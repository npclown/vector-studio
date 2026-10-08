import { describe, expect, it } from 'vitest';

import { q, sqrtUp } from './position-certificate/certificate.js';
import { loadFixtureRows } from './position-certificate/corpus.js';
import { add, compare, div, mul, rational, sub, type Rational } from './rounded-fill/exact.js';
import type { Q2 } from './extent-t01/clip.js';
import { exteriorWedgesQ } from './extent-t01/core.js';
import { c2Merged, type Linear } from './extent-t02/clearance.js';
import { epochOf } from './extent-t02/epoch.js';
import { syntheticRows } from './extent-t01/synthetic.js';
import { c2Local, subBand } from './extent-t03/local.js';

/**
 * P3.1p T03 host tests for D-A (localized C2) and D-B (sub-bands)
 * (docs/plans/p3-r2-tiling-rev4-contract.md, "Host tests").
 */

const DELTAS = [
  rational(1n, 1n << 20n),
  rational(1n, 4096n),
  rational(1n, 256n),
  rational(1n, 64n),
  rational(1n, 16n),
  rational(1n, 4n),
];

function exponentFor(points: readonly Q2[]): number {
  let span = rational(1n);
  for (const point of points)
    for (const value of point) {
      const magnitude = value.n < 0n ? rational(-value.n, value.d) : value;
      if (compare(magnitude, span) > 0) span = magnitude;
    }
  let k = 0;
  while (compare(rational(1n << BigInt(k)), span) < 0) k += 1;
  return k + 1;
}

/** Varying per-point bounds: δ·(1 + (p mod 3)/4). */
const boundsFor = (count: number, delta: Rational) =>
  Array.from({ length: count }, (_, p) =>
    mul(delta, add(rational(1n), rational(BigInt(p % 3), 4n))),
  );

function fixtures() {
  return loadFixtureRows()
    .map((row) => row.input)
    .filter((input) => input.mesh.indices.length <= 3 * 48);
}

/**
 * Unpruned oracle for D-A: every used vertex pair, every non-adjacent edge pair, every triangle
 * (three rotations), every exterior wedge; written independently of local.ts's bucketing.
 */
function oracle(
  points: readonly Q2[],
  indices: readonly number[],
  linear: Linear,
  s: Rational,
  bounds: readonly Rational[],
): { term: string | null; failing: Record<string, boolean>; failingPoints: number[] } {
  const zero = rational(0n);
  const two = rational(2n);
  const four = rational(4n);
  const eight = rational(8n);
  const abs = (x: Rational) => (x.n < 0n ? rational(-x.n, x.d) : x);
  const max = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);
  const min = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);
  const minus = (a: Q2, b: Q2): Q2 => [sub(a[0], b[0]), sub(a[1], b[1])];
  const dot = (u: Q2, v: Q2) => add(mul(u[0], v[0]), mul(u[1], v[1]));
  const cross = (u: Q2, v: Q2) => sub(mul(u[0], v[1]), mul(u[1], v[0]));
  const l1 = (u: Q2) => add(abs(u[0]), abs(u[1]));
  const linf = (u: Q2) => max(abs(u[0]), abs(u[1]));
  const segPoint2 = (p: Q2, a: Q2, b: Q2) => {
    const ab = minus(b, a);
    const len = dot(ab, ab);
    let t = len.n === 0n ? zero : div(dot(minus(p, a), ab), len);
    t = min(max(t, zero), rational(1n));
    const d = minus(p, [add(a[0], mul(t, ab[0])), add(a[1], mul(t, ab[1]))]);
    return dot(d, d);
  };
  const orient = (a: Q2, b: Q2, c: Q2) => {
    const v = cross(minus(b, a), minus(c, a));
    return v.n > 0n ? 1 : v.n < 0n ? -1 : 0;
  };
  const between = (v: Rational, a: Rational, b: Rational) =>
    compare(v, min(a, b)) >= 0 && compare(v, max(a, b)) <= 0;
  const onSeg = (p: Q2, a: Q2, b: Q2) => between(p[0], a[0], b[0]) && between(p[1], a[1], b[1]);
  const meet = (a: Q2, b: Q2, c: Q2, d: Q2) => {
    const [o1, o2, o3, o4] = [orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)];
    if (o1 !== o2 && o3 !== o4) return true;
    return (
      (o1 === 0 && onSeg(c, a, b)) ||
      (o2 === 0 && onSeg(d, a, b)) ||
      (o3 === 0 && onSeg(a, c, d)) ||
      (o4 === 0 && onSeg(b, c, d))
    );
  };
  const [a, b, c, d] = linear;
  const s2 = mul(s, s);
  const detS = abs(mul(s2, sub(mul(a, d), mul(b, c))));
  const sigmaMax = sqrtUp(mul(s2, add(add(mul(a, a), mul(b, b)), add(mul(c, c), mul(d, d)))));
  const sigmaLo = div(detS, sigmaMax);
  const sl2 = mul(sigmaLo, sigmaLo);
  const failing: Record<string, boolean> = {
    vertex: false,
    edge: false,
    triangle: false,
    wedge: false,
  };
  const failingPoints = new Set<number>();
  const used = [...new Set(indices)];
  for (let i = 0; i < used.length; i += 1)
    for (let j = i + 1; j < used.length; j += 1) {
      const u = used[i]!;
      const v = used[j]!;
      const delta = minus(points[u]!, points[v]!);
      const e = add(bounds[u]!, bounds[v]!);
      if (compare(mul(sl2, dot(delta, delta)), mul(e, e)) <= 0) {
        failing.vertex = true;
        failingPoints.add(u).add(v);
      }
    }
  const edges = new Map<string, [number, number]>();
  for (let o = 0; o < indices.length; o += 3)
    for (let k = 0; k < 3; k += 1) {
      const p = indices[o + k]!;
      const q2 = indices[o + ((k + 1) % 3)]!;
      edges.set(p < q2 ? `${p},${q2}` : `${q2},${p}`, p < q2 ? [p, q2] : [q2, p]);
    }
  const list = [...edges.values()];
  for (let i = 0; i < list.length; i += 1)
    for (let j = i + 1; j < list.length; j += 1) {
      const [p, r] = list[i]!;
      const [u, v] = list[j]!;
      if (p === u || p === v || r === u || r === v) continue;
      const [pa, pb, pc, pd] = [points[p]!, points[r]!, points[u]!, points[v]!];
      const dist = meet(pa, pb, pc, pd)
        ? zero
        : [
            segPoint2(pa, pc, pd),
            segPoint2(pb, pc, pd),
            segPoint2(pc, pa, pb),
            segPoint2(pd, pa, pb),
          ].reduce(min);
      const e = add(max(bounds[p]!, bounds[r]!), max(bounds[u]!, bounds[v]!));
      if (compare(mul(sl2, dist), mul(e, e)) <= 0) {
        failing.edge = true;
        for (const id of [p, r, u, v]) failingPoints.add(id);
      }
    }
  for (let o = 0; o < indices.length; o += 3) {
    const tri = [indices[o]!, indices[o + 1]!, indices[o + 2]!];
    const dt = tri.map((id) => bounds[id]!).reduce(max);
    const ok = [0, 1, 2].some((r0) => {
      const [p0, p1, p2] = [tri[r0]!, tri[(r0 + 1) % 3]!, tri[(r0 + 2) % 3]!];
      const u = minus(points[p1]!, points[p0]!);
      const v = minus(points[p2]!, points[p0]!);
      const plo = add(linf(u), linf(v));
      if (plo.n === 0n) return false;
      const lhs = div(mul(detS, abs(cross(u, v))), add(l1(u), l1(v)));
      return compare(lhs, add(mul(mul(two, dt), sigmaMax), div(mul(four, mul(dt, dt)), plo))) > 0;
    });
    if (!ok) {
      failing.triangle = true;
      for (const id of tri) failingPoints.add(id);
    }
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
      min(sqrtUp(aa), mul(sigmaMax, l1(u))),
      min(sqrtUp(bb), mul(sigmaMax, l1(v))),
    );
    const cr = abs(cross(pa, pb));
    const wLo =
      ab.n <= 0n
        ? sub(max(sqrtDownOracle(mul(aa, bb)), sub(zero, ab)), ab)
        : div(mul(cr, cr), mul(two, sqrtUp(mul(aa, bb))));
    const dw = [wedge.vertex, wedge.a, wedge.b].map((id) => bounds[id]!).reduce(max);
    const crossSlack = sub(cr, add(mul(mul(two, dw), lengths), mul(four, mul(dw, dw))));
    const wSlack = sub(wLo, add(mul(mul(four, dw), lengths), mul(eight, mul(dw, dw))));
    if (max(crossSlack, wSlack).n <= 0n) {
      failing.wedge = true;
      for (const id of [wedge.vertex, wedge.a, wedge.b]) failingPoints.add(id);
    }
  }
  const term = ['vertex', 'edge', 'triangle', 'wedge'].find((name) => failing[name]) ?? null;
  return { term, failing, failingPoints: [...failingPoints].sort((x, y) => x - y) };
}

function sqrtDownOracle(value: Rational): Rational {
  if (value.n <= 0n) return rational(0n);
  const scaled = (value.n << 128n) / value.d;
  if (scaled === 0n) return rational(0n);
  let root = 1n;
  while (root * root <= scaled) root <<= 1n;
  let lo = root >> 1n;
  let hi = root;
  while (hi - lo > 1n) {
    const mid = (lo + hi) >> 1n;
    if (mid * mid <= scaled) lo = mid;
    else hi = mid;
  }
  return rational(lo, 1n << 64n);
}

describe('P3.1p T03 localized C2 (D-A)', () => {
  it('pruned c2Local equals the unpruned oracle at sub-band s_lo with varying bounds and real exponents', () => {
    let compared = 0;
    let failures = 0;
    for (const input of fixtures()) {
      const epoch = epochOf(input);
      if (epoch === null) continue;
      const points = input.mesh.vertices.map((v) => [q(v[0]), q(v[1])] as Q2);
      const linear = input.affine.slice(0, 4).map(q) as unknown as Linear;
      for (const k of [0, 3]) {
        const width = div(sub(epoch.zqHi, epoch.zqLo), rational(4n));
        const band = subBand(epoch, 4, add(epoch.zqLo, mul(rational(BigInt(k + 1)), width)));
        for (const delta of DELTAS.slice(1, 5)) {
          const bounds = boundsFor(points.length, delta);
          let expected;
          try {
            expected = oracle(points, input.mesh.indices, linear, band.sLo, bounds);
          } catch (error) {
            expect(() =>
              c2Local(points, input.mesh.indices, linear, band.sLo, bounds, epoch.L),
            ).toThrow((error as Error).message);
            continue;
          }
          for (const exponent of [exponentFor(points), exponentFor(points) - 4]) {
            const actual = c2Local(points, input.mesh.indices, linear, band.sLo, bounds, exponent);
            expect(actual.term).toBe(expected.term);
            expect(actual.failing).toEqual(expected.failing);
            expect([...actual.failingPoints].sort((x, y) => x - y)).toEqual(expected.failingPoints);
          }
          compared += 1;
          if (expected.term !== null) failures += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(300);
    expect(failures).toBeGreaterThan(30);
  }, 60_000);

  it('dominates the global c2Merged at δ = max E_p with varying per-point bounds', () => {
    let admittedGlobal = 0;
    let strictlyMore = 0;
    for (const input of fixtures()) {
      const points = input.mesh.vertices.map((v) => [q(v[0]), q(v[1])] as Q2);
      const linear = input.affine.slice(0, 4).map(q) as unknown as Linear;
      const s = mul(q(input.zoom), q(input.dpr));
      for (const delta of DELTAS) {
        const bounds = boundsFor(points.length, delta);
        const used = [...new Set(input.mesh.indices)];
        const eMax = used.map((id) => bounds[id]!).reduce((m, v) => (compare(v, m) > 0 ? v : m));
        let global;
        try {
          global = c2Merged(
            points,
            input.mesh.indices,
            linear,
            s,
            mul(eMax, eMax),
            exponentFor(points),
          );
        } catch {
          continue;
        }
        const local = c2Local(points, input.mesh.indices, linear, s, bounds, exponentFor(points));
        if (global.term === null) {
          admittedGlobal += 1;
          expect(local.term).toBeNull();
        } else if (local.term === null) strictlyMore += 1;
      }
    }
    expect(admittedGlobal).toBeGreaterThan(300);
    expect(strictlyMore).toBeGreaterThan(0);
  }, 60_000);

  it('the triangle term passes when one rotation passes even if the first-vertex rotation fails', () => {
    // A long thin triangle: from the sharp vertex, ‖u‖₁ + ‖v‖₁ is large; from a blunt vertex the
    // short edge keeps it small, so ρ_t is larger there.
    const points: Q2[] = [
      [rational(0n), rational(0n)],
      [rational(64n), rational(0n)],
      [rational(64n), rational(1n)],
    ];
    const identity: Linear = [rational(1n), rational(0n), rational(0n), rational(1n)];
    const s = rational(1n);
    const at = (delta: Rational) =>
      c2Local(
        points,
        [0, 1, 2],
        identity,
        s,
        points.map(() => delta),
        8,
      );
    // Find δ where the sharp-vertex rotation alone would fail but the best rotation passes.
    const rho = (u: Q2, v: Q2) => {
      const cross = add(mul(u[0], v[1]), mul(rational(-1n), mul(u[1], v[0])));
      const abs = cross.n < 0n ? rational(-cross.n, cross.d) : cross;
      const l1 = (w: Q2) =>
        add(
          w[0].n < 0n ? rational(-w[0].n, w[0].d) : w[0],
          w[1].n < 0n ? rational(-w[1].n, w[1].d) : w[1],
        );
      return div(abs, add(l1(u), l1(v)));
    };
    const sharp = rho([rational(64n), rational(0n)], [rational(64n), rational(1n)]);
    const blunt = rho([rational(0n), rational(1n)], [rational(-64n), rational(-1n)]);
    expect(compare(blunt, sharp)).toBeGreaterThan(0);
    // δ = 1/4 at s = 1, identity (σ̄max = √2, |det S| = 1): the sharp-vertex rotation needs
    // ρ = 64/129 > 2δ√2 + 4δ²/128 ≈ 0.709 and fails; the blunt-vertex rotation needs
    // ρ = 64/66 > 2δ√2 + 4δ²/65 ≈ 0.711 and passes.
    expect(compare(sharp, rational(709n, 1000n))).toBeLessThan(0);
    expect(compare(blunt, rational(712n, 1000n))).toBeGreaterThan(0);
    expect(at(rational(1n, 4n)).failing.triangle).toBe(false);
    expect(at(rational(1n, 2n)).failing.triangle).toBe(true);
  });
});

describe('P3.1p T03 sub-bands (D-B)', () => {
  it('tile the epoch interval; a frame on an inner bound goes to the lower sub-band', () => {
    const base = epochOf(syntheticRows().rows[5]!.input)!;
    const width = div(add(base.zqHi, mul(rational(-1n), base.zqLo)), rational(4n));
    let previousHi = base.zqLo;
    for (let k = 0; k < 4; k += 1) {
      const inner = add(base.zqLo, mul(rational(BigInt(k + 1)), width));
      const band = subBand(base, 4, inner);
      expect(band.band).toBe(k);
      expect(compare(band.zqLo, previousHi)).toBe(0);
      expect(compare(band.zqHi, inner)).toBe(0);
      previousHi = band.zqHi;
      const justAbove = add(inner, rational(1n, 1n << 80n));
      if (k < 3) expect(subBand(base, 4, justAbove).band).toBe(k + 1);
    }
    expect(compare(previousHi, base.zqHi)).toBe(0);
  });
});
