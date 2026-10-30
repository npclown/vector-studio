import { describe, expect, it } from 'vitest';
import type { PathFringe } from '../../packages/renderer-core/src/path-fringe.js';
import type { PathMeshDraw } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { PathMeshPacker } from '../../packages/renderer-core/src/path-mesh-packet.js';
import type {
  MeshReceiptResource,
  MeshWrite,
} from '../../packages/renderer-core/src/primitive-packet.js';

// E26 contract, U5a (section 4.4.1): mesh writes and receipts carry record ranges, one per run
// of records written with one version, so a packet's record count is no longer bounded by the
// 2^24 entries of a V8 Map (baseline B3).

const FRAME = Object.freeze([0, 0, 1, 1, 640, 360, 0, 0]);

/** A fringe draw double: `triangles` region triangles over a fan and `lists` list entries. */
function fringeDraw(nodeId: string, slot: number, triangles: number, lists: number): PathMeshDraw {
  const vertices = triangles + 2;
  const fringe: PathFringe = {
    corners: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    triangles: new Uint32Array(8 * triangles).map((_, word) => (word % 8 === 4 ? 1 : 0)),
    lists: new Uint32Array(lists),
    features: new Uint32Array(16),
    regionTriangles: triangles,
    exteriorTriangles: 0,
    droppedExterior: 0,
  };
  return {
    nodeId,
    slot,
    toleranceExponent: 0,
    fringeBucket: 0,
    fringe: { id: Symbol(`${nodeId}-fringe`), data: fringe },
    orientation: 1,
    mesh: {
      positions: new Float64Array(2 * vertices),
      indices: Uint32Array.from({ length: 3 * triangles }, (_, index) =>
        index % 3 === 0 ? 0 : (index % 3) + Math.floor(index / 3),
      ),
      boundaryEdges: new Uint32Array(0),
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    },
    entryId: Symbol(nodeId),
    offsets: new Float32Array(2 * vertices),
    linear: [1, 0, 0, 1],
    anchor: [0, 0],
    opacity: 1,
    fill: { r: 1, g: 0, b: 0, a: 1 },
  };
}

function prepare(packer: PathMeshPacker, draws: readonly PathMeshDraw[]) {
  return packer.prepare({
    generation: 1,
    draws,
    slots: new Map(draws.map((draw) => [draw.nodeId, draw.slot])),
    resident: new Set(draws.map((draw) => draw.fringe!.id)),
    frameLanes: FRAME,
  });
}

/** The receipt resources the backend returns: each resource's write ranges, in fixed order. */
function receipt(
  resources: readonly { id: MeshWrite['resourceId']; incarnation: symbol }[],
  writes: readonly MeshWrite[],
): MeshReceiptResource[] {
  return resources.map((resource) => ({
    resourceId: resource.id,
    incarnation: resource.incarnation,
    records: writes
      .filter((write) => write.resourceId === resource.id)
      .flatMap((write) => write.records),
  }));
}

describe('E26-U5a mesh record ranges', () => {
  it('writes one range per variant region and covers every write exactly', () => {
    const packer = new PathMeshPacker();
    const output = prepare(packer, [fringeDraw('a', 0, 3, 10), fringeDraw('b', 1, 2, 7)]);
    const strides: Record<string, number> = {
      meshPositions: 8,
      meshTriangles: 32,
      meshFeatureLists: 4,
      meshFeatures: 64,
      meshInstances: 64,
      meshFrame: 32,
    };
    for (const write of output.writes) {
      const first = write.byteOffset / strides[write.resourceId]!;
      let next = first;
      for (const range of write.records) {
        expect(range.index).toBe(next);
        expect(range.count).toBeGreaterThan(0);
        next += range.count;
      }
      expect(next).toBe(first + write.bytes.byteLength / strides[write.resourceId]!);
    }
    const lists = output.writes.filter((write) => write.resourceId === 'meshFeatureLists');
    expect(
      lists.flatMap((write) => write.records.map(({ index, count }) => [index, count])),
    ).toEqual([
      [0, 10],
      [10, 7],
    ]);
    // One version per variant region, a new one per slot's instance record.
    const instances = output.writes.find((write) => write.resourceId === 'meshInstances')!;
    expect(instances.records.map(({ index, count }) => [index, count])).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(output.expected.get('meshFeatureLists')).toEqual(lists.flatMap((w) => w.records));
  });

  it('accepts exactly the expected ranges in any order and clears only matching versions', () => {
    const packer = new PathMeshPacker();
    const draws = [fringeDraw('a', 0, 3, 10), fringeDraw('b', 1, 2, 7)];
    const output = prepare(packer, draws);
    const good = receipt(output.resources, output.writes);
    const lists = good.findIndex((resource) => resource.resourceId === 'meshFeatureLists');
    const swap = (records: MeshReceiptResource['records']) =>
      good.map((resource, index) => (index === lists ? { ...resource, records } : resource));
    const [a, b] = good[lists]!.records;
    expect(packer.validateReceipt(swap([b!, a!]), output.expected, 6)).not.toBeNull();
    for (const bad of [
      swap([a!]),
      swap([a!, b!, b!]),
      swap([{ ...a!, count: a!.count - 1 }, b!]),
      swap([{ ...a!, version: Symbol('other') }, b!]),
      swap([
        { index: a!.index, count: 5, version: a!.version },
        { index: a!.index + 5, count: a!.count - 5, version: a!.version },
        b!,
      ]),
    ]) {
      expect(packer.validateReceipt(bad, output.expected, 6)).toBeNull();
    }

    // A stale range clears nothing; the matching receipt clears every record.
    packer.acknowledge(swap([{ ...a!, version: Symbol('stale') }, b!]));
    const listRanges = (draws: readonly PathMeshDraw[]) =>
      prepare(packer, draws)
        .writes.filter((write) => write.resourceId === 'meshFeatureLists')
        .flatMap((write) => write.records.map(({ index, count }) => [index, count]));
    expect(listRanges(draws)).toEqual([[0, 10]]);
    packer.acknowledge(good);
  });

  it('a packet with more than 2^24 list entries validates and acknowledges (baseline B3)', () => {
    const packer = new PathMeshPacker();
    const entries = 2 ** 24 + 8;
    const draws = [fringeDraw('a', 0, 2, entries)];
    const output = prepare(packer, draws);
    const lists = output.writes.filter((write) => write.resourceId === 'meshFeatureLists');
    expect(
      lists.flatMap((write) => write.records.map(({ index, count }) => [index, count])),
    ).toEqual([[0, entries]]);
    const resources = receipt(output.resources, output.writes);
    expect(packer.validateReceipt(resources, output.expected, 6)).toBe(resources);
    packer.acknowledge(resources);
    expect(prepare(packer, draws).writes).toEqual([]);
  }, 120_000);
});
