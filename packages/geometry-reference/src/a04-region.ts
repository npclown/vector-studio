import { classifyStrokeSource } from './stroke-region.js';

// D9 E3 unit E3-U2: the independent A04 oracle of docs/plans/d9-e3-b4-precision-contract.md,
// section 4 (with the section 14 annex, which records every executable choice this module makes).
//
// Inputs are only the case of E3-K1 (the canonical corpus object of section 13.2) and the drawn
// triangles with their mapped physical positions (E3-K2, the mesh `M*`). Nothing here imports
// from geometry-wasm, renderer-core or renderer-webgpu, and no kernel intermediate is read.
//
// Arithmetic discipline (section 4.1):
// - Every predicate on membership, orientation, winding and incidence is exact: binary64 inputs
//   become BigInt rationals, real roots are isolated by Sturm sequences, and the sign of a
//   polynomial at an isolated root is decided by refinement or by an exact gcd.
// - Distances are bounded by outward-rounded binary64 interval arithmetic: every operation rounds
//   its result one step outward (`nextDown`, `nextUp`), so every reported bound contains the true
//   value (obligation (g)).
// - Cell certifications (a cell lies inside, outside, or certainly meets a boundary) are sound:
//   they may answer "unknown", never a wrong class.
//
// The oracle shares no algorithm with the kernel: it never flattens to a tolerance tied to the
// bucket exponent; fill regions come from exact windings and an exact arrangement, stroke regions
// from exact piece membership and certified cells.

// =============================================================================================
// 1. Exact rationals

/**
 * Weighted work (E3-U2b, review S3 of PR #212). Every loop whose cost is not bounded by the
 * structural units (cover cells, elements, B&B nodes) is charged where it runs, through the work
 * of the call in progress: BigInt gcd steps, rational normalizations, Horner steps of exact
 * polynomial signs (weighted by the bit length of the point), pseudo-division steps, sub-arc
 * nodes and their interval tests, exact clip vertices, seam-split recursion, exact memberships
 * and cover-cell lookups. The weights are nominal microseconds on the calibration machine
 * (contract sections 14.7 and 14.8), so the cap bounds wall time empirically. The charge is
 * deterministic: it depends
 * only on the case, the mesh and the options.
 */
const WORK_KINDS = [
  'structure',
  'gcd step',
  'rational',
  'horner step',
  'pseudo-division step',
  'sub-arc node',
  'clip vertex',
  'seam split',
  'membership',
  'cell lookup',
  'mesh pair',
] as const;

const W_STRUCTURE = 0;
const W_GCD = 1;
const W_RATIONAL = 2;
const W_HORNER = 3;
const W_PDIV = 4;
const W_ARC = 5;
const W_CLIP = 6;
const W_SEAM = 7;
const W_MEMBER = 8;
const W_CELL = 9;
const W_PAIR = 10;

/**
 * Nominal microseconds per unit of each kind: the E3-U2c refit of contract section 14.8, which
 * supersedes the weights of section 14.7.
 */
const WORK_WEIGHTS: readonly number[] = [9.5, 0.22, 1.15, 0.17, 0.38, 12, 0.26, 80, 8.2, 4.2, 4.2];

type Work = { units: number; readonly cap: number; readonly counts: number[] };

function newWork(cap: number): Work {
  return { units: 0, cap, counts: WORK_KINDS.map(() => 0) };
}

/**
 * The work of the call in progress. Only `a04Measure` and `a04FreezeCheck` set it; charges
 * outside them are free. The inspection helpers `a04Contains`, `a04ContainsWith`,
 * `a04FillPortions` and `a04BoundaryDistance` run uncharged (tests only, never a run).
 */
let activeWork: Work | null = null;

function charge(kind: number, count: number): void {
  const work = activeWork;
  if (work === null) return;
  work.counts[kind]! += count;
  work.units += count * WORK_WEIGHTS[kind]!;
  if (work.units > work.cap) throw new A04WorkLimitError(WORK_KINDS[kind]!);
}

type Q = Readonly<{ n: bigint; d: bigint }>;
type QP = Readonly<{ x: Q; y: Q }>;

const Q0: Q = { n: 0n, d: 1n };
const Q1: Q = { n: 1n, d: 1n };
const QHALF: Q = { n: 1n, d: 2n };

function oracleError(message: string): never {
  throw new Error(`a04-oracle: ${message}`);
}

const absB = (v: bigint): bigint => (v < 0n ? -v : v);

function bitLen(v: bigint): number {
  const a = absB(v);
  if (a === 0n) return 0;
  const hexText = a.toString(16);
  const lead = parseInt(hexText[0]!, 16);
  return (hexText.length - 1) * 4 + (32 - Math.clz32(lead));
}

function trailingZeros(v: bigint): bigint {
  if (v === 0n) return 0n;
  // 32 bits at a time (E3-U2c): no string conversion of a large value.
  let a = absB(v);
  let k = 0;
  while ((a & 0xffffffffn) === 0n) {
    a >>= 32n;
    k += 32;
  }
  const low = Number(a & 0xffffffffn);
  return BigInt(k + 31 - Math.clz32(low & -low));
}

function gcdB(left: bigint, right: bigint): bigint {
  let a = absB(left);
  let b = absB(right);
  let steps = 0;
  while (b !== 0n) {
    [a, b] = [b, a % b];
    steps += 1;
  }
  // A step costs in proportion to the operands' words, and Euclid takes about 0.58 steps per
  // bit (37 per 64-bit word), so the step count also measures the size.
  if (steps > 0) charge(W_GCD, steps * (1 + steps / 37));
  return a;
}

function qmk(numerator: bigint, denominator: bigint): Q {
  charge(W_RATIONAL, 1);
  let n = numerator;
  let d = denominator;
  if (d === 0n) oracleError('zero denominator');
  if (n === 0n) return Q0;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (d === 1n) return { n, d };
  if ((d & (d - 1n)) === 0n) {
    const k = trailingZeros(n);
    const dk = trailingZeros(d);
    const s = k < dk ? k : dk;
    return s === 0n ? { n, d } : { n: n >> s, d: d >> s };
  }
  const g = gcdB(n, d);
  return g === 1n ? { n, d } : { n: n / g, d: d / g };
}

const qi = (v: bigint | number): Q => ({ n: BigInt(v), d: 1n });
const qadd = (a: Q, b: Q): Q =>
  a.d === b.d ? qmk(a.n + b.n, a.d) : qmk(a.n * b.d + b.n * a.d, a.d * b.d);
const qsub = (a: Q, b: Q): Q =>
  a.d === b.d ? qmk(a.n - b.n, a.d) : qmk(a.n * b.d - b.n * a.d, a.d * b.d);
const qmul = (a: Q, b: Q): Q => qmk(a.n * b.n, a.d * b.d);
const qdiv = (a: Q, b: Q): Q => {
  if (b.n === 0n) oracleError('division by zero');
  return qmk(a.n * b.d, a.d * b.n);
};
const qneg = (a: Q): Q => ({ n: -a.n, d: a.d });
const qsgn = (a: Q): number => (a.n < 0n ? -1 : a.n > 0n ? 1 : 0);
const qcmp = (a: Q, b: Q): number => {
  if (a.d === b.d) return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
const qeq = (a: Q, b: Q): boolean => a.n === b.n && a.d === b.d;
const qabs = (a: Q): Q => (a.n < 0n ? qneg(a) : a);
const qsq = (a: Q): Q => qmul(a, a);
const qmid = (a: Q, b: Q): Q => qmul(qadd(a, b), QHALF);
const qmin = (a: Q, b: Q): Q => (qcmp(a, b) <= 0 ? a : b);
const qmax = (a: Q, b: Q): Q => (qcmp(a, b) >= 0 ? a : b);

const BITS = new DataView(new ArrayBuffer(8));

/** The exact value of a finite binary64 as a reduced rational. */
function qnum(value: number): Q {
  if (!Number.isFinite(value)) oracleError('non-finite input');
  if (value === 0) return Q0;
  BITS.setFloat64(0, value);
  const hi = BITS.getUint32(0);
  const lo = BITS.getUint32(4);
  const exponent = (hi >>> 20) & 0x7ff;
  const fraction = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  const significand = exponent === 0 ? fraction : (1n << 52n) | fraction;
  const shift = (exponent === 0 ? 1 : exponent) - 1075;
  const signed = hi >>> 31 === 0 ? significand : -significand;
  return shift >= 0 ? qi(signed << BigInt(shift)) : qmk(signed, 1n << BigInt(-shift));
}

/** Nearest-ish binary64 to a rational (within one ulp); bounds use `qIv`, never this alone. */
function qapprox(a: Q): number {
  if (a.n === 0n) return 0;
  const negative = a.n < 0n;
  const n = absB(a.n);
  const shift = 64 - (bitLen(n) - bitLen(a.d));
  const scaled = shift >= 0 ? (n << BigInt(shift)) / a.d : n / (a.d << BigInt(-shift));
  let value = Number(scaled);
  // Multiply by 2^-shift in safe steps (shift may exceed the normal exponent range).
  let rest = -shift;
  while (rest > 1000) {
    value *= 2 ** 1000;
    rest -= 1000;
  }
  while (rest < -1000) {
    value *= 2 ** -1000;
    rest += 1000;
  }
  value *= 2 ** rest;
  return negative ? -value : value;
}

const qp = (x: Q, y: Q): QP => ({ x, y });
const qpn = (x: number, y: number): QP => ({ x: qnum(x), y: qnum(y) });
const qpadd = (a: QP, b: QP): QP => ({ x: qadd(a.x, b.x), y: qadd(a.y, b.y) });
const qpsub = (a: QP, b: QP): QP => ({ x: qsub(a.x, b.x), y: qsub(a.y, b.y) });
const qpscale = (a: QP, s: Q): QP => ({ x: qmul(a.x, s), y: qmul(a.y, s) });
const qpdot = (a: QP, b: QP): Q => qadd(qmul(a.x, b.x), qmul(a.y, b.y));
const qpcross = (a: QP, b: QP): Q => qsub(qmul(a.x, b.y), qmul(a.y, b.x));
const qpeq = (a: QP, b: QP): boolean => qeq(a.x, b.x) && qeq(a.y, b.y);
const qpzero = (a: QP): boolean => a.x.n === 0n && a.y.n === 0n;
const qpperp = (a: QP): QP => ({ x: qneg(a.y), y: a.x });
const qpneg = (a: QP): QP => ({ x: qneg(a.x), y: qneg(a.y) });
const qplerp = (a: QP, b: QP, t: Q): QP => qpadd(a, qpscale(qpsub(b, a), t));
const qpkey = (a: QP): string => `${a.x.n}/${a.x.d},${a.y.n}/${a.y.d}`;
const orient = (a: QP, b: QP, c: QP): number => qsgn(qpcross(qpsub(b, a), qpsub(c, a)));

/** sign(a + b·√s), s ≥ 0. */
function signRad(a: Q, b: Q, s: Q): number {
  const sa = qsgn(a);
  const sb = s.n === 0n ? 0 : qsgn(b);
  if (sb === 0) return sa;
  if (sa === 0) return sb;
  if (sa === sb) return sa;
  const difference = qsgn(qsub(qsq(a), qmul(qsq(b), s)));
  return sa > 0 ? difference : -difference;
}

/** sign(x0 + x1·√A + x2·√B + x3·√A·√B), A, B ≥ 0. */
function signRad2(x0: Q, x1: Q, x2: Q, x3: Q, a: Q, b: Q): number {
  const sx = signRad(x0, x1, a);
  const sy = b.n === 0n ? 0 : signRad(x2, x3, a);
  if (sy === 0) return sx;
  if (sx === 0) return sy;
  if (sx === sy) return sx;
  const two = qi(2);
  const z0 = qsub(qadd(qsq(x0), qmul(qsq(x1), a)), qmul(b, qadd(qsq(x2), qmul(qsq(x3), a))));
  const z1 = qsub(qmul(two, qmul(x0, x1)), qmul(two, qmul(b, qmul(x2, x3))));
  const sz = signRad(z0, z1, a);
  return sx > 0 ? sz : -sz;
}

// =============================================================================================
// 2. Polynomials over Q, Sturm sequences and exact real-root isolation

type Poly = readonly Q[];

function ptrim(p: Poly): Q[] {
  const out = [...p];
  while (out.length > 0 && out[out.length - 1]!.n === 0n) out.pop();
  return out;
}

function peval(p: Poly, t: Q): Q {
  let acc = Q0;
  for (let i = p.length - 1; i >= 0; i -= 1) acc = qadd(qmul(acc, t), p[i]!);
  return acc;
}

function pderiv(p: Poly): Q[] {
  const out: Q[] = [];
  for (let i = 1; i < p.length; i += 1) out.push(qmul(p[i]!, qi(i)));
  return ptrim(out);
}

function padd(a: Poly, b: Poly): Q[] {
  const out: Q[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) out.push(qadd(a[i] ?? Q0, b[i] ?? Q0));
  return ptrim(out);
}

function psub(a: Poly, b: Poly): Q[] {
  const out: Q[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) out.push(qsub(a[i] ?? Q0, b[i] ?? Q0));
  return ptrim(out);
}

function pmul(a: Poly, b: Poly): Q[] {
  if (a.length === 0 || b.length === 0) return [];
  const out: Q[] = Array.from({ length: a.length + b.length - 1 }, () => Q0);
  a.forEach((ai, i) => {
    if (ai.n === 0n) return;
    b.forEach((bj, j) => {
      out[i + j] = qadd(out[i + j]!, qmul(ai, bj));
    });
  });
  return ptrim(out);
}

function pscale(a: Poly, s: Q): Q[] {
  return ptrim(a.map((c) => qmul(c, s)));
}

/** Quotient and remainder of a / b. */
function pdivmod(a: Poly, b: Poly): { q: Q[]; r: Q[] } {
  const divisor = ptrim(b);
  if (divisor.length === 0) oracleError('polynomial division by zero');
  let r = ptrim(a);
  const lead = divisor[divisor.length - 1]!;
  const q: Q[] = Array.from({ length: Math.max(0, r.length - divisor.length + 1) }, () => Q0);
  while (r.length >= divisor.length) {
    const factor = qdiv(r[r.length - 1]!, lead);
    const shift = r.length - divisor.length;
    q[shift] = factor;
    const next = [...r];
    divisor.forEach((c, i) => {
      next[i + shift] = qsub(next[i + shift]!, qmul(factor, c));
    });
    next[next.length - 1] = Q0;
    r = ptrim(next);
  }
  return { q: ptrim(q), r };
}

// Root finding works on integer polynomials (primitive pseudo-remainder sequences): rational
// coefficients would renormalize by a BigInt gcd at every operation.

type ZPoly = bigint[];

function ztrim(p: readonly bigint[]): ZPoly {
  const out = [...p];
  while (out.length > 0 && out[out.length - 1] === 0n) out.pop();
  return out;
}

/** p times the lcm of its denominators: an integer polynomial with the same roots. */
function toZ(p: Poly): ZPoly {
  const t = ptrim(p);
  let l = 1n;
  for (const c of t) if (c.d !== 1n) l = (l / gcdB(l, c.d)) * c.d;
  return t.map((c) => (c.n * l) / c.d);
}

const fromZ = (p: readonly bigint[]): Q[] => p.map((c) => ({ n: c, d: 1n }));

/** Divides by the positive content; keeps the sign of the leading coefficient. */
function zprimitive(p: readonly bigint[]): ZPoly {
  const t = ztrim(p);
  let g = 0n;
  for (const c of t) {
    g = gcdB(g, c);
    if (g === 1n) return t;
  }
  return g <= 1n ? t : t.map((c) => c / g);
}

function zderiv(p: readonly bigint[]): ZPoly {
  const out: bigint[] = [];
  for (let i = 1; i < p.length; i += 1) out.push(p[i]! * BigInt(i));
  return ztrim(out);
}

/** Pseudo-division: lc(b)^(deg a − deg b + 1)·a = q·b + r. */
function zpdivmod(a: readonly bigint[], b: readonly bigint[]): { q: ZPoly; r: ZPoly } {
  const B = ztrim(b);
  if (B.length === 0) oracleError('polynomial division by zero');
  let r = ztrim(a);
  const lead = B[B.length - 1]!;
  const dq = r.length - B.length;
  if (dq < 0) return { q: [], r };
  const q: bigint[] = Array.from({ length: dq + 1 }, () => 0n);
  for (let k = dq; k >= 0; k -= 1) {
    charge(W_PDIV, r.length + q.length + B.length);
    const top = r.length - 1 >= k + B.length - 1 ? (r[k + B.length - 1] ?? 0n) : 0n;
    // Multiply everything by lead, then subtract top·x^k·B.
    r = r.map((c) => c * lead);
    for (let i = 0; i < q.length; i += 1) q[i] = q[i]! * lead;
    q[k] = q[k]! + top;
    // Pad to x^k first: r may have been trimmed below it, and a hole would not be a bigint.
    while (r.length < k) r.push(0n);
    for (let i = 0; i < B.length; i += 1) r[k + i] = (r[k + i] ?? 0n) - top * B[i]!;
    r = ztrim(r);
  }
  return { q: ztrim(q), r };
}

/** Sign of p at the rational t (p integer), by homogeneous Horner. */
function zsign(p: readonly bigint[], t: Q): number {
  if (p.length === 0) return 0;
  const n = t.n;
  const d = t.d;
  // Each step multiplies by n and d, whose size grows with the refinement of t.
  charge(W_HORNER, (p.length - 1) * (1 + (bitLen(n) + bitLen(d)) / 64));
  let acc = p[p.length - 1]!;
  let dp = 1n;
  for (let i = p.length - 2; i >= 0; i -= 1) {
    dp *= d;
    acc = acc * n + p[i]! * dp;
  }
  return acc < 0n ? -1 : acc > 0n ? 1 : 0;
}

function zgcd(a: readonly bigint[], b: readonly bigint[]): ZPoly {
  let x = zprimitive(a);
  let y = zprimitive(b);
  if (x.length < y.length) [x, y] = [y, x];
  while (y.length > 0) {
    const r = zprimitive(zpdivmod(x, y).r);
    x = y;
    y = r;
  }
  return zprimitive(x);
}

function zsquarefree(p: readonly bigint[]): ZPoly {
  const t = zprimitive(p);
  if (t.length <= 2) return t;
  const g = zgcd(t, zderiv(t));
  if (g.length <= 1) return t;
  return zprimitive(zpdivmod(t, g).q);
}

/** A gcd of a and b (integer coefficients, as rationals). */
function pgcd(a: Poly, b: Poly): Q[] {
  return fromZ(zgcd(toZ(a), toZ(b)));
}

/** The squarefree part of p (integer coefficients, as rationals). */
function psquarefree(p: Poly): Q[] {
  return fromZ(zsquarefree(toZ(p)));
}

type Sturm = readonly ZPoly[];

/** A Sturm sequence by primitive pseudo-remainders, sign-corrected. */
function sturmOf(s: Poly): Sturm {
  const seq: ZPoly[] = [zprimitive(toZ(s))];
  let next = zprimitive(zderiv(seq[0]!));
  while (next.length > 0) {
    seq.push(next);
    const a = seq[seq.length - 2]!;
    const lead = next[next.length - 1]!;
    const { r } = zpdivmod(a, next);
    // r = lc^(δ+1)·rem; the Sturm step needs −rem, so flip by the sign of lc^(δ+1).
    const odd = (a.length - next.length + 1) % 2 === 1;
    const flip = lead < 0n && odd ? 1n : -1n;
    next = zprimitive(r.map((c) => c * flip));
  }
  return seq;
}

/** Sign of a polynomial at t: integer polynomials through zsign. */
function psign(p: Poly, t: Q): number {
  if (p.every((c) => c.d === 1n))
    return zsign(
      p.map((c) => c.n),
      t,
    );
  return qsgn(peval(p, t));
}

function sturmChanges(seq: Sturm, t: Q): number {
  let changes = 0;
  let last = 0;
  for (const p of seq) {
    const s = zsign(p, t);
    if (s === 0) continue;
    if (last !== 0 && s !== last) changes += 1;
    last = s;
  }
  return changes;
}

/** An isolated real root: exactly `exact`, or the only root of the squarefree part in (lo, hi). */
type Root = { lo: Q; hi: Q; exact: Q | null };

type Isolated = Readonly<{ s: Q[]; roots: Root[] }>;

/** Isolates the distinct real roots of p in the closed interval [lo, hi]. */
function isolateRoots(p: Poly, lo: Q, hi: Q): Isolated {
  const t = ptrim(p);
  if (t.length === 0) oracleError('isolating the roots of the zero polynomial');
  const s = psquarefree(t);
  const roots: Root[] = [];
  if (s.length <= 1) return { s, roots };
  if (s.length === 2) {
    const t = qneg(qdiv(s[0]!, s[1]!));
    if (qcmp(t, lo) >= 0 && qcmp(t, hi) <= 0) roots.push({ lo: t, hi: t, exact: t });
    return { s, roots };
  }
  const seq = sturmOf(s);
  if (psign(s, lo) === 0) roots.push({ lo, hi: lo, exact: lo });
  const visit = (a: Q, b: Q, count: number): void => {
    if (count <= 0) return;
    if (count === 1) {
      if (psign(s, b) === 0) {
        roots.push({ lo: b, hi: b, exact: b });
        return;
      }
      if (psign(s, a) !== 0) {
        roots.push({ lo: a, hi: b, exact: null });
        return;
      }
    }
    const m = qmid(a, b);
    const left = sturmChanges(seq, a) - sturmChanges(seq, m);
    visit(a, m, left);
    visit(m, b, count - left);
  };
  visit(lo, hi, sturmChanges(seq, lo) - sturmChanges(seq, hi));
  roots.sort((u, v) => qcmp(u.lo, v.lo));
  return { s, roots };
}

/** Halves the isolating interval of a non-exact root of the squarefree `s`. */
function refineRoot(s: Poly, root: Root): void {
  if (root.exact !== null) return;
  const m = qmid(root.lo, root.hi);
  const sm = psign(s, m);
  if (sm === 0) {
    root.lo = m;
    root.hi = m;
    root.exact = m;
    return;
  }
  if (psign(s, root.lo) * sm < 0) root.hi = m;
  else root.lo = m;
}

/** Exact rational interval enclosure of p over [lo, hi] (Horner with interval products). */
function prange(p: Poly, lo: Q, hi: Q): { lo: Q; hi: Q } {
  let aLo = Q0;
  let aHi = Q0;
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const c = [qmul(aLo, lo), qmul(aLo, hi), qmul(aHi, lo), qmul(aHi, hi)];
    let mn = c[0]!;
    let mx = c[0]!;
    for (const v of c) {
      if (qcmp(v, mn) < 0) mn = v;
      if (qcmp(v, mx) > 0) mx = v;
    }
    aLo = qadd(mn, p[i]!);
    aHi = qadd(mx, p[i]!);
  }
  return { lo: aLo, hi: aHi };
}

/** Exact sign of h at an isolated root of the squarefree s (refines the root as needed). */
function signAtRoot(hq: Poly, s: Poly, root: Root): number {
  const h = fromZ(toZ(hq));
  if (root.exact !== null) return psign(h, root.exact);
  // An outward-rounded prefilter (E3-U2c): while the isolating interval is refined, an interval
  // Horner enclosure of h over it that excludes 0 decides the sign. Only otherwise does the exact
  // gcd and Sturm test below run.
  {
    const hi = hq.map(qIv);
    for (let step = 0; step < 64 && root.exact === null; step += 1) {
      const t = { lo: qIv(root.lo).lo, hi: qIv(root.hi).hi };
      const v = ipoly(hi, t);
      if (v.lo > 0) return 1;
      if (v.hi < 0) return -1;
      refineRoot(s, root);
    }
    if (root.exact !== null) return psign(h, root.exact);
  }
  return signAtRootExact(h, s, root);
}

/** The exact gcd and Sturm sign test of `signAtRoot`, without the interval prefilter. */
function signAtRootExact(h: Poly, s: Poly, root: Root): number {
  if (root.exact !== null) return psign(h, root.exact);
  const g = pgcd(s, h);
  if (g.length >= 2) {
    const a = psign(g, root.lo);
    const b = psign(g, root.hi);
    if (a * b < 0) return 0;
  }
  // h does not vanish at the root (the gcd test above), so once the isolating interval holds no
  // root of h, h keeps one sign on it: the sign at either end. Sturm counts of h's squarefree
  // part decide that in a few halvings, whatever |h(root)| is.
  const hs = psquarefree(h);
  const seq = hs.length >= 2 ? sturmOf(hs) : null;
  for (let step = 0; step < 4000; step += 1) {
    const a = psign(h, root.lo);
    if (a !== 0 && psign(h, root.hi) === a) {
      if (seq === null || sturmChanges(seq, root.lo) - sturmChanges(seq, root.hi) === 0) return a;
    }
    refineRoot(s, root);
    if (root.exact !== null) return psign(h, root.exact);
  }
  return oracleError('sign at an isolated root did not resolve');
}

/** Bernstein coefficients (degree n) to power basis on the same parameter. */
function bernsteinToPower(b: readonly Q[]): Q[] {
  const n = b.length - 1;
  const binom = (k: number, j: number): bigint => {
    let r = 1n;
    for (let i = 0; i < j; i += 1) r = (r * BigInt(k - i)) / BigInt(i + 1);
    return r;
  };
  const out: Q[] = Array.from({ length: n + 1 }, () => Q0);
  for (let i = 0; i <= n; i += 1) {
    // C(n,i) t^i (1-t)^(n-i) = C(n,i) Σ_j C(n-i,j) (-1)^j t^(i+j)
    for (let j = 0; j <= n - i; j += 1) {
      const coefficient = binom(n, i) * binom(n - i, j) * (j % 2 === 0 ? 1n : -1n);
      out[i + j] = qadd(out[i + j]!, qmul(b[i]!, qi(coefficient)));
    }
  }
  return ptrim(out);
}

// =============================================================================================
// 3. Outward-rounded binary64 intervals (obligation (g))

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);
F64[0] = 1;
if (U32[1] !== 0x3ff00000) oracleError('the interval code assumes a little-endian host');

/** The next binary64 above x. */
export function a04NextUp(x: number): number {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === 0) return Number.MIN_VALUE;
  F64[0] = x;
  if (x > 0) {
    U32[0] = (U32[0]! + 1) >>> 0;
    if (U32[0] === 0) U32[1] = U32[1]! + 1;
  } else {
    if (U32[0] === 0) U32[1] = U32[1]! - 1;
    U32[0] = (U32[0]! - 1) >>> 0;
  }
  return F64[0];
}

/** The next binary64 below x. */
export function a04NextDown(x: number): number {
  return -a04NextUp(-x);
}

const up = a04NextUp;
const dn = a04NextDown;

/** A closed interval of reals containing the true value. */
export type A04Interval = Readonly<{ lo: number; hi: number }>;
type Iv = A04Interval;
type IvP = Readonly<{ x: Iv; y: Iv }>;

const ivc = (v: number): Iv => ({ lo: v, hi: v });
const iadd = (a: Iv, b: Iv): Iv => ({ lo: dn(a.lo + b.lo), hi: up(a.hi + b.hi) });
const isub = (a: Iv, b: Iv): Iv => ({ lo: dn(a.lo - b.hi), hi: up(a.hi - b.lo) });
function imul(a: Iv, b: Iv): Iv {
  if (a.lo >= 0 && b.lo >= 0) return { lo: dn(a.lo * b.lo), hi: up(a.hi * b.hi) };
  const p1 = a.lo * b.lo;
  const p2 = a.lo * b.hi;
  const p3 = a.hi * b.lo;
  const p4 = a.hi * b.hi;
  return { lo: dn(Math.min(p1, p2, p3, p4)), hi: up(Math.max(p1, p2, p3, p4)) };
}
function isqr(a: Iv): Iv {
  if (a.lo >= 0) return { lo: dn(a.lo * a.lo), hi: up(a.hi * a.hi) };
  if (a.hi <= 0) return { lo: dn(a.hi * a.hi), hi: up(a.lo * a.lo) };
  return { lo: 0, hi: up(Math.max(a.lo * a.lo, a.hi * a.hi)) };
}
function idiv(a: Iv, b: Iv): Iv {
  if (b.lo <= 0 && b.hi >= 0) return { lo: -Infinity, hi: Infinity };
  const p1 = a.lo / b.lo;
  const p2 = a.lo / b.hi;
  const p3 = a.hi / b.lo;
  const p4 = a.hi / b.hi;
  return { lo: dn(Math.min(p1, p2, p3, p4)), hi: up(Math.max(p1, p2, p3, p4)) };
}
function isqrt(a: Iv): Iv {
  const lo = a.lo <= 0 ? 0 : dn(Math.sqrt(a.lo));
  const hi = a.hi <= 0 ? 0 : up(Math.sqrt(a.hi));
  return { lo: Math.max(0, lo), hi };
}

/** Outward binary64 enclosure of an exact rational. */
function qIv(a: Q): Iv {
  if (a.d === 1n && absB(a.n) <= 9007199254740992n) return ivc(Number(a.n));
  const v = qapprox(a);
  if (!Number.isFinite(v))
    return { lo: v > 0 ? Number.MAX_VALUE : -Infinity, hi: v > 0 ? Infinity : -Number.MAX_VALUE };
  const c = qcmp(a, qnum(v));
  if (c === 0) return ivc(v);
  if (c < 0) {
    let lo = dn(v);
    while (qcmp(a, qnum(lo)) < 0) lo = dn(lo);
    return { lo, hi: v };
  }
  let hi = up(v);
  while (qcmp(a, qnum(hi)) > 0) hi = up(hi);
  return { lo: v, hi };
}

const qpIv = (a: QP): IvP => ({ x: qIv(a.x), y: qIv(a.y) });
const ivpSub = (a: IvP, b: IvP): IvP => ({ x: isub(a.x, b.x), y: isub(a.y, b.y) });
const ivpAdd = (a: IvP, b: IvP): IvP => ({ x: iadd(a.x, b.x), y: iadd(a.y, b.y) });
const ivpScale = (a: IvP, s: Iv): IvP => ({ x: imul(a.x, s), y: imul(a.y, s) });
const ivpDot = (a: IvP, b: IvP): Iv => iadd(imul(a.x, b.x), imul(a.y, b.y));
const ivpCross = (a: IvP, b: IvP): Iv => isub(imul(a.x, b.y), imul(a.y, b.x));
const ivpNorm2 = (a: IvP): Iv => iadd(isqr(a.x), isqr(a.y));
const ivpLerp = (a: IvP, b: IvP, t: Iv): IvP => ivpAdd(a, ivpScale(ivpSub(b, a), t));
const ivpc = (x: number, y: number): IvP => ({ x: ivc(x), y: ivc(y) });
const ineg = (a: Iv): Iv => ({ lo: -a.hi, hi: -a.lo });

/** Sutherland–Hodgman clip of a convex polygon by a convex polygon (floats; candidates only). */
function clipConvex(
  subject: readonly [number, number][],
  clip: readonly [number, number][],
): [number, number][] {
  let area = 0;
  for (let i = 0; i < clip.length; i += 1) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    area += a[0] * b[1] - a[1] * b[0];
  }
  const sign = area >= 0 ? 1 : -1;
  let out: [number, number][] = [...subject];
  for (let i = 0; i < clip.length && out.length > 0; i += 1) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const side = (p: readonly [number, number]) =>
      sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const next: [number, number][] = [];
    for (let j = 0; j < out.length; j += 1) {
      const p = out[j]!;
      const q = out[(j + 1) % out.length]!;
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) next.push(p);
      if (sp * sq < 0) {
        const t = sp / (sp - sq);
        next.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    out = next;
  }
  return out;
}

/** An integer line A·x + B·y + C (E3-U2c), scaled from rationals by a positive factor. */
type ZLine = readonly [bigint, bigint, bigint];

function zLine(a: Q, b: Q, c: Q): ZLine {
  let l = 1n;
  for (const v of [a, b, c]) if (v.d !== 1n) l = (l / gcdB(l, v.d)) * v.d;
  return [(a.n * l) / a.d, (b.n * l) / b.d, (c.n * l) / c.d];
}

const zScale = (g: ZLine, s: bigint): ZLine => (s > 0n ? g : [-g[0], -g[1], -g[2]]);

/** A polygon vertex as the meet of its incoming and outgoing edge lines (homogeneous). */
type ZVert = Readonly<{ inLine: ZLine; outLine: ZLine; X: bigint; Y: bigint; W: bigint }>;

function zVert(inLine: ZLine, outLine: ZLine): ZVert {
  return {
    inLine,
    outLine,
    X: inLine[1] * outLine[2] - inLine[2] * outLine[1],
    Y: inLine[2] * outLine[0] - inLine[0] * outLine[2],
    W: inLine[0] * outLine[1] - inLine[1] * outLine[0],
  };
}

function zSide(g: ZLine, v: ZVert): number {
  const s = g[0] * v.X + g[1] * v.Y + g[2] * v.W;
  const sign = s > 0n ? 1 : s < 0n ? -1 : 0;
  return v.W > 0n ? sign : -sign;
}

/**
 * Exact clip of a convex polygon of positive area to {g ≥ 0}, or null when the result has zero
 * area (no vertex with g > 0). Sutherland–Hodgman on lines: a new vertex is the meet of the cut
 * edge's line and g. A kept vertex on g whose next (previous) vertex is cut away starts (ends)
 * an edge along g, so its outgoing (incoming) line becomes g; its point is unchanged.
 */
function zClip(poly: readonly ZVert[], g: ZLine): ZVert[] | null {
  charge(W_CLIP, poly.length);
  const side = poly.map((v) => zSide(g, v));
  if (!side.some((v) => v > 0)) return null;
  if (side.every((v) => v >= 0)) return [...poly];
  const out: ZVert[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const v = poly[i]!;
    if (side[i]! > 0) out.push(v);
    else if (side[i] === 0) {
      // Never both: on a convex polygon, a vertex on g with both neighbours cut away leaves no
      // vertex with g > 0, which returned null above.
      if (side[j]! < 0) out.push({ ...v, outLine: g });
      else if (side[(i + n - 1) % n]! < 0) out.push({ ...v, inLine: g });
      else out.push(v);
    }
    if (side[i]! * side[j]! < 0) out.push(side[i]! > 0 ? zVert(v.outLine, g) : zVert(g, v.outLine));
  }
  return out;
}

/**
 * The integer homogeneous form of a convex polygon of positive area given by its exact vertices
 * in order: the lines through consecutive distinct vertices, with consecutive collinear edges (a
 * vertex inside a side) merged, and each vertex the meet of its two lines. Null when fewer than
 * three edges remain.
 */
function zPolygon(ex: readonly QP[]): ZVert[] | null {
  // Each vertex in homogeneous integers (x.n·y.d, y.n·x.d, x.d·y.d), W > 0, and each line the
  // cross product of two of them (E3-U2e): a positive multiple of the line through the two
  // points, with no rational normalized (the gcds of the rational form dominated C9/k19).
  const hom = ex.map((p) => [p.x.n * p.y.d, p.y.n * p.x.d, p.x.d * p.y.d] as const);
  const raw: ZLine[] = [];
  for (let i = 0; i < ex.length; i += 1) {
    const j = (i + 1) % ex.length;
    if (qpeq(ex[i]!, ex[j]!)) continue;
    const [x1, y1, w1] = hom[i]!;
    const [x2, y2, w2] = hom[j]!;
    raw.push([y1 * w2 - w1 * y2, w1 * x2 - x1 * w2, x1 * y2 - y1 * x2]);
  }
  // Parallel lines of a convex polygon's consecutive edges coincide.
  const edges: ZLine[] = raw.filter(
    (e, i) => zVert(raw[(i + raw.length - 1) % raw.length]!, e).W !== 0n,
  );
  if (edges.length < 3) return null;
  return edges.map((e, i) => zVert(edges[(i + edges.length - 1) % edges.length]!, e));
}

/** Twice the signed area of a polygon. */
function polygonArea2(poly: readonly QP[]): Q {
  let a = Q0;
  for (let i = 0; i < poly.length; i += 1)
    a = qadd(a, qpcross(poly[i]!, poly[(i + 1) % poly.length]!));
  return a;
}

/** True when an edge line of the convex polygon (ordered gens) has every corner strictly outside. */
function separatedByEdges(gens: readonly IvP[], corners: readonly IvP[]): boolean {
  const n = gens.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i += 1) {
    const a = gens[i]!;
    const e = ivpSub(gens[(i + 1) % n]!, a);
    const inner = ivpCross(e, ivpSub(gens[(i + 2) % n]!, a));
    const side = inner.lo > 0 ? 1 : inner.hi < 0 ? -1 : 0;
    if (side === 0) continue;
    if (
      corners.every((c) => {
        const v = ivpCross(e, ivpSub(c, a));
        return side > 0 ? v.hi < 0 : v.lo > 0;
      })
    )
      return true;
  }
  return false;
}
const HALF = ivc(0.5);
/**
 * (a + b)·½ with outward rounding (E3-U2c): the sum is rounded outward, and halving a binary64
 * is exact unless the result is subnormal, where the general product is used.
 */
function imid(a: Iv, b: Iv): Iv {
  const v = iadd(a, b);
  const tiny = 2 ** -1020;
  if ((v.lo === 0 || Math.abs(v.lo) >= tiny) && (v.hi === 0 || Math.abs(v.hi) >= tiny))
    return { lo: v.lo * 0.5, hi: v.hi * 0.5 };
  return imul(v, HALF);
}
const ivpMid = (a: IvP, b: IvP): IvP => ({ x: imid(a.x, b.x), y: imid(a.y, b.y) });

/** Exact interval tests the outward-rounded primitives against BigInt evaluation (g). */
export function a04IntervalSelfTest(samples: readonly (readonly [number, number])[]): string[] {
  const findings: string[] = [];
  const contains = (i: Iv, exact: Q, label: string) => {
    const below = i.lo === -Infinity || qcmp(qnum(i.lo), exact) <= 0;
    const above = i.hi === Infinity || qcmp(qnum(i.hi), exact) >= 0;
    if (!below || !above) findings.push(`${label}: [${i.lo}, ${i.hi}] misses the exact value`);
  };
  for (const [a, b] of samples) {
    const qa = qnum(a);
    const qb = qnum(b);
    const ia = ivc(a);
    const ib = ivc(b);
    contains(iadd(ia, ib), qadd(qa, qb), `${a}+${b}`);
    contains(isub(ia, ib), qsub(qa, qb), `${a}-${b}`);
    contains(imul(ia, ib), qmul(qa, qb), `${a}*${b}`);
    contains(isqr(ia), qsq(qa), `${a}^2`);
    if (b !== 0) contains(idiv(ia, ib), qdiv(qa, qb), `${a}/${b}`);
    const r = isqrt(ivc(Math.abs(a)));
    const lo = qnum(r.lo);
    const hi = r.hi === Infinity ? null : qnum(r.hi);
    if (qcmp(qsq(lo), qabs(qa)) > 0 || (hi !== null && qcmp(qsq(hi), qabs(qa)) < 0))
      findings.push(`sqrt(${Math.abs(a)}) enclosure is not outward`);
    const third = qdiv(qa, qi(3));
    contains(qIv(third), third, `${a}/3 conversion`);
  }
  return findings;
}

// =============================================================================================
// 4. Small utilities: boxes, a binary heap, a uniform grid index

type Box = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;

const boxOfIvPoints = (points: readonly IvP[]): Box => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x.lo);
    y0 = Math.min(y0, p.y.lo);
    x1 = Math.max(x1, p.x.hi);
    y1 = Math.max(y1, p.y.hi);
  }
  return { x0, y0, x1, y1 };
};
const boxesMeet = (a: Box, b: Box): boolean =>
  a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
const boxDiam = (b: Box): number => up(Math.hypot(b.x1 - b.x0, b.y1 - b.y0));

/** Lower bound on the distance between two boxes. */
function boxBoxDistLo(a: Box, b: Box): number {
  const dx = Math.max(0, dn(b.x0 - a.x1), dn(a.x0 - b.x1));
  const dy = Math.max(0, dn(b.y0 - a.y1), dn(a.y0 - b.y1));
  if (dx === 0 && dy === 0) return 0;
  return Math.max(0, dn(Math.sqrt(dn(dn(dx * dx) + dn(dy * dy)))));
}

/**
 * Lower bound on the distance between the hull of `gens` and a box (E3-U2e): the larger of the
 * boxes' distance and the separations along the hull's edge normals and the direction between
 * the centers. A projection onto a direction shortens distances, so each separation, divided by
 * the direction's length, is a bound. Under strong anisotropy a cell's local hull is a thin
 * parallelogram far smaller than its box.
 */
function hullBoxDistLo(gens: readonly IvP[], hullBox: Box, box: Box): number {
  let best = boxBoxDistLo(hullBox, box);
  if (gens.length < 3) return best;
  const corners = [
    ivpc(box.x0, box.y0),
    ivpc(box.x1, box.y0),
    ivpc(box.x1, box.y1),
    ivpc(box.x0, box.y1),
  ];
  const mid = (v: Iv) => (v.lo + v.hi) / 2;
  const along = (dx: number, dy: number) => {
    if (!(dx !== 0 || dy !== 0) || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const d = ivpc(dx, dy);
    let lo = Infinity;
    for (const g of gens) lo = Math.min(lo, ivpDot(g, d).lo);
    let hi = -Infinity;
    for (const c of corners) hi = Math.max(hi, ivpDot(c, d).hi);
    const sep = dn(lo - hi);
    if (!(sep > 0)) return;
    best = Math.max(best, dn(sep / isqrt(ivpNorm2(d)).hi));
  };
  along(
    (hullBox.x0 + hullBox.x1) / 2 - (box.x0 + box.x1) / 2,
    (hullBox.y0 + hullBox.y1) / 2 - (box.y0 + box.y1) / 2,
  );
  for (let i = 0; i < gens.length; i += 1) {
    const a = gens[i]!;
    const b = gens[(i + 1) % gens.length]!;
    const ex = mid(b.x) - mid(a.x);
    const ey = mid(b.y) - mid(a.y);
    // Both normals: the outward one separates when the box is beyond that edge.
    along(ey, -ex);
    along(-ey, ex);
  }
  return best;
}

class Heap<T> {
  private readonly items: { key: number; value: T }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(key: number, value: T): void {
    const items = this.items;
    items.push({ key, value });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]!.key >= items[i]!.key) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }
  peekKey(): number {
    return this.items.length === 0 ? -Infinity : this.items[0]!.key;
  }
  /** Removes the item with the largest key. */
  pop(): { key: number; value: T } | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l]!.key > items[m]!.key) m = l;
        if (r < items.length && items[r]!.key > items[m]!.key) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i]!, items[m]!];
        i = m;
      }
    }
    return top;
  }
}

/** A uniform grid over a region; items outside it are clamped into the border cells. */
class GridIndex<T> {
  private readonly cells: (T[] | undefined)[];
  private readonly stamp = new Map<T, number>();
  private epoch = 0;
  readonly all: T[] = [];
  constructor(
    readonly region: Box,
    readonly n: number,
    private readonly boxOf: (item: T) => Box,
  ) {
    this.cells = new Array<T[] | undefined>(n * n);
  }
  private cx(x: number): number {
    const r = this.region;
    const v = Math.floor(((x - r.x0) / Math.max(r.x1 - r.x0, 1e-300)) * this.n);
    return Math.min(this.n - 1, Math.max(0, Number.isFinite(v) ? v : x > r.x0 ? this.n - 1 : 0));
  }
  private cy(y: number): number {
    const r = this.region;
    const v = Math.floor(((y - r.y0) / Math.max(r.y1 - r.y0, 1e-300)) * this.n);
    return Math.min(this.n - 1, Math.max(0, Number.isFinite(v) ? v : y > r.y0 ? this.n - 1 : 0));
  }
  insert(item: T): void {
    this.all.push(item);
    const b = this.boxOf(item);
    for (let i = this.cx(b.x0); i <= this.cx(b.x1); i += 1)
      for (let j = this.cy(b.y0); j <= this.cy(b.y1); j += 1) {
        const k = i * this.n + j;
        (this.cells[k] ??= []).push(item);
      }
  }
  /** Visits each item whose cells meet the query box once. */
  visit(query: Box, fn: (item: T) => void): void {
    this.epoch += 1;
    const e = this.epoch;
    for (let i = this.cx(query.x0); i <= this.cx(query.x1); i += 1)
      for (let j = this.cy(query.y0); j <= this.cy(query.y1); j += 1) {
        const list = this.cells[i * this.n + j];
        if (list === undefined) continue;
        for (const item of list) {
          if (this.stamp.get(item) === e) continue;
          this.stamp.set(item, e);
          fn(item);
        }
      }
  }
  /** Cell size along the larger axis. */
  get cellSize(): number {
    const r = this.region;
    return Math.max(r.x1 - r.x0, r.y1 - r.y0) / this.n;
  }
}

// =============================================================================================
// 5. The case (E3-K1), the ideal map Φ and the window (E3-K3)

/** One canonical corpus case (contract section 13.2); only the fields below are read. */
export type A04Case = Readonly<Record<string, unknown>>;

export type A04FillRule = 'nonzero' | 'evenodd';
export type A04Cap = 'butt' | 'round' | 'square';
export type A04Join = 'miter' | 'round' | 'bevel';

type Paint =
  | Readonly<{ kind: 'fill'; rule: A04FillRule }>
  | Readonly<{
      kind: 'stroke';
      width: number;
      cap: A04Cap;
      join: A04Join;
      miterLimit: number;
    }>;

type Decoded = Readonly<{
  id: string;
  paint: Paint;
  verbs: string;
  points: readonly number[];
  l: readonly [number, number, number, number];
  t: readonly [number, number];
  c: readonly [number, number];
  zoom: number;
  dpr: number;
  viewport: readonly [number, number];
}>;

function unhex64(text: unknown): number {
  if (typeof text !== 'string' || !/^[0-9a-f]{16}$/u.test(text))
    oracleError(`expected a 16-digit hex binary64, got ${String(text)}`);
  BITS.setBigUint64(0, BigInt(`0x${text}`));
  const value = BITS.getFloat64(0);
  if (!Number.isFinite(value)) oracleError('non-finite case value');
  return value;
}

function field(record: unknown, key: string): unknown {
  if (record === null || typeof record !== 'object') oracleError(`missing object for ${key}`);
  return (record as Record<string, unknown>)[key];
}

function hexArray(value: unknown, length: number | null, label: string): number[] {
  if (!Array.isArray(value)) oracleError(`${label} is not an array`);
  if (length !== null && value.length !== length) oracleError(`${label} has the wrong length`);
  return value.map(unhex64);
}

function decodeCase(input: A04Case): Decoded {
  const id = typeof input.id === 'string' ? input.id : '(no id)';
  const paintRecord = field(input, 'paint');
  const kind = field(paintRecord, 'kind');
  let paint: Paint;
  if (kind === 'fill') {
    const rule = field(paintRecord, 'rule');
    if (rule !== 'nonzero' && rule !== 'evenodd') oracleError('bad fill rule');
    paint = { kind: 'fill', rule };
  } else if (kind === 'stroke') {
    const cap = field(paintRecord, 'cap');
    const join = field(paintRecord, 'join');
    if (cap !== 'butt' && cap !== 'round' && cap !== 'square') oracleError('bad cap');
    if (join !== 'miter' && join !== 'round' && join !== 'bevel') oracleError('bad join');
    paint = {
      kind: 'stroke',
      width: unhex64(field(paintRecord, 'width')),
      cap,
      join,
      miterLimit: unhex64(field(paintRecord, 'miterLimit')),
    };
  } else {
    oracleError('bad paint kind');
  }
  const path = field(input, 'path');
  const verbs = field(path, 'verbs');
  if (typeof verbs !== 'string' || !/^[MLCZ]*$/u.test(verbs)) oracleError('bad verbs');
  const points = hexArray(field(path, 'points'), null, 'path.points');
  const camera = field(input, 'camera');
  const world = field(input, 'world');
  const viewport = field(input, 'viewport');
  if (
    !Array.isArray(viewport) ||
    viewport.length !== 2 ||
    !viewport.every((v) => typeof v === 'number' && Number.isInteger(v) && v > 0)
  )
    oracleError('bad viewport');
  const l = hexArray(field(world, 'l'), 4, 'world.l');
  const t = hexArray(field(world, 't'), 2, 'world.t');
  const c = hexArray(field(camera, 'c'), 2, 'camera.c');
  return {
    id,
    paint,
    verbs,
    points,
    l: [l[0]!, l[1]!, l[2]!, l[3]!],
    t: [t[0]!, t[1]!],
    c: [c[0]!, c[1]!],
    zoom: unhex64(field(camera, 'zoom')),
    dpr: unhex64(field(camera, 'dpr')),
    viewport: [viewport[0] as number, viewport[1] as number],
  };
}

/** Φ(x) = A·x + o with A = d·z·L and o = d·z·(t − c), exactly over the rationals. */
type Frame = Readonly<{
  a: Q;
  b: Q;
  c: Q;
  d: Q;
  ox: Q;
  oy: Q;
  det: Q;
  /** The adjugate of L (σ·L⁻¹): `phiInv` maps to scaled local coordinates σ·y. */
  ia: Q;
  ib: Q;
  ic: Q;
  id: Q;
  ivInv: readonly [Iv, Iv, Iv, Iv];
  /** σ = det L (1 when singular), the scale of the stroke region's local coordinates. */
  sigma: Q;
  ivO: IvP;
  width: number;
  height: number;
  /** Ω as a box: the viewport plus 2 physical px. */
  omega: Box;
  /** The axis box of Ω ⊕ 1. */
  w1Box: Box;
  singular: boolean;
}>;

function makeFrame(c: Decoded, hooks: A04Hooks): Frame {
  const zoom = hooks.idealZoom === undefined ? c.zoom : hooks.idealZoom(c.zoom);
  const s = qmul(qnum(c.dpr), qnum(zoom));
  const a = qmul(s, qnum(c.l[0]));
  const b = qmul(s, qnum(c.l[1]));
  const cc = qmul(s, qnum(c.l[2]));
  const d = qmul(s, qnum(c.l[3]));
  const ox = qmul(s, qsub(qnum(c.t[0]), qnum(c.c[0])));
  const oy = qmul(s, qsub(qnum(c.t[1]), qnum(c.c[1])));
  const det = qsub(qmul(a, d), qmul(b, cc));
  const singular = det.n === 0n;
  // The stroke region lives in scaled local coordinates y' = σ·y with σ = det L (E3-U2c): then
  // Φ⁻¹ scaled by σ is the adjugate, which is dyadic like Φ, so no exact test of a cell needs a
  // gcd. y ↦ σ·y is a similarity (a uniform scaling, by −|σ| a rotation by π), so every
  // membership predicate of the stroke pieces is unchanged when the pieces are scaled by σ.
  const ia = d;
  const ib = qneg(b);
  const ic = qneg(cc);
  const idd = a;
  const sigma = singular ? Q1 : det;
  const width = c.viewport[0] * c.dpr;
  const height = c.viewport[1] * c.dpr;
  if (!Number.isInteger(width) || !Number.isInteger(height)) oracleError('non-integer window');
  return {
    a,
    b,
    c: cc,
    d,
    ox,
    oy,
    det,
    ia,
    ib,
    ic,
    id: idd,
    ivInv: [qIv(ia), qIv(ib), qIv(ic), qIv(idd)],
    sigma,
    ivO: { x: qIv(ox), y: qIv(oy) },
    width,
    height,
    omega:
      hooks.window === undefined
        ? { x0: -2, y0: -2, x1: width + 2, y1: height + 2 }
        : hooks.window({ x0: -2, y0: -2, x1: width + 2, y1: height + 2 }),
    w1Box: { x0: -3, y0: -3, x1: width + 3, y1: height + 3 },
    singular,
  };
}

const phi = (f: Frame, p: QP): QP => ({
  x: qadd(qadd(qmul(f.a, p.x), qmul(f.b, p.y)), f.ox),
  y: qadd(qadd(qmul(f.c, p.x), qmul(f.d, p.y)), f.oy),
});

/** σ·Φ⁻¹(p): the scaled local point of a physical point (dyadic for a dyadic p). */
function phiInv(f: Frame, p: QP): QP {
  const x = qsub(p.x, f.ox);
  const y = qsub(p.y, f.oy);
  return { x: qadd(qmul(f.ia, x), qmul(f.ib, y)), y: qadd(qmul(f.ic, x), qmul(f.id, y)) };
}

function phiInvIv(f: Frame, p: IvP): IvP {
  const x = isub(p.x, f.ivO.x);
  const y = isub(p.y, f.ivO.y);
  const m = f.ivInv;
  return { x: iadd(imul(m[0], x), imul(m[1], y)), y: iadd(imul(m[2], x), imul(m[3], y)) };
}

/** Exact test that p lies in Ω ⊕ 1 (the measurement window). */
function inW1(f: Frame, p: QP): boolean {
  const o = f.omega;
  const dx = qmax(Q0, qmax(qsub(qi(o.x0), p.x), qsub(p.x, qnum(o.x1))));
  const dy = qmax(Q0, qmax(qsub(qi(o.y0), p.y), qsub(p.y, qnum(o.y1))));
  return qcmp(qadd(qsq(dx), qsq(dy)), Q1) <= 0;
}

/** Exact test that p lies in Ω. */
function inOmega(f: Frame, p: QP): boolean {
  const o = f.omega;
  return (
    qcmp(p.x, qi(o.x0)) >= 0 &&
    qcmp(p.x, qnum(o.x1)) <= 0 &&
    qcmp(p.y, qi(o.y0)) >= 0 &&
    qcmp(p.y, qnum(o.y1)) <= 0
  );
}

/** Conservative: false only when the box certainly misses Ω ⊕ 1. */
const boxMeetsW1 = (f: Frame, b: Box): boolean => boxBoxDistLo(b, f.omega) <= 1;

// =============================================================================================
// 6. The drawn mesh M* (E3-K2): T-junctions, ∂M extraction (obligation (e)), membership

/** A position lane: a binary64, or an exact rational `num/den` (the harness's `p*`). */
export type A04Scalar = number | Readonly<{ num: bigint; den: bigint }>;

/** The drawn region: closed region triangles at mapped physical positions (x, y interleaved). */
export type A04Mesh = Readonly<{ positions: ArrayLike<A04Scalar>; indices: ArrayLike<number> }>;

const scalarQ = (v: A04Scalar): Q => (typeof v === 'number' ? qnum(v) : qmk(v.num, v.den));

type Seg = Readonly<{ a: QP; b: QP; ia: IvP; ib: IvP; box: Box }>;

function makeSeg(a: QP, b: QP): Seg {
  const ia = qpIv(a);
  const ib = qpIv(b);
  return { a, b, ia, ib, box: boxOfIvPoints([ia, ib]) };
}

type MeshModel = Readonly<{
  empty: boolean;
  points: readonly QP[];
  triangles: readonly (readonly [number, number, number])[];
  triangleBoxes: readonly Box[];
  boundary: readonly Seg[];
  tJunctions: number;
  /**
   * Why the mesh is outside the oracle's preconditions (review S2 of PR #212), or null. ∂M is
   * the set of sub-edges used by exactly one triangle, which equals the topological boundary of
   * the union only when every triangle has positive area and no two interiors overlap.
   */
  invalid: string | null;
  triIndex: GridIndex<number> | null;
  segIndex: GridIndex<Seg> | null;
}>;

function gridSize(count: number): number {
  return Math.max(1, Math.min(256, Math.ceil(Math.sqrt(count))));
}

/** Points strictly inside each unique edge, by exact collinearity, sorted along the edge. */
function interiorPointsOfEdges(
  points: readonly QP[],
  pointIv: readonly IvP[],
  edges: readonly (readonly [number, number])[],
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  if (points.length === 0) return result;
  const boxes = pointIv.map((p) => boxOfIvPoints([p]));
  const region = boxOfIvPoints(pointIv);
  const index = new GridIndex<number>(region, gridSize(points.length), (i) => boxes[i]!);
  points.forEach((_, i) => index.insert(i));
  for (const [i, j] of edges) {
    const a = points[i]!;
    const b = points[j]!;
    const query = boxOfIvPoints([pointIv[i]!, pointIv[j]!]);
    const inside: number[] = [];
    const ab = qpsub(b, a);
    index.visit(query, (k) => {
      if (k === i || k === j || !boxesMeet(boxes[k]!, query)) return;
      const p = points[k]!;
      if (orient(a, b, p) !== 0) return;
      if (qsgn(qpdot(qpsub(p, a), ab)) > 0 && qsgn(qpdot(qpsub(p, b), ab)) < 0) inside.push(k);
    });
    if (inside.length > 0) {
      inside.sort((u, v) => qcmp(qpdot(qpsub(points[u]!, a), ab), qpdot(qpsub(points[v]!, a), ab)));
      result.set(`${i}:${j}`, inside);
    }
  }
  return result;
}

const EMPTY_MESH: MeshModel = {
  empty: true,
  points: [],
  triangles: [],
  triangleBoxes: [],
  boundary: [],
  tJunctions: 0,
  invalid: null,
  triIndex: null,
  segIndex: null,
};

function buildMesh(mesh: A04Mesh, hooks: A04Hooks): MeshModel {
  const positions = Array.from(mesh.positions);
  const indices = Array.from(mesh.indices);
  if (positions.length % 2 !== 0) oracleError('odd mesh position count');
  if (indices.length % 3 !== 0) oracleError('mesh index count is not a multiple of 3');
  const vertexCount = positions.length / 2;
  const keyToPoint = new Map<string, number>();
  const points: QP[] = [];
  const vertexOf: number[] = [];
  for (let v = 0; v < vertexCount; v += 1) {
    const p = qp(scalarQ(positions[2 * v]!), scalarQ(positions[2 * v + 1]!));
    const key = qpkey(p);
    let id = keyToPoint.get(key);
    if (id === undefined) {
      id = points.length;
      keyToPoint.set(key, id);
      points.push(p);
    }
    vertexOf.push(id);
  }
  const pointIv = points.map(qpIv);
  const triangles: [number, number, number][] = [];
  for (let k = 0; k < indices.length; k += 3) {
    const tri = [indices[k]!, indices[k + 1]!, indices[k + 2]!].map((index) => {
      if (!Number.isInteger(index) || index < 0 || index >= vertexCount)
        oracleError(`mesh index ${index} out of range`);
      return vertexOf[index]!;
    });
    triangles.push([tri[0]!, tri[1]!, tri[2]!]);
  }
  if (triangles.length === 0) return EMPTY_MESH;
  const edgeKey = (i: number, j: number): string => (i < j ? `${i}:${j}` : `${j}:${i}`);
  const uniqueEdges = new Map<string, readonly [number, number]>();
  const triEdges = (t: readonly [number, number, number]) =>
    [
      [t[0], t[1]],
      [t[1], t[2]],
      [t[2], t[0]],
    ] as const;
  for (const tri of triangles)
    for (const [i, j] of triEdges(tri)) {
      if (i === j) continue;
      const key = edgeKey(i, j);
      if (!uniqueEdges.has(key)) uniqueEdges.set(key, i < j ? [i, j] : [j, i]);
    }
  const interior = interiorPointsOfEdges(points, pointIv, [...uniqueEdges.values()]);
  let tJunctions = 0;
  for (const list of interior.values()) tJunctions += list.length;
  const split = hooks.splitAtTVertices ?? true;
  const usage = new Map<string, { i: number; j: number; count: number }>();
  for (const tri of triangles)
    for (const [i, j] of triEdges(tri)) {
      if (i === j) continue;
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      const chain = [lo, ...(split ? (interior.get(`${lo}:${hi}`) ?? []) : []), hi];
      for (let k = 0; k + 1 < chain.length; k += 1) {
        const key = edgeKey(chain[k]!, chain[k + 1]!);
        const entry = usage.get(key);
        if (entry === undefined) usage.set(key, { i: chain[k]!, j: chain[k + 1]!, count: 1 });
        else entry.count += 1;
      }
    }
  const boundary: Seg[] = [];
  for (const entry of usage.values())
    if (entry.count === 1) boundary.push(makeSeg(points[entry.i]!, points[entry.j]!));
  const triangleBoxes = triangles.map(([a, b, c]) =>
    boxOfIvPoints([pointIv[a]!, pointIv[b]!, pointIv[c]!]),
  );
  const box = boxOfIvPoints(pointIv);
  const triIndex = new GridIndex<number>(box, gridSize(triangles.length), (k) => triangleBoxes[k]!);
  triangles.forEach((_, k) => triIndex.insert(k));
  const invalid = meshPreconditionFailure(points, triangles, triangleBoxes, triIndex);
  let segIndex: GridIndex<Seg> | null = null;
  if (boundary.length > 0) {
    segIndex = new GridIndex<Seg>(box, gridSize(boundary.length), (s) => s.box);
    for (const s of boundary) segIndex.insert(s);
  }
  return {
    empty: false,
    points,
    triangles,
    triangleBoxes,
    boundary,
    tJunctions,
    invalid,
    triIndex,
    segIndex,
  };
}

/**
 * The first zero-area triangle or overlapping pair of the mesh, exactly, or null. Two triangles
 * of positive area have disjoint interiors exactly when the line of an edge of one of them has
 * the other triangle in its closed opposite half-plane (separating axes of convex polygons: the
 * edge of the Minkowski difference that faces the origin comes from an edge of one triangle).
 */
function meshPreconditionFailure(
  points: readonly QP[],
  triangles: readonly (readonly [number, number, number])[],
  boxes: readonly Box[],
  index: GridIndex<number>,
): string | null {
  const at = (t: readonly [number, number, number]) => t.map((i) => points[i]!);
  const orientation = triangles.map(([a, b, c]) => orient(points[a]!, points[b]!, points[c]!));
  const zero = orientation.findIndex((o) => o === 0);
  if (zero >= 0) return `zero-area triangle ${zero}`;
  const separated = (p: readonly QP[], sp: number, q: readonly QP[]): boolean => {
    for (let i = 0; i < 3; i += 1) {
      const a = p[i]!;
      const b = p[(i + 1) % 3]!;
      if (q.every((v) => orient(a, b, v) * sp <= 0)) return true;
    }
    return false;
  };
  for (let j = 0; j < triangles.length; j += 1) {
    const tj = at(triangles[j]!);
    let found = -1;
    index.visit(boxes[j]!, (k) => {
      if (found >= 0 || k <= j || !boxesMeet(boxes[k]!, boxes[j]!)) return;
      charge(W_PAIR, 1);
      const tk = at(triangles[k]!);
      if (!separated(tj, orientation[j]!, tk) && !separated(tk, orientation[k]!, tj)) found = k;
    });
    if (found >= 0) return `overlapping triangles ${j} and ${found}`;
  }
  return null;
}

/** Exact closed-triangle membership; a degenerate triangle is its segment hull. */
function triangleContains(a: QP, b: QP, c: QP, p: QP): boolean {
  const o1 = orient(a, b, p);
  const o2 = orient(b, c, p);
  const o3 = orient(c, a, p);
  if (orient(a, b, c) !== 0)
    return (o1 >= 0 && o2 >= 0 && o3 >= 0) || (o1 <= 0 && o2 <= 0 && o3 <= 0);
  if (o1 !== 0 || o2 !== 0 || o3 !== 0) return false;
  const within = (v: Q, list: Q[]) =>
    list.some((u) => qcmp(u, v) <= 0) && list.some((u) => qcmp(u, v) >= 0);
  return within(p.x, [a.x, b.x, c.x]) && within(p.y, [a.y, b.y, c.y]);
}

function meshContains(m: MeshModel, p: QP): boolean {
  if (m.empty || m.triIndex === null) return false;
  const pb = boxOfIvPoints([qpIv(p)]);
  let found = false;
  m.triIndex.visit(pb, (k) => {
    if (found || !boxesMeet(m.triangleBoxes[k]!, pb)) return;
    const [a, b, c] = m.triangles[k]!;
    if (triangleContains(m.points[a]!, m.points[b]!, m.points[c]!, p)) found = true;
  });
  return found;
}

function segmentMayMeetBox(a: IvP, b: IvP, box: Box): boolean {
  if (!boxesMeet(boxOfIvPoints([a, b]), box)) return false;
  const d = ivpSub(b, a);
  let pos = false;
  let neg = false;
  for (const [x, y] of [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ] as const) {
    const s = ivpCross(d, ivpSub(ivpc(x, y), a));
    if (s.hi >= 0) pos = true;
    if (s.lo <= 0) neg = true;
  }
  return pos && neg;
}

/** Conservative: false only when no ∂M segment can meet the box. */
function meshBoundaryMayMeet(m: MeshModel, box: Box): boolean {
  if (m.segIndex === null) return false;
  let hit = false;
  m.segIndex.visit(box, (s) => {
    if (!hit && segmentMayMeetBox(s.ia, s.ib, box)) hit = true;
  });
  return hit;
}

/**
 * Storage cracks (E3-K2): every T-vertex of the Float64 port mesh (a vertex in the relative
 * interior of another triangle's edge) is checked again in the mapped mesh `M*` with the same
 * indices. A T-vertex that is off its edge in `M*` is a storage crack.
 */
export function a04StorageCracks(
  portMesh: A04Mesh,
  mapped: A04Mesh,
): Readonly<{ tJunctions: number; storageCracks: number }> {
  const port = Array.from(portMesh.positions).map(scalarQ);
  const mappedPositions = Array.from(mapped.positions).map(scalarQ);
  const indices = Array.from(portMesh.indices);
  if (port.length !== mappedPositions.length) oracleError('port and mapped meshes differ in size');
  const vertex = (list: Q[], v: number): QP => qp(list[2 * v]!, list[2 * v + 1]!);
  const n = port.length / 2;
  const pts = Array.from({ length: n }, (_, v) => vertex(port, v));
  const ivs = pts.map(qpIv);
  const edges = new Map<string, readonly [number, number]>();
  for (let k = 0; k + 2 < indices.length; k += 3) {
    const tri = [indices[k]!, indices[k + 1]!, indices[k + 2]!];
    for (let e = 0; e < 3; e += 1) {
      const i = tri[e]!;
      const j = tri[(e + 1) % 3]!;
      if (qpeq(pts[i]!, pts[j]!)) continue;
      edges.set(i < j ? `${i}:${j}` : `${j}:${i}`, i < j ? [i, j] : [j, i]);
    }
  }
  const interior = interiorPointsOfEdges(pts, ivs, [...edges.values()]);
  // One T-junction per distinct (edge, point) pair of the Float64 mesh; it is a storage crack
  // when any mapped copy of the point leaves any mapped copy of the edge.
  const junctions = new Map<string, boolean>();
  for (const [key, list] of interior) {
    const [i, j] = key.split(':').map(Number) as [number, number];
    const edgeKey = [qpkey(pts[i]!), qpkey(pts[j]!)].sort().join('|');
    const a = vertex(mappedPositions, i);
    const b = vertex(mappedPositions, j);
    for (const k of list) {
      if (qpeq(pts[k]!, pts[i]!) || qpeq(pts[k]!, pts[j]!)) continue;
      const jKey = `${edgeKey}#${qpkey(pts[k]!)}`;
      const p = vertex(mappedPositions, k);
      const ab = qpsub(b, a);
      const onEdge =
        orient(a, b, p) === 0 &&
        qsgn(qpdot(qpsub(p, a), ab)) > 0 &&
        qsgn(qpdot(qpsub(p, b), ab)) < 0;
      junctions.set(jKey, (junctions.get(jKey) ?? false) || !onEdge);
    }
  }
  let storageCracks = 0;
  for (const cracked of junctions.values()) if (cracked) storageCracks += 1;
  return { tJunctions: junctions.size, storageCracks };
}

// =============================================================================================
// 7. Work accounting (section 4.4, work limit)

/** Thrown when a case exceeds the oracle work cap (`ORACLE-WORK` at the freeze). */
export class A04WorkLimitError extends Error {
  constructor(readonly where: string) {
    super(`a04-oracle: work cap exceeded in ${where}`);
  }
}

/** Thrown for geometry the oracle does not support (`ORACLE-UNSUPPORTED` at the freeze). */
export class A04UnsupportedError extends Error {
  constructor(readonly reason: string) {
    super(`a04-oracle: unsupported: ${reason}`);
  }
}

function spend(work: Work, units: number, where: string): void {
  work.counts[W_STRUCTURE]! += units;
  work.units += units * WORK_WEIGHTS[W_STRUCTURE]!;
  if (work.units > work.cap) throw new A04WorkLimitError(where);
}

function workByKind(work: Work): Record<string, number> {
  const out: Record<string, number> = {};
  WORK_KINDS.forEach((k, i) => {
    if (work.counts[i]! > 0) out[k] = work.counts[i]!;
  });
  return out;
}

// =============================================================================================
// 8. The fill ideal region: exact winding (obligation (a)) and closure membership

type FLine = Readonly<{ kind: 'line'; a: QP; b: QP; mult: number; box: Box }>;
type FCubic = Readonly<{
  kind: 'cubic';
  p: readonly [QP, QP, QP, QP];
  mult: number;
  box: Box;
  /** The original cubic this piece comes from, and its parameter range there. */
  origin: number;
  t0: Q;
  t1: Q;
}>;
type FCurve = FLine | FCubic;

const curveBox = (points: readonly QP[]): Box => boxOfIvPoints(points.map(qpIv));

/** Exact de Casteljau split of a cubic at rational t. */
function splitCubic(p: readonly QP[], t: Q): [QP[], QP[]] {
  const [p0, p1, p2, p3] = p as [QP, QP, QP, QP];
  const a = qplerp(p0, p1, t);
  const b = qplerp(p1, p2, t);
  const c = qplerp(p2, p3, t);
  const d = qplerp(a, b, t);
  const e = qplerp(b, c, t);
  const f = qplerp(d, e, t);
  return [
    [p0, a, d, f],
    [f, e, c, p3],
  ];
}

/** The sub-arc of a cubic over [u0, u1]. */
function subCubic(p: readonly QP[], u0: Q, u1: Q): QP[] {
  let q: readonly QP[] = p;
  if (!qeq(u1, Q1)) q = splitCubic(q, u1)[0];
  if (u0.n !== 0n) q = splitCubic(q, qdiv(u0, u1))[1];
  return [...q];
}

/** Power-basis coefficients (per axis) of a cubic: C(t) = Σ k_i t^i. */
function cubicPower(p: readonly QP[]): { x: Q[]; y: Q[] } {
  const axis = (k: 'x' | 'y') => bernsteinToPower(p.map((v) => v[k]));
  return { x: axis('x'), y: axis('y') };
}

const cubicAt = (p: readonly QP[], t: Q): QP => {
  const pw = cubicPower(p);
  return { x: peval(pw.x, t), y: peval(pw.y, t) };
};

function collinear(points: readonly QP[]): boolean {
  const p0 = points[0]!;
  for (let i = 1; i < points.length; i += 1)
    for (let j = i + 1; j < points.length; j += 1)
      if (qsgn(qpcross(qpsub(points[i]!, p0), qpsub(points[j]!, p0))) !== 0) return false;
  return true;
}

type FillRegion = Readonly<{
  rule: A04FillRule;
  /** Curves defining the winding function: lines merged, duplicates cancelled. */
  curves: readonly FCurve[];
  contains: (p: QP) => boolean;
  windingAt: (p: QP, direction: QP) => number;
}>;

/** The case's fill path in physical pixels: every contour closed by its implicit edge. */
function fillCurves(c: Decoded, f: Frame): FCurve[] {
  const pts = c.points;
  let cursor = 0;
  const take = (): QP => {
    if (cursor + 2 > pts.length) oracleError('verbs need more points');
    const p = phi(f, qpn(pts[cursor]!, pts[cursor + 1]!));
    cursor += 2;
    return p;
  };
  const raw: { kind: 'line' | 'cubic'; p: QP[] }[] = [];
  let start: QP | null = null;
  let last: QP | null = null;
  const close = () => {
    if (start !== null && last !== null && !qpeq(start, last))
      raw.push({ kind: 'line', p: [last, start] });
  };
  for (const verb of c.verbs) {
    if (verb === 'M') {
      close();
      start = take();
      last = start;
    } else if (verb === 'L') {
      if (last === null) oracleError('LINE without MOVE');
      const p = take();
      raw.push({ kind: 'line', p: [last, p] });
      last = p;
    } else if (verb === 'C') {
      if (last === null) oracleError('CUBIC without MOVE');
      const p: QP[] = [last, take(), take(), take()];
      raw.push({ kind: 'cubic', p });
      last = p[3]!;
    } else {
      close();
      last = start;
    }
  }
  close();
  if (cursor !== pts.length) oracleError('unused path points');
  // Collinear cubics become their chord (the winding function is unchanged off the line and the
  // backtracking spike has the same winding on both sides); zero-length pieces are dropped.
  const lines: { a: QP; b: QP }[] = [];
  const cubics: QP[][] = [];
  for (const r of raw) {
    if (r.kind === 'line') {
      if (!qpeq(r.p[0]!, r.p[1]!)) lines.push({ a: r.p[0]!, b: r.p[1]! });
    } else if (collinear(r.p)) {
      if (!qpeq(r.p[0]!, r.p[3]!)) lines.push({ a: r.p[0]!, b: r.p[3]! });
    } else cubics.push(r.p);
  }
  const out: FCurve[] = [...mergeLines(lines)];
  // Exact duplicates (or exact reversals) of a cubic cancel or add (section 4.4).
  const cubicMult = new Map<string, { p: QP[]; mult: number }>();
  for (const p of cubics) {
    const key = p.map(qpkey).join(';');
    const reverse = [...p].reverse().map(qpkey).join(';');
    const forward = cubicMult.get(key);
    const backward = cubicMult.get(reverse);
    if (forward !== undefined) forward.mult += 1;
    else if (backward !== undefined) backward.mult -= 1;
    else cubicMult.set(key, { p, mult: 1 });
  }
  let origin = 0;
  for (const { p, mult } of cubicMult.values()) {
    if (mult === 0) continue;
    const q = p as unknown as readonly [QP, QP, QP, QP];
    out.push({ kind: 'cubic', p: q, mult, box: curveBox(p), origin, t0: Q0, t1: Q1 });
    origin += 1;
  }
  return out;
}

/** Collinear overlapping lines are split at every endpoint and their signed counts summed. */
function mergeLines(lines: readonly { a: QP; b: QP }[]): FLine[] {
  const groups = new Map<string, { a: QP; b: QP }[]>();
  for (const line of lines) {
    const d = qpsub(line.b, line.a);
    // Canonical supporting line A·x + B·y = C, scaled so the first nonzero of (A, B) is 1.
    let A = qneg(d.y);
    let B = d.x;
    let C = qadd(qmul(A, line.a.x), qmul(B, line.a.y));
    const s = A.n !== 0n ? A : B;
    A = qdiv(A, s);
    B = qdiv(B, s);
    C = qdiv(C, s);
    const key = `${A.n}/${A.d};${B.n}/${B.d};${C.n}/${C.d}`;
    let list = groups.get(key);
    if (list === undefined) groups.set(key, (list = []));
    list.push(line);
  }
  const out: FLine[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      const { a, b } = list[0]!;
      out.push({ kind: 'line', a, b, mult: 1, box: curveBox([a, b]) });
      continue;
    }
    const e = qpsub(list[0]!.b, list[0]!.a);
    const param = (p: QP) => qpdot(p, e);
    const stops = new Map<string, { u: Q; p: QP }>();
    for (const { a, b } of list) {
      stops.set(qpkey(a), { u: param(a), p: a });
      stops.set(qpkey(b), { u: param(b), p: b });
    }
    const sorted = [...stops.values()].sort((u, v) => qcmp(u.u, v.u));
    for (let k = 0; k + 1 < sorted.length; k += 1) {
      const lo = sorted[k]!;
      const hi = sorted[k + 1]!;
      let mult = 0;
      for (const { a, b } of list) {
        const ua = param(a);
        const ub = param(b);
        const forward = qcmp(ua, ub) < 0;
        const min = forward ? ua : ub;
        const max = forward ? ub : ua;
        if (qcmp(min, lo.u) <= 0 && qcmp(max, hi.u) >= 0) mult += forward ? 1 : -1;
      }
      if (mult !== 0)
        out.push({ kind: 'line', a: lo.p, b: hi.p, mult, box: curveBox([lo.p, hi.p]) });
    }
  }
  return out;
}

const transitionState = (v: Q): number => (qsgn(v) > 0 ? 1 : 0);

/** Exact transitions of one line across the ray m + τ·v, τ > 0 (half-open rule). */
function lineTransitions(a: QP, b: QP, m: QP, v: QP): number {
  const ga = qpcross(v, qpsub(a, m));
  const gb = qpcross(v, qpsub(b, m));
  const sa = transitionState(ga);
  const sb = transitionState(gb);
  if (sa === sb) return 0;
  const ta = qpdot(v, qpsub(a, m));
  const tb = qpdot(v, qpsub(b, m));
  const num = qsub(qmul(ga, tb), qmul(ta, gb));
  const tauSign = qsgn(num) * qsgn(qsub(ga, gb));
  if (tauSign <= 0) return 0;
  return sb - sa;
}

/** Sign of g just right (side 1) or just left (side -1) of the exact root r. */
function sideSign(g: Poly, r: Q, side: 1 | -1): number {
  let p = ptrim(g);
  for (let k = 0; k <= 4 && p.length > 0; k += 1) {
    const v = qsgn(peval(p, r));
    if (v !== 0) return side === 1 || k % 2 === 0 ? v : -v;
    p = pderiv(p);
  }
  return 0;
}

/** Exact transitions of a Bernstein piece (control values g, τ) on [0, 1]. */
function bernsteinTransitions(g: readonly Q[], tau: readonly Q[], depth: number): number {
  if (g.every((v) => qsgn(v) > 0) || g.every((v) => qsgn(v) < 0)) return 0;
  if (tau.every((v) => qsgn(v) <= 0)) return 0;
  if (tau.every((v) => qsgn(v) > 0))
    return transitionState(g[g.length - 1]!) - transitionState(g[0]!);
  if (depth < 4) {
    const half = (c: readonly Q[]): [Q[], Q[]] => {
      const levels: Q[][] = [[...c]];
      while (levels[levels.length - 1]!.length > 1) {
        const prev = levels[levels.length - 1]!;
        const next: Q[] = [];
        for (let i = 0; i + 1 < prev.length; i += 1) next.push(qmid(prev[i]!, prev[i + 1]!));
        levels.push(next);
      }
      return [levels.map((l) => l[0]!), levels.map((l) => l[l.length - 1]!).reverse()];
    };
    const [g0, g1] = half(g);
    const [t0, t1] = half(tau);
    return bernsteinTransitions(g0, t0, depth + 1) + bernsteinTransitions(g1, t1, depth + 1);
  }
  const gp = bernsteinToPower(g);
  const tp = bernsteinToPower(tau);
  if (gp.length === 0) return 0;
  const { s, roots } = isolateRoots(gp, Q0, Q1);
  let total = 0;
  for (const root of roots) {
    let left: number;
    let right: number;
    if (root.exact !== null) {
      left = root.exact.n === 0n ? 0 : sideSign(gp, root.exact, -1);
      right = qeq(root.exact, Q1) ? 0 : sideSign(gp, root.exact, 1);
    } else {
      left = qsgn(peval(gp, root.lo));
      right = qsgn(peval(gp, root.hi));
    }
    const tauSign = signAtRoot(tp, s, root);
    if (tauSign <= 0) continue;
    total += (right > 0 ? 1 : 0) - (left > 0 ? 1 : 0);
  }
  return total;
}

function cubicTransitions(p: readonly QP[], m: QP, v: QP): number {
  const g = p.map((c) => qpcross(v, qpsub(c, m)));
  const tau = p.map((c) => qpdot(v, qpsub(c, m)));
  return bernsteinTransitions(g, tau, 0);
}

/** Conservative float pre-test: true when the curve certainly has no transition on the ray. */
function rayMisses(box: Box, m: IvP, v: IvP): boolean {
  let allBehind = true;
  let gPos = true;
  let gNeg = true;
  for (const [x, y] of [
    [box.x0, box.y0],
    [box.x1, box.y0],
    [box.x1, box.y1],
    [box.x0, box.y1],
  ] as const) {
    const d = ivpSub(ivpc(x, y), m);
    const t = ivpDot(v, d);
    const g = ivpCross(v, d);
    if (t.hi >= 0) allBehind = false;
    if (g.lo <= 0) gPos = false;
    if (g.hi >= 0) gNeg = false;
  }
  return allBehind || gPos || gNeg;
}

function windingAtCurves(curves: readonly FCurve[], m: QP, v: QP): number {
  const mi = qpIv(m);
  const vi = qpIv(v);
  let w = 0;
  for (const curve of curves) {
    if (rayMisses(curve.box, mi, vi)) continue;
    const k =
      curve.kind === 'line'
        ? lineTransitions(curve.a, curve.b, m, v)
        : cubicTransitions(curve.p, m, v);
    w += k * curve.mult;
  }
  return w;
}

const angleHalf = (v: QP): number => (qsgn(v.y) > 0 || (v.y.n === 0n && qsgn(v.x) > 0) ? 0 : 1);
const angleCompare = (a: QP, b: QP): number => {
  const h = angleHalf(a) - angleHalf(b);
  if (h !== 0) return h;
  return -qsgn(qpcross(a, b));
};

/** Directions of the branches of the curves through p (empty when p is on no curve). */
function branchesAt(curves: readonly FCurve[], p: QP): QP[] {
  const out: QP[] = [];
  const pi = qpIv(p);
  for (const curve of curves) {
    const b = curve.box;
    if (pi.x.hi < b.x0 || pi.x.lo > b.x1 || pi.y.hi < b.y0 || pi.y.lo > b.y1) continue;
    if (curve.kind === 'line') {
      if (orient(curve.a, curve.b, p) !== 0) continue;
      const d = qpsub(curve.b, curve.a);
      const s = qpdot(qpsub(p, curve.a), d);
      if (qsgn(s) < 0 || qcmp(s, qpdot(d, d)) > 0) continue;
      if (qpeq(p, curve.a)) out.push(d);
      else if (qpeq(p, curve.b)) out.push(qpneg(d));
      else out.push(d, qpneg(d));
      continue;
    }
    const pw = cubicPower(curve.p);
    const gx = psub(pw.x, [p.x]);
    const gy = psub(pw.y, [p.y]);
    const h = pgcd(gx, gy);
    if (h.length < 2) continue;
    const { roots } = isolateRoots(h, Q0, Q1);
    for (const root of roots) {
      // A dyadic parameter shows up as an exact midpoint within a few refinements.
      const hs = psquarefree(h);
      for (let k = 0; k < 64 && root.exact === null; k += 1) refineRoot(hs, root);
      if (root.exact === null)
        throw new A04UnsupportedError('a point lies on a cubic at an irrational parameter');
      const t = root.exact;
      let dx: Q[] = pw.x;
      let dy: Q[] = pw.y;
      let dir: QP | null = null;
      let order = 0;
      for (let k = 1; k <= 3; k += 1) {
        dx = pderiv(dx);
        dy = pderiv(dy);
        const v = { x: peval(dx, t), y: peval(dy, t) };
        if (!qpzero(v)) {
          dir = v;
          order = k;
          break;
        }
      }
      if (dir === null) throw new A04UnsupportedError('a stationary point of order above 3');
      if (qcmp(t, Q1) < 0) out.push(dir);
      if (t.n !== 0n) out.push(order % 2 === 0 ? dir : qpneg(dir));
    }
  }
  return out;
}

/** Membership in the closed region: some open sector around p has `rule` true. */
function closureContains(
  curves: readonly FCurve[],
  p: QP,
  inside: (w: number) => boolean,
): boolean {
  const branches = branchesAt(curves, p);
  if (branches.length === 0) return inside(windingAtCurves(curves, p, { x: Q1, y: Q0 }));
  const sorted = [...branches].sort(angleCompare);
  const dirs: QP[] = [];
  for (const d of sorted) {
    const prev = dirs[dirs.length - 1];
    if (prev !== undefined && qsgn(qpcross(prev, d)) === 0 && qsgn(qpdot(prev, d)) > 0)
      throw new A04UnsupportedError('two branches leave a point in one direction');
    dirs.push(d);
  }
  const first = dirs[0]!;
  const last = dirs[dirs.length - 1]!;
  if (dirs.length > 1 && qsgn(qpcross(last, first)) === 0 && qsgn(qpdot(last, first)) > 0)
    throw new A04UnsupportedError('two branches leave a point in one direction');
  if (dirs.length === 1) return inside(windingAtCurves(curves, p, qpneg(first)));
  for (let i = 0; i < dirs.length; i += 1) {
    const a = dirs[i]!;
    const b = dirs[(i + 1) % dirs.length]!;
    const v = qsgn(qpcross(a, b)) > 0 ? qpadd(a, b) : qpperp(a);
    if (inside(windingAtCurves(curves, p, v))) return true;
  }
  return false;
}

function makeFillRegion(c: Decoded, f: Frame, hooks: A04Hooks): FillRegion {
  if (c.paint.kind !== 'fill') oracleError('not a fill case');
  const rule = c.paint.rule;
  const curves = fillCurves(c, f);
  const inside = (w: number) =>
    hooks.fillRule === undefined
      ? rule === 'nonzero'
        ? w !== 0
        : w % 2 !== 0
      : hooks.fillRule(rule, w);
  return {
    rule,
    curves,
    contains: (p) => closureContains(curves, p, inside),
    windingAt: (p, v) => windingAtCurves(curves, p, v),
  };
}

/** The exact winding number of the case's fill path around a physical point not on the path. */
export function a04Winding(input: A04Case, point: readonly [number, number]): number {
  const c = decodeCase(input);
  const f = makeFrame(c, {});
  const region = makeFillRegion(c, f, {});
  const p = qpn(point[0], point[1]);
  if (branchesAt(region.curves, p).length > 0) oracleError('the point lies on the path');
  return region.windingAt(p, { x: Q1, y: Q0 });
}

// =============================================================================================
// 9. The fill arrangement: boundary portions of ∂R (obligations (c) and (d) for fills)

/**
 * One cut on an arrangement curve: an exact parameter, or a parameter interval (a "bit") that
 * contains one or more crossings. `crossings` names the crossings it contains; `unique` is true
 * when it is certified to contain exactly one.
 */
export type A04Crossing = Readonly<{ curve: number; lo: Q; hi: Q; id: number; unique: boolean }>;

type Cut = { lo: Q; hi: Q; ids: Set<number>; unique: boolean };

/** Bit size target: every isolated crossing is refined below this image diameter (px). */
const BIT_SIZE = 2 ** -24;

type Cone = Readonly<{ a: QP; b: QP }>;

/** The closed cone spanned by the nonzero hodograph vectors, or null when it spans π or more. */
function hodographCone(p: readonly QP[]): Cone | null {
  const vs: QP[] = [];
  for (let i = 0; i + 1 < p.length; i += 1) {
    const v = qpsub(p[i + 1]!, p[i]!);
    if (!qpzero(v)) vs.push(v);
  }
  if (vs.length === 0) return null;
  let a: QP | null = null;
  let b: QP | null = null;
  for (const c of vs) {
    if (
      vs.every(
        (w) => qsgn(qpcross(c, w)) >= 0 && (qsgn(qpcross(c, w)) > 0 || qsgn(qpdot(c, w)) > 0),
      )
    )
      a = c;
    if (
      vs.every(
        (w) => qsgn(qpcross(w, c)) >= 0 && (qsgn(qpcross(w, c)) > 0 || qsgn(qpdot(c, w)) > 0),
      )
    )
      b = c;
  }
  if (a === null || b === null) return null;
  const cr = qsgn(qpcross(a, b));
  if (cr < 0 || (cr === 0 && qsgn(qpdot(a, b)) <= 0)) return null;
  return { a, b };
}

function inCone(k: Cone, v: QP): boolean {
  if (qsgn(qpcross(k.a, k.b)) === 0) return qsgn(qpcross(k.a, v)) === 0 && qsgn(qpdot(k.a, v)) > 0;
  return qsgn(qpcross(k.a, v)) >= 0 && qsgn(qpcross(v, k.b)) >= 0;
}

const conesMeet = (k1: Cone, k2: Cone): boolean =>
  inCone(k1, k2.a) || inCone(k1, k2.b) || inCone(k2, k1.a) || inCone(k2, k1.b);
const coneNeg = (k: Cone): Cone => ({ a: qpneg(k.a), b: qpneg(k.b) });

/** Two curve pieces with tangent cones disjoint as undirected lines meet at most once. */
function conesSeparated(pa: readonly QP[], pb: readonly QP[]): boolean {
  const ka = hodographCone(pa);
  const kb = hodographCone(pb);
  if (ka === null || kb === null) return false;
  return !conesMeet(ka, kb) && !conesMeet(ka, coneNeg(kb));
}

/**
 * Two pieces that share the exact point P meet nowhere else when σA·KA and σB·KB are disjoint,
 * σ = +1 when P starts the piece and −1 when it ends it (the chord from P to a second common
 * point would lie in both).
 */
function sharedPointOnly(pa: readonly QP[], sa: number, pb: readonly QP[], sb: number): boolean {
  const ka = hodographCone(pa);
  const kb = hodographCone(pb);
  if (ka === null || kb === null) return false;
  return !conesMeet(sa > 0 ? ka : coneNeg(ka), sb > 0 ? kb : coneNeg(kb));
}

type ArrCurve = FCurve & { readonly index: number; cuts: Cut[] };

type BitClass = 'boundary' | 'non' | 'partial' | 'unknown';

/** One portion of an arrangement curve: certain (no other curve touches it) or a bit. */
export type A04Portion = Readonly<{
  curve: number;
  kind: 'line' | 'cubic';
  /** Parameter range on the arrangement curve. */
  u0: number;
  u1: number;
  certain: boolean;
  boundary: boolean | null;
  bitClass: BitClass | null;
  /** Approximate endpoints, for reports and closed-form comparisons in tests. */
  start: readonly [number, number];
  end: readonly [number, number];
}>;

type FillPortion = Readonly<{
  curve: ArrCurve;
  u0: Q;
  u1: Q;
  certain: boolean;
  boundary: boolean;
  bitClass: BitClass | null;
}>;

type Arrangement = Readonly<{
  curves: readonly ArrCurve[];
  portions: readonly FillPortion[];
  crossings: number;
}>;

/** Pre-subdivides the curves to the index region and drops pieces that miss it. */
function clipCurves(curves: readonly FCurve[], region: Box, work: Work): FCurve[] {
  const out: FCurve[] = [];
  const size = Math.max(region.x1 - region.x0, region.y1 - region.y0);
  const visit = (c: FCubic, depth: number) => {
    spend(work, 1, 'fill clipping');
    if (!boxesMeet(c.box, region)) return;
    const inside =
      c.box.x0 >= region.x0 &&
      c.box.x1 <= region.x1 &&
      c.box.y0 >= region.y0 &&
      c.box.y1 <= region.y1;
    if (inside || boxDiam(c.box) <= size / 2 || depth >= 60) {
      out.push(c);
      return;
    }
    const tm = qmid(c.t0, c.t1);
    const [l, r] = splitCubic(c.p, QHALF);
    visit({ ...c, p: l as unknown as FCubic['p'], box: curveBox(l), t1: tm }, depth + 1);
    visit({ ...c, p: r as unknown as FCubic['p'], box: curveBox(r), t0: tm }, depth + 1);
  };
  for (const c of curves) {
    if (c.kind === 'line') {
      if (boxesMeet(c.box, region)) out.push(c);
    } else visit(c, 0);
  }
  return out;
}

function addCut(curve: ArrCurve, lo: Q, hi: Q, id: number, unique: boolean): void {
  if (qcmp(hi, Q0) <= 0 || qcmp(lo, Q1) >= 0) return;
  curve.cuts.push({ lo: qmax(lo, Q0), hi: qmin(hi, Q1), ids: new Set([id]), unique });
}

/** Extent bound of a cubic's image over a parameter interval, by exact ranges per axis. */
function cubicImageExtent(pw: { x: Q[]; y: Q[] }, lo: Q, hi: Q): number {
  const rx = prange(pw.x, lo, hi);
  const ry = prange(pw.y, lo, hi);
  return Math.max(qIv(qsub(rx.hi, rx.lo)).hi, qIv(qsub(ry.hi, ry.lo)).hi);
}

function buildArrangement(
  allCurves: readonly FCurve[],
  region: Box,
  inside: (w: number) => boolean,
  hooks: A04Hooks,
  work: Work,
): Arrangement {
  const clipped = clipCurves(allCurves, region, work);
  const curves: ArrCurve[] = clipped.map((c, index) => ({ ...c, index, cuts: [] }));
  let nextId = 0;
  const crossings: A04Crossing[] = [];
  const record = (curve: ArrCurve, lo: Q, hi: Q, id: number, unique: boolean) =>
    crossings.push({ curve: curve.index, lo, hi, id, unique });
  // Pairs with overlapping boxes (sorted sweep on x).
  const order = [...curves].sort((a, b) => a.box.x0 - b.box.x0);
  for (let i = 0; i < order.length; i += 1) {
    const A = order[i]!;
    for (let j = i + 1; j < order.length; j += 1) {
      const B = order[j]!;
      if (B.box.x0 > A.box.x1) break;
      if (!boxesMeet(A.box, B.box)) continue;
      spend(work, 1, 'fill pairs');
      if (A.kind === 'line' && B.kind === 'line') {
        const d1 = qpsub(A.b, A.a);
        const d2 = qpsub(B.b, B.a);
        const den = qpcross(d1, d2);
        if (den.n === 0n) continue;
        const w = qpsub(B.a, A.a);
        const s = qdiv(qpcross(w, d2), den);
        const u = qdiv(qpcross(w, d1), den);
        if (qsgn(s) < 0 || qcmp(s, Q1) > 0 || qsgn(u) < 0 || qcmp(u, Q1) > 0) continue;
        const id = nextId++;
        record(A, s, s, id, true);
        record(B, u, u, id, true);
      } else if (A.kind === 'cubic' && B.kind === 'cubic') {
        if (A.origin === B.origin) continue;
        cubicCubic(A, B, () => nextId++, record, work);
      } else {
        const L = (A.kind === 'line' ? A : B) as ArrCurve & FLine;
        const C = (A.kind === 'cubic' ? A : B) as ArrCurve & FCubic;
        lineCubic(L, C, () => nextId++, record, work);
      }
    }
  }
  selfIntersections(allCurves, curves, () => nextId++, record);
  const kept = hooks.crossings === undefined ? crossings : hooks.crossings(crossings);
  for (const k of kept) addCut(curves[k.curve]!, k.lo, k.hi, k.id, k.unique);
  // Merge overlapping cuts into bits and classify the certain portions between them.
  const portions: FillPortion[] = [];
  for (const curve of curves) {
    const cuts = curve.cuts.sort((u, v) => qcmp(u.lo, v.lo));
    const merged: Cut[] = [];
    for (const cut of cuts) {
      const prev = merged[merged.length - 1];
      if (prev !== undefined && qcmp(cut.lo, prev.hi) <= 0) {
        if (qcmp(cut.hi, prev.hi) > 0) prev.hi = cut.hi;
        for (const id of cut.ids) prev.ids.add(id);
        prev.unique = prev.unique && cut.unique && prev.ids.size === 1;
      } else merged.push({ lo: cut.lo, hi: cut.hi, ids: new Set(cut.ids), unique: cut.unique });
    }
    const pieces: { u0: Q; u1: Q; bit: Cut | null }[] = [];
    let cursor = Q0;
    for (const cut of merged) {
      if (qcmp(cut.lo, cursor) > 0) pieces.push({ u0: cursor, u1: cut.lo, bit: null });
      if (qcmp(cut.hi, cut.lo) > 0) pieces.push({ u0: cut.lo, u1: cut.hi, bit: cut });
      cursor = qmax(cursor, cut.hi);
    }
    if (qcmp(cursor, Q1) < 0) pieces.push({ u0: cursor, u1: Q1, bit: null });
    const cls: (boolean | null)[] = pieces.map((piece) => {
      if (piece.bit !== null) return null;
      spend(work, curves.length + 1, 'fill side classification');
      return portionIsBoundary(curve, piece.u0, piece.u1, allCurves, inside);
    });
    pieces.forEach((piece, k) => {
      if (piece.bit === null) {
        portions.push({
          curve,
          u0: piece.u0,
          u1: piece.u1,
          certain: true,
          boundary: cls[k]!,
          bitClass: null,
        });
        return;
      }
      const left = k > 0 ? cls[k - 1] : null;
      const right = k + 1 < pieces.length ? cls[k + 1] : null;
      let bitClass: BitClass;
      const anyBoundary = left === true || right === true;
      if (
        piece.bit.unique &&
        left !== null &&
        right !== null &&
        left !== undefined &&
        right !== undefined
      )
        bitClass = left && right ? 'boundary' : !left && !right ? 'non' : 'partial';
      else bitClass = anyBoundary ? 'partial' : 'unknown';
      portions.push({
        curve,
        u0: piece.u0,
        u1: piece.u1,
        certain: bitClass === 'boundary',
        boundary: bitClass !== 'non',
        bitClass,
      });
    });
  }
  return { curves, portions, crossings: kept.length };
}

/** Side classification of a certain portion at its midpoint (contract section 4.2). */
function portionIsBoundary(
  curve: FCurve,
  u0: Q,
  u1: Q,
  all: readonly FCurve[],
  inside: (w: number) => boolean,
): boolean {
  let m: QP;
  let tangent: QP;
  if (curve.kind === 'line') {
    m = qplerp(curve.a, curve.b, qmid(u0, u1));
    tangent = qpsub(curve.b, curve.a);
  } else {
    const pw = cubicPower(curve.p);
    const dx = pderiv(pw.x);
    const dy = pderiv(pw.y);
    let t = qmid(u0, u1);
    let d = { x: peval(dx, t), y: peval(dy, t) };
    for (let k = 3; qpzero(d) && k < 64; k += 1) {
      t = qadd(u0, qmul(qsub(u1, u0), qmk(1n, BigInt(k))));
      d = { x: peval(dx, t), y: peval(dy, t) };
    }
    if (qpzero(d)) oracleError('no regular parameter in a portion');
    m = { x: peval(pw.x, t), y: peval(pw.y, t) };
    tangent = d;
  }
  const n = qpperp(tangent);
  return inside(windingAtCurves(all, m, n)) !== inside(windingAtCurves(all, m, qpneg(n)));
}

function lineCubic(
  L: ArrCurve & FLine,
  C: ArrCurve & FCubic,
  newId: () => number,
  record: (c: ArrCurve, lo: Q, hi: Q, id: number, unique: boolean) => void,
  work: Work,
): void {
  const d = qpsub(L.b, L.a);
  const dd = qpdot(d, d);
  const g = C.p.map((p) => qpcross(d, qpsub(p, L.a)));
  if (g.every((v) => qsgn(v) > 0) || g.every((v) => qsgn(v) < 0)) return;
  const gp = bernsteinToPower(g);
  const sigma = bernsteinToPower(C.p.map((p) => qpdot(d, qpsub(p, L.a))));
  const rest = psub([dd], sigma);
  const pw = cubicPower(C.p);
  const { s, roots } = isolateRoots(gp, Q0, Q1);
  for (const root of roots) {
    spend(work, 1, 'line-cubic roots');
    const s1 = signAtRoot(sigma, s, root);
    const s2 = signAtRoot(rest, s, root);
    if (s1 < 0 || s2 < 0) continue;
    const id = newId();
    for (let k = 0; k < 400 && root.exact === null; k += 1) {
      const ext = cubicImageExtent(pw, root.lo, root.hi);
      if (ext <= BIT_SIZE) break;
      refineRoot(s, root);
    }
    if (root.exact !== null) {
      record(C, root.exact, root.exact, id, true);
      const u = qdiv(peval(sigma, root.exact), dd);
      record(L, u, u, id, true);
      continue;
    }
    const r = prange(sigma, root.lo, root.hi);
    record(C, root.lo, root.hi, id, true);
    record(L, qdiv(r.lo, dd), qdiv(r.hi, dd), id, true);
  }
}

function cubicCubic(
  A: ArrCurve & FCubic,
  B: ArrCurve & FCubic,
  newId: () => number,
  record: (c: ArrCurve, lo: Q, hi: Q, id: number, unique: boolean) => void,
  work: Work,
): void {
  type Piece = { p: QP[]; t0: Q; t1: Q; box: Box };
  const piece = (p: QP[], t0: Q, t1: Q): Piece => ({ p, t0, t1, box: curveBox(p) });
  const split = (x: Piece): [Piece, Piece] => {
    const [l, r] = splitCubic(x.p, QHALF);
    const tm = qmid(x.t0, x.t1);
    return [piece(l, x.t0, tm), piece(r, tm, x.t1)];
  };
  const recurse = (a: Piece, b: Piece, uniqueId: number | null, depth: number): void => {
    spend(work, 1, 'cubic-cubic isolation');
    if (!boxesMeet(a.box, b.box)) return;
    const ends = [
      [a.p[0]!, 1, a.t0],
      [a.p[3]!, -1, a.t1],
    ] as const;
    const bends = [
      [b.p[0]!, 1, b.t0],
      [b.p[3]!, -1, b.t1],
    ] as const;
    const shared: [number, Q, number, Q][] = [];
    for (const [pa, sa, ta] of ends)
      for (const [pb, sb, tb] of bends) if (qpeq(pa, pb)) shared.push([sa, ta, sb, tb]);
    if (shared.length === 1) {
      const [sa, ta, sb, tb] = shared[0]!;
      if (sharedPointOnly(a.p, sa, b.p, sb)) {
        const id = newId();
        record(A, ta, ta, id, true);
        record(B, tb, tb, id, true);
        return;
      }
    }
    let unique = uniqueId;
    if (unique === null && shared.length === 0 && conesSeparated(a.p, b.p)) unique = newId();
    const da = boxDiam(a.box);
    const db = boxDiam(b.box);
    if ((da <= BIT_SIZE && db <= BIT_SIZE) || depth > 90) {
      const id = unique ?? newId();
      record(A, a.t0, a.t1, id, unique !== null);
      record(B, b.t0, b.t1, id, unique !== null);
      return;
    }
    if (da >= db) {
      const [a0, a1] = split(a);
      recurse(a0, b, unique, depth + 1);
      recurse(a1, b, unique, depth + 1);
    } else {
      const [b0, b1] = split(b);
      recurse(a, b0, unique, depth + 1);
      recurse(a, b1, unique, depth + 1);
    }
  };
  recurse(piece([...A.p], Q0, Q1), piece([...B.p], Q0, Q1), null, 0);
}

/** Rational bounds [lo, hi] on √v with relative width about 2^-bits. */
function sqrtBounds(v: Q, bits: number): { lo: Q; hi: Q; exact: boolean } {
  if (v.n === 0n) return { lo: Q0, hi: Q0, exact: true };
  const n = absB(v.n);
  const k = Math.max(0, Math.ceil((2 * bits - (bitLen(n) - bitLen(v.d))) / 2));
  const scaled = (n << BigInt(2 * k)) / v.d;
  let r = scaled < 2n ? scaled : 1n << BigInt((bitLen(scaled) + 1) >> 1);
  if (scaled >= 2n)
    for (;;) {
      const y = (r + scaled / r) >> 1n;
      if (y >= r) break;
      r = y;
    }
  const exact = r * r * v.d === n << BigInt(2 * k);
  const scale = 1n << BigInt(k);
  return { lo: qmk(r, scale), hi: exact ? qmk(r, scale) : qmk(r + 1n, scale), exact };
}

/** Self-intersections of each original cubic, in closed form (σ = s + t rational). */
function selfIntersections(
  all: readonly FCurve[],
  arr: readonly ArrCurve[],
  newId: () => number,
  record: (c: ArrCurve, lo: Q, hi: Q, id: number, unique: boolean) => void,
): void {
  for (const curve of all) {
    if (curve.kind !== 'cubic') continue;
    const pw = cubicPower(curve.p);
    const a3 = { x: pw.x[3] ?? Q0, y: pw.y[3] ?? Q0 };
    const a2 = { x: pw.x[2] ?? Q0, y: pw.y[2] ?? Q0 };
    const a1 = { x: pw.x[1] ?? Q0, y: pw.y[1] ?? Q0 };
    const c32 = qpcross(a3, a2);
    if (c32.n === 0n) continue;
    const sigma = qneg(qdiv(qpcross(a3, a1), c32));
    const comp = a3.x.n !== 0n ? 'x' : 'y';
    const pi = qadd(qsq(sigma), qdiv(qadd(qmul(a2[comp], sigma), a1[comp]), a3[comp]));
    const disc = qsub(qsq(sigma), qmul(qi(4), pi));
    if (qsgn(disc) <= 0) continue;
    const root = sqrtBounds(disc, 200);
    const sLo = qmul(qsub(sigma, root.hi), QHALF);
    const sHi = qmul(qsub(sigma, root.lo), QHALF);
    const tLo = qmul(qadd(sigma, root.lo), QHALF);
    const tHi = qmul(qadd(sigma, root.hi), QHALF);
    // Both parameters must lie in [0, 1], decided exactly in Q(√disc).
    const ge0 = (sign: number) => signRad(qmul(sigma, QHALF), qmul(qi(sign), QHALF), disc) >= 0;
    const le1 = (sign: number) =>
      signRad(qsub(Q1, qmul(sigma, QHALF)), qmul(qi(-sign), QHALF), disc) >= 0;
    if (!ge0(-1) || !le1(-1) || !ge0(1) || !le1(1)) continue;
    const id = newId();
    const place = (lo: Q, hi: Q) => {
      for (const piece of arr) {
        if (piece.kind !== 'cubic' || piece.origin !== curve.origin) continue;
        if (qcmp(hi, piece.t0) < 0 || qcmp(lo, piece.t1) > 0) continue;
        const span = qsub(piece.t1, piece.t0);
        record(piece, qdiv(qsub(lo, piece.t0), span), qdiv(qsub(hi, piece.t0), span), id, true);
      }
    };
    place(sLo, sHi);
    place(tLo, tHi);
  }
}

// =============================================================================================
// 10. Certified distance primitives (outward-rounded intervals)

/** Enclosure of the squared distance from p to segment [a, b]. */
function pointSegDist2(p: IvP, a: IvP, b: IvP): Iv {
  const d = ivpSub(b, a);
  const w = ivpSub(p, a);
  const dd = ivpNorm2(d);
  const wd = ivpDot(w, d);
  let lo = Infinity;
  let hi = -Infinity;
  const take = (v: Iv) => {
    lo = Math.min(lo, v.lo);
    hi = Math.max(hi, v.hi);
  };
  if (wd.lo <= 0) take(ivpNorm2(w));
  if (wd.hi >= dd.lo) take(ivpNorm2(ivpSub(p, b)));
  if (wd.hi > 0 && wd.lo < dd.hi && dd.lo > 0) take(idiv(isqr(ivpCross(d, w)), dd));
  if (lo === Infinity) take(ivpNorm2(w));
  return { lo: Math.max(0, lo), hi };
}

const sqrtIv = (v: Iv): Iv => isqrt(v);
const pointSegDist = (p: IvP, a: IvP, b: IvP): Iv => sqrtIv(pointSegDist2(p, a, b));
const pointPointDist = (p: IvP, q: IvP): Iv => sqrtIv(ivpNorm2(ivpSub(p, q)));

function segmentsMayCross(a: IvP, b: IvP, c: IvP, d: IvP): boolean {
  const straddles = (p: IvP, q: IvP, r: IvP, s: IvP) => {
    const dir = ivpSub(q, p);
    const s1 = ivpCross(dir, ivpSub(r, p));
    const s2 = ivpCross(dir, ivpSub(s, p));
    return !((s1.lo > 0 && s2.lo > 0) || (s1.hi < 0 && s2.hi < 0));
  };
  return straddles(a, b, c, d) && straddles(c, d, a, b);
}

/** Lower bound on the distance between two segments. */
function segSegDistLo(a: IvP, b: IvP, c: IvP, d: IvP): number {
  if (segmentsMayCross(a, b, c, d)) return 0;
  return Math.min(
    pointSegDist(a, c, d).lo,
    pointSegDist(b, c, d).lo,
    pointSegDist(c, a, b).lo,
    pointSegDist(d, a, b).lo,
  );
}

/** Lower bound on the distance from p to a box. */
function pointBoxDistLo(p: IvP, b: Box): number {
  return boxBoxDistLo({ x0: p.x.lo, y0: p.y.lo, x1: p.x.hi, y1: p.y.hi }, b);
}

const centerOf = (b: Box): IvP => ({
  x: iadd(imul(ivc(b.x0), ivc(0.5)), imul(ivc(b.x1), ivc(0.5))),
  y: iadd(imul(ivc(b.y0), ivc(0.5)), imul(ivc(b.y1), ivc(0.5))),
});

// =============================================================================================
// 11. The two boundary targets: ∂M (exact segments) and ∂R (certified elements)

/** ∂M: the boundary sub-edges of the drawn mesh. */
class MeshTarget {
  constructor(private readonly mesh: MeshModel) {}
  get empty(): boolean {
    return this.mesh.boundary.length === 0;
  }
  get segments(): readonly Seg[] {
    return this.mesh.boundary;
  }
  /** Visits segments whose boxes meet the box p ± r, growing r until `done`. */
  private search(p: IvP, visitor: (s: Seg) => void, done: (r: number) => boolean): number {
    const index = this.mesh.segIndex;
    if (index === null) return Infinity;
    let r = index.cellSize;
    const reach = Math.max(index.region.x1 - index.region.x0, index.region.y1 - index.region.y0);
    for (;;) {
      const q = { x0: p.x.lo - r, y0: p.y.lo - r, x1: p.x.hi + r, y1: p.y.hi + r };
      index.visit(q, visitor);
      const outside = pointBoxDistLo(p, index.region);
      if (done(r) || r > 4 * reach + outside) return r;
      r *= 2;
    }
  }
  dist(p: IvP): Iv {
    if (this.empty) return { lo: Infinity, hi: Infinity };
    let lo = Infinity;
    let hi = Infinity;
    const r = this.search(
      p,
      (s) => {
        const d = pointSegDist(p, s.ia, s.ib);
        lo = Math.min(lo, d.lo);
        hi = Math.min(hi, d.hi);
      },
      (radius) => hi <= radius,
    );
    return { lo: Math.min(lo, r), hi };
  }
  /** Lower bound on the distance from a segment [a, b] to ∂M. */
  segDistLo(a: IvP, b: IvP): number {
    if (this.empty) return Infinity;
    const box = boxOfIvPoints([a, b]);
    const c = centerOf(box);
    const half = boxDiam(box) / 2;
    let lo = Infinity;
    const r = this.search(
      c,
      (s) => {
        lo = Math.min(lo, segSegDistLo(a, b, s.ia, s.ib));
      },
      (radius) => lo <= radius - half,
    );
    return Math.min(lo, Math.max(0, r - half));
  }
  /** Upper bound on sup over the hull of `gens` of dist(·, ∂M), by convexity per segment. */
  supUpper(gens: readonly IvP[], hooks: A04Hooks): number {
    if (this.empty) return Infinity;
    const box = boxOfIvPoints(gens);
    const c = centerOf(box);
    const near: { s: Seg; d: number }[] = [];
    this.search(
      c,
      (s) => near.push({ s, d: pointSegDist(c, s.ia, s.ib).hi }),
      (radius) => near.some((n) => n.d <= radius),
    );
    near.sort((u, v) => u.d - v.d);
    let best = Infinity;
    for (const { s } of near.slice(0, 6)) {
      const v = cellSupUpper(gens, c, (g) => pointSegDist(g, s.ia, s.ib).hi, hooks);
      best = Math.min(best, v);
    }
    return best;
  }
}

/** D6 hook point: the upper bound of sup over a cell of a convex distance function. */
function cellSupUpper(
  gens: readonly IvP[],
  center: IvP,
  dist: (g: IvP) => number,
  hooks: A04Hooks,
): number {
  if (hooks.cellSupUpper !== undefined) return hooks.cellSupUpper(gens, center, dist);
  let m = 0;
  for (const g of gens) m = Math.max(m, dist(g));
  return m;
}

/** One element of the ∂R cover: a superset member, certain when it surely holds ∂R points. */
interface RElement {
  readonly box: Box;
  /** Generators of a convex superset of the element. */
  readonly gens: readonly IvP[];
  readonly certain: boolean;
  readonly size: number;
  /** Lower bound on the distance from g to the element (its hull). */
  lower(g: IvP): number;
  /** Upper bound on the distance from g to a ∂R point in the element (Infinity if uncertain). */
  upper(g: IvP): number;
  /** Upper bound on sup over hull(gens) of dist(·, ∂R ∩ element) (Infinity if uncertain). */
  supUpper(gens: readonly IvP[], center: IvP, hooks: A04Hooks): number;
  /** Lower bound on sup over (∂R ∩ element ∩ Ω⊕1) of dist(·, ∂M) (0 when nothing is sure). */
  brLower(m: MeshTarget, f: Frame): number;
  split(): RElement[] | null;
}

/** A straight portion of ∂R (fill lines), every point of which is on ∂R when certain. */
class SegElement implements RElement {
  readonly box: Box;
  readonly gens: readonly IvP[];
  readonly size: number;
  private kids: RElement[] | null = null;
  constructor(
    readonly a: QP,
    readonly b: QP,
    readonly certain: boolean,
  ) {
    const ia = qpIv(a);
    const ib = qpIv(b);
    this.gens = [ia, ib];
    this.box = boxOfIvPoints(this.gens);
    this.size = boxDiam(this.box);
  }
  lower(g: IvP): number {
    return pointSegDist(g, this.gens[0]!, this.gens[1]!).lo;
  }
  upper(g: IvP): number {
    return this.certain ? pointSegDist(g, this.gens[0]!, this.gens[1]!).hi : Infinity;
  }
  supUpper(gens: readonly IvP[], center: IvP, hooks: A04Hooks): number {
    if (!this.certain) return Infinity;
    return cellSupUpper(gens, center, (g) => this.upper(g), hooks);
  }
  brLower(m: MeshTarget, f: Frame): number {
    if (!this.certain) return 0;
    let best = 0;
    for (const p of [this.a, this.b, qmidp(this.a, this.b)])
      if (inW1(f, p)) best = Math.max(best, m.dist(qpIv(p)).lo);
    return best;
  }
  split(): RElement[] | null {
    if (this.kids === null) {
      const m = qmidp(this.a, this.b);
      this.kids = [
        new SegElement(this.a, m, this.certain),
        new SegElement(m, this.b, this.certain),
      ];
    }
    return this.kids;
  }
}

const qmidp = (a: QP, b: QP): QP => ({ x: qmid(a.x, b.x), y: qmid(a.y, b.y) });

/** A cubic sub-arc of ∂R (fills), every point of which is on ∂R when certain. */
class ArcElement implements RElement {
  readonly box: Box;
  readonly gens: readonly IvP[];
  readonly size: number;
  private kids: RElement[] | null = null;
  constructor(
    readonly p: readonly QP[],
    readonly certain: boolean,
  ) {
    this.gens = p.map(qpIv);
    this.box = boxOfIvPoints(this.gens);
    this.size = boxDiam(this.box);
  }
  lower(g: IvP): number {
    return pointBoxDistLo(g, this.box);
  }
  upper(g: IvP): number {
    if (!this.certain) return Infinity;
    return Math.min(pointPointDist(g, this.gens[0]!).hi, pointPointDist(g, this.gens[3]!).hi);
  }
  supUpper(gens: readonly IvP[], center: IvP, hooks: A04Hooks): number {
    if (!this.certain) return Infinity;
    return Math.min(
      cellSupUpper(gens, center, (g) => pointPointDist(g, this.gens[0]!).hi, hooks),
      cellSupUpper(gens, center, (g) => pointPointDist(g, this.gens[3]!).hi, hooks),
    );
  }
  brLower(m: MeshTarget, f: Frame): number {
    if (!this.certain) return 0;
    let best = 0;
    for (const p of [this.p[0]!, this.p[3]!])
      if (inW1(f, p)) best = Math.max(best, m.dist(qpIv(p)).lo);
    return best;
  }
  split(): RElement[] | null {
    if (this.kids === null) {
      const [l, r] = splitCubic(this.p, QHALF);
      this.kids = [new ArcElement(l, this.certain), new ArcElement(r, this.certain)];
    }
    return this.kids;
  }
}

/** The ∂R side of the distance engine. */
interface RegionTarget {
  readonly kind: 'fill' | 'stroke';
  /** Exact closed-region membership of a physical point. */
  contains(p: QP): boolean;
  /** Bounds on dist(p, ∂R), refined towards width `tol`. */
  dist(p: IvP, tol: number): Iv;
  /** Upper bound on sup over hull(gens) of dist(·, ∂R). */
  supUpper(gens: readonly IvP[], tol: number, hooks: A04Hooks): number;
  /** Superset elements of ∂R that may meet Ω ⊕ 1. */
  windowElements(): RElement[];
  /** 'in' or 'out' when R is constant on the box and ∂R misses it; else 'mixed'. */
  classifyBox(box: Box): 'in' | 'out' | 'mixed';
  /** Whether ∂R meets Ω: 'none' certified, 'some' certified, or 'unknown'. */
  omegaStatus(): 'none' | 'some' | 'unknown';
}

/** Nearest-element search with refinement: bounds on min over elements of dist(p, ·). */
function nearestBounds(
  initial: readonly RElement[],
  p: IvP,
  tol: number,
  work: Work,
): { lo: number; hi: number; certain: RElement[] } {
  const heap = new Heap<RElement>();
  let hi = Infinity;
  const certain: { e: RElement; u: number }[] = [];
  const consider = (e: RElement) => {
    const u = e.upper(p);
    if (u < Infinity) {
      certain.push({ e, u });
      hi = Math.min(hi, u);
    }
    heap.push(-e.lower(p), e);
  };
  for (const e of initial) consider(e);
  // Elements pop in increasing lower bound, so the first one that stops the search (or cannot
  // be refined) carries the final lower bound; refinement continues a little (16 leaves) to
  // tighten the upper bound past undecided leaves.
  let lo = Infinity;
  let leaves = 0;
  while (heap.size > 0 && leaves < 16) {
    spend(work, 1, 'distance query');
    const top = heap.pop()!;
    const l = -top.key;
    if (l >= hi - tol) {
      lo = Math.min(lo, l);
      break;
    }
    const kids = top.value.size > tol / 4 ? top.value.split() : null;
    if (kids === null) {
      lo = Math.min(lo, l);
      leaves += 1;
      continue;
    }
    for (const k of kids) consider(k);
  }
  certain.sort((u, v) => u.u - v.u);
  return { lo: Math.min(lo, hi), hi, certain: certain.slice(0, 6).map((c) => c.e) };
}

// =============================================================================================
// 12. The fill target: ∂R as exact boundary portions in a uniform grid

/** Margin around Ω ⊕ 1 within which ∂R is resolved (px). Distances saturate there. */
const INDEX_MARGIN = 64;

function indexRegion(f: Frame): Box {
  const b = f.w1Box;
  return {
    x0: b.x0 - INDEX_MARGIN,
    y0: b.y0 - INDEX_MARGIN,
    x1: b.x1 + INDEX_MARGIN,
    y1: b.y1 + INDEX_MARGIN,
  };
}

/** Distance from p to the outside of a box (0 when p is outside it). */
function depthInside(p: IvP, b: Box): number {
  return Math.max(
    0,
    Math.min(dn(p.x.lo - b.x0), dn(b.x1 - p.x.hi), dn(p.y.lo - b.y0), dn(b.y1 - p.y.hi)),
  );
}

/** Exact point of a box's center. */
const boxCenterQ = (b: Box): QP => ({
  x: qmid(qnum(b.x0), qnum(b.x1)),
  y: qmid(qnum(b.y0), qnum(b.y1)),
});

/** Points of a box to try, in order, when one lies on a curve the membership cannot decide. */
function boxSamples(b: Box): QP[] {
  const x0 = qnum(b.x0);
  const y0 = qnum(b.y0);
  const w = qsub(qnum(b.x1), x0);
  const h = qsub(qnum(b.y1), y0);
  const at = (fx: Q, fy: Q): QP => ({ x: qadd(x0, qmul(w, fx)), y: qadd(y0, qmul(h, fy)) });
  return [
    at(QHALF, QHALF),
    at(qmk(3n, 7n), qmk(5n, 11n)),
    at(qmk(5n, 13n), qmk(7n, 17n)),
    at(qmk(11n, 19n), qmk(3n, 23n)),
  ];
}

class FillTarget implements RegionTarget {
  readonly kind = 'fill' as const;
  readonly elements: RElement[] = [];
  private readonly index: GridIndex<RElement>;
  private readonly region: Box;
  constructor(
    readonly fill: FillRegion,
    readonly arrangement: Arrangement,
    private readonly frame: Frame,
    private readonly work: Work,
  ) {
    this.region = indexRegion(frame);
    const maxArc = Math.max(1, Math.max(frame.width, frame.height) / 64);
    const push = (e: RElement) => {
      if (!boxesMeet(e.box, this.region)) return;
      if (e instanceof ArcElement && e.size > maxArc) {
        for (const k of e.split()!) push(k);
        return;
      }
      this.elements.push(e);
    };
    for (const portion of arrangement.portions) {
      if (!portion.boundary) continue;
      const c = portion.curve;
      if (c.kind === 'line')
        push(
          new SegElement(
            qplerp(c.a, c.b, portion.u0),
            qplerp(c.a, c.b, portion.u1),
            portion.certain,
          ),
        );
      else push(new ArcElement(subCubic(c.p, portion.u0, portion.u1), portion.certain));
    }
    this.index = new GridIndex<RElement>(
      this.region,
      gridSize(this.elements.length * 4),
      (e) => e.box,
    );
    for (const e of this.elements) this.index.insert(e);
  }
  contains(p: QP): boolean {
    charge(W_MEMBER, 1);
    return this.fill.contains(p);
  }
  private candidates(
    p: IvP,
    enough: (found: RElement[], r: number) => boolean,
  ): {
    found: RElement[];
    r: number;
  } {
    const found: RElement[] = [];
    let r = Math.max(this.index.cellSize, 1);
    const reach = Math.max(this.region.x1 - this.region.x0, this.region.y1 - this.region.y0);
    for (;;) {
      found.length = 0;
      const q = { x0: p.x.lo - r, y0: p.y.lo - r, x1: p.x.hi + r, y1: p.y.hi + r };
      this.index.visit(q, (e) => {
        if (boxesMeet(e.box, q)) found.push(e);
      });
      if (enough(found, r) || r > 2 * reach) return { found, r };
      r *= 2;
    }
  }
  dist(p: IvP, tol: number): Iv {
    if (this.elements.length === 0) return { lo: depthInside(p, this.region), hi: Infinity };
    const { found, r } = this.candidates(p, (list, radius) =>
      list.some((e) => e.upper(p) <= radius),
    );
    const res = nearestBounds(found, p, tol, this.work);
    // Unvisited elements lie at least r away, and ∂R clipped from the index lies beyond the
    // region: both bound the lower end (review S1 of PR #212).
    return { lo: Math.min(res.lo, r, depthInside(p, this.region)), hi: res.hi };
  }
  supUpper(gens: readonly IvP[], tol: number, hooks: A04Hooks): number {
    if (this.elements.length === 0) return Infinity;
    const c = centerOf(boxOfIvPoints(gens));
    const { found } = this.candidates(c, (list, radius) => list.some((e) => e.upper(c) <= radius));
    const res = nearestBounds(found, c, tol, this.work);
    let best = Infinity;
    for (const e of res.certain) best = Math.min(best, e.supUpper(gens, c, hooks));
    return best;
  }
  windowElements(): RElement[] {
    return this.elements.filter((e) => boxMeetsW1(this.frame, e.box));
  }
  private mayMeet(e: RElement, box: Box, depth: number): boolean {
    if (!boxesMeet(e.box, box)) return false;
    if (e instanceof SegElement) return segmentMayMeetBox(e.gens[0]!, e.gens[1]!, box);
    if (e.size <= boxDiam(box) / 8 || depth > 40) return true;
    return e.split()!.some((k) => this.mayMeet(k, box, depth + 1));
  }
  /** True when no superset element of ∂R can meet the box. */
  boundaryFree(box: Box): boolean {
    let hit = false;
    this.index.visit(box, (e) => {
      if (!hit && this.mayMeet(e, box, 0)) hit = true;
    });
    return !hit;
  }
  /** Superset elements that may meet the box. */
  elementsMeeting(box: Box): RElement[] {
    const out: RElement[] = [];
    this.index.visit(box, (e) => {
      if (this.mayMeet(e, box, 0)) out.push(e);
    });
    return out;
  }
  classifyBox(box: Box): 'in' | 'out' | 'mixed' {
    if (!this.boundaryFree(box)) return 'mixed';
    for (const p of boxSamples(box)) {
      try {
        return this.contains(p) ? 'in' : 'out';
      } catch (error) {
        if (!(error instanceof A04UnsupportedError)) throw error;
      }
    }
    return 'mixed';
  }
  omegaStatus(): 'none' | 'some' | 'unknown' {
    const omega = this.frame.omega;
    let some = false;
    let maybe = false;
    this.index.visit(omega, (e) => {
      if (some || !this.mayMeet(e, omega, 0)) return;
      maybe = true;
      if (!e.certain) return;
      const ends =
        e instanceof SegElement
          ? [e.a, e.b, qmidp(e.a, e.b)]
          : e instanceof ArcElement
            ? [e.p[0]!, e.p[3]!]
            : [];
      if (ends.some((q) => inOmega(this.frame, q))) some = true;
    });
    return some ? 'some' : maybe ? 'unknown' : 'none';
  }
}

// =============================================================================================
// 13. The stroke ideal region: pieces of stroke contract section 2.2 (obligation (b))

/** A convex polygon in node-local units (hull of interval generators) with seam-side tags. */
type LPoly = Readonly<{
  gens: readonly IvP[];
  tags: ReadonlyMap<number, number>;
  box: Box;
  /** The exact vertices, when known (cells and their exact seam splits). */
  exact: readonly QP[] | null;
  /**
   * Sub-arc frontiers of an enclosing polygon, per sweep piece (E3-U2d): a sweep's traversals
   * start from these nodes instead of its root.
   */
  arcs?: ArcHint | undefined;
  /** Filled by each sweep piece that classifies this polygon: its frontier for the polygon. */
  found?: Map<StrokePiece, readonly ArcNode[]>;
  /** Classify without the finer second collection (E3-U2e: cover cells above the freeze size). */
  coarseOnly?: boolean;
  /**
   * Refine the OUT test's sub-arcs 16 times finer than the polygon (E3-U2e: freeze cells, where
   * an outside cell near a foot is otherwise left to the freeze check's descent).
   */
  deepOut?: boolean;
}>;

/**
 * Per sweep piece, a frontier of sub-arc nodes for a polygon P (E3-U2d): disjoint nodes that
 * cover every t of [0, 1] except those whose sub-arc is certified farther than r from P. Since
 * the certificate is a statement about the true sets, it holds for every polygon inside P: such
 * a t has no foot within r of it. So a traversal for a polygon inside P may start from the
 * frontier instead of the root. Every test on the way down is the same sound test.
 */
type ArcHint = ReadonlyMap<StrokePiece, readonly ArcNode[]>;
/**
 * The sub-arcs of a collection whose sweep equation keeps one sign over the polygon it was
 * collected for (E3-U2e). They have no foot in that polygon, so none in any polygon inside it.
 */
const NO_FOOT = new WeakMap<readonly ArcNode[], ReadonlyMap<ArcNode, number>>();

/** An end-normal line through B with normal vector T (canonically oriented). */
type Seam = {
  readonly id: number;
  readonly b: QP;
  readonly t: QP;
  readonly ib: IvP;
  readonly it: IvP;
  reach: number;
};
type SeamRef = Readonly<{ seam: Seam; side: number }>;

const tagged = (poly: LPoly, ref: SeamRef | null): boolean =>
  ref !== null && poly.tags.get(ref.seam.id) === ref.side;

/** Every gen satisfies `ok`, or every gen certainly violates via `bad`. */
type Verdict = { inOk: boolean; outAll: boolean[] };

interface StrokePiece {
  readonly role: string;
  /** Convex pieces contain a polygon exactly when they contain its exact vertices. */
  readonly convex: boolean;
  /** Enclosures of a convex polygonal piece's corners, for separation by the polygon's edges. */
  readonly corners?: readonly IvP[];
  readonly box: Box;
  contains(y: QP): boolean;
  /** 1 when the polygon lies in the piece, −1 when it misses it, 0 when undecided. */
  classify(poly: LPoly): number;
  /** True only when the polygon misses the piece: the OUT part of `classify`, when cheaper. */
  excludes?(poly: LPoly): boolean;
}

const ivSignOk = (v: Iv, sign: number): boolean => (sign > 0 ? v.lo >= 0 : v.hi <= 0);
const ivSignBad = (v: Iv, sign: number): boolean => (sign > 0 ? v.hi < 0 : v.lo > 0);

function verdict(v: Verdict): number {
  if (v.inOk) return 1;
  return v.outAll.some((x) => x) ? -1 : 0;
}

class LineSweep implements StrokePiece {
  readonly role = 'line-sweep';
  readonly convex = true;
  readonly corners: readonly IvP[];
  readonly box: Box;
  private readonly d: QP;
  private readonly dd: Q;
  private readonly rr: Q;
  private readonly ia: IvP;
  private readonly id: IvP;
  private readonly idd: Iv;
  private readonly irrdd: Iv;
  private readonly ird: Iv;
  constructor(
    private readonly a: QP,
    b: QP,
    r: Q,
    private readonly start: SeamRef | null,
    private readonly end: SeamRef | null,
  ) {
    this.d = qpsub(b, a);
    this.dd = qpdot(this.d, this.d);
    this.rr = qsq(r);
    this.ia = qpIv(a);
    this.id = qpIv(this.d);
    this.idd = qIv(this.dd);
    this.irrdd = qIv(qmul(this.rr, this.dd));
    this.ird = isqrt(this.irrdd);
    const nr = idiv(qIv(r), isqrt(this.idd));
    const pn: IvP = { x: imul(ineg(this.id.y), nr), y: imul(this.id.x, nr) };
    const ib = qpIv(b);
    this.corners = [ivpSub(this.ia, pn), ivpSub(ib, pn), ivpAdd(ib, pn), ivpAdd(this.ia, pn)];
    const ri = qIv(r).hi;
    const box = boxOfIvPoints([this.ia, qpIv(b)]);
    this.box = {
      x0: dn(box.x0 - ri),
      y0: dn(box.y0 - ri),
      x1: up(box.x1 + ri),
      y1: up(box.y1 + ri),
    };
  }
  contains(y: QP): boolean {
    const w = qpsub(y, this.a);
    const p = qpdot(w, this.d);
    if (qsgn(p) < 0 || qcmp(p, this.dd) > 0) return false;
    return qcmp(qsq(qpcross(this.d, w)), qmul(this.rr, this.dd)) <= 0;
  }
  classify(poly: LPoly): number {
    const st = tagged(poly, this.start);
    const en = tagged(poly, this.end);
    const v: Verdict = { inOk: true, outAll: [true, true, true, true] };
    for (const g of poly.gens) {
      const w = ivpSub(g, this.ia);
      const p = ivpDot(w, this.id);
      const c = ivpCross(this.id, w);
      if (!(st || p.lo >= 0) || !(en || p.hi <= this.idd.lo) || isqr(c).hi > this.irrdd.lo)
        v.inOk = false;
      if (!(p.hi < 0)) v.outAll[0] = false;
      if (!(p.lo > this.idd.hi)) v.outAll[1] = false;
      if (!(c.lo > this.ird.hi)) v.outAll[2] = false;
      if (!(c.hi < -this.ird.hi)) v.outAll[3] = false;
    }
    return verdict(v);
  }
}

/** A disk of radius r whose center is rational, or in Q(√s) (collinear turning points). */
class DiskPiece implements StrokePiece {
  readonly convex = true;
  get centerApprox(): [number, number] {
    return [(this.ic.x.lo + this.ic.x.hi) / 2, (this.ic.y.lo + this.ic.y.hi) / 2];
  }
  readonly box: Box;
  private readonly ic: IvP;
  private readonly irr: Iv;
  private readonly ir: Iv;
  constructor(
    readonly role: string,
    private readonly cx: Readonly<{ a: Q; b: Q }>,
    private readonly cy: Readonly<{ a: Q; b: Q }>,
    private readonly s: Q,
    private readonly r: Q,
  ) {
    const root = isqrt(qIv(s));
    this.ic = {
      x: iadd(qIv(cx.a), imul(qIv(cx.b), root)),
      y: iadd(qIv(cy.a), imul(qIv(cy.b), root)),
    };
    this.irr = qIv(qsq(r));
    this.ir = qIv(r);
    this.box = {
      x0: dn(this.ic.x.lo - this.ir.hi),
      y0: dn(this.ic.y.lo - this.ir.hi),
      x1: up(this.ic.x.hi + this.ir.hi),
      y1: up(this.ic.y.hi + this.ir.hi),
    };
  }
  contains(y: QP): boolean {
    const u = qsub(y.x, this.cx.a);
    const v = qsub(y.y, this.cy.a);
    const A = qsub(
      qadd(qadd(qsq(u), qsq(v)), qmul(qadd(qsq(this.cx.b), qsq(this.cy.b)), this.s)),
      qsq(this.r),
    );
    const B = qmul(qi(-2), qadd(qmul(u, this.cx.b), qmul(v, this.cy.b)));
    return signRad(A, B, this.s) <= 0;
  }
  classify(poly: LPoly): number {
    if (poly.gens.every((g) => ivpNorm2(ivpSub(g, this.ic)).hi <= this.irr.lo)) return 1;
    if (boxBoxDistLo(poly.box, boxOfIvPoints([this.ic])) > this.ir.hi) return -1;
    return 0;
  }
}

/** A bevel or miter join at B with outer normal directions u, v (stroke contract ST-S5, ST-S6). */
class AngleJoin implements StrokePiece {
  readonly convex = true;
  readonly corners: readonly IvP[];
  readonly box: Box;
  readonly role: string;
  private readonly crossUV: number;
  private readonly iu: IvP;
  private readonly iv: IvP;
  private readonly ib: IvP;
  private readonly ilu: Iv;
  private readonly ilv: Iv;
  private readonly irlu: Iv;
  private readonly irlv: Iv;
  private readonly ixr: Iv;
  constructor(
    private readonly miter: boolean,
    private readonly b: QP,
    private readonly u: QP,
    private readonly v: QP,
    private readonly r: Q,
    private readonly s1: SeamRef,
    private readonly s2: SeamRef,
  ) {
    this.role = miter ? 'miter-join' : 'bevel-join';
    this.crossUV = qsgn(qpcross(u, v));
    if (this.crossUV === 0) oracleError('angle join without a turn');
    this.iu = qpIv(u);
    this.iv = qpIv(v);
    this.ib = qpIv(b);
    const ri = qIv(r);
    this.ilu = isqrt(qIv(qpdot(u, u)));
    this.ilv = isqrt(qIv(qpdot(v, v)));
    this.irlu = imul(ri, this.ilu);
    this.irlv = imul(ri, this.ilv);
    this.ixr = imul(ri, qIv(qpcross(v, u)));
    const ru = ivpScale(this.iu, idiv(ri, this.ilu));
    const rv = ivpScale(this.iv, idiv(ri, this.ilv));
    const pu = ivpAdd(this.ib, ru);
    const pv = ivpAdd(this.ib, rv);
    if (miter) {
      const cos = idiv(qIv(qpdot(u, v)), imul(this.ilu, this.ilv));
      const tip = ivpAdd(this.ib, ivpScale(ivpAdd(ru, rv), idiv(ivc(1), iadd(ivc(1), cos))));
      this.corners = [this.ib, pu, tip, pv];
    } else this.corners = [this.ib, pu, pv];
    // Reach: the tip distance r·|û + v̂| / (1 + û·v̂) for a miter, r for a bevel.
    let reach = ri.hi;
    if (miter) {
      const ux = qapprox(u.x) / this.ilu.lo;
      const uy = qapprox(u.y) / this.ilu.lo;
      const vx = qapprox(v.x) / this.ilv.lo;
      const vy = qapprox(v.y) / this.ilv.lo;
      const denom = 1 + ux * vx + uy * vy;
      reach =
        denom > 1e-300 ? Math.max(reach, (ri.hi * Math.hypot(ux + vx, uy + vy)) / denom) : Infinity;
      reach = reach * 1.01 + ri.hi;
    }
    this.box = {
      x0: dn(this.ib.x.lo - reach),
      y0: dn(this.ib.y.lo - reach),
      x1: up(this.ib.x.hi + reach),
      y1: up(this.ib.y.hi + reach),
    };
  }
  contains(y: QP): boolean {
    const Y = qpsub(y, this.b);
    const cu = qsgn(qpcross(this.u, Y));
    const cv = qsgn(qpcross(this.v, Y));
    if (cu * this.crossUV < 0 || cv * -this.crossUV < 0) return false;
    const a = qpdot(this.u, this.u);
    const bb = qpdot(this.v, this.v);
    if (this.miter)
      return (
        signRad(qneg(qpdot(Y, this.u)), this.r, a) >= 0 &&
        signRad(qneg(qpdot(Y, this.v)), this.r, bb) >= 0
      );
    const x0 = qneg(qmul(this.r, qpcross(this.v, this.u)));
    const f = signRad2(x0, qpcross(this.v, Y), qneg(qpcross(this.u, Y)), Q0, a, bb);
    return f * this.crossUV >= 0;
  }
  classify(poly: LPoly): number {
    const t1 = tagged(poly, this.s1);
    const t2 = tagged(poly, this.s2);
    const v: Verdict = { inOk: true, outAll: [true, true, true, true] };
    for (const g of poly.gens) {
      const Y = ivpSub(g, this.ib);
      const cu = ivpCross(this.iu, Y);
      const cv = ivpCross(this.iv, Y);
      if (!(t1 || ivSignOk(cu, this.crossUV))) v.inOk = false;
      if (!(t2 || ivSignOk(cv, -this.crossUV))) v.inOk = false;
      if (!ivSignBad(cu, this.crossUV)) v.outAll[0] = false;
      if (!ivSignBad(cv, -this.crossUV)) v.outAll[1] = false;
      if (this.miter) {
        const pu = ivpDot(Y, this.iu);
        const pv = ivpDot(Y, this.iv);
        if (pu.hi > this.irlu.lo || pv.hi > this.irlv.lo) v.inOk = false;
        if (!(pu.lo > this.irlu.hi)) v.outAll[2] = false;
        if (!(pv.lo > this.irlv.hi)) v.outAll[3] = false;
      } else {
        const f = isub(isub(imul(this.ilu, cv), imul(this.ilv, cu)), this.ixr);
        if (!ivSignOk(f, this.crossUV)) v.inOk = false;
        if (!ivSignBad(f, this.crossUV)) v.outAll[2] = false;
        v.outAll[3] = false;
      }
    }
    return verdict(v);
  }
}

/** A square cap beyond B along the outward tangent f (ST-S7). */
class SquareCap implements StrokePiece {
  readonly role = 'square-cap';
  readonly convex = true;
  readonly corners: readonly IvP[];
  readonly box: Box;
  private readonly ib: IvP;
  private readonly ifv: IvP;
  private readonly irf: Iv;
  private readonly irrff: Iv;
  constructor(
    private readonly b: QP,
    private readonly f: QP,
    private readonly r: Q,
    private readonly seam: SeamRef,
  ) {
    this.ib = qpIv(b);
    this.ifv = qpIv(f);
    const ff = qIv(qpdot(f, f));
    this.irf = imul(qIv(r), isqrt(ff));
    this.irrff = imul(qIv(qsq(r)), ff);
    const nf = idiv(qIv(r), isqrt(ff));
    const pn: IvP = { x: imul(ineg(this.ifv.y), nf), y: imul(this.ifv.x, nf) };
    const ext = ivpScale(this.ifv, nf);
    this.corners = [
      ivpSub(this.ib, pn),
      ivpAdd(this.ib, pn),
      ivpAdd(ivpAdd(this.ib, pn), ext),
      ivpAdd(ivpSub(this.ib, pn), ext),
    ];
    const reach = up(qIv(r).hi * 1.5);
    this.box = {
      x0: dn(this.ib.x.lo - reach),
      y0: dn(this.ib.y.lo - reach),
      x1: up(this.ib.x.hi + reach),
      y1: up(this.ib.y.hi + reach),
    };
  }
  contains(y: QP): boolean {
    const Y = qpsub(y, this.b);
    const p = qpdot(Y, this.f);
    if (qsgn(p) < 0) return false;
    const ff = qpdot(this.f, this.f);
    if (signRad(qneg(p), this.r, ff) < 0) return false;
    return qcmp(qsq(qpcross(this.f, Y)), qmul(qsq(this.r), ff)) <= 0;
  }
  classify(poly: LPoly): number {
    const t = tagged(poly, this.seam);
    const v: Verdict = { inOk: true, outAll: [true, true, true, true] };
    for (const g of poly.gens) {
      const Y = ivpSub(g, this.ib);
      const p = ivpDot(Y, this.ifv);
      const c = ivpCross(this.ifv, Y);
      if (!(t || p.lo >= 0) || p.hi > this.irf.lo || isqr(c).hi > this.irrff.lo) v.inOk = false;
      if (!(p.hi < 0)) v.outAll[0] = false;
      if (!(p.lo > this.irf.hi)) v.outAll[1] = false;
      if (!(c.lo > this.irf.hi)) v.outAll[2] = false;
      if (!(c.hi < -this.irf.hi)) v.outAll[3] = false;
    }
    return verdict(v);
  }
}

/** The local-axis square of side w at a point (ST-S10). */
class PointSquare implements StrokePiece {
  readonly role = 'point-square';
  readonly convex = true;
  readonly corners: readonly IvP[];
  readonly box: Box;
  private readonly ic: IvP;
  private readonly ir: Iv;
  constructor(
    private readonly c: QP,
    private readonly r: Q,
  ) {
    this.ic = qpIv(c);
    this.ir = qIv(r);
    const rr = this.ir;
    this.corners = [
      { x: isub(this.ic.x, rr), y: isub(this.ic.y, rr) },
      { x: iadd(this.ic.x, rr), y: isub(this.ic.y, rr) },
      { x: iadd(this.ic.x, rr), y: iadd(this.ic.y, rr) },
      { x: isub(this.ic.x, rr), y: iadd(this.ic.y, rr) },
    ];
    this.box = {
      x0: dn(this.ic.x.lo - this.ir.hi),
      y0: dn(this.ic.y.lo - this.ir.hi),
      x1: up(this.ic.x.hi + this.ir.hi),
      y1: up(this.ic.y.hi + this.ir.hi),
    };
  }
  contains(y: QP): boolean {
    return (
      qcmp(qabs(qsub(y.x, this.c.x)), this.r) <= 0 && qcmp(qabs(qsub(y.y, this.c.y)), this.r) <= 0
    );
  }
  classify(poly: LPoly): number {
    const v: Verdict = { inOk: true, outAll: [true, true, true, true] };
    for (const g of poly.gens) {
      const dx = isub(g.x, this.ic.x);
      const dy = isub(g.y, this.ic.y);
      if (dx.hi > this.ir.lo || dx.lo < -this.ir.lo || dy.hi > this.ir.lo || dy.lo < -this.ir.lo)
        v.inOk = false;
      if (!(dx.lo > this.ir.hi)) v.outAll[0] = false;
      if (!(dx.hi < -this.ir.hi)) v.outAll[1] = false;
      if (!(dy.lo > this.ir.hi)) v.outAll[2] = false;
      if (!(dy.hi < -this.ir.hi)) v.outAll[3] = false;
    }
    return verdict(v);
  }
}

/** Interval Horner evaluation of a polynomial with interval coefficients at an interval t. */
function ipoly(c: readonly Iv[], t: Iv): Iv {
  let acc = ivc(0);
  for (let i = c.length - 1; i >= 0; i -= 1) acc = iadd(imul(acc, t), c[i]!);
  return acc;
}

type ArcNode = {
  readonly t0: number;
  readonly t1: number;
  readonly c: readonly IvP[];
  readonly box: Box;
  readonly size: number;
  readonly depth: number;
  kids: [ArcNode, ArcNode] | null;
  range: { dx: Iv; dy: Iv; e: Iv } | null;
  /**
   * Bernstein coefficients of D_x, D_y and e = C·D on [t0, t1] (E3-U2c), computed on first use
   * from the parent's by one de Casteljau halving (`bernOf`).
   */
  bern: Bern | null;
  readonly parent: ArcNode | null;
  readonly half: 0 | 1;
};

function bernOf(n: ArcNode): Bern | null {
  if (n.bern === null && n.parent !== null) {
    const pb = bernOf(n.parent);
    if (pb === null) return null;
    n.bern = bernKids(pb)[n.half];
  }
  return n.bern;
}

/** Bernstein coefficients (one common degree) of the sweep equation's parts on a sub-arc. */
type Bern = Readonly<{ x: readonly Iv[]; y: readonly Iv[]; e: readonly Iv[] }>;

/** De Casteljau halving of interval Bernstein coefficients, by (u + v)·½ as in `arcKids`. */
function bernHalves(b: readonly Iv[]): [Iv[], Iv[]] {
  const n = b.length;
  let row = [...b];
  const left: Iv[] = [row[0]!];
  const right: Iv[] = [row[n - 1]!];
  for (let k = 1; k < n; k += 1) {
    const next: Iv[] = [];
    for (let i = 0; i + 1 < row.length; i += 1) next.push(imid(row[i]!, row[i + 1]!));
    row = next;
    left.push(row[0]!);
    right.unshift(row[row.length - 1]!);
  }
  return [left, right];
}

function bernKids(b: Bern): [Bern, Bern] {
  const [x0, x1] = bernHalves(b.x);
  const [y0, y1] = bernHalves(b.y);
  const [e0, e1] = bernHalves(b.e);
  return [
    { x: x0, y: y0, e: e0 },
    { x: x1, y: y1, e: e1 },
  ];
}

/** Exact power-basis coefficients to Bernstein coefficients of degree n on [0, 1]. */
function powerToBernstein(a: readonly Q[], n: number): Q[] {
  const binom = (k: number, j: number): bigint => {
    let r = 1n;
    for (let i = 0; i < j; i += 1) r = (r * BigInt(k - i)) / BigInt(i + 1);
    return r;
  };
  const out: Q[] = [];
  for (let i = 0; i <= n; i += 1) {
    let v = Q0;
    for (let j = 0; j <= Math.min(i, a.length - 1); j += 1)
      v = qadd(v, qmul(a[j]!, qmk(binom(i, j), binom(n, j))));
    out.push(v);
  }
  return out;
}

const ARC_MAX_DEPTH = 48;

function arcNode(
  t0: number,
  t1: number,
  c: readonly IvP[],
  depth: number,
  bern: Bern | null,
  parent: ArcNode | null,
  half: 0 | 1,
): ArcNode {
  const box = boxOfIvPoints(c);
  return {
    t0,
    t1,
    c,
    box,
    size: boxDiam(box),
    depth,
    kids: null,
    range: null,
    bern,
    parent,
    half,
  };
}

/** Seam splits per top-level stroke classification (E3-U2c, contract section 14.8). */
const SEAM_SPLIT_BUDGET = 24;
/** The sub-arc floors of a point's classification, as exponents of r·2^-e (E3-U2e). */
const POINT_FLOOR_STAGES = [8, 16, 24] as const;
/** Pair splits (E3-U2e): at most this many open convex pieces, inward normals not within 8°. */
const PAIR_SPLIT_PIECES = 4;
const PAIR_SPLIT_COS = 0.99;

/**
 * The edge of a convex piece's corner polygon that crosses the polygon `gens` nearest to
 * (cx, cy): the point of its line nearest to (cx, cy) and its unit normal into the piece, or
 * null. Midpoint floats: the result only steers a split (E3-U2e).
 */
function crossingEdge(
  corners: readonly IvP[],
  gens: readonly IvP[],
  cx: number,
  cy: number,
): { px: number; py: number; nx: number; ny: number } | null {
  const m = (v: Iv) => (v.lo + v.hi) / 2;
  const n = corners.length;
  const ox = corners.reduce((a, c) => a + m(c.x), 0) / n;
  const oy = corners.reduce((a, c) => a + m(c.y), 0) / n;
  let best: { px: number; py: number; nx: number; ny: number } | null = null;
  let bestD = Infinity;
  for (let k = 0; k < n; k += 1) {
    const ax = m(corners[k]!.x);
    const ay = m(corners[k]!.y);
    const ex = m(corners[(k + 1) % n]!.x) - ax;
    const ey = m(corners[(k + 1) % n]!.y) - ay;
    const len = Math.hypot(ex, ey);
    if (!(len > 0)) continue;
    let nx = -ey / len;
    let ny = ex / len;
    if (nx * (ox - ax) + ny * (oy - ay) < 0) {
      nx = -nx;
      ny = -ny;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const g of gens) {
      const v = nx * (m(g.x) - ax) + ny * (m(g.y) - ay);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (!(lo < 0 && hi > 0)) continue;
    const d = nx * (cx - ax) + ny * (cy - ay);
    if (Math.abs(d) < bestD) {
      bestD = Math.abs(d);
      best = { px: cx - d * nx, py: cy - d * ny, nx, ny };
    }
  }
  return best;
}

/** Sub-arc nodes per normal-segment witness search (E3-U2c). */
const NORMAL_CANDIDATE_BUDGET = 512;

/**
 * Witness samples along the long local axis of an anisotropic cell (E3-U2d): at most this many,
 * and only when one side of the cell's local image is at least ANISOTROPIC_RATIO times the other.
 */
const ANISOTROPIC_SAMPLES = 64;
const ANISOTROPIC_RATIO = 8;
/** Halving levels of the OUT-by-halves test of an anisotropic cell (E3-U2d). */
const ANISOTROPIC_MAX_LEVELS = 12;

/** Sub-arc trees are cached to this depth only; deeper sub-arcs are rebuilt on demand. */
const ARC_CACHE_DEPTH = 14;

function arcKids(n: ArcNode, cache: { left: number }): [ArcNode, ArcNode] {
  if (n.kids === null) {
    // Midpoints as (u + v)·½, never u + (v − u)·½: the latter repeats u and would double the
    // interval widths at every level of the subdivision.
    const [p0, p1, p2, p3] = n.c as [IvP, IvP, IvP, IvP];
    const a = ivpMid(p0, p1);
    const b = ivpMid(p1, p2);
    const c = ivpMid(p2, p3);
    const d = ivpMid(a, b);
    const e = ivpMid(b, c);
    const f = ivpMid(d, e);
    const tm = (n.t0 + n.t1) / 2;
    const kids: [ArcNode, ArcNode] = [
      arcNode(n.t0, tm, [p0, a, d, f], n.depth + 1, null, n, 0),
      arcNode(tm, n.t1, [f, e, c, p3], n.depth + 1, null, n, 1),
    ];
    if (n.depth >= ARC_CACHE_DEPTH && cache.left <= 0) return kids;
    if (n.depth >= ARC_CACHE_DEPTH) cache.left -= 2;
    n.kids = kids;
  }
  return n.kids;
}

/**
 * The sweep of a cubic over its regular parameters (section 2.2, item 1): y is in the sweep
 * when f(y, t) = (y − C(t))·D(t) has a root t in [0, 1] with |y − C(t)| ≤ r. D is C′ divided by
 * the common factor of its components (t − t*) at a stationary parameter, so a stationary point
 * contributes its limit normal and never the disk of every y (obligation (b)); a cusp's disk is a
 * separate piece. A collinear cubic has the constant D of its line.
 */
class CubicSweep implements StrokePiece {
  readonly role = 'cubic-sweep';
  /** A collinear cubic sweeps a rectangle (its D is constant), which is convex. */
  readonly convex: boolean;
  readonly box: Box;
  private readonly pw: { x: Q[]; y: Q[] };
  private readonly dx: Q[];
  private readonly dy: Q[];
  private readonly e: Q[];
  private readonly rr: Q;
  private readonly idx: Iv[];
  private readonly idy: Iv[];
  private readonly ie: Iv[];
  private readonly irr: Iv;
  private readonly ir: Iv;
  private readonly root: ArcNode;
  private readonly at = new Map<number, { dx: Iv; dy: Iv; e: Iv }>();
  /** Sub-arcs below ARC_CACHE_DEPTH that may still be cached (a memory bound). */
  private readonly cache = { left: 1 << 15 };
  constructor(
    readonly controls: readonly QP[],
    direction: { x: Q[]; y: Q[] },
    readonly r: Q,
    private readonly sigmaStart: number,
    private readonly sigmaEnd: number,
    private readonly start: SeamRef | null,
    private readonly end: SeamRef | null,
    private readonly hooks: A04Hooks,
  ) {
    this.pw = cubicPower(controls);
    this.dx = direction.x;
    this.dy = direction.y;
    this.convex = this.dx.length <= 1 && this.dy.length <= 1;
    this.e = padd(pmul(this.pw.x, this.dx), pmul(this.pw.y, this.dy));
    this.rr = qsq(r);
    this.idx = this.dx.map(qIv);
    this.idy = this.dy.map(qIv);
    this.ie = this.e.map(qIv);
    this.irr = qIv(this.rr);
    this.ir = qIv(r);
    const degree = Math.max(this.dx.length, this.dy.length, this.e.length, 1) - 1;
    const bern = (a: readonly Q[]) => powerToBernstein(a, degree).map(qIv);
    this.root = arcNode(
      0,
      1,
      controls.map(qpIv),
      0,
      { x: bern(this.dx), y: bern(this.dy), e: bern(this.e) },
      null,
      0,
    );
    const b = this.root.box;
    this.box = {
      x0: dn(b.x0 - this.ir.hi),
      y0: dn(b.y0 - this.ir.hi),
      x1: up(b.x1 + this.ir.hi),
      y1: up(b.y1 + this.ir.hi),
    };
  }
  private exactContains(y: QP): boolean {
    const f = psub(padd(pscale(this.dx, y.x), pscale(this.dy, y.y)), this.e);
    if (f.length === 0) oracleError('degenerate sweep equation');
    const ux = psub([y.x], this.pw.x);
    const uy = psub([y.y], this.pw.y);
    const g = psub(padd(pmul(ux, ux), pmul(uy, uy)), [this.rr]);
    const { s, roots } = isolateRoots(f, Q0, Q1);
    return roots.some((root) => signAtRoot(g, s, root) <= 0);
  }
  contains(y: QP): boolean {
    if (this.hooks.sweepContains !== undefined)
      return this.hooks.sweepContains(
        {
          controls: this.controls.map((p) => [qapprox(p.x), qapprox(p.y)] as const),
          radius: qapprox(this.r),
          point: [qapprox(y.x), qapprox(y.y)],
        },
        () => this.exactContains(y),
      );
    return this.exactContains(y);
  }
  private coefAt(t: number): { dx: Iv; dy: Iv; e: Iv } {
    let v = this.at.get(t);
    if (v === undefined) {
      const ti = ivc(t);
      v = { dx: ipoly(this.idx, ti), dy: ipoly(this.idy, ti), e: ipoly(this.ie, ti) };
      if (this.at.size < 1 << 16) this.at.set(t, v);
    }
    return v;
  }
  private sigmaAt(poly: LPoly, t: number): number {
    if (t === 0 && tagged(poly, this.start)) return this.sigmaStart;
    if (t === 1 && tagged(poly, this.end)) return this.sigmaEnd;
    const k = this.coefAt(t);
    let pos = true;
    let neg = true;
    for (const g of poly.gens) {
      const f = isub(iadd(imul(g.x, k.dx), imul(g.y, k.dy)), k.e);
      if (!(f.lo > 0)) pos = false;
      if (!(f.hi < 0)) neg = false;
    }
    return pos ? 1 : neg ? -1 : 0;
  }
  private excludesZero(node: ArcNode, poly: LPoly): boolean {
    return this.footSign(node, poly) !== 0;
  }
  /** The one sign of the sweep equation over the sub-arc and the polygon, or 0 if not shown. */
  private footSign(node: ArcNode, poly: LPoly): number {
    if (node.range === null) {
      const t = { lo: node.t0, hi: node.t1 };
      node.range = { dx: ipoly(this.idx, t), dy: ipoly(this.idy, t), e: ipoly(this.ie, t) };
    }
    const k = node.range;
    let pos = true;
    let neg = true;
    for (const g of poly.gens) {
      const f = isub(iadd(imul(g.x, k.dx), imul(g.y, k.dy)), k.e);
      if (!(f.lo > 0)) pos = false;
      if (!(f.hi < 0)) neg = false;
    }
    if (pos || neg) return pos ? 1 : -1;
    // The Bernstein hull (E3-U2c): f(y, t) = Σ bᵢ(y)·Bᵢ(t) with bᵢ affine in y, so f keeps one
    // sign over the sub-arc and the polygon when every bᵢ does at every vertex enclosure.
    const b = bernOf(node);
    if (b === null) return 0;
    pos = true;
    neg = true;
    for (let i = 0; i < b.e.length && (pos || neg); i += 1)
      for (const g of poly.gens) {
        const f = isub(iadd(imul(g.x, b.x[i]!), imul(g.y, b.y[i]!)), b.e[i]!);
        if (!(f.lo > 0)) pos = false;
        if (!(f.hi < 0)) neg = false;
      }
    return pos ? 1 : neg ? -1 : 0;
  }
  private outside(
    node: ArcNode,
    poly: LPoly,
    size: number,
    budget: { n: number },
    none?: ReadonlyMap<ArcNode, number>,
  ): boolean {
    // A sub-arc without a foot in the polygon is outside it (E3-U2e: known from the collection).
    if (none?.has(node) === true) return true;
    charge(W_ARC, 1);
    if (hullBoxDistLo(poly.gens, poly.box, node.box) > this.ir.hi) return true;
    if (this.excludesZero(node, poly)) return true;
    budget.n -= 1;
    if (node.depth >= ARC_MAX_DEPTH || node.size <= size / 4 || budget.n <= 0) return false;
    const [a, b] = arcKids(node, this.cache);
    return this.outside(a, poly, size, budget) && this.outside(b, poly, size, budget);
  }
  private starts(poly: LPoly): readonly ArcNode[] {
    return poly.arcs?.get(this) ?? [this.root];
  }
  private collectNodes(poly: LPoly, target: number, from = this.starts(poly)): ArcNode[] {
    const nodes: ArcNode[] = [];
    // Sub-arcs without a foot in an enclosing polygon have none in this one (E3-U2e): they are
    // kept whole without the sign test, which is the same outcome at no cost.
    const known = NO_FOOT.get(from);
    const none = new Map<ArcNode, number>();
    let budget = 4096;
    const collect = (n: ArcNode) => {
      const sign = known?.get(n);
      if (sign !== undefined) {
        if (boxBoxDistLo(poly.box, n.box) > this.ir.hi) return;
        nodes.push(n);
        none.set(n, sign);
        return;
      }
      charge(W_ARC, 1);
      if (boxBoxDistLo(poly.box, n.box) > this.ir.hi) return;
      budget -= 1;
      if (n.size <= target || n.depth >= ARC_MAX_DEPTH || budget <= 0) {
        nodes.push(n);
        return;
      }
      const foot = this.footSign(n, poly);
      if (foot !== 0) {
        nodes.push(n);
        none.set(n, foot);
        return;
      }
      const [a, b] = arcKids(n, this.cache);
      collect(a);
      collect(b);
    };
    for (const n of from) collect(n);
    NO_FOOT.set(nodes, none);
    return nodes;
  }
  private readonly exactAtZ = new Map<number, ZLine>();
  /**
   * IN by a union of brackets, for a polygon with exact vertices. A point y is in the sweep when
   * f(y, ·) changes sign weakly across one sub-arc whose distance bound holds over the polygon.
   * Since f is affine in y, the points that one sub-arc does not cover form two convex pieces,
   * cut exactly from the polygon. The polygon is IN when no piece of positive area remains. This
   * certifies cells that need different feet for different points (inside a fold).
   */
  private insideUnion(poly: LPoly, nodes: readonly ArcNode[]): boolean {
    if (poly.exact === null || poly.exact.length < 3) return false;
    // Integer homogeneous geometry (E3-U2c): every line is an integer triple and every vertex the
    // cross product of the two lines it lies on, so no rational is normalized and vertex sizes do
    // not grow with the number of clips. A clip of a convex polygon of positive area by
    // {g ≥ 0} has positive area exactly when g > 0 at some vertex; otherwise the polygon meets
    // {g ≥ 0} only on the line g = 0. That replaces the area test.
    const line = (k: { dx: Q; dy: Q; e: Q }): ZLine => zLine(k.dx, k.dy, qneg(k.e));
    const coef = (t: number): ZLine => {
      let v = this.exactAtZ.get(t);
      if (v === undefined) {
        const tq = qnum(t);
        v = line({ dx: peval(this.dx, tq), dy: peval(this.dy, tq), e: peval(this.e, tq) });
        if (this.exactAtZ.size < 1 << 14) this.exactAtZ.set(t, v);
      }
      return v;
    };
    const ex = poly.exact;
    // A polygon of zero area is reported IN. Top-level cover cells have positive area, so such a
    // polygon is a degenerate half of a seam split (`splitPoly`). It is sound by the seam
    // argument of contract section 14.5: the halves are closed and their union is the cell, so a
    // half of zero area lies in the other half, which is then the whole cell, and `classifyPoly`
    // reports the cell IN only when that other half is IN as well. (The union-of-brackets
    // argument alone does not cover it: it drops zero-area pieces only of a cell of positive
    // area.)
    //
    // The polygon is convex, its vertices in order, so its area is zero exactly when its
    // vertices are collinear, which is when `zPolygon` keeps fewer than three edges (E3-U2e:
    // this replaces a rational area, whose gcds were most of the work of C9/k19).
    const cell = zPolygon(ex);
    if (cell === null) return true;
    let uncovered: ZVert[][] = [cell];
    for (const n of nodes) {
      let maxD = 0;
      for (const c of n.c)
        for (const g of poly.gens) maxD = Math.max(maxD, ivpNorm2(ivpSub(g, c)).hi);
      if (maxD > this.irr.lo) continue;
      const a = coef(n.t0);
      const b = coef(n.t1);
      const next: ZVert[][] = [];
      for (const p of uncovered)
        for (const sign of [1n, -1n]) {
          const q = zClip(p, zScale(a, sign));
          if (q === null) continue;
          const piece = zClip(q, zScale(b, sign));
          if (piece !== null) next.push(piece);
        }
      uncovered = next;
      if (uncovered.length === 0) return true;
      if (uncovered.length > 64) return false;
    }
    return false;
  }
  /**
   * IN by one bracket over sub-arcs collected by `collectNodes`. A sub-arc whose sweep equation
   * keeps one sign over the polygon holds no foot, so it is kept whole: a sign change (and so a
   * bracket) never spans it. The same collection serves the union-of-brackets test (E3-U2c).
   */
  private inside(
    poly: LPoly,
    nodes: readonly ArcNode[],
    none?: ReadonlyMap<ArcNode, number>,
  ): boolean {
    let k = 0;
    while (k < nodes.length) {
      let end = k;
      while (end + 1 < nodes.length && nodes[end + 1]!.t0 === nodes[end]!.t1) end += 1;
      // The run nodes[k..end] covers [nodes[k].t0, nodes[end].t1] contiguously.
      const ts = [nodes[k]!.t0, ...nodes.slice(k, end + 1).map((n) => n.t1)];
      // At an end of a sub-arc without a foot, the sign is that sub-arc's one sign over the
      // polygon (E3-U2e), except at t = 0 and 1, where a seam tag can set it.
      const sig = ts.map((t, j) => {
        if (none !== undefined && t !== 0 && t !== 1) {
          const known =
            (j > 0 ? none.get(nodes[k + j - 1]!) : undefined) ??
            (j <= end - k ? none.get(nodes[k + j]!) : undefined);
          if (known !== undefined) return known;
        }
        charge(W_ARC, 1);
        return this.sigmaAt(poly, t);
      });
      let last = -1;
      for (let j = 0; j < ts.length; j += 1) {
        if (sig[j] === 0) continue;
        if (last >= 0 && sig[last] === -sig[j]!) {
          let maxD = 0;
          for (let m = last; m < j; m += 1)
            for (const c of nodes[k + m]!.c)
              for (const g of poly.gens) maxD = Math.max(maxD, ivpNorm2(ivpSub(g, c)).hi);
          if (maxD <= this.irr.lo) return true;
        }
        last = j;
      }
      k = end + 1;
    }
    return false;
  }
  /** Up to 8 approximate curve points in a local box (witness candidates for thin strokes). */
  /**
   * Up to 16 approximate normal segments C(t) ± r·n̂(t) of sub-arcs within r of a local box
   * (E3-U2c). Every point of such a segment lies in the sweep (its foot is t, at distance at
   * most r), so the part inside a cell is a witness candidate where the sweep is thinner than
   * the samples, such as the tip of the envelope beside a stationary end. Candidates only:
   * each is tested by exact membership.
   */
  normalsNear(poly: LPoly): [[number, number], [number, number]][] {
    const out: [[number, number], [number, number]][] = [];
    const box = poly.box;
    // Refined to the box's smaller side: under strong anisotropy a cell is a thin local box.
    // Only sub-arcs with a possible foot in the polygon are followed (a sub-arc whose sweep
    // equation keeps one sign over the polygon has no normal through it), within a node budget.
    const size = Math.min(box.x1 - box.x0, box.y1 - box.y0);
    const r = (this.ir.lo + this.ir.hi) / 2;
    const mid = (v: Iv) => (v.lo + v.hi) / 2;
    let budget = NORMAL_CANDIDATE_BUDGET;
    // Sub-arcs known to have no foot in the polygon (E3-U2e) are skipped at no cost.
    const from = this.starts(poly);
    const none = NO_FOOT.get(from);
    const visit = (n: ArcNode) => {
      if (none?.has(n) === true) return;
      charge(W_ARC, 1);
      budget -= 1;
      if (out.length >= 16 || budget <= 0 || boxBoxDistLo(n.box, box) > this.ir.hi) return;
      if (this.excludesZero(n, poly)) return;
      if (n.size <= size / 4 || n.depth >= 40) {
        // The end normals too: beside a butt end the sweep can be a thin wedge along them.
        const ts = [n.t0, (n.t0 + n.t1) / 2, ...(n.t1 === 1 ? [1] : [])];
        for (const t of ts) {
          const k = this.coefAt(t);
          const dx = mid(k.dx);
          const dy = mid(k.dy);
          const l = Math.hypot(dx, dy);
          if (!(l > 0)) continue;
          // Float Horner on rounded coefficients (E3-U2e): a candidate need not be exact.
          const [px, py] = this.pwApprox();
          let cx = 0;
          let cy = 0;
          for (let i = px.length - 1; i >= 0; i -= 1) cx = cx * t + px[i]!;
          for (let i = py.length - 1; i >= 0; i -= 1) cy = cy * t + py[i]!;
          const nx = (-dy / l) * r;
          const ny = (dx / l) * r;
          // Only segments whose bounding box meets the box can cross the cell.
          if (
            Math.max(cx - nx, cx + nx) < box.x0 ||
            Math.min(cx - nx, cx + nx) > box.x1 ||
            Math.max(cy - ny, cy + ny) < box.y0 ||
            Math.min(cy - ny, cy + ny) > box.y1
          )
            continue;
          out.push([
            [cx - nx, cy - ny],
            [cx + nx, cy + ny],
          ]);
        }
        return;
      }
      const [a, b] = arcKids(n, this.cache);
      visit(a);
      visit(b);
    };
    for (const n of from) visit(n);
    return out;
  }
  private pwFloat: [number[], number[]] | null = null;
  /** The power-basis coefficients rounded to binary64, for approximate candidates only. */
  private pwApprox(): [number[], number[]] {
    this.pwFloat ??= [this.pw.x.map(qapprox), this.pw.y.map(qapprox)];
    return this.pwFloat;
  }
  pointsNear(box: Box): [number, number][] {
    const out: [number, number][] = [];
    const size = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    const visit = (n: ArcNode) => {
      charge(W_ARC, 1);
      if (out.length >= 8 || !boxesMeet(n.box, box)) return;
      if (n.size <= size / 4 || n.depth >= 40) {
        const c = n.c[0]!;
        out.push([(c.x.lo + c.x.hi) / 2, (c.y.lo + c.y.hi) / 2]);
        return;
      }
      const [a, b] = arcKids(n, this.cache);
      visit(a);
      visit(b);
    };
    visit(this.root);
    return out;
  }
  excludes(poly: LPoly): boolean {
    const size = boxDiam(poly.box);
    const floor = Math.max(size, this.ir.lo * (size > 0 ? 2 ** -36 : 2 ** -24));
    const budget = { n: 4096 };
    return this.starts(poly).every((n) => this.outside(n, poly, floor, budget));
  }
  classify(poly: LPoly): number {
    const size = boxDiam(poly.box);
    // Sub-arcs are refined to the polygon's size, never below r·2^-36 (a point is refined in
    // stages to r·2^-24, `classifyPointPoly`, its exact membership the fallback), and within a
    // node budget: an undecided polygon stays undecided, which is sound. Without the budget, a point at the evolute's cusp (a triple
    // foot) makes the undecided sub-arcs multiply at every level.
    //
    // The sub-arcs are collected to the polygon's size first (E3-U2d), and the OUT test and the
    // finer collection continue from that collection instead of the root. It is a frontier for
    // the polygon (`ArcHint`), and it is kept for the polygons inside it.
    if (size === 0) return this.classifyPointPoly(poly);
    const floor = Math.max(size, this.ir.lo * 2 ** -36);
    const coarse = this.collectNodes(poly, floor);
    poly.found?.set(this, coarse);
    const budget = { n: 4096 };
    const none = NO_FOOT.get(coarse);
    const outFloor = poly.deepOut === true ? floor / 16 : floor;
    if (coarse.every((n) => this.outside(n, poly, outFloor, budget, none))) return -1;
    if (this.inside(poly, coarse, none)) return 1;
    if (poly.coarseOnly === true) return 0;
    const fine = this.collectNodes(poly, floor / 8, coarse);
    return this.inside(poly, fine, NO_FOOT.get(fine)) || this.insideUnion(poly, fine) ? 1 : 0;
  }
  /**
   * A point's class (E3-U2e): the sub-arcs are refined in stages, to r·2^-8, r·2^-16 and
   * r·2^-24, each continuing from the last, and the OUT and IN tests run after each. A point
   * a fair way from ∂R is decided at the first stage instead of at r·2^-24 (the witness samples
   * of the freeze check were most of the work of C9/g0154), and the last stage is the former
   * single collection, so a point is decided whenever it was before.
   */
  private classifyPointPoly(poly: LPoly): number {
    let nodes = this.starts(poly);
    for (const e of POINT_FLOOR_STAGES) {
      const floor = this.ir.lo * 2 ** -e;
      nodes = this.collectNodes(poly, floor, nodes);
      const budget = { n: 4096 };
      const none = NO_FOOT.get(nodes);
      if (nodes.every((n) => this.outside(n, poly, floor, budget, none))) {
        poly.found?.set(this, nodes);
        return -1;
      }
      if (this.inside(poly, nodes, none)) {
        poly.found?.set(this, nodes);
        return 1;
      }
    }
    poly.found?.set(this, nodes);
    return 0;
  }
}

// =============================================================================================
// 14. Building the stroke region from the source (ST-S1 to ST-S12) and the seam-aware union

type QS = Readonly<{ a: Q; b: Q }>;
const qsMul = (u: QS, v: QS, s: Q): QS => ({
  a: qadd(qmul(u.a, v.a), qmul(qmul(u.b, v.b), s)),
  b: qadd(qmul(u.a, v.b), qmul(u.b, v.a)),
});
const qsEval = (p: Poly, t: QS, s: Q): QS => {
  let acc: QS = { a: Q0, b: Q0 };
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const m = qsMul(acc, t, s);
    acc = { a: qadd(m.a, p[i]!), b: m.b };
  }
  return acc;
};

type StrokeRegion = Readonly<{
  pieces: readonly StrokePiece[];
  seams: readonly Seam[];
  r: Q;
  /** Exact membership of a node-local point. */
  containsLocal: (y: QP) => boolean;
  /** Seam-aware union classification of a local polygon: 1 inside, −1 outside, 0 undecided. */
  classifyPoly: (poly: LPoly, depth: number) => number;
  /** True only when the polygon misses every piece (an OUT certificate without seam splits). */
  excludesPoly: (poly: LPoly) => boolean;
}>;

function startTangentOf(q: readonly QP[]): QP {
  for (let i = 1; i < q.length; i += 1) {
    const d = qpsub(q[i]!, q[0]!);
    if (!qpzero(d)) return d;
  }
  return oracleError('zero-length segment has no tangent');
}

function endTangentOf(q: readonly QP[]): QP {
  const last = q[q.length - 1]!;
  for (let i = q.length - 2; i >= 0; i -= 1) {
    const d = qpsub(last, q[i]!);
    if (!qpzero(d)) return d;
  }
  return oracleError('zero-length segment has no tangent');
}

/** The frontiers that a polygon inside `poly` may start from: its own, else its enclosing ones. */
function hintOf(poly: LPoly): ArcHint | undefined {
  if (poly.found === undefined || poly.found.size === 0) return poly.arcs;
  if (poly.arcs === undefined) return poly.found;
  return new Map([...poly.arcs, ...poly.found]);
}

function splitPoly(poly: LPoly, seam: Seam): [LPoly, LPoly] {
  const gens = poly.gens;
  const exactSide = (side: number): QP[] | null => {
    const ex = poly.exact;
    if (ex === null) return null;
    const out: QP[] = [];
    const sv = ex.map((p) => qsgn(qpdot(qpsub(p, seam.b), seam.t)) * side);
    for (let i = 0; i < ex.length; i += 1) {
      const P = ex[i]!;
      if (sv[i]! >= 0) out.push(P);
      if (ex.length === 1) break;
      const j = (i + 1) % ex.length;
      if (sv[i]! * sv[j]! < 0) {
        const sp = qpdot(qpsub(P, seam.b), seam.t);
        const sq = qpdot(qpsub(ex[j]!, seam.b), seam.t);
        out.push(qplerp(P, ex[j]!, qdiv(sp, qsub(sp, sq))));
      }
    }
    return out.length > 0 ? out : null;
  };
  const plus: IvP[] = [];
  const minus: IvP[] = [];
  const s = gens.map((g) => ivpDot(ivpSub(g, seam.ib), seam.it));
  for (let i = 0; i < gens.length; i += 1) {
    const P = gens[i]!;
    const sp = s[i]!;
    if (sp.hi >= 0) plus.push(P);
    if (sp.lo <= 0) minus.push(P);
    if (gens.length === 1) break;
    const j = (i + 1) % gens.length;
    const sq = s[j]!;
    const sameSide = (sp.lo > 0 && sq.lo > 0) || (sp.hi < 0 && sq.hi < 0);
    if (sameSide) continue;
    const den = isub(sp, sq);
    let lam = idiv(sp, den);
    lam = {
      lo: Math.max(0, Number.isFinite(lam.lo) ? lam.lo : 0),
      hi: Math.min(1, Number.isFinite(lam.hi) ? lam.hi : 1),
    };
    if (lam.lo > lam.hi) lam = { lo: 0, hi: 1 };
    const I = ivpLerp(P, gens[j]!, lam);
    plus.push(I);
    minus.push(I);
  }
  // The exact half is computed on first use only (E3-U2c): most halves are decided by the
  // interval tests, and the exact cut points carry large denominators.
  const make = (g: IvP[], side: number): LPoly => {
    const tags = new Map(poly.tags);
    tags.set(seam.id, side);
    let exact: QP[] | null | undefined;
    return {
      gens: g,
      tags,
      box: boxOfIvPoints(g),
      arcs: hintOf(poly),
      get exact() {
        if (exact === undefined) exact = exactSide(side);
        return exact;
      },
    };
  };
  return [make(plus, 1), make(minus, -1)];
}

/**
 * The stroke region in scaled local coordinates σ·y (see `makeFrame`): every source point and
 * the half width are scaled by σ, and the radius by |σ|. The classification of the source is
 * scale-free, so it runs on the unscaled numbers.
 */
function makeStrokeRegion(c: Decoded, hooks: A04Hooks, sigma: Q): StrokeRegion {
  if (c.paint.kind !== 'stroke') oracleError('not a stroke case');
  const paint = c.paint;
  const verbCodes = [...c.verbs].map((v) => 'MLCZ'.indexOf(v));
  const classification = classifyStrokeSource({
    verbs: verbCodes,
    points: c.points,
    width: paint.width,
    cap: paint.cap,
    join: paint.join,
    miterLimit: paint.miterLimit,
    toleranceExponent: 0,
  });
  // Segments by verb ordinal (ST-S1), decoded independently of the classifier.
  const segments = new Map<number, QP[]>();
  {
    let cursor = 0;
    const take = (): QP => {
      const p = qpscale(qpn(c.points[cursor]!, c.points[cursor + 1]!), sigma);
      cursor += 2;
      return p;
    };
    let start: QP | null = null;
    let last: QP | null = null;
    [...c.verbs].forEach((verb, ordinal) => {
      if (verb === 'M') {
        start = take();
        last = start;
      } else if (verb === 'L') {
        const p = take();
        segments.set(ordinal, [last!, p]);
        last = p;
      } else if (verb === 'C') {
        const q = [last!, take(), take(), take()];
        segments.set(ordinal, q);
        last = q[3]!;
      } else {
        if (last !== null && start !== null && !qpeq(last, start))
          segments.set(ordinal, [last, start]);
        last = start;
      }
    });
  }
  const seg = (verb: number): QP[] => {
    const q = segments.get(verb);
    if (q === undefined) oracleError(`no segment for verb ${verb}`);
    return q;
  };
  const r = qabs(qmul(qmul(qnum(paint.width), QHALF), sigma));
  const rApprox = qIv(r).hi;
  const seams = new Map<string, Seam>();
  const seamRef = (b: QP, t: QP, side: number, reach: number): SeamRef => {
    let canon = t;
    let flip = 1;
    if (qsgn(t.x) < 0 || (t.x.n === 0n && qsgn(t.y) < 0)) {
      canon = qpneg(t);
      flip = -1;
    }
    const dirKey =
      canon.x.n === 0n
        ? 'v'
        : (() => {
            const k = qdiv(canon.y, canon.x);
            return `${k.n}/${k.d}`;
          })();
    const key = `${qpkey(b)}|${dirKey}`;
    let seam = seams.get(key);
    if (seam === undefined) {
      seam = { id: seams.size, b, t: canon, ib: qpIv(b), it: qpIv(canon), reach };
      seams.set(key, seam);
    }
    seam.reach = Math.max(seam.reach, reach);
    return { seam, side: side * flip };
  };
  const pieces: StrokePiece[] = [];
  const add = (p: StrokePiece) => {
    if (hooks.dropStrokePiece?.(p.role) !== true) pieces.push(p);
  };
  const ratDisk = (role: string, p: QP) =>
    add(new DiskPiece(role, { a: p.x, b: Q0 }, { a: p.y, b: Q0 }, Q0, r));
  const cubicByVerb = new Map(classification.cubics.map((k) => [k.verb, k]));
  for (const sub of classification.subpaths)
    for (const verb of sub.remainingVerbs) {
      const q = seg(verb);
      const ts = startTangentOf(q);
      const te = endTangentOf(q);
      const startRef = seamRef(q[0]!, ts, 1, 2 * rApprox);
      const endRef = seamRef(q[q.length - 1]!, te, -1, 2 * rApprox);
      if (q.length === 2) {
        add(new LineSweep(q[0]!, q[1]!, r, startRef, endRef));
        continue;
      }
      const info = cubicByVerb.get(verb);
      if (info === undefined) oracleError(`cubic ${verb} is unclassified`);
      const pw = cubicPower(q);
      let dir: { x: Q[]; y: Q[] };
      if (info.kind === 'collinear') {
        const d = startTangentOf(q);
        dir = { x: [d.x], y: [d.y] };
        // Turning points: odd-order roots in (0, 1) of the projected derivative.
        const lam = pderiv(padd(pscale(pw.x, d.x), pscale(pw.y, d.y)));
        const turning: QS[] = [];
        let s = Q0;
        if (lam.length === 3) {
          const [C0, B0, A0] = lam as [Q, Q, Q];
          const disc = qsub(qsq(B0), qmul(qi(4), qmul(A0, C0)));
          if (qsgn(disc) > 0) {
            s = disc;
            const base = qdiv(qneg(B0), qmul(qi(2), A0));
            const half = qdiv(Q1, qmul(qi(2), A0));
            for (const t of [
              { a: base, b: qneg(half) },
              { a: base, b: half },
            ])
              if (signRad(t.a, t.b, s) > 0 && signRad(qsub(Q1, t.a), qneg(t.b), s) > 0)
                turning.push(t);
          }
        } else if (lam.length === 2) {
          const t = qdiv(qneg(lam[0]!), lam[1]!);
          if (qsgn(t) > 0 && qcmp(t, Q1) < 0) turning.push({ a: t, b: Q0 });
        }
        if (turning.length !== info.turningPoints.length)
          oracleError('turning points disagree with the stroke classification');
        for (const t of turning)
          add(new DiskPiece('turning-disk', qsEval(pw.x, t, s), qsEval(pw.y, t, s), s, r));
      } else {
        const dx = pderiv(pw.x);
        const dy = pderiv(pw.y);
        if (info.kind === 'regular') dir = { x: dx, y: dy };
        else {
          const st = info.stationary;
          if (st === null) oracleError('stationary cubic without a parameter');
          const t = qmk(st.numerator, st.denominator);
          const lin = [qneg(t), Q1];
          const qx = pdivmod(dx, lin);
          const qy = pdivmod(dy, lin);
          if (qx.r.length > 0 || qy.r.length > 0)
            oracleError('stationary parameter does not divide C′');
          dir = { x: qx.q, y: qy.q };
          if (info.kind === 'cusp') ratDisk('cusp-disk', { x: peval(pw.x, t), y: peval(pw.y, t) });
        }
      }
      const d0 = { x: peval(dir.x, Q0), y: peval(dir.y, Q0) };
      const d1 = { x: peval(dir.x, Q1), y: peval(dir.y, Q1) };
      const s0 = qsgn(qpdot(d0, ts));
      const s1 = -qsgn(qpdot(d1, te));
      if (s0 === 0 || s1 === 0 || qsgn(qpcross(d0, ts)) !== 0 || qsgn(qpcross(d1, te)) !== 0)
        oracleError('sweep direction disagrees with the ST-S2 tangents');
      add(new CubicSweep(q, dir, r, s0, s1, startRef, endRef, hooks));
    }
  for (const join of classification.joins) {
    if (join.piece === 'none') continue;
    const b = qpscale(qpn(join.point[0], join.point[1]), sigma);
    if (join.piece === 'round') {
      ratDisk('round-join', b);
      continue;
    }
    const dIn = endTangentOf(seg(join.incomingVerb));
    const dOut = startTangentOf(seg(join.outgoingVerb));
    const k = join.outer === 'plus' ? Q1 : qi(-1);
    const u = qpscale(qpperp(dIn), k);
    const v = qpscale(qpperp(dOut), k);
    const piece = new AngleJoin(
      join.piece === 'miter',
      b,
      u,
      v,
      r,
      seamRef(b, dIn, qsgn(qpdot(dIn, v)), 0),
      seamRef(b, dOut, qsgn(qpdot(dOut, u)), 0),
    );
    const reach = Math.max(piece.box.x1 - piece.box.x0, piece.box.y1 - piece.box.y0);
    seamRef(b, dIn, 1, reach);
    seamRef(b, dOut, 1, reach);
    add(piece);
  }
  for (const cap of classification.caps) {
    const q = seg(cap.verb);
    if (cap.end === 'start') {
      const t = startTangentOf(q);
      if (paint.cap === 'round') ratDisk('round-cap', q[0]!);
      else add(new SquareCap(q[0]!, qpneg(t), r, seamRef(q[0]!, t, -1, 2 * rApprox)));
    } else {
      const t = endTangentOf(q);
      const b = q[q.length - 1]!;
      if (paint.cap === 'round') ratDisk('round-cap', b);
      else add(new SquareCap(b, t, r, seamRef(b, t, 1, 2 * rApprox)));
    }
  }
  for (const pc of classification.pointCaps) {
    const p = qpscale(qpn(pc.point[0], pc.point[1]), sigma);
    if (paint.cap === 'round') ratDisk('point-cap', p);
    else add(new PointSquare(p, r));
  }
  const seamList = [...seams.values()];
  const containsLocal = (y: QP) => {
    charge(W_MEMBER, 1);
    return pieces.some((p) => p.contains(y));
  };
  // A vertex whose enclosure lies outside a piece's (outward) box is outside the piece, so the
  // exact all-vertices test of a convex piece cannot succeed: a sound filter before exact work.
  const maybeWithin = (poly: LPoly, box: Box): boolean =>
    poly.gens.every(
      (g) => g.x.hi >= box.x0 && g.x.lo <= box.x1 && g.y.hi >= box.y0 && g.y.lo <= box.y1,
    );
  // Seam splits per top-level classification (E3-U2c). An exhausted budget leaves the polygon
  // undecided, which is sound; the cover's quadtree then refines it, and a smaller cell meets
  // fewer seams. Without it a large cell tries every seam to depth 3 (seams³ classifications).
  let splitBudget = 0;
  const classifyPoly = (poly: LPoly, depth: number): number => {
    charge(W_SEAM, 1);
    if (depth === 0) splitBudget = SEAM_SPLIT_BUDGET;
    const open: StrokePiece[] = [];
    for (const p of pieces) {
      if (!boxesMeet(p.box, poly.box)) continue;
      const v = p.classify(poly);
      if (v === 1) return 1;
      if (v === 0) {
        if (
          p.convex &&
          poly.exact !== null &&
          maybeWithin(poly, p.box) &&
          poly.exact.every((y) => p.contains(y))
        )
          return 1;
        if (p.corners !== undefined && separatedByEdges(poly.gens, p.corners)) continue;
        open.push(p);
      }
    }
    if (open.length === 0) return -1;
    if (depth >= 3) return 0;
    // Nearest seams first, so that the budget goes to the seams most likely to matter.
    const candidates: { seam: Seam; d: number }[] = [];
    for (const seam of seamList) {
      if (poly.tags.has(seam.id)) continue;
      const d = pointBoxDistLo(seam.ib, poly.box);
      if (d > seam.reach) continue;
      const s = poly.gens.map((g) => ivpDot(ivpSub(g, seam.ib), seam.it));
      if (s.every((v) => v.lo > 0) || s.every((v) => v.hi < 0)) continue;
      candidates.push({ seam, d });
    }
    candidates.sort((u, v) => u.d - v.d || u.seam.id - v.seam.id);
    for (const { seam } of candidates) {
      if (splitBudget <= 0) return 0;
      splitBudget -= 1;
      const [plus, minus] = splitPoly(poly, seam);
      if (classifyPoly(plus, depth + 1) === 1 && classifyPoly(minus, depth + 1) === 1) return 1;
    }
    return pairSplit(poly, depth, open) ? 1 : 0;
  };
  // Pair splits (E3-U2e). Two convex pieces whose edges both cross the polygon can cover it
  // without either containing it, where no registered seam lies: two overlapping line bodies of
  // a path that turns back on itself, or the crossing of two bodies' edges. In both, the
  // bisector of the two edge lines (the points at equal signed distance from both) leaves each
  // half of the polygon inside one piece, so the polygon is split along it and is inside when
  // both halves are. The line is only a guess: the halves cover the polygon whatever it is, so
  // the result is sound, and a wrong guess leaves the polygon undecided.
  const pairSplit = (poly: LPoly, depth: number, open: readonly StrokePiece[]): boolean => {
    const convex = open.filter((p) => p.convex && p.corners !== undefined);
    if (convex.length < 2 || convex.length > PAIR_SPLIT_PIECES) return false;
    const cx = (poly.box.x0 + poly.box.x1) / 2;
    const cy = (poly.box.y0 + poly.box.y1) / 2;
    const lines = convex.map((p) => crossingEdge(p.corners!, poly.gens, cx, cy));
    for (let i = 0; i < lines.length; i += 1)
      for (let j = i + 1; j < lines.length; j += 1) {
        const a = lines[i]!;
        const b = lines[j]!;
        if (a === null || b === null || a.nx * b.nx + a.ny * b.ny > PAIR_SPLIT_COS) continue;
        // The bisector {y : n_a·(y − p_a) = n_b·(y − p_b)}, through the point nearest the center.
        const tx = a.nx - b.nx;
        const ty = a.ny - b.ny;
        const k =
          (a.nx * a.px + a.ny * a.py - b.nx * b.px - b.ny * b.py - tx * cx - ty * cy) /
          (tx * tx + ty * ty);
        const bx = cx + k * tx;
        const by = cy + k * ty;
        if (![bx, by, tx, ty].every(Number.isFinite)) continue;
        if (splitBudget <= 0) return false;
        splitBudget -= 1;
        // A negative id never names a registered seam, so no piece reads the tag as its own.
        const seam: Seam = {
          id: -1 - depth,
          b: qpn(bx, by),
          t: qpn(tx, ty),
          ib: ivpc(bx, by),
          it: ivpc(tx, ty),
          reach: Infinity,
        };
        const [plus, minus] = splitPoly(poly, seam);
        if (classifyPoly(plus, depth + 1) === 1 && classifyPoly(minus, depth + 1) === 1)
          return true;
      }
    return false;
  };
  const excludesPoly = (poly: LPoly): boolean => {
    charge(W_SEAM, 1);
    for (const p of pieces) {
      if (!boxesMeet(p.box, poly.box)) continue;
      if (p.corners !== undefined && separatedByEdges(poly.gens, p.corners)) continue;
      if (p.excludes !== undefined ? !p.excludes(poly) : p.classify(poly) !== -1) return false;
    }
    return true;
  };
  return { pieces, seams: seamList, r, containsLocal, classifyPoly, excludesPoly };
}

// =============================================================================================
// 15. The stroke target: a lazy certified quadtree cover of ∂R (obligation (d) for strokes)

type CoverNode = {
  readonly box: Box;
  readonly cls: number;
  readonly witness: Readonly<{ a: QP; b: QP; ia: IvP; ib: IvP }> | null;
  kids: CoverNode[] | null;
  /** The quadtree parent, whose sub-arc frontiers the cell's classification starts from. */
  readonly parent: CoverNode | null;
};

/** Sub-arc frontiers of undecided cover cells kept for reuse (E3-U2d), a memory bound. */
const COVER_FRONTIER_CACHE = 1 << 14;
const SAMPLE_CACHE = 1 << 16;

/** One cover cell as a ∂R element: certain when it holds an inside and an outside witness. */
class CellElement implements RElement {
  readonly gens: readonly IvP[];
  readonly size: number;
  constructor(
    readonly node: CoverNode,
    private readonly target: StrokeTarget,
  ) {
    const b = node.box;
    this.gens = [ivpc(b.x0, b.y0), ivpc(b.x1, b.y0), ivpc(b.x1, b.y1), ivpc(b.x0, b.y1)];
    this.size = boxDiam(b);
  }
  get box(): Box {
    return this.node.box;
  }
  get certain(): boolean {
    return this.node.witness !== null;
  }
  lower(g: IvP): number {
    return pointBoxDistLo(g, this.node.box);
  }
  upper(g: IvP): number {
    const w = this.node.witness;
    if (w === null) return Infinity;
    return Math.max(pointPointDist(g, w.ia).hi, pointPointDist(g, w.ib).hi);
  }
  supUpper(gens: readonly IvP[], center: IvP, hooks: A04Hooks): number {
    const w = this.node.witness;
    if (w === null) return Infinity;
    return cellSupUpper(
      gens,
      center,
      (g) => Math.max(pointPointDist(g, w.ia).hi, pointPointDist(g, w.ib).hi),
      hooks,
    );
  }
  brLower(m: MeshTarget, f: Frame): number {
    const w = this.node.witness;
    if (w === null || !inW1(f, w.a) || !inW1(f, w.b)) return 0;
    return m.segDistLo(w.ia, w.ib);
  }
  split(): RElement[] | null {
    return this.target.children(this.node).map((k) => new CellElement(k, this.target));
  }
}

class StrokeTarget implements RegionTarget {
  readonly kind = 'stroke' as const;
  readonly root: CoverNode;
  nodes = 0;
  /**
   * The sub-arc frontiers of undecided cells (E3-U2d), least recently used first. An evicted
   * cell's frontiers are recomputed from its parent's on demand: the same classification, so
   * the same frontiers, charged again.
   */
  private readonly frontiers = new Map<CoverNode, ArcHint>();
  private rootArcs: ArcHint | null = null;
  /** Memberships of witness samples by position, oldest first (E3-U2e). */
  private readonly samples = new Map<string, number>();
  constructor(
    readonly region: StrokeRegion,
    private readonly frame: Frame,
    private readonly work: Work,
  ) {
    const reg = indexRegion(frame);
    const side = 2 ** Math.ceil(Math.log2(Math.max(reg.x1 - reg.x0, reg.y1 - reg.y0)));
    this.root = this.node({ x0: reg.x0, y0: reg.y0, x1: reg.x0 + side, y1: reg.y0 + side }, null);
  }
  private keepArcs(n: CoverNode, arcs: ArcHint): void {
    if (n.parent === null) {
      this.rootArcs = arcs;
      return;
    }
    this.frontiers.delete(n);
    this.frontiers.set(n, arcs);
    if (this.frontiers.size > COVER_FRONTIER_CACHE)
      this.frontiers.delete(this.frontiers.keys().next().value!);
  }
  /** The sub-arc frontiers of an undecided cell: kept, or recomputed from its parent's. */
  private arcsOf(n: CoverNode): ArcHint {
    if (n.parent === null && this.rootArcs !== null) return this.rootArcs;
    const kept = this.frontiers.get(n);
    if (kept !== undefined) {
      this.keepArcs(n, kept);
      return kept;
    }
    const { arcs } = this.classifyCell(
      n.box,
      n.parent === null ? undefined : this.arcsOf(n.parent),
    );
    this.keepArcs(n, arcs);
    return arcs;
  }
  /** The local polygon of a physical box (or a point). */
  polyOf(points: readonly IvP[], exact: readonly QP[] | null = null, arcs?: ArcHint): LPoly {
    const gens = points.map((p) => phiInvIv(this.frame, p));
    const local = exact === null ? null : exact.map((p) => phiInv(this.frame, p));
    return {
      gens,
      tags: new Map(),
      box: boxOfIvPoints(gens),
      exact: local,
      arcs,
      found: new Map(),
    };
  }
  /** The local polygon of a physical box, without its exact vertices. */
  private boxPoly(box: Box, arcs?: ArcHint): LPoly {
    return this.polyOf(
      [ivpc(box.x0, box.y0), ivpc(box.x1, box.y0), ivpc(box.x1, box.y1), ivpc(box.x0, box.y1)],
      null,
      arcs,
    );
  }
  /** A cell's class, and the sub-arc frontiers that its classification found (E3-U2d). */
  private classifyCell(box: Box, from?: ArcHint): { cls: number; arcs: ArcHint } {
    // A cell above the freeze cell size skips the finer collection (E3-U2e): on ∂R it never
    // decides, and an inside cell that only it would decide is refined instead.
    const poly: LPoly = {
      ...this.polyOf(
        [ivpc(box.x0, box.y0), ivpc(box.x1, box.y0), ivpc(box.x1, box.y1), ivpc(box.x0, box.y1)],
        [qpn(box.x0, box.y0), qpn(box.x1, box.y0), qpn(box.x1, box.y1), qpn(box.x0, box.y1)],
        from,
      ),
      coarseOnly: box.x1 - box.x0 > A04_ORACLE_PARAMETERS.freezeCellSize,
      deepOut: box.x1 - box.x0 === A04_ORACLE_PARAMETERS.freezeCellSize,
    };
    const cls = this.region.classifyPoly(poly, 0);
    return { cls, arcs: hintOf(poly) ?? new Map() };
  }
  /** The class of a box that need not be a cover cell, from the sub-arc roots. */
  classifyPhys(box: Box): number {
    return this.classifyCell(box).cls;
  }
  /** The lengths of the local images of a box's x and y edges. */
  private localSides(box: Box): { lx: number; ly: number } {
    const o = phiInvIv(this.frame, ivpc(box.x0, box.y0));
    const len = (p: IvP) =>
      Math.hypot(
        (p.x.lo + p.x.hi) / 2 - (o.x.lo + o.x.hi) / 2,
        (p.y.lo + p.y.hi) / 2 - (o.y.lo + o.y.hi) / 2,
      );
    return {
      lx: len(phiInvIv(this.frame, ivpc(box.x1, box.y0))),
      ly: len(phiInvIv(this.frame, ivpc(box.x0, box.y1))),
    };
  }
  /**
   * OUT by halves for an anisotropic cell (E3-U2d). Under strong anisotropy (T7) a cell's local
   * image is a strip longer than the stroke is wide. Beside a butt corner such a strip holds
   * points within r of the end and points on the end normal, but no point that is both, and
   * the sub-arc test, which bounds the distance over the whole strip, cannot see that. The cell
   * misses R when both halves along its long local axis miss every piece, which holds
   * recursively, so the halves are tested down to a local aspect of about 2. The search stops at
   * the first half that is not certified, so a cell on ∂R costs one chain of halves.
   */
  private excludesByHalves(box: Box, arcs: ArcHint): boolean {
    const { lx, ly } = this.localSides(box);
    const long = Math.max(lx, ly);
    const short = Math.min(lx, ly);
    if (!(long >= ANISOTROPIC_RATIO * short)) return false;
    const levels = Math.min(ANISOTROPIC_MAX_LEVELS, Math.ceil(Math.log2(long / short)) - 1);
    const halves = (b: Box): [Box, Box] => {
      if (lx >= ly) {
        const xm = (b.x0 + b.x1) / 2;
        return [
          { ...b, x1: xm },
          { ...b, x0: xm },
        ];
      }
      const ym = (b.y0 + b.y1) / 2;
      return [
        { ...b, y1: ym },
        { ...b, y0: ym },
      ];
    };
    // The cell itself is not certified (classifyPoly), so the search starts at its halves.
    const halvesExcluded = (b: Box, left: number): boolean =>
      halves(b).every((h) => {
        const poly = this.boxPoly(h, arcs);
        return this.region.excludesPoly(poly) || (left > 1 && halvesExcluded(h, left - 1));
      });
    return halvesExcluded(box, levels);
  }
  /**
   * IN by halves for an anisotropic cell (E3-U2e), the counterpart of `excludesByHalves`. Under
   * T7 a cell inside a self-overlapping stroke (C9/k22) is a strip whose feet on the curve
   * spread over more than the bracket test allows; its halves along the long local axis are
   * shorter, and the cell is inside when both are, recursively.
   */
  private includedByHalves(box: Box, arcs: ArcHint): boolean {
    const { lx, ly } = this.localSides(box);
    const long = Math.max(lx, ly);
    const short = Math.min(lx, ly);
    if (!(long >= ANISOTROPIC_RATIO * short)) return false;
    const levels = Math.min(ANISOTROPIC_MAX_LEVELS, Math.ceil(Math.log2(long / short)) - 1);
    const halves = (b: Box): [Box, Box] => {
      if (lx >= ly) {
        const xm = (b.x0 + b.x1) / 2;
        return [
          { ...b, x1: xm },
          { ...b, x0: xm },
        ];
      }
      const ym = (b.y0 + b.y1) / 2;
      return [
        { ...b, y1: ym },
        { ...b, y0: ym },
      ];
    };
    const halvesIncluded = (b: Box, left: number): boolean =>
      halves(b).every((h) => {
        const poly = this.polyOf(
          [ivpc(h.x0, h.y0), ivpc(h.x1, h.y0), ivpc(h.x1, h.y1), ivpc(h.x0, h.y1)],
          [qpn(h.x0, h.y0), qpn(h.x1, h.y0), qpn(h.x1, h.y1), qpn(h.x0, h.y1)],
          arcs,
        );
        return this.region.classifyPoly(poly, 0) === 1 || (left > 1 && halvesIncluded(h, left - 1));
      });
    return halvesIncluded(box, levels);
  }
  /** The class of a point; `arcs` are frontiers of a cell that holds it. */
  classifyPoint(x: number, y: number, arcs?: ArcHint): number {
    return this.region.classifyPoly(this.polyOf([ivpc(x, y)], null, arcs), 0);
  }
  private node(box: Box, parent: CoverNode | null): CoverNode {
    spend(this.work, 1, 'stroke cover');
    this.nodes += 1;
    // A cell's classification starts from its parent's sub-arc frontiers (E3-U2d). The root's
    // starts from the sub-arc roots, so by induction a cell's class and frontiers are a function
    // of its box alone, however the cover is built.
    const classified = this.classifyCell(box, parent === null ? undefined : this.arcsOf(parent));
    let cls = classified.cls;
    // The witness pair is searched on first use (E3-U2c): the freeze check reads it only at the
    // freeze cell size and below, so larger cells on the way down never pay for the samples. It
    // is a function of the box alone, so the cover is the same whenever it is computed. Its
    // samples start from the cell's own sub-arc frontiers (E3-U2d), a function of the box too:
    // kept, or recomputed from the parent's when they were evicted.
    const arcs = classified.arcs;
    let witness: CoverNode['witness'] | undefined = cls === 0 ? undefined : null;
    // An undecided anisotropic cell at the freeze cell size or below gets its witness, or its
    // class by halves, at once (`anisotropicGate`). Larger cells are refined instead, so the cost
    // stays with the small cells that the freeze check reads.
    if (cls === 0 && box.x1 - box.x0 <= A04_ORACLE_PARAMETERS.freezeCellSize) {
      const { lx, ly } = this.localSides(box);
      if (Math.max(lx, ly) >= ANISOTROPIC_RATIO * Math.min(lx, ly))
        ({ cls, witness } = this.anisotropicGate(box, arcs));
    }
    const find = () => this.findWitness(box, this.arcsOf(n));
    const n: CoverNode = {
      box,
      cls,
      kids: null,
      parent,
      get witness() {
        if (witness === undefined) witness = find();
        return witness;
      },
    };
    if (cls === 0) this.keepArcs(n, arcs);
    return n;
  }
  /**
   * The membership of a witness sample, ±1 (E3-U2e). A sample the certified point test leaves
   * open (it lies on or next to ∂R) is decided by exact membership; a point of ∂R is inside the
   * closed region. Either way the value is the point's membership, whichever cell's frontiers
   * the test started from, so it is kept: neighbouring cells share their corner and edge-middle
   * samples.
   */
  private sampleClass(x: number, y: number, arcs: ArcHint): number {
    const key = `${x},${y}`;
    const kept = this.samples.get(key);
    if (kept !== undefined) return kept;
    let v = this.classifyPoint(x, y, arcs);
    if (v === 0) v = this.contains(qpn(x, y)) ? 1 : -1;
    this.samples.set(key, v);
    if (this.samples.size > SAMPLE_CACHE) this.samples.delete(this.samples.keys().next().value!);
    return v;
  }
  /** An exact inside and outside sample of an undecided cell, or null. */
  /** The first inside and outside points among the nine samples of a cell. */
  private sampleSides(
    box: Box,
    arcs: ArcHint,
  ): { inside: [number, number] | null; outside: [number, number] | null } {
    const xm = (box.x0 + box.x1) / 2;
    const ym = (box.y0 + box.y1) / 2;
    let inside: [number, number] | null = null;
    let outside: [number, number] | null = null;
    for (const [x, y] of [
      [xm, ym],
      [box.x0, box.y0],
      [box.x1, box.y0],
      [box.x1, box.y1],
      [box.x0, box.y1],
      [xm, box.y0],
      [box.x1, ym],
      [xm, box.y1],
      [box.x0, ym],
    ] as const) {
      const v = this.sampleClass(x, y, arcs);
      if (v === 1 && inside === null) inside = [x, y];
      if (v === -1 && outside === null) outside = [x, y];
      if (inside !== null && outside !== null) break;
    }
    return { inside, outside };
  }
  private findWitness(box: Box, arcs: ArcHint): CoverNode['witness'] {
    let { inside, outside } = this.sampleSides(box, arcs);
    // A piece thinner than the sample spacing (a thin wedge or strip) is found through the
    // pieces themselves: the centroid of a convex piece clipped to the cell, or the cell point
    // nearest to a disk's center, is tested by exact membership.
    if (outside !== null && inside === null) inside = this.pieceCandidate(box, arcs);
    if (outside !== null && inside === null) inside = this.anisotropicCandidate(box, arcs, 1);
    if (inside !== null && outside === null) outside = this.anisotropicCandidate(box, arcs, -1);
    if (inside === null || outside === null) return null;
    return {
      a: qpn(inside[0], inside[1]),
      b: qpn(outside[0], outside[1]),
      ia: ivpc(inside[0], inside[1]),
      ib: ivpc(outside[0], outside[1]),
    };
  }
  /**
   * The class and witness of an undecided anisotropic cell at the freeze cell size or below
   * (E3-U2d, E3-U2e). A cell with a witness meets ∂R; one without is tested OUT, then IN, by
   * halves. When the nine samples are all on one side, the halves test of that side runs before
   * the candidate search of the other side, which is the costly step (E3-U2e: C9/k22 at T7): a
   * cell certified by halves holds no point of the other side, so the search would fail.
   */
  private anisotropicGate(box: Box, arcs: ArcHint): { cls: number; witness: CoverNode['witness'] } {
    const { inside, outside } = this.sampleSides(box, arcs);
    let triedIn = false;
    let triedOut = false;
    if (inside !== null && outside === null) {
      triedIn = true;
      if (this.includedByHalves(box, arcs)) return { cls: 1, witness: null };
    }
    if (outside !== null && inside === null) {
      triedOut = true;
      if (this.excludesByHalves(box, arcs)) return { cls: -1, witness: null };
    }
    const witness = this.findWitness(box, arcs);
    if (witness !== null) return { cls: 0, witness };
    if (!triedOut && this.excludesByHalves(box, arcs)) return { cls: -1, witness: null };
    if (!triedIn && this.includedByHalves(box, arcs)) return { cls: 1, witness: null };
    return { cls: 0, witness: null };
  }
  /**
   * A point of the box inside R (want 1) or outside it (want −1, E3-U2e) on the cell's midline
   * along its long local axis, or null (E3-U2d). Under strong anisotropy a cell's local image is a thin strip that can be longer
   * than the stroke is wide, so the part of R in it is a short stretch of the strip, which the
   * nine samples and the normal segments can miss (beside the butt corner of a stroke under
   * T7). The samples are spaced at about the strip's width. Candidates only: each is tested by
   * the certified point test and exact membership.
   */
  private anisotropicCandidate(box: Box, arcs: ArcHint, want: 1 | -1): [number, number] | null {
    const f = this.frame;
    const ex = phiInvIv(f, ivpc(box.x1, box.y0));
    const ey = phiInvIv(f, ivpc(box.x0, box.y1));
    const o = phiInvIv(f, ivpc(box.x0, box.y0));
    const len = (p: IvP) =>
      Math.hypot(
        (p.x.lo + p.x.hi) / 2 - (o.x.lo + o.x.hi) / 2,
        (p.y.lo + p.y.hi) / 2 - (o.y.lo + o.y.hi) / 2,
      );
    const lx = len(ex);
    const ly = len(ey);
    const long = Math.max(lx, ly);
    const short = Math.min(lx, ly);
    if (!(long >= ANISOTROPIC_RATIO * short)) return null;
    const n = Math.min(
      ANISOTROPIC_SAMPLES,
      2 ** Math.ceil(Math.log2(long / Math.max(short, Number.MIN_VALUE))),
    );
    const xm = (box.x0 + box.x1) / 2;
    const ym = (box.y0 + box.y1) / 2;
    // Then geometrically toward both ends (E3-U2e): a thin wedge of R or of its complement that
    // ends at a short edge of the cell (a piece's edge on a dyadic cell edge, beside the crossing
    // of another piece's edge) is thinner there than any uniform spacing.
    const us: number[] = [];
    for (let i = 0; i < n; i += 1) us.push((i + 0.5) / n);
    for (let k = Math.log2(n) + 1; k <= Math.log2(n) + ANISOTROPIC_MAX_LEVELS; k += 1)
      us.push(2 ** -k, 1 - 2 ** -k);
    for (const u of us) {
      const x = lx >= ly ? box.x0 + u * (box.x1 - box.x0) : xm;
      const y = lx >= ly ? ym : box.y0 + u * (box.y1 - box.y0);
      const v = this.classifyPoint(x, y, arcs);
      if (v === want) return [x, y];
      if (v === 0 && this.contains(qpn(x, y)) === (want === 1)) return [x, y];
    }
    return null;
  }
  /** A point of the box inside R, found from the pieces, or null (candidates are approximate). */
  private pieceCandidate(box: Box, arcs: ArcHint): [number, number] | null {
    const f = this.frame;
    const toLocal = (x: number, y: number): [number, number] => {
      const p = phiInvIv(f, ivpc(x, y));
      return [(p.x.lo + p.x.hi) / 2, (p.y.lo + p.y.hi) / 2];
    };
    const sg = qapprox(f.sigma);
    const fa = qapprox(f.a) / sg;
    const fb = qapprox(f.b) / sg;
    const fc = qapprox(f.c) / sg;
    const fd = qapprox(f.d) / sg;
    const ox = qapprox(f.ox);
    const oy = qapprox(f.oy);
    const toPhys = ([x, y]: readonly [number, number]): [number, number] => [
      fa * x + fb * y + ox,
      fc * x + fd * y + oy,
    ];
    const quad = [
      toLocal(box.x0, box.y0),
      toLocal(box.x1, box.y0),
      toLocal(box.x1, box.y1),
      toLocal(box.x0, box.y1),
    ];
    const local = boxOfIvPoints(quad.map(([x, y]) => ivpc(x, y)));
    const tryPoint = (p: [number, number]): [number, number] | null => {
      const x = Math.min(box.x1, Math.max(box.x0, p[0]));
      const y = Math.min(box.y1, Math.max(box.y0, p[1]));
      // The certified point test first; exact membership only where it is undecided.
      const v = this.classifyPoint(x, y, arcs);
      if (v !== 0) return v === 1 ? [x, y] : null;
      return this.contains(qpn(x, y)) ? [x, y] : null;
    };
    for (const piece of this.region.pieces) {
      if (!boxesMeet(piece.box, local)) continue;
      if (piece.corners !== undefined) {
        const clipped = clipConvex(
          piece.corners.map(
            (c) => [(c.x.lo + c.x.hi) / 2, (c.y.lo + c.y.hi) / 2] as [number, number],
          ),
          quad,
        );
        if (clipped.length === 0) continue;
        const cx = clipped.reduce((a, p) => a + p[0], 0) / clipped.length;
        const cy = clipped.reduce((a, p) => a + p[1], 0) / clipped.length;
        const hit = tryPoint(toPhys([cx, cy]));
        if (hit !== null) return hit;
      } else if (piece instanceof CubicSweep) {
        for (const p of piece.pointsNear(local)) {
          const hit = tryPoint(toPhys(p));
          if (hit !== null) return hit;
        }
        // The part of a normal segment inside the cell (Liang–Barsky), at its midpoint.
        const cellPoly = this.boxPoly(box, arcs);
        for (const [u, v] of piece.normalsNear(cellPoly)) {
          const [ax, ay] = toPhys(u);
          const [bx, by] = toPhys(v);
          let lo = 0;
          let hi = 1;
          const clip = (p0: number, d: number, min: number, max: number) => {
            if (d === 0) {
              if (p0 < min || p0 > max) hi = -1;
              return;
            }
            const t0 = (min - p0) / d;
            const t1 = (max - p0) / d;
            lo = Math.max(lo, Math.min(t0, t1));
            hi = Math.min(hi, Math.max(t0, t1));
          };
          clip(ax, bx - ax, box.x0, box.x1);
          clip(ay, by - ay, box.y0, box.y1);
          if (!(lo <= hi)) continue;
          for (const w of [0.5, 0.25, 0.75]) {
            const t = lo + w * (hi - lo);
            const hit = tryPoint([ax + t * (bx - ax), ay + t * (by - ay)]);
            if (hit !== null) return hit;
          }
        }
      } else if (piece instanceof DiskPiece) {
        const [cx, cy] = toPhys(piece.centerApprox);
        const x = Math.min(box.x1, Math.max(box.x0, cx));
        const y = Math.min(box.y1, Math.max(box.y0, cy));
        const hit = tryPoint([x + (cx - x) * 1e-3, y + (cy - y) * 1e-3]);
        if (hit !== null) return hit;
      }
    }
    return null;
  }
  /** The cell of the given size containing (x, y), built on demand; null outside the root. */
  cellAt(x: number, y: number, size: number): CoverNode | null;
  /** Without `build`, undefined where the cell is not in the cover yet (E3-U2e). */
  cellAt(x: number, y: number, size: number, build: false): CoverNode | null | undefined;
  cellAt(x: number, y: number, size: number, build = true): CoverNode | null | undefined {
    charge(W_CELL, 1);
    let n = this.root;
    if (x < n.box.x0 || x >= n.box.x1 || y < n.box.y0 || y >= n.box.y1) return null;
    while (n.box.x1 - n.box.x0 > size && n.cls === 0) {
      if (!build && n.kids === null) return undefined;
      this.children(n);
      const k = (n.kids ?? []).find(
        (c) => x >= c.box.x0 && x < c.box.x1 && y >= c.box.y0 && y < c.box.y1,
      );
      if (k === undefined) return n;
      n = k;
    }
    return n;
  }
  /** The undecided children of an undecided node (uniform children carry no ∂R inside). */
  children(n: CoverNode): CoverNode[] {
    if (n.cls !== 0) return [];
    if (n.kids === null) {
      const { x0, y0, x1, y1 } = n.box;
      const xm = (x0 + x1) / 2;
      const ym = (y0 + y1) / 2;
      if (!(xm > x0 && xm < x1 && ym > y0 && ym < y1)) return [];
      n.kids = [
        this.node({ x0, y0, x1: xm, y1: ym }, n),
        this.node({ x0: xm, y0, x1, y1: ym }, n),
        this.node({ x0, y0: ym, x1: xm, y1 }, n),
        this.node({ x0: xm, y0: ym, x1, y1 }, n),
      ];
    }
    return n.kids.filter((k) => k.cls === 0);
  }
  contains(p: QP): boolean {
    if (this.frame.singular) return false;
    return this.region.containsLocal(phiInv(this.frame, p));
  }
  private rootElements(): RElement[] {
    return this.root.cls === 0 ? [new CellElement(this.root, this)] : [];
  }
  dist(p: IvP, tol: number): Iv {
    const res = nearestBounds(this.rootElements(), p, tol, this.work);
    return { lo: Math.min(res.lo, depthInside(p, this.root.box)), hi: res.hi };
  }
  supUpper(gens: readonly IvP[], tol: number, hooks: A04Hooks): number {
    const box = boxOfIvPoints(gens);
    const c = centerOf(box);
    // The smallest witnessed cover cell that holds the whole box bounds the supremum without a
    // search when it is no larger than four times the box (the G quadtree's cells are cover cells).
    const size = Math.max(box.x1 - box.x0, box.y1 - box.y0);
    let n: CoverNode = this.root;
    let local: CoverNode | null = null;
    const holds = (b: Box) => b.x0 <= box.x0 && b.y0 <= box.y0 && b.x1 >= box.x1 && b.y1 >= box.y1;
    if (size > 0 && holds(n.box))
      for (;;) {
        if (n.witness !== null) local = n;
        if (n.cls !== 0 || n.box.x1 - n.box.x0 <= size) break;
        this.children(n);
        const k = (n.kids ?? []).find((q) => holds(q.box));
        if (k === undefined) break;
        n = k;
      }
    if (local !== null && local.box.x1 - local.box.x0 <= 4 * size)
      return new CellElement(local, this).supUpper(gens, c, hooks);
    const res = nearestBounds(this.rootElements(), c, tol, this.work);
    let best = Infinity;
    for (const e of res.certain) best = Math.min(best, e.supUpper(gens, c, hooks));
    return best;
  }
  windowElements(): RElement[] {
    return this.rootElements();
  }
  classifyBox(box: Box): 'in' | 'out' | 'mixed' {
    const cell = this.cellAt(box.x0, box.y0, box.x1 - box.x0);
    const same =
      cell !== null &&
      cell.box.x0 <= box.x0 &&
      cell.box.y0 <= box.y0 &&
      cell.box.x1 >= box.x1 &&
      cell.box.y1 >= box.y1;
    // A uniform cover cell holding the box decides it; an undecided cell of the same box too.
    if (same && (cell.cls !== 0 || cell.box.x1 - cell.box.x0 === box.x1 - box.x0))
      return cell.cls === 1 ? 'in' : cell.cls === -1 ? 'out' : 'mixed';
    const v = this.classifyPhys(box);
    return v === 1 ? 'in' : v === -1 ? 'out' : 'mixed';
  }
  omegaStatus(): 'none' | 'some' | 'unknown' {
    const omega = this.frame.omega;
    let unknown = false;
    const visit = (n: CoverNode): boolean => {
      if (!boxesMeet(n.box, omega) || n.cls !== 0) return false;
      const w = n.witness;
      if (w !== null && inOmega(this.frame, w.a) && inOmega(this.frame, w.b)) return true;
      if (boxDiam(n.box) <= 2 ** -6) {
        unknown = true;
        return false;
      }
      for (const k of this.children(n)) if (visit(k)) return true;
      return false;
    };
    if (visit(this.root)) return 'some';
    return unknown ? 'unknown' : 'none';
  }
}

// =============================================================================================
// 16. Hooks for the seeded defects of contract section 8.2 (applied only by unit tests)

export type A04IvPoint = Readonly<{ x: A04Interval; y: A04Interval }>;

/**
 * Test-only substitution points. The committed oracle never sets them; each seeded defect of
 * section 8.2 is a function written in the unit test and passed here.
 */
export type A04Hooks = Readonly<{
  /** E3-D1, E3-D2: how the three terms combine into E (default: the maximum). */
  combine?: (terms: Readonly<{ bR: A04Interval; bM: A04Interval; g: A04Interval }>) => A04Interval;
  /** E3-D3: the fill rule applied to an exact winding number. */
  fillRule?: (rule: A04FillRule, winding: number) => boolean;
  /**
   * E3-D4: exact membership of a node-local point in a cubic sweep. Since E3-U2c the controls,
   * the radius and the point are in the scaled local frame σ·y (σ = det L, see `makeFrame`): the
   * controls and the point are scaled by σ and the radius by |σ|, not the source's numbers.
   */
  sweepContains?: (
    sweep: Readonly<{
      controls: readonly (readonly [number, number])[];
      radius: number;
      point: readonly [number, number];
    }>,
    exact: () => boolean,
  ) => boolean;
  /** E3-D5: drops stroke pieces by role (for example `cusp-disk`). */
  dropStrokePiece?: (role: string) => boolean;
  /** E3-D6: the upper bound of sup over a cell of a convex distance (default: max over gens). */
  cellSupUpper?: (
    gens: readonly A04IvPoint[],
    center: A04IvPoint,
    dist: (g: A04IvPoint) => number,
  ) => number;
  /** E3-D9 (E3-U3): the window Ω (default: the viewport plus 2 physical px, E3-K3). */
  window?: (
    omega: Readonly<{ x0: number; y0: number; x1: number; y1: number }>,
  ) => Readonly<{ x0: number; y0: number; x1: number; y1: number }>;
  /** E3-D8: the zoom the ideal map uses (default: the binary64 zoom). */
  idealZoom?: (zoom: number) => number;
  /** E3-D11: whether ∂M extraction splits edges at T-vertices (default true). */
  splitAtTVertices?: boolean;
  /** E3-D12: filters the crossings of the fill arrangement. */
  crossings?: (crossings: readonly A04Crossing[]) => readonly A04Crossing[];
  /** E3-D13: returns false to skip a G quadtree leaf. */
  gLeaf?: (leaf: Readonly<{ boundaryFree: boolean }>) => boolean;
}>;

// =============================================================================================
// 17. Certified branch-and-bound for B_R, B_M and G (contract section 4.2)

type Bnb = Readonly<{ tol: number; floor: number; threshold: number; stopAbove: number }>;

function boxCorners(b: Box): IvP[] {
  return [ivpc(b.x0, b.y0), ivpc(b.x1, b.y0), ivpc(b.x1, b.y1), ivpc(b.x0, b.y1)];
}

/** B_R = sup over ∂R ∩ Ω⊕1 of dist(·, ∂M). */
function supBR(
  R: RegionTarget,
  M: MeshTarget,
  f: Frame,
  opt: Bnb,
  work: Work,
  hooks: A04Hooks,
): Iv {
  const heap = new Heap<RElement>();
  let lo = 0;
  let finalHi = 0;
  const consider = (e: RElement) => {
    if (!boxMeetsW1(f, e.box)) return;
    lo = Math.max(lo, e.brLower(M, f));
    heap.push(M.supUpper(e.gens, hooks), e);
  };
  for (const e of R.windowElements()) consider(e);
  while (heap.size > 0) {
    if (heap.peekKey() <= Math.max(lo, opt.threshold) + opt.tol || lo > opt.stopAbove) break;
    const top = heap.pop()!;
    spend(work, 1, 'B_R');
    if (top.value.size <= opt.floor / 4) {
      finalHi = Math.max(finalHi, top.key);
      continue;
    }
    for (const k of top.value.split() ?? []) consider(k);
  }
  return { lo, hi: Math.max(lo, heap.peekKey(), finalHi) };
}

type MCell = Readonly<{ a: QP; b: QP; gens: readonly IvP[]; size: number }>;

function mcell(a: QP, b: QP): MCell {
  const gens = [qpIv(a), qpIv(b)];
  return { a, b, gens, size: boxDiam(boxOfIvPoints(gens)) };
}

/** B_M = sup over ∂M ∩ Ω⊕1 of dist(·, ∂R). */
function supBM(
  R: RegionTarget,
  M: MeshTarget,
  f: Frame,
  opt: Bnb,
  work: Work,
  hooks: A04Hooks,
): Iv {
  const heap = new Heap<MCell>();
  let lo = 0;
  let finalHi = 0;
  // A child cell's end points were sampled with its parent, so only its midpoint is new.
  const consider = (c: MCell, ends: boolean) => {
    if (!boxMeetsW1(f, boxOfIvPoints(c.gens))) return;
    for (const p of ends ? [c.a, c.b, qmidp(c.a, c.b)] : [qmidp(c.a, c.b)])
      if (inW1(f, p)) lo = Math.max(lo, R.dist(qpIv(p), Math.max(opt.tol, c.size / 8)).lo);
    heap.push(R.supUpper(c.gens, Math.max(opt.tol, c.size / 4), hooks), c);
  };
  for (const s of M.segments) consider(mcell(s.a, s.b), true);
  while (heap.size > 0) {
    if (heap.peekKey() <= Math.max(lo, opt.threshold) + opt.tol || lo > opt.stopAbove) break;
    const top = heap.pop()!;
    spend(work, 1, 'B_M');
    if (top.value.size <= opt.floor / 4) {
      finalHi = Math.max(finalHi, top.key);
      continue;
    }
    const m = qmidp(top.value.a, top.value.b);
    consider(mcell(top.value.a, m), false);
    consider(mcell(m, top.value.b), false);
  }
  return { lo, hi: Math.max(lo, heap.peekKey(), finalHi) };
}

/** Exact membership, or null when the point sits where the closure cannot be decided. */
function tryContains(R: RegionTarget, p: QP): boolean | null {
  try {
    return R.contains(p);
  } catch (error) {
    if (error instanceof A04UnsupportedError) return null;
    throw error;
  }
}

/**
 * The agreement certificate for a G cell (fills): when every ∂R and ∂M piece that can meet the
 * cell lies on one exact line, M and R are constant on each side, and one corner per side
 * decides whether they agree there.
 */
function stripAgrees(R: FillTarget, mesh: MeshModel, box: Box): boolean {
  const els = R.elementsMeeting(box);
  const lines: [QP, QP][] = [];
  for (const e of els) {
    if (!(e instanceof SegElement) || !e.certain) return false;
    lines.push([e.a, e.b]);
  }
  mesh.segIndex?.visit(box, (s) => {
    if (segmentMayMeetBox(s.ia, s.ib, box)) lines.push([s.a, s.b]);
  });
  if (lines.length === 0) return false;
  const [a, b] = lines[0]!;
  for (const [p, q] of lines) if (orient(a, b, p) !== 0 || orient(a, b, q) !== 0) return false;
  const corners = [
    qpn(box.x0, box.y0),
    qpn(box.x1, box.y0),
    qpn(box.x1, box.y1),
    qpn(box.x0, box.y1),
  ];
  const plus = corners.find((p) => orient(a, b, p) > 0);
  const minus = corners.find((p) => orient(a, b, p) < 0);
  if (plus === undefined || minus === undefined) return false;
  for (const p of [plus, minus]) {
    const r = tryContains(R, p);
    if (r === null || r !== meshContains(mesh, p)) return false;
  }
  return true;
}

/** G = sup over (M △ R) ∩ Ω⊕1 of dist(·, ∂R), by a certified quadtree (obligation (f)). */
function supG(
  R: RegionTarget,
  mesh: MeshModel,
  f: Frame,
  opt: Bnb,
  work: Work,
  hooks: A04Hooks,
): Iv {
  const heap = new Heap<Box>();
  let lo = 0;
  let finalHi = 0;
  const lowerAt = (p: QP, size: number) => {
    if (inW1(f, p)) lo = Math.max(lo, R.dist(qpIv(p), Math.max(opt.tol, size / 8)).lo);
  };
  const process = (box: Box) => {
    spend(work, 1, 'G');
    if (!boxMeetsW1(f, box)) return;
    const mMixed = meshBoundaryMayMeet(mesh, box);
    const rc = R.classifyBox(box);
    const boundaryFree = !mMixed && rc !== 'mixed';
    if (hooks.gLeaf !== undefined && !hooks.gLeaf({ boundaryFree })) return;
    const center = boxCenterQ(box);
    if (boundaryFree) {
      const mIn = meshContains(mesh, center);
      if (mIn === (rc === 'in')) return;
      lowerAt(center, boxDiam(box));
      heap.push(R.supUpper(boxCorners(box), Math.max(opt.tol, boxDiam(box) / 4), hooks), box);
      return;
    }
    if (R instanceof FillTarget && stripAgrees(R, mesh, box)) return;
    const r = tryContains(R, center);
    if (r !== null && r !== meshContains(mesh, center)) lowerAt(center, boxDiam(box));
    heap.push(R.supUpper(boxCorners(box), Math.max(opt.tol, boxDiam(box) / 4), hooks), box);
  };
  // Strokes start from the cover's root, so G cells coincide with cover cells and reuse them.
  process(R instanceof StrokeTarget ? R.root.box : f.w1Box);
  while (heap.size > 0) {
    if (heap.peekKey() <= Math.max(lo, opt.threshold) + opt.tol || lo > opt.stopAbove) break;
    const top = heap.pop()!;
    const b = top.value;
    if (boxDiam(b) <= opt.floor / 2) {
      finalHi = Math.max(finalHi, top.key);
      continue;
    }
    const xm = (b.x0 + b.x1) / 2;
    const ym = (b.y0 + b.y1) / 2;
    process({ x0: b.x0, y0: b.y0, x1: xm, y1: ym });
    process({ x0: xm, y0: b.y0, x1: b.x1, y1: ym });
    process({ x0: b.x0, y0: ym, x1: xm, y1: b.y1 });
    process({ x0: xm, y0: ym, x1: b.x1, y1: b.y1 });
  }
  return { lo, hi: Math.max(lo, heap.peekKey(), finalHi) };
}

// =============================================================================================
// 18. The per-case measurement (contract sections 3 and 4) and its parameters

/** The oracle's fixed parameters, recorded in the section 14 annex. */
export const A04_ORACLE_PARAMETERS = Object.freeze({
  /** Default resolution target r_m (px), section 4.3. */
  resolution: 2 ** -10,
  /** Resolution floor (px), section 4.3. */
  floor: 2 ** -20,
  /** Crossing isolation size (px) of the fill arrangement. */
  bitSize: BIT_SIZE,
  /** Margin beyond Ω ⊕ 1 within which ∂R is resolved (px). */
  margin: INDEX_MARGIN,
  /** Work cap per case at measurement time (units). */
  measureWorkCap: 7_200_000_000,
  /** Work cap per case at the freeze check (units). */
  freezeWorkCap: 1_800_000_000,
  /** Freeze-check cell size for the stroke cover (px). */
  freezeCellSize: 2 ** -4,
  /** Extra levels below the freeze cell size in which an undecided cell must resolve. */
  freezeExtraLevels: 12,
  /** The A04 target (px). */
  target: 0.25,
});

export type A04Status = 'window-empty' | 'pass' | 'fail' | 'undecided' | 'not-drawable';

export type A04Measurement = Readonly<{
  id: string;
  paint: 'fill' | 'stroke';
  status: A04Status;
  reason: string | null;
  /** Certified intervals, physical px; null when not measured. */
  e: A04Interval | null;
  bR: A04Interval | null;
  bM: A04Interval | null;
  g: A04Interval | null;
  /** The final resolution r_m reached. */
  resolution: number;
  /** T-vertex incidences of the drawn mesh (E3-K2). */
  tJunctions: number;
  /** ∂M sub-edges after T-vertex splitting. */
  boundaryEdges: number;
  /** The window-point classification of E3-K3 when the window-empty check ran. */
  windowPoint: Readonly<{ r: boolean; m: boolean }> | null;
  work: number;
}>;

export type A04MeasureOptions = Readonly<{
  resolution?: number;
  floor?: number;
  /** PASS when E_hi ≤ passBelow (the harness passes 0.25 − β_c). */
  passBelow?: number;
  /** FAIL when E_lo > failAbove (the harness passes 0.25 + β_c). */
  failAbove?: number;
  workCap?: number;
  hooks?: A04Hooks;
  /** Refine each term to the resolution on its own, without pruning by the others. */
  separateTerms?: boolean;
  /** Diagnostic: compute only these terms; the others are reported as [0, +∞). */
  onlyTerms?: readonly ('bR' | 'bM' | 'g')[];
  /** The case's β_c (from the harness), for the reported crack bound. */
  betaC?: number;
  /**
   * The Float64 port mesh that `M*` was mapped from, with the same indices (E3-K2). Its
   * T-junctions, which `a04StorageCracks` finds, count towards the crack bound too (review S7 of
   * PR #212): a port T-vertex that leaves its edge in `M*` is no T-junction of `M*`.
   */
  portMesh?: A04Mesh;
}>;

function regionTarget(c: Decoded, f: Frame, hooks: A04Hooks, work: Work): RegionTarget {
  if (c.paint.kind === 'fill') {
    const fill = makeFillRegion(c, f, hooks);
    const inside = (w: number) =>
      hooks.fillRule === undefined
        ? fill.rule === 'nonzero'
          ? w !== 0
          : w % 2 !== 0
        : hooks.fillRule(fill.rule, w);
    const arrangement = buildArrangement(fill.curves, indexRegion(f), inside, hooks, work);
    return new FillTarget(fill, arrangement, f, work);
  }
  return new StrokeTarget(makeStrokeRegion(c, hooks, f.sigma), f, work);
}

function notDrawable(c: Decoded, f: Frame): string | null {
  if (f.singular) return 'det L = 0';
  if (c.paint.kind === 'stroke' && c.paint.width === 0) return 'w = 0';
  return null;
}

/** One point of Ω (its center, or a nearby sample when the center is undecidable). */
function windowPoint(R: RegionTarget, f: Frame): { p: QP; r: boolean } | null {
  for (const p of boxSamples({ x0: 0, y0: 0, x1: f.width, y1: f.height })) {
    const r = tryContains(R, p);
    if (r !== null) return { p, r };
  }
  return null;
}

/**
 * Measures E(M*, R) on Ω ⊕ 1 for one case and one drawn mesh (contract sections 3.2 to 3.4,
 * 4.2 and 4.3). The result is a certified interval [E_lo, E_hi], refined from the default
 * resolution down to the floor while it straddles the decision thresholds.
 */
export function a04Measure(
  input: A04Case,
  meshInput: A04Mesh,
  options: A04MeasureOptions = {},
): A04Measurement &
  Readonly<{
    crackBound: number | null;
    storage: Readonly<{ tJunctions: number; storageCracks: number }> | null;
  }> {
  const mesh: MeshState = { complete: false, storage: null };
  const m = measureCase(input, meshInput, options, mesh);
  // E3-Q10 (b): a T-junction can open a crack up to about 2β_c wide on the GPU; it is reported
  // here and judged by A01, not scored by A04. The port mesh's T-junctions count as well, so a
  // storage crack (a port T-vertex off its edge in M*) keeps the bound. A mesh that was not
  // fully built and checked (a work cap hit before) has no bound: it is null, never 0.
  const junctions = m.tJunctions + (mesh.storage?.tJunctions ?? 0);
  const crackBound =
    options.betaC === undefined || !mesh.complete
      ? null
      : junctions > 0
        ? up(2 * options.betaC)
        : 0;
  return { ...m, crackBound, storage: mesh.storage };
}

/** Set by `measureCase`: whether the mesh (and the port mesh, if given) was fully processed. */
type MeshState = {
  complete: boolean;
  storage: Readonly<{ tJunctions: number; storageCracks: number }> | null;
};

function measureCase(
  input: A04Case,
  meshInput: A04Mesh,
  options: A04MeasureOptions,
  state: MeshState,
): A04Measurement {
  const hooks = options.hooks ?? {};
  const c = decodeCase(input);
  const f = makeFrame(c, hooks);
  const base = {
    id: c.id,
    paint: c.paint.kind,
    e: null,
    bR: null,
    bM: null,
    g: null,
    tJunctions: 0,
    boundaryEdges: 0,
    windowPoint: null,
  } as const;
  const skip = notDrawable(c, f);
  if (skip !== null)
    return { ...base, status: 'not-drawable', reason: skip, resolution: 0, work: 0 };
  const work = newWork(options.workCap ?? A04_ORACLE_PARAMETERS.measureWorkCap);
  const passBelow = options.passBelow ?? A04_ORACLE_PARAMETERS.target;
  const failAbove = options.failAbove ?? A04_ORACLE_PARAMETERS.target;
  const floor = options.floor ?? A04_ORACLE_PARAMETERS.floor;
  let tol = options.resolution ?? A04_ORACLE_PARAMETERS.resolution;
  let mesh: MeshModel = EMPTY_MESH;
  const previousWork = activeWork;
  activeWork = work;
  try {
    const R = regionTarget(c, f, hooks, work);
    mesh = buildMesh(meshInput, hooks);
    // Inside the active work, so the storage-crack check is charged and capped too.
    if (options.portMesh !== undefined)
      state.storage = a04StorageCracks(options.portMesh, meshInput);
    state.complete = true;
    const M = new MeshTarget(mesh);
    const meshInfo = { tJunctions: mesh.tJunctions, boundaryEdges: mesh.boundary.length };
    if (mesh.invalid !== null)
      return {
        ...base,
        ...meshInfo,
        status: 'undecided',
        reason: `invalid mesh: ${mesh.invalid}`,
        resolution: tol,
        work: work.units,
      };
    let wp: { r: boolean; m: boolean } | null = null;
    if (R.omegaStatus() === 'none' && !meshBoundaryMayMeet(mesh, f.omega)) {
      const point = windowPoint(R, f);
      if (point === null) throw new A04UnsupportedError('no decidable window point');
      wp = { r: point.r, m: meshContains(mesh, point.p) };
      if (wp.r === wp.m)
        return {
          ...base,
          ...meshInfo,
          status: 'window-empty',
          reason: null,
          windowPoint: wp,
          resolution: tol,
          work: work.units,
        };
    }
    for (;;) {
      const free: Bnb = {
        tol,
        floor,
        threshold: -Infinity,
        stopAbove: options.separateTerms ? Infinity : failAbove,
      };
      // Early exit (section 4.2): once a term's lower bound exceeds failAbove the case is a certain
      // FAIL, and the remaining terms are reported as [0, +∞) unless terms are requested apart.
      const separate = options.separateTerms === true;
      const open: Iv = { lo: 0, hi: Infinity };
      const bM =
        options.onlyTerms === undefined || options.onlyTerms.includes('bM')
          ? supBM(R, M, f, free, work, hooks)
          : { lo: 0, hi: Infinity };
      const want = (t: 'bR' | 'bM' | 'g') =>
        options.onlyTerms === undefined || options.onlyTerms.includes(t);
      const bR =
        want('bR') && (separate || bM.lo <= failAbove)
          ? supBR(R, M, f, separate ? free : { ...free, threshold: bM.lo }, work, hooks)
          : open;
      const g =
        want('g') && (separate || Math.max(bM.lo, bR.lo) <= failAbove)
          ? supG(
              R,
              mesh,
              f,
              separate ? free : { ...free, threshold: Math.max(bM.lo, bR.lo) },
              work,
              hooks,
            )
          : open;
      const e =
        hooks.combine === undefined
          ? { lo: Math.max(bR.lo, bM.lo, g.lo), hi: Math.max(bR.hi, bM.hi, g.hi) }
          : hooks.combine({ bR, bM, g });
      const result = { ...base, ...meshInfo, e, bR, bM, g, windowPoint: wp, resolution: tol };
      if (e.lo > failAbove) return { ...result, status: 'fail', reason: null, work: work.units };
      if (options.onlyTerms !== undefined)
        return { ...result, status: 'undecided', reason: 'some terms only', work: work.units };
      if (e.hi <= passBelow) return { ...result, status: 'pass', reason: null, work: work.units };
      if (tol <= floor)
        return {
          ...result,
          status: 'undecided',
          reason: 'straddles at the floor',
          work: work.units,
        };
      tol = Math.max(floor, tol / 2);
    }
  } catch (error) {
    const info = { tJunctions: mesh.tJunctions, boundaryEdges: mesh.boundary.length };
    if (error instanceof A04WorkLimitError)
      return {
        ...base,
        ...info,
        status: 'undecided',
        reason: `work cap: ${error.where}`,
        resolution: tol,
        work: work.units,
      };
    if (error instanceof A04UnsupportedError)
      return {
        ...base,
        ...info,
        status: 'undecided',
        reason: `unsupported: ${error.reason}`,
        resolution: tol,
        work: work.units,
      };
    throw error;
  } finally {
    activeWork = previousWork;
  }
}

// =============================================================================================
// 19. The oracle-only freeze check (contract section 5.5, E3-Q6 (a))

export type A04FreezeStatus =
  'ok' | 'not-drawable' | 'ORACLE-WORK' | 'ORACLE-UNSUPPORTED' | 'ORACLE-INCONSISTENT';

export type A04FreezeResult = Readonly<{
  id: string;
  paint: 'fill' | 'stroke';
  status: A04FreezeStatus;
  detail: string | null;
  /** Boundary elements (fill) or cover cells (stroke) built. */
  elements: number;
  /** ∂R ∩ Ω: 'none', 'some' or 'unknown' (an unknown window is measured, never skipped). */
  window: 'none' | 'some' | 'unknown' | null;
  /** Weighted work (nominal microseconds, contract section 14.7). */
  work: number;
  /** Unweighted counts per work kind (absent for a case that was not drawable). */
  workByKind?: Readonly<Record<string, number>>;
}>;

export type A04FreezeOptions = Readonly<{
  workCap?: number;
  cellSize?: number;
  extraLevels?: number;
}>;

/**
 * Certifies that the oracle can build the ideal boundary of one case within its work cap,
 * before any kernel run. Fills: the arrangement of ∂R within Ω ⊕ 1 plus the margin is complete,
 * and every crossing bit there is classified or adjacent to certain boundary. Strokes: every
 * undecided cover cell of ∂R ∩ Ω ⊕ 1 at the freeze cell size holds certain witnesses, or
 * resolves within the extra levels. Both: exact membership decides a window point, and (strokes)
 * sampled cell classes and witnesses agree with exact membership.
 */
export function a04FreezeCheck(input: A04Case, options: A04FreezeOptions = {}): A04FreezeResult {
  const c = decodeCase(input);
  const f = makeFrame(c, {});
  const base = { id: c.id, paint: c.paint.kind } as const;
  const skip = notDrawable(c, f);
  if (skip !== null)
    return { ...base, status: 'not-drawable', detail: skip, elements: 0, window: null, work: 0 };
  const work = newWork(options.workCap ?? A04_ORACLE_PARAMETERS.freezeWorkCap);
  const cellSize = options.cellSize ?? A04_ORACLE_PARAMETERS.freezeCellSize;
  const extra = options.extraLevels ?? A04_ORACLE_PARAMETERS.freezeExtraLevels;
  let elements = 0;
  const previousWork = activeWork;
  activeWork = work;
  try {
    const R = regionTarget(c, f, {}, work);
    let detail: string | null = null;
    let status: A04FreezeStatus = 'ok';
    if (R instanceof FillTarget) {
      elements = R.elements.length;
      for (const p of R.arrangement.portions) {
        if (p.bitClass !== 'unknown') continue;
        const e =
          p.curve.kind === 'line'
            ? new SegElement(
                qplerp(p.curve.a, p.curve.b, p.u0),
                qplerp(p.curve.a, p.curve.b, p.u1),
                false,
              )
            : new ArcElement(subCubic(p.curve.p, p.u0, p.u1), false);
        if (boxMeetsW1(f, e.box)) {
          status = 'ORACLE-WORK';
          detail = `unclassified crossing near (${e.box.x0}, ${e.box.y0})`;
          break;
        }
      }
    } else if (R instanceof StrokeTarget) {
      let checks = 0;
      const verify = (n: CoverNode): void => {
        if (checks >= 24) return;
        checks += 1;
        if (n.cls !== 0) {
          const inside = R.contains(boxCenterQ(n.box));
          if (inside !== (n.cls === 1))
            throw new InconsistentError(`cell class at (${n.box.x0}, ${n.box.y0})`);
        } else if (n.witness !== null) {
          if (!R.contains(n.witness.a) || R.contains(n.witness.b))
            throw new InconsistentError(`witness at (${n.box.x0}, ${n.box.y0})`);
        }
      };
      // An undecided cell without witnesses must resolve point-like: within `extra` levels its
      // undecided, unwitnessed descendants shrink to at most 16 cells (a cell that merely comes
      // within ε of ∂R). A seam-like or area-like set of such cells (a classification that does
      // not converge) fails the freeze.
      //
      // A cell is next to the boundary, and so harmless, when one of its eight neighbours at the
      // same size is witnessed, or is uniform of the other class than the cell's center: ∂R then
      // passes within one cell size, so distance bounds through it converge. Only cells with no
      // such neighbour count as suspicious (an internal seam would produce a line of them).
      const nearBoundary = (k: CoverNode): boolean => {
        const b = k.box;
        const w = b.x1 - b.x0;
        const xm = (b.x0 + b.x1) / 2;
        const ym = (b.y0 + b.y1) / 2;
        // The cheaper tests go first (E3-U2e): the neighbours already in the cover before those
        // that need new cells, the uniform ones before the witness searches, and the center's
        // class only for a uniform neighbour. The outcome is the same in any order.
        let inside: boolean | undefined;
        const undecided: CoverNode[] = [];
        const opposite = (m: CoverNode | null): boolean => {
          if (m === null) return false;
          if (m.cls === 0) {
            undecided.push(m);
            return false;
          }
          if (inside === undefined) {
            const fast = R.classifyPoint(xm, ym);
            inside = fast !== 0 ? fast === 1 : R.contains(qpn(xm, ym));
          }
          return (m.cls === 1) !== inside;
        };
        const later: [number, number][] = [];
        for (const dx of [-1, 0, 1])
          for (const dy of [-1, 0, 1]) {
            if (dx === 0 && dy === 0) continue;
            const x = b.x0 + w * (dx + 0.5);
            const y = b.y0 + w * (dy + 0.5);
            const m = R.cellAt(x, y, w, false);
            if (m === undefined) later.push([x, y]);
            else if (opposite(m)) return true;
          }
        for (const [x, y] of later) if (opposite(R.cellAt(x, y, w) ?? null)) return true;
        return undecided.some((m) => m.witness !== null);
      };
      const resolves = (n: CoverNode, levels: number): boolean => {
        let current = n.witness === null ? [n] : [];
        for (let level = 0; level < levels && current.length > 0; level += 1) {
          const next: CoverNode[] = [];
          for (const c of current)
            for (const k of R.children(c))
              if (boxMeetsW1(f, k.box) && k.witness === null) next.push(k);
          const suspicious = next.length > 8 ? next.filter((k) => !nearBoundary(k)) : next;
          if (suspicious.length > 4096) return false;
          current = suspicious;
        }
        return current.length <= 16;
      };
      let uniformSeen = 0;
      const visit = (n: CoverNode): void => {
        if (status !== 'ok' || !boxMeetsW1(f, n.box)) return;
        if (n.cls !== 0) {
          uniformSeen += 1;
          if (uniformSeen % 7 === 1) verify(n);
          return;
        }
        if (n.box.x1 - n.box.x0 <= cellSize) {
          if (n.witness !== null) verify(n);
          if (!resolves(n, extra)) {
            status = 'ORACLE-WORK';
            detail = `unresolved cover cell at (${n.box.x0}, ${n.box.y0}), size ${n.box.x1 - n.box.x0}`;
          }
          return;
        }
        R.children(n);
        for (const k of n.kids ?? []) visit(k);
      };
      visit(R.root);
      elements = R.nodes;
    }
    const window = R.omegaStatus();
    if (status === 'ok' && windowPoint(R, f) === null) {
      status = 'ORACLE-UNSUPPORTED';
      detail = 'no decidable window point';
    }
    return {
      ...base,
      status,
      detail,
      elements,
      window,
      work: work.units,
      workByKind: workByKind(work),
    };
  } catch (error) {
    if (error instanceof A04WorkLimitError)
      return {
        ...base,
        status: 'ORACLE-WORK',
        detail: error.where,
        elements,
        window: null,
        work: work.units,
        workByKind: workByKind(work),
      };
    if (error instanceof A04UnsupportedError)
      return {
        ...base,
        status: 'ORACLE-UNSUPPORTED',
        detail: error.reason,
        elements,
        window: null,
        work: work.units,
        workByKind: workByKind(work),
      };
    if (error instanceof InconsistentError)
      return {
        ...base,
        status: 'ORACLE-INCONSISTENT',
        detail: error.message,
        elements,
        window: null,
        work: work.units,
        workByKind: workByKind(work),
      };
    throw error;
  } finally {
    activeWork = previousWork;
  }
}

class InconsistentError extends Error {}

// =============================================================================================
// 20. Inspection helpers for the paired tests

/** Exact membership of a physical point in the ideal region R (closed). */
export function a04Contains(input: A04Case, point: readonly [A04Scalar, A04Scalar]): boolean {
  const c = decodeCase(input);
  const f = makeFrame(c, {});
  const work = newWork(A04_ORACLE_PARAMETERS.measureWorkCap);
  const p = qp(scalarQ(point[0]), scalarQ(point[1]));
  if (c.paint.kind === 'fill') return makeFillRegion(c, f, {}).contains(p);
  return new StrokeTarget(makeStrokeRegion(c, {}, f.sigma), f, work).contains(p);
}

/** Exact membership with hooks (seeded-defect tests). */
export function a04ContainsWith(
  input: A04Case,
  point: readonly [A04Scalar, A04Scalar],
  hooks: A04Hooks,
): boolean {
  const c = decodeCase(input);
  const f = makeFrame(c, hooks);
  const p = qp(scalarQ(point[0]), scalarQ(point[1]));
  if (c.paint.kind === 'fill') return makeFillRegion(c, f, hooks).contains(p);
  const region = makeStrokeRegion(c, hooks, f.sigma);
  return region.containsLocal(phiInv(f, p));
}

/** The fill arrangement's portions within Ω ⊕ 1 plus the margin (obligations (c), (d)). */
export function a04FillPortions(input: A04Case, hooks: A04Hooks = {}): A04Portion[] {
  const c = decodeCase(input);
  const f = makeFrame(c, hooks);
  const work = newWork(A04_ORACLE_PARAMETERS.measureWorkCap);
  const t = regionTarget(c, f, hooks, work);
  if (!(t instanceof FillTarget)) oracleError('not a fill case');
  return t.arrangement.portions.map((p) => {
    const curve = p.curve;
    const at = (u: Q): QP =>
      curve.kind === 'line' ? qplerp(curve.a, curve.b, u) : cubicAt(curve.p, u);
    const s = at(p.u0);
    const e = at(p.u1);
    return {
      curve: curve.index,
      kind: curve.kind,
      u0: qapprox(p.u0),
      u1: qapprox(p.u1),
      certain: p.certain,
      boundary: p.bitClass === null ? p.boundary : null,
      bitClass: p.bitClass,
      start: [qapprox(s.x), qapprox(s.y)],
      end: [qapprox(e.x), qapprox(e.y)],
    };
  });
}

/** Certified bounds on dist(p, ∂R) for a physical point (refined towards `tol`). */
export function a04BoundaryDistance(
  input: A04Case,
  point: readonly [number, number],
  tol: number,
): A04Interval {
  const c = decodeCase(input);
  const f = makeFrame(c, {});
  const work = newWork(A04_ORACLE_PARAMETERS.measureWorkCap);
  return regionTarget(c, f, {}, work).dist(ivpc(point[0], point[1]), tol);
}

// =============================================================================================
// 21. Self-tests of the E3-U2c exact steps (tests only, review of PR #216)

/** A deterministic generator of floats in [0, 1) for the self-tests (mulberry32). */
function selfTestRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The rational clip of E3-U2b (`clipExact`), kept as the reference of `a04ClipSelfTest`. */
function clipRational(poly: readonly QP[], g: (y: QP) => Q): QP[] {
  const out: QP[] = [];
  const v = poly.map(g);
  for (let i = 0; i < poly.length; i += 1) {
    const j = (i + 1) % poly.length;
    const si = qsgn(v[i]!);
    const sj = qsgn(v[j]!);
    if (si >= 0) out.push(poly[i]!);
    if (si * sj < 0) out.push(qplerp(poly[i]!, poly[j]!, qdiv(v[i]!, qsub(v[i]!, v[j]!))));
  }
  return out;
}

const zDot = (g: ZLine, v: ZVert): bigint => g[0] * v.X + g[1] * v.Y + g[2] * v.W;
const zSameLine = (a: ZLine, b: ZLine): boolean =>
  a[1] * b[2] === a[2] * b[1] && a[2] * b[0] === a[0] * b[2] && a[0] * b[1] === a[1] * b[0];

/**
 * Randomized equivalence of the integer clip `zClip` (with `zPolygon`) against the rational clip
 * of E3-U2b and its area test, over chains of 3 to 8 clips of convex lattice polygons. Most
 * clip lines pass exactly through one or two vertices of the current polygon. Per step: the
 * same nullness (zero area), the same vertex set, and every vertex on its two lines with each
 * outgoing line the next vertex's incoming line. The first chain is the review's repro.
 */
export function a04ClipSelfTest(seed: number, count: number): string[] {
  const rnd = selfTestRandom(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const findings: string[] = [];
  const keys = (ps: readonly QP[]): string =>
    [...new Set(ps.map(qpkey))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(' ');
  const hull = (pts: readonly [number, number][]): QP[] => {
    const s = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list: [number, number][]) => {
      const h: [number, number][] = [];
      for (const p of list) {
        while (h.length >= 2 && cross(h[h.length - 2]!, h[h.length - 1]!, p) <= 0) h.pop();
        h.push(p);
      }
      h.pop();
      return h;
    };
    return [...half(s), ...half([...s].reverse())].map(([x, y]) => qp(qi(x), qi(y)));
  };
  let chains = 0;
  for (let k = 0; chains < count; k += 1) {
    let start: QP[];
    let fixed: [Q, Q, Q][] | null = null;
    if (k === 0) {
      start = hull([
        [0, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ]);
      fixed = [
        [qi(-1), qi(-2), qi(4)],
        [qi(1), qi(1), qi(-3)],
        [qi(0), qi(2), qi(-1)],
      ];
    } else {
      const n = int(3, 8);
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i += 1) pts.push([int(-12, 12), int(-12, 12)]);
      start = hull(pts);
      if (start.length < 3 || qsgn(polygonArea2(start)) === 0) continue;
    }
    chains += 1;
    let ref: QP[] | null = start;
    let z: ZVert[] | null = zPolygon(start);
    if (z === null) {
      findings.push(`chain ${k}: zPolygon rejected a polygon of positive area`);
      continue;
    }
    const steps = fixed === null ? int(3, 8) : fixed.length;
    for (let step = 0; step < steps && ref !== null && z !== null; step += 1) {
      let line: [Q, Q, Q];
      const kind = int(0, 9);
      const nx = int(-6, 6);
      const ny = int(-6, 6) || 1;
      if (fixed !== null) line = fixed[step]!;
      else if (kind <= 2) line = [qi(nx), qi(ny), qi(int(-30, 30))];
      else if (kind <= 6) {
        // Through one vertex of the current polygon, exactly.
        const p = ref[int(0, ref.length - 1)]!;
        line = [qi(nx), qi(ny), qneg(qadd(qmul(qi(nx), p.x), qmul(qi(ny), p.y)))];
      } else {
        // Through two vertices: a diagonal or an edge line, in either orientation.
        const i = int(0, ref.length - 1);
        const j = (i + int(1, ref.length - 1)) % ref.length;
        const p = ref[i]!;
        const q = ref[j]!;
        const sgn = qi(int(0, 1) === 0 ? 1 : -1);
        line = [
          qmul(sgn, qsub(p.y, q.y)),
          qmul(sgn, qsub(q.x, p.x)),
          qmul(sgn, qsub(qmul(p.x, q.y), qmul(q.x, p.y))),
        ];
      }
      const [a, b, c] = line;
      if (a.n === 0n && b.n === 0n) continue;
      const label = `chain ${k} step ${step} (${qpkey(qp(a, b))} ${c.n}/${c.d})`;
      const r = clipRational(ref, (y) => qadd(qadd(qmul(a, y.x), qmul(b, y.y)), c));
      const refNext: QP[] | null = r.length >= 3 && qsgn(polygonArea2(r)) !== 0 ? r : null;
      const zNext = zClip(z, zLine(a, b, c));
      if ((refNext === null) !== (zNext === null)) {
        findings.push(
          `${label}: nullness differs (rational ${refNext === null ? 'null' : 'kept'})`,
        );
        break;
      }
      if (refNext !== null && zNext !== null) {
        const pts: QP[] = [];
        for (let i = 0; i < zNext.length; i += 1) {
          const v = zNext[i]!;
          const w = zNext[(i + 1) % zNext.length]!;
          if (v.W === 0n) findings.push(`${label}: vertex ${i} at infinity`);
          if (zDot(v.inLine, v) !== 0n || zDot(v.outLine, v) !== 0n)
            findings.push(`${label}: vertex ${i} is not on its lines`);
          if (!zSameLine(v.outLine, w.inLine))
            findings.push(`${label}: vertex ${i}'s outgoing line is not the next incoming line`);
          if (v.W !== 0n) pts.push(qp(qmk(v.X, v.W), qmk(v.Y, v.W)));
        }
        if (keys(pts) !== keys(refNext))
          findings.push(`${label}: vertices ${keys(pts)} differ from ${keys(refNext)}`);
      }
      ref = refNext;
      z = zNext;
    }
  }
  return findings;
}

/** p(u0 + h·s) in the power basis of s, exactly. */
function composeAffine(a: readonly Q[], u0: Q, h: Q): Q[] {
  let acc: Q[] = [];
  for (let i = a.length - 1; i >= 0; i -= 1) acc = padd(pmul(acc, [u0, h]), [a[i]!]);
  return ptrim(acc);
}

/**
 * Enclosure of `powerToBernstein` and the outward-rounded `bernHalves`. For random exact
 * polynomials (degree up to 5, also degree-elevated): the Bernstein form maps back exactly to
 * the power form, and on each step of a random path of up to 24 halvings to a dyadic
 * sub-interval [u0, u1], every interval coefficient encloses the exact Bernstein coefficient of
 * p on it, and the hull of the intervals encloses exact values of p on it.
 */
export function a04BernsteinSelfTest(seed: number, count: number): string[] {
  const rnd = selfTestRandom(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const findings: string[] = [];
  const inIv = (i: Iv, v: Q): boolean =>
    (i.lo === -Infinity || qcmp(qnum(i.lo), v) <= 0) &&
    (i.hi === Infinity || qcmp(qnum(i.hi), v) >= 0);
  for (let k = 0; k < count; k += 1) {
    const d = int(0, 5);
    const a: Q[] = [];
    for (let i = 0; i <= d; i += 1)
      a.push(
        int(0, 2) === 0
          ? qmk(BigInt(int(-1000, 1000)), BigInt(int(1, 97)))
          : qnum((rnd() * 2 - 1) * 2 ** int(-30, 30)),
      );
    const n = Math.max(1, d + int(0, 1));
    const exact = powerToBernstein(a, n);
    const back = bernsteinToPower(exact);
    const want = ptrim(a);
    if (back.length !== want.length || back.some((c, i) => !qeq(c, want[i]!)))
      findings.push(`poly ${k}: the Bernstein form does not map back to the power form`);
    let b: Iv[] = exact.map(qIv);
    let u0 = Q0;
    let u1 = Q1;
    const depth = int(1, 24);
    for (let level = 0; level < depth; level += 1) {
      const [left, right] = bernHalves(b);
      const m = qmid(u0, u1);
      if (int(0, 1) === 0) {
        b = left;
        u1 = m;
      } else {
        b = right;
        u0 = m;
      }
      const sub = powerToBernstein(composeAffine(a, u0, qsub(u1, u0)), n);
      sub.forEach((c, i) => {
        if (!inIv(b[i]!, c))
          findings.push(`poly ${k} level ${level} coefficient ${i}: [${b[i]!.lo}, ${b[i]!.hi}]`);
      });
      let lo = Infinity;
      let hi = -Infinity;
      for (const c of b) {
        lo = Math.min(lo, c.lo);
        hi = Math.max(hi, c.hi);
      }
      for (const s of [Q0, qmk(1n, 3n), QHALF, qmk(5n, 7n), Q1]) {
        const v = peval(a, qadd(u0, qmul(qsub(u1, u0), s)));
        if (!inIv({ lo, hi }, v)) findings.push(`poly ${k} level ${level}: the hull misses p`);
      }
    }
  }
  return findings;
}

/** The floor of the square root of a non-negative BigInt. */
function isqrtB(v: bigint): bigint {
  if (v < 2n) return v;
  let x = 1n << BigInt((bitLen(v) >> 1) + 1);
  for (;;) {
    const y = (x + v / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * Sign agreement of `signAtRoot` (with its interval prefilter) and the exact gcd and Sturm test
 * alone (`signAtRootExact`), near zeros of h. The root is the irrational √k/m of m²t² − k (also
 * times a rational linear factor). Each h vanishes at the root or nearly: t − q for rationals q
 * within a few 2^−p/m of it (p up to 200), multiples of m²t² − k (zero), m²t² − k ± ε, and
 * products of these. Where the sign has a closed form, it is checked as well.
 */
export function a04SignAtRootSelfTest(seed: number, count: number): string[] {
  const rnd = selfTestRandom(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const findings: string[] = [];
  for (let k = 0; k < count; k += 1) {
    const m = BigInt(int(2, 60));
    let kk = BigInt(int(1, Number(m * m) - 1));
    while (isqrtB(kk) * isqrtB(kk) === kk) kk += 1n;
    if (kk >= m * m) kk = m * m - 1n;
    if (isqrtB(kk) * isqrtB(kk) === kk) continue;
    const quad: Q[] = [qi(-kk), Q0, qi(m * m)];
    const withLinear = int(0, 1) === 1;
    const s0 = withLinear ? pmul(quad, [qmk(-BigInt(int(1, 9)), 10n), Q1]) : quad;
    const { s, roots } = isolateRoots(s0, Q0, Q1);
    // The isolating interval of √k/m: m²t² − k changes sign across it (the other root is rational).
    const root = roots.find((r) => r.exact === null && psign(quad, r.lo) * psign(quad, r.hi) < 0);
    if (root === undefined) {
      findings.push(`case ${k}: the root √k/m was not isolated`);
      continue;
    }
    const p = int(4, 200);
    const scale = 1n << BigInt(p);
    // q = (⌊√k·2^p⌋ + j) / (m·2^p), within a few 2^−p/m of √k/m.
    const base = isqrtB(kk * scale * scale);
    const j = BigInt(int(-2, 3));
    const q = qmk(base + j, m * scale);
    const lin: Q[] = [qneg(q), Q1];
    const eps = qmk(BigInt(int(1, 5)) * (int(0, 1) === 0 ? 1n : -1n), scale);
    const choices: { h: Q[]; want: number | null }[] = [
      // For r, q > 0: r > q exactly when k > (q·m)².
      { h: lin, want: Math.sign(qcmp(qi(kk), qsq(qmul(q, qi(m))))) },
      { h: pmul(quad, [qmk(BigInt(int(1, 9)), 7n), Q1]), want: 0 },
      { h: padd(quad, [eps]), want: qsgn(eps) },
      { h: pmul(lin, padd(quad, [eps])), want: null },
      { h: pmul(lin, lin), want: 1 },
      { h: psub(pmul(lin, lin), [qmul(eps, eps)]), want: null },
    ];
    const pick = choices[int(0, choices.length - 1)]!;
    const copy = (r: Root): Root => ({ lo: r.lo, hi: r.hi, exact: r.exact });
    const fast = signAtRoot(pick.h, s, copy(root));
    const slow = signAtRootExact(fromZ(toZ(pick.h)), s, copy(root));
    if (fast !== slow) findings.push(`case ${k} (p ${p}): prefilter ${fast}, exact ${slow}`);
    if (pick.want !== null && slow !== pick.want)
      findings.push(`case ${k} (p ${p}): exact ${slow}, closed form ${pick.want}`);
  }
  return findings;
}

/**
 * Checks the pseudo-division of integer polynomials (E3-U2e): lc(b)^(deg a − deg b + 1)·a =
 * q·b + r with deg r < deg b, on sparse random polynomials, whose remainder can drop by more
 * than one degree in one step, and on x⁴ + x³ by x + 1, which left holes in the remainder before
 * E3-U2e (a TypeError on C9/k03 and C9/k04 at T7 in the freeze run of 2026-10-24).
 */
export function a04PseudoDivisionSelfTest(seed: number, count: number): string[] {
  const rnd = selfTestRandom(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const findings: string[] = [];
  const zmul = (a: readonly bigint[], b: readonly bigint[]): bigint[] => {
    const out: bigint[] = Array.from({ length: Math.max(0, a.length + b.length - 1) }, () => 0n);
    a.forEach((x, i) => b.forEach((y, j) => (out[i + j] = out[i + j]! + x * y)));
    return out;
  };
  const cases: [bigint[], bigint[]][] = [
    [
      [0n, 0n, 0n, 1n, 1n],
      [1n, 1n],
    ],
  ];
  for (let k = 0; k < count; k += 1) {
    const sparse = (n: number) =>
      Array.from({ length: n }, () => (int(0, 2) === 0 ? BigInt(int(-9, 9)) : 0n));
    const b = sparse(int(1, 4));
    b.push(BigInt(int(1, 9) * (int(0, 1) === 0 ? 1 : -1)));
    cases.push([sparse(int(2, 10)), b]);
  }
  cases.forEach(([a, b], k) => {
    const A = ztrim(a);
    const B = ztrim(b);
    let out: { q: ZPoly; r: ZPoly };
    try {
      out = zpdivmod(A, B);
    } catch (error) {
      findings.push(`case ${k}: ${String(error)}`);
      return;
    }
    if (A.length < B.length) return;
    const lead = B[B.length - 1]!;
    const left = A.map((c) => c * lead ** BigInt(A.length - B.length + 1));
    const right = zmul(out.q, B);
    out.r.forEach((c, i) => (right[i] = (right[i] ?? 0n) + c));
    const l = ztrim(left);
    const rr = ztrim(right);
    if (l.length !== rr.length || l.some((c, i) => c !== rr[i]))
      findings.push(`case ${k}: lc^(δ+1)·a ≠ q·b + r`);
    if (out.r.length >= B.length) findings.push(`case ${k}: deg r ≥ deg b`);
    if (out.r.some((c) => typeof c !== 'bigint')) findings.push(`case ${k}: a hole in r`);
  });
  return findings;
}

/**
 * Exact membership of a physical point in the stroke region built unscaled (σ = 1), at
 * Φ⁻¹(p) = (σ·Φ⁻¹(p))/σ: the reference of the scaled local frame of E3-U2c (tests only).
 */
export function a04ContainsUnscaled(
  input: A04Case,
  point: readonly [A04Scalar, A04Scalar],
  hooks: A04Hooks = {},
): boolean {
  const c = decodeCase(input);
  const f = makeFrame(c, hooks);
  if (c.paint.kind !== 'stroke') oracleError('not a stroke case');
  if (f.singular) oracleError('singular frame');
  const p = qp(scalarQ(point[0]), scalarQ(point[1]));
  return makeStrokeRegion(c, hooks, Q1).containsLocal(qpscale(phiInv(f, p), qdiv(Q1, f.sigma)));
}

export type A04CoverSelfTest = Readonly<{
  findings: string[];
  cells: number;
  /** Sample points decided by the point test from the cell's frontiers, and from the root. */
  decidedWarm: number;
  decidedCold: number;
  witnessed: number;
  /** Cells that the OUT-by-halves test certifies (E3-U2d). */
  halvesOut: number;
  /** Cells that the IN-by-halves test certifies (E3-U2e). */
  halvesIn: number;
  /** Cells that the cell test itself decides (E3-U2e: pair splits). */
  decided: number;
}>;

/**
 * Checks the E3-U2d and E3-U2e steps on the stroke cover of one case (contract sections 17 and
 * 18): the cell class, against exact membership at random points of the cell; the point test
 * started from a cell's sub-arc frontiers, against the point test from the root and exact
 * membership; the witness pair of the cell; and the OUT-by-halves and IN-by-halves tests,
 * against exact membership at the samples. The cells are the given boxes, or else
 * undecided cover cells reached by a random descent to sizes between 2^-4 and 2^-9.
 */
export function a04CoverSelfTest(
  input: A04Case,
  seed: number,
  options: Readonly<{ cells?: number; samples?: number; boxes?: readonly Box[] }> = {},
): A04CoverSelfTest {
  const c = decodeCase(input);
  const f = makeFrame(c, {});
  const work = newWork(A04_ORACLE_PARAMETERS.measureWorkCap);
  const previousWork = activeWork;
  activeWork = work;
  try {
    const R = regionTarget(c, f, {}, work);
    if (!(R instanceof StrokeTarget)) oracleError('a04CoverSelfTest takes a stroke case');
    const rnd = selfTestRandom(seed);
    const findings: string[] = [];
    let boxes = options.boxes;
    if (boxes === undefined) {
      const found: Box[] = [];
      for (
        let k = 0;
        k < (options.cells ?? 24) * 32 && found.length < (options.cells ?? 24);
        k += 1
      ) {
        const stop = 2 ** -(4 + Math.floor(rnd() * 6));
        let n = R.root;
        while (n.box.x1 - n.box.x0 > stop) {
          const kids = R.children(n).filter((m) => boxMeetsW1(f, m.box));
          if (kids.length === 0) break;
          n = kids[Math.floor(rnd() * kids.length)]!;
        }
        if (n.cls === 0 && n.box.x1 - n.box.x0 <= stop) found.push(n.box);
      }
      boxes = found;
    }
    let decidedWarm = 0;
    let decidedCold = 0;
    let witnessed = 0;
    let halvesOut = 0;
    let halvesIn = 0;
    let decided = 0;
    for (const box of boxes) {
      const at = `(${box.x0}, ${box.y0}) size ${box.x1 - box.x0}`;
      const { cls, arcs } = R['classifyCell'](box);
      if (cls !== 0) decided += 1;
      const w = box.x1 - box.x0;
      const h = box.y1 - box.y0;
      const exactAt: boolean[] = [];
      for (let k = 0; k < (options.samples ?? 24); k += 1) {
        // Dyadic offsets, so that the points are exact.
        const x = box.x0 + w * (Math.floor(rnd() * 1024) / 1024);
        const y = box.y0 + h * (Math.floor(rnd() * 1024) / 1024);
        const inside = R.contains(qpn(x, y));
        exactAt.push(inside);
        const warm = R.classifyPoint(x, y, arcs);
        const cold = R.classifyPoint(x, y);
        if (warm !== 0) decidedWarm += 1;
        if (cold !== 0) decidedCold += 1;
        if (warm !== 0 && (warm === 1) !== inside) findings.push(`${at}: warm point (${x}, ${y})`);
        if (cold !== 0 && (cold === 1) !== inside) findings.push(`${at}: cold point (${x}, ${y})`);
        if (cls !== 0 && (cls === 1) !== inside) findings.push(`${at}: cell class at (${x}, ${y})`);
      }
      if (cls !== 0) continue;
      const witness = R['findWitness'](box, arcs);
      if (witness !== null) {
        witnessed += 1;
        const inBox = (q: QP) =>
          qcmp(q.x, qnum(box.x0)) >= 0 &&
          qcmp(q.x, qnum(box.x1)) <= 0 &&
          qcmp(q.y, qnum(box.y0)) >= 0 &&
          qcmp(q.y, qnum(box.y1)) <= 0;
        if (
          !R.contains(witness.a) ||
          R.contains(witness.b) ||
          !inBox(witness.a) ||
          !inBox(witness.b)
        )
          findings.push(`${at}: witness`);
        // Points next to ∂R, where the point tests are hardest: bisection between the pair.
        let a = [qapprox(witness.a.x), qapprox(witness.a.y)] as const;
        let b = [qapprox(witness.b.x), qapprox(witness.b.y)] as const;
        for (let k = 0; k < 24; k += 1) {
          const x = (a[0] + b[0]) / 2;
          const y = (a[1] + b[1]) / 2;
          const inside = R.contains(qpn(x, y));
          const warm = R.classifyPoint(x, y, arcs);
          const cold = R.classifyPoint(x, y);
          if (warm !== 0) decidedWarm += 1;
          if (cold !== 0) decidedCold += 1;
          if (warm !== 0 && (warm === 1) !== inside)
            findings.push(`${at}: warm point (${x}, ${y})`);
          if (cold !== 0 && (cold === 1) !== inside)
            findings.push(`${at}: cold point (${x}, ${y})`);
          if (inside) a = [x, y];
          else b = [x, y];
        }
      }
      if (R['excludesByHalves'](box, arcs)) {
        halvesOut += 1;
        if (witness !== null) findings.push(`${at}: a witnessed cell is OUT by halves`);
        if (exactAt.some((v) => v))
          findings.push(`${at}: an inside sample in a cell OUT by halves`);
      }
      if (R['includedByHalves'](box, arcs)) {
        halvesIn += 1;
        if (witness !== null) findings.push(`${at}: a witnessed cell is IN by halves`);
        if (exactAt.some((v) => !v))
          findings.push(`${at}: an outside sample in a cell IN by halves`);
      }
    }
    return {
      findings,
      cells: boxes.length,
      decided,
      decidedWarm,
      decidedCold,
      witnessed,
      halvesOut,
      halvesIn,
    };
  } finally {
    activeWork = previousWork;
  }
}
