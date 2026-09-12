import type { RenderNodeSnapshot } from '@vector-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import * as numeric from '../../packages/renderer-core/src/scene-numeric.js';
import * as packing from '../../packages/renderer-core/src/primitive-packing.js';
import type {
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

const identity = { documentId: 'primary-packet-review', pageId: 'page' };
const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 1,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 4,
  targetFormat: 'bgra8unorm',
};
function leaf(id: string, x = 20): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    kind: 'primitive',
    transform: [1, 0, 0, 1, x, 20],
    visible: true,
    opacity: 1,
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
  };
}
function receipt(packet: PrimitivePacket): PrimitiveReceipt {
  return {
    scene: packet.scene,
    sceneEpoch: packet.sceneEpoch,
    cameraRevision: packet.cameraRevision,
    surfaceRevision: packet.surfaceRevision,
    originRevision: packet.originRevision,
    generation: packet.generation,
    packetId: packet.packetId,
    submissionSerial: 1,
    resources: packet.resources.map((resource) => ({
      resourceId: resource.id,
      incarnation: resource.incarnation,
      records: packet.writes
        .filter((write) => write.resourceId === resource.id)
        .flatMap((write) => write.records),
    })),
  };
}
function setup(nodes: readonly RenderNodeSnapshot[]) {
  const mirror = new RetainedSceneMirror();
  expect(
    mirror.replaceSnapshot({
      identity,
      revision: 0,
      nodes,
      rootOrder: nodes.map((node) => node.id),
    }).status,
  ).toBe('applied');
  return { mirror, source: new PrimitiveSceneSource(mirror) };
}

describe('Primary packet publication review', () => {
  it('requires the current packet identity even when every other version is identical', () => {
    const { source } = setup([leaf('a')]);
    const old = source.prepare(target)!;
    const current = source.prepare(target)!;
    expect(current.packetId).not.toBe(old.packetId);
    source.acknowledge(receipt(old));
    expect(source.prepare(target)!.mode).toBe('reconstruct');
  });

  it('keeps the N03 negative hysteresis boundary and rebases only transforms', () => {
    const { mirror, source } = setup([leaf('a')]);
    const origins: number[] = [];
    for (const x of [0, -0.25, -256, -512, -512.25]) {
      mirror.setCamera({ position: { x, y: 0 }, zoom: 1 });
      const packet = source.prepare(target)!;
      const frame = packet.writes.find((write) => write.resourceId === 'frame')!;
      origins.push(
        new DataView(frame.bytes.buffer, frame.bytes.byteOffset).getFloat32(0, true) + x,
      );
      if (x !== 0) {
        expect(
          packet.writes.some(
            (write) => write.resourceId === 'geometry' || write.resourceId === 'styles',
          ),
        ).toBe(false);
        expect(
          packet.writes
            .filter((write) => write.resourceId === 'transforms')
            .reduce((sum, write) => sum + write.bytes.length, 0),
        ).toBe(x === -512.25 ? 32 : 0);
      }
      source.acknowledge(receipt(packet));
    }
    expect(origins).toEqual([0, 0, 0, 0, -768]);
  });

  it('recomputes only affected world/bounds caches across ancestor, reparent and stroke edits', () => {
    const group: RenderNodeSnapshot = {
      id: 'g',
      parentId: null,
      kind: 'container',
      transform: [1, 0, 0, 1, 10, 0],
      visible: true,
      opacity: 1,
      children: ['a', 'b'],
    };
    const a = { ...leaf('a'), parentId: 'g' };
    const b = { ...leaf('b', 40), parentId: 'g' };
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({
      identity,
      revision: 0,
      nodes: [group, a, b, leaf('c', 80)],
      rootOrder: ['g', 'c'],
    });
    const source = new PrimitiveSceneSource(mirror);
    source.acknowledge(receipt(source.prepare(target)!));
    const compose = vi.spyOn(numeric, 'composeSceneAffine');
    const bounds = vi.spyOn(numeric, 'transformSceneBounds');
    const radii = vi.spyOn(packing, 'normalizeRectangleRadii');
    try {
      const movedGroup = { ...group, transform: [1, 0, 0, 1, 11, 0] as const };
      expect(
        mirror.applyChanges({
          identity,
          baseRevision: 0,
          revision: 1,
          inserted: [],
          updated: [movedGroup],
          removed: [],
          orders: [],
        }).status,
      ).toBe('applied');
      compose.mockClear();
      bounds.mockClear();
      radii.mockClear();
      const moved = source.prepare(target)!;
      expect(compose).toHaveBeenCalledTimes(3);
      expect(bounds).toHaveBeenCalledTimes(2);
      expect(radii).not.toHaveBeenCalled();
      expect(moved.writes.map((w) => [w.resourceId, w.byteOffset, w.bytes.length])).toEqual([
        ['transforms', 0, 64],
      ]);
      source.acknowledge(receipt(moved));
      const reparented = { ...a, parentId: null };
      expect(
        mirror.applyChanges({
          identity,
          baseRevision: 1,
          revision: 2,
          inserted: [],
          updated: [reparented],
          removed: [],
          orders: [
            { parentId: 'g', children: ['b'] },
            { parentId: null, children: ['g', 'a', 'c'] },
          ],
        }).status,
      ).toBe('applied');
      compose.mockClear();
      bounds.mockClear();
      radii.mockClear();
      const reparent = source.prepare(target)!;
      expect(compose).toHaveBeenCalledTimes(1);
      expect(bounds).toHaveBeenCalledTimes(1);
      expect(radii).not.toHaveBeenCalled();
      const order = reparent.writes.find((w) => w.resourceId === 'order')!;
      const view = new DataView(order.bytes.buffer, order.bytes.byteOffset);
      expect([view.getUint32(0, true), view.getUint32(4, true)]).toEqual([1, 0]);
      source.acknowledge(receipt(reparent));
      const stroked = {
        ...reparented,
        style: {
          fill: { r: 1, g: 1, b: 1, a: 1 },
          stroke: { color: { r: 1, g: 0, b: 0, a: 1 }, width: 3 },
        },
      };
      expect(
        mirror.applyChanges({
          identity,
          baseRevision: 2,
          revision: 3,
          inserted: [],
          updated: [stroked],
          removed: [],
          orders: [],
        }).status,
      ).toBe('applied');
      compose.mockClear();
      bounds.mockClear();
      radii.mockClear();
      const styled = source.prepare(target)!;
      expect(compose).not.toHaveBeenCalled();
      expect(bounds).toHaveBeenCalledTimes(1);
      expect(radii).not.toHaveBeenCalled();
      expect(styled.writes.map((w) => [w.resourceId, w.byteOffset, w.bytes.length])).toEqual([
        ['styles', 0, 48],
      ]);
    } finally {
      compose.mockRestore();
      bounds.mockRestore();
      radii.mockRestore();
    }
  });

  it('preserves CPU truth when finite input cannot produce safe f32 frame or inverse arithmetic', () => {
    const { mirror, source } = setup([leaf('a')]);
    mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1e-300 });
    expect(() => source.prepare(target)).toThrow();
    expect(mirror.getCameraState()!.camera.zoom).toBe(1e-300);
    expect(mirror.getSynchronizationState().current!.revision).toBe(0);
    mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1 });
    const tiny = { ...leaf('a'), transform: [1e-30, 0, 0, 1e-30, 0, 0] as const };
    expect(
      mirror.replaceSnapshot({ identity, revision: 1, nodes: [tiny], rootOrder: ['a'] }).status,
    ).toBe('applied');
    expect(() => source.prepare(target)).toThrow();
    expect(mirror.readRetainedScene()!.getNode('a')!.transform).toEqual(tiny.transform);
    expect(
      mirror.replaceSnapshot({ identity, revision: 2, nodes: [leaf('a')], rootOrder: ['a'] })
        .status,
    ).toBe('applied');
    const recovery = source.prepare(target)!;
    expect(recovery.mode).toBe('reconstruct');
    expect(recovery.draws).toHaveLength(1);
  });

  it('keeps a ready draw envelope for continuous frames and clears the last removed draw', () => {
    const { mirror, source } = setup([leaf('a')]);
    const initial = source.prepare(target)!;
    source.acknowledge(receipt(initial));
    const steady = source.prepare(target)!;
    expect(steady).not.toBeNull();
    expect(steady.writes).toEqual([]);
    expect(steady.draws).toEqual([{ first: 0, count: 1, variant: 'analytic-v1' }]);
    expect(steady.packetId).not.toBe(initial.packetId);
    expect(
      mirror.applyChanges({
        identity,
        baseRevision: 0,
        revision: 1,
        inserted: [],
        updated: [],
        removed: ['a'],
        orders: [{ parentId: null, children: [] }],
      }).status,
    ).toBe('applied');
    const cleared = source.prepare(target)!;
    expect(cleared).not.toBeNull();
    expect(cleared.scene.revision).toBe(1);
    expect(cleared.draws).toEqual([]);
  });

  it('rejects duplicate receipt coverage atomically instead of acknowledging a missing record', () => {
    const { source } = setup([leaf('a'), leaf('b', 40)]);
    const packet = source.prepare(target)!;
    const submitted = receipt(packet);
    const transform = submitted.resources.find((resource) => resource.resourceId === 'transforms')!;
    source.acknowledge({
      ...submitted,
      resources: submitted.resources.map((resource) =>
        resource.resourceId === 'transforms'
          ? { ...resource, records: [transform.records[0]!, transform.records[0]!] }
          : resource,
      ),
    });
    const retry = source.prepare(target)!;
    expect(retry.mode).toBe('reconstruct');
    expect(
      retry.writes.map((write) => [write.resourceId, write.byteOffset, [...write.bytes]]),
    ).toEqual(packet.writes.map((write) => [write.resourceId, write.byteOffset, [...write.bytes]]));
  });

  it('does not let an old scene epoch acknowledge a new identical record or retain caller byte mutation', () => {
    const { mirror, source } = setup([leaf('a')]);
    const old = source.prepare(target)!;
    const oldReceipt = receipt(old);
    const expected = [...old.writes[0]!.bytes];
    old.writes[0]!.bytes.fill(255);
    expect(
      mirror.replaceSnapshot({ identity, revision: 1, nodes: [leaf('a')], rootOrder: ['a'] })
        .status,
    ).toBe('applied');
    const replacement = source.prepare(target)!;
    expect(replacement.sceneEpoch).not.toBe(old.sceneEpoch);
    expect([...replacement.writes[0]!.bytes]).toEqual(expected);
    source.acknowledge(oldReceipt);
    const retry = source.prepare(target)!;
    expect(retry.mode).toBe('reconstruct');
    expect(retry.writes).toHaveLength(replacement.writes.length);
  });
});
