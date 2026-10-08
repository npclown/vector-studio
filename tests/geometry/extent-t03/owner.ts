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
import { cross3, type Q2 } from '../extent-t01/clip.js';
import { roundToBinary64 } from '../extent-t01/tile-certificate.js';
import { pow2 } from '../extent-t01/tile.js';
import { pointKey } from '../extent-t02/fringe.js';
import {
  cellIndex,
  cellKey,
  sourceContext,
  type MergedMesh,
  type SourceContext,
  type SourceEdge,
  type SourceTriangle,
} from '../extent-t02/merged.js';

/**
 * P3.1p T03 owner carrier centre (docs/plans/p3-r2-tiling-rev4-contract.md, D-D). Test-only.
 *
 * The owned set of cell (i, j) at level L depends on the cell and the source mesh only:
 *
 * - every vertex of a non-degenerate source triangle in the half-open cell [x0, x1) × [y0, y1);
 * - every crossing of a (unique, non-degenerate) source edge with the cell's lower line y = y0 for
 *   x in [x0, x1), and with its left line x = x0 for y in [y0, y1); an edge lying along such a line
 *   contributes the ends of its overlap with the closed side that fall in the half-open extent;
 * - the lower-left corner when it lies strictly inside a non-degenerate source triangle (kind 3).
 *
 * Every merged record owned by the cell lies in this set, except a kind-4 lower-left corner.
 */

type Box = Readonly<{ x0: Rational; y0: Rational; x1: Rational; y1: Rational }>;

const minR = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const maxR = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);

function strictlyInside(point: Q2, triangle: readonly [Q2, Q2, Q2]): boolean {
  const s0 = sign(cross3(triangle[0], triangle[1], point));
  const s1 = sign(cross3(triangle[1], triangle[2], point));
  const s2 = sign(cross3(triangle[2], triangle[0], point));
  return s0 !== 0 && s0 === s1 && s1 === s2;
}

const inClosedBox = (point: Q2, box: Box) =>
  compare(point[0], box.x0) >= 0 &&
  compare(point[0], box.x1) <= 0 &&
  compare(point[1], box.y0) >= 0 &&
  compare(point[1], box.y1) <= 0;

/** Owned points from the given (superset of relevant) source vertices, edges and triangles. */
function ownedFrom(
  L: number,
  i: bigint,
  j: bigint,
  vertices: readonly Q2[],
  edges: readonly SourceEdge[],
  triangles: readonly SourceTriangle[],
): Q2[] {
  const side = pow2(L);
  const x0 = mul(rational(i), side);
  const y0 = mul(rational(j), side);
  const x1 = add(x0, side);
  const y1 = add(y0, side);
  const unique = new Map<string, Q2>();
  const push = (point: Q2) => unique.set(pointKey(point), point);
  const halfOpen = (value: Rational, low: Rational, high: Rational) =>
    compare(value, low) >= 0 && compare(value, high) < 0;

  for (const vertex of vertices)
    if (halfOpen(vertex[0], x0, x1) && halfOpen(vertex[1], y0, y1)) push(vertex);

  const lines: { axis: 0 | 1; value: Rational; low: Rational; high: Rational }[] = [
    { axis: 1, value: y0, low: x0, high: x1 }, // lower line, x in [x0, x1)
    { axis: 0, value: x0, low: y0, high: y1 }, // left line, y in [y0, y1)
  ];
  for (const edge of edges) {
    if (
      compare(edge.box.x0, x1) > 0 ||
      compare(edge.box.x1, x0) < 0 ||
      compare(edge.box.y0, y1) > 0 ||
      compare(edge.box.y1, y0) < 0
    )
      continue;
    for (const line of lines) {
      const axis = line.axis;
      const other = axis === 0 ? 1 : 0;
      const make = (along: Rational): Q2 =>
        axis === 0 ? [line.value, along] : [along, line.value];
      const da = compare(edge.a[axis], line.value);
      const db = compare(edge.b[axis], line.value);
      if (da === 0 && db === 0) {
        const low = maxR(minR(edge.a[other], edge.b[other]), line.low);
        const high = minR(maxR(edge.a[other], edge.b[other]), line.high);
        if (compare(low, high) > 0) continue;
        for (const end of [low, high]) if (halfOpen(end, line.low, line.high)) push(make(end));
        continue;
      }
      if (da * db > 0) continue;
      const t = div(sub(line.value, edge.a[axis]), sub(edge.b[axis], edge.a[axis]));
      const along = add(edge.a[other], mul(t, sub(edge.b[other], edge.a[other])));
      if (halfOpen(along, line.low, line.high)) push(make(along));
    }
  }

  const corner: Q2 = [x0, y0];
  if (
    !unique.has(pointKey(corner)) &&
    triangles.some(
      (triangle) => inClosedBox(corner, triangle.box) && strictlyInside(corner, triangle.points),
    )
  )
    push(corner);
  return [...unique.values()].sort(
    (left, right) => compare(left[0], right[0]) || compare(left[1], right[1]),
  );
}

function sourceVertices(context: SourceContext): Q2[] {
  const unique = new Map<string, Q2>();
  for (const triangle of context.triangles)
    for (const point of triangle.points) unique.set(pointKey(point), point);
  return [...unique.values()];
}

/** D-D owned set of cell (i, j) at level L, sorted by exact (x, y). */
export function ownedPoints(context: SourceContext, L: number, i: bigint, j: bigint): Q2[] {
  return ownedFrom(L, i, j, sourceVertices(context), context.edges, context.triangles);
}

/** The exact lower-left corner in binary64; throws `owner:corner-inexact` if not representable. */
function cornerBinary64(L: number, i: bigint, j: bigint): [number, number] {
  const convert = (index: bigint): number => {
    const exact = mul(rational(index), pow2(L));
    const value = roundToBinary64(exact);
    if (!Number.isFinite(value) || compare(q(value), exact) !== 0)
      throw new Error(`owner:corner-inexact:tile(${L},${i},${j})`);
    return value;
  };
  return [convert(i), convert(j)];
}

/**
 * D-D carrier centre: m = ((x_min·0.5) + (x_max·0.5), (y_min·0.5) + (y_max·0.5)) in binary64
 * round-to-nearest over the owned points' v64 = roundToBinary64(exact); the exact lower-left
 * corner when the owned set is empty.
 */
export function carrierCentre(
  owned: readonly Q2[],
  L: number,
  i: bigint,
  j: bigint,
): [number, number] {
  if (owned.length === 0) return cornerBinary64(L, i, j);
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const point of owned) {
    const x = roundToBinary64(point[0]);
    const y = roundToBinary64(point[1]);
    xMin = Math.min(xMin, x);
    xMax = Math.max(xMax, x);
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  }
  return [xMin * 0.5 + xMax * 0.5, yMin * 0.5 + yMax * 0.5];
}

/** Centre of cell (i, j) from the cell and the source mesh alone. */
export function ownerCentre(
  context: SourceContext,
  L: number,
  i: bigint,
  j: bigint,
): [number, number] {
  return carrierCentre(ownedPoints(context, L, i, j), L, i, j);
}

/**
 * D-D centres of every owner cell referenced by `mesh.records`, keyed `"i,j"` (`cellKey`). The
 * source elements are bucketed by the closed cell range of their boxes first, which only skips
 * elements that cannot meet the closed cell, so each value equals `ownerCentre` of the cell alone.
 */
export function ownerCentres(
  input: ProjectionInput,
  mesh: Pick<MergedMesh, 'L' | 'records'>,
  context: SourceContext = sourceContext(input),
): Map<string, [number, number]> {
  const L = mesh.L;
  const owners = new Map<string, [bigint, bigint]>();
  for (const record of mesh.records) owners.set(cellKey(...record.owner), record.owner);
  const ownerList = [...owners.values()];

  const buckets = new Map<
    string,
    { vertices: Q2[]; edges: SourceEdge[]; triangles: SourceTriangle[] }
  >([...owners.keys()].map((key) => [key, { vertices: [], edges: [], triangles: [] }]));
  /** Visit owners whose closed cell meets the closed box. */
  const visit = (
    box: Box,
    apply: (bucket: NonNullable<ReturnType<typeof buckets.get>>) => void,
  ) => {
    const i0 = -cellIndex(rational(-box.x0.n, box.x0.d), L) - 1n;
    const i1 = cellIndex(box.x1, L);
    const j0 = -cellIndex(rational(-box.y0.n, box.y0.d), L) - 1n;
    const j1 = cellIndex(box.y1, L);
    const span = (i1 - i0 + 1n) * (j1 - j0 + 1n);
    if (span <= BigInt(ownerList.length)) {
      for (let j = j0; j <= j1; j += 1n)
        for (let i = i0; i <= i1; i += 1n) {
          const bucket = buckets.get(cellKey(i, j));
          if (bucket !== undefined) apply(bucket);
        }
    } else
      for (const [i, j] of ownerList)
        if (i >= i0 && i <= i1 && j >= j0 && j <= j1) apply(buckets.get(cellKey(i, j))!);
  };
  for (const vertex of sourceVertices(context)) {
    const bucket = buckets.get(cellKey(cellIndex(vertex[0], L), cellIndex(vertex[1], L)));
    if (bucket !== undefined) bucket.vertices.push(vertex);
  }
  for (const edge of context.edges) visit(edge.box, (bucket) => bucket.edges.push(edge));
  for (const triangle of context.triangles)
    visit(triangle.box, (bucket) => bucket.triangles.push(triangle));

  const centres = new Map<string, [number, number]>();
  for (const [key, [i, j]] of owners) {
    const bucket = buckets.get(key)!;
    centres.set(
      key,
      carrierCentre(ownedFrom(L, i, j, bucket.vertices, bucket.edges, bucket.triangles), L, i, j),
    );
  }
  return centres;
}
