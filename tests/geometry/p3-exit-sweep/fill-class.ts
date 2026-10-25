// D9 E14-Q1 (a) class test for the A01 sweep (docs/plans/d9-e14-fill-rung0-edge-cap-contract.md,
// section 10; E11 section 7.2): a rejected fill row is in the class "fill `work-limit` on a
// self-crossing path over E" when (1) its S1 polygon at the row's tolerance has more than E = 256
// flat edges, (2) two edges of that polygon cross properly by exact orient2d (strictly opposite
// signs at both edges), and (3) its port result is `work-limit`.
//
// The polygon is the P2 flattening of the row, rebuilt here from the P2 rule (binary subdivision
// of the cubic relative to its first point until the control points are within the tolerance of
// the chord's third points, plus the P2 rounding guard; `geometry.rs` `visit`), not read from the
// kernel. The crossing test uses its own exact predicate: a binary64 filter with Shewchuk's error
// bound, then an exact BigInt determinant.

import type { FillMeshRequest } from '../../../packages/contracts/src/geometry.js';

/** E, the exact rung's flat-edge budget (E14-K2). */
export const E14_EXACT_EDGE_CAP = 256;

const MOVE = 0;
const LINE = 1;
const CUBIC = 2;
const CLOSE = 3;
const P2_MAX_DEPTH = 20;
const EPSILON = Number.EPSILON;

type Point = readonly [number, number];

/** Why the mirror could not rebuild the polygon (the P2 sizing would fail the same way). */
export class FlattenRefused extends Error {}

/**
 * The P2 flattening of a fill path at tolerance 2^e, as closed contours of points. Consecutive
 * bit-equal points are merged and a final point equal to the contour's first is dropped, so each
 * contour of n ≥ 2 points has n edges (its closing edge included); a single point has none.
 */
export function p2FillContours(
  request: Pick<FillMeshRequest, 'verbs' | 'points' | 'toleranceExponent'>,
): Point[][] {
  const tolerance = 2 ** request.toleranceExponent;
  const { verbs, points } = request;
  const contours: Point[][] = [];
  let contour: Point[] | null = null;
  let current: Point = [0, 0];
  let p = 0;
  const read = (): Point => {
    const q: Point = [points[p]!, points[p + 1]!];
    p += 2;
    return q;
  };
  const push = (q: Point) => {
    const last = contour![contour!.length - 1]!;
    if (!Object.is(last[0], q[0]) || !Object.is(last[1], q[1])) contour!.push(q);
  };
  const finish = () => {
    if (contour === null) return;
    const first = contour[0]!;
    const last = contour[contour.length - 1]!;
    if (contour.length > 1 && Object.is(first[0], last[0]) && Object.is(first[1], last[1]))
      contour.pop();
    contours.push(contour);
    contour = null;
  };
  for (const verb of verbs) {
    if (verb === MOVE) {
      finish();
      current = read();
      contour = [current];
    } else if (verb === LINE) {
      current = read();
      push(current);
    } else if (verb === CUBIC) {
      const controls: [Point, Point, Point, Point] = [current, read(), read(), read()];
      flattenCubic(controls, tolerance, push);
      current = controls[3];
    } else if (verb === CLOSE) {
      finish();
    } else {
      throw new FlattenRefused(`unknown verb ${String(verb)}`);
    }
  }
  finish();
  return contours;
}

function flattenCubic(
  original: readonly [Point, Point, Point, Point],
  tolerance: number,
  emit: (q: Point) => void,
): void {
  const [ox, oy] = original[0];
  const rel = original.map(([x, y]) => [x - ox, y - oy] as Point) as [Point, Point, Point, Point];
  const maxAbsOriginal = original.reduce((m, [x, y]) => Math.max(m, Math.abs(x), Math.abs(y)), 1);
  const maxAbsRelative = rel.reduce((m, [x, y]) => Math.max(m, Math.abs(x), Math.abs(y)), 0);
  const guard = (depth: number) => 128 * EPSILON * (maxAbsOriginal + (depth + 1) * maxAbsRelative);
  if (!(guard(0) < tolerance)) throw new FlattenRefused('guard exceeds tolerance');
  const mid = (a: Point, b: Point): Point => [a[0] * 0.5 + b[0] * 0.5, a[1] * 0.5 + b[1] * 0.5];
  const visit = (q: readonly [Point, Point, Point, Point], depth: number): void => {
    const g = guard(depth);
    if (!(g < tolerance)) throw new FlattenRefused('guard exceeds tolerance');
    const [p0, p1, p2, p3] = q;
    const c1x = p0[0] + (p3[0] - p0[0]) / 3;
    const c1y = p0[1] + (p3[1] - p0[1]) / 3;
    const c2x = p0[0] + (2 * (p3[0] - p0[0])) / 3;
    const c2y = p0[1] + (2 * (p3[1] - p0[1])) / 3;
    const flatness = Math.max(
      Math.hypot(p1[0] - c1x, p1[1] - c1y),
      Math.hypot(p2[0] - c2x, p2[1] - c2y),
    );
    if (!Number.isFinite(flatness + g)) throw new FlattenRefused('non-finite flatness');
    if (flatness + g <= tolerance) {
      emit([ox + p3[0], oy + p3[1]]);
      return;
    }
    if (depth >= P2_MAX_DEPTH) throw new FlattenRefused('depth limit');
    const p01 = mid(p0, p1);
    const p12 = mid(p1, p2);
    const p23 = mid(p2, p3);
    const p012 = mid(p01, p12);
    const p123 = mid(p12, p23);
    const m = mid(p012, p123);
    visit([p0, p01, p012, m], depth + 1);
    visit([m, p123, p23, p3], depth + 1);
  };
  visit(rel, 0);
}

// --- exact orient2d -------------------------------------------------------------------------------

const ERR_BOUND_A = (3 + 16 * EPSILON) * EPSILON;
const scratch = new DataView(new ArrayBuffer(8));

/** A finite binary64 as mantissa × 2^exponent, both exact. */
function decompose(x: number): [bigint, number] {
  if (x === 0) return [0n, 0];
  scratch.setFloat64(0, x);
  const hi = scratch.getUint32(0);
  const lo = scratch.getUint32(4);
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (biased !== 0) mantissa |= 1n << 52n;
  const exponent = (biased === 0 ? 1 : biased) - 1075;
  return [hi >>> 31 ? -mantissa : mantissa, exponent];
}

function exactSign(values: readonly number[]): number {
  const parts = values.map(decompose);
  const base = Math.min(...parts.map(([m, e]) => (m === 0n ? Infinity : e)));
  const v = parts.map(([m, e]) => (m === 0n ? 0n : m << BigInt(e - base)));
  const [ax, ay, bx, by, cx, cy] = v as [bigint, bigint, bigint, bigint, bigint, bigint];
  const det = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return det > 0n ? 1 : det < 0n ? -1 : 0;
}

/** The exact sign of orient2d(a, b, c): +1 counter-clockwise, -1 clockwise, 0 collinear. */
export function orient2dSign(a: Point, b: Point, c: Point): number {
  const left = (a[0] - c[0]) * (b[1] - c[1]);
  const right = (a[1] - c[1]) * (b[0] - c[0]);
  const det = left - right;
  const bound = ERR_BOUND_A * (Math.abs(left) + Math.abs(right));
  if (det > bound) return 1;
  if (-det > bound) return -1;
  return exactSign([a[0], a[1], b[0], b[1], c[0], c[1]]);
}

/** The first pair of polygon edges (in edge order) that cross properly, or null. */
export function properCrossing(contours: readonly (readonly Point[])[]): [number, number] | null {
  const edges: [Point, Point][] = [];
  for (const c of contours)
    if (c.length >= 2)
      for (let i = 0; i < c.length; i += 1) edges.push([c[i]!, c[(i + 1) % c.length]!]);
  // Sweep by minimum x; only pairs whose boxes overlap reach the predicate.
  const order = edges
    .map((e, i) => ({ i, minX: Math.min(e[0][0], e[1][0]), maxX: Math.max(e[0][0], e[1][0]) }))
    .sort((x, y) => x.minX - y.minX || x.i - y.i);
  let best: [number, number] | null = null;
  const active: typeof order = [];
  for (const cur of order) {
    for (let k = active.length - 1; k >= 0; k -= 1)
      if (active[k]!.maxX < cur.minX) active.splice(k, 1);
    const [a, b] = edges[cur.i]!;
    for (const other of active) {
      const [c, d] = edges[other.i]!;
      if (
        Math.max(a[1], b[1]) < Math.min(c[1], d[1]) ||
        Math.max(c[1], d[1]) < Math.min(a[1], b[1])
      )
        continue;
      const abc = orient2dSign(a, b, c);
      const abd = orient2dSign(a, b, d);
      if (abc === 0 || abd === 0 || abc === abd) continue;
      const cda = orient2dSign(c, d, a);
      const cdb = orient2dSign(c, d, b);
      if (cda === 0 || cdb === 0 || cda === cdb) continue;
      const pair: [number, number] = [Math.min(cur.i, other.i), Math.max(cur.i, other.i)];
      if (best === null || pair[0] < best[0] || (pair[0] === best[0] && pair[1] < best[1]))
        best = pair;
    }
    active.push(cur);
  }
  return best;
}

export type FillRejectionClass = Readonly<{
  outcome: string;
  /** Flat edges of the P2 polygon, or null when the mirror refused the path. */
  flatEdges: number | null;
  /** The first properly crossing edge pair, when the polygon has more than E edges. */
  crossing: readonly [number, number] | null;
  /** In the E14-Q1 class "fill `work-limit` on a self-crossing path over E". */
  e14SelfCrossingOverE: boolean;
  refused?: string;
}>;

/** Applies the E14-Q1 class test to one rejected fill request with its sweep outcome. */
export function classifyFillRejection(
  request: Pick<FillMeshRequest, 'verbs' | 'points' | 'toleranceExponent'>,
  outcome: string,
): FillRejectionClass {
  if (outcome !== 'failed:work-limit')
    return { outcome, flatEdges: null, crossing: null, e14SelfCrossingOverE: false };
  let contours: Point[][];
  try {
    contours = p2FillContours(request);
  } catch (error) {
    if (!(error instanceof FlattenRefused)) throw error;
    return {
      outcome,
      flatEdges: null,
      crossing: null,
      e14SelfCrossingOverE: false,
      refused: error.message,
    };
  }
  const flatEdges = contours.reduce((n, c) => n + (c.length >= 2 ? c.length : 0), 0);
  const crossing = flatEdges > E14_EXACT_EDGE_CAP ? properCrossing(contours) : null;
  return { outcome, flatEdges, crossing, e14SelfCrossingOverE: crossing !== null };
}
