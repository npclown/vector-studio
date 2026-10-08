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
import type { Linear } from '../extent-t02/clearance.js';
import type { Epoch } from '../extent-t02/epoch.js';

/**
 * P3.1p T03 localized C2 (docs/plans/p3-r2-tiling-rev4-contract.md, D-A and D-B). Each instance is charged only its own points'
 * displacement bounds E_p instead of a global δ̄:
 *
 * - vertex pair (u, v): σ_lo²·|u − v|² > (E_u + E_v)²;
 * - edge pair (ab, cd): σ_lo²·dist² > (max(E_a, E_b) + max(E_c, E_d))², because a point of a
 *   segment moves at most its endpoints' larger bound under affine motion;
 * - triangle t: |det S|·ρ_t > 2·δ_t·σ̄max + 4·δ_t²/Plo_t, with δ_t its vertices' largest bound and
 *   Plo_t = ‖u‖∞ + ‖v‖∞ ≤ ‖u‖₂ + ‖v‖₂ (the per-pair form of M04's ratio algebra);
 * - wedge (v; a, b): the R0a margins with δ_w = max(E_v, E_a, E_b).
 *
 * Vertex and edge pairs farther apart (local ∞-norm boxes) than τ = 2·max E/σ_lo are pruned.
 */

const ZERO = rational(0n);
const ONE = rational(1n);
const TWO = rational(2n);
const FOUR = rational(4n);
const EIGHT = rational(8n);

export type C2Local = Readonly<{
  term: C2Term | null;
  failing: Readonly<Record<C2Term, boolean>>;
  /** Point indices of every failing instance. */
  failingPoints: ReadonlySet<number>;
}>;

const cross = (u: Q2, v: Q2) => sub(mul(u[0], v[1]), mul(u[1], v[0]));
const dot = (u: Q2, v: Q2) => add(mul(u[0], v[0]), mul(u[1], v[1]));
const l1 = (u: Q2) => add(absolute(u[0]), absolute(u[1]));
const linf = (u: Q2) =>
  compare(absolute(u[0]), absolute(u[1])) >= 0 ? absolute(u[0]) : absolute(u[1]);
const minus = (a: Q2, b: Q2): Q2 => [sub(a[0], b[0]), sub(a[1], b[1])];
const minR = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
const maxR = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);

function pointSegment2(p: Q2, a: Q2, b: Q2): Rational {
  const ab = minus(b, a);
  const ap = minus(p, a);
  const length2 = dot(ab, ab);
  let t = length2.n === 0n ? ZERO : div(dot(ap, ab), length2);
  if (compare(t, ZERO) < 0) t = ZERO;
  if (compare(t, ONE) > 0) t = ONE;
  const delta = minus(p, [add(a[0], mul(t, ab[0])), add(a[1], mul(t, ab[1]))]);
  return dot(delta, delta);
}

function segmentsIntersect(a: Q2, b: Q2, c: Q2, d: Q2): boolean {
  const o1 = sign(cross(minus(b, a), minus(c, a)));
  const o2 = sign(cross(minus(b, a), minus(d, a)));
  const o3 = sign(cross(minus(d, c), minus(a, c)));
  const o4 = sign(cross(minus(d, c), minus(b, c)));
  if (o1 !== o2 && o3 !== o4) return true;
  const between = (value: Rational, s: Rational, t: Rational) =>
    compare(value, minR(s, t)) >= 0 && compare(value, maxR(s, t)) <= 0;
  const on = (p: Q2, s: Q2, t: Q2) => between(p[0], s[0], t[0]) && between(p[1], s[1], t[1]);
  return (
    (o1 === 0 && on(c, a, b)) ||
    (o2 === 0 && on(d, a, b)) ||
    (o3 === 0 && on(a, c, d)) ||
    (o4 === 0 && on(b, c, d))
  );
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
  const p = (e: number) => (e >= 0 ? rational(1n << BigInt(e)) : rational(1n, 1n << BigInt(-e)));
  while (compare(p(k), value) < 0) k += 1;
  return k;
}
function candidatePairs(
  boxes: readonly Box[],
  reach: Rational,
  exponent: number,
): [number, number][] {
  const buckets = new Map<string, number[]>();
  boxes.forEach((box, index) => {
    for (
      let i = floorShift(sub(box.x0, reach), exponent);
      i <= floorShift(add(box.x1, reach), exponent);
      i += 1n
    )
      for (
        let j = floorShift(sub(box.y0, reach), exponent);
        j <= floorShift(add(box.y1, reach), exponent);
        j += 1n
      ) {
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
  return pairs.sort((p, r) => p[0] - r[0] || p[1] - r[1]);
}
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

export function c2Local(
  points: readonly Q2[],
  indices: readonly number[],
  linear: Linear,
  s: Rational,
  bounds: readonly Rational[],
  cellExponent: number,
): C2Local {
  const [a, b, c, d] = linear;
  const s2 = mul(s, s);
  const detS = absolute(mul(s2, sub(mul(a, d), mul(b, c))));
  const sigmaMax = sqrtUp(mul(s2, add(add(mul(a, a), mul(b, b)), add(mul(c, c), mul(d, d)))));
  const sigmaLo = div(detS, sigmaMax);
  const sigmaLo2 = mul(sigmaLo, sigmaLo);
  const used = [...new Set(indices)].sort((p, r) => p - r);
  const eMax = used.map((id) => bounds[id]!).reduce(maxR, ZERO);
  const tau = div(mul(TWO, eMax), sigmaLo);
  const exponent = tau.n === 0n ? cellExponent : exponentAtLeast(tau, cellExponent);
  const failing: Record<C2Term, boolean> = {
    vertex: false,
    edge: false,
    triangle: false,
    wedge: false,
  };
  const failingPoints = new Set<number>();
  const mark = (term: C2Term, ids: readonly number[]) => {
    failing[term] = true;
    for (const id of ids) failingPoints.add(id);
  };

  for (const [x, y] of candidatePairs(
    used.map((id) => boxOf([points[id]!])),
    tau,
    exponent,
  )) {
    const u = used[x]!;
    const v = used[y]!;
    const delta = minus(points[u]!, points[v]!);
    const e = add(bounds[u]!, bounds[v]!);
    if (compare(mul(sigmaLo2, dot(delta, delta)), mul(e, e)) <= 0) mark('vertex', [u, v]);
  }
  const edgeMap = new Map<string, readonly [number, number]>();
  for (let offset = 0; offset < indices.length; offset += 3)
    for (let k = 0; k < 3; k += 1) {
      const p = indices[offset + k]!;
      const r = indices[offset + ((k + 1) % 3)]!;
      edgeMap.set(p < r ? `${p},${r}` : `${r},${p}`, p < r ? [p, r] : [r, p]);
    }
  const edges = [...edgeMap.values()];
  for (const [x, y] of candidatePairs(
    edges.map(([p, r]) => boxOf([points[p]!, points[r]!])),
    tau,
    exponent,
  )) {
    const [p, r] = edges[x]!;
    const [u, v] = edges[y]!;
    if (p === u || p === v || r === u || r === v) continue;
    const [pa, pb, pc, pd] = [points[p]!, points[r]!, points[u]!, points[v]!];
    const distance2 = segmentsIntersect(pa, pb, pc, pd)
      ? ZERO
      : [
          pointSegment2(pa, pc, pd),
          pointSegment2(pb, pc, pd),
          pointSegment2(pc, pa, pb),
          pointSegment2(pd, pa, pb),
        ].reduce(minR);
    const e = add(maxR(bounds[p]!, bounds[r]!), maxR(bounds[u]!, bounds[v]!));
    if (compare(mul(sigmaLo2, distance2), mul(e, e)) <= 0) mark('edge', [p, r, u, v]);
  }
  for (let offset = 0; offset < indices.length; offset += 3) {
    const [i, j, k] = indices.slice(offset, offset + 3) as [number, number, number];
    const dt = maxR(maxR(bounds[i]!, bounds[j]!), bounds[k]!);
    // Any base vertex gives a sufficient condition; the triangle passes if one rotation passes.
    const passes = (
      [
        [i, j, k],
        [j, k, i],
        [k, i, j],
      ] as const
    ).some(([p0, p1, p2]) => {
      const u = minus(points[p1]!, points[p0]!);
      const v = minus(points[p2]!, points[p0]!);
      const plo = add(linf(u), linf(v));
      if (plo.n === 0n) return false;
      const rho = div(absolute(cross(u, v)), add(l1(u), l1(v)));
      const rhs = add(mul(mul(TWO, dt), sigmaMax), div(mul(FOUR, mul(dt, dt)), plo));
      return compare(mul(detS, rho), rhs) > 0;
    });
    if (!passes) mark('triangle', [i, j, k]);
  }
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
    const lengths = add(
      minR(sqrtUp(aa), mul(sigmaMax, l1(u))),
      minR(sqrtUp(bb), mul(sigmaMax, l1(v))),
    );
    const cr = absolute(cross(pa, pb));
    const wLo =
      sign(ab) <= 0
        ? sub(maxR(sqrtDown(mul(aa, bb)), sub(ZERO, ab)), ab)
        : div(mul(cr, cr), mul(TWO, sqrtUp(mul(aa, bb))));
    const dw = maxR(maxR(bounds[wedge.vertex]!, bounds[wedge.a]!), bounds[wedge.b]!);
    const crossSlack = sub(cr, add(mul(mul(TWO, dw), lengths), mul(FOUR, mul(dw, dw))));
    const wSlack = sub(wLo, add(mul(mul(FOUR, dw), lengths), mul(EIGHT, mul(dw, dw))));
    if (sign(maxR(crossSlack, wSlack)) <= 0) mark('wedge', [wedge.vertex, wedge.a, wedge.b]);
  }
  const order: C2Term[] = ['vertex', 'edge', 'triangle', 'wedge'];
  return { term: order.find((name) => failing[name]) ?? null, failing, failingPoints };
}

/**
 * Sub-band k of K equal-width parts of the epoch's lane interval (zqLo, zqHi] that contains the
 * frame's zq; s_lo and s_hi are recomputed with the same 2^-22 slack. Lists and fringe reach keep
 * the level-band floor s_L.
 */
export function subBand(
  epoch: Epoch,
  K: number,
  zq: Rational = epoch.zq,
): Epoch & { band: number } {
  const width = div(sub(epoch.zqHi, epoch.zqLo), rational(BigInt(K)));
  let k = 0;
  while (k < K - 1 && compare(zq, add(epoch.zqLo, mul(rational(BigInt(k + 1)), width))) > 0) k += 1;
  const lo = add(epoch.zqLo, mul(rational(BigInt(k)), width));
  const hi = add(lo, width);
  const slack = rational(1n, 1n << 22n);
  return {
    ...epoch,
    zqLo: lo,
    zqHi: hi,
    sLo: mul(lo, sub(ONE, slack)),
    sHi: mul(hi, add(ONE, slack)),
    band: k,
  };
}
