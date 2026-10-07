import type { ProjectionInput } from '../mesh-projection/model.js';
import { q } from '../position-certificate/certificate.js';
import {
  absolute,
  add,
  compare,
  div,
  mul,
  rational,
  sign,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';
import { cross3, earClip, exactClip, type Cell, type Q2 } from './clip.js';

/**
 * P3.1p T01 K1 local fixed-grid tiling (docs/plans/p3-t01-extent-experiment-contract.md, K1:
 * "Level", "Cells", "Clipping", "Ear rule", "Identity and indexing"). Test-only and exact.
 */

export const TILE_CAP = 4096;
export const LEVEL_MIN = -1074;

export type SteinerKind = 0 | 1 | 2 | 3;

export type TileCell = Readonly<{
  L: number;
  /** Cell indices are bigint: far cells can exceed 2^53. */
  i: bigint;
  j: bigint;
  /** Binary64 cell centre, asserted exact. */
  m: readonly [number, number];
  /** Exact local points: originals ascending by source index, then Steiner kinds 1, 2, 3. */
  points: readonly Q2[];
  /** Original mesh vertex index, or null for a Steiner point. */
  sourceIndex: readonly (number | null)[];
  steinerKind: readonly SteinerKind[];
  /** Tile-local triangles, by source triangle then ear order, in the source winding. */
  indices: readonly (readonly [number, number, number])[];
}>;

export type TileStatus = 'OK' | 'TILE_CAP_EXCEEDED' | 'LEVEL_NONE';

export type TileResult = Readonly<{
  status: TileStatus;
  L: number | null;
  /** Cells meeting the exact local preimage bbox of the window (0 for LEVEL_NONE). */
  materializedCells: number;
  /** Tiles: materialized cells with at least one positive-area piece, row-major by (j, i). */
  cells: readonly TileCell[];
}>;

export type PxWindow = Readonly<{ x0: Rational; y0: Rational; x1: Rational; y1: Rational }>;

type LevelInput = Pick<ProjectionInput, 'affine' | 'zoom' | 'dpr'>;

const f = Math.fround;

export function pow2(exponent: number): Rational {
  return exponent >= 0 ? rational(1n << BigInt(exponent)) : rational(1n, 1n << BigInt(-exponent));
}

/** ‖A‖∞ · z · q from the f32 lanes, with z = q(fround(zoom)) and q = q(fround(dpr)). */
export function levelScale(input: LevelInput): Rational {
  const [a, b, c, d] = input.affine.slice(0, 4).map((value) => absolute(q(f(value)))) as [
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const row0 = add(a, c);
  const row1 = add(b, d);
  const norm = compare(row0, row1) >= 0 ? row0 : row1;
  return mul(mul(norm, q(f(input.zoom))), q(f(input.dpr)));
}

/** Exact cell side in physical px at level L: 2^L · ‖A‖∞ · z · q. */
export function sidePx(input: LevelInput, L: number): Rational {
  return mul(pow2(L), levelScale(input));
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/**
 * Largest integer L with 2^L · ‖A‖∞ · z · q ≤ T, evaluated exactly; null when no L ≥ −1074
 * qualifies, or when the scale is 0 (no largest L exists).
 */
export function levelFor(input: LevelInput, T: number): number | null {
  const scale = levelScale(input);
  if (sign(scale) <= 0) return null;
  const ratio = div(q(T), scale);
  if (sign(ratio) <= 0) return null;
  let L = bitLength(ratio.n) - bitLength(ratio.d);
  while (compare(pow2(L), ratio) > 0) L -= 1;
  while (compare(pow2(L + 1), ratio) <= 0) L += 1;
  return L < LEVEL_MIN ? null : L;
}

function floorBig(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return quotient * denominator !== numerator && numerator < 0n !== denominator < 0n
    ? quotient - 1n
    : quotient;
}

/** floor(value / 2^L). */
function cellIndex(value: Rational, L: number): bigint {
  return L >= 0
    ? floorBig(value.n, value.d << BigInt(L))
    : floorBig(value.n << BigInt(-L), value.d);
}

function gridValue(index: bigint, L: number): Rational {
  return mul(rational(index), pow2(L));
}

export function cellOf(L: number, i: bigint, j: bigint): Cell {
  return {
    x0: gridValue(i, L),
    x1: gridValue(i + 1n, L),
    y0: gridValue(j, L),
    y1: gridValue(j + 1n, L),
  };
}

function onGridLine(value: Rational, L: number): boolean {
  const scaled = mul(value, pow2(-L));
  return scaled.d === 1n;
}

/** Binary64 cell centre (i + 1/2)·2^L; throws if it is not exact in binary64. */
export function cellCentre(L: number, i: bigint, j: bigint): readonly [number, number] {
  const convert = (index: bigint): number => {
    const exact = mul(rational(2n * index + 1n), pow2(L - 1));
    const value = Number(2n * index + 1n) * 2 ** (L - 1);
    if (!Number.isFinite(value) || compare(q(value), exact) !== 0)
      throw new Error(`cell centre not exact in binary64 at tile(${L},${i},${j})`);
    return value;
  };
  return [convert(i), convert(j)];
}

function keyOf(point: Q2): string {
  return `${point[0].n}/${point[0].d},${point[1].n}/${point[1].d}`;
}

function onSegment(point: Q2, a: Q2, b: Q2): boolean {
  if (sign(cross3(a, b, point)) !== 0) return false;
  const within = (value: Rational, s: Rational, t: Rational) =>
    compare(value, compare(s, t) <= 0 ? s : t) >= 0 &&
    compare(value, compare(s, t) <= 0 ? t : s) <= 0;
  return within(point[0], a[0], b[0]) && within(point[1], a[1], b[1]);
}

function strictlyInside(point: Q2, triangle: readonly [Q2, Q2, Q2]): boolean {
  const s0 = sign(cross3(triangle[0], triangle[1], point));
  const s1 = sign(cross3(triangle[1], triangle[2], point));
  const s2 = sign(cross3(triangle[2], triangle[0], point));
  return s0 !== 0 && s0 === s1 && s1 === s2;
}

/** Exact local preimage of a physical-px point under the reference map R (original inputs). */
export function preimage(input: ProjectionInput, point: Q2): Q2 {
  const [a, b, c, d, e, g] = input.affine.map(q) as [
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const det = sub(mul(a, d), mul(b, c));
  if (sign(det) === 0) throw new Error('preimage: singular affine');
  const scale = mul(q(input.zoom), q(input.dpr));
  const rx = sub(add(div(point[0], scale), q(input.camera[0])), e);
  const ry = sub(add(div(point[1], scale), q(input.camera[1])), g);
  return [div(sub(mul(d, rx), mul(c, ry)), det), div(sub(mul(a, ry), mul(b, rx)), det)];
}

type Piece = Readonly<{ triangle: number; ring: readonly Q2[] }>;

type Edge = readonly [number, number];

type Classified = {
  point: Q2;
  sourceIndex: number | null;
  kind: SteinerKind;
  edge: Edge | null;
};

function compareEdge(left: Edge, right: Edge): number {
  return left[0] - right[0] || left[1] - right[1];
}

function lowestEdge(
  point: Q2,
  triangles: readonly (readonly [Q2, Q2, Q2])[],
  corners: readonly (readonly [number, number, number])[],
): Edge | null {
  let best: Edge | null = null;
  triangles.forEach((triangle, index) => {
    const ids = corners[index]!;
    for (let side = 0; side < 3; side += 1) {
      const u = (side + 1) % 3;
      if (!onSegment(point, triangle[side]!, triangle[u]!)) continue;
      const edge: Edge = ids[side]! < ids[u]! ? [ids[side]!, ids[u]!] : [ids[u]!, ids[side]!];
      if (best === null || compareEdge(edge, best) < 0) best = edge;
    }
  });
  return best;
}

function buildTile(
  input: ProjectionInput,
  L: number,
  i: bigint,
  j: bigint,
  pieces: readonly Piece[],
  locals: readonly Q2[],
  originalAt: ReadonlyMap<string, number>,
): TileCell {
  const indices = input.mesh.indices;
  const sources = [...new Set(pieces.map((piece) => piece.triangle))];
  const corners = sources.map(
    (t) => [indices[3 * t]!, indices[3 * t + 1]!, indices[3 * t + 2]!] as const,
  );
  const triangles = corners.map((ids) => ids.map((id) => locals[id]!) as unknown as [Q2, Q2, Q2]);

  const unique = new Map<string, Q2>();
  for (const piece of pieces) for (const point of piece.ring) unique.set(keyOf(point), point);

  const classified: Classified[] = [];
  for (const [key, point] of unique) {
    const original = originalAt.get(key);
    if (original !== undefined) {
      classified.push({ point, sourceIndex: original, kind: 0, edge: null });
      continue;
    }
    const onX = onGridLine(point[0], L);
    const onY = onGridLine(point[1], L);
    const edge = lowestEdge(point, triangles, corners);
    let kind: SteinerKind;
    if (edge !== null && onX) kind = 1;
    else if (edge !== null && onY) kind = 2;
    else if (edge === null && onX && onY && triangles.some((tri) => strictlyInside(point, tri)))
      kind = 3;
    else throw new Error(`unclassifiable tile vertex ${key} in tile(${L},${i},${j})`);
    classified.push({ point, sourceIndex: null, kind, edge });
  }

  classified.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind - right.kind;
    switch (left.kind) {
      case 0:
        return left.sourceIndex! - right.sourceIndex!;
      case 1:
        return (
          compare(left.point[0], right.point[0]) ||
          compareEdge(left.edge!, right.edge!) ||
          compare(left.point[1], right.point[1])
        );
      case 2:
        return (
          compare(left.point[1], right.point[1]) ||
          compareEdge(left.edge!, right.edge!) ||
          compare(left.point[0], right.point[0])
        );
      default:
        return compare(left.point[0], right.point[0]) || compare(left.point[1], right.point[1]);
    }
  });

  const indexOf = new Map(classified.map((entry, index) => [keyOf(entry.point), index]));
  const tileIndices: [number, number, number][] = [];
  for (const piece of pieces) {
    const local = piece.ring.map((point) => indexOf.get(keyOf(point))!);
    for (const [a, b, c] of earClip(piece.ring))
      tileIndices.push([local[a]!, local[b]!, local[c]!]);
  }
  return {
    L,
    i,
    j,
    m: cellCentre(L, i, j),
    points: classified.map((entry) => entry.point),
    sourceIndex: classified.map((entry) => entry.sourceIndex),
    steinerKind: classified.map((entry) => entry.kind),
    indices: tileIndices,
  };
}

/**
 * K1 tiling of one row at tile target T over a physical-px window (the U1 window).
 * Materializes every cell meeting the exact local preimage bbox of the window, clips each region
 * triangle exactly per cell, ear-clips each piece and merges vertices within the tile exactly.
 */
export function tileRow(input: ProjectionInput, T: number, window: PxWindow): TileResult {
  const L = levelFor(input, T);
  if (L === null) return { status: 'LEVEL_NONE', L: null, materializedCells: 0, cells: [] };

  const corners = [
    preimage(input, [window.x0, window.y0]),
    preimage(input, [window.x1, window.y0]),
    preimage(input, [window.x0, window.y1]),
    preimage(input, [window.x1, window.y1]),
  ];
  const extreme = (axis: 0 | 1, direction: 1 | -1) =>
    corners
      .map((point) => point[axis])
      .reduce((best, value) => (compare(value, best) * direction > 0 ? value : best));
  const i0 = cellIndex(extreme(0, -1), L);
  const i1 = cellIndex(extreme(0, 1), L);
  const j0 = cellIndex(extreme(1, -1), L);
  const j1 = cellIndex(extreme(1, 1), L);
  const count = (i1 - i0 + 1n) * (j1 - j0 + 1n);
  if (count > BigInt(TILE_CAP))
    return { status: 'TILE_CAP_EXCEEDED', L, materializedCells: Number(count), cells: [] };

  const locals: Q2[] = input.mesh.vertices.map(([x, y]) => [q(x), q(y)] as const);
  const originalAt = new Map<string, number>();
  for (const index of [...new Set(input.mesh.indices)].sort((a, b) => a - b)) {
    const key = keyOf(locals[index]!);
    if (!originalAt.has(key)) originalAt.set(key, index);
  }

  const pieces = new Map<string, Piece[]>();
  const indices = input.mesh.indices;
  for (let t = 0; 3 * t < indices.length; t += 1) {
    const triangle = [
      locals[indices[3 * t]!]!,
      locals[indices[3 * t + 1]!]!,
      locals[indices[3 * t + 2]!]!,
    ] as const;
    if (sign(cross3(...triangle)) === 0) continue;
    const span = (axis: 0 | 1, low: bigint, high: bigint) => {
      const values = triangle.map((point) => point[axis]);
      const min = values.reduce((best, value) => (compare(value, best) < 0 ? value : best));
      const max = values.reduce((best, value) => (compare(value, best) > 0 ? value : best));
      const from = cellIndex(min, L);
      const to = cellIndex(max, L);
      return [from > low ? from : low, to < high ? to : high] as const;
    };
    const [ia, ib] = span(0, i0, i1);
    const [ja, jb] = span(1, j0, j1);
    for (let j = ja; j <= jb; j += 1n)
      for (let i = ia; i <= ib; i += 1n) {
        const ring = exactClip(triangle, cellOf(L, i, j));
        if (ring.length === 0) continue;
        const key = `${j},${i}`;
        const list = pieces.get(key) ?? [];
        list.push({ triangle: t, ring });
        pieces.set(key, list);
      }
  }

  const keys = [...pieces.keys()]
    .map((key) => key.split(',').map(BigInt) as [bigint, bigint])
    .sort(([ja, ia], [jb, ib]) =>
      ja !== jb ? (ja < jb ? -1 : 1) : ia < ib ? -1 : ia > ib ? 1 : 0,
    );
  const cells = keys.map(([j, i]) =>
    buildTile(input, L, i, j, pieces.get(`${j},${i}`)!, locals, originalAt),
  );
  return { status: 'OK', L, materializedCells: Number(count), cells };
}

/** True when no tile vertex lies strictly inside an edge of a triangle of the same tile. */
export function tJunctionFree(cell: TileCell): boolean {
  for (const [a, b, c] of cell.indices) {
    for (const [u, w] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const pu = cell.points[u]!;
      const pw = cell.points[w]!;
      for (let index = 0; index < cell.points.length; index += 1) {
        if (index === u || index === w) continue;
        if (onSegment(cell.points[index]!, pu, pw)) return false;
      }
    }
  }
  return true;
}

function closedInside(point: Q2, triangle: readonly [Q2, Q2, Q2]): boolean {
  const s = [
    sign(cross3(triangle[0], triangle[1], point)),
    sign(cross3(triangle[1], triangle[2], point)),
    sign(cross3(triangle[2], triangle[0], point)),
  ];
  return !s.includes(1) || !s.includes(-1);
}

export type SeamReport = Readonly<{
  conforming: boolean;
  /** Number of adjacent tile pairs examined (each shared grid-line segment once). */
  pairs: number;
  /** Distinct exact positions lying on a shared segment of some adjacent tile pair. */
  seamVertices: number;
}>;

/**
 * Reference seam conformance over adjacent tiles sharing a grid-line segment: every exact vertex
 * of one side on the shared segment that the other side's triangles reach (closed) is also a
 * vertex of the other side. Where both sides cover the segment, the two vertex sets are equal.
 */
export function seamConformance(result: TileResult): SeamReport {
  const byKey = new Map(result.cells.map((cell) => [`${cell.j},${cell.i}`, cell]));
  const seam = new Set<string>();
  let pairs = 0;
  let conforming = true;
  const triangleList = (cell: TileCell) =>
    cell.indices.map((ids) => ids.map((id) => cell.points[id]!) as unknown as [Q2, Q2, Q2]);
  const check = (left: TileCell, right: TileCell, axis: 0 | 1) => {
    const L = left.L;
    const line = axis === 0 ? gridValue(left.i + 1n, L) : gridValue(left.j + 1n, L);
    const other = axis === 0 ? left.j : left.i;
    const low = gridValue(other, L);
    const high = gridValue(other + 1n, L);
    const onShared = (point: Q2) =>
      compare(point[axis], line) === 0 &&
      compare(point[1 - axis]!, low) >= 0 &&
      compare(point[1 - axis]!, high) <= 0;
    const sides = [left, right].map((cell) => ({
      keys: new Set(cell.points.filter(onShared).map(keyOf)),
      points: cell.points.filter(onShared),
      triangles: triangleList(cell),
    }));
    for (const [from, to] of [
      [sides[0]!, sides[1]!],
      [sides[1]!, sides[0]!],
    ] as const) {
      for (const point of from.points) {
        seam.add(keyOf(point));
        if (to.keys.has(keyOf(point))) continue;
        if (to.triangles.some((triangle) => closedInside(point, triangle))) conforming = false;
      }
    }
    pairs += 1;
  };
  for (const cell of result.cells) {
    const east = byKey.get(`${cell.j},${cell.i + 1n}`);
    if (east !== undefined) check(cell, east, 0);
    const south = byKey.get(`${cell.j + 1n},${cell.i}`);
    if (south !== undefined) check(cell, south, 1);
  }
  return { conforming, pairs, seamVertices: seam.size };
}
