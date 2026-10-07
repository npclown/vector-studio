import type { ProjectionInput } from '../mesh-projection/model.js';
import { q } from '../position-certificate/certificate.js';
import {
  add,
  compare,
  div,
  mul,
  rational,
  sign,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';
import { compareAngle, type P } from '../coverage-oracle/exterior.js';
import { cross3, doubleArea, earClip, exactClip, type Cell, type Q2 } from '../extent-t01/clip.js';
import { roundToBinary64 } from '../extent-t01/tile-certificate.js';
import { cellCentre, cellOf, pow2 } from '../extent-t01/tile.js';
import { fringeFaces, onClosedSegment, pointKey } from './fringe.js';

/**
 * P3.1p T02 merged mesh (docs/plans/p3-r2-tiling-contract.md, "Cells and owner", E1, E2, P3, P5,
 * "Mechanism" and the `MergedMesh` type). Test-only and exact.
 *
 * Per candidate cell: T01's `exactClip` and convex ear rule, unchanged. Records are shared across
 * the whole merged set, one per exact position, classified and ordered per P5 with `lowestEdge`
 * taken globally over all non-degenerate source triangles. Fringe cells (P3) are partitioned by
 * `fringeFaces`. Lists are left empty for the caller (Primary) to fill.
 */

export type { Q2 };

export type EpochCells = Readonly<{
  L: number;
  /** Cells whose closed square meets P̂, in (j, then i) order; taken as given. */
  candidates: readonly Readonly<{ i: bigint; j: bigint }>[];
  /** Fringe reach ρ_L in the local ∞-norm. */
  rhoL: Rational;
}>;

export type RecordKind = 0 | 1 | 2 | 3 | 4;

export type MergedMesh = {
  L: number;
  cells: { i: bigint; j: bigint; m: Q2; region: boolean; fringe: boolean }[]; // candidate order (j, then i)
  records: { pos: Q2; v64: [number, number]; owner: [bigint, bigint]; kind: RecordKind }[]; // P5 order
  carriers: { owner: [bigint, bigint]; m: [number, number] }[]; // owner order (j, then i)
  triangles: { ids: [number, number, number]; role: 'region' | 'exterior'; cell: number }[];
  boundary: { edges: [number, number][]; vertices: { id: number; sectors: [number, number][] }[] };
  lists: { offset: number; count: number }[]; // per triangle, into a flat feature array
};

export type MergedMeshResult =
  | Readonly<{
      status: 'OK';
      mesh: MergedMesh;
      /**
       * Boundary vertices on the candidate set's outer border (a point whose closed neighbouring
       * cells include both a candidate and a non-candidate). Their boundary rays may continue outside
       * the candidate set, so they get no sector entry; they lie outside P̂.
       */
      omittedVertices: readonly number[];
    }>
  | Readonly<{ status: 'LANE_RANGE'; locus: string }>
  | Readonly<{ status: 'PARTITION'; check: string }>;

type Box = Readonly<{ x0: Rational; y0: Rational; x1: Rational; y1: Rational }>;
type IndexRange = Readonly<{ i0: bigint; i1: bigint; j0: bigint; j1: bigint }>;

const minR = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const maxR = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);

function boxOf(points: readonly Q2[]): Box {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return { x0: xs.reduce(minR), x1: xs.reduce(maxR), y0: ys.reduce(minR), y1: ys.reduce(maxR) };
}

function inBox(point: Q2, box: Box): boolean {
  return (
    compare(point[0], box.x0) >= 0 &&
    compare(point[0], box.x1) <= 0 &&
    compare(point[1], box.y0) >= 0 &&
    compare(point[1], box.y1) <= 0
  );
}

function boxesMeet(a: Box, b: Box): boolean {
  return (
    compare(a.x0, b.x1) <= 0 &&
    compare(b.x0, a.x1) <= 0 &&
    compare(a.y0, b.y1) <= 0 &&
    compare(b.y0, a.y1) <= 0
  );
}

function floorBig(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return quotient * denominator !== numerator && numerator < 0n !== denominator < 0n
    ? quotient - 1n
    : quotient;
}

/** floor(value / 2^L): the half-open owner index. */
export function cellIndex(value: Rational, L: number): bigint {
  return L >= 0
    ? floorBig(value.n, value.d << BigInt(L))
    : floorBig(value.n << BigInt(-L), value.d);
}

/** ceil(value / 2^L). */
function ceilIndex(value: Rational, L: number): bigint {
  return -cellIndex(rational(-value.n, value.d), L);
}

function onGridLine(value: Rational, L: number): boolean {
  return mul(value, pow2(-L)).d === 1n;
}

/** Owner cell of an exact point: (⌊x / 2^L⌋, ⌊y / 2^L⌋), on the exact position. */
export function ownerOf(point: Q2, L: number): [bigint, bigint] {
  return [cellIndex(point[0], L), cellIndex(point[1], L)];
}

/** Index range of cells whose closed square meets the closed box. */
function closedRange(box: Box, L: number): IndexRange {
  return {
    i0: ceilIndex(box.x0, L) - 1n,
    i1: cellIndex(box.x1, L),
    j0: ceilIndex(box.y0, L) - 1n,
    j1: cellIndex(box.y1, L),
  };
}

export const cellKey = (i: bigint, j: bigint): string => `${i},${j}`;

/** Exact rational cell centre ((i + 1/2)·2^L, (j + 1/2)·2^L). */
export function exactCentre(L: number, i: bigint, j: bigint): Q2 {
  return [mul(rational(2n * i + 1n), pow2(L - 1)), mul(rational(2n * j + 1n), pow2(L - 1))];
}

/** Exact segment-against-closed-box test (separating axes: the box axes and the segment normal). */
export function segmentMeetsBox(a: Q2, b: Q2, box: Box): boolean {
  if (!boxesMeet(boxOf([a, b]), box)) return false;
  const corners: Q2[] = [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ];
  const signs = corners.map((corner) => sign(cross3(a, b, corner)));
  return !(signs.every((s) => s > 0) || signs.every((s) => s < 0));
}

// ---------------------------------------------------------------------------------------------
// Source context (the original region mesh; shared by every cell build).

export type SourceTriangle = Readonly<{
  index: number;
  ids: readonly [number, number, number];
  points: readonly [Q2, Q2, Q2];
  box: Box;
}>;

export type SourceEdge = Readonly<{
  /** Original vertex indices, ascending. */
  ids: readonly [number, number];
  a: Q2;
  b: Q2;
  box: Box;
  /** Used by exactly one non-degenerate source triangle. */
  boundary: boolean;
}>;

export type SourceContext = Readonly<{
  locals: readonly Q2[];
  /** Non-degenerate source triangles, by index. */
  triangles: readonly SourceTriangle[];
  /** Unique source edges of non-degenerate triangles, ascending by (a, b). */
  edges: readonly SourceEdge[];
  /** Exact position → lowest original vertex index referenced by the indices. */
  originalAt: ReadonlyMap<string, number>;
  /** Region winding: the sign of the first non-degenerate source triangle (+1 when none). */
  winding: 1 | -1;
}>;

export function sourceContext(input: ProjectionInput): SourceContext {
  const locals: Q2[] = input.mesh.vertices.map(([x, y]) => [q(x), q(y)] as const);
  const originalAt = new Map<string, number>();
  for (const index of [...new Set(input.mesh.indices)].sort((a, b) => a - b)) {
    const key = pointKey(locals[index]!);
    if (!originalAt.has(key)) originalAt.set(key, index);
  }
  const indices = input.mesh.indices;
  const triangles: SourceTriangle[] = [];
  const edgeUses = new Map<string, { ids: [number, number]; count: number }>();
  let winding: 1 | -1 | 0 = 0;
  for (let t = 0; 3 * t < indices.length; t += 1) {
    const ids = [indices[3 * t]!, indices[3 * t + 1]!, indices[3 * t + 2]!] as const;
    const points = ids.map((id) => locals[id]!) as unknown as [Q2, Q2, Q2];
    const orientation = sign(cross3(...points));
    if (orientation === 0) continue;
    if (winding === 0) winding = orientation;
    triangles.push({ index: t, ids, points, box: boxOf(points) });
    for (let side = 0; side < 3; side += 1) {
      const u = ids[side]!;
      const w = ids[(side + 1) % 3]!;
      const pair: [number, number] = u < w ? [u, w] : [w, u];
      const key = `${pair[0]}:${pair[1]}`;
      const entry = edgeUses.get(key) ?? { ids: pair, count: 0 };
      entry.count += 1;
      edgeUses.set(key, entry);
    }
  }
  const edges = [...edgeUses.values()]
    .sort((left, right) => left.ids[0] - right.ids[0] || left.ids[1] - right.ids[1])
    .map(({ ids, count }): SourceEdge => {
      const a = locals[ids[0]]!;
      const b = locals[ids[1]]!;
      return { ids, a, b, box: boxOf([a, b]), boundary: count === 1 };
    });
  return { locals, triangles, edges, originalAt, winding: winding === 0 ? 1 : winding };
}

function lowestEdge(point: Q2, context: SourceContext): readonly [number, number] | null {
  for (const edge of context.edges)
    if (inBox(point, edge.box) && onClosedSegment(point, edge.a, edge.b)) return edge.ids;
  return null;
}

function strictlyInside(point: Q2, triangle: readonly [Q2, Q2, Q2]): boolean {
  const s0 = sign(cross3(triangle[0], triangle[1], point));
  const s1 = sign(cross3(triangle[1], triangle[2], point));
  const s2 = sign(cross3(triangle[2], triangle[0], point));
  return s0 !== 0 && s0 === s1 && s1 === s2;
}

export type Classified = Readonly<{
  pos: Q2;
  kind: RecordKind;
  /** Original vertex index for kind 0. */
  sourceIndex: number | null;
  /** Global lowest source edge through the point (kinds 1 and 2). */
  edge: readonly [number, number] | null;
}>;

/**
 * P5 classification. Kind 0: an original vertex. Kind 1: on a source edge and on an x-line. Kind 2:
 * on a source edge and on a y-line. Kind 3: an x-line × y-line corner strictly inside a source
 * triangle. Kind 4 (only when `allowCorner`): a cell corner outside the closed region.
 */
export function classify(
  point: Q2,
  L: number,
  context: SourceContext,
  allowCorner = false,
): Classified {
  const pos = point;
  const original = context.originalAt.get(pointKey(point));
  if (original !== undefined) return { pos, kind: 0, sourceIndex: original, edge: null };
  const onX = onGridLine(point[0], L);
  const onY = onGridLine(point[1], L);
  const edge = lowestEdge(point, context);
  if (edge !== null && onX) return { pos, kind: 1, sourceIndex: null, edge };
  if (edge !== null && onY) return { pos, kind: 2, sourceIndex: null, edge };
  if (edge === null && onX && onY) {
    const inside = context.triangles.some(
      (triangle) => inBox(point, triangle.box) && strictlyInside(point, triangle.points),
    );
    if (inside) return { pos, kind: 3, sourceIndex: null, edge: null };
    if (allowCorner) return { pos, kind: 4, sourceIndex: null, edge: null };
  }
  throw new Error(`unclassifiable record ${pointKey(point)} at level ${L}`);
}

function compareEdge(left: readonly [number, number], right: readonly [number, number]): number {
  return left[0] - right[0] || left[1] - right[1];
}

/** P5 record order. */
export function compareRecords(left: Classified, right: Classified): number {
  if (left.kind !== right.kind) return left.kind - right.kind;
  switch (left.kind) {
    case 0:
      return left.sourceIndex! - right.sourceIndex!;
    case 1:
      return (
        compare(left.pos[0], right.pos[0]) ||
        compareEdge(left.edge!, right.edge!) ||
        compare(left.pos[1], right.pos[1])
      );
    case 2:
      return (
        compare(left.pos[1], right.pos[1]) ||
        compareEdge(left.edge!, right.edge!) ||
        compare(left.pos[0], right.pos[0])
      );
    default:
      return compare(left.pos[0], right.pos[0]) || compare(left.pos[1], right.pos[1]);
  }
}

// ---------------------------------------------------------------------------------------------
// Cell geometry (E2: depends on the cell and the source mesh alone).

export type CellPiece = Readonly<{ triangle: number; ring: readonly Q2[] }>;

export type CellGeometry = Readonly<{
  L: number;
  i: bigint;
  j: bigint;
  cell: Cell;
  /** Positive-area clipped pieces, by source triangle index. */
  pieces: readonly CellPiece[];
  /** Region triangles: T01's convex ear rule per piece, in the source winding. */
  region: readonly (readonly [Q2, Q2, Q2])[];
  /** Region piece vertices, classified, in P5 order. */
  regionRecords: readonly Classified[];
}>;

function cellPieces(
  L: number,
  i: bigint,
  j: bigint,
  context: SourceContext,
  triangles: readonly SourceTriangle[] = context.triangles,
): CellPiece[] {
  const cell = cellOf(L, i, j);
  const box: Box = cell;
  const pieces: CellPiece[] = [];
  for (const triangle of triangles) {
    if (!boxesMeet(triangle.box, box)) continue;
    const ring = exactClip(triangle.points, cell);
    if (ring.length > 0) pieces.push({ triangle: triangle.index, ring });
  }
  return pieces;
}

function geometryFromPieces(
  L: number,
  i: bigint,
  j: bigint,
  pieces: readonly CellPiece[],
  context: SourceContext,
): CellGeometry {
  const region: (readonly [Q2, Q2, Q2])[] = [];
  const unique = new Map<string, Q2>();
  for (const piece of pieces) {
    for (const point of piece.ring) unique.set(pointKey(point), point);
    for (const [a, b, c] of earClip(piece.ring))
      region.push([piece.ring[a]!, piece.ring[b]!, piece.ring[c]!]);
  }
  const regionRecords = [...unique.values()]
    .map((point) => classify(point, L, context))
    .sort(compareRecords);
  return { L, i, j, cell: cellOf(L, i, j), pieces, region, regionRecords };
}

/**
 * One cell's geometry alone (E2 cache unit): its clipped pieces, region triangles and records.
 * Fringe geometry (exterior triangles and side records) comes from `buildCellFringe`.
 */
export function buildCellGeometry(
  input: ProjectionInput,
  L: number,
  i: bigint,
  j: bigint,
  context: SourceContext = sourceContext(input),
): CellGeometry {
  return geometryFromPieces(L, i, j, cellPieces(L, i, j, context), context);
}

/**
 * The cell's side points: its corners, every crossing of a source edge with a closed side (for an
 * edge along a side, the ends of the overlap), and every region vertex on a side. These are the
 * points a neighbour can place on a shared side; the cell computes them itself.
 */
export function cellSidePoints(geometry: CellGeometry, context: SourceContext): Q2[] {
  const { cell } = geometry;
  const unique = new Map<string, Q2>();
  const push = (point: Q2) => unique.set(pointKey(point), point);
  const corners: Q2[] = [
    [cell.x0, cell.y0],
    [cell.x1, cell.y0],
    [cell.x1, cell.y1],
    [cell.x0, cell.y1],
  ];
  corners.forEach(push);
  const sides: { axis: 0 | 1; value: Rational; low: Rational; high: Rational }[] = [
    { axis: 0, value: cell.x0, low: cell.y0, high: cell.y1 },
    { axis: 0, value: cell.x1, low: cell.y0, high: cell.y1 },
    { axis: 1, value: cell.y0, low: cell.x0, high: cell.x1 },
    { axis: 1, value: cell.y1, low: cell.x0, high: cell.x1 },
  ];
  for (const edge of context.edges) {
    if (!boxesMeet(edge.box, cell)) continue;
    for (const side of sides) {
      const axis = side.axis;
      const other = axis === 0 ? 1 : 0;
      const make = (along: Rational): Q2 =>
        axis === 0 ? [side.value, along] : [along, side.value];
      const da = compare(edge.a[axis], side.value);
      const db = compare(edge.b[axis], side.value);
      if (da === 0 && db === 0) {
        const low = maxR(minR(edge.a[other], edge.b[other]), side.low);
        const high = minR(maxR(edge.a[other], edge.b[other]), side.high);
        if (compare(low, high) <= 0) {
          push(make(low));
          push(make(high));
        }
        continue;
      }
      if (da * db > 0) continue;
      const t = div(sub(side.value, edge.a[axis]), sub(edge.b[axis], edge.a[axis]));
      const along = add(edge.a[other], mul(t, sub(edge.b[other], edge.a[other])));
      if (compare(along, side.low) >= 0 && compare(along, side.high) <= 0) push(make(along));
    }
  }
  const onSide = (point: Q2) =>
    compare(point[0], cell.x0) === 0 ||
    compare(point[0], cell.x1) === 0 ||
    compare(point[1], cell.y0) === 0 ||
    compare(point[1], cell.y1) === 0;
  for (const piece of geometry.pieces)
    for (const point of piece.ring) if (onSide(point)) push(point);
  return [...unique.values()].sort(
    (left, right) => compare(left[0], right[0]) || compare(left[1], right[1]),
  );
}

export type CellFringe =
  | Readonly<{
      status: 'OK';
      /** Exterior triangles, in the region winding. */
      exterior: readonly (readonly [Q2, Q2, Q2])[];
      /** Records of the exterior triangles that are not region records, classified, P5 order. */
      records: readonly Classified[];
    }>
  | Readonly<{ status: 'FAIL'; reason: string }>;

/** The cell's exterior partition (P3) when it is a fringe cell; depends on the cell alone. */
export function buildCellFringe(geometry: CellGeometry, context: SourceContext): CellFringe {
  const sidePoints = cellSidePoints(geometry, context);
  const result = fringeFaces(
    geometry.cell,
    geometry.pieces.map((piece) => piece.ring),
    sidePoints,
    context.winding,
  );
  if (result.status !== 'OK') return result;
  const known = new Set(geometry.regionRecords.map((record) => pointKey(record.pos)));
  const extra = new Map<string, Q2>();
  for (const triangle of result.exterior)
    for (const point of triangle)
      if (!known.has(pointKey(point))) extra.set(pointKey(point), point);
  const records = [...extra.values()]
    .map((point) => classify(point, geometry.L, context, true))
    .sort(compareRecords);
  for (const record of records)
    if (record.kind === 4) {
      const isCorner =
        (compare(record.pos[0], geometry.cell.x0) === 0 ||
          compare(record.pos[0], geometry.cell.x1) === 0) &&
        (compare(record.pos[1], geometry.cell.y0) === 0 ||
          compare(record.pos[1], geometry.cell.y1) === 0);
      if (!isCorner) return { status: 'FAIL', reason: `kind4-not-corner:${pointKey(record.pos)}` };
    }
  return { status: 'OK', exterior: result.exterior, records };
}

// ---------------------------------------------------------------------------------------------
// Merged build.

const locus = (L: number, i: bigint, j: bigint) => `tile(${L},${i},${j})`;

/**
 * Build the merged mesh of one epoch's candidate set (contract "Mechanism" 2-5). `region` is true
 * for a candidate cell holding at least one region piece; `fringe` per P3. Drawn cells are region
 * or fringe cells. Lists are left empty.
 */
export function buildMergedMesh(input: ProjectionInput, epoch: EpochCells): MergedMeshResult {
  const { L, candidates, rhoL } = epoch;
  const context = sourceContext(input);
  const side = pow2(L);
  const candidateIndex = new Map(candidates.map((cell, index) => [cellKey(cell.i, cell.j), index]));

  // 1. Per candidate: pieces (clipped only against source triangles whose bbox range covers it).
  const byCell = new Map<number, SourceTriangle[]>();
  for (const triangle of context.triangles) {
    const range = closedRange(triangle.box, L);
    const span = (range.i1 - range.i0 + 1n) * (range.j1 - range.j0 + 1n);
    const assign = (index: number) => {
      const list = byCell.get(index) ?? [];
      list.push(triangle);
      byCell.set(index, list);
    };
    if (span <= BigInt(candidates.length)) {
      for (let j = range.j0; j <= range.j1; j += 1n)
        for (let i = range.i0; i <= range.i1; i += 1n) {
          const index = candidateIndex.get(cellKey(i, j));
          if (index !== undefined) assign(index);
        }
    } else
      candidates.forEach(({ i, j }, index) => {
        if (i >= range.i0 && i <= range.i1 && j >= range.j0 && j <= range.j1) assign(index);
      });
  }
  const geometries = candidates.map(({ i, j }, index) =>
    geometryFromPieces(L, i, j, cellPieces(L, i, j, context, byCell.get(index) ?? []), context),
  );

  // 2. Boundary pieces of the candidate set's region tiling (by exact position).
  type PosEdge = { a: Q2; b: Q2; cell: number };
  const uses = new Map<string, { edge: PosEdge; count: number }>();
  geometries.forEach((geometry, cell) => {
    for (const triangle of geometry.region)
      for (let k = 0; k < 3; k += 1) {
        const a = triangle[k]!;
        const b = triangle[(k + 1) % 3]!;
        const ka = pointKey(a);
        const kb = pointKey(b);
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const entry = uses.get(key) ?? { edge: { a, b, cell }, count: 0 };
        entry.count += 1;
        uses.set(key, entry);
      }
  });
  const isCandidate = (i: bigint, j: bigint) => candidateIndex.has(cellKey(i, j));
  /** The side of cell `cell` that segment ab lies on, if any, as the neighbour across it. */
  const neighbourAcross = (a: Q2, b: Q2, cell: number): [bigint, bigint] | null => {
    const { i, j } = candidates[cell]!;
    const box = geometries[cell]!.cell;
    const both = (axis: 0 | 1, value: Rational) =>
      compare(a[axis], value) === 0 && compare(b[axis], value) === 0;
    if (both(0, box.x0)) return [i - 1n, j];
    if (both(0, box.x1)) return [i + 1n, j];
    if (both(1, box.y0)) return [i, j - 1n];
    if (both(1, box.y1)) return [i, j + 1n];
    return null;
  };
  const onSourceBoundary = (a: Q2, b: Q2) =>
    context.edges.some(
      (edge) =>
        edge.boundary &&
        inBox(a, edge.box) &&
        inBox(b, edge.box) &&
        onClosedSegment(a, edge.a, edge.b) &&
        onClosedSegment(b, edge.a, edge.b),
    );
  const boundaryPieces: PosEdge[] = [];
  for (const { edge, count } of uses.values()) {
    if (count !== 1) continue;
    const across = neighbourAcross(edge.a, edge.b, edge.cell);
    if (across !== null && !isCandidate(...across) && !onSourceBoundary(edge.a, edge.b)) continue;
    boundaryPieces.push(edge);
  }

  // 3. Fringe flags: the closed square expanded by ρ_L meets a boundary piece.
  const fringe = candidates.map(() => false);
  for (const piece of boundaryPieces) {
    const box = boxOf([piece.a, piece.b]);
    const dilated: Box = {
      x0: sub(box.x0, rhoL),
      x1: add(box.x1, rhoL),
      y0: sub(box.y0, rhoL),
      y1: add(box.y1, rhoL),
    };
    const range = closedRange(dilated, L);
    const test = (index: number) => {
      if (fringe[index]) return;
      const cell = geometries[index]!.cell;
      const expanded: Box = {
        x0: sub(cell.x0, rhoL),
        x1: add(cell.x1, rhoL),
        y0: sub(cell.y0, rhoL),
        y1: add(cell.y1, rhoL),
      };
      if (segmentMeetsBox(piece.a, piece.b, expanded)) fringe[index] = true;
    };
    const span = (range.i1 - range.i0 + 1n) * (range.j1 - range.j0 + 1n);
    if (span <= BigInt(candidates.length)) {
      for (let j = range.j0; j <= range.j1; j += 1n)
        for (let i = range.i0; i <= range.i1; i += 1n) {
          const index = candidateIndex.get(cellKey(i, j));
          if (index !== undefined) test(index);
        }
    } else
      candidates.forEach(({ i, j }, index) => {
        if (i >= range.i0 && i <= range.i1 && j >= range.j0 && j <= range.j1) test(index);
      });
  }

  // 4. Non-fringe region cells must be fully covered; fringe cells get their exterior partition.
  const fullArea = mul(side, side);
  const exteriors: (readonly (readonly [Q2, Q2, Q2])[])[] = [];
  const extraRecords: Classified[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const geometry = geometries[index]!;
    exteriors.push([]);
    if (!fringe[index]) {
      if (geometry.pieces.length === 0) continue;
      let area = rational(0n);
      for (const piece of geometry.pieces) {
        const twice = doubleArea(piece.ring);
        area = add(area, sign(twice) < 0 ? rational(-twice.n, twice.d) : twice);
      }
      if (compare(area, mul(rational(2n), fullArea)) !== 0)
        return {
          status: 'PARTITION',
          check: `region-cell-area:${locus(L, geometry.i, geometry.j)}`,
        };
      continue;
    }
    const result = buildCellFringe(geometry, context);
    if (result.status !== 'OK')
      return {
        status: 'PARTITION',
        check: `fringe:${locus(L, geometry.i, geometry.j)}:${result.reason}`,
      };
    exteriors[index] = result.exterior;
    extraRecords.push(...result.records);
  }

  // 5. Records: one per exact position over all drawn triangles, in P5 order.
  const classified = new Map<string, Classified>();
  geometries.forEach((geometry, index) => {
    if (geometry.pieces.length === 0 && !fringe[index]) return;
    for (const record of geometry.regionRecords) classified.set(pointKey(record.pos), record);
  });
  for (const record of extraRecords)
    if (!classified.has(pointKey(record.pos))) classified.set(pointKey(record.pos), record);
  const ordered = [...classified.values()].sort(compareRecords);
  const idOf = new Map(ordered.map((record, id) => [pointKey(record.pos), id]));
  const records: MergedMesh['records'] = ordered.map((record) => ({
    pos: record.pos,
    v64: [roundToBinary64(record.pos[0]), roundToBinary64(record.pos[1])],
    owner: ownerOf(record.pos, L),
    kind: record.kind,
  }));

  // 6. Carriers for every referenced owner cell, ordered (j, then i).
  const owners = new Map<string, [bigint, bigint]>();
  for (const record of records) owners.set(cellKey(...record.owner), record.owner);
  const ownerList = [...owners.values()].sort(([ia, ja], [ib, jb]) =>
    ja !== jb ? (ja < jb ? -1 : 1) : ia < ib ? -1 : ia > ib ? 1 : 0,
  );
  const carriers: MergedMesh['carriers'] = [];
  for (const [i, j] of ownerList) {
    try {
      const m = cellCentre(L, i, j);
      carriers.push({ owner: [i, j], m: [m[0], m[1]] });
    } catch {
      return { status: 'LANE_RANGE', locus: locus(L, i, j) };
    }
  }

  // 7. Triangles: per candidate cell, region triangles then exterior triangles.
  const ids = (triangle: readonly [Q2, Q2, Q2]): [number, number, number] =>
    triangle.map((point) => idOf.get(pointKey(point))!) as [number, number, number];
  const triangles: MergedMesh['triangles'] = [];
  geometries.forEach((geometry, cell) => {
    for (const triangle of geometry.region)
      triangles.push({ ids: ids(triangle), role: 'region', cell });
    for (const triangle of exteriors[cell]!)
      triangles.push({ ids: ids(triangle), role: 'exterior', cell });
  });

  // 8. Boundary edges (region triangle winding) and vertex sectors.
  const edges: [number, number][] = boundaryPieces
    .map(
      (piece) => [idOf.get(pointKey(piece.a))!, idOf.get(pointKey(piece.b))!] as [number, number],
    )
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const sectors = boundarySectors(records, edges, context.winding, L, isCandidate);
  if (sectors.status !== 'OK') return { status: 'PARTITION', check: sectors.check };

  const cells: MergedMesh['cells'] = candidates.map(({ i, j }, index) => ({
    i,
    j,
    m: exactCentre(L, i, j),
    region: geometries[index]!.pieces.length > 0,
    fringe: fringe[index]!,
  }));
  return {
    status: 'OK',
    mesh: {
      L,
      cells,
      records,
      carriers,
      triangles,
      boundary: { edges, vertices: sectors.vertices },
      lists: [],
    },
    omittedVertices: sectors.omitted,
  };
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/**
 * O02-style sector pairing on the directed boundary edges (region on the left in the region
 * winding): at each boundary vertex the rays are sorted by exact angle and every outgoing ray is
 * paired with the next ray counterclockwise (clockwise for a negative winding), which must be an
 * incoming one. Sectors are [rOut neighbour id, rIn neighbour id], in angle order of rOut.
 */
function boundarySectors(
  records: MergedMesh['records'],
  edges: readonly [number, number][],
  winding: 1 | -1,
  L: number,
  isCandidate: (i: bigint, j: bigint) => boolean,
):
  | Readonly<{
      status: 'OK';
      vertices: MergedMesh['boundary']['vertices'];
      omitted: number[];
    }>
  | Readonly<{ status: 'FAIL'; check: string }> {
  const rays = new Map<number, { other: number; out: boolean }[]>();
  const push = (v: number, other: number, out: boolean) => {
    const list = rays.get(v) ?? [];
    list.push({ other, out });
    rays.set(v, list);
  };
  for (const [from, to] of edges) {
    push(from, to, true);
    push(to, from, false);
  }
  const vertices: MergedMesh['boundary']['vertices'] = [];
  const omitted: number[] = [];
  for (const v of [...rays.keys()].sort((a, b) => a - b)) {
    const pos = records[v]!.pos;
    if (onOuterBorder(pos, L, isCandidate)) {
      omitted.push(v);
      continue;
    }
    const list = rays.get(v)!;
    const deltas = list.map(({ other }) => {
      const p = records[other]!.pos;
      return [sub(p[0], pos[0]), sub(p[1], pos[1])] as const;
    });
    let lcm = 1n;
    for (const [x, y] of deltas)
      for (const value of [x, y]) lcm = (lcm / gcd(lcm, value.d)) * value.d;
    const directed = list.map((ray, k) => {
      const [x, y] = deltas[k]!;
      const d: P = [x.n * (lcm / x.d), BigInt(winding) * y.n * (lcm / y.d)];
      return { ...ray, d };
    });
    const sorted = [...directed].sort((a, b) => compareAngle(a.d, b.d));
    for (let k = 1; k < sorted.length; k += 1)
      if (compareAngle(sorted[k - 1]!.d, sorted[k]!.d) === 0)
        return { status: 'FAIL', check: `sector-ray-tie:${v}` };
    const pairs: [number, number][] = [];
    for (let k = 0; k < sorted.length; k += 1) {
      const ray = sorted[k]!;
      if (!ray.out) continue;
      const next = sorted[(k + 1) % sorted.length]!;
      if (next.out || next === ray) return { status: 'FAIL', check: `sector-pairing:${v}` };
      pairs.push([ray.other, next.other]);
    }
    if (pairs.length * 2 !== sorted.length) return { status: 'FAIL', check: `sector-pairing:${v}` };
    vertices.push({ id: v, sectors: pairs });
  }
  return { status: 'OK', vertices, omitted };
}

/** True when the closed cells around `point` include both a candidate and a non-candidate. */
function onOuterBorder(
  point: Q2,
  L: number,
  isCandidate: (i: bigint, j: bigint) => boolean,
): boolean {
  const [i, j] = ownerOf(point, L);
  const is = onGridLine(point[0], L) ? [i - 1n, i] : [i];
  const js = onGridLine(point[1], L) ? [j - 1n, j] : [j];
  let some = false;
  let all = true;
  for (const ci of is)
    for (const cj of js) {
      if (isCandidate(ci, cj)) some = true;
      else all = false;
    }
  return some && !all;
}
