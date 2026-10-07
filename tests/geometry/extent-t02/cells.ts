import type { ProjectionInput } from '../mesh-projection/model.js';
import { add, compare, rational, sub, type Rational } from '../rounded-fill/exact.js';
import { cellIndex, sourceContext, type SourceContext } from './merged.js';

/**
 * P3.1p T02 trajectory cell sets (docs/plans/p3-r2-tiling-contract.md, "Trajectory keys"): no
 * clipping. A candidate cell (its closed square meets P̂; the caller passes the candidates) counts
 * when its closed square meets the bounding box of some non-degenerate region triangle, or meets
 * the ρ_L-dilated bounding box of some boundary edge of the original region mesh (an index-pair
 * edge used by exactly one non-degenerate triangle). Both tests are exact and conservative, so the
 * set is a superset of the materialized (drawn) set.
 */

type Range = Readonly<{ i0: bigint; i1: bigint; j0: bigint; j1: bigint }>;

const minR = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const maxR = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);

/** Cells whose closed square [i·2^L, (i+1)·2^L] meets [lo, hi] on one axis: i ∈ [⌈lo/2^L⌉ − 1, ⌊hi/2^L⌋]. */
function axisRange(lo: Rational, hi: Rational, L: number): readonly [bigint, bigint] {
  const ceil = -cellIndex(rational(-lo.n, lo.d), L);
  return [ceil - 1n, cellIndex(hi, L)];
}

function rangeOf(
  xs: readonly Rational[],
  ys: readonly Rational[],
  L: number,
  grow: Rational,
): Range {
  const [i0, i1] = axisRange(sub(xs.reduce(minR), grow), add(xs.reduce(maxR), grow), L);
  const [j0, j1] = axisRange(sub(ys.reduce(minR), grow), add(ys.reduce(maxR), grow), L);
  return { i0, i1, j0, j1 };
}

export const trajectoryCellKey = (L: number, i: bigint, j: bigint): string => `${L},${i},${j}`;

export function trajectoryCells(
  input: ProjectionInput,
  L: number,
  candidates: readonly Readonly<{ i: bigint; j: bigint }>[],
  rhoL: Rational,
  context: SourceContext = sourceContext(input),
): Set<string> {
  const zero = rational(0n);
  const ranges: Range[] = [];
  for (const triangle of context.triangles)
    ranges.push(
      rangeOf(
        triangle.points.map((point) => point[0]),
        triangle.points.map((point) => point[1]),
        L,
        zero,
      ),
    );
  for (const edge of context.edges)
    if (edge.boundary)
      ranges.push(rangeOf([edge.a[0], edge.b[0]], [edge.a[1], edge.b[1]], L, rhoL));

  const result = new Set<string>();
  const index = new Map(candidates.map(({ i, j }) => [`${i},${j}`, { i, j }]));
  const count = BigInt(candidates.length);
  for (const range of ranges) {
    const span = (range.i1 - range.i0 + 1n) * (range.j1 - range.j0 + 1n);
    if (span <= count) {
      for (let j = range.j0; j <= range.j1; j += 1n)
        for (let i = range.i0; i <= range.i1; i += 1n)
          if (index.has(`${i},${j}`)) result.add(trajectoryCellKey(L, i, j));
    } else
      for (const { i, j } of candidates)
        if (i >= range.i0 && i <= range.i1 && j >= range.j0 && j <= range.j1)
          result.add(trajectoryCellKey(L, i, j));
  }
  return result;
}
