import type { RenderNodeSnapshot, SceneColor, SceneEffect } from '@vector-studio/contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import {
  EFFECT_PASS_KINDS,
  EFFECT_SHADER,
  planEffectPasses,
} from '../../packages/renderer-webgpu/src/effect-pipeline.js';
import {
  LAYER_COMPOSITE_SHIFTED_SHADER,
  MESH_FILL_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_SHIFTED_SHADER,
  PRIMITIVE_ANALYTIC_SHIFTED_SHADER,
  TEXT_CLIP_SHIFTED_SHADER,
} from '../../packages/renderer-webgpu/src/shifted-layer-pipeline.js';
import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), unit U5: the effect pipelines'
// creation and failure rules, the effect passes between an effect root's layer pass and its
// composite, `R` in place of `L` at the composite, the transient effect textures (the unit part
// of E41-A09), `effectPasses`, the effect-content test hook, the unavailable pipeline (section
// 5.3), the device limit and the service and backend wiring. Fake device seams only; the
// passes' arithmetic is checked in e41-u5-effect-passes.test.ts and on SwiftShader.

const red: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const shade: SceneColor = { r: 0, g: 0, b: 0, a: 0.5 };
const identity = { documentId: 'e41-u5', pageId: 'page' } as const;

const shadow = (offsetX: number, offsetY: number, sigma: number): SceneEffect => ({
  kind: 'dropShadow',
  color: shade,
  offsetX,
  offsetY,
  sigma,
});

function box(
  id: string,
  x: number,
  extra: Partial<{
    effects: readonly SceneEffect[];
    opacity: number;
    size: readonly [number, number];
    y: number;
  }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: [1, 0, 0, 1, x, extra.y ?? 40],
    visible: true,
    opacity: extra.opacity ?? 1,
    kind: 'primitive',
    geometry: {
      kind: 'rectangle',
      width: extra.size?.[0] ?? 20,
      height: extra.size?.[1] ?? 20,
      cornerRadii: [0, 0, 0, 0],
    },
    style: { fill: red, stroke: null },
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
  };
}

function prepare(nodes: readonly RenderNodeSnapshot[], target: PrimitiveTarget): PrimitivePacket {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'unsupported',
    clips: 'supported',
    groupOpacity: 'supported',
    effects: 'v0',
  });
  mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  const result = mirror.replaceSnapshot({
    identity,
    revision: 1,
    nodes,
    rootOrder: nodes.map((node) => node.id),
  });
  expect(result.status).toBe('applied');
  return new PrimitiveSceneSource(mirror).prepare(target) as PrimitivePacket;
}

const layered = { clipPipeline: true, layerPipeline: true } as const;
const withEffects = { ...layered, effectPipeline: true } as const;
const frame = 'primitive/1/layer-frame-1';

/** The pass, pipeline, viewport, draw and copy calls. */
const outline = (calls: readonly (readonly unknown[])[]) =>
  calls
    .filter(
      ([name]) =>
        name === 'beginRenderPass' ||
        name === 'setViewport' ||
        name === 'setPipeline' ||
        name === 'copyTextureToTexture' ||
        name === 'draw',
    )
    .map((call) => (call[0] === 'beginRenderPass' ? call.slice(0, 3) : call));

describe('E41 U5 effect pipeline creation', () => {
  it('creates the effect module, five pipelines and the shifted layer variants', async () => {
    const plain = nativeFixture();
    const without = await nativeScene(plain, layered);
    const fixture = nativeFixture();
    const { scene, creation, accounting } = await nativeScene(fixture, withEffects);
    expect(scene.effectPipelineAvailable).toBe(true);
    expect(without.scene.effectPipelineAvailable).toBe(false);
    expect(fixture.modules.filter((code) => code === EFFECT_SHADER)).toHaveLength(1);
    expect(fixture.pipelineLabels.filter((label) => label.includes('e41-effect'))).toEqual(
      EFFECT_PASS_KINDS.map((kind) => `vector-studio/e41-effect-${kind}`),
    );
    // U5b: the shifted composite, plain analytic and clip analytic variants (no mesh, paint
    // or text path in this generation).
    const shifted = [
      LAYER_COMPOSITE_SHIFTED_SHADER,
      PRIMITIVE_ANALYTIC_SHIFTED_SHADER,
      PRIMITIVE_ANALYTIC_CLIP_SHIFTED_SHADER,
    ];
    for (const code of shifted) {
      expect(fixture.modules.filter((module) => module === code)).toHaveLength(1);
    }
    expect(fixture.pipelineLabels.filter((label) => label.endsWith('+shift-v0'))).toEqual([
      'vector-studio/e25-layer-composite-4x+shift-v0',
      'vector-studio/p1-analytic-primitive-4x+layer-v0+shift-v0',
      'vector-studio/p1-analytic-primitive-4x+clip-v0+layer-v0+shift-v0',
    ]);
    expect(scene.shaderModulesCreated).toBe(without.scene.shaderModulesCreated + 1 + 3);
    expect(scene.pipelinesCreated).toBe(without.scene.pipelinesCreated + 5 + 3);
    creation.dispose();
    without.creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('creates a shifted variant for each layer variant, with the mesh stencil passes', async () => {
    const all = {
      meshPipeline: true,
      clipPipeline: true,
      paintPipeline: true,
      layerPipeline: true,
      textPipeline: true,
    } as const;
    const without = await nativeScene(nativeFixture(), all);
    const fixture = nativeFixture();
    const { scene, creation, accounting } = await nativeScene(fixture, {
      ...all,
      effectPipeline: true,
    });
    expect(scene.effectPipelineAvailable).toBe(true);
    // Composite, four analytic, four mesh and two text modules; per mesh module a fill, a
    // joint and seven covers, and four stencil passes over the plain one.
    expect(scene.shaderModulesCreated).toBe(without.scene.shaderModulesCreated + 1 + 11);
    expect(scene.pipelinesCreated).toBe(without.scene.pipelinesCreated + 5 + 1 + 4 + 36 + 4 + 2);
    const labels = fixture.pipelineLabels.filter((label) => label.endsWith('+shift-v0'));
    expect(labels).toHaveLength(47);
    expect(new Set(labels).size).toBe(47);
    expect(fixture.modules).toContain(MESH_FILL_SHIFTED_SHADER);
    expect(fixture.modules).toContain(TEXT_CLIP_SHIFTED_SHADER);
    creation.dispose();
    without.creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('a failed shifted variant leaves the effects unavailable and evicts what it cached', async () => {
    const all = { meshPipeline: true, clipPipeline: true, layerPipeline: true } as const;
    const baseline = await nativeScene(nativeFixture(), all);
    const fixture = nativeFixture({ failPipeline: 'p3-mesh-joint-4x+clip-v0+layer-v0+shift-v0' });
    const { scene, accounting, creation } = await nativeScene(fixture, {
      ...all,
      effectPipeline: true,
    });
    expect(scene.effectPipelineAvailable).toBe(false);
    expect(scene.layerPipelineAvailable).toBe(true);
    expect(accounting.snapshot().live).toBe(baseline.accounting.snapshot().live);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('needs the layer pipeline', async () => {
    const fixture = nativeFixture();
    const { scene } = await nativeScene(fixture, { clipPipeline: true, effectPipeline: true });
    expect(scene.effectPipelineAvailable).toBe(false);
    expect(fixture.modules).not.toContain(EFFECT_SHADER);
  });

  it('a failed effect pipeline leaves the effects unavailable and releases what it tracked', async () => {
    const baseline = await nativeScene(nativeFixture(), layered);
    const fixture = nativeFixture({ failPipeline: 'e41-effect-tint' });
    const { scene, accounting, creation } = await nativeScene(fixture, withEffects);
    expect(scene.effectPipelineAvailable).toBe(false);
    expect(scene.layerPipelineAvailable).toBe(true);
    expect(accounting.snapshot().live).toBe(baseline.accounting.snapshot().live);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });
});

describe('E41 U5 effect passes in a frame', () => {
  it('builds R after the layer pass and composites it in place of L', async () => {
    const fixture = nativeFixture();
    const { scene, target, creation, accounting } = await nativeScene(fixture, withEffects);
    const live = new Set<string>();
    const track = accounting.track.bind(accounting);
    const release = accounting.release.bind(accounting);
    vi.spyOn(accounting, 'track').mockImplementation((id, descriptor) => {
      if (id.includes('/effect-')) live.add(id);
      return track(id, descriptor);
    });
    vi.spyOn(accounting, 'release').mockImplementation((id) => {
      live.delete(id);
      return release(id);
    });
    const packet = prepare([box('a', 0), box('b', 100, { effects: [shadow(4, 6, 2)] })], target);
    const layer = packet.layers!.layers[0]!;
    expect(layer.effect).toBeDefined();
    const effect = layer.effect!;
    const plan = planEffectPasses(layer.bound, effect.output, effect);
    expect(plan.passes.map((pass) => pass.kind)).toEqual(['blur', 'blur', 'tint', 'merge']);
    fixture.calls.length = 0;
    const bindGroups = vi.spyOn(fixture.device, 'createBindGroup');
    submitted(scene.submitPrimitivePacket(packet));
    const calls = outline(fixture.calls);
    const copy = calls.findIndex((call) => call[0] === 'copyTextureToTexture');
    const main = calls.findIndex(
      (call) => call[0] === 'beginRenderPass' && call[1] === 'vector-studio/primitive-pass',
    );
    const passes = calls.slice(copy + 1, main);
    expect(passes).toEqual(
      plan.passes.flatMap((pass) => [
        [
          'beginRenderPass',
          `vector-studio/effect-pass/0/${pass.kind}`,
          pass.target === 'result'
            ? `${frame}/effect-result-0`
            : `${frame}/effect-${pass.target === 'scratch0' ? 'scratch-0-0' : 'scratch-0-1'}`,
        ],
        ['setViewport', 0, 0, pass.width, pass.height, 0, 1],
        ['setPipeline', `vector-studio/e41-effect-${pass.kind}`],
        ['draw', 3],
      ]),
    );
    // Each pass binds its source at its own record.
    const effectBinds = fixture.calls.filter(
      (call) => call[0] === 'setBindGroup' && String(call[2]).includes('/effect-'),
    );
    expect(effectBinds.map((call) => call[3])).toEqual(
      plan.passes.map((_, index) => (packet.layers!.layers.length + 2 + index) * 256),
    );
    // The composite group reads R.
    const compositeGroup = bindGroups.mock.calls.find(
      ([descriptor]) => descriptor.label === `${frame}/composite-0`,
    )![0];
    expect([...compositeGroup.entries][0]!.resource).toEqual({
      texture: `${frame}/effect-result-0`,
    });
    const results = fixture.textures.filter((texture) => texture.label.includes('effect-'));
    expect(
      results.map(({ label, width, height, sampleCount }) => [label, width, height, sampleCount]),
    ).toEqual([
      [`${frame}/effect-result-0`, effect.output.width, effect.output.height, 1],
      [`${frame}/effect-scratch-0-0`, plan.scratch.width, plan.scratch.height, 1],
      [`${frame}/effect-scratch-0-1`, plan.scratch.width, plan.scratch.height, 1],
    ]);
    // E41-A09 unit part: released after the submission.
    expect(fixture.destroyed.filter((label) => label.includes('effect-')).sort()).toEqual(
      results.map((texture) => texture.label).sort(),
    );
    expect([...live]).toEqual([]);
    expect(scene.effectPasses).toBe(1);
    creation.dispose();
  });

  it('gives a root that does not fit the shared scratch its own (a wide and a tall root)', async () => {
    const fixture = nativeFixture();
    const { scene, target } = await nativeScene(fixture, withEffects);
    const packet = prepare(
      [
        box('wide', 20, { effects: [shadow(0, 2, 2)], size: [560, 10], y: 20 }),
        box('tall', 300, { effects: [shadow(2, 0, 2)], size: [10, 250], y: 80 }),
      ],
      target,
    );
    expect(packet.layers!.layers.filter((layer) => layer.effect !== undefined)).toHaveLength(2);
    submitted(scene.submitPrimitivePacket(packet));
    const scratch = fixture.textures
      .filter((texture) => texture.label.includes('effect-scratch'))
      .map(({ label, width, height }) => [label.slice(frame.length + 1), width, height]);
    expect(scratch).toHaveLength(4);
    // No scratch texture is both as wide as the wide root and as tall as the tall one.
    for (const [, width, height] of scratch) {
      expect((width as number) > 300 && (height as number) > 200).toBe(false);
    }
    expect(scene.effectPasses).toBe(2);
  });

  it('shares one scratch pair between similar roots', async () => {
    const fixture = nativeFixture();
    const { scene, target } = await nativeScene(fixture, withEffects);
    const packet = prepare(
      [
        box('a', 20, { effects: [shadow(0, 2, 2)], size: [100, 90] }),
        box('b', 200, { effects: [shadow(2, 0, 2)], size: [96, 100] }),
        box('c', 400, { effects: [shadow(1, 1, 2)], size: [104, 86] }),
      ],
      target,
    );
    submitted(scene.submitPrimitivePacket(packet));
    expect(
      fixture.textures.filter((texture) => texture.label.includes('effect-scratch')).length,
    ).toBe(2);
    expect(scene.effectPasses).toBe(3);
  });

  it('composites a leaf root at its content opacity, scaled back in the passes', async () => {
    const fixture = nativeFixture();
    const { scene, target } = await nativeScene(fixture, withEffects);
    const packet = prepare([box('b', 100, { effects: [shadow(0, 2, 1)], opacity: 0.5 })], target);
    const effect = packet.layers!.layers[0]!.effect!;
    expect(effect.contentOpacity).toBe(0.5);
    const plan = planEffectPasses(packet.layers!.layers[0]!.bound, effect.output, effect);
    expect(plan.passes.find((pass) => pass.kind === 'merge')!.contentScale).toBe(2);
    submitted(scene.submitPrimitivePacket(packet));
  });

  it('draws an effect root as an E25 layer without the pipeline or under the content hook', async () => {
    for (const options of [layered, { ...withEffects, effectContentForTesting: true }]) {
      const fixture = nativeFixture();
      const { scene, target } = await nativeScene(fixture, options);
      const packet = prepare([box('b', 100, { effects: [shadow(4, 6, 2)] })], target);
      fixture.calls.length = 0;
      submitted(scene.submitPrimitivePacket(packet));
      expect(outline(fixture.calls).some((call) => String(call[1]).includes('effect-pass'))).toBe(
        false,
      );
      expect(fixture.textures.some((texture) => texture.label.includes('effect-'))).toBe(false);
      expect(scene.effectPasses).toBe(0);
    }
  });

  it('skips the composite of a root whose output is outside the target', async () => {
    const fixture = nativeFixture();
    const { scene, target } = await nativeScene(fixture, withEffects);
    const packet = prepare([box('b', 100, { effects: [shadow(4, 6, 2)] })], target);
    const layer = packet.layers!.layers[0]!;
    const moved: PrimitivePacket = {
      ...packet,
      layers: {
        ...packet.layers!,
        layers: [
          {
            ...layer,
            effect: { ...layer.effect!, output: { x: 1000, y: 0, width: 20, height: 20 } },
          },
        ],
      },
    };
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(moved));
    const calls = outline(fixture.calls);
    expect(calls.some((call) => String(call[1]).includes('effect-pass'))).toBe(false);
    expect(calls.some((call) => call[1] === 'vector-studio/e25-layer-composite-1x')).toBe(false);
    expect(scene.effectPasses).toBe(0);
  });

  it('draws a root past the target through the shifted variants (U5b)', async () => {
    const fixture = nativeFixture();
    const { scene, target } = await nativeScene(fixture, withEffects);
    // The caster's left half is off the target; its shadow falls on it.
    const nodes = [box('b', -60, { effects: [shadow(80, 0, 2)], size: [100, 60] })];
    const clamped = prepare(nodes, target).layers!.layers[0]!;
    expect(clamped.bound.x).toBe(0);
    const packet = prepare(nodes, { ...target, offTargetEffectLayers: true });
    const layer = packet.layers!.layers[0]!;
    expect(layer.bound.x).toBeLessThan(-50);
    expect(Math.abs(layer.bound.x % 2)).toBe(0);
    expect(layer.bound.width).toBeGreaterThan(clamped.bound.width);
    const writes = vi.spyOn(fixture.device.queue, 'writeBuffer');
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(packet));
    const calls = outline(fixture.calls);
    const layerPass = calls.findIndex(
      (call) => call[0] === 'beginRenderPass' && call[1] === 'vector-studio/layer-pass/0',
    );
    const copy = calls.findIndex((call) => call[0] === 'copyTextureToTexture');
    const tile = fixture.textures.find((texture) => texture.label === `${frame}/tile-color`)!;
    expect(tile.width).toBe(layer.bound.width);
    // The viewport is the tile's own; the analytic draw takes the shifted plain variant.
    expect(calls.slice(layerPass + 1, copy)).toEqual([
      ['setViewport', 0, 0, tile.width, tile.height, 0, 1],
      ['setPipeline', 'vector-studio/p1-analytic-primitive-4x+layer-v0+shift-v0'],
    ]);
    // Its pass record: the tile's origin in target pixels, and the tile's size.
    const records = writes.mock.calls.find(([buffer]) =>
      (buffer as unknown as { label: string }).label.endsWith('/records'),
    )![2] as Uint8Array;
    const view = new DataView(records.buffer, records.byteOffset, records.byteLength);
    expect([0, 4, 8, 12].map((offset) => view.getFloat32(256 + offset, true))).toEqual([
      layer.bound.x,
      layer.bound.y,
      tile.width,
      tile.height,
    ]);
    // R stays inside the target for a root composited in the main pass, drawn by E25's
    // composite there.
    const result = fixture.textures.find(
      (texture) => texture.label === `${frame}/effect-result-0`,
    )!;
    expect(result.width).toBeLessThanOrEqual(target.width);
    const main = calls.findIndex(
      (call) => call[0] === 'beginRenderPass' && call[1] === 'vector-studio/primitive-pass',
    );
    expect(calls.slice(main)).toContainEqual([
      'setPipeline',
      'vector-studio/e25-layer-composite-4x',
    ]);
    expect(scene.effectPasses).toBe(1);
  });

  it('refuses a layer past the target that is not in an effect root', async () => {
    const fixture = nativeFixture();
    const { scene, target } = await nativeScene(fixture, withEffects);
    const packet = prepare([box('b', -60, { effects: [shadow(80, 0, 2)], size: [100, 60] })], {
      ...target,
      offTargetEffectLayers: true,
    });
    const layer = packet.layers!.layers[0]!;
    const plain = { ...layer };
    delete plain.effect;
    const bad = {
      ...packet,
      layers: { ...packet.layers!, layers: [plain] },
    } as PrimitivePacket;
    expect(scene.submitPrimitivePacket(bad)).toEqual({
      status: 'failed',
      reason: 'invalid-packet',
    });
    // Without the effect pipeline, an effect root past the target is refused too.
    const without = await nativeScene(nativeFixture(), layered);
    expect(without.scene.submitPrimitivePacket(packet)).toEqual({
      status: 'failed',
      reason: 'invalid-packet',
    });
  });

  it('refuses an invalid effect record', async () => {
    const fixture = nativeFixture();
    const { scene, target } = await nativeScene(fixture, withEffects);
    const packet = prepare([box('b', 100, { effects: [shadow(4, 6, 2)] })], target);
    const layer = packet.layers!.layers[0]!;
    for (const effect of [
      { ...layer.effect!, contentOpacity: 0 },
      { ...layer.effect!, blurSigmaPx: 300 },
      { ...layer.effect!, shadows: [{ ...layer.effect!.shadows[0]!, dx: Number.NaN }] },
      { ...layer.effect!, output: { x: 0, y: 0, width: 0, height: 4 } },
    ]) {
      const bad = {
        ...packet,
        layers: { ...packet.layers!, layers: [{ ...layer, effect }] },
      } as PrimitivePacket;
      expect(scene.submitPrimitivePacket(bad)).toEqual({
        status: 'failed',
        reason: 'invalid-packet',
      });
    }
  });

  it('reports the device limit', async () => {
    const fixture = nativeFixture();
    const { scene } = await nativeScene(fixture, withEffects);
    expect(scene.maxTextureDimension2D).toBe(fixture.device.limits.maxTextureDimension2D);
  });
});

describe('E41 U5 service and source wiring', () => {
  it("asks for the effect pipeline exactly with effects 'v0'", () => {
    const invalidation = { invalidate: () => undefined } as never;
    expect(
      new PrimitiveRendererService(invalidation, {
        clips: 'all',
        groups: 'isolated',
        effects: 'v0',
      }).requiresEffectPipeline,
    ).toBe(true);
    expect(
      new PrimitiveRendererService(invalidation, { clips: 'all', groups: 'isolated' })
        .requiresEffectPipeline,
    ).toBe(false);
  });

  it("plans against the target's maxTextureDimension2D when the backend passes it", () => {
    const nodes = [box('b', 100, { effects: [shadow(4, 6, 2)] })];
    const base: PrimitiveTarget = {
      generation: 1,
      surfaceRevision: 1,
      width: 640,
      height: 360,
      devicePixelRatio: 1,
      sampleCount: 1,
      targetFormat: 'bgra8unorm',
    };
    expect(prepare(nodes, base).layers!.layers[0]!.effect).toBeDefined();
    // A limit below the root's bounds drops its effects (section 5.4).
    const limited = prepare(nodes, { ...base, maxTextureDimension2D: 16 });
    expect(limited.layers?.layers.some((layer) => layer.effect !== undefined) ?? false).toBe(false);
    expect(limited.layers?.effectNotices?.length).toBe(1);
  });
});
