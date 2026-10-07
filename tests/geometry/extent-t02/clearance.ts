import { sqrtUp } from '../position-certificate/certificate.js';
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
import type { Q2 } from '../extent-t01/clip.js';
import { exteriorWedgesQ, type C2Term } from '../extent-t01/core.js';

/**
 * P3.1p T02 S3: M04/R0a C2 (extent-t01 core.ts c2Q) on the merged mesh at an exact rational scale
 * s, with exact pruning of vertex and edge pairs (docs/plans/p3-r2-tiling-contract.md, S3). A pair
 * whose local ∞-norm boxes are more than τ = 2δ̄/σ_lo apart has Euclidean distance above τ and
 * cannot fail its term; triangle, fan-length and wedge terms are never pruned. Pass/fail and the
 * failing term equal c2Q's; the host test asserts this on brute force.
 */

const ZERO = rational(0n);
const ONE = rational(1n);
const TWO = rational(2n);
const FOUR = rational(4n);
const EIGHT = rational(8n);

export type Linear = readonly [Rational, Rational, Rational, Rational];

export type C2Merged = Readonly<{
  term: C2Term | null;
  failing: Readonly<Record<C2Term, boolean>>;
  /** Smallest slack per term over the evaluated (unpruned) instances; null when none. */
  slacks: Readonly<Record<C2Term, Rational | null>>;
  /**
   * Point indices of every failing instance (vertex and edge pairs, triangles, wedges), for the
   * sliver predicate; `unlocated` is true when a failure has no instance locus (undefined RHS).
   */
  failingPoints: ReadonlySet<number>;
  unlocated: boolean;
}>;

const cross = (u: Q2, v: Q2) => sub(mul(u[0], v[1]), mul(u[1], v[0]));
const dot = (u: Q2, v: Q2) => add(mul(u[0], v[0]), mul(u[1], v[1]));
const l1 = (u: Q2) => add(absolute(u[0]), absolute(u[1]));
const linf = (u: Q2) =>
  compare(absolute(u[0]), absolute(u[1])) >= 0 ? absolute(u[0]) : absolute(u[1]);
const minus = (a: Q2, b: Q2): Q2 => [sub(a[0], b[0]), sub(a[1], b[1])];
const minOf = (left: Rational | null, right: Rational): Rational =>
  left === null || compare(right, left) < 0 ? right : left;
const minR = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const maxR = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);

function pointSegment2(p: Q2, a: Q2, b: Q2): Rational {
  const ab = minus(b, a);
  const ap = minus(p, a);
  const length2 = dot(ab, ab);
  let t = length2.n === 0n ? ZERO : div(dot(ap, ab), length2);
  if (compare(t, ZERO) < 0) t = ZERO;
  if (compare(t, ONE) > 0) t = ONE;
  const closest: Q2 = [add(a[0], mul(t, ab[0])), add(a[1], mul(t, ab[1]))];
  const delta = minus(p, closest);
  return dot(delta, delta);
}

function segmentsIntersect(a: Q2, b: Q2, c: Q2, d: Q2): boolean {
  const o1 = sign(cross(minus(b, a), minus(c, a)));
  const o2 = sign(cross(minus(b, a), minus(d, a)));
  const o3 = sign(cross(minus(d, c), minus(a, c)));
  const o4 = sign(cross(minus(d, c), minus(b, c)));
  if (o1 !== o2 && o3 !== o4) return true;
  const between = (value: Rational, s: Rational, t: Rational) =>
    compare(value, compare(s, t) < 0 ? s : t) >= 0 &&
    compare(value, compare(s, t) > 0 ? s : t) <= 0;
  const onSegment = (p: Q2, s: Q2, t: Q2) => between(p[0], s[0], t[0]) && between(p[1], s[1], t[1]);
  return (
    (o1 === 0 && onSegment(c, a, b)) ||
    (o2 === 0 && onSegment(d, a, b)) ||
    (o3 === 0 && onSegment(a, c, d)) ||
    (o4 === 0 && onSegment(b, c, d))
  );
}

function edgeDistance2(pa: Q2, pb: Q2, pc: Q2, pd: Q2): Rational {
  if (segmentsIntersect(pa, pb, pc, pd)) return ZERO;
  return [
    pointSegment2(pa, pc, pd),
    pointSegment2(pb, pc, pd),
    pointSegment2(pc, pa, pb),
    pointSegment2(pd, pa, pb),
  ].reduce((best, value) => (compare(value, best) < 0 ? value : best));
}

type Box = Readonly<{ x0: Rational; y0: Rational; x1: Rational; y1: Rational }>;

const boxOf = (points: readonly Q2[]): Box => ({
  x0: points.map((p) => p[0]).reduce(minR),
  y0: points.map((p) => p[1]).reduce(minR),
  x1: points.map((p) => p[0]).reduce(maxR),
  y1: points.map((p) => p[1]).reduce(maxR),
});

/** ∞-norm gap between two boxes (0 when they overlap). */
function boxGap(a: Box, b: Box): Rational {
  const gx = maxR(maxR(sub(b.x0, a.x1), sub(a.x0, b.x1)), ZERO);
  const gy = maxR(maxR(sub(b.y0, a.y1), sub(a.y0, b.y1)), ZERO);
  return maxR(gx, gy);
}

/** Smallest power of two 2^k ≥ value (value > 0). */
function pow2Ceil(value: Rational): number {
  let k = value.n.toString(2).length - value.d.toString(2).length;
  const p = (e: number) => (e >= 0 ? rational(1n << BigInt(e)) : rational(1n, 1n << BigInt(-e)));
  while (compare(p(k), value) < 0) k += 1;
  while (compare(p(k - 1), value) >= 0) k -= 1;
  return k;
}

function floorShift(value: Rational, k: number): bigint {
  const scaled =
    k >= 0 ? rational(value.n, value.d << BigInt(k)) : rational(value.n << BigInt(-k), value.d);
  const quotient = scaled.n / scaled.d;
  return quotient * scaled.d !== scaled.n && scaled.n < 0n ? quotient - 1n : quotient;
}

/** Pairs (i < j) of items whose boxes may lie within `reach` (∞-norm), via a power-of-two grid. */
function candidatePairs(
  boxes: readonly Box[],
  reach: Rational,
  cellExponent: number,
): [number, number][] {
  const buckets = new Map<string, number[]>();
  boxes.forEach((box, index) => {
    const i0 = floorShift(sub(box.x0, reach), cellExponent);
    const i1 = floorShift(add(box.x1, reach), cellExponent);
    const j0 = floorShift(sub(box.y0, reach), cellExponent);
    const j1 = floorShift(add(box.y1, reach), cellExponent);
    if ((i1 - i0 + 1n) * (j1 - j0 + 1n) > 64n) throw new Error('prune:bucket-span');
    for (let i = i0; i <= i1; i += 1n)
      for (let j = j0; j <= j1; j += 1n) {
        const key = `${i},${j}`;
        const list = buckets.get(key);
        if (list === undefined) buckets.set(key, [index]);
        else list.push(index);
      }
  });
  const seen = new Set<string>();
  const pairs: [number, number][] = [];
  for (const list of buckets.values())
    for (let x = 0; x < list.length; x += 1)
      for (let y = x + 1; y < list.length; y += 1) {
        const a = Math.min(list[x]!, list[y]!);
        const b = Math.max(list[x]!, list[y]!);
        const key = `${a},${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (compare(boxGap(boxes[a]!, boxes[b]!), reach) <= 0) pairs.push([a, b]);
      }
  pairs.sort((p, r) => p[0] - r[0] || p[1] - r[1]);
  return pairs;
}

/** floor(sqrt(floor(v · 2^128))) / 2^64 (wedge.ts sqrtDown). */
function sqrtDown(value: Rational): Rational {
  if (value.n <= 0n) return ZERO;
  const scaled = (value.n << 128n) / value.d;
  if (scaled === 0n) return ZERO;
  let root = 1n << BigInt(Math.ceil(scaled.toString(2).length / 2));
  for (;;) {
    const next = (root + scaled / root) / 2n;
    if (next >= root) break;
    root = next;
  }
  while (root * root > scaled) root -= 1n;
  while ((root + 1n) * (root + 1n) <= scaled) root += 1n;
  return rational(root, 1n << 64n);
}

/**
 * C2 on `points`/flat `indices` at local-to-physical map s·A0 (A0 exact, s exact rational).
 * `cellExponent` is the pruning grid's log2 cell size (the tiling level L); it must satisfy
 * 2^cellExponent ≥ τ, otherwise a finer grid is used.
 */
export function c2Merged(
  points: readonly Q2[],
  indices: readonly number[],
  linear: Linear,
  s: Rational,
  delta2: Rational,
  cellExponent: number,
): C2Merged {
  const [a, b, c, d] = linear;
  const s2 = mul(s, s);
  const detS = absolute(mul(s2, sub(mul(a, d), mul(b, c))));
  const sigmaMax = sqrtUp(mul(s2, add(add(mul(a, a), mul(b, b)), add(mul(c, c), mul(d, d)))));
  const sigmaLo = div(detS, sigmaMax);
  const sigmaLo2 = mul(sigmaLo, sigmaLo);
  const deltaBar = sqrtUp(delta2);
  const delta2Bar = mul(deltaBar, deltaBar);
  const fourDelta2 = mul(FOUR, delta2Bar);
  const tau = div(mul(TWO, deltaBar), sigmaLo);
  const exponent = tau.n === 0n ? cellExponent : Math.max(cellExponent, pow2Ceil(tau));

  const used = [...new Set(indices)].sort((left, right) => left - right);
  const edgeMap = new Map<string, readonly [number, number]>();
  const adjacency = new Map<number, number[]>();
  for (let offset = 0; offset < indices.length; offset += 3) {
    const tri = indices.slice(offset, offset + 3);
    for (let k = 0; k < 3; k += 1) {
      const p = tri[k]!;
      const r = tri[(k + 1) % 3]!;
      const key = p < r ? `${p},${r}` : `${r},${p}`;
      if (edgeMap.has(key)) continue;
      edgeMap.set(key, p < r ? [p, r] : [r, p]);
      for (const [from, to] of [
        [p, r],
        [r, p],
      ] as const) {
        const list = adjacency.get(from);
        if (list === undefined) adjacency.set(from, [to]);
        else list.push(to);
      }
    }
  }
  const edges = [...edgeMap.values()];

  const failingPoints = new Set<number>();
  let unlocated = false;
  const failsPair = (distance2: Rational) => sub(mul(sigmaLo2, distance2), fourDelta2).n <= 0n;
  // Vertex term (pruned).
  let dV2: Rational | null = null;
  const vertexBoxes = used.map((index) => boxOf([points[index]!]));
  for (const [x, y] of candidatePairs(vertexBoxes, tau, exponent)) {
    const delta = minus(points[used[x]!]!, points[used[y]!]!);
    dV2 = minOf(dV2, dot(delta, delta));
    if (failsPair(dot(delta, delta))) {
      failingPoints.add(used[x]!);
      failingPoints.add(used[y]!);
    }
  }
  // Edge term (pruned).
  let dE2: Rational | null = null;
  const edgeBoxes = edges.map(([p, r]) => boxOf([points[p]!, points[r]!]));
  for (const [x, y] of candidatePairs(edgeBoxes, tau, exponent)) {
    const [p, r] = edges[x]!;
    const [u, v] = edges[y]!;
    if (p === u || p === v || r === u || r === v) continue;
    const distance2 = edgeDistance2(points[p]!, points[r]!, points[u]!, points[v]!);
    dE2 = minOf(dE2, distance2);
    if (failsPair(distance2)) for (const id of [p, r, u, v]) failingPoints.add(id);
  }
  // Triangle term and plo (never pruned).
  let rhoBar: Rational | null = null;
  let plo: Rational | null = null;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const [i, j, k] = indices.slice(offset, offset + 3) as [number, number, number];
    const u = minus(points[j]!, points[i]!);
    const v = minus(points[k]!, points[i]!);
    rhoBar = minOf(rhoBar, div(absolute(cross(u, v)), add(l1(u), l1(v))));
    plo = minOf(plo, add(linf(u), linf(v)));
  }
  for (const vertex of used) {
    const rays = (adjacency.get(vertex) ?? []).map((other) =>
      linf(minus(points[other]!, points[vertex]!)),
    );
    if (rays.length < 2) continue;
    const sorted = [...rays].sort((left, right) => compare(left, right));
    plo = minOf(plo, add(sorted[0]!, sorted[1]!));
  }

  const failing: Record<C2Term, boolean> = {
    vertex: false,
    edge: false,
    triangle: false,
    wedge: false,
  };
  const slacks: Record<C2Term, Rational | null> = {
    vertex: null,
    edge: null,
    triangle: null,
    wedge: null,
  };
  if (dV2 !== null) {
    slacks.vertex = sub(mul(sigmaLo2, dV2), fourDelta2);
    failing.vertex = slacks.vertex.n <= 0n;
  }
  if (dE2 !== null) {
    slacks.edge = sub(mul(sigmaLo2, dE2), fourDelta2);
    failing.edge = slacks.edge.n <= 0n;
  }
  if (rhoBar !== null) {
    const rhs =
      plo === null || plo.n === 0n
        ? null
        : add(mul(mul(TWO, deltaBar), sigmaMax), div(fourDelta2, plo));
    if (rhs === null) {
      failing.triangle = true;
      unlocated = true;
    } else {
      slacks.triangle = sub(mul(detS, rhoBar), rhs);
      failing.triangle = slacks.triangle.n <= 0n;
      if (failing.triangle)
        for (let offset = 0; offset < indices.length; offset += 3) {
          const [i, j, k] = indices.slice(offset, offset + 3) as [number, number, number];
          const u = minus(points[j]!, points[i]!);
          const v = minus(points[k]!, points[i]!);
          const rho = div(absolute(cross(u, v)), add(l1(u), l1(v)));
          if (sub(mul(detS, rho), rhs).n <= 0n) for (const id of [i, j, k]) failingPoints.add(id);
        }
    }
  }
  // Wedge term (wedge.ts, at rational scale s).
  const map = (w: Q2): Q2 => [
    mul(s, add(mul(a, w[0]), mul(c, w[1]))),
    mul(s, add(mul(b, w[0]), mul(d, w[1]))),
  ];
  for (const wedge of exteriorWedgesQ(points, indices)) {
    const u = minus(points[wedge.a]!, points[wedge.vertex]!);
    const v = minus(points[wedge.b]!, points[wedge.vertex]!);
    const pa = map(u);
    const pb = map(v);
    const aa = dot(pa, pa);
    const bb = dot(pb, pb);
    const ab = dot(pa, pb);
    const lengthA = minR(sqrtUp(aa), mul(sigmaMax, l1(u)));
    const lengthB = minR(sqrtUp(bb), mul(sigmaMax, l1(v)));
    const lengths = add(lengthA, lengthB);
    const cr = absolute(cross(pa, pb));
    const wLo =
      sign(ab) <= 0
        ? sub(maxR(sqrtDown(mul(aa, bb)), sub(ZERO, ab)), ab)
        : div(mul(cr, cr), mul(TWO, sqrtUp(mul(aa, bb))));
    const crossSlack = sub(cr, add(mul(mul(TWO, deltaBar), lengths), fourDelta2));
    const wSlack = sub(wLo, add(mul(mul(FOUR, deltaBar), lengths), mul(EIGHT, delta2Bar)));
    const slack = maxR(crossSlack, wSlack);
    if (sign(slack) <= 0) {
      failing.wedge = true;
      for (const id of [wedge.vertex, wedge.a, wedge.b]) failingPoints.add(id);
    }
    slacks.wedge = minOf(slacks.wedge, slack);
  }
  const order: C2Term[] = ['vertex', 'edge', 'triangle', 'wedge'];
  return {
    term: order.find((name) => failing[name]) ?? null,
    failing,
    slacks,
    failingPoints,
    unlocated,
  };
}
