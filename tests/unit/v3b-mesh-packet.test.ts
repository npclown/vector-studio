import { createHash } from 'node:crypto';
import type {
  FillMesh,
  RenderNodeSnapshot,
  RendererInvalidationTarget,
} from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import type { PathMeshDraw } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import {
  MESH_RESOURCE_ORDER,
  MESH_STRIDES,
  PathMeshPacker,
  meshFrameCorners,
  selectMeshOrigin,
  type MeshOrigin,
} from '../../packages/renderer-core/src/path-mesh-packet.js';
import type {
  MeshResourceId,
  PrimitivePacket,
  PrimitiveTarget,
} from '../../packages/renderer-core/src/primitive-packet.js';
import { PrimitiveRendererService } from '../../packages/renderer-core/src/primitive-renderer-service.js';
import { PrimitiveSceneSource } from '../../packages/renderer-core/src/primitive-scene-source.js';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';
import { originPXTarget } from '../geometry/position-certificate/r3-window.js';
import {
  ScriptedFillMeshPort,
  createCountingPort,
  createFailingPort,
  createPathHarness,
  identity,
  okResult,
  pathNode,
  rectangleNode,
  squareMesh,
  target,
} from '../support/v3a-path-harness.js';
import { MeshShadow, fanMesh, receiptOf, words } from '../support/v3b-mesh-harness.js';

// P3 V3 contract unit V3b, renderer-core side: the optional mesh packet part (section f), paint
// order (section g), range management and receipts, and device loss (section i). Functional
// evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target, and no Q4
// coverage threshold is claimed.

const noInvalidation: RendererInvalidationTarget = {
  invalidate: () => undefined,
  setMode: () => undefined,
};

function meshPort(meshes: ReadonlyMap<number, FillMesh>): ScriptedFillMeshPort {
  return new ScriptedFillMeshPort({
    request: (request, tag) => okResult(request, meshes.get(tag) ?? squareMesh()),
  });
}

function bytesOf(packet: PrimitivePacket, resource: MeshResourceId): Uint8Array[] {
  return packet.mesh!.writes.filter((write) => write.resourceId === resource).map((w) => w.bytes);
}

describe('V3b mesh part bytes (V3-A10)', () => {
  it('V3-A10: section f strides, K4 offsets, triangle records, instance anchors and sigma, and the mesh frame', () => {
    // Coordinates near 2^20 whose differences from m round in binary32.
    const mesh = fanMesh([
      [1_048_576.3, -2.7],
      [1_048_590.1, -2.7],
      [1_048_590.1, 9.05],
      [1_048_576.3, 9.05],
    ]);
    const port = meshPort(new Map([[1_048_576.3, mesh]]));
    // A reflection (det < 0) with shear; its translation brings m near the camera.
    const reflected: readonly [number, number, number, number, number, number] = [
      -1, 0.25, 0.5, 1.5, 1_048_400.125, -262_400.5,
    ];
    const h = createPathHarness({
      port,
      nodes: [
        pathNode('p', 0, {
          transform: reflected,
          opacity: 0.625,
          fill: { r: 0.25, g: 0.5, b: 0.75, a: 0.8 },
          points: [1_048_576.3, -2.7, 1_048_590.1, -2.7, 1_048_590.1, 9.05],
        }),
      ],
    });
    h.setZoom(1.5, { x: -200.25, y: -300.5 });
    const packet = h.source.prepare({ ...target, devicePixelRatio: 2 })!;
    const part = packet.mesh!;
    expect(part.layoutVersion).toBe(0);
    expect(part.resources.map((resource) => [resource.id, resource.capacityBytes])).toEqual([
      ['meshPositions', 16 * 8],
      ['meshTriangles', 16 * 32],
      ['meshFeatureLists', 16 * 4],
      ['meshFeatures', 16 * 64],
      ['meshInstances', 16 * 64],
      ['meshFrame', 32],
    ]);
    expect(MESH_RESOURCE_ORDER).toEqual(part.resources.map((resource) => resource.id));
    expect(MESH_STRIDES).toEqual({
      meshPositions: 8,
      meshTriangles: 32,
      meshFeatureLists: 4,
      meshFeatures: 64,
      meshInstances: 64,
      meshFrame: 32,
    });

    // Geometry-owned: m from the exact bounds, u = fround(v - m) taken in Float64.
    const m = { x: mesh.bounds.minX / 2 + mesh.bounds.maxX / 2, y: -2.7 / 2 + 9.05 / 2 };
    const [positions] = bytesOf(packet, 'meshPositions');
    const expectedOffsets = Array.from(mesh.positions, (value, index) =>
      Math.fround(value - (index % 2 === 0 ? m.x : m.y)),
    );
    expect(words(positions!, 'f32')).toEqual(expectedOffsets);
    // The Float64 difference matters: rounding both terms first gives another lane.
    expect(Math.fround(mesh.positions[0]! - m.x)).not.toBe(
      Math.fround(Math.fround(mesh.positions[0]!) - Math.fround(m.x)),
    );

    const [triangles] = bytesOf(packet, 'meshTriangles');
    expect(words(triangles!, 'u32')).toEqual([0, 1, 2, 0, 0, 0, 0, 0, 0, 2, 3, 0, 0, 0, 0, 0]);
    expect(bytesOf(packet, 'meshFeatureLists')).toEqual([]);
    expect(bytesOf(packet, 'meshFeatures')).toEqual([]);

    // Transform-owned: f32 lanes of L, B = fround(W(m) - O_m), sigma from the exact determinant.
    const origin = selectMeshOrigin({ x: -200.25, y: -300.5 }, 1.5, 2, null)!;
    expect(origin).toEqual({ x: -224, y: -320, g: 32 });
    const [instance] = bytesOf(packet, 'meshInstances');
    const floats = words(instance!, 'f32');
    const integers = words(instance!, 'u32');
    const anchorX = reflected[0] * m.x + reflected[2] * m.y + reflected[4] - origin.x;
    const anchorY = reflected[1] * m.x + reflected[3] * m.y + reflected[5] - origin.y;
    expect(floats.slice(0, 12)).toEqual(
      [-1, 0.25, 0.5, 1.5, anchorX, anchorY, -1, 0.625, 0.25, 0.5, 0.75, 0.8].map(Math.fround),
    );
    expect(integers.slice(12)).toEqual([0, 0, 0, 0]);

    const [frame] = bytesOf(packet, 'meshFrame');
    expect(words(frame!, 'f32')).toEqual(
      [-224 + 200.25, -320 + 300.5, 1.5, 2, 640, 360, 0, 0].map(Math.fround),
    );
    expect(part.draws).toEqual([{ position: 0, instance: 0, firstTriangle: 0, triangleCount: 2 }]);
    expect(packet.draws).toEqual([]);

    // Golden digest of the serialized mesh part.
    const serialized = JSON.stringify({
      resources: part.resources.map((resource) => [resource.id, resource.capacityBytes]),
      writes: part.writes.map((write) => [
        write.resourceId,
        write.byteOffset,
        Buffer.from(write.bytes).toString('hex'),
        write.records.map((record) => record.index),
      ]),
      draws: part.draws,
    });
    expect(createHash('sha256').update(serialized).digest('hex')).toBe(GOLDEN_MESH_PART_DIGEST);
  });

  it('V3-A10: frame corners lie on the outward binary32 grid with the exact margin', () => {
    const cases: Array<
      readonly [Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>, number]
    > = [
      [{ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0.5],
      [{ minX: 1_048_576.3, minY: -2.7, maxX: 1_048_590.1, maxY: 9.05 }, 2 ** -3],
      [{ minX: -1e7 - 0.1, minY: 3.3, maxX: -1e7 + 0.7, maxY: 3.30001 }, 2 ** -20],
      [{ minX: 0.1, minY: 0.2, maxX: 0.30000000000000004, maxY: 0.7 }, 2 ** -30],
      [{ minX: -3e30, minY: -1, maxX: 5e30, maxY: 1 }, 2 ** 70],
    ];
    for (const [bounds, rho] of cases) {
      const m = { x: bounds.minX / 2 + bounds.maxX / 2, y: bounds.minY / 2 + bounds.maxY / 2 };
      const corners = meshFrameCorners(bounds, m, rho)!;
      expect(corners).not.toBeNull();
      for (const [corner, low, mid, side] of [
        [corners.minX, bounds.minX, m.x, 'low'],
        [corners.minY, bounds.minY, m.y, 'low'],
        [corners.maxX, bounds.maxX, m.x, 'high'],
        [corners.maxY, bounds.maxY, m.y, 'high'],
      ] as const) {
        expect(Math.fround(corner)).toBe(corner);
        // Independent exact check over BigInt rationals with a common power-of-two scale.
        const margin = (k: number) =>
          side === 'low'
            ? exact(low) - exact(rho) - exact(mid) - exact(k)
            : exact(mid) + exact(k) - exact(low) - exact(rho);
        expect(margin(corner) >= 0n).toBe(true);
        const inward = stepFloat32(corner, side === 'low' ? 1 : -1);
        expect(margin(inward) < 0n).toBe(true);
      }
    }
    // A corner that is not a finite binary32 value cannot be built (fringe-range).
    expect(
      meshFrameCorners({ minX: -3e38, minY: 0, maxX: 3e38, maxY: 1 }, { x: 0, y: 0.5 }, 1e38),
    ).toBeNull();
  });

  it('V3-A10: the mesh origin is O-PX(128) with R3 inputs and matches R3 originPXTarget', () => {
    const zooms = [1, 1.5, 0.01, 64, 1e-3, 3.7, 2 ** 20, 1 / 3];
    const ratios = [1, 2, 1.25, 3];
    const cameras = [-1_000.5, -3.25, 0, 0.1, 127.9, 4_096.75, 1e9 + 0.5];
    for (const zoom of zooms) {
      for (const dpr of ratios) {
        let previous: MeshOrigin | null = null;
        let reference: { origin: readonly [number, number]; g: number } | undefined;
        for (const x of cameras) {
          for (const y of [-cameras[1]!, x / 3]) {
            const ours: MeshOrigin = selectMeshOrigin({ x, y }, zoom, dpr, previous)!;
            const theirs = originPXTarget([x, y], zoom, dpr, 128, reference);
            expect([ours.x, ours.y, ours.g]).toEqual([...theirs.origin, theirs.g]);
            previous = ours;
            reference = theirs;
          }
        }
      }
    }
    expect(selectMeshOrigin({ x: 0, y: 0 }, 1e-300, 1, null)).toBeNull();
  });

  it('V3-A10: R3 TR-PAN at zoom 1 and DPR 1 rebases 15 times; a rebase rewrites only instance anchors and the mesh frame', () => {
    const port = createCountingPort();
    const wide = pathNode('a', 0, { points: [0, 0, 5_000, 0, 5_000, 10] });
    const h = createPathHarness({ port, nodes: [wide, pathNode('b', 30)] });
    let previous: PrimitivePacket | null = null;
    let rebases = 0;
    let reference: { origin: readonly [number, number]; g: number } | undefined;
    let referenceChanges = 0;
    for (let k = 0; k <= 1023; k += 1) {
      const camera = { x: (k * 4) / (1 * 1), y: 0 };
      h.setZoom(1, camera);
      const packet = h.source.prepare(target)!;
      const next = originPXTarget([camera.x, camera.y], 1, 1, 128, reference);
      if (
        reference !== undefined &&
        (next.origin[0] !== reference.origin[0] || next.origin[1] !== reference.origin[1])
      ) {
        referenceChanges += 1;
      }
      reference = next;
      if (previous !== null) {
        const rebased = packet.mesh!.originRevision !== previous.mesh!.originRevision;
        if (rebased) rebases += 1;
        const written = packet.mesh!.writes.map((write) => [
          write.resourceId,
          write.bytes.byteLength,
        ]);
        const drawnSlots = packet.mesh!.draws.length;
        expect(written).toEqual([
          ...(rebased && drawnSlots > 0 ? [['meshInstances', 64]] : []),
          ['meshFrame', 32],
        ]);
      }
      h.source.acknowledge(receiptOf(packet));
      previous = packet;
    }
    expect(rebases).toBe(15);
    expect(referenceChanges).toBe(15);
    expect(port.callCount).toBe(1);
  });

  it('V3-A10: receipts with and without a mesh part', () => {
    // Primitive-only scene with a port: no mesh part, and a receipt without one acknowledges.
    const port = createCountingPort();
    const plain = createPathHarness({ port, nodes: [rectangleNode('r', 0)] });
    const primitiveOnly = plain.source.prepare(target)!;
    expect(primitiveOnly).not.toHaveProperty('mesh');
    plain.source.acknowledge(receiptOf(primitiveOnly));
    expect(plain.source.prepare(target)!.writes).toEqual([]);

    // A packet with a mesh part is acknowledged by a matching submitted part: both clear.
    const h = createPathHarness({ port, nodes: [rectangleNode('r', 0), pathNode('p', 20)] });
    const first = h.source.prepare(target)!;
    expect(first.mesh!.writes.length).toBeGreaterThan(0);
    h.source.acknowledge(receiptOf(first));
    const second = h.source.prepare(target)!;
    expect(second.writes).toEqual([]);
    expect(second.mesh!.writes).toEqual([]);
    expect(second.mesh!.draws).toHaveLength(1);
  });

  it('V3-A10: a receipt with a mismatched mesh part acknowledges nothing', () => {
    const port = createCountingPort();
    const h = createPathHarness({ port, nodes: [rectangleNode('r', 0), pathNode('p', 20)] });
    type Receipt = ReturnType<typeof receiptOf>;
    type Submitted = Extract<NonNullable<Receipt['mesh']>, { status: 'submitted' }>;
    const tamper =
      (edit: (receipt: Receipt, mesh: Submitted) => Receipt) => (packet: PrimitivePacket) => {
        const good = receiptOf(packet);
        return edit(good, good.mesh as Submitted);
      };
    const mismatches: Array<(packet: PrimitivePacket) => Receipt> = [
      (packet) => receiptOf(packet, 'none'),
      tamper((good, mesh) => ({
        ...good,
        mesh: { ...mesh, originRevision: Symbol('other-origin') },
      })),
      tamper((good, mesh) => ({
        ...good,
        mesh: {
          ...mesh,
          resources: mesh.resources.map((resource, index) =>
            index === 0 ? { ...resource, records: resource.records.slice(1) } : resource,
          ),
        },
      })),
      tamper((good, mesh) => ({
        ...good,
        mesh: {
          ...mesh,
          resources: mesh.resources.map((resource, index) =>
            index === 4 ? { ...resource, incarnation: Symbol('stale') } : resource,
          ),
        },
      })),
      tamper((good, mesh) => ({
        ...good,
        mesh: { ...mesh, resources: mesh.resources.slice(0, 5) },
      })),
      tamper((good, mesh) => ({
        ...good,
        mesh: { ...mesh, resources: [...mesh.resources].reverse() },
      })),
      tamper((good) => ({ ...good, mesh: { status: 'pending' } as unknown as Submitted })),
    ];
    let packet = h.source.prepare(target)!;
    for (const mismatch of mismatches) {
      h.source.acknowledge(mismatch(packet));
      const again = h.source.prepare(target)!;
      // Nothing was cleared: every P1 and mesh write is still pending.
      expect(again.writes.map((write) => write.byteOffset)).toEqual(
        packet.writes.map((write) => write.byteOffset),
      );
      expect(again.mesh!.writes.map((write) => [write.resourceId, write.byteOffset])).toEqual(
        packet.mesh!.writes.map((write) => [write.resourceId, write.byteOffset]),
      );
      packet = again;
    }
    // The untampered receipt of the latest packet acknowledges both parts.
    h.source.acknowledge(receiptOf(packet));
    expect(h.source.prepare(target)!.mesh!.writes).toEqual([]);
    // A mesh part on a receipt for a packet without one acknowledges nothing either.
    const plain = createPathHarness({ port, nodes: [rectangleNode('r', 0)] });
    const primitiveOnly = plain.source.prepare(target)!;
    plain.source.acknowledge({ ...receiptOf(primitiveOnly), mesh: { status: 'skipped' } });
    expect(plain.source.prepare(target)!.writes.length).toBe(primitiveOnly.writes.length);
  });

  it('V3-A10: a nonfinite shared meshFrame makes every drawable path packing-range, and primitives draw as usual', () => {
    const port = createCountingPort();
    const h = createPathHarness({
      port,
      nodes: [rectangleNode('r', 0), pathNode('a', 0), pathNode('b', 20)],
    });
    // g = 2^129 at zoom 1e-37, so O_m - camera is about -6.8e38: not a finite binary32 value.
    expect(h.mirror.setCamera({ position: { x: -1, y: 0 }, zoom: 1e-37 }).status).toBe('applied');
    const packet = h.source.prepare(target)!;
    expect(packet.draws).toEqual([{ first: 0, count: 1, variant: 'analytic-v1' }]);
    expect(packet.mesh!.draws).toEqual([]);
    expect(packet.mesh!.notices.map((notice) => [notice.nodeId, notice.failureCode])).toEqual([
      ['a', 'packing-range'],
      ['b', 'packing-range'],
    ]);
    expect(packet.mesh!.writes.some((write) => write.resourceId === 'meshFrame')).toBe(false);
    // Port results were published before packing and stay cached; the state repeats no call
    // and no notice while it holds.
    expect(port.callCount).toBe(1);
    expect(h.statistics().entries).toBe(2);
    const again = h.source.prepare(target)!;
    expect(again.mesh!.notices).toEqual([]);
    expect(port.callCount).toBe(1);
    // Inside the R3 window O_m keeps its value, so at this zoom no camera both re-snaps to a
    // finite origin and keeps the anchors finite; a normal zoom draws again (new bucket e).
    h.setZoom(1);
    const recovered = h.source.prepare(target)!;
    expect(recovered.mesh!.draws.map((draw) => draw.instance)).toEqual([0, 1]);
    expect(recovered.draws).toEqual([{ first: 0, count: 1, variant: 'analytic-v1' }]);
  });

  it('V3-A10: a nonfinite geometry-owned offset or instance anchor is packing-range for that path only', () => {
    const wideMesh = fanMesh([
      [-1e300, 0],
      [1e300, 0],
      [1e300, 1],
    ]);
    const farMesh = fanMesh([
      [1e39, 0],
      [1e39 + 1e24, 0],
      [1e39 + 1e24, 1e24],
    ]);
    const port = meshPort(
      new Map([
        [0, wideMesh],
        [40, farMesh],
      ]),
    );
    const h = createPathHarness({
      port,
      nodes: [pathNode('wide', 0), pathNode('fine', 20), pathNode('far', 40)],
    });
    const packet = h.source.prepare(target)!;
    expect(packet.mesh!.notices.map((notice) => [notice.nodeId, notice.failureCode])).toEqual([
      ['wide', 'packing-range'],
      ['far', 'packing-range'],
    ]);
    expect(packet.mesh!.draws).toHaveLength(1);
    expect(h.statistics().entries).toBe(3);
  });
});

describe('V3b paint order (V3-A12)', () => {
  it('V3-A12: [rect, path, rect, path, rect] gives analytic, mesh, analytic, mesh, analytic with adjacent analytic ranges', () => {
    const port = createCountingPort();
    const h = createPathHarness({
      port,
      nodes: [
        rectangleNode('r0', 0),
        pathNode('p1', 10),
        rectangleNode('r2', 20),
        pathNode('p3', 30),
        rectangleNode('r4', 40),
      ],
    });
    const packet = h.source.prepare(target)!;
    expect(packet.draws).toEqual([
      { first: 0, count: 1, variant: 'analytic-v1' },
      { first: 1, count: 1, variant: 'analytic-v1' },
      { first: 2, count: 1, variant: 'analytic-v1' },
    ]);
    expect(packet.mesh!.draws.map((draw) => [draw.position, draw.instance])).toEqual([
      [1, 0],
      [2, 1],
    ]);
    // A path first and last in paint order sits before and after every analytic draw.
    h.replace([
      pathNode('p1', 10),
      rectangleNode('r0', 0),
      rectangleNode('r2', 20),
      pathNode('p3', 30),
    ]);
    const edges = h.source.prepare(target)!;
    expect(edges.draws).toEqual([{ first: 0, count: 2, variant: 'analytic-v1' }]);
    expect(edges.mesh!.draws.map((draw) => draw.position)).toEqual([0, 1]);
  });

  it('V3-A12: a hidden, culled or failed path between two rectangles leaves one merged analytic draw', () => {
    const port = createFailingPort({ pathFailures: new Map([[30, 'work-limit']]) });
    const scenes: RenderNodeSnapshot[][] = [
      [rectangleNode('r0', 0), pathNode('p', 10, { visible: false }), rectangleNode('r2', 20)],
      [rectangleNode('r0', 0), pathNode('p', 5_000), rectangleNode('r2', 20)],
      [rectangleNode('r0', 0), pathNode('p', 30), rectangleNode('r2', 20)],
      [rectangleNode('r0', 0), pathNode('p', 10, { fill: null }), rectangleNode('r2', 20)],
    ];
    for (const nodes of scenes) {
      const h = createPathHarness({ port, nodes });
      const packet = h.source.prepare(target)!;
      expect(packet.draws).toEqual([{ first: 0, count: 2, variant: 'analytic-v1' }]);
      expect(packet.mesh!.draws).toEqual([]);
    }
  });
});

describe('V3b range management (V3-A13, renderer-core part)', () => {
  const frame = Object.freeze([0, 0, 1, 1, 640, 360, 0, 0]);
  const entries = new Map<string, symbol>();
  function draw(nodeId: string, slot: number, vertices: number, triangles: number): PathMeshDraw {
    let entryId = entries.get(`${nodeId}/${vertices}`);
    if (entryId === undefined) {
      entryId = Symbol(nodeId);
      entries.set(`${nodeId}/${vertices}`, entryId);
    }
    const offsets = Float32Array.from({ length: 2 * vertices }, (_, index) => slot * 100 + index);
    const indices = Uint32Array.from({ length: 3 * triangles }, (_, index) => index % vertices);
    return {
      nodeId,
      slot,
      toleranceExponent: -3,
      fringeBucket: null,
      orientation: 1,
      mesh: {
        positions: new Float64Array(2 * vertices),
        indices,
        boundaryEdges: new Uint32Array(0),
        bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      },
      entryId,
      offsets,
      linear: [1, 0, 0, 1],
      anchor: [slot, 0],
      opacity: 1,
      fill: { r: 1, g: 0, b: 0, a: 1 },
    };
  }
  function run(
    packer: PathMeshPacker,
    draws: readonly PathMeshDraw[],
    slots: ReadonlyMap<string, number>,
    resident: readonly PathMeshDraw[] = draws,
  ) {
    return packer.prepare({
      generation: 1,
      draws,
      slots,
      resident: new Set(resident.map((item) => item.entryId)),
      frameLanes: frame,
    });
  }

  it('V3-A13: first-fit placement, and a released range is reused only after the packet that stops referencing it', () => {
    const packer = new PathMeshPacker();
    const [a, b, c, d] = [
      draw('a', 0, 4, 2),
      draw('b', 1, 4, 2),
      draw('c', 2, 4, 2),
      draw('d', 3, 4, 2),
    ];
    const all = new Map([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
      ['e', 4],
    ]);
    const first = run(packer, [a, b, c, d], all);
    expect([0, 1, 2, 3].map((slot) => packer.getSlotRanges(slot)!.meshPositions)).toEqual([
      0, 4, 8, 12,
    ]);
    expect([0, 1, 2, 3].map((slot) => packer.getSlotRanges(slot)!.meshTriangles)).toEqual([
      0, 2, 4, 6,
    ]);
    expect(first.placements.get('c')).toEqual({ firstTriangle: 4, triangleCount: 2 });

    // b and d leave the cache: their ranges are pending, not free, in this packet.
    run(packer, [a, c], all, [a, c]);
    expect(packer.getSlotRanges(1)).toBeNull();
    expect(packer.getStatistics()).toMatchObject({
      freeElements: { meshPositions: 0, meshTriangles: 8 },
      pendingReleases: 4,
    });
    // The next packet reuses the first hole that fits.
    const e = draw('e', 4, 4, 2);
    const reuse = run(packer, [a, c, e], all);
    expect(packer.getSlotRanges(4)).toMatchObject({ meshPositions: 4, meshTriangles: 2 });
    expect(packer.getStatistics()).toMatchObject({ arenaReplacements: 0, repacks: 0 });
    expect(reuse.resources).toEqual(first.resources);
  });

  it('V3-A13: fragmentation replaces the arena at the same capacity and repacks every resident variant contiguously', () => {
    const packer = new PathMeshPacker();
    const slots = new Map([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
      ['f', 5],
    ]);
    const [a, b, c, d] = [
      draw('a', 0, 4, 2),
      draw('b', 1, 4, 2),
      draw('c', 2, 4, 2),
      draw('d', 3, 4, 2),
    ];
    const first = run(packer, [a, b, c, d], slots);
    run(packer, [b, d], slots, [b, d]);
    // Holes [0, 4) and [8, 12): 8 free elements, but no range fits 6.
    const f = draw('f', 5, 6, 2);
    const shadow = new MeshShadow();
    const repacked = run(packer, [b, d, f], slots);
    expect(packer.getStatistics()).toMatchObject({ arenaReplacements: 1, repacks: 1 });
    expect(repacked.resources.map((resource) => resource.capacityBytes)).toEqual(
      first.resources.map((resource) => resource.capacityBytes),
    );
    for (const [index, resource] of repacked.resources.entries()) {
      expect(resource.incarnation).not.toBe(first.resources[index]!.incarnation);
    }
    expect([1, 3, 5].map((slot) => packer.getSlotRanges(slot)!.meshPositions)).toEqual([0, 4, 8]);
    // Draws placed before the repack in the same packet report their moved ranges.
    expect(['b', 'd', 'f'].map((id) => repacked.placements.get(id))).toEqual([
      { firstTriangle: 0, triangleCount: 2 },
      { firstTriangle: 2, triangleCount: 2 },
      { firstTriangle: 4, triangleCount: 2 },
    ]);
    // Everything resident is rewritten into the new arena, byte for byte from the CPU entries.
    shadow.apply({
      mesh: { ...repacked, draws: [], notices: [], layoutVersion: 0, originRevision: Symbol('o') },
    } as unknown as PrimitivePacket);
    for (const [slot, item] of [
      [1, b],
      [3, d],
      [5, f],
    ] as const) {
      const base = packer.getSlotRanges(slot)!.meshPositions;
      for (let index = 0; index < item.offsets.length; index += 1) {
        expect(shadow.f32('meshPositions', base * 8 + 4 * index)).toBe(item.offsets[index]);
      }
      expect(shadow.u32('meshInstances', slot * 64 + 48)).toBe(base);
    }
    expect(shadow.written.get('meshFrame')).toEqual(new Set([0]));
  });

  it('V3-A13: growth replaces the arena at the next capacity, and meshInstances grows by power of two', () => {
    const packer = new PathMeshPacker();
    const slots = new Map([
      ['a', 0],
      ['g', 1],
    ]);
    const a = draw('a', 0, 10, 4);
    const first = run(packer, [a], slots);
    const g = draw('g', 1, 12, 4);
    const grown = run(packer, [a, g], slots);
    expect(grown.resources[0]).toMatchObject({ id: 'meshPositions', capacityBytes: 32 * 8 });
    expect(grown.resources[0]!.incarnation).not.toBe(first.resources[0]!.incarnation);
    expect(packer.getStatistics()).toMatchObject({ arenaReplacements: 1, repacks: 0 });
    const wide = new Map([...slots, ['h', 16]]);
    const h = draw('h', 16, 3, 1);
    const instances = run(packer, [a, g, h], wide);
    expect(instances.resources[4]).toMatchObject({ id: 'meshInstances', capacityBytes: 32 * 64 });
    expect(packer.getStatistics()).toMatchObject({ arenaReplacements: 2 });
    expect(instances.placements.get('h')).toEqual({ firstTriangle: 8, triangleCount: 1 });
  });
});

describe('V3b device loss and skipped receipts (V3-A15, V3-A13 source part)', () => {
  it('V3-A15: a generation change yields a reconstruct packet whose mesh writes equal the pre-loss bytes, with zero port calls', () => {
    const port = meshPort(
      new Map([
        [
          0,
          fanMesh([
            [0, 0],
            [7.25, 0],
            [7.25, 3.5],
            [0, 3.5],
          ]),
        ],
        [
          20,
          fanMesh([
            [20, 0],
            [25, 0],
            [22.5, 4],
          ]),
        ],
      ]),
    );
    const nodes = [pathNode('a', 0), rectangleNode('r', 40), pathNode('b', 20)];
    const h = createPathHarness({ port, nodes });
    h.setZoom(1.25, { x: -3.5, y: 1.75 });
    const shadow = new MeshShadow();
    const first = h.source.prepare(target)!;
    shadow.apply(first);
    h.source.acknowledge(receiptOf(first));
    // b is hidden: its slot keeps the served variant's ranges while the entry is cached.
    h.replace([pathNode('a', 0), rectangleNode('r', 40), pathNode('b', 20, { visible: false })]);
    const hidden = h.source.prepare(target)!;
    shadow.apply(hidden);
    h.source.acknowledge(receiptOf(hidden));
    const calls = port.callCount;

    const lost = h.source.prepare({ ...target, generation: 2 })!;
    expect(lost.mode).toBe('reconstruct');
    expect(port.callCount).toBe(calls);
    const covered = new Map<MeshResourceId, Set<number>>();
    for (const write of lost.mesh!.writes) {
      const before = shadow.bytes.get(write.resourceId)!;
      expect(write.bytes).toEqual(
        before.subarray(write.byteOffset, write.byteOffset + write.bytes.byteLength),
      );
      const indices = covered.get(write.resourceId) ?? new Set<number>();
      for (const record of write.records) indices.add(record.index);
      covered.set(write.resourceId, indices);
    }
    // Every occupied slot's instance record, every served variant's ranges and the frame.
    expect(covered.get('meshInstances')).toEqual(new Set([0, 1]));
    expect(covered.get('meshPositions')).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
    expect(covered.get('meshTriangles')).toEqual(new Set([0, 1, 2]));
    expect(covered.get('meshFrame')).toEqual(new Set([0]));
    expect(lost.mesh!.draws).toEqual(hidden.mesh!.draws);
  });

  it('V3-A13: a skipped mesh receipt acknowledges the P1 part only, stops mesh draws and writes for that generation, and a new generation retries', () => {
    const port = createFailingPort({ pathFailures: new Map([[40, 'work-limit']]) });
    const h = createPathHarness({
      port,
      nodes: [rectangleNode('r0', 0), pathNode('a', 10), rectangleNode('r2', 20)],
    });
    const first = h.source.prepare(target)!;
    expect(first.draws).toHaveLength(2);
    h.source.acknowledge(receiptOf(first, 'skipped'));
    const stopped = h.source.prepare(target)!;
    expect(stopped.writes).toEqual([]);
    expect(stopped.draws).toEqual([{ first: 0, count: 2, variant: 'analytic-v1' }]);
    expect(stopped.mesh).toMatchObject({ resources: [], writes: [], draws: [], notices: [] });
    // Queued notices still travel in a part holding notices only.
    h.replace([
      rectangleNode('r0', 0),
      pathNode('a', 10),
      rectangleNode('r2', 20),
      pathNode('bad', 40),
    ]);
    const notices = h.source.prepare(target)!;
    expect(notices.mesh).toMatchObject({ resources: [], writes: [], draws: [] });
    expect(notices.mesh!.notices.map((notice) => notice.nodeId)).toEqual(['bad']);
    h.source.acknowledge(receiptOf(notices, 'skipped'));
    // A new generation tries the mesh path again with every mesh record.
    const retry = h.source.prepare({ ...target, generation: 2 })!;
    expect(retry.mesh!.resources).toHaveLength(6);
    expect(retry.mesh!.draws).toHaveLength(1);
    expect(retry.mesh!.writes.map((write) => write.resourceId)).toEqual([
      'meshPositions',
      'meshTriangles',
      'meshInstances',
      'meshFrame',
    ]);
  });
});

describe('V3b primitive-only identity (V3-A16) and the source flag', () => {
  function serialize(packet: PrimitivePacket | null): unknown {
    if (packet === null) return null;
    return {
      keys: Object.keys(packet),
      mode: packet.mode,
      resources: packet.resources.map((resource) => [resource.id, resource.capacityBytes]),
      writes: packet.writes.map((write) => [
        write.resourceId,
        write.byteOffset,
        Buffer.from(write.bytes).toString('hex'),
        write.records.map((record) => record.index),
      ]),
      draws: packet.draws,
      frame: packet.frame,
    };
  }

  it('V3-A16: a service with a port and a primitive-only scene emits packets identical to a service without one', () => {
    const port = createCountingPort();
    const withPort = new PrimitiveRendererService(noInvalidation, { fillMesh: port });
    const without = new PrimitiveRendererService(noInvalidation);
    expect(withPort.requiresMeshPipeline).toBe(true);
    expect(without.requiresMeshPipeline).toBe(false);
    const nodes = [rectangleNode('a', 0), rectangleNode('b', 30)];
    const frames: Array<(service: PrimitiveRendererService) => void> = [
      (service) => {
        service.replaceSnapshot({ identity, revision: 1, nodes, rootOrder: ['a', 'b'] });
      },
      (service) => {
        service.setCamera({ position: { x: 300, y: -20 }, zoom: 2 });
      },
      (service) => {
        service.setCamera({ position: { x: 1_000, y: 4 }, zoom: 0.5 });
      },
    ];
    const targets: PrimitiveTarget[] = [target, target, { ...target, generation: 2 }];
    frames.forEach((apply, index) => {
      apply(withPort);
      apply(without);
      const left = withPort.prepare(targets[index]!);
      const right = without.prepare(targets[index]!);
      expect(left).not.toHaveProperty('mesh');
      expect(serialize(left)).toEqual(serialize(right));
      if (left !== null) withPort.acknowledge(receiptOf(left));
      if (right !== null) without.acknowledge(receiptOf(right));
    });
    expect(port.callCount).toBe(0);
  });

  it('V3-A16: requiresMeshPipeline is optional and false for a source without a port', () => {
    const mirror = new RetainedSceneMirror();
    expect(new PrimitiveSceneSource(mirror).requiresMeshPipeline).toBe(false);
    const h = createPathHarness({ port: createCountingPort() });
    expect(h.source.requiresMeshPipeline).toBe(true);
  });
});

// Recorded from this V3b implementation; a change to any mesh byte, offset or draw breaks it.
const GOLDEN_MESH_PART_DIGEST = 'fca584dbb67047b51542113ad3c303ad9d70b7225dc62f44893e8d379e330b23';

function exact(value: number): bigint {
  // value * 2^1100, exact for every finite binary64 value.
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const biased = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  let exponent = -1074;
  if (biased !== 0) {
    mantissa |= 1n << 52n;
    exponent = biased - 1075;
  }
  const scaled = mantissa << BigInt(exponent + 1100);
  return high >>> 31 === 1 ? -scaled : scaled;
}

function stepFloat32(value: number, direction: 1 | -1): number {
  const floats = new Float32Array([value]);
  const bits = new Uint32Array(floats.buffer);
  if (value === 0) return direction * 2 ** -149;
  bits[0] = value > 0 === direction > 0 ? bits[0]! + 1 : bits[0]! - 1;
  return floats[0]!;
}
