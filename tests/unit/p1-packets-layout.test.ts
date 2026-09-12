import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import type {
  PrimitivePacket,
  PrimitiveReceipt,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

const identity = { documentId: 'fixture-doc', pageId: 'fixture-page' } as const;
const target: PrimitiveTarget = {
  generation: 1,
  surfaceRevision: 0,
  width: 640,
  height: 360,
  devicePixelRatio: 1,
  sampleCount: 1,
  targetFormat: 'bgra8unorm',
};

function rectangle(
  id: string,
  x: number,
  parentId: string | null = null,
  overrides: Partial<RenderNodeSnapshot> = {},
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    kind: 'primitive',
    transform: [1, 0, 0, 1, x, 0],
    visible: true,
    opacity: 1,
    geometry: { kind: 'rectangle', width: 10, height: 10, cornerRadii: [0, 0, 0, 0] },
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
    ...overrides,
  } as RenderNodeSnapshot;
}

function snapshot(
  nodes: readonly RenderNodeSnapshot[],
  rootOrder: readonly string[],
  revision = 0,
): RenderSceneSnapshot {
  return { identity, revision, nodes, rootOrder };
}

function receipt(packet: PrimitivePacket, serial = 1): PrimitiveReceipt {
  return {
    scene: packet.scene,
    sceneEpoch: packet.sceneEpoch,
    cameraRevision: packet.cameraRevision,
    surfaceRevision: packet.surfaceRevision,
    originRevision: packet.originRevision,
    generation: packet.generation,
    packetId: packet.packetId,
    submissionSerial: serial,
    resources: packet.resources.map((resource) => ({
      resourceId: resource.id,
      incarnation: resource.incarnation,
      records: packet.writes
        .filter((write) => write.resourceId === resource.id)
        .flatMap((write) => write.records),
    })),
  };
}

function apply(
  mirror: RetainedSceneMirror,
  baseRevision: number,
  change: Partial<RenderChangeSet>,
) {
  return mirror.applyChanges({
    identity,
    baseRevision,
    revision: baseRevision + 1,
    inserted: [],
    updated: [],
    removed: [],
    orders: [],
    ...change,
  });
}

function words(write: { bytes: Uint8Array }) {
  const view = new DataView(write.bytes.buffer, write.bytes.byteOffset, write.bytes.byteLength);
  return Array.from({ length: write.bytes.byteLength / 4 }, (_, index) =>
    view.getUint32(index * 4, true),
  );
}

describe('P1.2 primitive packet layout and incremental state', () => {
  it('matches B01 stable slots, frozen capacities, order-only reorder, and isolated transform write', () => {
    const mirror = new RetainedSceneMirror();
    expect(
      mirror.replaceSnapshot(snapshot([rectangle('b', 20), rectangle('a', 0)], ['a', 'b'])).status,
    ).toBe('applied');
    const source = new PrimitiveSceneSource(mirror);
    const initial = source.prepare(target)!;
    expect(initial.mode).toBe('reconstruct');
    expect(initial.resources.map(({ id, capacityBytes }) => [id, capacityBytes])).toEqual([
      ['transforms', 512],
      ['geometry', 768],
      ['styles', 768],
      ['order', 64],
      ['frame', 32],
    ]);
    expect(
      initial.writes
        .filter(({ resourceId }) => resourceId === 'transforms')
        .map(({ byteOffset, bytes }) => [byteOffset, bytes.byteLength]),
    ).toEqual([[0, 64]]);
    const initialOrder = initial.writes.find(({ resourceId }) => resourceId === 'order')!;
    expect(words(initialOrder)).toEqual([0, 1]);
    source.acknowledge(receipt(initial));

    expect(apply(mirror, 0, { orders: [{ parentId: null, children: ['b', 'a'] }] }).status).toBe(
      'applied',
    );
    const reordered = source.prepare(target)!;
    expect(
      reordered.writes.map(({ resourceId, byteOffset, bytes }) => [
        resourceId,
        byteOffset,
        bytes.byteLength,
      ]),
    ).toEqual([['order', 0, 8]]);
    expect(words(reordered.writes[0]!)).toEqual([1, 0]);
    source.acknowledge(receipt(reordered, 2));

    expect(apply(mirror, 1, { updated: [rectangle('a', 0.5)] }).status).toBe('applied');
    const moved = source.prepare(target)!;
    expect(
      moved.writes.map(({ resourceId, byteOffset, bytes }) => [
        resourceId,
        byteOffset,
        bytes.byteLength,
      ]),
    ).toEqual([['transforms', 0, 32]]);
    expect(
      new DataView(moved.writes[0]!.bytes.buffer, moved.writes[0]!.bytes.byteOffset).getFloat32(
        16,
        true,
      ),
    ).toBe(0.5);
  });

  it('reuses the lowest free slot, reconstructs on growth/generation, and protects newer dirty versions', () => {
    const nodes = Array.from({ length: 16 }, (_, index) =>
      rectangle(`n${String(index).padStart(2, '0')}`, index * 12),
    );
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot(
      snapshot(
        nodes,
        nodes.map(({ id }) => id),
      ),
    );
    const source = new PrimitiveSceneSource(mirror);
    const first = source.prepare(target)!;
    source.acknowledge(receipt(first));
    expect(
      apply(mirror, 0, {
        removed: ['n03'],
        inserted: [rectangle('z', 36)],
        orders: [
          {
            parentId: null,
            children: [...nodes.filter(({ id }) => id !== 'n03').map(({ id }) => id), 'z'],
          },
        ],
      }).status,
    ).toBe('applied');
    const reused = source.prepare(target)!;
    const order = reused.writes.find(({ resourceId }) => resourceId === 'order')!;
    expect(words(order).at(-1)).toBe(3);
    source.acknowledge(receipt(reused, 2));

    expect(
      apply(mirror, 1, {
        inserted: [rectangle('zz', 200)],
        orders: [
          {
            parentId: null,
            children: [...nodes.filter(({ id }) => id !== 'n03').map(({ id }) => id), 'z', 'zz'],
          },
        ],
      }).status,
    ).toBe('applied');
    const grown = source.prepare(target)!;
    expect(grown.mode).toBe('reconstruct');
    expect(grown.resources[0]!.capacityBytes).toBe(1024);
    const newerNode = rectangle('zz', 201);
    expect(apply(mirror, 2, { updated: [newerNode] }).status).toBe('applied');
    source.prepare(target);
    source.acknowledge(receipt(grown, 3));
    const retry = source.prepare(target)!;
    expect(
      retry.writes.some(
        ({ resourceId, records }) =>
          resourceId === 'transforms' && records.some(({ index }) => index === 16),
      ),
    ).toBe(true);

    source.acknowledge(receipt(retry, 4));
    const recovered = source.prepare({ ...target, generation: 2 })!;
    expect(recovered.mode).toBe('reconstruct');
    expect(
      recovered.writes.find(({ resourceId }) => resourceId === 'transforms')!.records,
    ).toHaveLength(17);

    expect(mirror.replaceSnapshot(snapshot([rectangle('only', 0)], ['only'], 4)).status).toBe(
      'applied',
    );
    const replaced = source.prepare({ ...target, generation: 2 })!;
    expect(replaced.mode).toBe('reconstruct');
    expect(replaced.resources[0]!.capacityBytes).toBe(1024);
  });

  it('disposes its CPU packet state without disposing the injected mirror', () => {
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot(snapshot([rectangle('a', 0)], ['a']));
    const source = new PrimitiveSceneSource(mirror);
    expect(source.prepare(target)).not.toBeNull();
    source.dispose();
    source.dispose();
    expect(source.prepare(target)).toBeNull();
    expect(mirror.readRetainedScene()).not.toBeNull();
  });

  it('matches N04/S4 culling and warms to one transform record with no unrelated writes', () => {
    const nodes = Array.from({ length: 10_000 }, (_, index) => benchmarkPrimitive(index));
    const rootOrder = nodes.map(({ id }) => id);
    const mirror = new RetainedSceneMirror();
    mirror.replaceSnapshot({
      identity: { documentId: 'p1-benchmark', pageId: 'p1-single-transform-10k/v1' },
      revision: 0,
      nodes,
      rootOrder,
    });
    mirror.setCamera({ position: { x: 0, y: 0 }, zoom: 1.5 });
    const source = new PrimitiveSceneSource(mirror);
    const benchmarkTarget = { ...target, width: 1280, height: 720, sampleCount: 4 as const };
    const initial = source.prepare(benchmarkTarget)!;
    expect(initial.draws).toEqual([{ first: 0, count: 1032, variant: 'analytic-v1' }]);
    source.acknowledge(receipt(initial));

    const benchmarkIdentity = { documentId: 'p1-benchmark', pageId: 'p1-single-transform-10k/v1' };
    expect(
      mirror.applyChanges({
        identity: benchmarkIdentity,
        baseRevision: 0,
        revision: 1,
        inserted: [],
        updated: [benchmarkPrimitive(0)],
        removed: [],
        orders: [],
      }).status,
    ).toBe('applied');
    const revisionOnly = source.prepare(benchmarkTarget)!;
    expect(revisionOnly.writes).toEqual([]);

    expect(
      mirror.applyChanges({
        identity: benchmarkIdentity,
        baseRevision: 1,
        revision: 2,
        inserted: [],
        updated: [benchmarkPrimitive(0, { x: 14, y: 6 })],
        removed: [],
        orders: [],
      }).status,
    ).toBe('applied');
    const moved = source.prepare(benchmarkTarget)!;
    expect(moved.draws).toEqual([{ first: 0, count: 1032, variant: 'analytic-v1' }]);
    expect(
      moved.writes.map(({ resourceId, byteOffset, bytes }) => [
        resourceId,
        byteOffset,
        bytes.byteLength,
      ]),
    ).toEqual([['transforms', 0, 32]]);
  });
});

function benchmarkPrimitive(index: number, center?: { x: number; y: number }): RenderNodeSnapshot {
  const x = center?.x ?? 10 + 20 * (index % 100);
  const y = center?.y ?? 10 + 20 * Math.floor(index / 100);
  const word = (Math.imul(1664525, (0x50310001 ^ index) >>> 0) + 1013904223) >>> 0;
  const q = (byte: number) => ((word >>> (8 * byte)) & 255) / 255;
  const fill = {
    r: 0.2 + 0.6 * q(0),
    g: 0.2 + 0.6 * q(1),
    b: 0.2 + 0.6 * q(2),
    a: 0.45 + 0.4 * q(3),
  };
  const stroke = {
    color: { r: 0.8 - 0.6 * q(2), g: 0.8 - 0.6 * q(1), b: 0.8 - 0.6 * q(0), a: 0.65 },
    width: index % 4 === 3 ? 1 : 0.5,
  };
  const common = {
    id: `p1-${String(index).padStart(5, '0')}`,
    parentId: null,
    kind: 'primitive' as const,
    visible: true,
    opacity: 0.5 + 0.25 * (index % 3),
  };
  switch (index % 4) {
    case 0:
      return {
        ...common,
        transform: [1, 0, 0, 1, x - 1.5, y - 1],
        geometry: { kind: 'rectangle', width: 3, height: 2, cornerRadii: [0, 0, 0, 0] },
        style: { fill, stroke },
      };
    case 1:
      return {
        ...common,
        transform: [1, 0, 0, 1, x - 1.5, y - 1.5],
        geometry: { kind: 'rectangle', width: 3, height: 3, cornerRadii: [0.5, 1, 0.5, 1] },
        style: { fill, stroke },
      };
    case 2:
      return {
        ...common,
        transform: [1, 0, 0, 1, x - 1.5, y - 1],
        geometry: { kind: 'ellipse', width: 3, height: 2 },
        style: { fill, stroke },
      };
    default:
      return {
        ...common,
        transform: [1, 0, 0, 1, x, y],
        geometry: { kind: 'line', start: { x: -1.75, y: 0 }, end: { x: 1.75, y: 0 } },
        style: { fill: null, stroke },
      };
  }
}
