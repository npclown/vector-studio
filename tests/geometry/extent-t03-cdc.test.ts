import { describe, expect, it } from 'vitest';

import type { ProjectionInput } from './mesh-projection/model.js';

import {
  absolute,
  add,
  compare,
  mul,
  rational,
  sign,
  type Rational,
} from './rounded-fill/exact.js';
import { cross3, type Q2 } from './extent-t01/clip.js';
import { roundToBinary64 } from './extent-t01/tile-certificate.js';
import { pow2 } from './extent-t01/tile.js';
import { corpusRows } from './extent-t01/report.js';
import { candidateCells, epochOf, epochWindow, preimageQuad } from './extent-t02/epoch.js';
import { pointKey } from './extent-t02/fringe.js';
import {
  buildMergedMesh,
  cellKey,
  sourceContext,
  type EpochCells,
  type MergedMesh,
} from './extent-t02/merged.js';
import { checkMergedPartition } from './extent-t02/partition.js';
import { delaunayFlip, flipMergedExteriors, incircle, meshWinding } from './extent-t03/delaunay.js';
import { carrierCentre, ownedPoints, ownerCentre, ownerCentres } from './extent-t03/owner.js';

// ---------------------------------------------------------------------------------------------
// Helpers.

type T3 = readonly [number, number, number];

const P = (x: number, y: number, d = 1): Q2 => [
  rational(BigInt(x), BigInt(d)),
  rational(BigInt(y), BigInt(d)),
];

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

const orientOf = (points: readonly Q2[], t: T3) =>
  sign(cross3(points[t[0]]!, points[t[1]]!, points[t[2]]!));

function totalArea(points: readonly Q2[], tris: readonly T3[]): Rational {
  return tris.reduce(
    (sum, t) => add(sum, absolute(cross3(points[t[0]]!, points[t[1]]!, points[t[2]]!))),
    rational(0n),
  );
}

/** Directed edges used once, as position keys. */
function constraintEdges(points: readonly Q2[], tris: readonly T3[]): string[] {
  const counts = new Map<string, number>();
  for (const t of tris)
    for (let k = 0; k < 3; k += 1) {
      const a = t[k]!;
      const b = t[(k + 1) % 3]!;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const result: string[] = [];
  for (const t of tris)
    for (let k = 0; k < 3; k += 1) {
      const a = t[k]!;
      const b = t[(k + 1) % 3]!;
      if (counts.get(a < b ? `${a}:${b}` : `${b}:${a}`) === 1)
        result.push(`${pointKey(points[a]!)}>${pointKey(points[b]!)}`);
    }
  return result.sort();
}

/** Every interior edge (shared, opposite use) is locally Delaunay (incircle · winding ≤ 0). */
function locallyDelaunay(points: readonly Q2[], tris: readonly T3[], winding: 1 | -1): boolean {
  const forward = new Map<string, number>();
  tris.forEach((t, slot) => {
    for (let k = 0; k < 3; k += 1) forward.set(`${t[k]}:${t[(k + 1) % 3]}`, slot);
  });
  for (const t of tris)
    for (let k = 0; k < 3; k += 1) {
      const p = t[k]!;
      const q2 = t[(k + 1) % 3]!;
      const c = t[(k + 2) % 3]!;
      const other = forward.get(`${q2}:${p}`);
      if (other === undefined) continue;
      const d = tris[other]!.find((v) => v !== p && v !== q2)!;
      if (incircle(points[p]!, points[q2]!, points[c]!, points[d]!) * winding > 0) return false;
    }
  return true;
}

const triangleKey = (points: readonly Q2[], t: T3) => t.map((v) => pointKey(points[v]!)).join('|');

/** Unordered (rotation- and mirror-insensitive) triangle set by positions. */
const triangleSet = (points: readonly Q2[], tris: readonly T3[]) =>
  tris
    .map((t) =>
      t
        .map((v) => pointKey(points[v]!))
        .sort()
        .join('|'),
    )
    .sort();

/** Random star polygon (integer points around an interior centre) triangulated by a fan. */
function randomFan(seed: number, n: number): { points: Q2[]; tris: T3[] } | null {
  const random = mulberry32(seed);
  const angles = Array.from({ length: n }, () => random() * 2 * Math.PI).sort((a, b) => a - b);
  const raw = angles.map((angle) => {
    const radius = 20 + random() * 80;
    return [Math.round(radius * Math.cos(angle)), Math.round(radius * Math.sin(angle))] as const;
  });
  const keys = new Set<string>();
  const ring: Q2[] = [];
  for (const [x, y] of raw) {
    if (keys.has(`${x},${y}`)) continue;
    keys.add(`${x},${y}`);
    ring.push(P(x, y, 4));
  }
  const centre = P(0, 0);
  const points = [centre, ...ring];
  const tris: T3[] = [];
  for (let k = 1; k <= ring.length; k += 1) {
    const t: T3 = [0, k, (k % ring.length) + 1];
    if (orientOf(points, t) !== 1) return null;
    tris.push(t);
  }
  return { points, tris };
}

function permute(seed: number, length: number): number[] {
  const random = mulberry32(seed);
  const order = Array.from({ length }, (_, k) => k);
  for (let k = length - 1; k > 0; k -= 1) {
    const r = Math.floor(random() * (k + 1));
    [order[k], order[r]] = [order[r]!, order[k]!];
  }
  return order;
}

/** Renumber: point k moves to index perm[k]. */
function renumber(points: readonly Q2[], tris: readonly T3[], perm: readonly number[]) {
  const moved: Q2[] = new Array<Q2>(points.length);
  points.forEach((point, k) => {
    moved[perm[k]!] = point;
  });
  return { points: moved, tris: tris.map((t) => t.map((v) => perm[v]!) as unknown as T3) };
}

// ---------------------------------------------------------------------------------------------
// delaunayFlip.

describe('delaunayFlip (D-C)', () => {
  const fans = Array.from({ length: 60 }, (_, seed) =>
    randomFan(1000 + seed, 8 + (seed % 17)),
  ).filter((fan) => fan !== null);

  it('produces a constrained Delaunay triangulation, preserving area, winding and constraints', () => {
    expect(fans.length).toBeGreaterThan(30);
    let flipped = 0;
    for (const { points, tris } of fans) {
      const result = delaunayFlip(points, tris, 1);
      expect(result.length).toBe(tris.length);
      for (const t of result) expect(orientOf(points, t)).toBe(1);
      expect(compare(totalArea(points, result), totalArea(points, tris))).toBe(0);
      expect(constraintEdges(points, result)).toEqual(constraintEdges(points, tris));
      expect(locallyDelaunay(points, result, 1)).toBe(true);
      // Idempotent: a Delaunay result has no flippable edge left.
      expect(delaunayFlip(points, result, 1)).toEqual(result);
      if (result.some((t, k) => triangleKey(points, t) !== triangleKey(points, tris[k]!)))
        flipped += 1;
    }
    expect(flipped).toBeGreaterThan(fans.length / 2);
  });

  it('keeps a negative winding (mirror image gives the mirrored triangulation)', () => {
    for (const { points, tris } of fans.slice(0, 20)) {
      const mirrored = points.map(([x, y]): Q2 => [rational(-x.n, x.d), y]);
      const result = delaunayFlip(mirrored, tris, -1);
      for (const t of result) expect(orientOf(mirrored, t)).toBe(-1);
      expect(compare(totalArea(mirrored, result), totalArea(mirrored, tris))).toBe(0);
      expect(constraintEdges(mirrored, result)).toEqual(constraintEdges(mirrored, tris));
      expect(locallyDelaunay(mirrored, result, -1)).toBe(true);
      // Generic integer sets: the constrained Delaunay triangulation is unique, so it mirrors.
      const positive = delaunayFlip(points, tris, 1);
      // Same indices on mirrored positions: compare as unordered position sets of the originals.
      expect(triangleSet(points, result)).toEqual(triangleSet(points, positive));
    }
  });

  it('is invariant under renumbering of point indices', () => {
    for (const [index, { points, tris }] of fans.slice(0, 25).entries()) {
      const reference = delaunayFlip(points, tris, 1).map((t) => triangleKey(points, t));
      for (let trial = 0; trial < 3; trial += 1) {
        const perm = permute(index * 7 + trial, points.length);
        const moved = renumber(points, tris, perm);
        const result = delaunayFlip(moved.points, moved.tris, 1);
        expect(result.map((t) => triangleKey(moved.points, t))).toEqual(reference);
      }
    }
  });

  it('is deterministic on cocircular grids and circles', () => {
    // 4 × 4 grid, every square split by the same diagonal: every quad is cocircular, no flip.
    const grid: Q2[] = [];
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) grid.push(P(x, y));
    const id = (x: number, y: number) => 4 * y + x;
    const gridTris: T3[] = [];
    for (let y = 0; y < 3; y += 1)
      for (let x = 0; x < 3; x += 1) {
        gridTris.push([id(x, y), id(x + 1, y), id(x + 1, y + 1)]);
        gridTris.push([id(x, y), id(x + 1, y + 1), id(x, y + 1)]);
      }
    expect(delaunayFlip(grid, gridTris, 1)).toEqual(gridTris);

    // Twelve rational points on x² + y² = 25 plus one interior point; the result must not depend
    // on the numbering.
    const circle: [number, number][] = [
      [5, 0],
      [4, 3],
      [3, 4],
      [0, 5],
      [-3, 4],
      [-4, 3],
      [-5, 0],
      [-4, -3],
      [-3, -4],
      [0, -5],
      [3, -4],
      [4, -3],
    ];
    // Fan of the convex 12-gon from (5, 0) (all cocircular), with the triangle (p0, p5, p6) split
    // at an interior point: flips meet cocircular ties among the circle points.
    const points = [P(-4, 3, 3), ...circle.map(([x, y]) => P(x, y))];
    const tris: T3[] = [];
    for (let k = 2; k <= 11; k += 1)
      if (k === 6) tris.push([1, 6, 0], [6, 7, 0], [7, 1, 0]);
      else tris.push([1, k, k + 1]);
    for (const t of tris) expect(orientOf(points, t)).toBe(1);
    const reference = delaunayFlip(points, tris, 1);
    expect(locallyDelaunay(points, reference, 1)).toBe(true);
    const keys = reference.map((t) => triangleKey(points, t));
    expect(keys).not.toEqual(tris.map((t) => triangleKey(points, t)));
    for (let trial = 0; trial < 8; trial += 1) {
      const moved = renumber(points, tris, permute(50 + trial, points.length));
      const result = delaunayFlip(moved.points, moved.tris, 1);
      expect(result.map((t) => triangleKey(moved.points, t))).toEqual(keys);
    }
  });

  it('throws on an edge not used in opposite directions', () => {
    const points = [P(0, 0), P(4, 0), P(2, 3), P(2, -3), P(2, 5)];
    expect(() =>
      delaunayFlip(
        points,
        [
          [0, 1, 2],
          [0, 1, 3],
        ],
        1,
      ),
    ).toThrow('delaunay:opposite-use');
    expect(() =>
      delaunayFlip(
        points,
        [
          [0, 1, 2],
          [1, 0, 3],
          [0, 1, 4],
        ],
        1,
      ),
    ).toThrow('delaunay:opposite-use');
    // A single pair in opposite directions is fine (and flips: the quad is a thin rhombus).
    const ok = delaunayFlip(
      [P(0, 0), P(8, 0), P(4, 1), P(4, -1)],
      [
        [0, 1, 2],
        [1, 0, 3],
      ],
      1,
    );
    expect(ok).toEqual([
      [0, 3, 2],
      [1, 2, 3],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Real merged meshes (C corpus rows).

type Built = { input: ProjectionInput; epoch: EpochCells; mesh: MergedMesh };

const ROW_IDS = [
  'carrier/W/mixed/bowtie:nonzero/S6',
  'carrier/W/mixed/bowtie:evenodd/S8',
  'carrier/Y/triangle-free/star:nonzero/S8',
  'carrier/Y/triangle-free/star:nonzero/S3',
];

function buildRows(): Built[] {
  const rows = corpusRows('C').filter((row) => ROW_IDS.includes(row.id));
  expect(rows.length).toBe(ROW_IDS.length);
  return rows.map((row) => {
    const epoch = epochOf(row.input)!;
    const candidates = candidateCells(preimageQuad(row.input.affine, epochWindow(epoch)), epoch.L);
    if (candidates.status !== 'OK') throw new Error('candidates');
    const cells: EpochCells = {
      L: epoch.L,
      candidates: candidates.cells.map(([i, j]) => ({ i, j })),
      rhoL: epoch.rhoL,
    };
    const built = buildMergedMesh(row.input, cells);
    if (built.status !== 'OK') throw new Error(`build ${built.status}`);
    return { input: row.input, epoch: cells, mesh: built.mesh };
  });
}

/** A candidate subset: the cell plus the given neighbour offsets that are candidates. */
function subset(epoch: EpochCells, i: bigint, j: bigint, reach: 0 | 1): EpochCells {
  const keep = epoch.candidates.filter(
    (cell) =>
      cell.i >= i - BigInt(reach) &&
      cell.i <= i + BigInt(reach) &&
      cell.j >= j - BigInt(reach) &&
      cell.j <= j + BigInt(reach),
  );
  return { ...epoch, candidates: keep };
}

function exteriorOf(mesh: MergedMesh, i: bigint, j: bigint): string[] | null {
  const index = mesh.cells.findIndex((cell) => cell.i === i && cell.j === j);
  if (index < 0 || !mesh.cells[index]!.fringe) return null;
  const points = mesh.records.map((record) => record.pos);
  return mesh.triangles
    .filter((t) => t.cell === index && t.role === 'exterior')
    .map((t) => triangleKey(points, t.ids));
}

describe('flipMergedExteriors (D-C on merged meshes)', () => {
  it('passes the merged partition check and keeps region triangles and records', () => {
    let changed = 0;
    for (const { input, mesh } of buildRows()) {
      expect(checkMergedPartition(mesh)).toEqual({ ok: true });
      expect(meshWinding(mesh)).toBe(sourceContext(input).winding);
      const flipped = flipMergedExteriors(input, mesh);
      expect(checkMergedPartition(flipped)).toEqual({ ok: true });
      expect(flipped.records).toBe(mesh.records);
      expect(flipped.triangles.length).toBe(mesh.triangles.length);
      mesh.triangles.forEach((t, slot) => {
        const after = flipped.triangles[slot]!;
        expect(after.role).toBe(t.role);
        expect(after.cell).toBe(t.cell);
        if (t.role === 'region') expect(after.ids).toEqual(t.ids);
        else if (after.ids.join() !== t.ids.join()) changed += 1;
      });
      const points = mesh.records.map((record) => record.pos);
      const byCell = new Map<number, T3[]>();
      for (const t of flipped.triangles)
        if (t.role === 'exterior') byCell.set(t.cell, [...(byCell.get(t.cell) ?? []), t.ids]);
      for (const tris of byCell.values())
        expect(locallyDelaunay(points, tris, meshWinding(mesh))).toBe(true);
    }
    expect(changed).toBeGreaterThan(0);
  });

  it('flips a cell identically under different neighbour materialization', () => {
    let compared = 0;
    for (const { input, epoch, mesh } of buildRows()) {
      const full = flipMergedExteriors(input, mesh);
      const fringeCells = mesh.cells.filter((cell) => cell.fringe).slice(0, 12);
      for (const { i, j } of fringeCells) {
        const reference = exteriorOf(full, i, j)!;
        for (const reach of [1, 0] as const) {
          const built = buildMergedMesh(input, subset(epoch, i, j, reach));
          if (built.status !== 'OK') continue;
          // Different candidate sets renumber the records; flips must not depend on that.
          const other = exteriorOf(flipMergedExteriors(input, built.mesh), i, j);
          if (other === null) continue;
          expect(other).toEqual(reference);
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------------------------
// D-D owned set and carrier centre.

function makeInput(
  vertices: readonly (readonly [number, number])[],
  indices: readonly number[],
): ProjectionInput {
  return {
    id: 'extent-t03-cdc-host',
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

const keysOf = (points: readonly Q2[]) => points.map(pointKey);

describe('ownedPoints and carrierCentre (D-D)', () => {
  // One large CCW triangle at level 2 (side 4).
  const big = sourceContext(
    makeInput(
      [
        [-2, -2],
        [6, -2],
        [-2, 6],
      ],
      [0, 1, 2],
    ),
  );

  it('owns points on the lower and left lines, not on the upper and right ones', () => {
    // Cell (0, 0): the hypotenuse x + y = 4 meets its right side at (4, 0) and its upper side at
    // (0, 4); both belong to the neighbours. Its corner (0, 0) is strictly inside (kind 3).
    expect(keysOf(ownedPoints(big, 2, 0n, 0n))).toEqual(keysOf([P(0, 0)]));
    expect(keysOf(ownedPoints(big, 2, 1n, 0n))).toEqual(keysOf([P(4, 0)]));
    expect(keysOf(ownedPoints(big, 2, 0n, 1n))).toEqual(keysOf([P(0, 4)]));
    // Cell (0, -1): the bottom edge crosses its left line at (0, -2).
    expect(keysOf(ownedPoints(big, 2, 0n, -1n))).toEqual(keysOf([P(0, -2)]));
    // Cell (1, -1): a source vertex and a left-line crossing; the hypotenuse leaves through (4, 0),
    // which is on its upper side.
    expect(keysOf(ownedPoints(big, 2, 1n, -1n))).toEqual(keysOf([P(4, -2), P(6, -2)]));
    expect(ownerCentre(big, 2, 1n, -1n)).toEqual([5, -2]);
    expect(ownerCentre(big, 2, 0n, 0n)).toEqual([0, 0]);
  });

  it('includes a lower-left corner only when it is strictly inside a source triangle', () => {
    // Cell (-1, -1) has corner (-4, -4) outside, but its upper-right region is inside.
    expect(ownedPoints(big, 2, -1n, -1n).some((p) => pointKey(p) === pointKey(P(-4, -4)))).toBe(
      false,
    );
    // Cell (1, 1) = [4, 8)²: corner (4, 4) is outside (kind 4); nothing owned, centre = corner.
    expect(ownedPoints(big, 2, 1n, 1n)).toEqual([]);
    expect(ownerCentre(big, 2, 1n, 1n)).toEqual([4, 4]);
    // Kind 3 at level 0.
    expect(keysOf(ownedPoints(big, 0, 0n, 0n))).toEqual(keysOf([P(0, 0)]));
    expect(keysOf(ownedPoints(big, 0, 1n, 1n))).toEqual(keysOf([P(1, 1)]));
  });

  it('uses the corner for an empty cell and the binary64 midpoint otherwise', () => {
    expect(ownerCentre(big, 2, 5n, 5n)).toEqual([20, 20]);
    expect(ownedPoints(big, -3, -100n, 2n)).toEqual([]);
    expect(ownerCentre(big, -3, -100n, 2n)).toEqual([-12.5, 0.25]);
    // A kind-3 corner alone also gives the corner.
    expect(ownerCentre(big, -3, -9n, 2n)).toEqual([-9 / 8, 2 / 8]);
    // An edge along the lower line contributes its overlap ends inside [x0, x1).
    const along = sourceContext(
      makeInput(
        [
          [-1, 0],
          [9, 0],
          [4, 6],
        ],
        [0, 1, 2],
      ),
    );
    expect(keysOf(ownedPoints(along, 2, 0n, 0n))).toEqual(keysOf([P(0, 0), P(0, 6, 5)]));
    expect(ownerCentre(along, 2, 0n, 0n)).toEqual([0, roundToBinary64(rational(6n, 5n)) * 0.5]);
    expect(keysOf(ownedPoints(along, 2, 1n, 0n))).toEqual(keysOf([P(4, 0)]));
    expect(keysOf(ownedPoints(along, 2, 2n, 0n))).toEqual(
      keysOf([P(8, 0), [rational(8n), rational(6n, 5n)], P(9, 0)]),
    );
    expect(ownerCentre(along, 2, 2n, 0n)).toEqual([8.5, roundToBinary64(rational(6n, 5n)) * 0.5]);
    // carrierCentre rounds each coordinate before halving.
    const thirds: Q2[] = [P(1, 1, 3), P(2, 5, 3)];
    expect(carrierCentre(thirds, 2, 0n, 0n)).toEqual([
      roundToBinary64(rational(1n, 3n)) * 0.5 + roundToBinary64(rational(2n, 3n)) * 0.5,
      roundToBinary64(rational(1n, 3n)) * 0.5 + roundToBinary64(rational(5n, 3n)) * 0.5,
    ]);
  });

  it('is cell-local on merged builds, including non-drawn owner cells', () => {
    let nonDrawn = 0;
    let checked = 0;
    for (const { input, epoch, mesh } of buildRows()) {
      const context = sourceContext(input);
      const fringeCells = mesh.cells.filter((cell) => cell.fringe).slice(0, 6);
      const builds: MergedMesh[] = [mesh];
      for (const { i, j } of fringeCells)
        for (const reach of [1, 0] as const) {
          const built = buildMergedMesh(input, subset(epoch, i, j, reach));
          if (built.status === 'OK') builds.push(built.mesh);
        }
      const seen = new Map<string, [number, number]>();
      for (const build of builds) {
        const centres = ownerCentres(input, build, context);
        const drawn = new Set(
          build.cells
            .filter((cell) => cell.region || cell.fringe)
            .map((cell) => cellKey(cell.i, cell.j)),
        );
        const owned = new Map<string, Set<string>>();
        for (const record of build.records) {
          const key = cellKey(...record.owner);
          expect(centres.has(key)).toBe(true);
          if (!owned.has(key))
            owned.set(key, new Set(keysOf(ownedPoints(context, build.L, ...record.owner))));
          // Every owned record is in the geometric owned set, except a kind-4 lower-left corner.
          const corner = pointKey([
            mul(rational(record.owner[0]), pow2(build.L)),
            mul(rational(record.owner[1]), pow2(build.L)),
          ]);
          const inSet = owned.get(key)!.has(pointKey(record.pos));
          expect(inSet || (record.kind === 4 && pointKey(record.pos) === corner)).toBe(true);
        }
        for (const [key, centre] of centres) {
          const [i, j] = key.split(',').map(BigInt) as [bigint, bigint];
          expect(centre).toEqual(ownerCentre(context, build.L, i, j));
          const previous = seen.get(key);
          if (previous !== undefined) expect(centre).toEqual(previous);
          seen.set(key, centre);
          if (!drawn.has(key)) nonDrawn += 1;
          checked += 1;
        }
      }
    }
    expect(nonDrawn).toBeGreaterThan(0);
    expect(checked).toBeGreaterThan(100);
  });
});
