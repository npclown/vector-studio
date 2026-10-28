import type { RenderNodeSnapshot, SceneAffine, SceneClip } from '@vector-studio/contracts';
import {
  P4_MASK_TEXTURE_BYTES_MAX,
  maskTileSet,
  type PrimitivePacket,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';
import { describe, expect, it, vi } from 'vitest';

import { nativeFixture, nativeScene, submitted } from '../support/p4-native-fixture.js';
import { ScriptedStrokeMeshPort, createStrokeHarness } from '../support/st-u6-stroke-harness.js';
import { createCountingPort, pathNode } from '../support/v3a-path-harness.js';

// E22 contract (docs/plans/d9-e22-clip-follow-ups-contract.md), unit U1: one tile set per frame
// (E22-K1, A1), tiled mask passes with per-tile pass records (K2), and the budget of resident
// textures plus one tile set (K3, A2, A3). Fake device seams only; the rendered evidence is
// E22-A4 (SwiftShader) and A5 (headed).

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];
const MASK: SceneClip = { kind: 'mask' };

function group(
  id: string,
  children: readonly string[],
  parentId: string | null = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: IDENTITY,
    visible: true,
    opacity: 1,
    kind: 'container',
    clip: MASK,
    children,
  };
}

function box(id: string, parentId: string | null, x: number, y: number, size: number) {
  return {
    id,
    parentId,
    transform: [1, 0, 0, 1, x, y],
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width: size, height: size, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
  } satisfies RenderNodeSnapshot;
}

function harness(nodes: readonly RenderNodeSnapshot[]) {
  return createStrokeHarness({
    fillPort: createCountingPort(),
    strokePort: new ScriptedStrokeMeshPort(),
    clips: 'supported',
    nodes,
  });
}

/** `count` full-surface masks, each with one content box. */
function fullMasks(count: number, size = 5000) {
  return Array.from({ length: count }, (_, index) => [
    group(`m${index}`, [`s${index}`, `a${index}`]),
    box(`s${index}`, `m${index}`, -10, -10, size),
    box(`a${index}`, `m${index}`, 300 + 10 * index, 10, 5),
  ]).flat();
}

const UHD = { width: 3840, height: 2160 };

/** The plan's bytes for a packet's mask levels (E22-K3). */
function planned(packet: PrimitivePacket, sampleCount: 1 | 4): number {
  const masks = packet.clip?.masks ?? [];
  if (masks.length === 0) return 0;
  const resident = masks.reduce((sum, level) => sum + level.device.width * level.device.height, 0);
  return (
    resident +
    maskTileSet(
      Math.max(...masks.map((level) => level.device.width)),
      Math.max(...masks.map((level) => level.device.height)),
      sampleCount,
    ).bytes
  );
}

describe('E22-A3 mask plan figures', () => {
  const target: PrimitiveTarget = {
    generation: 1,
    surfaceRevision: 1,
    ...UHD,
    devicePixelRatio: 1,
    sampleCount: 4,
    targetFormat: 'bgra8unorm',
  };

  it('fits six full-screen 3840 × 2160 masks at 4x and reports the seventh', () => {
    const packet = harness(fullMasks(7)).source.prepare(target)!;
    expect(packet.clip!.masks).toHaveLength(6);
    expect(packet.clip!.masks[0]!.device).toEqual({ x: 0, y: 0, ...UHD });
    expect(planned(packet, 4)).toBe(59_203_584);
    expect(packet.clipNotices).toEqual([
      { nodeId: 'm6', bytes: 67_497_984, limit: P4_MASK_TEXTURE_BYTES_MAX },
    ]);
  });

  it('fits seven at 1x and reports the eighth', () => {
    const packet = harness(fullMasks(8)).source.prepare({ ...target, sampleCount: 1 })!;
    expect(packet.clip!.masks).toHaveLength(7);
    expect(planned(packet, 1)).toBe(60_157_952);
    expect(packet.clipNotices).toEqual([
      { nodeId: 'm7', bytes: 68_452_352, limit: P4_MASK_TEXTURE_BYTES_MAX },
    ]);
  });

  it('sizes the tile set from levels smaller than a tile', () => {
    expect(maskTileSet(300, 200, 4)).toEqual({ width: 300, height: 200, bytes: 300 * 200 * 9 });
    expect(maskTileSet(3840, 200, 1)).toEqual({ width: 1024, height: 200, bytes: 1024 * 200 * 2 });
    const packet = harness([
      group('m', ['s', 'a']),
      box('s', 'm', 0, 0, 100),
      box('a', 'm', 5, 5, 5),
    ]).source.prepare({ ...target, devicePixelRatio: 1 })!;
    // 100 units plus the 2 px guard on each side.
    expect(packet.clip!.masks[0]!.device).toEqual({ x: 0, y: 0, width: 102, height: 102 });
  });
});

/** A fake-device scene at `width × height`; live texture bytes are sampled at every track. */
async function sceneAt(width: number, height: number) {
  const fixture = nativeFixture();
  const context = await nativeScene(fixture);
  const target: PrimitiveTarget = { ...context.target, surfaceRevision: 2, width, height };
  context.scene.setTarget(target);
  const textureBytes = () => context.accounting.snapshot().byCategory.texture.liveBytes;
  const baseline = textureBytes();
  let peak = 0;
  const track = context.accounting.track.bind(context.accounting);
  vi.spyOn(context.accounting, 'track').mockImplementation((...args) => {
    const result = track(...args);
    peak = Math.max(peak, textureBytes() - baseline);
    return result;
  });
  return {
    ...context,
    fixture,
    target,
    /** The highest mask texture bytes seen since the last call. */
    takePeak: () => {
      const value = peak;
      peak = 0;
      return value;
    },
  };
}

describe('E22-K1 and K2 tiled mask passes', () => {
  it('renders a level larger than a tile in per-tile passes over one tile set (E22-A1)', async () => {
    const { scene, creation, fixture, target, takePeak } = await sceneAt(2048, 1500);
    const packet = harness([
      group('m', ['s', 'a']),
      box('s', 'm', 0, 0, 3000),
      box('a', 'm', 30, 30, 10),
    ]).source.prepare(target)!;
    const level = packet.clip!.masks[0]!;
    expect(level.device).toEqual({ x: 0, y: 0, width: 2048, height: 1500 });
    fixture.calls.length = 0;
    submitted(scene.submitPrimitivePacket(packet));
    const tiles = fixture.textures.filter(({ label }) => label.includes('mask-tiles'));
    expect(
      tiles.map(({ label, width, height, sampleCount }) => [label, width, height, sampleCount]),
    ).toEqual([
      ['primitive/1/mask-tiles-1/color', 1024, 1024, 4],
      ['primitive/1/mask-tiles-1/resolve', 1024, 1024, 1],
    ]);
    // COPY_SRC on the resolve tile, COPY_DST on the mask texture.
    expect(tiles[1]!.usage & 0x01).toBe(0x01);
    expect(fixture.textures.find(({ label }) => label === 'primitive/1/mask-1')!.usage & 0x02).toBe(
      0x02,
    );
    const viewports = fixture.calls.filter(([name]) => name === 'setViewport').slice(0, 4);
    expect(viewports).toEqual([
      ['setViewport', -0, -0, 2048, 1500, 0, 1],
      ['setViewport', -1024, -0, 2048, 1500, 0, 1],
      ['setViewport', -0, -1024, 2048, 1500, 0, 1],
      ['setViewport', -1024, -1024, 2048, 1500, 0, 1],
    ]);
    expect(fixture.calls.filter(([name]) => name === 'copyTextureToTexture')).toEqual([
      [
        'copyTextureToTexture',
        'primitive/1/mask-tiles-1/resolve',
        'primitive/1/mask-1',
        0,
        0,
        1024,
        1024,
      ],
      [
        'copyTextureToTexture',
        'primitive/1/mask-tiles-1/resolve',
        'primitive/1/mask-1',
        1024,
        0,
        1024,
        1024,
      ],
      [
        'copyTextureToTexture',
        'primitive/1/mask-tiles-1/resolve',
        'primitive/1/mask-1',
        0,
        1024,
        1024,
        476,
      ],
      [
        'copyTextureToTexture',
        'primitive/1/mask-tiles-1/resolve',
        'primitive/1/mask-1',
        1024,
        1024,
        1024,
        476,
      ],
    ]);
    // Each tile binds its own pass record after maxIndex.
    const stride = 1280;
    const offsets = fixture.calls
      .filter((call) => call[0] === 'setBindGroup' && call[1] === 1)
      .slice(0, 4)
      .map((call) => (call[3] as number) / stride);
    const first = packet.clip!.maxIndex + 1;
    expect(offsets).toEqual([first, first + 1, first + 2, first + 3]);
    expect(takePeak()).toBeLessThanOrEqual(planned(packet, 4));
    expect(fixture.destroyed.filter((label) => label.includes('mask-tiles'))).toHaveLength(2);
    creation.dispose();
  });

  it('writes per-tile pixel shifts and parent texel offsets (E22-K2)', async () => {
    const { scene, creation, fixture, target } = await sceneAt(2048, 1100);
    const packet = harness([
      group('outer', ['os', 'inner']),
      box('os', 'outer', 0, 0, 3000),
      group('inner', ['is', 'a'], 'outer'),
      box('is', 'inner', 100, 50, 1500),
      box('a', 'inner', 200, 100, 10),
    ]).source.prepare(target)!;
    const [outer, inner] = packet.clip!.masks;
    expect(outer!.device).toEqual({ x: 0, y: 0, width: 2048, height: 1100 });
    expect(inner!.device).toEqual({ x: 98, y: 48, width: 1504, height: 1052 });
    const queue = fixture.device.queue as unknown as {
      writeBuffer: ReturnType<
        typeof vi.fn<(b: { label: string }, o: number, d: Uint8Array) => void>
      >;
    };
    queue.writeBuffer.mockClear();
    submitted(scene.submitPrimitivePacket(packet));
    const stride = 1280;
    const lanes = new Map<number, number[]>();
    for (const [buffer, offset, bytes] of queue.writeBuffer.mock.calls) {
      if (!buffer.label.includes('clip-states') || offset === 0) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      lanes.set(offset / stride, [
        view.getUint32(4, true),
        view.getInt32(8, true),
        view.getInt32(12, true),
        view.getFloat32(16, true),
        view.getFloat32(20, true),
      ]);
    }
    const first = packet.clip!.maxIndex + 1;
    // outer: 2 × 2 tiles, no parent; inner: 2 × 2 tiles under outer (its texel offset is the
    // tile's target pixel, since outer starts at the origin).
    expect([...Array(8).keys()].map((index) => lanes.get(first + index))).toEqual([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 1024, 0],
      [0, 0, 0, 0, 1024],
      [0, 0, 0, 1024, 1024],
      [1, 98, 48, 98, 48],
      [1, 1122, 48, 1122, 48],
      [1, 98, 1072, 98, 1072],
      [1, 1122, 1072, 1122, 1072],
    ]);
    creation.dispose();
  });

  it('a mesh source adds the stencil tile; a frame without a re-rendered level creates none', async () => {
    const { scene, creation, fixture, target } = await sceneAt(640, 360);
    const h = harness([
      group('m', ['s', 'a']),
      pathNode('s', 0, { parentId: 'm', fill: null, points: [0, 0, 200, 0, 0, 200] }),
      box('a', 'm', 30, 30, 10),
    ]);
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    expect(
      fixture.textures
        .filter(({ label }) => label.includes('mask-tiles'))
        .map(({ label }) => label),
    ).toEqual([
      'primitive/1/mask-tiles-1/color',
      'primitive/1/mask-tiles-1/resolve',
      'primitive/1/mask-tiles-1/stencil',
    ]);
    const created = fixture.textures.length;
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    expect(fixture.textures).toHaveLength(created);
    creation.dispose();
  });
});

describe('E22-K3 live mask bytes within the plan (E22-A2)', () => {
  it('a frame where every level changes size holds no old texture beside its new one', async () => {
    const { scene, creation, fixture, target, takePeak } = await sceneAt(3840, 2160);
    const h = harness(fullMasks(6));
    const first = h.source.prepare(target)!;
    expect(first.clip!.masks).toHaveLength(6);
    submitted(scene.submitPrimitivePacket(first));
    expect(takePeak()).toBeLessThanOrEqual(planned(first, 4));
    // A pan left moves the source's left edge into the surface: every level's rect shrinks.
    h.mirror.setCamera({ position: { x: -110, y: 0 }, zoom: 1 });
    const panned = h.source.prepare(target)!;
    expect(panned.clip!.masks.map((level) => level.device)).toEqual(
      Array(6).fill({ x: 98, y: 0, width: 3742, height: 2160 }),
    );
    submitted(scene.submitPrimitivePacket(panned));
    expect(takePeak()).toBeLessThanOrEqual(planned(panned, 4));
    expect(fixture.destroyed.filter((label) => /mask-\d+$/.test(label))).toHaveLength(6);
    creation.dispose();
  });

  it('a level replaced by another releases the old texture first', async () => {
    const { scene, creation, target, takePeak } = await sceneAt(3840, 2160);
    const h = harness(fullMasks(6));
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    takePeak();
    h.replace([
      ...fullMasks(5),
      group('n', ['ns', 'na']),
      box('ns', 'n', -10, -10, 5000),
      box('na', 'n', 1, 1, 5),
    ]);
    const replaced = h.source.prepare(target)!;
    expect(replaced.clip!.masks.map((level) => level.id)).toEqual([
      'm0',
      'm1',
      'm2',
      'm3',
      'm4',
      'n',
    ]);
    submitted(scene.submitPrimitivePacket(replaced));
    expect(takePeak()).toBeLessThanOrEqual(planned(replaced, 4));
    creation.dispose();
  });

  it('after a failed submission the next frame binds no destroyed texture', async () => {
    const { scene, creation, fixture, target, takePeak } = await sceneAt(1024, 512);
    const h = harness(fullMasks(2));
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    h.mirror.setCamera({ position: { x: 110, y: 0 }, zoom: 1 });
    const queue = fixture.device.queue as unknown as { submit: ReturnType<typeof vi.fn> };
    queue.submit.mockImplementationOnce(() => {
      throw new Error('injected submission failure');
    });
    const panned = h.source.prepare(target)!;
    expect(scene.submitPrimitivePacket(panned)).toEqual({
      status: 'failed',
      reason: 'submission-failed',
    });
    // E22-A1: the failed frame's tile set is released too.
    expect(fixture.destroyed.filter((label) => label.includes('mask-tiles-2'))).toEqual([
      'primitive/1/mask-tiles-2/color',
      'primitive/1/mask-tiles-2/resolve',
    ]);
    takePeak();
    fixture.calls.length = 0;
    const passes = scene.maskPasses!;
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    expect(scene.maskPasses).toBe(passes + 2);
    expect(takePeak()).toBeLessThanOrEqual(planned(panned, 4));
    const boundMasks = fixture.calls
      .filter((call) => call[0] === 'setBindGroup' && call[1] === 1)
      .map((call) => (call[2] as string).replace('/bind-group', ''))
      .filter((label) => /mask-\d+$/.test(label));
    for (const label of boundMasks) expect(fixture.destroyed).not.toContain(label);
    creation.dispose();
  });

  it('a tile that cannot be created mid-encode is an allocation failure that leaks nothing', async () => {
    const { scene, creation, fixture, target, accounting } = await sceneAt(1024, 512);
    const h = harness(fullMasks(2));
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    const live = accounting.snapshot().byCategory.texture.live;
    // A pan resizes both levels: their old textures go early, then the resolve tile fails.
    h.mirror.setCamera({ position: { x: -110, y: 0 }, zoom: 1 });
    const device = fixture.device as unknown as {
      createTexture: ReturnType<typeof vi.fn<(descriptor: GPUTextureDescriptor) => unknown>>;
    };
    const create = device.createTexture.getMockImplementation()!;
    device.createTexture.mockImplementation((descriptor) => {
      if (descriptor.label?.endsWith('mask-tiles-2/resolve')) throw new Error('injected');
      return create(descriptor);
    });
    expect(scene.submitPrimitivePacket(h.source.prepare(target)!)).toEqual({
      status: 'failed',
      reason: 'allocation-failed',
    });
    device.createTexture.mockImplementation(create);
    expect(fixture.destroyed).toEqual(
      expect.arrayContaining([
        'primitive/1/mask-1',
        'primitive/1/mask-2',
        'primitive/1/mask-3',
        'primitive/1/mask-4',
        'primitive/1/mask-tiles-2/color',
      ]),
    );
    // Neither the released nor the discarded textures, nor the colour tile, stay in accounting.
    expect(accounting.snapshot().byCategory.texture.live).toBe(live - 2);
    fixture.calls.length = 0;
    const passes = scene.maskPasses!;
    submitted(scene.submitPrimitivePacket(h.source.prepare(target)!));
    expect(scene.maskPasses).toBe(passes + 2);
    const bound = fixture.calls
      .filter((call) => call[0] === 'setBindGroup' && call[1] === 1)
      .map((call) => (call[2] as string).replace('/bind-group', ''))
      .filter((label) => /mask-\d+$/.test(label));
    expect(bound.length).toBeGreaterThan(0);
    for (const label of bound) expect(fixture.destroyed).not.toContain(label);
    creation.dispose();
  });
});
