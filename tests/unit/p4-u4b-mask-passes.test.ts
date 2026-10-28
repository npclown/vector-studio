import type { RenderNodeSnapshot, SceneAffine, SceneClip } from '@vector-studio/contracts';
import { PrimitiveRendererService, type PrimitivePacket } from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

import {
  CLIP_STATE_HEADER_SIZE,
  MESH_FILL_MASK_SHADER,
  PRIMITIVE_ANALYTIC_MASK_SHADER,
  packClipState,
} from '../../packages/renderer-webgpu/src/clip-pipeline.js';
import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';
import { ScriptedStrokeMeshPort, createStrokeHarness } from '../support/st-u6-stroke-harness.js';
import { createCountingPort, pathNode } from '../support/v3a-path-harness.js';

// P4 contract (docs/plans/p4-clip-mask.md), unit U4b: the mask passes (section 4, Mask
// coverage textures, Mask-pass state), the mask cache and its `maskPasses` count, the mask
// lanes of the clip records, mask resources in accounting (P4-A08, U4 part) and the
// `clips: 'all'` service option. Fake device seams only; the rendered evidence is U5's.

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const MASK: SceneClip = { kind: 'mask' };

function group(
  id: string,
  children: readonly string[],
  clip: SceneClip,
  parentId: string | null = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: IDENTITY,
    visible: true,
    opacity: 1,
    kind: 'container',
    clip,
    children,
  };
}

function box(
  id: string,
  parentId: string | null,
  x: number,
  y = 20,
  size = 10,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, y],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: size, height: size, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 0, b: 0, a: 1 }, stroke: null },
  };
}

function harness(nodes: readonly RenderNodeSnapshot[]) {
  return createStrokeHarness({
    fillPort: createCountingPort(),
    strokePort: new ScriptedStrokeMeshPort(),
    clips: 'supported',
    nodes,
  });
}

/** A mask with a 100-unit primitive source at (10, 20) and one clipped box. */
const primitiveMask = () => [
  group('m', ['s', 'a'], MASK),
  box('s', 'm', 10, 20, 100),
  box('a', 'm', 30),
];

const passCalls = [
  'beginRenderPass',
  'setViewport',
  'setPipeline',
  'setBindGroup',
  'setStencilReference',
  'drawIndexed',
  'draw',
  'end',
];

function encoded(calls: readonly (readonly unknown[])[]) {
  return calls
    .filter(([name]) => passCalls.includes(name as string))
    .map((call) => (call[0] === 'setBindGroup' && call[1] === 0 ? ['setBindGroup', 0] : call));
}

describe('P4 U4b mask lanes', () => {
  const rect = { toLocal: [1, 0, 0, 1, -5, 0] as SceneAffine, width: 30, height: 40 };

  it('packs the mask flag, texel offset and pixel shift in the header', () => {
    const bytes = packClipState(
      { rects: [], masks: ['m'] },
      { x: 0, y: 0 },
      {
        maskOffset: [-8, -18],
        pixelShift: [3, 4],
      },
    )!;
    const view = new DataView(bytes.buffer);
    expect([
      view.getUint32(0, true),
      view.getUint32(4, true),
      view.getInt32(8, true),
      view.getInt32(12, true),
      view.getFloat32(16, true),
      view.getFloat32(20, true),
    ]).toEqual([0, 1, -8, -18, 3, 4]);
    // Without a mask level the header has no flag; the rects follow the header.
    const pass = packClipState(
      { rects: [rect], masks: [] },
      { x: 0, y: 0 },
      {
        maskOffset: null,
        pixelShift: [8, 18],
      },
    )!;
    const passView = new DataView(pass.buffer);
    expect(passView.getUint32(4, true)).toBe(0);
    expect(passView.getFloat32(CLIP_STATE_HEADER_SIZE + 16, true)).toBe(-5);
  });

  it('refuses a mask level without an offset, an offset without one, and fractional lanes', () => {
    const lanes = { maskOffset: [0, 0] as const, pixelShift: [0, 0] as const };
    expect(packClipState({ rects: [], masks: [] }, { x: 0, y: 0 }, lanes)).toBeNull();
    expect(
      packClipState({ rects: [], masks: ['m'] }, { x: 0, y: 0 }, { ...lanes, maskOffset: null }),
    ).toBeNull();
    expect(
      packClipState(
        { rects: [], masks: ['m'] },
        { x: 0, y: 0 },
        { ...lanes, pixelShift: [0.5, 0] },
      ),
    ).toBeNull();
    // U3's packing is unchanged without lanes.
    expect(packClipState({ rects: [], masks: ['m'] }, { x: 0, y: 0 })).toBeNull();
  });

  it('builds the mask modules from the clip block', () => {
    expect(PRIMITIVE_ANALYTIC_MASK_SHADER).toContain('let slot = instanceIndex;');
    expect(PRIMITIVE_ANALYTIC_MASK_SHADER).not.toContain('order[instanceIndex]');
    expect(PRIMITIVE_ANALYTIC_MASK_SHADER).toContain('textureLoad(clipMask');
    expect(MESH_FILL_MASK_SHADER).toContain(
      'meshCoverage(input.position.xy + clipState.pixelShift, triangle, instance)',
    );
  });
});

describe('P4 U4b mask passes', () => {
  it('renders a primitive source before the main pass; the content samples the texture', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    const packet = harness(primitiveMask()).source.prepare(target)!;
    expect(packet.clip!.masks.map((level) => [level.id, level.device])).toEqual([
      ['m', { x: 8, y: 18, width: 104, height: 104 }],
    ]);
    submitted(scene.submitPrimitivePacket(packet));
    const p1 = 'vector-studio/p1-analytic-primitive-stencil-4x';
    expect(encoded(fixture.calls)).toEqual([
      [
        'beginRenderPass',
        'vector-studio/mask-pass/m',
        'primitive/1/mask-pass-1/color',
        'primitive/1/mask-1',
        null,
      ],
      ['setViewport', -8, -18, 640, 360, 0, 1],
      ['setPipeline', 'vector-studio/p1-analytic-primitive-4x+mask-v0'],
      ['setBindGroup', 0],
      ['setBindGroup', 1, 'primitive/1/clip-states-1/bind-group', 2 * 1280],
      ['drawIndexed', 6, 1, 0, 0, 0],
      ['end'],
      [
        'beginRenderPass',
        'vector-studio/primitive-pass',
        'primitive/1/attachment-1',
        null,
        'primitive/1/stencil-1',
      ],
      ['setPipeline', p1],
      ['setBindGroup', 0],
      ['setPipeline', `${p1}+clip-v0`],
      ['setBindGroup', 1, 'primitive/1/mask-1/bind-group', 1280],
      ['drawIndexed', 6, 1, 0, 0, 0],
      ['end'],
    ]);
    expect(scene.maskPasses).toBe(1);
    creation.dispose();
  });

  it('caches the texture: a pass runs only when the key changes (Mask cache)', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target, accounting } = await nativeScene(fixture);
    const h = harness(primitiveMask());
    const submit = () => submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    submit();
    submit();
    expect(scene.maskPasses).toBe(1);
    // A content edit keeps the key.
    h.replace([...primitiveMask().slice(0, 2), box('a', 'm', 35)]);
    submit();
    expect(scene.maskPasses).toBe(1);
    // A pan re-renders the same-size texture in place.
    h.mirror.setCamera({ position: { x: 1, y: 0 }, zoom: 1 });
    submit();
    expect(scene.maskPasses).toBe(2);
    expect(
      fixture.textures.filter(({ label }) => label.includes('/mask-') && !label.includes('pass')),
    ).toHaveLength(1);
    // The transient 4x targets are released after each submission.
    expect(fixture.destroyed.filter((label) => label.includes('mask-pass'))).toHaveLength(2);
    const live = accounting.snapshot().byCategory.texture.live;
    // Once no clip is left, the mask texture goes and accounting is back at its baseline.
    h.replace([box('x', null, 0)]);
    submit();
    expect(accounting.snapshot().byCategory.texture.live).toBe(live - 1);
    expect(fixture.destroyed).toContain('primitive/1/mask-1');
    creation.dispose();
    expect(accounting.snapshot().live).toBe(0);
  });

  it('draws a mesh source with the write-once stencil at reference 1', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    const h = harness([
      group('m', ['s', 'a'], MASK),
      pathNode('s', 0, { parentId: 'm', fill: null, points: [0, 0, 200, 0, 0, 200] }),
      box('a', 'm', 30),
    ]);
    const packet: PrimitivePacket = h.source.prepare(target)!;
    const level = packet.clip!.masks[0]!;
    if (level.source.kind !== 'mesh') throw new Error('expected a mesh source');
    const draw = level.source.draw!;
    submitted(scene.submitPrimitivePacket(packet));
    const calls = encoded(fixture.calls);
    expect(calls.slice(0, 7)).toEqual([
      [
        'beginRenderPass',
        'vector-studio/mask-pass/m',
        'primitive/1/mask-pass-1/color',
        'primitive/1/mask-1',
        'primitive/1/mask-pass-1/stencil',
      ],
      ['setViewport', -level.device.x, -level.device.y, 640, 360, 0, 1],
      ['setPipeline', 'vector-studio/p3-mesh-fill-4x+mask-v0'],
      ['setBindGroup', 0],
      ['setBindGroup', 1, 'primitive/1/clip-states-1/bind-group', 2 * 1280],
      ['setStencilReference', 1],
      ['draw', 3 * draw.triangleCount, 1, 3 * draw.firstTriangle, draw.instance],
    ]);
    expect(
      fixture.textures.find(
        ({ label }) => label.endsWith('/stencil') && label.includes('mask-pass'),
      ),
    ).toMatchObject({ format: 'stencil8', sampleCount: 4 });
    creation.dispose();
  });

  it('nests: the child pass reads the parent texture at its texel offset', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    const packet = harness([
      group('outer', ['os', 'inner'], MASK),
      box('os', 'outer', 0, 0, 200),
      group('inner', ['is', 'a'], MASK, 'outer'),
      box('is', 'inner', 50, 40, 60),
      box('a', 'inner', 60, 50),
    ]).source.prepare(target)!;
    expect(packet.clip!.masks.map((level) => level.id)).toEqual(['outer', 'inner']);
    submitted(scene.submitPrimitivePacket(packet));
    const groups = encoded(fixture.calls).filter(
      (call) => call[0] === 'setBindGroup' && call[1] === 1,
    );
    expect(groups).toEqual([
      ['setBindGroup', 1, 'primitive/1/clip-states-1/bind-group', 2 * 1280],
      ['setBindGroup', 1, 'primitive/1/mask-1/bind-group', 3 * 1280],
      ['setBindGroup', 1, 'primitive/1/mask-2/bind-group', 1280],
    ]);
    // The inner pass record: no rect, the parent texture at the offset between the two rects.
    const written = fixture.writes.filter(({ label }) => label.includes('clip-states'));
    expect(written.map(({ offset }) => offset)).toEqual([0, 1280, 2 * 1280, 3 * 1280]);
    creation.dispose();
  });

  it('refuses a content state under a mask level the part lacks, and a level outside the target', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    const packet = harness(primitiveMask()).source.prepare(target)!;
    const clip = packet.clip!;
    expect(scene.submitPrimitivePacket({ ...packet, clip: { ...clip, masks: [] } })).toEqual({
      status: 'failed',
      reason: 'invalid-packet',
    });
    const outside = { ...clip.masks[0]!, device: { x: 600, y: 0, width: 100, height: 10 } };
    expect(scene.submitPrimitivePacket({ ...packet, clip: { ...clip, masks: [outside] } })).toEqual(
      {
        status: 'failed',
        reason: 'invalid-packet',
      },
    );
    const unwritten = { ...clip.masks[0]!, source: { kind: 'primitive' as const, slot: 99 } };
    expect(
      scene.submitPrimitivePacket({ ...packet, clip: { ...clip, masks: [unwritten] } }),
    ).toEqual({ status: 'failed', reason: 'invalid-packet' });
    // Nothing was created by the refused packets.
    expect(fixture.textures.filter(({ label }) => label.includes('/mask-'))).toEqual([]);
    creation.dispose();
  });

  it('releases the mask textures on resize and dispose', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target, accounting } = await nativeScene(fixture);
    submitted(scene.submitPrimitivePacket(harness(primitiveMask()).source.prepare(target)!));
    scene.setTarget({ ...target, surfaceRevision: 2, width: 320 });
    expect(fixture.destroyed).toContain('primitive/1/mask-1');
    submitted(
      scene.submitPrimitivePacket(
        harness(primitiveMask()).source.prepare({ ...target, surfaceRevision: 2, width: 320 })!,
      ),
    );
    creation.dispose();
    expect(fixture.destroyed).toContain('primitive/1/mask-2');
    expect(accounting.snapshot().live).toBe(0);
  });
});

describe('P4 U4b mask failures and buffer growth', () => {
  it('a failed submission discards the created texture; the next frame renders it again', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target, accounting } = await nativeScene(fixture);
    const h = harness(primitiveMask());
    const live = accounting.snapshot().byCategory.texture.live;
    const queue = fixture.device.queue as unknown as { submit: ReturnType<typeof vi.fn> };
    queue.submit.mockImplementationOnce(() => {
      throw new Error('injected submission failure');
    });
    expect(scene.submitPrimitivePacket(h.source.prepare(target)!)).toEqual({
      status: 'failed',
      reason: 'submission-failed',
    });
    expect(fixture.destroyed).toContain('primitive/1/mask-1');
    expect(accounting.snapshot().byCategory.texture.live).toBe(live);
    expect(scene.maskPasses).toBe(0);
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    expect(scene.maskPasses).toBe(1);
    creation.dispose();
  });

  it('a cached texture gets a new bind group when the clip buffer grows', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture);
    const h = harness(primitiveMask());
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    h.replace([
      ...primitiveMask(),
      group('c1', ['b1'], { kind: 'rect', x: 0, y: 0, width: 300, height: 300 }),
      box('b1', 'c1', 200),
      group('c2', ['b2'], { kind: 'rect', x: 0, y: 0, width: 300, height: 300 }),
      box('b2', 'c2', 220),
    ]);
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    expect(scene.maskPasses).toBe(1);
    const device = fixture.device as unknown as {
      createBindGroup: ReturnType<typeof vi.fn<(descriptor: GPUBindGroupDescriptor) => unknown>>;
    };
    const labels = device.createBindGroup.mock.calls.map(([descriptor]) => descriptor.label);
    expect(labels.filter((label) => label === 'primitive/1/mask-1/bind-group')).toHaveLength(2);
    expect(labels).toContain('primitive/1/clip-states-2/bind-group');
    creation.dispose();
  });

  it('without the mesh path a mesh source pass only clears its texture', async () => {
    const fixture = nativeFixture();
    const { scene, creation, target } = await nativeScene(fixture, { clipPipeline: true });
    const packet = harness([
      group('m', ['s', 'a'], MASK),
      pathNode('s', 0, { parentId: 'm', fill: null, points: [0, 0, 200, 0, 0, 200] }),
      box('a', 'm', 30),
    ]).source.prepare(target)!;
    submitted(scene.submitPrimitivePacket(packet));
    expect(encoded(fixture.calls).slice(0, 3)).toEqual([
      [
        'beginRenderPass',
        'vector-studio/mask-pass/m',
        'primitive/1/mask-pass-1/color',
        'primitive/1/mask-1',
        null,
      ],
      [
        'setViewport',
        -packet.clip!.masks[0]!.device.x,
        -packet.clip!.masks[0]!.device.y,
        640,
        360,
        0,
        1,
      ],
      ['end'],
    ]);
    creation.dispose();
  });
});

describe("P4 U4b service option clips: 'all'", () => {
  it('accepts mask containers and asks for the clip pipeline', () => {
    const invalidate = { invalidate: () => undefined, setMode: () => undefined };
    const service = new PrimitiveRendererService(invalidate, { clips: 'all' });
    expect(service.requiresClipPipeline).toBe(true);
    expect(
      service.replaceSnapshot({
        identity: { documentId: 'p4-u4b', pageId: 'page' },
        revision: 1,
        rootOrder: ['m'],
        nodes: primitiveMask(),
      }),
    ).toMatchObject({ status: 'applied' });
    service.dispose();
  });
});
