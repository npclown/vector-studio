import type { RenderNodeSnapshot, SceneColor, SceneEffect } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';

import {
  deviceEffects,
  effectBounds,
  effectMargin,
  extendEffectReach,
  planEffectBudget,
} from '../../packages/renderer-core/src/effect-plan.js';
import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { effectsEqual } from '../../packages/renderer-core/src/scene-validation.js';
import {
  RetainedSceneMirror,
  type RetainedSceneMirrorOptions,
} from '../../packages/renderer-core/src/scene-mirror.js';
import { planEffectPasses } from '../../packages/renderer-webgpu/src/effect-pipeline.js';
import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';

// V-36 contract (docs/plans/viz-v36-inner-shadow-background-blur-contract.md), unit U2, renderer
// half: the V36-S3 scene shapes, the V36-S4 gate ('v0' and 'v1'), V36-K1 (output margin, cull
// reach, source bound), K1b's cut sides in the packet, section 5.5's harden scratch in the
// budget, the inner-shadow passes in a frame on the fake device, and the background-blur fallback
// (`backgroundBlurSkipped`; since U3 for a nested root, section 5.3). The passes' arithmetic is in e41-u5-effect-passes.test.ts.

const IDENTITY = [1, 0, 0, 1, 0, 0] as const;
const black: SceneColor = { r: 0, g: 0, b: 0, a: 0.5 };
const red: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const sceneIdentity = { documentId: 'v36-u2', pageId: 'page' } as const;

const drop = (offsetX: number, offsetY: number, sigma: number): SceneEffect => ({
  kind: 'dropShadow',
  color: black,
  offsetX,
  offsetY,
  sigma,
});
const inner = (offsetX: number, offsetY: number, sigma: number): SceneEffect => ({
  kind: 'innerShadow',
  color: black,
  offsetX,
  offsetY,
  sigma,
});
const backgroundBlur = (sigma: number): SceneEffect => ({ kind: 'backgroundBlur', sigma });

function box(
  id: string,
  parentId: string | null,
  x: number,
  extra: Partial<{ effects: readonly SceneEffect[]; size: number; y: number }> = {},
): RenderNodeSnapshot {
  const size = extra.size ?? 20;
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, extra.y ?? 40],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: size, height: size, cornerRadii: [0, 0, 0, 0] },
    style: { fill: red, stroke: null },
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
  };
}

function group(
  id: string,
  parentId: string | null,
  children: readonly string[],
  extra: Partial<{ effects: readonly SceneEffect[]; mask: boolean }> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: IDENTITY,
    visible: true,
    opacity: 1,
    kind: 'container',
    clip: extra.mask === true ? { kind: 'mask' } : null,
    children,
    ...(extra.effects === undefined ? {} : { effects: extra.effects }),
  };
}

const options = (effects: 'none' | 'v0' | 'v1'): RetainedSceneMirrorOptions => ({
  pathNodes: 'unsupported',
  clips: 'supported',
  groupOpacity: 'supported',
  effects,
});

function mirrorWith(nodes: readonly RenderNodeSnapshot[], effects: 'none' | 'v0' | 'v1') {
  const mirror = new RetainedSceneMirror(undefined, options(effects));
  mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  const result = mirror.replaceSnapshot({
    identity: sceneIdentity,
    revision: 1,
    nodes,
    rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  });
  return { mirror, status: result.status === 'invalid-scene' ? result.reason : result.status };
}

const statusOf = (nodes: readonly RenderNodeSnapshot[], effects: 'none' | 'v0' | 'v1') => {
  const { status } = mirrorWith(nodes, effects);
  return status;
};

const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
};

function prepare(
  nodes: readonly RenderNodeSnapshot[],
  at: PrimitiveTarget = target,
): PrimitivePacket {
  const { mirror, status } = mirrorWith(nodes, 'v1');
  expect(status).toBe('applied');
  return new PrimitiveSceneSource(mirror).prepare(at) as PrimitivePacket;
}

describe('V36-S3 scene shapes and V36-S4 gate', () => {
  it('accepts inner shadows and a background blur on v1, in order', () => {
    const effects = [drop(1, 2, 3), inner(0, 4, 2), backgroundBlur(5)];
    const { mirror, status } = mirrorWith([box('r', null, 0, { effects })], 'v1');
    expect(status).toBe('applied');
    expect(mirror.readRetainedScene()!.getNode('r')!.effects).toEqual(effects);
  });

  it('rejects the new kinds on v0 and none, and accepts E41 kinds on v0', () => {
    for (const effects of [[inner(0, 4, 2)], [backgroundBlur(5)], [drop(1, 1, 1), inner(0, 1, 1)]])
      for (const option of ['v0', 'none'] as const)
        expect(statusOf([box('r', null, 0, { effects })], option)).toBe('unsupported-feature');
    expect(statusOf([box('r', null, 0, { effects: [drop(1, 1, 1)] })], 'v0')).toBe('applied');
  });

  it.each([
    ['two background blurs', [backgroundBlur(1), backgroundBlur(2)]],
    ['a background blur with an extra key', [{ kind: 'backgroundBlur', sigma: 1, radius: 2 }]],
    ['a negative background-blur sigma', [backgroundBlur(-1)]],
    [
      'an inner shadow without its colour',
      [{ kind: 'innerShadow', offsetX: 0, offsetY: 0, sigma: 1 }],
    ],
    ['nine effects', Array.from({ length: 9 }, () => inner(0, 1, 1))],
  ])('rejects %s as invalid-value', (_name, effects) => {
    expect(statusOf([box('r', null, 0, { effects: effects as SceneEffect[] })], 'v1')).toBe(
      'invalid-value',
    );
  });

  it('compares kinds first (a drop and an inner shadow with equal fields differ)', () => {
    expect(effectsEqual([drop(0, 4, 2)], [inner(0, 4, 2)])).toBe(false);
    expect(effectsEqual([inner(0, 4, 2)], [inner(0, 4, 2)])).toBe(true);
    expect(effectsEqual([backgroundBlur(2)], [{ kind: 'layerBlur', sigma: 2 }])).toBe(false);
    expect(effectsEqual([backgroundBlur(2)], [backgroundBlur(2)])).toBe(true);
  });

  it("takes 'v1' in the service, which needs isolated groups", () => {
    const invalidate = { invalidate: () => undefined } as never;
    expect(() => new PrimitiveRendererService(invalidate, { effects: 'v1' })).toThrow(
      "effects: 'v1' needs groups: 'isolated'.",
    );
    const service = new PrimitiveRendererService(invalidate, {
      effects: 'v1',
      groups: 'isolated',
      clips: 'all',
    });
    expect(service.requiresEffectPipeline).toBe(true);
  });
});

describe('V36-K1 reach and bounds', () => {
  const view = { x: 0, y: 0, width: 640, height: 360 };

  it('keeps inner shadows out of the output margin and the drop list', () => {
    const effects = deviceEffects([drop(4, 0, 1), inner(0, 30, 5), backgroundBlur(4)], IDENTITY, 2);
    expect(effects.shadows).toHaveLength(1);
    expect(effects.innerShadows).toEqual([{ color: black, dx: 0, dy: 60, sigmaPx: 10 }]);
    expect(effects.backgroundBlur).toEqual({ sigmaPx: 8 });
    // ⌈3 × 2⌉ + 8: the inner shadow adds nothing.
    expect(effectMargin(effects)).toBe(14);
    // E41 effects keep their exact record shape.
    expect(Object.keys(deviceEffects([drop(1, 1, 1)], IDENTITY, 1))).toEqual([
      'shadows',
      'blurSigmaPx',
      'clamped',
    ]);
  });

  it('joins the inner shadows to the cull reach under the layer blur term', () => {
    const reach = extendEffectReach(
      null,
      [{ kind: 'layerBlur', sigma: 1 }, drop(10, 0, 1), inner(0, 40, 2), backgroundBlur(50)],
      IDENTITY,
      null,
    );
    // 3 × 1 + max(3 + 10, 6 + 40).
    expect(reach.margin).toBeCloseTo(49, 12);
  });

  it('extends the source bound by each inner shadow’s reach and sizes its harden scratch', () => {
    // Pixels at p read content at p − offset = p + (0, 100): below the view.
    const effects = deviceEffects([inner(0, -100, 1)], IDENTITY, 1);
    const bounds = effectBounds({ minX: 10, minY: 300, maxX: 20, maxY: 900 }, view, effects)!;
    // No output margin: the output stops at the view.
    expect(bounds.output).toEqual({ x: 10, y: 300, width: 10, height: 60 });
    // The source reaches (V − offset) ⊕ 3: rows to 463.
    expect(bounds.source.y).toBe(300);
    expect(bounds.source.y + bounds.source.height).toBeGreaterThanOrEqual(463);
    expect(bounds.source.y + bounds.source.height).toBeLessThanOrEqual(465);
    expect(bounds.uncut).toEqual(bounds.source);
    // (10 + 2r) × (60 + 2r), r = 3 + 100 + 2 + 2.
    expect(bounds.innerScratch).toBe((10 + 214) * (60 + 214));
    // Without inner shadows the bounds keep E41's shape.
    const plain = effectBounds(
      { minX: 10, minY: 300, maxX: 20, maxY: 900 },
      view,
      deviceEffects([drop(0, -100, 1)], IDENTITY, 1),
    )!;
    expect(Object.keys(plain)).toEqual(['source', 'output']);
  });

  it('counts the harden scratch in the budget when it is the largest', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    const tree = (innerScratch?: number) => ({
      rootId: 'r',
      layers: [
        {
          kind: 'effect' as const,
          source: rect,
          output: rect,
          ...(innerScratch === undefined ? {} : { innerScratch }),
        },
      ],
      withoutEffects: [],
      effectRoots: ['r'],
    });
    // 4 × (2 + 2/3) × 10⁶ ≈ 10.7 MB of scratch does not fit 5 MB; 100 pixels do.
    expect(planEffectBudget([tree()], 1, 8192, 5_000_000).withEffects.has('r')).toBe(true);
    const large = planEffectBudget([tree(1_000_000)], 1, 8192, 5_000_000);
    expect(large.withEffects.has('r')).toBe(false);
    expect(large.effectNotices[0]!.bytes).toBeGreaterThan(Math.ceil(4 * (2 + 2 / 3) * 1_000_000));
  });
});

describe('V36-K1b cut sides in the packet', () => {
  it('marks the sides where a mask-group root’s layer is cut at the target', () => {
    const packet = prepare([
      group('root', null, ['m'], { effects: [inner(0, 4, 2)] }),
      group('m', 'root', ['s', 'c'], { mask: true }),
      box('s', 'm', -30, { y: -30, size: 80 }),
      box('c', 'm', -30, { y: -30, size: 80 }),
    ]);
    const layer = packet.layers!.layers.find((entry) => entry.nodeId === 'root')!;
    expect(layer.bound.x).toBe(0);
    expect(layer.bound.y).toBe(0);
    // Left and top are cut (1 | 2); right and bottom are the content's own edges.
    expect(layer.effect!.innerClamp).toBe(3);
  });

  it('marks a leaf root cut at the target on a backend without off-target layers', () => {
    // The test target has no `offTargetEffectLayers`, so every bound is clamped to it.
    const packet = prepare([box('a', null, -30, { y: 300, size: 80, effects: [inner(0, 4, 2)] })]);
    const layer = packet.layers!.layers.find((entry) => entry.nodeId === 'a')!;
    expect([layer.bound.x, layer.bound.y + layer.bound.height]).toEqual([0, 360]);
    // Left and bottom are cut (1 | 8).
    expect(layer.effect!.innerClamp).toBe(9);
  });

  it('marks a nested root cut by its parent root’s bound', () => {
    const parent = {
      ...group('p', null, ['a'], { effects: [drop(0, 0, 0)] }),
      clip: { kind: 'rect', x: 100, y: 100, width: 60, height: 60 },
    } as RenderNodeSnapshot;
    const packet = prepare([
      parent,
      box('a', 'p', 130, { y: 130, size: 80, effects: [inner(0, 4, 2)] }),
    ]);
    const outer = packet.layers!.layers.find((entry) => entry.nodeId === 'p')!;
    const layer = packet.layers!.layers.find((entry) => entry.nodeId === 'a')!;
    expect(layer.bound.x + layer.bound.width).toBeLessThanOrEqual(
      outer.bound.x + outer.bound.width,
    );
    // Right and bottom are cut by the parent (4 | 8); left and top are the content's own edges.
    expect(layer.effect!.innerClamp).toBe(12);
  });

  it('leaves the mask out for an uncut root and for roots without inner shadows', () => {
    const packet = prepare([
      box('a', null, 100, { effects: [inner(0, 4, 2)] }),
      group('root', null, ['m'], { effects: [drop(0, 4, 2)] }),
      group('m', 'root', ['s', 'c'], { mask: true }),
      box('s', 'm', -30, { y: -30, size: 80 }),
      box('c', 'm', -30, { y: -30, size: 80 }),
    ]);
    for (const layer of packet.layers!.layers) expect(layer.effect!.innerClamp).toBeUndefined();
  });
});

describe('V36 inner shadows and the nested background blur in a frame', () => {
  const withEffects = { clipPipeline: true, layerPipeline: true, effectPipeline: true } as const;

  it('encodes harden, blur, innerTint, coverage and merge passes after the layer pass', async () => {
    const fixture = nativeFixture();
    const { scene, target: native, creation } = await nativeScene(fixture, withEffects);
    const packet = prepare([box('a', null, 100, { effects: [inner(0, 4, 2)] })], native);
    const layer = packet.layers!.layers[0]!;
    const plan = planEffectPasses(layer.bound, layer.effect!.output, layer.effect!);
    expect(plan.passes.map((pass) => pass.kind)).toEqual([
      'merge',
      'harden',
      'blur',
      'blur',
      'innerTint',
      'coverage',
      'merge',
    ]);
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(packet));
    const pipelines = fixture.calls
      .filter(([name]) => name === 'setPipeline')
      .map((call) => call[1] as string)
      .filter((label) => label.startsWith('vector-studio/e41-effect-'));
    expect(pipelines).toEqual(plan.passes.map((pass) => `vector-studio/e41-effect-${pass.kind}`));
    expect(scene.effectPasses).toBe(1);
    expect(scene.backgroundBlurSkipped).toBe(0);
    creation.dispose();
  });

  it('draws a nested background-blur root without its blur and counts it (U3: section 5.3)', async () => {
    const fixture = nativeFixture();
    const {
      scene,
      target: native,
      creation,
    } = await nativeScene(fixture, {
      ...withEffects,
      blendPipeline: true,
    });
    // U3: a root in a 50 % group composites into the group's layer, not the main pass, so it
    // asks for no backdrop even on a target that takes snapshots.
    const nodes = [
      { ...group('g', null, ['a']), opacity: 0.5 },
      box('a', 'g', 100, { effects: [backgroundBlur(4), drop(2, 2, 1)] }),
    ];
    const packet = prepare(nodes, { ...native, backdropSnapshots: true });
    const layer = packet.layers!.layers.find((entry) => entry.nodeId === 'a')!;
    expect(layer.parent).not.toBe(-1);
    expect(layer.effect!.backgroundBlur).toEqual({ sigmaPx: 4 });
    expect(layer.backdrop).toBeUndefined();
    const plan = planEffectPasses(layer.bound, layer.effect!.output, layer.effect!);
    // The drop shadow's passes only: the background blur's run at a main-pass split.
    expect(plan.passes.map((pass) => pass.kind)).toEqual(['blur', 'blur', 'tint', 'merge']);
    submitted(scene.submitPrimitivePacket(packet));
    submitted(scene.submitPrimitivePacket(packet));
    expect(scene.effectPasses).toBe(2);
    expect(scene.backgroundBlurSkipped).toBe(2);
    expect(scene.blendSplits).toBe(0);
    creation.dispose();
  });
});
