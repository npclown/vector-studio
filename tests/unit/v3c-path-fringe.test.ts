import type { FillMesh, FillMeshRequest } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkPartition,
  pointTriangleDistanceSquared,
  sectorsOf,
  segmentTriangleDistanceSquared,
  type P,
} from '../geometry/coverage-oracle/exterior.js';
import type { Q2 } from '../geometry/coverage-oracle/positions.js';
import { bitsOf, compare, exactInteger, rational } from '../geometry/rounded-fill/exact.js';
import {
  buildPathFringe,
  buildPathFringeDetailed,
  pathFringeBytes,
  type PathFringe,
} from '../../packages/renderer-core/src/path-fringe.js';
import { MESH_FILL_SHADER } from '../../packages/renderer-webgpu/src/mesh-fill-shader.js';
import { FILL_CONFORMANCE_PATHS } from '../support/fill-mesh-port-conformance.js';
import { FillMeshPortDouble } from '../support/fill-mesh-port-double.js';
import {
  ScriptedFillMeshPort,
  createPathHarness,
  okResult,
  pathNode,
  squareMesh,
} from '../support/v3a-path-harness.js';
import { receiptOf, words } from '../support/v3b-mesh-harness.js';

// P3 V3 contract unit V3c, section e: the exact fringe builder, its exterior triangles, features
// and lists (V3-A11), checked against O02's independent test-only oracle
// (tests/geometry/coverage-oracle/exterior.ts). Functional evidence only: precision is
// UNVERIFIED against the 0.25 physical-pixel target, and no Q4 coverage threshold is claimed.

type Point = readonly [number, number];

/** An owned port-shaped mesh: triangles made counterclockwise, boundary edges used once. */
function meshOf(vertices: readonly Point[], triangles: readonly (readonly number[])[]): FillMesh {
  const oriented = triangles.map(([a, b, c]) => {
    const [ax, ay] = vertices[a!]!;
    const [bx, by] = vertices[b!]!;
    const [cx, cy] = vertices[c!]!;
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) > 0 ? [a!, b!, c!] : [a!, c!, b!];
  });
  const uses = new Map<string, number>();
  for (const [a, b, c] of oriented)
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = `${Math.min(p!, q!)}:${Math.max(p!, q!)}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  const boundary: number[] = [];
  for (const [a, b, c] of oriented)
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const)
      if (uses.get(`${Math.min(p!, q!)}:${Math.max(p!, q!)}`) === 1) boundary.push(p!, q!);
  const xs = vertices.map(([x]) => x);
  const ys = vertices.map(([, y]) => y);
  return {
    positions: Float64Array.from(vertices.flat()),
    indices: Uint32Array.from(oriented.flat()),
    boundaryEdges: Uint32Array.from(boundary),
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
  };
}

/** The V2 conformance double's hand meshes for a fixture, as the port would return them. */
function doubleMesh(name: keyof typeof FILL_CONFORMANCE_PATHS, fillRule: 'nonzero' | 'evenodd') {
  const fixture = FILL_CONFORMANCE_PATHS[name];
  const request: FillMeshRequest = {
    requestId: 0,
    verbs: Uint8Array.from(fixture.verbs),
    points: Float64Array.from(fixture.points),
    fillRule,
    toleranceExponent: -3,
  };
  const batch = new FillMeshPortDouble().buildFillMeshes([request]);
  if (batch.status !== 'ok' || batch.results[0]!.status !== 'ok') throw new Error(name);
  return batch.results[0]!.mesh;
}

// O02's synthetic shapes (tests/geometry/coverage-o02.test.ts).
const star = (() => {
  const outer: Point[] = [];
  const inner: Point[] = [];
  for (let i = 0; i < 5; i += 1) {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / 5;
    const b = a + Math.PI / 5;
    outer.push([10 + 9 * Math.cos(a), 10 + 9 * Math.sin(a)]);
    inner.push([
      10 + 3.5 * Math.cos(b - (2 * Math.PI) / 5),
      10 + 3.5 * Math.sin(b - (2 * Math.PI) / 5),
    ]);
  }
  const triangles: number[][] = [];
  for (let i = 0; i < 5; i += 1) triangles.push([i, 5 + ((i + 1) % 5), 5 + i]);
  return meshOf([...outer, ...inner], triangles);
})();

const zeroClosure = meshOf(
  [
    [0, 2],
    [2, 2],
    [2, 4],
    [0, 4],
    [2, 0],
    [4, 0],
    [4, 2],
    [6, 2],
    [6, 4],
    [4, 4],
    [4, 6],
    [2, 6],
  ],
  [
    [0, 1, 2],
    [0, 2, 3],
    [4, 5, 6],
    [4, 6, 1],
    [6, 7, 8],
    [6, 8, 9],
    [2, 9, 10],
    [2, 10, 11],
  ],
);

const bowtiePinch = meshOf(
  [
    [0, 0],
    [6, 0],
    [3, 3],
    [0, 6],
    [6, 6],
  ],
  [
    [0, 1, 2],
    [2, 4, 3],
  ],
);

/** F01-F11 (P3 private contract) with the V2 double's meshes, plus O02's synthetic shapes. */
const CORPUS: ReadonlyArray<readonly [string, FillMesh]> = [
  ['F01', doubleMesh('f01', 'nonzero')],
  ['F02 nonzero', doubleMesh('f02', 'nonzero')],
  ['F02 evenodd', doubleMesh('f02', 'evenodd')],
  ['F03', doubleMesh('f03', 'nonzero')],
  ['F04 nonzero', doubleMesh('f04', 'nonzero')],
  // F05 and F04 evenodd are empty: no mesh, no fringe.
  ['F06 bowtie', doubleMesh('f06', 'nonzero')],
  ['F07', doubleMesh('f07', 'nonzero')],
  // F08: the open triangle (0,0),(8,0),(0,8), filled.
  [
    'F08',
    meshOf(
      [
        [0, 0],
        [8, 0],
        [0, 8],
      ],
      [[0, 1, 2]],
    ),
  ],
  // F09: a repeated point on F01 and a contour permutation of F02 leave the region unchanged.
  ['F09 (F01 region)', doubleMesh('f01', 'nonzero')],
  ['F09 (F02 evenodd region)', doubleMesh('f02', 'evenodd')],
  ['F10 nonzero', doubleMesh('f10', 'nonzero')],
  ['F10 evenodd', doubleMesh('f10', 'evenodd')],
  ['F10 reversed', doubleMesh('f10Reversed', 'nonzero')],
  ['F11', doubleMesh('f11', 'nonzero')],
  ['H1', doubleMesh('h1', 'nonzero')],
  ['H2', doubleMesh('h2', 'nonzero')],
  ['bowtie pinch', bowtiePinch],
  ['even-odd star', star],
  ['zero closure', zeroClosure],
];

const BUCKETS = [-3, 0, 1, 4] as const;

/** Independent fixed point: every binary64 is an integer multiple of 2^-1074. */
const fixed = (value: number): bigint => exactInteger(bitsOf(value));

function midpointOf(mesh: FillMesh): Point {
  return [mesh.bounds.minX / 2 + mesh.bounds.maxX / 2, mesh.bounds.minY / 2 + mesh.bounds.maxY / 2];
}

/** Exact points of a variant: port vertices, then the frame corners m + k. */
function variantPoints(mesh: FillMesh, fringe: PathFringe): P[] {
  const points: P[] = [];
  for (let index = 0; index < mesh.positions.length; index += 2) {
    points.push([fixed(mesh.positions[index]!), fixed(mesh.positions[index + 1]!)]);
  }
  const [mx, my] = midpointOf(mesh);
  for (let corner = 0; corner < 4; corner += 1) {
    points.push([
      fixed(mx) + fixed(fringe.corners[2 * corner]!),
      fixed(my) + fixed(fringe.corners[2 * corner + 1]!),
    ]);
  }
  return points;
}

function records(fringe: PathFringe) {
  return Array.from({ length: fringe.triangles.length / 8 }, (_, index) => {
    const at = index * 8;
    const t = fringe.triangles;
    return {
      triangle: [t[at]!, t[at + 1]!, t[at + 2]!] as const,
      list: Array.from(fringe.lists.subarray(t[at + 3], t[at + 3]! + t[at + 4]!)),
      role: t[at + 5]!,
      padding: [t[at + 6]!, t[at + 7]!],
    };
  });
}

function built(mesh: FillMesh, f: number) {
  const detailed = buildPathFringeDetailed(mesh, f);
  if (detailed.result.status !== 'built') {
    throw new Error(`not built: ${JSON.stringify(detailed.result)}`);
  }
  return { fringe: detailed.result.fringe, exterior: detailed.exterior! };
}

describe('V3c fringe partition (V3-A11)', () => {
  for (const [name, mesh] of CORPUS) {
    it(`V3-A11: ${name}: region plus exterior partition the frame exactly (O02 checkPartition)`, () => {
      for (const f of BUCKETS) {
        const { fringe, exterior } = built(mesh, f);
        const points = variantPoints(mesh, fringe);
        const n = mesh.positions.length / 2;
        const frame = [n, n + 1, n + 2, n + 3] as const;
        const region = Array.from({ length: mesh.indices.length / 3 }, (_, index) =>
          Array.from(mesh.indices.subarray(3 * index, 3 * index + 3)),
        ) as unknown as [number, number, number][];
        expect(checkPartition(points, [...region, ...exterior], frame), `${name} f=${f}`).toBe(
          null,
        );
        // Region triangles come first and are the port's, unchanged; exterior triangles follow
        // in builder order, and only those with an empty list are dropped.
        const published = records(fringe);
        expect(published.slice(0, region.length).map((record) => record.triangle)).toEqual(region);
        expect(published.slice(0, region.length).every((record) => record.role === 0)).toBe(true);
        const kept = published.slice(region.length);
        expect(kept.every((record) => record.role === 1 && record.list.length > 0)).toBe(true);
        expect(fringe.regionTriangles).toBe(region.length);
        expect(fringe.exteriorTriangles + fringe.droppedExterior).toBe(exterior.length);
        let cursor = 0;
        for (const record of kept) {
          while (cursor < exterior.length && exterior[cursor]!.join() !== record.triangle.join())
            cursor += 1;
          expect(cursor < exterior.length, `${name} f=${f}: exterior order`).toBe(true);
          cursor += 1;
        }
        // No Steiner points: exterior triangles use boundary vertices and frame corners only.
        const boundary = new Set([...mesh.boundaryEdges, ...frame]);
        for (const triangle of exterior)
          for (const v of triangle) expect(boundary.has(v)).toBe(true);
        expect(published.every((record) => record.padding.join() === '0,0')).toBe(true);
      }
    });
  }

  it('V3-A11: the frame margin is at least rho on every side, on the binary32 offset grid', () => {
    for (const [name, mesh] of CORPUS) {
      for (const f of BUCKETS) {
        const { fringe } = built(mesh, f);
        const [mx, my] = midpointOf(mesh);
        const rho = fixed(2 ** f);
        const [kx0, ky0, kx1, , , ky1] = fringe.corners;
        expect(fringe.corners.every((value) => Math.fround(value) === value)).toBe(true);
        expect(fixed(mx) + fixed(kx0!) <= fixed(mesh.bounds.minX) - rho, name).toBe(true);
        expect(fixed(my) + fixed(ky0!) <= fixed(mesh.bounds.minY) - rho, name).toBe(true);
        expect(fixed(mx) + fixed(kx1!) >= fixed(mesh.bounds.maxX) + rho, name).toBe(true);
        expect(fixed(my) + fixed(ky1!) >= fixed(mesh.bounds.maxY) + rho, name).toBe(true);
        // Corner order (x0, y0), (x1, y0), (x1, y1), (x0, y1): positive orientation.
        expect(Array.from(fringe.corners)).toEqual([kx0, ky0, kx1, ky0, kx1, ky1, kx0, ky1]);
      }
    }
  });
});

describe('V3c features and lists (V3-A11)', () => {
  it('V3-A11: every list holds exactly the features within rho of its closed triangle (brute force)', () => {
    for (const [name, mesh] of CORPUS) {
      for (const f of BUCKETS) {
        const { fringe } = built(mesh, f);
        const points = variantPoints(mesh, fringe);
        const q = (index: number): Q2 => [rational(points[index]![0]), rational(points[index]![1])];
        const reach = rational(fixed(2 ** f) * fixed(2 ** f));
        // Global order, independently: edges by (from, to), then boundary vertices ascending.
        const edges: [number, number][] = [];
        for (let slot = 0; slot < mesh.boundaryEdges.length; slot += 2)
          edges.push([mesh.boundaryEdges[slot]!, mesh.boundaryEdges[slot + 1]!]);
        edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        const vertices = [...new Set(mesh.boundaryEdges)].sort((a, b) => a - b);
        for (const record of records(fringe)) {
          const triangle = record.triangle.map(q) as unknown as readonly [Q2, Q2, Q2];
          const expected: number[] = [];
          edges.forEach(([a, b], index) => {
            if (compare(segmentTriangleDistanceSquared(q(a), q(b), triangle), reach) <= 0)
              expected.push(index);
          });
          vertices.forEach((vertex, index) => {
            if (compare(pointTriangleDistanceSquared(q(vertex), triangle), reach) <= 0)
              expected.push(edges.length + index);
          });
          expect(record.list, `${name} f=${f} ${record.triangle.join()}`).toEqual(expected);
        }
        // A dropped exterior triangle has no feature within rho.
        const { exterior } = built(mesh, f);
        const kept = new Set(records(fringe).map((record) => record.triangle.join()));
        for (const dropped of exterior.filter((triangle) => !kept.has(triangle.join()))) {
          const triangle = dropped.map(q) as unknown as readonly [Q2, Q2, Q2];
          for (const [a, b] of edges)
            expect(compare(segmentTriangleDistanceSquared(q(a), q(b), triangle), reach)).toBe(1);
        }
      }
    }
  });

  it('V3-A11: EDGE and VERTEX records follow section f, with O02 sectors and reflex bits', () => {
    for (const [name, mesh] of [['F02 evenodd', CORPUS[2]![1]], ...CORPUS.slice(-3)] as const) {
      const { fringe } = built(mesh, 0);
      const [mx, my] = midpointOf(mesh);
      const u = (vertex: number) => [
        Math.fround(mesh.positions[2 * vertex]! - mx),
        Math.fround(mesh.positions[2 * vertex + 1]! - my),
      ];
      const f32 = words(new Uint8Array(fringe.features.buffer), 'f32');
      const u32 = Array.from(fringe.features);
      const edges: [number, number][] = [];
      for (let slot = 0; slot < mesh.boundaryEdges.length; slot += 2)
        edges.push([mesh.boundaryEdges[slot]!, mesh.boundaryEdges[slot + 1]!]);
      edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      edges.forEach(([a, b], index) => {
        const at = 16 * index;
        expect(u32[at]).toBe(0);
        expect(f32.slice(at + 1, at + 5)).toEqual([...u(a), ...u(b)]);
        expect(u32.slice(at + 5, at + 16).every((word) => word === 0)).toBe(true);
      });
      const points = variantPoints(mesh, fringe);
      const oracle = sectorsOf(
        points,
        edges.map(([from, to], edge) => ({ from, to, edge })),
      );
      if (oracle.status !== 'OK') throw new Error(`${name}: ${oracle.reason}`);
      oracle.vertices.forEach(({ vertex, sectors }, index) => {
        const at = 16 * (edges.length + index);
        expect(u32[at], name).toBe(1);
        let flags = sectors.length;
        sectors.forEach((sector, s) => {
          if (sector.reflex) flags |= 1 << (8 + s);
          // Unnormalized local directions: parallel to the exact rays, larger component in [1, 2).
          for (const [ray, lane] of [
            [sector.rOut, at + 4 + 4 * s],
            [sector.rIn, at + 6 + 4 * s],
          ] as const) {
            const other = ray[0] === vertex ? ray[1] : ray[0];
            const dx = mesh.positions[2 * other]! - mesh.positions[2 * vertex]!;
            const dy = mesh.positions[2 * other + 1]! - mesh.positions[2 * vertex + 1]!;
            const [x, y] = [f32[lane]!, f32[lane + 1]!];
            expect(Math.max(Math.abs(x), Math.abs(y))).toBeGreaterThanOrEqual(1);
            expect(Math.max(Math.abs(x), Math.abs(y))).toBeLessThan(2);
            expect(x * dx + y * dy).toBeGreaterThan(0);
            expect(Math.abs(x * dy - y * dx)).toBeLessThan(1e-6 * Math.hypot(dx, dy));
          }
        });
        expect(u32[at + 1], name).toBe(flags);
        expect(f32.slice(at + 2, at + 4)).toEqual(u(vertex));
        expect(u32.slice(at + 4 + 4 * sectors.length, at + 16).every((word) => word === 0)).toBe(
          true,
        );
      });
      expect(fringe.features.length).toBe(16 * (edges.length + oracle.vertices.length));
    }
  });
});

describe('V3c builder failures (V3-A11, V3-A8)', () => {
  const fan = meshOf(
    [
      [5, 5],
      [9, 4],
      [9, 6],
      [4, 9],
      [6, 9],
      [1, 6],
      [1, 4],
      [6, 1],
      [4, 1],
    ],
    [
      [0, 1, 2],
      [0, 4, 3],
      [0, 5, 6],
      [0, 8, 7],
    ],
  );
  const F32_MAX = 3.4028234663852886e38;
  const huge: FillMesh = {
    positions: Float64Array.from([-F32_MAX, 0, F32_MAX, 0, F32_MAX, 1, -F32_MAX, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    boundaryEdges: Uint32Array.from([0, 1, 1, 2, 2, 3, 3, 0]),
    bounds: { minX: -F32_MAX, minY: 0, maxX: F32_MAX, maxY: 1 },
  };

  it('V3-A11: a vertex of degree above 6 and duplicate coordinates are fringe-unsupported', () => {
    expect(buildPathFringe(fan, 0)).toEqual({ status: 'unsupported', reason: 'degree:0:8' });
    const twins = meshOf(
      [
        [0, 0],
        [4, 0],
        [2, 2],
        [2, 2],
        [4, 4],
        [0, 4],
      ],
      [
        [0, 1, 2],
        [3, 4, 5],
      ],
    );
    expect(buildPathFringe(twins, 0)).toEqual({ status: 'unsupported', reason: 'duplicate:2:3' });
    // A failed partition (here a reversed region triangle) is never published.
    const reversed = { ...squareMesh(), indices: Uint32Array.from([0, 2, 1, 0, 3, 2]) };
    expect(buildPathFringe(reversed, 0).status).toBe('unsupported');
  });

  it('V3-A11: a frame corner that is not a finite binary32 value is fringe-range', () => {
    expect(buildPathFringe(huge, 1)).toEqual({ status: 'range' });
    expect(buildPathFringe(squareMesh(), 1).status).toBe('built');
  });

  it('V3-A11 and V3-A8 in the pipeline: unsupported keeps the mesh cached; a range corner is the fringe-range state', () => {
    const meshes = new Map<number, FillMesh>([
      [0, fan],
      [20, huge],
      [40, squareMesh()],
    ]);
    const port = new ScriptedFillMeshPort({
      request: (request, tag) => okResult(request, meshes.get(tag)),
    });
    const h = createPathHarness({
      port,
      nodes: [pathNode('fan', 0), pathNode('huge', 20), pathNode('square', 40)],
      fringeBuilder: buildPathFringe,
    });
    const first = h.prepare();
    expect(first.draws.map((draw) => draw.nodeId)).toEqual(['square']);
    expect(first.notices).toEqual([
      {
        interim: 'd8',
        nodeId: 'fan',
        failureScope: 'renderer',
        failureCode: 'fringe-unsupported',
        toleranceExponent: -3,
      },
      {
        interim: 'd8',
        nodeId: 'huge',
        failureScope: 'renderer',
        failureCode: 'fringe-range',
        toleranceExponent: null,
      },
    ]);
    expect(h.statistics().entries).toBe(3);
    expect(h.prepare()).toMatchObject({ notices: [] });
    expect(port.callCount).toBe(1);
  });
});

describe('V3c fringe variants in the packet (V3-A11, section f)', () => {
  it('V3-A11: a served variant stores its corners after the port vertices and its own records', () => {
    const port = new ScriptedFillMeshPort({
      request: (request) => okResult(request, squareMesh()),
    });
    const h = createPathHarness({
      port,
      nodes: [pathNode('p', 0)],
      fringeBuilder: buildPathFringe,
    });
    const packet = h.source.prepare({
      generation: 1,
      surfaceRevision: 1,
      width: 640,
      height: 360,
      devicePixelRatio: 1,
      sampleCount: 4,
      targetFormat: 'bgra8unorm',
    })!;
    const fringe = buildPathFringe(squareMesh(), 1);
    if (fringe.status !== 'built') throw new Error('not built');
    const bytes = (resource: string) =>
      packet.mesh!.writes.filter((write) => write.resourceId === resource);
    const [positions] = bytes('meshPositions');
    expect(words(positions!.bytes, 'f32')).toEqual([
      -5,
      -5,
      5,
      -5,
      5,
      5,
      -5,
      5,
      ...Array.from(fringe.fringe.corners),
    ]);
    expect(words(bytes('meshTriangles')[0]!.bytes, 'u32')).toEqual(
      Array.from(fringe.fringe.triangles),
    );
    expect(words(bytes('meshFeatureLists')[0]!.bytes, 'u32')).toEqual(
      Array.from(fringe.fringe.lists),
    );
    expect(words(bytes('meshFeatures')[0]!.bytes, 'u32')).toEqual(
      Array.from(fringe.fringe.features),
    );
    const draw = packet.mesh!.draws[0]!;
    expect(draw.triangleCount).toBe(fringe.fringe.triangles.length / 8);
    expect(draw.triangleCount).toBe(
      fringe.fringe.regionTriangles + fringe.fringe.exteriorTriangles,
    );
    const instance = words(bytes('meshInstances')[0]!.bytes, 'u32');
    expect(instance.slice(12, 16)).toEqual([0, 0, 0, 0]);
    expect(h.statistics().bytes).toBe(152 + pathFringeBytes(fringe.fringe));
  });

  it('V3-A11: each fringe variant has its own ranges; switching variants rewrites them, serving within f + 1 does not', () => {
    const port = new ScriptedFillMeshPort({
      request: (request) => okResult(request, squareMesh()),
    });
    const builds: number[] = [];
    const h = createPathHarness({
      port,
      nodes: [pathNode('p', 0)],
      fringeBuilder: (mesh, f) => {
        builds.push(f);
        return buildPathFringe(mesh, f);
      },
    });
    const target = {
      generation: 1,
      surfaceRevision: 1,
      width: 640,
      height: 360,
      devicePixelRatio: 1,
      sampleCount: 4 as const,
      targetFormat: 'bgra8unorm' as const,
    };
    const geometryWrites = (zoom: number) => {
      h.setZoom(zoom);
      const packet = h.source.prepare(target)!;
      h.source.acknowledge(receiptOf(packet));
      return packet
        .mesh!.writes.map((write) => write.resourceId)
        .filter((id) => id !== 'meshInstances' && id !== 'meshFrame');
    };
    const all = ['meshPositions', 'meshTriangles', 'meshFeatureLists', 'meshFeatures'];
    expect(geometryWrites(1)).toEqual(all);
    // f = 3 at zoom 0.25: f' = 1 cannot serve it, so a new variant is built and placed.
    expect(geometryWrites(0.25)).toEqual(all);
    // f = 2 at zoom 0.5 is served by f' = 3 (f <= f' <= f + 1): no rebuild, no geometry write.
    expect(geometryWrites(0.5)).toEqual([]);
    // Back at f = 1: the cached f' = 1 variant serves again without a rebuild, in new ranges.
    expect(geometryWrites(1)).toEqual(all);
    expect(builds).toEqual([1, 3]);
    expect(port.callCount).toBe(1);
  });
});

describe('V3c coverage shader (section e)', () => {
  it('evaluates the O02 rule at @builtin(position) with sigma and no per-sample state', () => {
    expect(MESH_FILL_SHADER).toContain('fn meshCoverage(p: vec2f');
    expect(MESH_FILL_SHADER).toContain('meshCoverage(input.position.xy, triangle, instance)');
    expect(MESH_FILL_SHADER).toContain('clamp(0.5 - side / width, 0.0, 1.0)');
    expect(MESH_FILL_SHADER).toContain('best >= FAR_FIELD_PX');
    expect(MESH_FILL_SHADER).toContain('instance.orientation * cross2(rOut, d)');
    expect(MESH_FILL_SHADER).toContain('-instance.orientation * cross2(t, q)');
    expect(MESH_FILL_SHADER).not.toMatch(/sample_index|@interpolate\([^)]*sample|fwidth|dpdx/);
  });
});
