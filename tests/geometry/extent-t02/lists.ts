import {
  pointTriangleDistanceSquared,
  segmentTriangleDistanceSquared,
} from '../coverage-oracle/exterior.js';
import {
  absolute,
  add,
  compare,
  div,
  mul,
  rational,
  sub,
  type Rational,
} from '../rounded-fill/exact.js';
import type { Q2 } from '../extent-t01/clip.js';
import type { Linear } from './clearance.js';
import { LIST_REACH_PX } from './epoch.js';

/**
 * P3.1p T02 per-triangle feature lists (P4) and the S5 list check
 * (docs/plans/p3-r2-tiling-contract.md). A feature is a boundary EDGE (record pair) or a boundary
 * VERTEX (record). A triangle lists every feature whose exact local ∞-norm distance to the closed
 * reference triangle is at most λ_L. S5 checks, at scale s_L, that every unlisted feature within
 * the pruning box reach is more than 13/8 physical px away.
 */

const ZERO = rational(0n);
const ONE = rational(1n);

export type Feature = Readonly<
  { kind: 'edge'; a: number; b: number } | { kind: 'vertex'; v: number }
>;

export type ListResult = Readonly<{
  /** Per triangle: indices into `features`, ascending. */
  lists: readonly (readonly number[])[];
  /** First triangle failing S5, or null. */
  failing: number | null;
  /** Unlisted (triangle, feature) pairs checked exactly by S5. */
  checked: number;
}>;

const minR = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const maxR = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);

/** Global feature order: edges by (a, b), then vertices by index (O02's order). */
export function featuresOf(
  edges: readonly (readonly [number, number])[],
  vertices: readonly number[],
): Feature[] {
  const sortedEdges = [...edges].sort((p, r) => p[0] - r[0] || p[1] - r[1]);
  return [
    ...sortedEdges.map(([a, b]) => ({ kind: 'edge' as const, a, b })),
    ...[...vertices].sort((p, r) => p - r).map((v) => ({ kind: 'vertex' as const, v })),
  ];
}

/** Exact ∞-norm distance from p to the closed segment ab. */
export function pointSegmentLinf(p: Q2, a: Q2, b: Q2): Rational {
  const ex = sub(a[0], p[0]);
  const ey = sub(a[1], p[1]);
  const dx = sub(b[0], a[0]);
  const dy = sub(b[1], a[1]);
  const g = (t: Rational) => maxR(absolute(add(ex, mul(t, dx))), absolute(add(ey, mul(t, dy))));
  const candidates: Rational[] = [ZERO, ONE];
  const root = (numerator: Rational, denominator: Rational) => {
    if (denominator.n === 0n) return;
    const t = div(numerator, denominator);
    if (compare(t, ZERO) >= 0 && compare(t, ONE) <= 0) candidates.push(t);
  };
  root(sub(ZERO, ex), dx);
  root(sub(ZERO, ey), dy);
  root(sub(ey, ex), sub(dx, dy));
  root(sub(sub(ZERO, ey), ex), add(dx, dy));
  return candidates.map(g).reduce(minR);
}

function orient(p: Q2, q: Q2, r: Q2): number {
  const value = sub(mul(sub(q[0], p[0]), sub(r[1], p[1])), mul(sub(q[1], p[1]), sub(r[0], p[0])));
  return value.n > 0n ? 1 : value.n < 0n ? -1 : 0;
}

function insideClosed(p: Q2, triangle: readonly [Q2, Q2, Q2]): boolean {
  const [a, b, c] = triangle;
  const s = orient(a, b, c);
  return (
    s !== 0 && orient(a, b, p) * s >= 0 && orient(b, c, p) * s >= 0 && orient(c, a, p) * s >= 0
  );
}

function segmentsMeet(a: Q2, b: Q2, c: Q2, d: Q2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  const within = (p: Q2, q: Q2, r: Q2) =>
    compare(r[0], p[0]) * compare(r[0], q[0]) <= 0 &&
    compare(r[1], p[1]) * compare(r[1], q[1]) <= 0;
  return (
    (o1 === 0 && within(a, b, c)) ||
    (o2 === 0 && within(a, b, d)) ||
    (o3 === 0 && within(c, d, a)) ||
    (o4 === 0 && within(c, d, b))
  );
}

/** Exact ∞-norm distance from a point or closed segment to a closed triangle. */
export function featureTriangleLinf(
  feature: readonly Q2[],
  triangle: readonly [Q2, Q2, Q2],
): Rational {
  const sides: [Q2, Q2][] = [
    [triangle[0], triangle[1]],
    [triangle[1], triangle[2]],
    [triangle[2], triangle[0]],
  ];
  if (feature.some((point) => insideClosed(point, triangle))) return ZERO;
  if (feature.length === 2 && sides.some(([p, r]) => segmentsMeet(feature[0]!, feature[1]!, p, r)))
    return ZERO;
  let best: Rational | null = null;
  for (const point of feature)
    for (const [p, r] of sides) {
      const value = pointSegmentLinf(point, p, r);
      best = best === null ? value : minR(best, value);
    }
  if (feature.length === 2)
    for (const vertex of triangle)
      best = minR(best!, pointSegmentLinf(vertex, feature[0]!, feature[1]!));
  return best!;
}

type Box = Readonly<{ x0: Rational; y0: Rational; x1: Rational; y1: Rational }>;

const boxOf = (points: readonly Q2[]): Box => ({
  x0: points.map((p) => p[0]).reduce(minR),
  y0: points.map((p) => p[1]).reduce(minR),
  x1: points.map((p) => p[0]).reduce(maxR),
  y1: points.map((p) => p[1]).reduce(maxR),
});

function boxGap(a: Box, b: Box): Rational {
  const gx = maxR(maxR(sub(b.x0, a.x1), sub(a.x0, b.x1)), ZERO);
  const gy = maxR(maxR(sub(b.y0, a.y1), sub(a.y0, b.y1)), ZERO);
  return maxR(gx, gy);
}

function floorShift(value: Rational, k: number): bigint {
  const scaled =
    k >= 0 ? rational(value.n, value.d << BigInt(k)) : rational(value.n << BigInt(-k), value.d);
  const quotient = scaled.n / scaled.d;
  return quotient * scaled.d !== scaled.n && scaled.n < 0n ? quotient - 1n : quotient;
}

function exponentAtLeast(value: Rational, floor: number): number {
  let k = floor;
  while (compare(k >= 0 ? rational(1n << BigInt(k)) : rational(1n, 1n << BigInt(-k)), value) < 0)
    k += 1;
  return k;
}

/**
 * Lists (P4) and S5 for the drawn triangles. `linear` is A0 exact; `sL` the level-band floor.
 * `cellExponent` is the bucketing grid's log2 size (the level L).
 */
export function buildLists(
  points: readonly Q2[],
  triangles: readonly (readonly [number, number, number])[],
  features: readonly Feature[],
  lambdaL: Rational,
  linear: Linear,
  sL: Rational,
  cellExponent: number,
): ListResult {
  const featurePoints = features.map((feature): Q2[] =>
    feature.kind === 'edge' ? [points[feature.a]!, points[feature.b]!] : [points[feature.v]!],
  );
  const exponent = exponentAtLeast(lambdaL, cellExponent);
  const buckets = new Map<string, number[]>();
  featurePoints.forEach((pts, index) => {
    const box = boxOf(pts);
    for (
      let i = floorShift(sub(box.x0, lambdaL), exponent);
      i <= floorShift(add(box.x1, lambdaL), exponent);
      i += 1n
    )
      for (
        let j = floorShift(sub(box.y0, lambdaL), exponent);
        j <= floorShift(add(box.y1, lambdaL), exponent);
        j += 1n
      ) {
        const key = `${i},${j}`;
        const list = buckets.get(key);
        if (list === undefined) buckets.set(key, [index]);
        else list.push(index);
      }
  });
  const [a, b, c, d] = linear;
  const map = (p: Q2): Q2 => [
    mul(sL, add(mul(a, p[0]), mul(c, p[1]))),
    mul(sL, add(mul(b, p[0]), mul(d, p[1]))),
  ];
  const limit2 = mul(LIST_REACH_PX, LIST_REACH_PX);
  const lists: number[][] = [];
  let failing: number | null = null;
  let checked = 0;
  triangles.forEach((ids, triangleIndex) => {
    const triangle = ids.map((id) => points[id]!) as unknown as [Q2, Q2, Q2];
    const box = boxOf(triangle);
    const candidates = new Set<number>();
    for (let i = floorShift(box.x0, exponent); i <= floorShift(box.x1, exponent); i += 1n)
      for (let j = floorShift(box.y0, exponent); j <= floorShift(box.y1, exponent); j += 1n)
        for (const index of buckets.get(`${i},${j}`) ?? []) candidates.add(index);
    const physical = triangle.map(map) as unknown as [Q2, Q2, Q2];
    const listed: number[] = [];
    for (const index of [...candidates].sort((p, r) => p - r)) {
      const pts = featurePoints[index]!;
      if (compare(boxGap(boxOf(pts), box), lambdaL) > 0) continue;
      if (compare(featureTriangleLinf(pts, triangle), lambdaL) <= 0) {
        listed.push(index);
        continue;
      }
      checked += 1;
      const mapped = pts.map(map);
      const distance2 =
        mapped.length === 2
          ? segmentTriangleDistanceSquared(mapped[0]!, mapped[1]!, physical)
          : pointTriangleDistanceSquared(mapped[0]!, physical);
      if (compare(distance2, limit2) <= 0 && failing === null) failing = triangleIndex;
    }
    lists.push(listed);
  });
  return { lists, failing, checked };
}

/** Max, p99 (nearest rank) and total list length. */
export function listStats(lists: readonly (readonly number[])[]): {
  max: number;
  p99: number;
  total: number;
} {
  const sizes = lists.map((list) => list.length).sort((p, r) => p - r);
  if (sizes.length === 0) return { max: 0, p99: 0, total: 0 };
  const rank = Math.max(1, Math.ceil(0.99 * sizes.length));
  return {
    max: sizes[sizes.length - 1]!,
    p99: sizes[rank - 1]!,
    total: sizes.reduce((s, v) => s + v, 0),
  };
}
