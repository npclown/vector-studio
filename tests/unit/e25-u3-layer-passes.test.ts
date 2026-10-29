import { createHash } from 'node:crypto';

import type {
  RenderNodeSnapshot,
  SceneAffine,
  SceneClip,
  SceneGradient,
} from '@vector-studio/contracts';
import {
  PrimitiveRendererService,
  type PrimitivePacket,
  type ResourceAccounting,
} from '@vector-studio/renderer-core';
import {
  WebGpuBackend,
  type WebGpuAdapterPort,
  type WebGpuDevicePort,
  type WebGpuPlatform,
  type WebGpuPrimitiveScenePort,
} from '@vector-studio/renderer-webgpu';
import { describe, expect, it, vi } from 'vitest';

import {
  MESH_FILL_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_SHADER,
} from '../../packages/renderer-webgpu/src/clip-pipeline.js';
import {
  LAYER_BLOCK,
  LAYER_COMPOSITE_RECORD_SIZE,
  LAYER_PASS_RECORD_SIZE,
  MESH_FILL_CLIP_LAYER_SHADER,
  MESH_FILL_LAYER_SHADER,
  MESH_FILL_PAINT_CLIP_LAYER_SHADER,
  MESH_FILL_PAINT_LAYER_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_LAYER_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_CLIP_LAYER_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_LAYER_SHADER,
  layerCompositePipelineKey,
  layerVariantBaseKey,
  layerVariantSource,
  packLayerCompositeRecord,
  packLayerPassRecord,
} from '../../packages/renderer-webgpu/src/layer-pipeline.js';
import { MESH_FILL_SHADER } from '../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import {
  MESH_FILL_PAINT_CLIP_SHADER,
  MESH_FILL_PAINT_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_SHADER,
} from '../../packages/renderer-webgpu/src/paint-pipeline.js';
import type { PipelineCacheSnapshot } from '../../packages/renderer-webgpu/src/pipeline-cache.js';
import { PRIMITIVE_ANALYTIC_SHADER } from '../../packages/renderer-webgpu/src/primitive-analytic-shader.js';
import { primitivePipelineKey } from '../../packages/renderer-webgpu/src/primitive-pipeline.js';
import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';
import {
  ScriptedStrokeMeshPort,
  createStrokeHarness,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';
import { createCountingPort } from '../support/v3a-path-harness.js';

// E25 contract (docs/plans/d9-e25-isolated-opacity-contract.md), unit U3: the `+layer-v0`
// variants and the composite pipeline (section 4), their creation and failure rules, the layer
// tile passes and composites in the main and nested passes, fail-closed layers without the
// pipeline, the transient layer resources (the unit part of E25-A06), `layerPasses`, the
// `groups` service option (E25-A01's option-wiring cases) and the backend's test hooks. Fake
// device seams only; E25-A05 and A08 are the SwiftShader captures in docs/evidence/e25/.

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const red = { r: 1, g: 0, b: 0, a: 1 };
const linear: SceneGradient = {
  kind: 'linear',
  transform: [10, 0, 0, 10, 0, 0],
  stops: [
    { offset: 0, color: red },
    { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
  ],
  spread: 'pad',
};

function box(
  id: string,
  x: number,
  parentId: string | null = null,
  fill: unknown = red,
  width = 10,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, 20],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill, stroke: null },
  } as RenderNodeSnapshot;
}

function group(
  id: string,
  opacity: number,
  children: readonly string[],
  parentId: string | null = null,
  clip: SceneClip | null = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: IDENTITY,
    visible: true,
    opacity,
    kind: 'container',
    clip,
    children,
  };
}

const fillPath = (id: string, tag: number, parentId: string | null = null) =>
  ({ ...strokedNode(id, tag, { stroke: null }), parentId }) as RenderNodeSnapshot;

function harness(
  nodes: readonly RenderNodeSnapshot[],
  options: Readonly<{ isolateUnitOpacityForTesting?: boolean }> = {},
) {
  return createStrokeHarness({
    fillPort: createCountingPort(),
    strokePort: new ScriptedStrokeMeshPort(),
    clips: 'rect',
    paints: 'gradient',
    groupOpacity: 'supported',
    nodes,
    ...options,
  });
}

const allOptions = {
  meshPipeline: true,
  clipPipeline: true,
  paintPipeline: true,
  layerPipeline: true,
} as const;
const withoutLayer = { meshPipeline: true, clipPipeline: true, paintPipeline: true } as const;
const hash = (code: string) => createHash('sha256').update(code).digest('hex');
const readyOf = (scene: unknown) =>
  (
    scene as { pipelineCacheSnapshotForTesting(): PipelineCacheSnapshot }
  ).pipelineCacheSnapshotForTesting();
const prepared = (h: ReturnType<typeof harness>, target: Parameters<typeof h.source.prepare>[0]) =>
  h.source.prepare(target) as PrimitivePacket;
const frame = 'primitive/1/layer-frame-1';
const stencilP1 = 'vector-studio/p1-analytic-primitive-stencil-4x';
const composite = 'vector-studio/e25-layer-composite-stencil-4x';
const layerEmpty = 'primitive/1/layer-empty-bind-group';

describe('E25 U3 layer variant sources (section 4; E25-A08 hash part)', () => {
  it('keeps the base, clip and paint modules byte-identical to main', () => {
    // E23 U3 pins the base, clip and mask hashes; these are the paint modules' at 095abeb.
    expect({
      analytic: hash(PRIMITIVE_ANALYTIC_SHADER),
      mesh: hash(MESH_FILL_SHADER),
      analyticClip: hash(PRIMITIVE_ANALYTIC_CLIP_SHADER),
      meshClip: hash(MESH_FILL_CLIP_SHADER),
      analyticPaint: hash(PRIMITIVE_ANALYTIC_PAINT_SHADER),
      analyticPaintClip: hash(PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER),
      meshPaint: hash(MESH_FILL_PAINT_SHADER),
      meshPaintClip: hash(MESH_FILL_PAINT_CLIP_SHADER),
    }).toEqual({
      analytic: '06b0839c15b93141d1caa72596484b0aa02f53e74f1e58b74959fb5b92af527d',
      mesh: 'd306137cf0770f6bf7f9237f1c98b9ecd0a165cfdbfda916196d299e36b831a3',
      analyticClip: '434bc1d2768c1b9d09c385a2ac4f524f3d6976e183fb9324e0612a7a176efc0d',
      meshClip: 'abcac5d89e07e09978e7a93ad4f14783ac17fef656332cdcffa821328e994d7a',
      analyticPaint: '4806c2ff765f81874b1c4e343642f84113cc2be4ddcba355a4479a644f2767f3',
      analyticPaintClip: 'd5ca9dad0bb75815b3048d9276d2a57e63def756b9fb44149ee4042dc2720510',
      meshPaint: '6e92d37155395acaad383dcb2093e6e449c88f3e41843825249b9ede8785ad40',
      meshPaintClip: '6c77d54690333e3a93138bc43be954d14a66d692aaeb767488480c46435b7fd2',
    });
  });

  it('shifts every position read and appends the layer block; the plain module reads none', () => {
    const pairs = [
      [PRIMITIVE_ANALYTIC_CLIP_SHADER, PRIMITIVE_ANALYTIC_CLIP_LAYER_SHADER],
      [PRIMITIVE_ANALYTIC_PAINT_SHADER, PRIMITIVE_ANALYTIC_PAINT_LAYER_SHADER],
      [PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER, PRIMITIVE_ANALYTIC_PAINT_CLIP_LAYER_SHADER],
      [MESH_FILL_SHADER, MESH_FILL_LAYER_SHADER],
      [MESH_FILL_CLIP_SHADER, MESH_FILL_CLIP_LAYER_SHADER],
      [MESH_FILL_PAINT_SHADER, MESH_FILL_PAINT_LAYER_SHADER],
      [MESH_FILL_PAINT_CLIP_SHADER, MESH_FILL_PAINT_CLIP_LAYER_SHADER],
    ] as const;
    for (const [base, variant] of pairs) {
      const reads = base.split('input.position.xy').length - 1;
      expect(reads).toBeGreaterThan(0);
      expect(variant.split('(input.position.xy + layerPass.shift)').length - 1).toBe(reads);
      expect(variant.endsWith(LAYER_BLOCK)).toBe(true);
      expect(variant.slice(0, -LAYER_BLOCK.length).replaceAll(' + layerPass.shift)', '')).toBe(
        base.replaceAll('input.position.xy', '(input.position.xy'),
      );
    }
    expect(PRIMITIVE_ANALYTIC_SHADER).not.toContain('input.position');
    expect(() => layerVariantSource(PRIMITIVE_ANALYTIC_SHADER)).toThrow('reads no fragment');
  });

  it('suffixes the variant keys and keys the composite by format, samples and stencil', () => {
    const analytic = primitivePipelineKey('bgra8unorm', 4, true);
    expect(layerVariantBaseKey(analytic, 'paint-clip')).toMatchObject({
      shaderKey: 'p1-analytic-v1+paint-v0+clip-v0+layer-v0',
    });
    expect(layerVariantBaseKey(analytic, 'clip').layoutKey).toContain('e25-layer-v0');
    expect(layerCompositePipelineKey('bgra8unorm', 4, true)).not.toEqual(
      layerCompositePipelineKey('bgra8unorm', 4, false),
    );
    expect(layerCompositePipelineKey('bgra8unorm', 1, false)).not.toEqual(
      layerCompositePipelineKey('bgra8unorm', 4, false),
    );
  });

  it('packs the pass and composite records', () => {
    const pass = new DataView(
      packLayerPassRecord({ x: 18, y: 6 }, { width: 640, height: 360 }).buffer,
    );
    expect(LAYER_PASS_RECORD_SIZE).toBe(16);
    expect([0, 4, 8, 12].map((offset) => pass.getFloat32(offset, true))).toEqual([18, 6, 640, 360]);
    const record = packLayerCompositeRecord({ x: 18, y: 6, width: 38, height: 32 }, 0.5);
    expect(record.byteLength).toBe(LAYER_COMPOSITE_RECORD_SIZE);
    const view = new DataView(record.buffer);
    expect([0, 4, 8, 12, 16, 20].map((offset) => view.getFloat32(offset, true))).toEqual([
      18, 6, 38, 32, 0.5, 0,
    ]);
  });
});

describe('E25 U3 pipeline creation', () => {
  it('creates the composite and 11 layer variants after the paint variants, with 4 groups', async () => {
    const fixture = nativeFixture();
    const { scene, creation, accounting } = await nativeScene(fixture, allOptions);
    expect(scene).toMatchObject({
      layerPipelineAvailable: true,
      paintPipelineAvailable: true,
      pipelinesCreated: 27,
      shaderModulesCreated: 19,
      layerPasses: 0,
    });
    expect(fixture.pipelineLabels.slice(15)).toEqual([
      composite,
      `${stencilP1}+clip-v0+layer-v0`,
      `${stencilP1}+paint-v0+layer-v0`,
      `${stencilP1}+paint-v0+clip-v0+layer-v0`,
      'vector-studio/p3-mesh-fill-4x+layer-v0',
      'vector-studio/p3-mesh-joint-4x+layer-v0',
      'vector-studio/p3-mesh-fill-4x+clip-v0+layer-v0',
      'vector-studio/p3-mesh-joint-4x+clip-v0+layer-v0',
      'vector-studio/p3-mesh-fill-4x+paint-v0+layer-v0',
      'vector-studio/p3-mesh-joint-4x+paint-v0+layer-v0',
      'vector-studio/p3-mesh-fill-4x+paint-v0+clip-v0+layer-v0',
      'vector-studio/p3-mesh-joint-4x+paint-v0+clip-v0+layer-v0',
    ]);
    const groups = (label: string) =>
      (
        fixture.descriptors.find((descriptor) => descriptor.label === label)!.layout as unknown as {
          groups: { label: string }[];
        }
      ).groups.map((layout) => layout.label);
    expect(groups(composite)).toEqual([
      'vector-studio/e25-layer-composite-layout',
      'primitive/1/layer-empty-bind-group-layout',
      'primitive/1/layer-empty-bind-group-layout',
      'vector-studio/e25-layer-layout',
    ]);
    expect(groups('vector-studio/p3-mesh-fill-4x+layer-v0')).toEqual([
      'vector-studio/p3-mesh-packet-layout',
      'primitive/1/layer-empty-bind-group-layout',
      'primitive/1/layer-empty-bind-group-layout',
      'vector-studio/e25-layer-layout',
    ]);
    expect(groups(`${stencilP1}+paint-v0+clip-v0+layer-v0`)).toEqual([
      'vector-studio/p1-primitive-packet-layout',
      'vector-studio/p4-clip-layout',
      'vector-studio/e23-paint-layout',
      'vector-studio/e25-layer-layout',
    ]);
    // The base pipelines are created as before: the first 15 labels are the paint run's.
    const paintOnly = nativeFixture();
    const plain = await nativeScene(paintOnly, withoutLayer);
    expect(fixture.pipelineLabels.slice(0, 15)).toEqual(paintOnly.pipelineLabels);
    expect(plain.scene).toMatchObject({ layerPipelineAvailable: false, pipelinesCreated: 15 });
    expect(paintOnly.modules.some((code) => code.includes('layerPass'))).toBe(false);
    plain.creation.dispose();
    expect(accounting.snapshot().byCategory['render-pipeline'].live).toBe(27);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('creates only the variants of the variants the generation has', async () => {
    const fixture = nativeFixture();
    const { scene, creation } = await nativeScene(fixture, {
      clipPipeline: true,
      layerPipeline: true,
    });
    expect(scene).toMatchObject({ layerPipelineAvailable: true, meshPipelineAvailable: false });
    expect(fixture.pipelineLabels.filter((label) => label.includes('layer'))).toEqual([
      'vector-studio/e25-layer-composite-4x',
      'vector-studio/p1-analytic-primitive-4x+clip-v0+layer-v0',
    ]);
    creation.dispose();
  });

  const steps = [
    ['composite', 'e25-layer-composite'],
    ['analytic clip', 'primitive-stencil-4x+clip-v0+layer'],
    ['analytic paint clip', 'primitive-stencil-4x+paint-v0+clip-v0+layer'],
    ['mesh', 'p3-mesh-fill-4x+layer'],
    ['mesh joint paint clip', 'p3-mesh-joint-4x+paint-v0+clip-v0+layer'],
  ] as const;

  it.each(steps)(
    'a %s failure caches no layer variant and leaves the rest intact',
    async (_, failPipeline) => {
      const plain = await nativeScene(nativeFixture(), withoutLayer);
      const baseline = readyOf(plain.scene).readyEntries;
      const baselineLive = plain.accounting.snapshot().live;
      plain.creation.dispose();
      const { scene, creation, accounting } = await nativeScene(
        nativeFixture({ failPipeline }),
        allOptions,
      );
      expect(scene).toMatchObject({
        layerPipelineAvailable: false,
        paintPipelineAvailable: true,
        clipPipelineAvailable: true,
        meshPipelineAvailable: true,
        pipelinesCreated: 15,
        shaderModulesCreated: 11,
      });
      expect(readyOf(scene).readyEntries).toBe(baseline);
      expect(accounting.snapshot().live).toBe(baselineLive);
      creation.dispose();
      expect(accounting.snapshot().live).toBe(0);
    },
  );

  it('fewer than 4 bind groups leave the layer pipeline unavailable and create nothing', async () => {
    const fixture = nativeFixture();
    (fixture.device.limits as { maxBindGroups: number }).maxBindGroups = 3;
    const { scene, creation } = await nativeScene(fixture, allOptions);
    expect(scene).toMatchObject({ layerPipelineAvailable: false, pipelinesCreated: 15 });
    expect(fixture.modules.some((code) => code.includes('layerPass'))).toBe(false);
    creation.dispose();
  });

  it('rejects a layer tile size that is not a positive even integer', async () => {
    for (const layerTileSizeForTesting of [0, -2, 3, 1.5, Number.NaN]) {
      await expect(
        nativeScene(nativeFixture(), { ...allOptions, layerTileSizeForTesting }),
      ).rejects.toThrow('layerTileSizeForTesting must be a positive even integer.');
    }
  });
});

describe('E25 U3 layer passes and composites', () => {
  it('renders the layer in a tile pass, copies it, and composites it in paint order', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target, accounting } = await nativeScene(fixture, allOptions);
    const frameIds = layerFrameIds(accounting);
    const h = harness([
      box('a', 0),
      group('g', 0.5, ['b', 'p']),
      box('b', 20, 'g'),
      { ...strokedNode('p', 40), parentId: 'g' },
      box('c', 80),
    ]);
    const packet = prepared(h, target);
    expect(packet.layers?.layers.map((layer) => [layer.nodeId, layer.bound])).toEqual([
      ['g', { x: 18, y: 0, width: 38, height: 32 }],
    ]);
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(packet));
    expect(fixture.calls).toEqual([
      [
        'beginRenderPass',
        'vector-studio/layer-pass/0',
        `${frame}/tile-color`,
        `${frame}/tile-resolve`,
        `${frame}/tile-stencil`,
      ],
      ['setViewport', -18, -0, 640, 360, 0, 1],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 256],
      // The unclipped solid analytic run uses the base pipeline.
      ['setPipeline', stencilP1],
      ['setBindGroup', 0, 'primitive/1/arena-1/bind-group'],
      ['setVertexBuffer'],
      ['setIndexBuffer'],
      ['drawIndexed', 6, 1, 0, 0, 1],
      ['setPipeline', 'vector-studio/p3-mesh-fill-4x+layer-v0'],
      ['setBindGroup', 0, 'primitive/1/mesh-arena-2/bind-group'],
      ['setBindGroup', 1, layerEmpty],
      ['setBindGroup', 2, layerEmpty],
      ['setStencilReference', 1],
      ['draw', 6, 1, 0, 0],
      ['setStencilReference', 2],
      ['draw', 24, 1, 6, 1],
      ['end'],
      ['copyTextureToTexture', `${frame}/tile-resolve`, `${frame}/layer-0`, 0, 0, 38, 32],
      [
        'beginRenderPass',
        'vector-studio/primitive-pass',
        'primitive/1/attachment-1',
        null,
        'primitive/1/stencil-1',
      ],
      ['setPipeline', stencilP1],
      ['setBindGroup', 0, 'primitive/1/arena-1/bind-group'],
      ['setVertexBuffer'],
      ['setIndexBuffer'],
      ['drawIndexed', 6, 1, 0, 0, 0],
      ['setPipeline', composite],
      ['setBindGroup', 0, `${frame}/composite-0`],
      ['setBindGroup', 1, layerEmpty],
      ['setBindGroup', 2, layerEmpty],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 0],
      ['draw', 6],
      ['setPipeline', stencilP1],
      ['setBindGroup', 0, 'primitive/1/arena-1/bind-group'],
      ['setVertexBuffer'],
      ['setIndexBuffer'],
      ['drawIndexed', 6, 1, 0, 0, 2],
      ['end'],
    ]);
    // Records: the main pass, one tile, one composite, each at a 256-byte stride.
    expect(fixture.writes.filter((write) => write.label === `${frame}/records`)).toEqual([
      { label: `${frame}/records`, offset: 0, bytes: 3 * 256 },
    ]);
    expect(
      fixture.textures
        .filter((texture) => texture.label.startsWith(frame))
        .map(({ label, sampleCount, width, height }) => [label, sampleCount, width, height]),
    ).toEqual([
      [`${frame}/layer-0`, 1, 38, 32],
      [`${frame}/tile-color`, 4, 38, 32],
      [`${frame}/tile-resolve`, 1, 38, 32],
      [`${frame}/tile-stencil`, 4, 38, 32],
    ]);
    // E25-A06 unit part: every frame resource is released after submit.
    expect(fixture.destroyed.filter((label) => label.startsWith(frame)).sort()).toEqual(
      [
        `${frame}/layer-0`,
        `${frame}/tile-color`,
        `${frame}/tile-resolve`,
        `${frame}/tile-stencil`,
      ].sort(),
    );
    expect(frameIds.tracked.sort()).toEqual(
      ['layer-0', 'records', 'tile-color', 'tile-resolve', 'tile-stencil'].map(
        (name) => `${frame}/${name}`,
      ),
    );
    expect(frameIds.live()).toEqual([]);
    expect(scene.layerPasses).toBe(1);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });
});

/** The layer frames' tracked ids, and those still live (E25-A06 unit part). */
function layerFrameIds(accounting: ResourceAccounting) {
  const tracked: string[] = [];
  const live = new Set<string>();
  const track = accounting.track.bind(accounting);
  const release = accounting.release.bind(accounting);
  vi.spyOn(accounting, 'track').mockImplementation((id, descriptor) => {
    if (id.includes('/layer-frame-')) {
      tracked.push(id);
      live.add(id);
    }
    return track(id, descriptor);
  });
  vi.spyOn(accounting, 'release').mockImplementation((id) => {
    live.delete(id);
    return release(id);
  });
  return { tracked, live: () => [...live] };
}

/** The pass, pipeline, viewport, group 3, draw and copy calls, without the bind calls of 0. */
const outline = (calls: readonly (readonly unknown[])[]) =>
  calls
    .filter(
      ([name, index]) =>
        name === 'beginRenderPass' ||
        name === 'setViewport' ||
        name === 'setPipeline' ||
        name === 'copyTextureToTexture' ||
        name === 'drawIndexed' ||
        name === 'draw' ||
        (name === 'setBindGroup' && index === 3),
    )
    .map((call) => (call[0] === 'beginRenderPass' ? call.slice(0, 2) : call));

describe('E25 U3 nesting, tiles, ties and variants', () => {
  it('renders a nested layer first and composites it in its parent at the parent tile record', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, allOptions);
    const h = harness([
      group('g', 0.5, ['b', 'h']),
      box('b', 20, 'g'),
      group('h', 0.5, ['d'], 'g'),
      box('d', 30, 'h'),
    ]);
    const packet = prepared(h, target);
    expect(packet.layers?.layers.map((layer) => [layer.nodeId, layer.parent])).toEqual([
      ['h', 1],
      ['g', -1],
    ]);
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(packet));
    expect(outline(fixture.calls)).toEqual([
      ['beginRenderPass', 'vector-studio/layer-pass/0'],
      ['setViewport', -28, -18, 640, 360, 0, 1],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 256],
      ['setPipeline', stencilP1],
      ['drawIndexed', 6, 1, 0, 0, 1],
      ['copyTextureToTexture', `${frame}/tile-resolve`, `${frame}/layer-0`, 0, 0, 14, 14],
      ['beginRenderPass', 'vector-studio/layer-pass/1'],
      ['setViewport', -18, -16, 640, 360, 0, 1],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 512],
      ['setPipeline', stencilP1],
      ['drawIndexed', 6, 1, 0, 0, 0],
      // h composites into g's tile after b, with g's tile shift.
      ['setPipeline', composite],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 512],
      ['draw', 6],
      ['copyTextureToTexture', `${frame}/tile-resolve`, `${frame}/layer-1`, 0, 0, 26, 18],
      ['beginRenderPass', 'vector-studio/primitive-pass'],
      ['setPipeline', stencilP1],
      ['setPipeline', composite],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 0],
      ['draw', 6],
    ]);
    expect(fixture.calls).toContainEqual(['setBindGroup', 0, `${frame}/composite-0`]);
    expect(fixture.calls).toContainEqual(['setBindGroup', 0, `${frame}/composite-1`]);
    // Main pass, two tiles, two composites.
    expect(fixture.writes.find((write) => write.label === `${frame}/records`)?.bytes).toBe(5 * 256);
    expect(scene.layerPasses).toBe(2);
    creation.dispose();
  });

  it('places a composite between the mesh draws its meshOrder counts', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, allOptions);
    const h = harness([
      fillPath('p1', 0),
      group('g', 0.5, ['b']),
      box('b', 20, 'g'),
      fillPath('p2', 40),
    ]);
    const packet = prepared(h, target);
    expect(packet.layers?.composites).toEqual([
      { layer: 0, target: -1, position: 0, meshOrder: 1 },
    ]);
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(packet));
    const main = fixture.calls.findIndex((call) => call[1] === 'vector-studio/primitive-pass');
    expect(outline(fixture.calls.slice(main))).toEqual([
      ['beginRenderPass', 'vector-studio/primitive-pass'],
      ['setPipeline', stencilP1],
      ['setPipeline', 'vector-studio/p3-mesh-fill-4x'],
      ['draw', 6, 1, 0, 0],
      ['setPipeline', composite],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 0],
      ['draw', 6],
      // The next mesh draw binds its pipeline and group 0 again.
      ['setPipeline', 'vector-studio/p3-mesh-fill-4x'],
      ['draw', 6, 1, 6, 1],
    ]);
    expect(fixture.calls.slice(main).filter((call) => call[0] === 'setBindGroup')).toContainEqual([
      'setBindGroup',
      0,
      'primitive/1/mesh-arena-2/bind-group',
    ]);
    creation.dispose();
  });

  it('splits a layer wider than the tile into tiles, each at its viewport, record and offset', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, {
      ...allOptions,
      layerTileSizeForTesting: 16,
    });
    const h = harness([group('g', 0.5, ['b']), box('b', 20, 'g', red, 30)]);
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(prepared(h, target)));
    const tiles = outline(fixture.calls).filter(
      ([name, index]) =>
        name === 'setViewport' ||
        name === 'copyTextureToTexture' ||
        (name === 'setBindGroup' && index === 3),
    );
    expect(tiles).toEqual([
      ['setViewport', -18, -18, 640, 360, 0, 1],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 256],
      ['copyTextureToTexture', `${frame}/tile-resolve`, `${frame}/layer-0`, 0, 0, 16, 14],
      ['setViewport', -34, -18, 640, 360, 0, 1],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 512],
      ['copyTextureToTexture', `${frame}/tile-resolve`, `${frame}/layer-0`, 16, 0, 16, 14],
      ['setViewport', -50, -18, 640, 360, 0, 1],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 768],
      ['copyTextureToTexture', `${frame}/tile-resolve`, `${frame}/layer-0`, 32, 0, 2, 14],
      ['setBindGroup', 3, `${frame}/pass-bind-group`, 0],
    ]);
    const sizes = fixture.textures
      .filter((texture) => texture.label.startsWith(`${frame}/tile-`))
      .map((texture) => [texture.width, texture.height]);
    expect(sizes).toEqual([
      [16, 14],
      [16, 14],
      [16, 14],
    ]);
    // One layer pass per layer, not per tile.
    expect(scene.layerPasses).toBe(1);
    creation.dispose();
  });

  it('draws clipped and painted leaves in a layer through their layer variants', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, allOptions);
    const h = harness([
      group('g', 0.5, ['b', 'c']),
      box('b', 20, 'g', linear),
      group('c', 1, ['d'], 'g', { kind: 'rect', x: 35, y: 0, width: 100, height: 100 }),
      box('d', 30, 'c'),
    ]);
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(prepared(h, target)));
    const end = fixture.calls.findIndex((call) => call[0] === 'end');
    expect(fixture.calls.slice(3, end).filter((call) => call[0] !== 'setVertexBuffer')).toEqual([
      ['setPipeline', `${stencilP1}+paint-v0+layer-v0`],
      ['setBindGroup', 0, 'primitive/1/arena-1/bind-group'],
      ['setIndexBuffer'],
      ['setBindGroup', 1, layerEmpty],
      ['setBindGroup', 2, 'primitive/1/paint-primitives-2/bind-group'],
      ['drawIndexed', 6, 1, 0, 0, 0],
      ['setPipeline', `${stencilP1}+clip-v0+layer-v0`],
      // Clip records stay target-based: the same state offset as in the main pass.
      ['setBindGroup', 1, 'primitive/1/clip-states-1/bind-group', 1280],
      ['setBindGroup', 2, layerEmpty],
      ['drawIndexed', 6, 1, 0, 0, 1],
    ]);
    creation.dispose();
  });

  it('isolateUnitOpacityForTesting draws an opacity-1 container as a layer at alpha 1', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, allOptions);
    const nodes = [group('g', 1, ['b']), box('b', 20, 'g')];
    expect(prepared(harness(nodes), target).layers).toBeUndefined();
    const packet = prepared(harness(nodes, { isolateUnitOpacityForTesting: true }), target);
    expect(packet.layers?.layers.map((layer) => [layer.nodeId, layer.opacity])).toEqual([['g', 1]]);
    submitted(scene.submitPrimitivePacket(packet));
    expect(scene.layerPasses).toBe(1);
    creation.dispose();
  });
});

describe('E25 U3 fail-closed layers, identity and lifetime', () => {
  const nodes = () => [
    box('a', 0),
    group('g', 0.5, ['b', 'p']),
    box('b', 20, 'g'),
    fillPath('p', 40, 'g'),
    box('c', 80, null, linear),
  ];

  it('without the layer pipeline, layer content is not drawn and the rest is', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, withoutLayer);
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(prepared(harness(nodes()), target)));
    expect(outline(fixture.calls)).toEqual([
      ['beginRenderPass', 'vector-studio/primitive-pass'],
      ['setPipeline', stencilP1],
      ['drawIndexed', 6, 1, 0, 0, 0],
      ['setPipeline', `${stencilP1}+paint-v0`],
      ['drawIndexed', 6, 1, 0, 0, 2],
    ]);
    expect(fixture.textures.some((texture) => texture.label.includes('layer'))).toBe(false);
    expect(scene).toMatchObject({ layerPipelineAvailable: false, layerPasses: 0 });
    creation.dispose();
  });

  it('a scene without layers encodes exactly as without the layer pipeline', async () => {
    const flat = [
      box('a', 0),
      group('g', 1, ['b', 'p'], null, { kind: 'rect', x: 15, y: 0, width: 100, height: 100 }),
      box('b', 20, 'g', linear),
      fillPath('p', 40, 'g'),
      { ...strokedNode('s', 80, { opacity: 0.5 }), parentId: null } as RenderNodeSnapshot,
    ];
    const run = async (options: Parameters<typeof nativeScene>[1]) => {
      const fixture = nativeFixture();
      const { scene, creation, target } = await nativeScene(fixture, options);
      const packet = prepared(harness(flat), target);
      expect(packet.layers).toBeUndefined();
      submitted(scene.submitPrimitivePacket(packet));
      creation.dispose();
      return { calls: fixture.calls, writes: fixture.writes, textures: fixture.textures };
    };
    const withLayer = await run(allOptions);
    expect(withLayer).toEqual(await run(withoutLayer));
    expect(withLayer.calls.some((call) => call[0] === 'setBindGroup' && call[1] === 3)).toBe(false);
  });

  it('every frame with a layer re-renders it with new transients, released after each submit', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target, accounting } = await nativeScene(fixture, allOptions);
    const ids = layerFrameIds(accounting);
    const h = harness(nodes());
    const first = prepared(h, target);
    h.source.acknowledge(submitted(scene.submitPrimitivePacket(first)));
    const second = prepared(h, target);
    h.source.acknowledge(submitted(scene.submitPrimitivePacket(second)));
    expect(scene.layerPasses).toBe(2);
    expect(ids.tracked.filter((id) => id.endsWith('/layer-0'))).toEqual([
      'primitive/1/layer-frame-1/layer-0',
      'primitive/1/layer-frame-2/layer-0',
    ]);
    expect(ids.live()).toEqual([]);
    // Removing the container leaves no layer resource behind.
    h.replace([box('a', 0)]);
    h.source.acknowledge(submitted(scene.submitPrimitivePacket(prepared(h, target))));
    expect(scene.layerPasses).toBe(2);
    expect(ids.live()).toEqual([]);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('a failed layer allocation fails the frame and releases what it created', async () => {
    const fixture = nativeFixture();
    const createTexture = fixture.device.createTexture.bind(fixture.device);
    (fixture.device as { createTexture: GPUDevice['createTexture'] }).createTexture = (
      descriptor,
    ) => {
      if (descriptor.label?.endsWith('/tile-stencil') === true) throw new Error('out of memory');
      return createTexture(descriptor);
    };
    const { scene, creation, target, accounting } = await nativeScene(fixture, allOptions);
    const ids = layerFrameIds(accounting);
    expect(scene.submitPrimitivePacket(prepared(harness(nodes()), target))).toEqual({
      status: 'failed',
      reason: 'allocation-failed',
    });
    expect(ids.tracked.length).toBeGreaterThan(0);
    expect(ids.live()).toEqual([]);
    expect(scene.layerPasses).toBe(0);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('refuses a malformed layers part', async () => {
    const { scene, creation, target } = await nativeScene(nativeFixture(), allOptions);
    const packet = prepared(harness(nodes()), target);
    const part = packet.layers!;
    const broken = [
      { ...part, composites: [] },
      { ...part, layers: [{ ...part.layers[0]!, bound: { x: 17, y: 0, width: 38, height: 32 } }] },
      { ...part, layers: [{ ...part.layers[0]!, opacity: 0 }] },
      { ...part, composites: [{ ...part.composites[0]!, target: 0 }] },
    ];
    for (const layers of broken) {
      expect(scene.submitPrimitivePacket({ ...packet, layers })).toEqual({
        status: 'failed',
        reason: 'invalid-packet',
      });
    }
    creation.dispose();
  });
});

function fakeDevice(layerPipelineAvailable: boolean) {
  const scene: WebGpuPrimitiveScenePort = {
    sampleCount: 4,
    shaderModulesCreated: 1,
    pipelinesCreated: 1,
    meshPipelineAvailable: false,
    clipPipelineAvailable: true,
    layerPipelineAvailable,
    layerPasses: 3,
    setTarget: vi.fn(),
    submitPrimitivePacket: vi.fn(() => ({ status: 'not-ready' as const })),
    dispose: vi.fn(),
  };
  const createPrimitiveScene = vi.fn(() => ({
    result: Promise.resolve({ scene, fellBackFrom4x: false }),
    dispose: () => scene.dispose(),
  }));
  const device: WebGpuDevicePort = {
    features: [],
    limits: { maxTextureDimension2D: 4096, maxBufferSize: 256 * 1024 * 1024 },
    lost: new Promise(() => {}),
    createFoundationScene: () => {
      throw new Error('foundation mode is not used here');
    },
    createPrimitiveScene,
    waitForSubmittedWork: vi.fn(() => Promise.resolve()),
    subscribeErrors: vi.fn(() => ({ disposed: false, dispose: vi.fn() })),
    triggerValidationErrorForTesting: vi.fn(),
    destroy: vi.fn(),
  };
  const adapter: WebGpuAdapterPort = { info: {}, requestDevice: () => Promise.resolve(device) };
  return { adapter, createPrimitiveScene };
}

function platformFor(adapter: WebGpuAdapterPort): WebGpuPlatform {
  const context = { configure: vi.fn(), unconfigure: vi.fn() };
  return {
    secureContext: true,
    apiAvailable: true,
    requestAdapter: vi.fn(() => Promise.resolve(adapter)),
    getCanvasContext: vi.fn(() => context),
    getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
  };
}

const surface = {
  canvas: { width: 0, height: 0 } as HTMLCanvasElement,
  cssSize: { width: 640, height: 360 },
  devicePixelRatio: 1,
};

async function start(
  groups: 'flat' | 'isolated',
  device: ReturnType<typeof fakeDevice>,
  backendOptions: ConstructorParameters<typeof WebGpuBackend>[0] = {},
) {
  const backend = new WebGpuBackend({ platform: platformFor(device.adapter), ...backendOptions });
  const service = new PrimitiveRendererService(
    { invalidate: vi.fn(), setMode: vi.fn() },
    { clips: 'rect', groups },
  );
  backend.attachPrimitiveFrameSource(service);
  await backend.initialize(surface).catch(() => {});
  return { backend, service };
}

describe('E25 U3 the groups option and the backend (E25-A01 option wiring)', () => {
  const invalidate = () => ({ invalidate: vi.fn(), setMode: vi.fn() });

  it('the service asks for the layer pipeline exactly with groups isolated', () => {
    expect(
      new PrimitiveRendererService(invalidate(), { clips: 'rect', groups: 'isolated' })
        .requiresLayerPipeline,
    ).toBe(true);
    expect(new PrimitiveRendererService(invalidate()).requiresLayerPipeline).toBe(false);
    expect(
      new PrimitiveRendererService(invalidate(), { clips: 'all', groups: 'flat' })
        .requiresLayerPipeline,
    ).toBe(false);
  });

  it('rejects groups isolated with clips none, unknown groups, and a misplaced test hook', () => {
    expect(() => new PrimitiveRendererService(invalidate(), { groups: 'isolated' })).toThrow(
      "groups: 'isolated' needs clips other than 'none'.",
    );
    expect(
      () =>
        new PrimitiveRendererService(invalidate(), {
          clips: 'rect',
          groups: 'layered' as 'flat',
        }),
    ).toThrow("groups must be 'flat' or 'isolated'.");
    expect(
      () =>
        new PrimitiveRendererService(invalidate(), {
          clips: 'rect',
          isolateUnitOpacityForTesting: true,
        }),
    ).toThrow("isolateUnitOpacityForTesting needs groups: 'isolated'.");
  });

  it('accepts container opacity only with groups isolated', () => {
    const scene = (groups: 'flat' | 'isolated') => {
      const service = new PrimitiveRendererService(invalidate(), { clips: 'rect', groups });
      const result = service.replaceSnapshot({
        identity: { documentId: 'e25-u3', pageId: 'page' },
        revision: 1,
        nodes: [group('g', 0.5, ['b']), box('b', 20, 'g')],
        rootOrder: ['g'],
      });
      service.dispose();
      return result.status === 'invalid-scene' ? result.reason : result.status;
    };
    expect(scene('isolated')).toBe('applied');
    expect(scene('flat')).toBe('unsupported-feature');
  });

  it('the backend creates the scene with layerPipeline and the tile size only when asked', async () => {
    const asked = fakeDevice(true);
    const one = await start('isolated', asked, { layerTileSizeForTesting: 64 });
    expect(asked.createPrimitiveScene.mock.calls[0]).toContainEqual({
      clipPipeline: true,
      layerPipeline: true,
      layerTileSizeForTesting: 64,
    });
    expect(one.backend.getLayerPassesForTesting()).toBe(3);
    one.backend.dispose();
    one.service.dispose();
    const flat = fakeDevice(false);
    const two = await start('flat', flat, { layerTileSizeForTesting: 64 });
    expect(flat.createPrimitiveScene.mock.calls[0]).toContainEqual({ clipPipeline: true });
    expect(two.backend.getLayerPassesForTesting()).toBe(3);
    two.backend.dispose();
    two.service.dispose();
  });

  it('validates layerTileSizeForTesting', () => {
    for (const layerTileSizeForTesting of [0, 3, -2, 2.5]) {
      expect(() => new WebGpuBackend({ layerTileSizeForTesting })).toThrow(
        'layerTileSizeForTesting must be a positive even integer.',
      );
    }
    expect(() => new WebGpuBackend({ layerTileSizeForTesting: 64 })).not.toThrow();
  });

  it('with test hooks, an unavailable layer pipeline fails creation', async () => {
    const { backend, service } = await start('isolated', fakeDevice(false), {
      frameCaptureForTesting: true,
    });
    expect(backend.state).not.toBe('ready');
    backend.dispose();
    service.dispose();
    const ready = await start('isolated', fakeDevice(false));
    expect(ready.backend.state).toBe('ready');
    ready.backend.dispose();
    ready.service.dispose();
  });
});
