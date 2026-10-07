import { describe, expect, it } from 'vitest';

import type { ProjectionInput } from './mesh-projection/model.js';
import { q } from './position-certificate/certificate.js';
import {
  add,
  absolute,
  compare,
  mul,
  rational,
  sign,
  type Rational,
} from './rounded-fill/exact.js';
import { cross3, earClip, type Cell, type Q2 } from './extent-t01/clip.js';
import { cellOf, pow2 } from './extent-t01/tile.js';
import { trajectoryCells, trajectoryCellKey } from './extent-t02/cells.js';
import { fringeFaces, pointKey, type FringeResult } from './extent-t02/fringe.js';
import {
  buildCellFringe,
  buildCellGeometry,
  buildMergedMesh,
  classify,
  compareRecords,
  sourceContext,
  type EpochCells,
  type MergedMesh,
} from './extent-t02/merged.js';
import { checkMergedPartition } from './extent-t02/partition.js';

// ---------------------------------------------------------------------------------------------
// Helpers.

const r = (value: number): Rational => q(value);
const pt = (x: number, y: number): Q2 => [r(x), r(y)];

function makeInput(
  vertices: readonly (readonly [number, number])[],
  indices: readonly number[],
): ProjectionInput {
  return {
    id: 'extent-t02-host',
    mesh: { vertices, indices },
    affine: [1, 0, 0, 1, 0, 0],
    camera: [0, 0],
    origin: [0, 0],
    zoom: 1,
    dpr: 1,
    width: 64,
    height: 64,
  };
}

/** Candidate cells over [i0, i1] × [j0, j1], in (j, then i) order. */
function block(i0: number, i1: number, j0: number, j1: number): EpochCells['candidates'] {
  const cells: { i: bigint; j: bigint }[] = [];
  for (let j = j0; j <= j1; j += 1)
    for (let i = i0; i <= i1; i += 1) cells.push({ i: BigInt(i), j: BigInt(j) });
  return cells;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function strictlyIn(point: Q2, triangle: readonly [Q2, Q2, Q2]): boolean {
  const s = [
    sign(cross3(triangle[0], triangle[1], point)),
    sign(cross3(triangle[1], triangle[2], point)),
    sign(cross3(triangle[2], triangle[0], point)),
  ];
  return s[0] !== 0 && s[0] === s[1] && s[1] === s[2];
}

function onTriangleBoundary(point: Q2, triangle: readonly [Q2, Q2, Q2]): boolean {
  const s = [
    sign(cross3(triangle[0], triangle[1], point)),
    sign(cross3(triangle[1], triangle[2], point)),
    sign(cross3(triangle[2], triangle[0], point)),
  ];
  if (!s.includes(0)) return false;
  const nonzero = s.filter((value) => value !== 0);
  return nonzero.every((value) => value === nonzero[0]);
}

function twiceAbs(triangle: readonly [Q2, Q2, Q2]): Rational {
  return absolute(cross3(...triangle));
}

/**
 * Brute-force area decomposition of a cell: the exterior and region triangles' areas sum to the
 * cell area, and every generic sample point of the open cell is strictly inside exactly one of
 * them (samples on a triangle boundary are skipped).
 */
function checkDecomposition(
  cell: Cell,
  pieces: readonly (readonly Q2[])[],
  result: FringeResult,
  winding: 1 | -1,
): void {
  expect(result.status).toBe('OK');
  if (result.status !== 'OK') return;
  const region = pieces.flatMap((ring) =>
    earClip(ring).map(([a, b, c]) => [ring[a]!, ring[b]!, ring[c]!] as const),
  );
  for (const triangle of result.exterior) expect(sign(cross3(...triangle))).toBe(winding);
  let total = rational(0n);
  for (const triangle of [...region, ...result.exterior]) total = add(total, twiceAbs(triangle));
  const side = add(cell.x1, rational(-cell.x0.n, cell.x0.d));
  expect(compare(total, mul(rational(2n), mul(side, side)))).toBe(0);
  const all = [...region, ...result.exterior];
  const N = 23n;
  let samples = 0;
  for (let k = 0n; k < N; k += 1n)
    for (let l = 0n; l < N; l += 1n) {
      const fx = rational(2n * k + 1n, 2n * N);
      const fy = rational(2n * l + 1n, 2n * N);
      const point: Q2 = [
        add(add(cell.x0, mul(fx, side)), rational(1n, 977n)),
        add(add(cell.y0, mul(fy, side)), rational(1n, 1009n)),
      ];
      if (compare(point[0], cell.x1) >= 0 || compare(point[1], cell.y1) >= 0) continue;
      if (all.some((triangle) => onTriangleBoundary(point, triangle))) continue;
      const count = all.filter((triangle) => strictlyIn(point, triangle)).length;
      expect(count, `sample ${pointKey(point)}`).toBe(1);
      samples += 1;
    }
  expect(samples).toBeGreaterThan(100);
}

const cell4 = cellOf(2, 0n, 0n); // [0, 4]²
const corners4 = [pt(0, 0), pt(4, 0), pt(4, 4), pt(0, 4)];

type FringeCase = Readonly<{
  name: string;
  pieces: readonly (readonly Q2[])[];
  side: readonly Q2[];
  faces: number;
}>;

const annulus = (() => {
  const outer = [pt(0.5, 0.5), pt(3.5, 0.5), pt(3.5, 3.5), pt(0.5, 3.5)];
  const inner = [pt(1.5, 1.5), pt(2.5, 1.5), pt(2.5, 2.5), pt(1.5, 2.5)];
  const pieces: Q2[][] = [];
  for (let k = 0; k < 4; k += 1) {
    const n = (k + 1) % 4;
    pieces.push([outer[k]!, outer[n]!, inner[n]!], [outer[k]!, inner[n]!, inner[k]!]);
  }
  return pieces;
})();

const FRINGE_CASES: readonly FringeCase[] = [
  {
    name: 'boundary touching a side at a point',
    pieces: [[pt(2, 0), pt(3, 2), pt(1, 2)]],
    side: [pt(2, 0)],
    faces: 1,
  },
  {
    name: 'pinch on a side',
    pieces: [
      [pt(2, 0), pt(1, 2), pt(0.5, 1)],
      [pt(2, 0), pt(3.5, 1), pt(3, 2)],
    ],
    side: [pt(2, 0)],
    faces: 1,
  },
  {
    name: 'interior pinch',
    pieces: [
      [pt(1, 1), pt(2, 2), pt(1, 2)],
      [pt(2, 2), pt(3, 3), pt(2, 3)],
    ],
    side: [],
    faces: 1,
  },
  { name: 'island hole', pieces: [[pt(1, 1), pt(3, 1), pt(2, 3)]], side: [], faces: 1 },
  { name: 'annulus with a pocket', pieces: annulus, side: [], faces: 2 },
  {
    name: 'collinear seam points',
    pieces: [
      [pt(0, 0), pt(2, 0), pt(1, 1)],
      [pt(2, 0), pt(4, 0), pt(3, 1)],
    ],
    side: [pt(2, 0), pt(4, 1), pt(4, 3), pt(1, 4), pt(2, 4), pt(3, 4), pt(0, 2)],
    faces: 1,
  },
  {
    name: 'boundary along a grid line (no pieces)',
    pieces: [],
    side: [pt(1, 0), pt(3, 0)],
    faces: 1,
  },
  {
    name: 'boundary along a grid line (region strip on a side)',
    pieces: [
      [pt(0, 0), pt(4, 0), pt(4, 1)],
      [pt(0, 0), pt(4, 1), pt(0, 1)],
    ],
    side: [pt(4, 1), pt(0, 1), pt(2, 0)],
    faces: 1,
  },
  {
    name: 'corners outside the region',
    pieces: [[pt(0, 0), pt(2, 0), pt(0, 2)]],
    side: [pt(2, 0), pt(0, 2)],
    faces: 1,
  },
  {
    name: 'region splitting the cell',
    pieces: [
      [pt(0, 1), pt(4, 2), pt(4, 3)],
      [pt(0, 1), pt(4, 3), pt(0, 2)],
    ],
    side: [pt(0, 1), pt(4, 2), pt(4, 3), pt(0, 2)],
    faces: 2,
  },
];

// ---------------------------------------------------------------------------------------------
// fringeFaces.

describe('P3.1p T02 fringeFaces', () => {
  for (const testCase of FRINGE_CASES)
    it(`matches the brute-force area decomposition: ${testCase.name}`, () => {
      const result = fringeFaces(cell4, testCase.pieces, [...corners4, ...testCase.side], 1);
      checkDecomposition(cell4, testCase.pieces, result, 1);
      if (result.status === 'OK') expect(result.faces).toBe(testCase.faces);
      // Negative region winding: reversed pieces, exterior in the negative winding.
      const reversed = testCase.pieces.map((ring) => [...ring].reverse());
      const negative = fringeFaces(cell4, reversed, [...corners4, ...testCase.side], -1);
      checkDecomposition(cell4, reversed, negative, -1);
    });

  it('a full cell has no exterior and an empty cell is two triangles', () => {
    const full = fringeFaces(
      cell4,
      [
        [pt(0, 0), pt(4, 0), pt(4, 4)],
        [pt(0, 0), pt(4, 4), pt(0, 4)],
      ],
      corners4,
    );
    expect(full).toEqual({ status: 'OK', exterior: [], faces: 0 });
    const empty = fringeFaces(cell4, [], corners4);
    expect(empty.status === 'OK' && empty.exterior.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Merged mesh fixtures.

type MergedCase = Readonly<{
  name: string;
  input: ProjectionInput;
  epoch: EpochCells;
}>;

/** Square [0, 12]² with a square hole [4, 8]² on grid lines (L = 2): boundary along grid lines. */
function squareWithHole(): ProjectionInput {
  const vertices: [number, number][] = [
    [0, 0],
    [12, 0],
    [12, 12],
    [0, 12],
    [4, 4],
    [8, 4],
    [8, 8],
    [4, 8],
  ];
  const indices: number[] = [];
  for (let k = 0; k < 4; k += 1) {
    const n = (k + 1) % 4;
    indices.push(k, n, 4 + n, k, 4 + n, 4 + k);
  }
  return makeInput(vertices, indices);
}

/** A jittered lattice, randomly triangulated, with random quads dropped (holes and pinches). */
function latticeMesh(seed: number, n: number): ProjectionInput {
  const random = mulberry32(seed);
  const jitter = () => (Math.floor(random() * 5) - 2) / 8;
  const vertices: [number, number][] = [];
  for (let b = 0; b < n; b += 1)
    for (let a = 0; a < n; a += 1) vertices.push([a * 1.5 - 2 + jitter(), b * 1.5 - 2 + jitter()]);
  const id = (a: number, b: number) => b * n + a;
  const indices: number[] = [];
  for (let b = 0; b + 1 < n; b += 1)
    for (let a = 0; a + 1 < n; a += 1) {
      if (random() < 0.3) continue;
      const [p, s, t, u] = [id(a, b), id(a + 1, b), id(a + 1, b + 1), id(a, b + 1)];
      if (random() < 0.5) indices.push(p, s, t, p, t, u);
      else indices.push(p, s, u, s, t, u);
    }
  return makeInput(vertices, indices);
}

const MERGED_CASES: readonly MergedCase[] = [
  {
    name: 'triangle across cells, all around',
    input: makeInput(
      [
        [1, 1],
        [13, 3],
        [2, 10],
      ],
      [0, 1, 2],
    ),
    epoch: { L: 2, candidates: block(-1, 4, -1, 3), rhoL: rational(1n, 2n) },
  },
  {
    name: 'triangle across cells, partial candidate set',
    input: makeInput(
      [
        [1, 1],
        [13, 3],
        [2, 10],
      ],
      [0, 1, 2],
    ),
    epoch: { L: 2, candidates: block(0, 1, 0, 1), rhoL: rational(1n, 2n) },
  },
  {
    name: 'negative winding triangle',
    input: makeInput(
      [
        [1, 1],
        [2, 10],
        [13, 3],
      ],
      [0, 1, 2],
    ),
    epoch: { L: 2, candidates: block(-1, 4, -1, 3), rhoL: rational(1n, 2n) },
  },
  {
    name: 'square with a hole on grid lines',
    input: squareWithHole(),
    epoch: { L: 2, candidates: block(-1, 3, -1, 3), rhoL: rational(1n, 4n) },
  },
  {
    name: 'square with a hole, interior candidates only',
    input: squareWithHole(),
    epoch: { L: 2, candidates: block(0, 2, 0, 2), rhoL: rational(1n, 4n) },
  },
  {
    name: 'vertex on the candidate set border and owner edges',
    input: makeInput(
      [
        [1, 1],
        [8, 2],
        [4, 6],
        [-3, 5],
      ],
      [0, 1, 2, 0, 2, 3],
    ),
    epoch: { L: 2, candidates: block(-1, 1, 0, 1), rhoL: rational(1n, 2n) },
  },
];

function seededCases(): MergedCase[] {
  const cases: MergedCase[] = [];
  for (let seed = 1; seed <= 6; seed += 1) {
    const input = latticeMesh(seed, 5);
    const full = { L: 1, candidates: block(-2, 3, -2, 3), rhoL: rational(1n, 4n) };
    cases.push({ name: `lattice seed ${seed}`, input, epoch: full });
    cases.push({
      name: `lattice seed ${seed}, partial`,
      input,
      epoch: { L: 1, candidates: block(-1, 1, -2, 2), rhoL: rational(1n, 4n) },
    });
  }
  return cases;
}

function built(testCase: MergedCase): MergedMesh {
  const result = buildMergedMesh(testCase.input, testCase.epoch);
  if (result.status !== 'OK') throw new Error(`${testCase.name}: ${JSON.stringify(result)}`);
  return result.mesh;
}

const sameQ = (a: Q2, b: Q2) => compare(a[0], b[0]) === 0 && compare(a[1], b[1]) === 0;

// ---------------------------------------------------------------------------------------------
// S4.

describe('P3.1p T02 S4 partition', () => {
  for (const testCase of MERGED_CASES)
    it(`passes on ${testCase.name}`, () => {
      const mesh = built(testCase);
      expect(checkMergedPartition(mesh)).toEqual({ ok: true });
      expect(mesh.triangles.length).toBeGreaterThan(0);
      expect(mesh.lists).toEqual([]);
    });

  it('passes on seeded random lattice meshes', () => {
    for (const testCase of seededCases()) {
      const mesh = built(testCase);
      expect(checkMergedPartition(mesh), testCase.name).toEqual({ ok: true });
    }
  });

  it('fails the right check on deliberately broken meshes', () => {
    const mesh = built(MERGED_CASES[0]!);
    const clone = (): MergedMesh => structuredClone(mesh);

    const flipped = clone();
    const t = flipped.triangles.findIndex((triangle) => triangle.role === 'exterior');
    const [a, b, c] = flipped.triangles[t]!.ids;
    flipped.triangles[t]!.ids = [a, c, b];
    expect(checkMergedPartition(flipped)).toEqual({ ok: false, check: `orientation:t${t}` });

    const removed = clone();
    removed.triangles.splice(
      removed.triangles.findIndex((triangle) => triangle.role === 'region'),
      1,
    );
    const removedResult = checkMergedPartition(removed);
    expect(removedResult.ok === false && removedResult.check.startsWith('edge-use:')).toBe(true);

    const duplicated = clone();
    const victim = duplicated.triangles[0]!.ids[0];
    duplicated.records.push({ ...duplicated.records[victim]! });
    duplicated.triangles[0]!.ids[0] = duplicated.records.length - 1;
    const duplicateResult = checkMergedPartition(duplicated);
    expect(duplicateResult).toEqual({
      ok: false,
      check: `duplicate-record:${victim}:${duplicated.records.length - 1}`,
    });

    const extraCell = clone();
    extraCell.cells.push({ i: 100n, j: 100n, m: pt(402, 402), region: false, fringe: true });
    expect(checkMergedPartition(extraCell)).toEqual({ ok: false, check: 'area' });
  });

  it('reports a T-junction across a seam', () => {
    // Cell (0,0) uses the whole side x = 4; cell (1,0) splits it at (4, 2).
    const records: MergedMesh['records'] = [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [8, 0],
      [8, 4],
      [4, 2],
    ].map(([x, y]) => ({
      pos: pt(x!, y!),
      v64: [x!, y!],
      owner: [BigInt(Math.floor(x! / 4)), BigInt(Math.floor(y! / 4))],
      kind: 0,
    }));
    const mesh: MergedMesh = {
      L: 2,
      cells: [
        { i: 0n, j: 0n, m: pt(2, 2), region: true, fringe: false },
        { i: 1n, j: 0n, m: pt(6, 2), region: true, fringe: false },
      ],
      records,
      carriers: [],
      triangles: [
        { ids: [0, 1, 2], role: 'region', cell: 0 },
        { ids: [0, 2, 3], role: 'region', cell: 0 },
        { ids: [1, 4, 6], role: 'region', cell: 1 },
        { ids: [6, 4, 5], role: 'region', cell: 1 },
        { ids: [6, 5, 2], role: 'region', cell: 1 },
      ],
      boundary: { edges: [], vertices: [] },
      lists: [],
    };
    expect(checkMergedPartition(mesh)).toEqual({ ok: false, check: 't-junction:6:1:2' });
  });
});

// ---------------------------------------------------------------------------------------------
// Records, owners, carriers, boundary.

function checkRecords(testCase: MergedCase, mesh: MergedMesh): void {
  const { input } = testCase;
  const L = mesh.L;
  const context = sourceContext(input);
  const side = pow2(L);
  // Identity: one record per exact position, every record referenced.
  const keys = new Set(mesh.records.map((record) => pointKey(record.pos)));
  expect(keys.size).toBe(mesh.records.length);
  const referenced = new Set(mesh.triangles.flatMap((triangle) => triangle.ids));
  expect(referenced.size).toBe(mesh.records.length);
  // Order: P5 under an independent re-classification.
  const reclassified = mesh.records.map((record) => classify(record.pos, L, context, true));
  reclassified.forEach((entry, id) => expect(entry.kind).toBe(mesh.records[id]!.kind));
  for (let id = 1; id < reclassified.length; id += 1)
    expect(compareRecords(reclassified[id - 1]!, reclassified[id]!)).toBeLessThan(0);
  for (const [id, record] of mesh.records.entries()) {
    // v64 = RN64(pos); originals are exact.
    if (record.kind === 0) {
      const source = reclassified[id]!.sourceIndex!;
      expect(record.v64).toEqual(input.mesh.vertices[source]);
    }
    // Owner: half-open floor on the exact position.
    const [i, j] = record.owner;
    const x0 = mul(rational(i), side);
    const y0 = mul(rational(j), side);
    expect(compare(record.pos[0], x0) >= 0 && compare(record.pos[0], add(x0, side)) < 0).toBe(true);
    expect(compare(record.pos[1], y0) >= 0 && compare(record.pos[1], add(y0, side)) < 0).toBe(true);
    // Kind 4: the owner is the cell whose lower-left corner it is.
    if (record.kind === 4) expect(sameQ(record.pos, [x0, y0])).toBe(true);
  }
  // Carriers: one per referenced owner, ordered (j, then i), centre exact.
  const owners = [
    ...new Set(mesh.records.map((record) => `${record.owner[0]},${record.owner[1]}`)),
  ];
  expect(mesh.carriers.length).toBe(owners.length);
  for (let k = 1; k < mesh.carriers.length; k += 1) {
    const [ia, ja] = mesh.carriers[k - 1]!.owner;
    const [ib, jb] = mesh.carriers[k]!.owner;
    expect(ja < jb || (ja === jb && ia < ib)).toBe(true);
  }
  for (const carrier of mesh.carriers) {
    const [i, j] = carrier.owner;
    expect(carrier.m).toEqual([(Number(i) + 0.5) * 2 ** L, (Number(j) + 0.5) * 2 ** L]);
  }
  // Boundary edges: used by exactly one region triangle, directed as in it.
  const directed = new Map<string, number>();
  for (const triangle of mesh.triangles)
    if (triangle.role === 'region')
      for (let k = 0; k < 3; k += 1) {
        const key = `${triangle.ids[k]}:${triangle.ids[(k + 1) % 3]}`;
        directed.set(key, (directed.get(key) ?? 0) + 1);
      }
  for (const [a, b] of mesh.boundary.edges) {
    expect(directed.get(`${a}:${b}`)).toBe(1);
    expect(directed.has(`${b}:${a}`)).toBe(false);
  }
  for (const vertex of mesh.boundary.vertices)
    for (const [out, into] of vertex.sectors) {
      expect(directed.get(`${vertex.id}:${out}`)).toBe(1);
      expect(directed.get(`${into}:${vertex.id}`)).toBe(1);
    }
}

describe('P3.1p T02 records, owners and carriers', () => {
  it('keeps record identity, P5 order, owners and carriers', () => {
    for (const testCase of [...MERGED_CASES, ...seededCases()])
      checkRecords(testCase, built(testCase));
  });

  it('applies the owner rule on upper and right edges and to kind-4 corners', () => {
    const testCase = MERGED_CASES[5]!;
    const mesh = built(testCase);
    const byPos = (x: number, y: number) =>
      mesh.records.find((record) => sameQ(record.pos, pt(x, y)));
    // (8, 2) lies on the right edge of the candidate set: owner (2, 0), outside the candidates.
    expect(byPos(8, 2)?.owner).toEqual([2n, 0n]);
    expect(mesh.carriers.some((carrier) => carrier.owner[0] === 2n)).toBe(true);
    expect(mesh.cells.some((cell) => cell.i === 2n)).toBe(false);
    // A grid crossing on x = 4 is owned by cell i = 1, one on x = 0 by i = 0.
    const onFour = mesh.records.filter((record) => compare(record.pos[0], r(4)) === 0);
    expect(onFour.length).toBeGreaterThan(0);
    for (const record of onFour) expect(record.owner[0]).toBe(1n);
    // Negative coordinates floor downwards.
    expect(byPos(-3, 5)?.owner).toEqual([-1n, 1n]);
    // Kind-4 corners exist and sit on their owner's lower-left corner.
    const kind4 = mesh.records.filter((record) => record.kind === 4);
    expect(kind4.length).toBeGreaterThan(0);
    for (const record of kind4)
      expect(
        sameQ(record.pos, [
          mul(rational(record.owner[0]), r(4)),
          mul(rational(record.owner[1]), r(4)),
        ]),
      ).toBe(true);
    expect(byPos(-4, 0)?.kind).toBe(4);
    expect(byPos(-4, 0)?.owner).toEqual([-1n, 0n]);
  });

  it('classifies an original vertex on a grid corner as kind 0 and corners on edges as kind 1', () => {
    const mesh = built(MERGED_CASES[3]!);
    const at = (x: number, y: number) => mesh.records.find((record) => sameQ(record.pos, pt(x, y)));
    expect(at(4, 4)?.kind).toBe(0);
    expect(at(0, 4)?.kind).toBe(1);
    expect(at(4, 0)?.kind).toBe(1);
    expect(mesh.records.filter((record) => record.kind === 0).length).toBe(8);
  });

  it('omits sectors only on the candidate set outer border', () => {
    const result = buildMergedMesh(MERGED_CASES[1]!.input, MERGED_CASES[1]!.epoch);
    expect(result.status).toBe('OK');
    if (result.status !== 'OK') return;
    expect(result.omittedVertices.length).toBeGreaterThan(0);
    const full = buildMergedMesh(MERGED_CASES[0]!.input, MERGED_CASES[0]!.epoch);
    expect(full.status === 'OK' && full.omittedVertices.length).toBe(0);
    if (full.status === 'OK')
      expect(full.mesh.boundary.vertices.length).toBe(full.mesh.boundary.edges.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Cell-geometry independence (E2).

describe('P3.1p T02 cell-geometry independence', () => {
  it('building a cell alone equals its part of the merged build', () => {
    for (const testCase of [...MERGED_CASES, ...seededCases().slice(0, 4)]) {
      const mesh = built(testCase);
      const pos = (id: number) => mesh.records[id]!.pos;
      const kindAt = new Map(mesh.records.map((record) => [pointKey(record.pos), record.kind]));
      mesh.cells.forEach((cell, index) => {
        const alone = buildCellGeometry(testCase.input, mesh.L, cell.i, cell.j);
        const fromMesh = (role: 'region' | 'exterior') =>
          mesh.triangles
            .filter((triangle) => triangle.cell === index && triangle.role === role)
            .map((triangle) => triangle.ids.map(pos));
        const region = fromMesh('region');
        expect(region.length).toBe(alone.region.length);
        alone.region.forEach((triangle, k) =>
          triangle.forEach((point, c) => expect(sameQ(point, region[k]![c]!)).toBe(true)),
        );
        expect(cell.region).toBe(alone.pieces.length > 0);
        for (const record of alone.regionRecords)
          expect(kindAt.get(pointKey(record.pos))).toBe(record.kind);
        if (!cell.fringe) {
          expect(fromMesh('exterior').length).toBe(0);
          return;
        }
        const fringe = buildCellFringe(alone, sourceContext(testCase.input));
        expect(fringe.status).toBe('OK');
        if (fringe.status !== 'OK') return;
        const exterior = fromMesh('exterior');
        expect(exterior.length).toBe(fringe.exterior.length);
        fringe.exterior.forEach((triangle, k) =>
          triangle.forEach((point, c) => expect(sameQ(point, exterior[k]![c]!)).toBe(true)),
        );
        for (const record of fringe.records)
          expect(kindAt.get(pointKey(record.pos))).toBe(record.kind);
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Trajectory cell sets.

describe('P3.1p T02 trajectory cell sets', () => {
  it('contain every drawn cell and only candidates', () => {
    for (const testCase of [...MERGED_CASES, ...seededCases()]) {
      const mesh = built(testCase);
      const { L, candidates, rhoL } = testCase.epoch;
      const set = trajectoryCells(testCase.input, L, candidates, rhoL);
      const candidateKeys = new Set(candidates.map(({ i, j }) => trajectoryCellKey(L, i, j)));
      for (const key of set) expect(candidateKeys.has(key)).toBe(true);
      for (const cell of mesh.cells)
        if (cell.region || cell.fringe)
          expect(set.has(trajectoryCellKey(L, cell.i, cell.j)), testCase.name).toBe(true);
    }
  });

  it('matches a hand count on a single triangle', () => {
    const input = makeInput(
      [
        [1, 1],
        [3, 1],
        [1, 3],
      ],
      [0, 1, 2],
    );
    // Bounding box [1, 3]² meets cells i, j ∈ {0} at L = 2; the 1/2-dilated edge boxes stay inside
    // [0.5, 3.5]², also cell (0, 0) only.
    const set = trajectoryCells(input, 2, block(-2, 2, -2, 2), rational(1n, 2n));
    expect([...set]).toEqual(['2,0,0']);
    // With reach 1 the dilated boxes touch x = 4 and y = 4 and x = 0, y = 0: cells −1..1.
    const wide = trajectoryCells(input, 2, block(-2, 2, -2, 2), rational(1n, 1n));
    expect(wide.size).toBe(9);
  });
});
