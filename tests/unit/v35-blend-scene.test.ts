import type { RenderNodeSnapshot, SceneBlendMode, SceneColor } from '@vector-studio/contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import {
  BACKDROP_PARENT_USAGE,
  backdropRect,
  backdropSnapshotShader,
  packBackdropSnapshotRecord,
} from '../../packages/renderer-webgpu/src/backdrop-pipeline.js';
import {
  BLEND_COMPOSITE_CLIP_SHADER,
  BLEND_COMPOSITE_SHADER,
  BLEND_MODE_INDEX,
  packBlendCompositeRecord,
} from '../../packages/renderer-webgpu/src/blend-composite-pipeline.js';
import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), unit U4: the snapshot (K4) and
// blend composite (K5) pipelines' creation, the end-and-resume of the main pass around a blend
// root's composite (one split), the usages only under `blend: 'v0'` (A06's resource part), no
// split without a blend root (A06) and the split counter (A07's unit part). Fake device seams
// only; the pixels are tests/gpu/v35-blend.spec.ts on SwiftShader.

const red: SceneColor = { r: 1, g: 0, b: 0, a: 0.8 };
const identity = { documentId: 'v35-u4', pageId: 'page' } as const;

function box(id: string, x: number, blendMode?: SceneBlendMode): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: [1, 0, 0, 1, x, 40],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: 20, height: 20, cornerRadii: [0, 0, 0, 0] },
    style: { fill: red, stroke: null },
    ...(blendMode === undefined ? {} : { blendMode }),
  };
}

function prepare(nodes: readonly RenderNodeSnapshot[], target: PrimitiveTarget): PrimitivePacket {
  const mirror = new RetainedSceneMirror(undefined, {
    pathNodes: 'unsupported',
    clips: 'supported',
    groupOpacity: 'supported',
    effects: 'v0',
    blend: 'v0',
  });
  mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
  const result = mirror.replaceSnapshot({
    identity,
    revision: 1,
    nodes,
    rootOrder: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  });
  expect(result.status).toBe('applied');
  return new PrimitiveSceneSource(mirror).prepare(target) as PrimitivePacket;
}

const layered = { clipPipeline: true, layerPipeline: true } as const;
const withBlend = { ...layered, blendPipeline: true } as const;

/** The passes and the pipelines bound in them. */
const outline = (calls: readonly (readonly unknown[])[]) =>
  calls
    .filter(([name]) => name === 'beginRenderPass' || name === 'setPipeline' || name === 'draw')
    .map((call) => (call[0] === 'beginRenderPass' ? call.slice(0, 2) : call));

describe('V-35 U4 blend pipeline creation (K4, K5, K7)', () => {
  it('creates the snapshot and the plain and clip blend composites with the layer pipeline', async () => {
    const without = await nativeScene(nativeFixture(), layered);
    const fixture = nativeFixture();
    const { scene, creation, accounting } = await nativeScene(fixture, withBlend);
    expect(scene.blendPipelineAvailable).toBe(true);
    expect(without.scene.blendPipelineAvailable).toBe(false);
    expect(fixture.modules).toContain(backdropSnapshotShader(4));
    expect(fixture.modules).toContain(BLEND_COMPOSITE_SHADER);
    expect(fixture.modules).toContain(BLEND_COMPOSITE_CLIP_SHADER);
    expect(fixture.pipelineLabels.filter((label) => label.includes('v35-'))).toEqual([
      'vector-studio/v35-backdrop-snapshot-v0-from-4x',
      'vector-studio/v35-blend-composite-v0-plain-4x',
      'vector-studio/v35-blend-composite-v0-clip-4x',
    ]);
    creation.dispose();
    without.creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('needs the layer pipeline', async () => {
    const fixture = nativeFixture();
    const { scene } = await nativeScene(fixture, { clipPipeline: true, blendPipeline: true });
    expect(scene.blendPipelineAvailable).toBe(false);
    expect(fixture.modules).not.toContain(BLEND_COMPOSITE_SHADER);
  });

  it('a failed blend composite leaves blending unavailable and releases what it tracked', async () => {
    const baseline = await nativeScene(nativeFixture(), layered);
    const fixture = nativeFixture({ failPipeline: 'v35-blend-composite-v0-clip' });
    const { scene, accounting, creation } = await nativeScene(fixture, withBlend);
    expect(scene.blendPipelineAvailable).toBe(false);
    expect(scene.layerPipelineAvailable).toBe(true);
    expect(accounting.snapshot().live).toBe(baseline.accounting.snapshot().live);
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });
});

describe('V-35 U4 records', () => {
  it('packs the blend composite record on the E25 prefix, the mode as a u32', () => {
    const view = new DataView(
      packBlendCompositeRecord({ x: 4, y: 6, width: 20, height: 10 }, 0.5, 'luminosity', {
        x: 3,
        y: 5,
      }).buffer,
    );
    expect([0, 4, 8, 12, 16].map((offset) => view.getFloat32(offset, true))).toEqual([
      4, 6, 20, 10, 0.5,
    ]);
    expect(view.getUint32(20, true)).toBe(BLEND_MODE_INDEX.luminosity);
    expect([24, 28].map((offset) => view.getFloat32(offset, true))).toEqual([3, 5]);
    expect(Object.values(BLEND_MODE_INDEX)).toEqual(
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
  });

  it('packs the snapshot record and clamps the snapshot rectangle to the parent', () => {
    const view = new DataView(
      packBackdropSnapshotRecord({ x: 70, y: 10 }, { x: 64, y: 0, width: 64, height: 32 }).buffer,
    );
    expect([0, 4, 8, 12].map((offset) => view.getFloat32(offset, true))).toEqual([6, 10, 63, 31]);
    const region = { x: 64, y: 0, width: 64, height: 32 };
    expect(backdropRect({ x: 60, y: 4, width: 10, height: 10 }, 0, region)).toEqual({
      x: 64,
      y: 4,
      width: 6,
      height: 10,
    });
    expect(backdropRect({ x: 60, y: 4, width: 10, height: 10 }, 2, region)).toEqual({
      x: 64,
      y: 2,
      width: 8,
      height: 14,
    });
    expect(backdropRect({ x: 0, y: 4, width: 10, height: 10 }, 0, region)).toBeNull();
  });
});

describe('V-35 U4 the main pass around a blend root (K4, A06, A07)', () => {
  it('ends the main pass, snapshots the backdrop and resumes it with load, once per root', async () => {
    const fixture = nativeFixture();
    // With the mesh pipeline, so that the main pass has a stencil attachment to carry over.
    const { scene, target, creation } = await nativeScene(fixture, {
      ...withBlend,
      meshPipeline: true,
    });
    const blendTarget = { ...target, blendLayers: true };
    const packet = prepare([box('a', 0), box('b', 10, 'multiply')], blendTarget);
    expect(packet.layers!.layers.map((layer) => layer.blend)).toEqual(['multiply']);
    fixture.calls.length = 0;
    const encoders = vi.spyOn(fixture.device, 'createCommandEncoder');
    submitted(scene.submitPrimitivePacket(packet));
    const calls = outline(fixture.calls);
    const passes = calls.filter((call) => call[0] === 'beginRenderPass').map((call) => call[1]);
    expect(passes.slice(-3)).toEqual([
      'vector-studio/primitive-pass',
      'vector-studio/backdrop-snapshot',
      'vector-studio/primitive-pass',
    ]);
    const snapshot = calls.findIndex((call) => call[1] === 'vector-studio/backdrop-snapshot');
    expect(calls.slice(snapshot + 1, snapshot + 3)).toEqual([
      ['setPipeline', 'vector-studio/v35-backdrop-snapshot-v0-from-4x'],
      ['draw', 3],
    ]);
    expect(calls.slice(snapshot + 3).map((call) => call[1])).toContain(
      'vector-studio/v35-blend-composite-v0-plain-stencil-4x',
    );
    // The first segment stores the attachment and stencil without a resolve; the second loads.
    type RecordedEncoder = { beginRenderPass: ReturnType<typeof vi.fn> };
    const begins = encoders.mock.results
      .flatMap((result) => (result.value as unknown as RecordedEncoder).beginRenderPass.mock.calls)
      .map((call) => call[0] as GPURenderPassDescriptor)
      .filter((descriptor) => descriptor.label === 'vector-studio/primitive-pass');
    const [first, second] = begins.slice(-2);
    const color = (descriptor: GPURenderPassDescriptor) => [...descriptor.colorAttachments][0]!;
    expect([color(first!).loadOp, color(first!).storeOp, color(first!).resolveTarget]).toEqual([
      'clear',
      'store',
      undefined,
    ]);
    expect(first!.depthStencilAttachment).toMatchObject({ stencilStoreOp: 'store' });
    expect([color(second!).loadOp, color(second!).storeOp]).toEqual(['load', 'discard']);
    expect(color(second!).resolveTarget).toBeDefined();
    expect(second!.depthStencilAttachment).toMatchObject({ stencilLoadOp: 'load' });
    expect(scene.blendSplits).toBe(1);
    // K4: the 4x attachment is readable only under blend.
    const msaa = fixture.textures.filter(
      (texture) => texture.sampleCount === 4 && texture.format === 'bgra8unorm',
    );
    expect(msaa.every((texture) => (texture.usage & BACKDROP_PARENT_USAGE) !== 0)).toBe(true);
    creation.dispose();
  });

  it('A06: without a blend root, the frame makes no split and the same passes', async () => {
    const plainFixture = nativeFixture();
    const plain = await nativeScene(plainFixture, layered);
    const blendFixture = nativeFixture();
    const blend = await nativeScene(blendFixture, withBlend);
    const nodes = [box('a', 0), box('b', 10)];
    plainFixture.calls.length = 0;
    blendFixture.calls.length = 0;
    submitted(plain.scene.submitPrimitivePacket(prepare(nodes, plain.target)));
    submitted(
      blend.scene.submitPrimitivePacket(prepare(nodes, { ...blend.target, blendLayers: true })),
    );
    expect(outline(blendFixture.calls)).toEqual(outline(plainFixture.calls));
    expect(blend.scene.blendSplits).toBe(0);
    // Under blend 'none' no usage is added to the attachment.
    const msaa = plainFixture.textures.filter(
      (texture) => texture.sampleCount === 4 && texture.format === 'bgra8unorm',
    );
    expect(msaa.length).toBeGreaterThan(0);
    expect(msaa.every((texture) => (texture.usage & BACKDROP_PARENT_USAGE) === 0)).toBe(true);
    plain.creation.dispose();
    blend.creation.dispose();
  });

  it('K7: without blendLayers on the target the source draws the root as normal', async () => {
    const fixture = nativeFixture();
    const { scene, target, creation } = await nativeScene(fixture, withBlend);
    const packet = prepare([box('a', 0), box('b', 10, 'multiply')], target);
    expect(packet.layers?.layers.some((layer) => layer.blend !== undefined) ?? false).toBe(false);
    submitted(scene.submitPrimitivePacket(packet));
    expect(scene.blendSplits).toBe(0);
    creation.dispose();
  });
});
