import type { Point } from './types.js';

// Independent test-only oracle for the B2 stroke contract
// (docs/plans/p3-b2-stroke-contract.md, section 11.1): ST-O1 piece bounds,
// ST-O2 inventory, ST-O3 resolution, ST-O4 exact region and ST-O5 literal
// membership, plus the named fixtures ST-F1 to ST-F26 of section 11.2.
//
// Every decision is exact: binary64 inputs become BigInt dyadic rationals,
// irrational ideal positions are compared through isolated and squared
// radicals, and the continuous leaf verifier uses outward-rounded rational
// intervals. Float64 values are only used to report approximate numbers.
// Nothing here imports from geometry-wasm or reuses the kernel's construction.

// ---------------------------------------------------------------------------
// Public types

export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

/** One stroke request as the kernel receives it (contract sections 2 and 6). */
export type StrokeOracleSource = Readonly<{
  verbs: ArrayLike<number>;
  /** Interleaved node-local x, y. */
  points: ArrayLike<number>;
  width: number;
  cap: StrokeCap;
  join: StrokeJoin;
  miterLimit: number;
  toleranceExponent: number;
}>;

/** A canonical sample `(E-, C, E+)` with `E± = C ± r·N` (contract section 4.2). */
export type StrokeSampleTriple = Readonly<{ minus: Point; center: Point; plus: Point }>;

/**
 * One emitted piece as the ST-U3 dump hook reports it. `verb` is the source
 * verb ordinal of the drawing segment (the CLOSE ordinal for a closing line).
 * `polygon` is the emitted contour, or null when its hull had zero area and
 * was dropped (section 4.2).
 */
export type StrokeDumpPiece =
  | Readonly<{
      kind: 'line-sweep';
      verb: number;
      /** 0 for a LINE; the sub-sweep ordinal of a collinear cubic (section 4.6). */
      part: number;
      start: StrokeSampleTriple;
      end: StrokeSampleTriple;
      polygon: readonly Point[] | null;
    }>
  | Readonly<{
      kind: 'cubic-leaf';
      verb: number;
      /** The subdivided parameter range: 0, the cusp split `t̃` or 1. */
      rangeStart: number;
      rangeEnd: number;
      /** The leaf is `[index, index + 1] / 2^depth` of its range. */
      depth: number;
      index: number;
      start: StrokeSampleTriple;
      end: StrokeSampleTriple;
      polygon: readonly Point[] | null;
    }>
  | Readonly<{
      kind: 'cusp-disk';
      verb: number;
      /** Float64 parameter of the reversal or turning point. */
      parameter: number;
      center: Point;
      polygon: readonly Point[] | null;
    }>
  | Readonly<{
      kind: 'join';
      incomingVerb: number;
      outgoingVerb: number;
      join: StrokeJoin;
      /** Outer points; at an exact reversal the incoming end triple's two outer points. */
      outerIn: Point;
      outerOut: Point;
      tip: Point | null;
      polygon: readonly Point[] | null;
    }>
  | Readonly<{
      kind: 'cap';
      end: 'start' | 'end';
      verb: number;
      cap: 'round' | 'square';
      triple: StrokeSampleTriple;
      /** Square caps: `[E- + r·τ̂, E+ + r·τ̂]`; null for round caps. */
      extension: readonly [Point, Point] | null;
      polygon: readonly Point[] | null;
    }>
  | Readonly<{
      kind: 'point-cap';
      subpath: number;
      cap: 'round' | 'square';
      point: Point;
      polygon: readonly Point[] | null;
    }>;

/** The V1 mesh form (structurally a `FillMesh`). */
export type StrokeOracleMesh = Readonly<{
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  boundaryEdges: ArrayLike<number>;
  bounds: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;
}>;

export type StrokeOracleResult = Readonly<{ ok: boolean; findings: readonly string[] }>;

export type StrokePieceBoundsResult = StrokeOracleResult &
  Readonly<{
    /** Largest certified leaf bound (side error plus hull term), in local units. */
    maxLeafBound: number;
    verifierCells: number;
  }>;

export type StrokeExactArea = Readonly<{ numerator: bigint; denominator: bigint; value: number }>;

export type StrokeResolutionResult = StrokeOracleResult &
  Readonly<{ meshArea: StrokeExactArea | null; unionArea: StrokeExactArea | null }>;

export type StrokeExactRegionResult = StrokeOracleResult &
  Readonly<{ idealArea: StrokeExactArea | null }>;

export type StrokeJoinClass = Readonly<{
  incomingVerb: number;
  outgoingVerb: number;
  point: Point;
  turn: 'continuation' | 'reversal' | 'turn';
  outer: 'minus' | 'plus' | null;
  piece: 'none' | StrokeJoin;
}>;

export type StrokeCubicClass = Readonly<{
  verb: number;
  kind: 'regular' | 'endpoint-stationary' | 'cusp' | 'collinear';
  /** Exact stationary parameter of a non-collinear cubic, when one lies in [0, 1]. */
  stationary: Readonly<{ numerator: bigint; denominator: bigint; value: number }> | null;
  /** Exact `C(t*)` of a cusp, approximated. */
  cuspCenter: Point | null;
  /** Odd-order roots in (0, 1) of a collinear cubic, approximated. */
  turningPoints: readonly Readonly<{ t: number; point: Point }>[];
  /** Even-order roots in (0, 1) of a collinear cubic, approximated. */
  continuations: readonly number[];
}>;

export type StrokeClassification = Readonly<{
  subpaths: readonly Readonly<{ closed: boolean; remainingVerbs: readonly number[] }>[];
  joins: readonly StrokeJoinClass[];
  caps: readonly Readonly<{ end: 'start' | 'end'; verb: number; tangent: Point }>[];
  pointCaps: readonly Readonly<{ subpath: number; point: Point }>[];
  cubics: readonly StrokeCubicClass[];
}>;

/** One ideal piece of the stroke region (section 2.2) as the oracle builds it. */
export type StrokeIdealPiece =
  | Readonly<{ kind: 'polygon'; role: string; exact: boolean; polygon: readonly Point[] }>
  | Readonly<{ kind: 'disk'; role: string; center: Point; radius: number }>
  | Readonly<{ kind: 'curve-sweep'; role: string; verb: number }>;

// ---------------------------------------------------------------------------
// Exact rationals

type Q = Readonly<{ n: bigint; d: bigint }>;
type QPoint = Readonly<{ x: Q; y: Q }>;

const Z: Q = { n: 0n, d: 1n };
const ONE: Q = { n: 1n, d: 1n };
const TWO: Q = { n: 2n, d: 1n };

function fail(message: string): never {
  throw new RangeError(message);
}

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function bitLength(value: bigint): number {
  return absBig(value).toString(2).length;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = absBig(left);
  let b = absBig(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function qr(n: bigint, d: bigint): Q {
  if (d === 0n) fail('zero rational denominator');
  if (n === 0n) return Z;
  const g = gcd(n, d);
  const s = d < 0n ? -1n : 1n;
  return { n: (n / g) * s, d: (d / g) * s };
}

function qi(value: bigint | number): Q {
  return { n: BigInt(value), d: 1n };
}

const qadd = (a: Q, b: Q): Q => qr(a.n * b.d + b.n * a.d, a.d * b.d);
const qsub = (a: Q, b: Q): Q => qr(a.n * b.d - b.n * a.d, a.d * b.d);
const qmul = (a: Q, b: Q): Q => qr(a.n * b.n, a.d * b.d);
const qdiv = (a: Q, b: Q): Q => qr(a.n * b.d, a.d * b.n);
const qneg = (a: Q): Q => ({ n: -a.n, d: a.d });
const qsgn = (a: Q): number => (a.n < 0n ? -1 : a.n > 0n ? 1 : 0);
const qcmp = (a: Q, b: Q): number => {
  const v = a.n * b.d - b.n * a.d;
  return v < 0n ? -1 : v > 0n ? 1 : 0;
};
const qeq = (a: Q, b: Q): boolean => a.n === b.n && a.d === b.d;
const qabs = (a: Q): Q => (a.n < 0n ? qneg(a) : a);
const qmax = (a: Q, b: Q): Q => (qcmp(a, b) >= 0 ? a : b);
const qsq = (a: Q): Q => qmul(a, a);

function qpow2(exponent: number): Q {
  return exponent >= 0 ? qi(1n << BigInt(exponent)) : { n: 1n, d: 1n << BigInt(-exponent) };
}

const bits = new DataView(new ArrayBuffer(8));

/** The exact binary64 value as a reduced dyadic rational. */
function qn(value: number): Q {
  if (!Number.isFinite(value)) fail('nonfinite value');
  bits.setFloat64(0, value, false);
  const high = bits.getUint32(0, false);
  const low = bits.getUint32(4, false);
  const exponent = (high >>> 20) & 0x7ff;
  const fraction = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  const significand = exponent === 0 ? fraction : (1n << 52n) | fraction;
  const shift = (exponent === 0 ? 1 : exponent) - 1075;
  const signed = (high & 0x80000000) === 0 ? significand : -significand;
  return shift >= 0 ? qi(signed << BigInt(shift)) : qr(signed, 1n << BigInt(-shift));
}

/** Approximate value for reports only; never used for a decision. */
function qv(a: Q): number {
  if (a.n === 0n) return 0;
  const negative = a.n < 0n;
  const n = absBig(a.n);
  const shift = 64 - (bitLength(n) - bitLength(a.d));
  const scaled = shift >= 0 ? (n << BigInt(shift)) / a.d : n / (a.d << BigInt(-shift));
  const value = Number(scaled) * 2 ** -shift;
  return negative ? -value : value;
}

function exactArea(a: Q): StrokeExactArea {
  return { numerator: a.n, denominator: a.d, value: qv(a) };
}

/** True when `area` is exactly the binary64 value `value`. */
export function strokeAreaEquals(area: StrokeExactArea, value: number): boolean {
  return qeq({ n: area.numerator, d: area.denominator }, qn(value));
}

const qp = (point: Point): QPoint => ({ x: qn(point[0]), y: qn(point[1]) });
const pv = (point: QPoint): Point => [qv(point.x), qv(point.y)];
const psub = (a: QPoint, b: QPoint): QPoint => ({ x: qsub(a.x, b.x), y: qsub(a.y, b.y) });
const padd = (a: QPoint, b: QPoint): QPoint => ({ x: qadd(a.x, b.x), y: qadd(a.y, b.y) });
const pscale = (a: QPoint, s: Q): QPoint => ({ x: qmul(a.x, s), y: qmul(a.y, s) });
const pdot = (a: QPoint, b: QPoint): Q => qadd(qmul(a.x, b.x), qmul(a.y, b.y));
const pcross = (a: QPoint, b: QPoint): Q => qsub(qmul(a.x, b.y), qmul(a.y, b.x));
const pzero = (a: QPoint): boolean => a.x.n === 0n && a.y.n === 0n;
const peq = (a: QPoint, b: QPoint): boolean => qeq(a.x, b.x) && qeq(a.y, b.y);
/** Left normal direction (not normalized). */
const pperp = (a: QPoint): QPoint => ({ x: qneg(a.y), y: a.x });
const pneg = (a: QPoint): QPoint => ({ x: qneg(a.x), y: qneg(a.y) });
const orient = (a: QPoint, b: QPoint, c: QPoint): number => qsgn(pcross(psub(b, a), psub(c, a)));

const sameNumber = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];
const sameBits = (a: Point, b: Point): boolean => Object.is(a[0], b[0]) && Object.is(a[1], b[1]);
const sameTriple = (a: StrokeSampleTriple, b: StrokeSampleTriple): boolean =>
  sameBits(a.minus, b.minus) && sameBits(a.center, b.center) && sameBits(a.plus, b.plus);

// ---------------------------------------------------------------------------
// Exact signs of radical expressions ("radicals isolated and squared")

/** sign(a + b·sqrt(s)) for s >= 0. */
function signRad(a: Q, b: Q, s: Q): number {
  const sa = qsgn(a);
  const sb = s.n === 0n ? 0 : qsgn(b);
  if (sb === 0) return sa;
  if (sa === 0) return sb;
  if (sa === sb) return sa;
  const difference = qsgn(qsub(qsq(a), qmul(qsq(b), s)));
  return sa > 0 ? difference : -difference;
}

type Q4 = readonly [Q, Q, Q, Q];

/** sign(x0 + x1·√A + x2·√B + x3·√A·√B) for A, B >= 0. */
function signRad2(x: Q4, a: Q, b: Q): number {
  const sx = signRad(x[0], x[1], a);
  const sy = b.n === 0n ? 0 : signRad(x[2], x[3], a);
  if (sy === 0) return sx;
  if (sx === 0) return sy;
  if (sx === sy) return sx;
  // X² - Y²·B with X = x0 + x1√A and Y = x2 + x3√A.
  const z0 = qsub(
    qadd(qsq(x[0]), qmul(qsq(x[1]), a)),
    qmul(b, qadd(qsq(x[2]), qmul(qsq(x[3]), a))),
  );
  const z1 = qsub(qmul(TWO, qmul(x[0], x[1])), qmul(TWO, qmul(b, qmul(x[2], x[3]))));
  const sz = signRad(z0, z1, a);
  return sx > 0 ? sz : -sz;
}

function q4mul(x: Q4, y: Q4, a: Q, b: Q): Q4 {
  const m = (u: Q, v: Q) => qmul(u, v);
  return [
    qadd(
      qadd(m(x[0], y[0]), qmul(m(x[1], y[1]), a)),
      qadd(qmul(m(x[2], y[2]), b), qmul(m(x[3], y[3]), qmul(a, b))),
    ),
    qadd(qadd(m(x[0], y[1]), m(x[1], y[0])), qmul(qadd(m(x[2], y[3]), m(x[3], y[2])), b)),
    qadd(qadd(m(x[0], y[2]), m(x[2], y[0])), qmul(qadd(m(x[1], y[3]), m(x[3], y[1])), a)),
    qadd(qadd(m(x[0], y[3]), m(x[3], y[0])), qadd(m(x[1], y[2]), m(x[2], y[1]))),
  ];
}

const q4add = (x: Q4, y: Q4): Q4 => [
  qadd(x[0], y[0]),
  qadd(x[1], y[1]),
  qadd(x[2], y[2]),
  qadd(x[3], y[3]),
];
const q4sub = (x: Q4, y: Q4): Q4 => [
  qsub(x[0], y[0]),
  qsub(x[1], y[1]),
  qsub(x[2], y[2]),
  qsub(x[3], y[3]),
];

/** An element `a + b·√s` of Q(√s) with the field's `s` kept by the caller. */
type QS = Readonly<{ a: Q; b: Q }>;
type QSPoint = Readonly<{ x: QS; y: QS }>;

const qsOf = (a: Q): QS => ({ a, b: Z });
const qsAdd = (u: QS, v: QS): QS => ({ a: qadd(u.a, v.a), b: qadd(u.b, v.b) });
const qsSub = (u: QS, v: QS): QS => ({ a: qsub(u.a, v.a), b: qsub(u.b, v.b) });
const qsMul = (u: QS, v: QS, s: Q): QS => ({
  a: qadd(qmul(u.a, v.a), qmul(qmul(u.b, v.b), s)),
  b: qadd(qmul(u.a, v.b), qmul(u.b, v.a)),
});
const qsScale = (u: QS, k: Q): QS => ({ a: qmul(u.a, k), b: qmul(u.b, k) });
const qsSign = (u: QS, s: Q): number => signRad(u.a, u.b, s);
const qsPoint = (p: QPoint): QSPoint => ({ x: qsOf(p.x), y: qsOf(p.y) });
function qsApprox(u: QS, s: Q): number {
  return qv(u.a) + qv(u.b) * Math.sqrt(qv(s));
}

/**
 * Decide `|P - (C + (r/√U)·w)| <= h` exactly, with `C` in Q(√s)², `w` rational and
 * `U > 0` rational. With `D = P - C` the condition is
 * `(|D|² + r²|w|²/U - h²)·√U - 2r(D·w) <= 0`, an element of Q(√s, √U).
 */
function withinOffset(p: QPoint, c: QSPoint, s: Q, w: QPoint, u: Q, r: Q, h: Q): boolean {
  const dx = qsSub(qsOf(p.x), c.x);
  const dy = qsSub(qsOf(p.y), c.y);
  const d2 = qsAdd(qsMul(dx, dx, s), qsMul(dy, dy, s));
  const h2 = qsq(h);
  if (pzero(w) || r.n === 0n) return qsSign(qsSub(d2, qsOf(h2)), s) <= 0;
  const dw = qsAdd(qsScale(dx, w.x), qsScale(dy, w.y));
  const x = qsAdd(d2, qsOf(qsub(qdiv(qmul(qsq(r), pdot(w, w)), u), h2)));
  const twoR = qmul(TWO, r);
  return signRad2([qneg(qmul(twoR, dw.a)), qneg(qmul(twoR, dw.b)), x.a, x.b], s, u) <= 0;
}

/** `|P - C| <= h` with `C` in Q(√s)². */
function withinPoint(p: QPoint, c: QSPoint, s: Q, h: Q): boolean {
  return withinOffset(p, c, s, { x: Z, y: Z }, ONE, Z, h);
}

/**
 * The ideal miter tip `T = B + r(a·|b| + b·|a|)/(|a||b| + a·b)` for outer normal
 * directions `a`, `b`; decide `|P - T| <= h` exactly in Q(√|a|², √|b|²).
 */
function withinMiterTip(p: QPoint, b: QPoint, na: QPoint, nb: QPoint, r: Q, h: Q): boolean {
  const aa = pdot(na, na);
  const bb = pdot(nb, nb);
  const ab = pdot(na, nb);
  const d = psub(p, b);
  const component = (dj: Q, aj: Q, bj: Q): Q4 => [
    qmul(dj, ab),
    qneg(qmul(r, bj)),
    qneg(qmul(r, aj)),
    dj,
  ];
  const vx = component(d.x, na.x, nb.x);
  const vy = component(d.y, na.y, nb.y);
  const den: Q4 = [ab, Z, Z, ONE];
  const lhs = q4mul(q4mul(den, den, aa, bb), [qsq(h), Z, Z, Z], aa, bb);
  const rhs = q4add(q4mul(vx, vx, aa, bb), q4mul(vy, vy, aa, bb));
  return signRad2(q4sub(lhs, rhs), aa, bb) >= 0;
}

// ---------------------------------------------------------------------------
// Outward-rounded rational intervals for the continuous verifier

type I = Readonly<{ lo: Q; hi: Q }>;

const PRECISION = 160;

function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

function roundQ(a: Q, up: boolean): Q {
  if (a.n === 0n) return a;
  if (bitLength(a.n) <= PRECISION && bitLength(a.d) <= PRECISION) return a;
  const k = PRECISION - (bitLength(a.n) - bitLength(a.d));
  const num = k >= 0 ? a.n << BigInt(k) : a.n;
  const den = k >= 0 ? a.d : a.d << BigInt(-k);
  let f = floorDiv(num, den);
  if (up && f * den !== num) f += 1n;
  return k >= 0 ? qr(f, 1n << BigInt(k)) : qi(f << BigInt(-k));
}

const iv = (lo: Q, hi: Q): I => ({ lo: roundQ(lo, false), hi: roundQ(hi, true) });
const ipt = (a: Q): I => ({ lo: a, hi: a });
const iadd = (a: I, b: I): I => iv(qadd(a.lo, b.lo), qadd(a.hi, b.hi));
const isub = (a: I, b: I): I => iv(qsub(a.lo, b.hi), qsub(a.hi, b.lo));
function imul(a: I, b: I): I {
  const v = [qmul(a.lo, b.lo), qmul(a.lo, b.hi), qmul(a.hi, b.lo), qmul(a.hi, b.hi)];
  let lo = v[0]!;
  let hi = v[0]!;
  for (const x of v) {
    if (qcmp(x, lo) < 0) lo = x;
    if (qcmp(x, hi) > 0) hi = x;
  }
  return iv(lo, hi);
}
function idiv(a: I, b: I): I | null {
  if (qsgn(b.lo) <= 0 && qsgn(b.hi) >= 0) return null;
  const v = [qdiv(a.lo, b.lo), qdiv(a.lo, b.hi), qdiv(a.hi, b.lo), qdiv(a.hi, b.hi)];
  let lo = v[0]!;
  let hi = v[0]!;
  for (const x of v) {
    if (qcmp(x, lo) < 0) lo = x;
    if (qcmp(x, hi) > 0) hi = x;
  }
  return iv(lo, hi);
}

function isqrtBig(value: bigint): bigint {
  if (value < 2n) return value;
  let x = 1n << BigInt((bitLength(value) + 1) >> 1);
  for (;;) {
    const y = (x + value / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Outward enclosure of sqrt(a) for rational a >= 0, about PRECISION bits. */
function sqrtQ(a: Q): I {
  if (a.n < 0n) fail('square root of a negative rational');
  if (a.n === 0n) return ipt(Z);
  const k = Math.max(0, Math.ceil((2 * PRECISION - (bitLength(a.n) - bitLength(a.d))) / 2));
  const scaled = (a.n << BigInt(2 * k)) / a.d;
  const root = isqrtBig(scaled);
  const exactRoot = root * root * a.d === a.n << BigInt(2 * k);
  const scale = 1n << BigInt(k);
  return { lo: qr(root, scale), hi: exactRoot ? qr(root, scale) : qr(root + 1n, scale) };
}

const distanceFromZero = (a: I): Q => (qsgn(a.lo) > 0 ? a.lo : qsgn(a.hi) < 0 ? qneg(a.hi) : Z);
const maxAbs = (a: I): Q => qmax(qabs(a.lo), qabs(a.hi));
const normLower = (x: I, y: I): Q =>
  sqrtQ(qadd(qsq(distanceFromZero(x)), qsq(distanceFromZero(y)))).lo;
const normUpper = (x: I, y: I): Q => sqrtQ(qadd(qsq(maxAbs(x)), qsq(maxAbs(y)))).hi;

// ---------------------------------------------------------------------------
// Source decoding (ST-S1, ST-S2)

type Segment = Readonly<{
  verb: number;
  kind: 'line' | 'cubic';
  raw: readonly Point[];
  q: readonly QPoint[];
  zeroLength: boolean;
}>;

type Subpath = Readonly<{
  ordinal: number;
  closed: boolean;
  start: Point;
  segments: readonly Segment[];
  remaining: readonly Segment[];
}>;

const VERB_MOVE = 0;
const VERB_LINE = 1;
const VERB_CUBIC = 2;
const VERB_CLOSE = 3;

function decode(source: StrokeOracleSource): Subpath[] {
  const verbs = Array.from(source.verbs);
  const points = Array.from(source.points);
  if (points.length % 2 !== 0) fail('odd point scalar count');
  if (!points.every(Number.isFinite)) fail('nonfinite point');
  let cursor = 0;
  const take = (): Point => {
    if (cursor + 2 > points.length) fail('verbs need more points');
    const point: Point = [points[cursor]!, points[cursor + 1]!];
    cursor += 2;
    return point;
  };
  const subpaths: Subpath[] = [];
  let current: { start: Point; last: Point; segments: Segment[]; closed: boolean } | null = null;
  const finish = () => {
    if (current === null) return;
    subpaths.push({
      ordinal: subpaths.length,
      closed: current.closed,
      start: current.start,
      segments: current.segments,
      remaining: current.segments.filter((segment) => !segment.zeroLength),
    });
    current = null;
  };
  const segment = (verb: number, raw: Point[]): Segment => {
    const q = raw.map(qp);
    return {
      verb,
      kind: raw.length === 2 ? 'line' : 'cubic',
      raw,
      q,
      zeroLength: q.every((point) => peq(point, q[0]!)),
    };
  };
  verbs.forEach((verb, ordinal) => {
    if (verb === VERB_MOVE) {
      finish();
      const start = take();
      current = { start, last: start, segments: [], closed: false };
      return;
    }
    if (current === null) fail('drawing verb without an open subpath');
    const open: { start: Point; last: Point; segments: Segment[]; closed: boolean } = current;
    if (verb === VERB_LINE) {
      const end = take();
      open.segments.push(segment(ordinal, [open.last, end]));
      open.last = end;
    } else if (verb === VERB_CUBIC) {
      const controls = [open.last, take(), take(), take()];
      open.segments.push(segment(ordinal, controls));
      open.last = controls[3]!;
    } else if (verb === VERB_CLOSE) {
      if (!sameNumber(open.last, open.start)) {
        open.segments.push(segment(ordinal, [open.last, open.start]));
      }
      open.closed = true;
      finish();
    } else {
      fail('unknown verb');
    }
  });
  finish();
  if (cursor !== points.length) fail('unused points');
  return subpaths;
}

/** ST-S2: exact one-sided tangents. */
function startTangent(segment: Segment): QPoint {
  const [p0, ...rest] = segment.q;
  for (const point of rest) {
    const d = psub(point, p0!);
    if (!pzero(d)) return d;
  }
  return fail('zero-length segment has no tangent');
}

function endTangent(segment: Segment): QPoint {
  const q = segment.q;
  const last = q[q.length - 1]!;
  for (let index = q.length - 2; index >= 0; index -= 1) {
    const d = psub(last, q[index]!);
    if (!pzero(d)) return d;
  }
  return fail('zero-length segment has no tangent');
}

// ---------------------------------------------------------------------------
// Cubic power basis and the exact stationary classification (section 4.6)

type Power = Readonly<{ a: QPoint; b: QPoint; c: QPoint; d: QPoint }>;

function power(q: readonly QPoint[]): Power {
  const [p0, p1, p2, p3] = q as [QPoint, QPoint, QPoint, QPoint];
  const three = qi(3);
  const a = padd(psub(pscale(psub(p1, p2), three), p0), p3);
  const b = padd(psub(pscale(p0, three), pscale(p1, qi(6))), pscale(p2, three));
  const c = pscale(psub(p1, p0), three);
  return { a, b, c, d: p0 };
}

function evalPoint(pw: Power, t: Q): QPoint {
  const axis = (k: 'x' | 'y') =>
    qadd(qmul(qadd(qmul(qadd(qmul(pw.a[k], t), pw.b[k]), t), pw.c[k]), t), pw.d[k]);
  return { x: axis('x'), y: axis('y') };
}

function evalDerivative(pw: Power, t: Q): QPoint {
  const axis = (k: 'x' | 'y') =>
    qadd(qmul(qadd(qmul(qmul(qi(3), pw.a[k]), t), qmul(TWO, pw.b[k])), t), pw.c[k]);
  return { x: axis('x'), y: axis('y') };
}

function evalPointQS(pw: Power, t: QS, s: Q): QSPoint {
  const axis = (k: 'x' | 'y') =>
    qsAdd(
      qsMul(qsAdd(qsMul(qsAdd(qsScale(t, pw.a[k]), qsOf(pw.b[k])), t, s), qsOf(pw.c[k])), t, s),
      qsOf(pw.d[k]),
    );
  return { x: axis('x'), y: axis('y') };
}

type Poly = readonly Q[];

function trim(p: Poly): Q[] {
  const out = [...p];
  while (out.length > 0 && out[out.length - 1]!.n === 0n) out.pop();
  return out;
}

function polyRem(a: Poly, b: Poly): Q[] {
  let r = trim(a);
  const divisor = trim(b);
  const lead = divisor[divisor.length - 1]!;
  while (r.length >= divisor.length) {
    const factor = qdiv(r[r.length - 1]!, lead);
    const shift = r.length - divisor.length;
    const next = [...r];
    divisor.forEach((coefficient, index) => {
      next[index + shift] = qsub(next[index + shift]!, qmul(factor, coefficient));
    });
    next[next.length - 1] = Z;
    r = trim(next);
  }
  return r;
}

function polyGcd(a: Poly, b: Poly): Q[] {
  let x = trim(a);
  let y = trim(b);
  while (y.length > 0) [x, y] = [y, polyRem(x, y)];
  return x;
}

type Turning = Readonly<{ t: QS; point: QSPoint; s: Q }>;

type CubicInfo =
  | Readonly<{ kind: 'regular' | 'endpoint-stationary' | 'cusp'; pw: Power; root: Q | null }>
  | Readonly<{
      kind: 'collinear';
      pw: Power;
      direction: QPoint;
      turning: readonly Turning[];
      continuations: readonly QS[];
      s: Q;
    }>;

function inOpenUnit(t: QS, s: Q): boolean {
  return qsSign(t, s) > 0 && qsSign(qsSub(qsOf(ONE), t), s) > 0;
}

function classifyCubic(segment: Segment): CubicInfo {
  const q = segment.q;
  const pw = power(q);
  const p0 = q[0]!;
  const collinear = [1, 2, 3].every((i) =>
    [1, 2, 3].every((j) => qsgn(pcross(psub(q[i]!, p0), psub(q[j]!, p0))) === 0),
  );
  if (collinear) {
    let direction: QPoint | null = null;
    for (const point of q.slice(1)) {
      const d = psub(point, p0);
      if (!pzero(d)) {
        direction = d;
        break;
      }
    }
    if (direction === null) fail('zero-length cubic reached classification');
    // Projected derivative p(t) = A t² + B t + C.
    const A = qmul(qi(3), pdot(pw.a, direction));
    const B = qmul(TWO, pdot(pw.b, direction));
    const C = pdot(pw.c, direction);
    const turning: Turning[] = [];
    const continuations: QS[] = [];
    let s = Z;
    if (A.n !== 0n) {
      const disc = qsub(qsq(B), qmul(qi(4), qmul(A, C)));
      const twoA = qmul(TWO, A);
      if (disc.n === 0n) {
        const t = qsOf(qdiv(qneg(B), twoA));
        if (inOpenUnit(t, Z)) continuations.push(t);
      } else if (qsgn(disc) > 0) {
        s = disc;
        const base = qdiv(qneg(B), twoA);
        const half = qdiv(ONE, twoA);
        const roots = [
          { a: base, b: qneg(half) },
          { a: base, b: half },
        ].sort((u, v) => qsSign(qsSub(u, v), s));
        for (const t of roots) {
          if (inOpenUnit(t, s)) turning.push({ t, point: evalPointQS(pw, t, s), s });
        }
      }
    } else if (B.n !== 0n) {
      const t = qsOf(qdiv(qneg(C), B));
      if (inOpenUnit(t, Z)) turning.push({ t, point: evalPointQS(pw, t, Z), s: Z });
    }
    return { kind: 'collinear', pw, direction, turning, continuations, s };
  }
  const dx: Q[] = [pw.c.x, qmul(TWO, pw.b.x), qmul(qi(3), pw.a.x)];
  const dy: Q[] = [pw.c.y, qmul(TWO, pw.b.y), qmul(qi(3), pw.a.y)];
  const g = polyGcd(dx, dy);
  if (g.length > 2) fail('classification undecided: hodograph gcd above degree 1');
  if (g.length < 2) return { kind: 'regular', pw, root: null };
  const root = qdiv(qneg(g[0]!), g[1]!);
  if (qsgn(root) < 0 || qcmp(root, ONE) > 0) return { kind: 'regular', pw, root };
  if (root.n === 0n || qeq(root, ONE)) return { kind: 'endpoint-stationary', pw, root };
  return { kind: 'cusp', pw, root };
}

// ---------------------------------------------------------------------------
// Joins, caps and the exact miter predicate (sections 2.3 and 4.3)

/** Exact miter test of section 4.3 on exact dyadic tangents `u`, `v`. */
function miterKept(u: QPoint, v: QPoint, limit: Q): boolean {
  const l2 = qsq(limit);
  const A = qmul(l2, pdot(u, v));
  const K = qsub(TWO, l2);
  const UV = qmul(pdot(u, u), pdot(v, v));
  const lhs = qsq(A);
  const rhs = qmul(qsq(K), UV);
  if (qsgn(K) <= 0) return qsgn(A) >= 0 ? true : qcmp(lhs, rhs) <= 0;
  return qsgn(A) < 0 ? false : qcmp(lhs, rhs) >= 0;
}

/** The exact miter predicate on Float64 tangents (ST-F5, ST-F25). */
export function strokeMiterKept(dIn: Point, dOut: Point, miterLimit: number): boolean {
  return miterKept(qp(dIn), qp(dOut), qn(miterLimit));
}

type JoinPlan = Readonly<{
  incoming: Segment;
  outgoing: Segment;
  b: QPoint;
  raw: Point;
  dIn: QPoint;
  dOut: QPoint;
  turn: 'continuation' | 'reversal' | 'turn';
  outer: 'minus' | 'plus' | null;
  piece: 'none' | StrokeJoin;
}>;

function planJoin(incoming: Segment, outgoing: Segment, source: StrokeOracleSource): JoinPlan {
  const dIn = endTangent(incoming);
  const dOut = startTangent(outgoing);
  const raw = incoming.raw[incoming.raw.length - 1]!;
  const b = qp(raw);
  const cross = qsgn(pcross(dIn, dOut));
  const dot = qsgn(pdot(dIn, dOut));
  const base = { incoming, outgoing, b, raw, dIn, dOut };
  if (cross === 0 && dot > 0) return { ...base, turn: 'continuation', outer: null, piece: 'none' };
  if (cross === 0) {
    return {
      ...base,
      turn: 'reversal',
      outer: null,
      piece: source.join === 'round' ? 'round' : 'none',
    };
  }
  const outer = cross > 0 ? 'minus' : 'plus';
  const piece =
    source.join === 'miter'
      ? miterKept(dIn, dOut, qn(source.miterLimit))
        ? 'miter'
        : 'bevel'
      : source.join;
  return { ...base, turn: 'turn', outer, piece };
}

type Slot =
  | Readonly<{
      kind: 'cap';
      end: 'start' | 'end';
      segment: Segment;
      b: QPoint;
      raw: Point;
      d: QPoint;
    }>
  | Readonly<{ kind: 'segment'; segment: Segment; info: CubicInfo | null }>
  | Readonly<{ kind: 'join'; join: JoinPlan }>
  | Readonly<{ kind: 'point-cap'; subpath: number; point: Point }>;

type Plan = Readonly<{
  subpaths: readonly Subpath[];
  slots: readonly Slot[];
  joins: readonly JoinPlan[];
  r: Q;
  h1: Q;
  h2: Q;
  infoByVerb: ReadonlyMap<number, CubicInfo>;
  segmentByVerb: ReadonlyMap<number, Segment>;
}>;

function checkSource(source: StrokeOracleSource): void {
  if (!Number.isFinite(source.width) || source.width < 0) fail('invalid stroke width');
  if (!Number.isFinite(source.miterLimit) || source.miterLimit < 1) fail('invalid miter limit');
  if (!['butt', 'round', 'square'].includes(source.cap)) fail('invalid cap');
  if (!['miter', 'round', 'bevel'].includes(source.join)) fail('invalid join');
  const e = source.toleranceExponent;
  if (!Number.isInteger(e) || e < -1020 || e > 1023) fail('invalid tolerance exponent');
}

function plan(source: StrokeOracleSource): Plan {
  checkSource(source);
  const subpaths = decode(source);
  const slots: Slot[] = [];
  const joins: JoinPlan[] = [];
  const infoByVerb = new Map<number, CubicInfo>();
  const segmentByVerb = new Map<number, Segment>();
  const capped = source.cap !== 'butt';
  for (const subpath of subpaths) {
    for (const segment of subpath.segments) segmentByVerb.set(segment.verb, segment);
    const remaining = subpath.remaining;
    if (remaining.length === 0) {
      if (!subpath.closed && subpath.segments.length > 0 && capped) {
        slots.push({ kind: 'point-cap', subpath: subpath.ordinal, point: subpath.start });
      }
      continue;
    }
    const first = remaining[0]!;
    const last = remaining[remaining.length - 1]!;
    if (!subpath.closed && capped) {
      slots.push({
        kind: 'cap',
        end: 'start',
        segment: first,
        b: first.q[0]!,
        raw: first.raw[0]!,
        d: startTangent(first),
      });
    }
    remaining.forEach((segment, index) => {
      const info = segment.kind === 'cubic' ? classifyCubic(segment) : null;
      if (info !== null) infoByVerb.set(segment.verb, info);
      slots.push({ kind: 'segment', segment, info });
      if (index + 1 < remaining.length) {
        const join = planJoin(segment, remaining[index + 1]!, source);
        joins.push(join);
        if (join.piece !== 'none') slots.push({ kind: 'join', join });
      }
    });
    if (subpath.closed) {
      const join = planJoin(last, first, source);
      joins.push(join);
      if (join.piece !== 'none') slots.push({ kind: 'join', join });
    } else if (capped) {
      slots.push({
        kind: 'cap',
        end: 'end',
        segment: last,
        b: last.q[last.q.length - 1]!,
        raw: last.raw[last.raw.length - 1]!,
        d: endTangent(last),
      });
    }
  }
  const e = source.toleranceExponent;
  return {
    subpaths,
    slots,
    joins,
    r: qdiv(qn(source.width), TWO),
    h1: qpow2(e),
    h2: qpow2(e - 2),
    infoByVerb,
    segmentByVerb,
  };
}

function exactOf(value: Q): Readonly<{ numerator: bigint; denominator: bigint; value: number }> {
  return { numerator: value.n, denominator: value.d, value: qv(value) };
}

/** The oracle's own decoding and classification (ST-S1, ST-S2, section 4.6, ST-S6). */
export function classifyStrokeSource(source: StrokeOracleSource): StrokeClassification {
  const p = plan(source);
  const cubics: StrokeCubicClass[] = [];
  for (const [verb, info] of p.infoByVerb) {
    if (info.kind === 'collinear') {
      cubics.push({
        verb,
        kind: 'collinear',
        stationary: null,
        cuspCenter: null,
        turningPoints: info.turning.map((turning) => ({
          t: qsApprox(turning.t, turning.s),
          point: [qsApprox(turning.point.x, turning.s), qsApprox(turning.point.y, turning.s)],
        })),
        continuations: info.continuations.map((t) => qsApprox(t, Z)),
      });
    } else {
      const root = info.kind === 'regular' ? null : info.root;
      cubics.push({
        verb,
        kind: info.kind,
        stationary: root === null ? null : exactOf(root),
        cuspCenter: info.kind === 'cusp' ? pv(evalPoint(info.pw, info.root!)) : null,
        turningPoints: [],
        continuations: [],
      });
    }
  }
  return {
    subpaths: p.subpaths.map((subpath) => ({
      closed: subpath.closed,
      remainingVerbs: subpath.remaining.map((segment) => segment.verb),
    })),
    joins: p.joins.map((join) => ({
      incomingVerb: join.incoming.verb,
      outgoingVerb: join.outgoing.verb,
      point: join.raw,
      turn: join.turn,
      outer: join.outer,
      piece: join.piece,
    })),
    caps: p.slots.flatMap((slot) =>
      slot.kind === 'cap' ? [{ end: slot.end, verb: slot.segment.verb, tangent: pv(slot.d) }] : [],
    ),
    pointCaps: p.slots.flatMap((slot) =>
      slot.kind === 'point-cap' ? [{ subpath: slot.subpath, point: slot.point }] : [],
    ),
    cubics,
  };
}

// ---------------------------------------------------------------------------
// Disk vertex count (section 4.4), as the contract states it in Float64

const C_ARC = 4.9348023;

/** `n` of section 4.4 for radius `r`, or null for `DiskLimit`. */
export function strokeDiskVertexCount(
  radius: number,
  toleranceExponent: number,
  centerInfNorm: number,
): number | null {
  for (let k = 1; k <= 6; k += 1) {
    const n = 2 ** (k + 2);
    const gArc = (8 * k + 16) * 2 ** -53 * (centerInfNorm + radius);
    if (radius * C_ARC <= (2 ** (toleranceExponent - 2) - gArc) * n * n * (1 - 2 ** -40)) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Boundary-inclusive convex hull (section 4.2)

/** Hull indices into `points`, CCW from the lexicographic minimum; null for zero area. */
function hullIndices(points: readonly QPoint[]): number[] | null {
  const order = points
    .map((point, index) => ({ point, index }))
    .sort((u, v) => qcmp(u.point.x, v.point.x) || qcmp(u.point.y, v.point.y));
  const unique = order.filter(
    (entry, index) => index === 0 || !peq(order[index - 1]!.point, entry.point),
  );
  if (unique.length < 3) return null;
  const chain = (list: typeof unique) => {
    const out: typeof unique = [];
    for (const entry of list) {
      while (
        out.length >= 2 &&
        orient(out[out.length - 2]!.point, out[out.length - 1]!.point, entry.point) < 0
      ) {
        out.pop();
      }
      out.push(entry);
    }
    return out;
  };
  const lower = chain(unique);
  const upper = chain([...unique].reverse());
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let twice = Z;
  for (let index = 0; index < hull.length; index += 1) {
    twice = qadd(twice, pcross(hull[index]!.point, hull[(index + 1) % hull.length]!.point));
  }
  if (qsgn(twice) <= 0) return null;
  return hull.map((entry) => entry.index);
}

function hullOf(points: readonly Point[]): Point[] | null {
  const indices = hullIndices(points.map(qp));
  return indices === null ? null : indices.map((index) => points[index]!);
}

/**
 * The boundary-inclusive convex hull of section 4.2, decided by exact
 * orientation: counter-clockwise from the lexicographically smallest point,
 * collinear boundary points kept, interior points and duplicates dropped;
 * null for zero area.
 */
export function strokeConvexHull(points: readonly Point[]): Point[] | null {
  return hullOf(points);
}

function samePolygon(a: readonly Point[] | null, b: readonly Point[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((point, index) => sameNumber(point, b[index]!));
}

function polygonText(polygon: readonly Point[] | null): string {
  return polygon === null
    ? 'null'
    : polygon.map((point) => `(${String(point[0])},${String(point[1])})`).join(' ');
}

// ---------------------------------------------------------------------------
// ST-O1 piece bounds

function checkDisk(
  polygon: readonly Point[] | null,
  center: QPoint,
  r: Q,
  h: Q,
  extra: readonly Point[],
  label: string,
  findings: string[],
): void {
  if (polygon === null || polygon.length < 3) {
    findings.push(`${label}: disk piece has no polygon`);
    return;
  }
  const v = polygon.map(qp);
  const n = v.length;
  const outer = qsq(qadd(r, h));
  const inner = qsub(r, h);
  for (let index = 0; index < n; index += 1) {
    const a = v[index]!;
    const b = v[(index + 1) % n]!;
    const c = v[(index + 2) % n]!;
    if (orient(a, b, c) < 0 || peq(a, b)) {
      findings.push(
        `${label}: disk polygon is not convex and counter-clockwise at vertex ${String(index)}`,
      );
      return;
    }
    if (qsgn(pcross(psub(a, center), psub(b, center))) <= 0) {
      findings.push(`${label}: disk polygon does not wind once around its center`);
      return;
    }
    if (qcmp(pdot(psub(a, center), psub(a, center)), outer) > 0) {
      findings.push(`${label}: disk vertex ${String(index)} lies beyond r + share`);
    }
    const edge = psub(b, a);
    const cross = pcross(edge, psub(center, a));
    if (
      qsgn(inner) > 0 &&
      (qsgn(cross) < 0 || qcmp(qsq(cross), qmul(qsq(inner), pdot(edge, edge))) < 0)
    ) {
      findings.push(
        `${label}: disk chord ${String(index)} lies closer than r - share to the center`,
      );
    }
  }
  for (const point of extra) {
    const p = qp(point);
    for (let index = 0; index < n; index += 1) {
      if (orient(v[index]!, v[(index + 1) % n]!, p) < 0) {
        findings.push(
          `${label}: hull point (${String(point[0])},${String(point[1])}) lies outside the disk piece`,
        );
        break;
      }
    }
  }
}

/** `p` within `h` of `base + σ·(r/|d|)·perp(d)` (σ = +1 for E+, -1 for E-). */
function sampleOk(p: Point, base: QSPoint, s: Q, d: QPoint, sigma: 1 | -1, r: Q, h: Q): boolean {
  const w = sigma > 0 ? pperp(d) : pneg(pperp(d));
  return withinOffset(qp(p), base, s, w, pdot(d, d), r, h);
}

function checkTriple(
  triple: StrokeSampleTriple,
  center: QSPoint,
  s: Q,
  d: QPoint,
  r: Q,
  h: Q,
  label: string,
  findings: string[],
  eitherSign = false,
): void {
  if (!withinPoint(qp(triple.center), center, s, h))
    findings.push(`${label}: center sample beyond the share`);
  const direct =
    sampleOk(triple.minus, center, s, d, -1, r, h) && sampleOk(triple.plus, center, s, d, 1, r, h);
  const swapped =
    eitherSign &&
    sampleOk(triple.minus, center, s, d, 1, r, h) &&
    sampleOk(triple.plus, center, s, d, -1, r, h);
  if (!direct && !swapped) findings.push(`${label}: offset sample beyond the share`);
}

function checkGeneratedHull(
  polygon: readonly Point[] | null,
  generators: readonly Point[],
  label: string,
  findings: string[],
): void {
  const expected = hullOf(generators);
  if (!samePolygon(polygon, expected)) {
    findings.push(
      `${label}: polygon ${polygonText(polygon)} is not the hull ${polygonText(expected)}`,
    );
  }
}

type LeafVerification = { bound: Q | null; cells: number; finding: string | null };

const VERIFIER_DEPTH = 40;
const VERIFIER_CELLS = 1 << 16;

/**
 * The P3.0b-s1 continuous verifier for one side of a cubic leaf. The side chord
 * runs from `pa` at parameter `a` to `pb` at `b`; the ideal side is
 * `O(t) = C(t) + σ·r·N(t)`, with `N` the unit left normal of `C'(t)` or, at a
 * simple stationary root `t*`, of `sign(t - t*)·L(t)` where `C' = (t - t*)·L`.
 */
function verifySide(
  pw: Power,
  root: Q | null,
  a: Q,
  b: Q,
  pa: QPoint,
  pb: QPoint,
  sigma: 1 | -1,
  r: Q,
  budget: Q,
  stats: { cells: number },
): LeafVerification {
  const three = qi(3);
  const L1: QPoint | null = root === null ? null : pscale(pw.a, three);
  const L0: QPoint | null =
    root === null ? null : padd(pscale(pw.b, TWO), pscale(pw.a, qmul(three, root)));
  const factorSign = root === null ? 1 : qcmp(qadd(a, b), qmul(TWO, root)) >= 0 ? 1 : -1;
  if (root !== null) {
    const remainder = padd(pw.c, pscale(L0!, root));
    if (!pzero(remainder))
      return { bound: null, cells: 0, finding: 'stationary root does not divide the hodograph' };
  }
  const direction = (t: Q): QPoint => {
    if (L1 === null) return evalDerivative(pw, t);
    const value = padd(pscale(L1, t), L0!);
    return factorSign > 0 ? value : pneg(value);
  };
  const span = qsub(b, a);
  const chord = (t: Q): QPoint => padd(pa, pscale(psub(pb, pa), qdiv(qsub(t, a), span)));
  const endpointError = (t: Q): { lower: Q; upper: Q } | null => {
    const center = evalPoint(pw, t);
    const d = direction(t);
    if (pzero(d)) return null;
    const length = sqrtQ(pdot(d, d));
    const nx = idiv(ipt(qneg(d.y)), length);
    const ny = idiv(ipt(d.x), length);
    if (nx === null || ny === null) return null;
    const scale = ipt(sigma > 0 ? r : qneg(r));
    const target = chord(t);
    const ex = isub(iadd(ipt(center.x), imul(nx, scale)), ipt(target.x));
    const ey = isub(iadd(ipt(center.y), imul(ny, scale)), ipt(target.y));
    return { lower: normLower(ex, ey), upper: normUpper(ex, ey) };
  };
  const jerk = sqrtQ(pdot(pscale(pw.a, qi(6)), pscale(pw.a, qi(6)))).hi;
  const l1Norm = L1 === null ? Z : sqrtQ(pdot(L1, L1)).hi;
  let bound: Q = Z;
  const stack: { t0: Q; t1: Q; depth: number }[] = [{ t0: a, t1: b, depth: 0 }];
  while (stack.length > 0) {
    if (stats.cells >= VERIFIER_CELLS)
      return { bound: null, cells: stats.cells, finding: 'verifier cell limit' };
    const cell = stack.pop()!;
    stats.cells += 1;
    const left = endpointError(cell.t0);
    const right = endpointError(cell.t1);
    if (left === null || right === null) {
      return {
        bound: null,
        cells: stats.cells,
        finding: 'side normal undefined at a cell endpoint',
      };
    }
    if (qcmp(left.lower, budget) > 0 || qcmp(right.lower, budget) > 0) {
      const at = qcmp(left.lower, budget) > 0 ? cell.t0 : cell.t1;
      return {
        bound: null,
        cells: stats.cells,
        finding: `endpoint error lower bound ${String(qv(qmax(left.lower, right.lower)))} exceeds the side budget at t=${String(qv(at))}`,
      };
    }
    const t = iv(cell.t0, cell.t1);
    const dirBox = (k: 'x' | 'y'): I => {
      if (L1 === null)
        return iadd(
          imul(iadd(imul(ipt(qmul(three, pw.a[k])), t), ipt(qmul(TWO, pw.b[k]))), t),
          ipt(pw.c[k]),
        );
      return iadd(imul(ipt(L1[k]), t), ipt(L0![k]));
    };
    const speed = normLower(dirBox('x'), dirBox('y'));
    let accepted = false;
    if (qsgn(speed) > 0) {
      const acc = normUpper(
        iadd(imul(ipt(qmul(qi(6), pw.a.x)), t), ipt(qmul(TWO, pw.b.x))),
        iadd(imul(ipt(qmul(qi(6), pw.a.y)), t), ipt(qmul(TWO, pw.b.y))),
      );
      const dirAcc = L1 === null ? acc : l1Norm;
      const dirJerk = L1 === null ? jerk : Z;
      const normalSecond = qadd(
        qdiv(qmul(TWO, dirJerk), speed),
        qdiv(qmul(qi(6), qsq(dirAcc)), qsq(speed)),
      );
      const m = qadd(acc, qmul(r, normalSecond));
      const h = qsub(cell.t1, cell.t0);
      const error = roundQ(qadd(qmax(left.upper, right.upper), qdiv(qmul(m, qsq(h)), qi(8))), true);
      if (qcmp(error, budget) <= 0) {
        bound = qmax(bound, error);
        accepted = true;
      }
    }
    if (accepted) continue;
    if (cell.depth >= VERIFIER_DEPTH)
      return { bound: null, cells: stats.cells, finding: 'verifier depth limit' };
    const mid = qdiv(qadd(cell.t0, cell.t1), TWO);
    stack.push(
      { t0: mid, t1: cell.t1, depth: cell.depth + 1 },
      { t0: cell.t0, t1: mid, depth: cell.depth + 1 },
    );
  }
  return { bound, cells: stats.cells, finding: null };
}

function leafRange(
  piece: Extract<StrokeDumpPiece, { kind: 'cubic-leaf' }>,
): { t0: Q; t1: Q } | null {
  if (!Number.isInteger(piece.depth) || piece.depth < 0 || piece.depth > 64) return null;
  if (!Number.isInteger(piece.index) || piece.index < 0 || piece.index >= 2 ** piece.depth)
    return null;
  const s = qn(piece.rangeStart);
  const e = qn(piece.rangeEnd);
  const scale = qpow2(-piece.depth);
  const at = (k: number) => qadd(s, qmul(qsub(e, s), qmul(qi(k), scale)));
  return { t0: at(piece.index), t1: at(piece.index + 1) };
}

/**
 * ST-O1: every emitted piece against its ideal piece from the source, within
 * its section 3 share (`2^e` for sweeps, tips, square caps and cusp centers;
 * `2^(e-2)` for disk polygons).
 */
export function checkStrokePieceBounds(
  source: StrokeOracleSource,
  pieces: readonly StrokeDumpPiece[],
): StrokePieceBoundsResult {
  const p = plan(source);
  const findings: string[] = [];
  const { r, h1, h2 } = p;
  let maxLeaf = Z;
  const stats = { cells: 0 };
  const joinOf = (incoming: number, outgoing: number) =>
    p.joins.find((join) => join.incoming.verb === incoming && join.outgoing.verb === outgoing) ??
    null;

  pieces.forEach((piece, index) => {
    const label = `piece ${String(index)} (${piece.kind})`;
    switch (piece.kind) {
      case 'line-sweep': {
        const segment = p.segmentByVerb.get(piece.verb);
        if (segment === undefined || segment.zeroLength) {
          findings.push(`${label}: no remaining segment for verb ${String(piece.verb)}`);
          return;
        }
        const generators = [
          piece.start.minus,
          piece.start.center,
          piece.start.plus,
          piece.end.minus,
          piece.end.center,
          piece.end.plus,
        ];
        checkGeneratedHull(piece.polygon, generators, label, findings);
        if (segment.kind === 'line') {
          if (piece.part !== 0) findings.push(`${label}: a line has one sweep part`);
          const d = psub(segment.q[1]!, segment.q[0]!);
          if (
            !sameNumber(piece.start.center, segment.raw[0]!) ||
            !sameNumber(piece.end.center, segment.raw[1]!)
          ) {
            findings.push(`${label}: line sweep centers are not the exact source points`);
          }
          checkTriple(piece.start, qsPoint(segment.q[0]!), Z, d, r, h1, `${label} start`, findings);
          checkTriple(piece.end, qsPoint(segment.q[1]!), Z, d, r, h1, `${label} end`, findings);
          return;
        }
        const info = p.infoByVerb.get(piece.verb);
        if (info === undefined || info.kind !== 'collinear') {
          findings.push(`${label}: a line sweep on a non-collinear cubic`);
          return;
        }
        const knots: { point: QSPoint; s: Q }[] = [
          { point: qsPoint(segment.q[0]!), s: Z },
          ...info.turning.map((turning) => ({ point: turning.point, s: turning.s })),
          { point: qsPoint(segment.q[3]!), s: Z },
        ];
        if (!Number.isInteger(piece.part) || piece.part < 0 || piece.part + 1 >= knots.length) {
          findings.push(`${label}: collinear sweep part ${String(piece.part)} does not exist`);
          return;
        }
        const from = knots[piece.part]!;
        const to = knots[piece.part + 1]!;
        checkTriple(
          piece.start,
          from.point,
          from.s,
          info.direction,
          r,
          h1,
          `${label} start`,
          findings,
          true,
        );
        checkTriple(
          piece.end,
          to.point,
          to.s,
          info.direction,
          r,
          h1,
          `${label} end`,
          findings,
          true,
        );
        return;
      }
      case 'cubic-leaf': {
        const info = p.infoByVerb.get(piece.verb);
        if (info === undefined || info.kind === 'collinear') {
          findings.push(`${label}: no non-collinear cubic for verb ${String(piece.verb)}`);
          return;
        }
        const range = leafRange(piece);
        if (range === null || qcmp(range.t0, range.t1) >= 0) {
          findings.push(`${label}: invalid leaf interval`);
          return;
        }
        checkGeneratedHull(
          piece.polygon,
          [
            piece.start.minus,
            piece.start.center,
            piece.start.plus,
            piece.end.minus,
            piece.end.center,
            piece.end.plus,
          ],
          label,
          findings,
        );
        for (const [t, triple, which] of [
          [range.t0, piece.start, 'start'],
          [range.t1, piece.end, 'end'],
        ] as const) {
          if (!withinPoint(qp(triple.center), qsPoint(evalPoint(info.pw, t)), Z, h1)) {
            findings.push(`${label}: ${which} center sample beyond the share`);
          }
        }
        // Clip at a stationary root inside the leaf: the sliver between t* and
        // the split t̃ belongs to the cusp disk (ST-G5).
        let a = range.t0;
        let b = range.t1;
        const root = info.root;
        if (root !== null && qcmp(root, a) > 0 && qcmp(root, b) < 0) {
          const atSplit = (value: number) =>
            info.kind === 'cusp' && qcmp(qabs(qsub(qn(value), root)), qpow2(-40)) <= 0;
          if (piece.index === 2 ** piece.depth - 1 && atSplit(piece.rangeEnd)) b = root;
          else if (piece.index === 0 && atSplit(piece.rangeStart)) a = root;
          else {
            findings.push(`${label}: stationary parameter strictly inside a leaf`);
            return;
          }
        }
        const s0 = psub(qp(piece.start.plus), qp(piece.start.minus));
        const s1 = psub(qp(piece.end.plus), qp(piece.end.minus));
        if (pzero(s0) || pzero(s1)) {
          findings.push(`${label}: collapsed normal sample`);
          return;
        }
        const sin2 = qdiv(qsq(pcross(s0, s1)), qmul(pdot(s0, s0), pdot(s1, s1)));
        const hull = roundQ(qmul(r, sqrtQ(sin2).hi), true);
        const budget = qsub(h1, hull);
        if (qsgn(budget) <= 0) {
          findings.push(`${label}: hull term alone exceeds the curve share`);
          return;
        }
        let side = Z;
        for (const [sigma, start, end] of [
          [1, piece.start.plus, piece.end.plus],
          [-1, piece.start.minus, piece.end.minus],
        ] as const) {
          const result = verifySide(
            info.pw,
            root,
            a,
            b,
            qp(start),
            qp(end),
            sigma,
            r,
            budget,
            stats,
          );
          if (result.finding !== null || result.bound === null) {
            findings.push(
              `${label} ${sigma > 0 ? 'plus' : 'minus'} side: ${result.finding ?? 'uncertified'}`,
            );
            return;
          }
          side = qmax(side, result.bound);
        }
        maxLeaf = qmax(maxLeaf, qadd(side, hull));
        return;
      }
      case 'cusp-disk': {
        const info = p.infoByVerb.get(piece.verb);
        if (info === undefined) {
          findings.push(`${label}: no cubic for verb ${String(piece.verb)}`);
          return;
        }
        const centers: { point: QSPoint; s: Q }[] =
          info.kind === 'collinear'
            ? info.turning.map((turning) => ({ point: turning.point, s: turning.s }))
            : info.kind === 'cusp'
              ? [{ point: qsPoint(evalPoint(info.pw, info.root!)), s: Z }]
              : [];
        if (!centers.some((center) => withinPoint(qp(piece.center), center.point, center.s, h1))) {
          findings.push(
            `${label}: center not within the curve share of an exact reversal or turning point`,
          );
        }
        checkDisk(piece.polygon, qp(piece.center), r, h2, [], label, findings);
        return;
      }
      case 'join': {
        const join = joinOf(piece.incomingVerb, piece.outgoingVerb);
        if (join === null || join.piece === 'none') {
          findings.push(`${label}: the oracle has no join piece here`);
          return;
        }
        if (piece.join !== join.piece) {
          findings.push(`${label}: join kind ${piece.join} where the oracle decides ${join.piece}`);
          return;
        }
        const base = qsPoint(join.b);
        if (join.turn === 'reversal') {
          const ok =
            (sampleOk(piece.outerIn, base, Z, join.dIn, -1, r, h1) &&
              sampleOk(piece.outerOut, base, Z, join.dIn, 1, r, h1)) ||
            (sampleOk(piece.outerIn, base, Z, join.dIn, 1, r, h1) &&
              sampleOk(piece.outerOut, base, Z, join.dIn, -1, r, h1));
          if (!ok) findings.push(`${label}: reversal outer points beyond the share`);
          checkDisk(
            piece.polygon,
            join.b,
            r,
            h2,
            [join.raw, piece.outerIn, piece.outerOut],
            label,
            findings,
          );
          return;
        }
        const sigma = join.outer === 'plus' ? 1 : -1;
        if (!sampleOk(piece.outerIn, base, Z, join.dIn, sigma, r, h1))
          findings.push(`${label}: O_in beyond the share`);
        if (!sampleOk(piece.outerOut, base, Z, join.dOut, sigma, r, h1))
          findings.push(`${label}: O_out beyond the share`);
        if (join.piece === 'bevel') {
          checkGeneratedHull(
            piece.polygon,
            [join.raw, piece.outerIn, piece.outerOut],
            label,
            findings,
          );
        } else if (join.piece === 'miter') {
          if (piece.tip === null) {
            findings.push(`${label}: miter without a tip`);
            return;
          }
          const na = sigma > 0 ? pperp(join.dIn) : pneg(pperp(join.dIn));
          const nb = sigma > 0 ? pperp(join.dOut) : pneg(pperp(join.dOut));
          if (!withinMiterTip(qp(piece.tip), join.b, na, nb, r, h1))
            findings.push(`${label}: miter tip beyond the share`);
          checkGeneratedHull(
            piece.polygon,
            [join.raw, piece.outerIn, piece.tip, piece.outerOut],
            label,
            findings,
          );
        } else {
          checkDisk(
            piece.polygon,
            join.b,
            r,
            h2,
            [join.raw, piece.outerIn, piece.outerOut],
            label,
            findings,
          );
        }
        return;
      }
      case 'cap': {
        const slot = p.slots.find(
          (candidate): candidate is Extract<Slot, { kind: 'cap' }> =>
            candidate.kind === 'cap' &&
            candidate.end === piece.end &&
            candidate.segment.verb === piece.verb,
        );
        if (slot === undefined) {
          findings.push(`${label}: the oracle has no cap here`);
          return;
        }
        if (piece.cap !== source.cap)
          findings.push(`${label}: cap kind ${piece.cap} differs from the request`);
        if (!sameNumber(piece.triple.center, slot.raw))
          findings.push(`${label}: cap center is not the exact end point`);
        checkTriple(piece.triple, qsPoint(slot.b), Z, slot.d, r, h1, label, findings);
        if (piece.cap === 'square') {
          if (piece.extension === null) {
            findings.push(`${label}: square cap without extension points`);
            return;
          }
          const forward = slot.end === 'end' ? slot.d : pneg(slot.d);
          const u = pdot(slot.d, slot.d);
          const base = qsPoint(slot.b);
          const okMinus = withinOffset(
            qp(piece.extension[0]),
            base,
            Z,
            padd(pneg(pperp(slot.d)), forward),
            u,
            r,
            h1,
          );
          const okPlus = withinOffset(
            qp(piece.extension[1]),
            base,
            Z,
            padd(pperp(slot.d), forward),
            u,
            r,
            h1,
          );
          if (!okMinus || !okPlus) findings.push(`${label}: square cap corner beyond the share`);
          checkGeneratedHull(
            piece.polygon,
            [
              piece.triple.minus,
              piece.triple.center,
              piece.triple.plus,
              piece.extension[0],
              piece.extension[1],
            ],
            label,
            findings,
          );
        } else {
          checkDisk(
            piece.polygon,
            slot.b,
            r,
            h2,
            [piece.triple.minus, piece.triple.center, piece.triple.plus],
            label,
            findings,
          );
        }
        return;
      }
      case 'point-cap': {
        const subpath = p.subpaths[piece.subpath];
        if (subpath === undefined || !sameNumber(subpath.start, piece.point)) {
          findings.push(`${label}: point is not the subpath's point`);
          return;
        }
        const c = qp(subpath.start);
        if (piece.cap === 'round') {
          checkDisk(piece.polygon, c, r, h2, [], label, findings);
          return;
        }
        const corners = [
          { x: qsub(c.x, r), y: qsub(c.y, r) },
          { x: qadd(c.x, r), y: qsub(c.y, r) },
          { x: qadd(c.x, r), y: qadd(c.y, r) },
          { x: qsub(c.x, r), y: qadd(c.y, r) },
        ];
        if (piece.polygon === null || piece.polygon.length !== 4) {
          findings.push(`${label}: square point cap is not a quadrilateral`);
          return;
        }
        piece.polygon.forEach((vertex, corner) => {
          if (!withinPoint(qp(vertex), qsPoint(corners[corner]!), Z, h1)) {
            findings.push(`${label}: corner ${String(corner)} beyond the share`);
          }
        });
        return;
      }
    }
  });
  return {
    ok: findings.length === 0,
    findings,
    maxLeafBound: qv(maxLeaf),
    verifierCells: stats.cells,
  };
}

// ---------------------------------------------------------------------------
// ST-O2 inventory

function tripleOuter(triple: StrokeSampleTriple, side: 'minus' | 'plus'): Point {
  return side === 'minus' ? triple.minus : triple.plus;
}

/**
 * ST-O2: the dump lists, in the order of section 4.9, one sweep sequence per
 * remaining segment whose leaves tile its parameter range, one join piece of
 * the oracle's own kind at each source join that emits one and none elsewhere,
 * caps at open ends only, cusp disks exactly at the oracle's classification,
 * and shared triples at knots and forward continuations.
 */
export function checkStrokeInventory(
  source: StrokeOracleSource,
  pieces: readonly StrokeDumpPiece[],
): StrokeOracleResult {
  const p = plan(source);
  const findings: string[] = [];
  let cursor = 0;
  const firstTriple = new Map<number, StrokeSampleTriple>();
  const lastTriple = new Map<number, StrokeSampleTriple>();
  const next = (): StrokeDumpPiece | undefined => pieces[cursor];
  const bad = (message: string) => findings.push(`piece ${String(cursor)}: ${message}`);

  const consumeLeaves = (
    segment: Segment,
    rangeStart: Q,
    rangeEnd: Q,
    previous: StrokeSampleTriple | null,
  ) => {
    let expected = rangeStart;
    let prior = previous;
    let count = 0;
    while (qcmp(expected, rangeEnd) < 0) {
      const piece = next();
      if (piece === undefined || piece.kind !== 'cubic-leaf' || piece.verb !== segment.verb) {
        bad(`expected a leaf of verb ${String(segment.verb)} at t=${String(qv(expected))}`);
        return { ok: false, last: prior };
      }
      const range = leafRange(piece);
      if (
        range === null ||
        !qeq(qn(piece.rangeStart), rangeStart) ||
        !qeq(qn(piece.rangeEnd), rangeEnd)
      ) {
        bad('leaf range differs from its subdivided range');
        return { ok: false, last: prior };
      }
      if (!qeq(range.t0, expected)) {
        bad(qcmp(range.t0, expected) > 0 ? 'leaf intervals leave a gap' : 'leaf intervals overlap');
        return { ok: false, last: prior };
      }
      if (prior !== null && !sameTriple(prior, piece.start))
        bad('adjacent leaves do not share the knot triple');
      if (count === 0 && !firstTriple.has(segment.verb)) firstTriple.set(segment.verb, piece.start);
      prior = piece.end;
      expected = range.t1;
      count += 1;
      cursor += 1;
    }
    if (!qeq(expected, rangeEnd)) bad('leaf intervals overrun their range');
    return { ok: true, last: prior };
  };

  for (const slot of p.slots) {
    if (slot.kind === 'cap') {
      const piece = next();
      if (
        piece === undefined ||
        piece.kind !== 'cap' ||
        piece.end !== slot.end ||
        piece.verb !== slot.segment.verb
      ) {
        bad(`expected the ${slot.end} cap of verb ${String(slot.segment.verb)}`);
        return { ok: false, findings };
      }
      cursor += 1;
      continue;
    }
    if (slot.kind === 'point-cap') {
      const piece = next();
      if (piece === undefined || piece.kind !== 'point-cap' || piece.subpath !== slot.subpath) {
        bad(`expected the point cap of subpath ${String(slot.subpath)}`);
        return { ok: false, findings };
      }
      cursor += 1;
      continue;
    }
    if (slot.kind === 'join') {
      const piece = next();
      const join = slot.join;
      if (
        piece === undefined ||
        piece.kind !== 'join' ||
        piece.incomingVerb !== join.incoming.verb ||
        piece.outgoingVerb !== join.outgoing.verb
      ) {
        bad(
          `expected the join between verbs ${String(join.incoming.verb)} and ${String(join.outgoing.verb)}`,
        );
        return { ok: false, findings };
      }
      if (piece.join !== join.piece)
        bad(`join kind ${piece.join} where the oracle decides ${join.piece}`);
      cursor += 1;
      continue;
    }
    const segment = slot.segment;
    const info = slot.info;
    if (info === null) {
      const piece = next();
      if (
        piece === undefined ||
        piece.kind !== 'line-sweep' ||
        piece.verb !== segment.verb ||
        piece.part !== 0
      ) {
        bad(`expected the sweep of line verb ${String(segment.verb)}`);
        return { ok: false, findings };
      }
      firstTriple.set(segment.verb, piece.start);
      lastTriple.set(segment.verb, piece.end);
      cursor += 1;
      continue;
    }
    if (info.kind === 'collinear') {
      for (let part = 0; part <= info.turning.length; part += 1) {
        if (part > 0) {
          const disk = next();
          if (disk === undefined || disk.kind !== 'cusp-disk' || disk.verb !== segment.verb) {
            bad(`expected a turning-point disk of verb ${String(segment.verb)}`);
            return { ok: false, findings };
          }
          cursor += 1;
        }
        const piece = next();
        if (
          piece === undefined ||
          piece.kind !== 'line-sweep' ||
          piece.verb !== segment.verb ||
          piece.part !== part
        ) {
          bad(`expected collinear sweep part ${String(part)} of verb ${String(segment.verb)}`);
          return { ok: false, findings };
        }
        if (part === 0) firstTriple.set(segment.verb, piece.start);
        lastTriple.set(segment.verb, piece.end);
        cursor += 1;
      }
      continue;
    }
    if (info.kind === 'cusp') {
      const root = info.root!;
      // The split t̃ is announced by the first range's end.
      const first = next();
      const split = first !== undefined && first.kind === 'cubic-leaf' ? qn(first.rangeEnd) : null;
      if (split === null || qcmp(qabs(qsub(split, root)), qpow2(-40)) > 0) {
        bad(
          `leaves of verb ${String(segment.verb)} are not split at the reversal t*=${String(qv(root))}`,
        );
        return { ok: false, findings };
      }
      const left = consumeLeaves(segment, Z, split, null);
      if (!left.ok) return { ok: false, findings };
      const disk = next();
      if (disk === undefined || disk.kind !== 'cusp-disk' || disk.verb !== segment.verb) {
        bad(`expected the cusp disk of verb ${String(segment.verb)}`);
        return { ok: false, findings };
      }
      if (!qeq(qn(disk.parameter), split)) bad('cusp disk parameter differs from the leaf split');
      cursor += 1;
      const right = consumeLeaves(segment, split, ONE, null);
      if (!right.ok) return { ok: false, findings };
      if (right.last !== null) lastTriple.set(segment.verb, right.last);
      continue;
    }
    const all = consumeLeaves(segment, Z, ONE, null);
    if (!all.ok) return { ok: false, findings };
    if (all.last !== null) lastTriple.set(segment.verb, all.last);
  }
  if (cursor !== pieces.length)
    bad('pieces beyond the oracle inventory (for example a join at a generated knot)');

  // Seams: joins and caps share the adjacent sweep samples; forward
  // continuations share the whole triple bit for bit.
  for (const join of p.joins) {
    const incoming = lastTriple.get(join.incoming.verb);
    const outgoing = firstTriple.get(join.outgoing.verb);
    if (incoming === undefined || outgoing === undefined) continue;
    if (join.turn === 'continuation') {
      if (!sameTriple(incoming, outgoing)) {
        findings.push(
          `continuation at verb ${String(join.outgoing.verb)} does not share the triple bit for bit`,
        );
      }
      continue;
    }
    const piece = pieces.find(
      (candidate): candidate is Extract<StrokeDumpPiece, { kind: 'join' }> =>
        candidate.kind === 'join' &&
        candidate.incomingVerb === join.incoming.verb &&
        candidate.outgoingVerb === join.outgoing.verb,
    );
    if (piece === undefined) continue;
    if (join.turn === 'reversal') {
      const pair = [piece.outerIn, piece.outerOut];
      if (
        !pair.some((point) => sameBits(point, incoming.minus)) ||
        !pair.some((point) => sameBits(point, incoming.plus))
      ) {
        findings.push(
          `reversal join at verb ${String(join.outgoing.verb)} does not use the incoming triple`,
        );
      }
      continue;
    }
    const side = join.outer!;
    if (
      !sameBits(piece.outerIn, tripleOuter(incoming, side)) ||
      !sameBits(piece.outerOut, tripleOuter(outgoing, side))
    ) {
      findings.push(
        `join at verb ${String(join.outgoing.verb)} does not share the sweep outer samples`,
      );
    }
  }
  for (const piece of pieces) {
    if (piece.kind !== 'cap') continue;
    const triple = piece.end === 'start' ? firstTriple.get(piece.verb) : lastTriple.get(piece.verb);
    if (triple !== undefined && !sameTriple(triple, piece.triple)) {
      findings.push(
        `${piece.end} cap of verb ${String(piece.verb)} does not share the sweep triple`,
      );
    }
  }
  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Exact polygon regions: slab decomposition of nonzero unions

type Edge = Readonly<{ ax: Q; ay: Q; bx: Q; by: Q; layer: 0 | 1; dir: 1 | -1 }>;

const MAX_REGION_EDGES = 4096;

function edgesOf(
  polygons: readonly (readonly QPoint[])[],
  layer: 0 | 1,
  out: Edge[],
  xs: Q[],
): void {
  for (const polygon of polygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const a = polygon[index]!;
      const b = polygon[(index + 1) % polygon.length]!;
      xs.push(a.x);
      const c = qcmp(a.x, b.x);
      if (c === 0) continue;
      out.push(
        c < 0
          ? { ax: a.x, ay: a.y, bx: b.x, by: b.y, layer, dir: 1 }
          : { ax: b.x, ay: b.y, bx: a.x, by: a.y, layer, dir: -1 },
      );
    }
  }
}

function yAt(edge: Edge, x: Q): Q {
  return qadd(
    edge.ay,
    qdiv(qmul(qsub(x, edge.ax), qsub(edge.by, edge.ay)), qsub(edge.bx, edge.ax)),
  );
}

/** Exact areas of the nonzero regions of two polygon layers and of their symmetric difference. */
function regionAreas(
  first: readonly (readonly QPoint[])[],
  second: readonly (readonly QPoint[])[],
): { first: Q; second: Q; xor: Q } {
  const edges: Edge[] = [];
  const xs: Q[] = [];
  edgesOf(first, 0, edges, xs);
  edgesOf(second, 1, edges, xs);
  if (edges.length > MAX_REGION_EDGES) fail('too many region edges for the exact oracle');
  for (let i = 0; i < edges.length; i += 1) {
    const e = edges[i]!;
    for (let j = i + 1; j < edges.length; j += 1) {
      const f = edges[j]!;
      if (qcmp(e.bx, f.ax) <= 0 || qcmp(f.bx, e.ax) <= 0) continue;
      const dex = qsub(e.bx, e.ax);
      const dey = qsub(e.by, e.ay);
      const dfx = qsub(f.bx, f.ax);
      const dfy = qsub(f.by, f.ay);
      const den = qsub(qmul(dex, dfy), qmul(dey, dfx));
      if (den.n === 0n) continue;
      const wx = qsub(f.ax, e.ax);
      const wy = qsub(f.ay, e.ay);
      const t = qdiv(qsub(qmul(wx, dfy), qmul(wy, dfx)), den);
      const u = qdiv(qsub(qmul(wx, dey), qmul(wy, dex)), den);
      if (qsgn(t) < 0 || qcmp(t, ONE) > 0 || qsgn(u) < 0 || qcmp(u, ONE) > 0) continue;
      xs.push(qadd(e.ax, qmul(t, dex)));
    }
  }
  xs.sort(qcmp);
  const unique = xs.filter((x, index) => index === 0 || !qeq(xs[index - 1]!, x));
  let a0 = Z;
  let a1 = Z;
  let ax = Z;
  for (let slab = 0; slab + 1 < unique.length; slab += 1) {
    const xa = unique[slab]!;
    const xb = unique[slab + 1]!;
    const active = edges
      .filter((edge) => qcmp(edge.ax, xa) <= 0 && qcmp(edge.bx, xb) >= 0)
      .map((edge) => ({ edge, key: qadd(yAt(edge, xa), yAt(edge, xb)) }))
      .sort((u, v) => qcmp(u.key, v.key));
    const width = qsub(xb, xa);
    const winding = [0, 0];
    for (let index = 0; index + 1 < active.length; index += 1) {
      const entry = active[index]!;
      winding[entry.edge.layer]! += entry.edge.dir;
      const height = qsub(active[index + 1]!.key, entry.key);
      if (height.n === 0n) continue;
      const area = qdiv(qmul(width, height), TWO);
      const in0 = winding[0] !== 0;
      const in1 = winding[1] !== 0;
      if (in0) a0 = qadd(a0, area);
      if (in1) a1 = qadd(a1, area);
      if (in0 !== in1) ax = qadd(ax, area);
    }
  }
  return { first: a0, second: a1, xor: ax };
}

function twiceSignedArea(polygon: readonly QPoint[]): Q {
  let twice = Z;
  for (let index = 0; index < polygon.length; index += 1) {
    twice = qadd(twice, pcross(polygon[index]!, polygon[(index + 1) % polygon.length]!));
  }
  return twice;
}

/** Exact area of the nonzero union of Float64 polygons (each listed counter-clockwise). */
export function strokePolygonUnionArea(polygons: readonly (readonly Point[])[]): StrokeExactArea {
  return exactArea(
    regionAreas(
      polygons.map((polygon) => polygon.map(qp)),
      [],
    ).first,
  );
}

// ---------------------------------------------------------------------------
// ST-O3 resolution

type MeshData = {
  vertices: QPoint[];
  triangles: QPoint[][];
  findings: string[];
  perimeter: number;
};

function inspectMesh(mesh: StrokeOracleMesh): MeshData {
  const findings: string[] = [];
  const positions = Array.from(mesh.positions);
  const indices = Array.from(mesh.indices);
  const boundary = Array.from(mesh.boundaryEdges);
  const empty: MeshData = { vertices: [], triangles: [], findings, perimeter: 0 };
  if (positions.length % 2 !== 0) return (findings.push('positions length is odd'), empty);
  if (indices.length % 3 !== 0)
    return (findings.push('indices length is not a multiple of 3'), empty);
  if (boundary.length % 2 !== 0) return (findings.push('boundaryEdges length is odd'), empty);
  const count = positions.length / 2;
  if (count === 0 || indices.length === 0)
    return (findings.push('an ok mesh has no triangles'), empty);
  if (
    [...indices, ...boundary].some(
      (index) => !Number.isInteger(index) || index < 0 || index >= count,
    )
  ) {
    return (findings.push('an index lies outside the vertices'), empty);
  }
  if (!positions.every(Number.isFinite)) return (findings.push('a position is not finite'), empty);
  const xs = positions.filter((_, index) => index % 2 === 0);
  const ys = positions.filter((_, index) => index % 2 === 1);
  const { bounds } = mesh;
  if (
    bounds.minX !== Math.min(...xs) ||
    bounds.minY !== Math.min(...ys) ||
    bounds.maxX !== Math.max(...xs) ||
    bounds.maxY !== Math.max(...ys)
  ) {
    findings.push('bounds differ from the vertex min/max');
  }
  const vertices = Array.from({ length: count }, (_, v) =>
    qp([positions[2 * v]!, positions[2 * v + 1]!]),
  );
  const triangles: QPoint[][] = [];
  for (let slot = 0; slot < indices.length; slot += 3) {
    const triangle = [
      vertices[indices[slot]!]!,
      vertices[indices[slot + 1]!]!,
      vertices[indices[slot + 2]!]!,
    ];
    if (orient(triangle[0]!, triangle[1]!, triangle[2]!) <= 0) {
      findings.push(`triangle ${String(slot / 3)} is not strictly positive`);
    }
    triangles.push(triangle);
  }
  if (findings.length > 0) return { vertices, triangles, findings, perimeter: 0 };

  // Interior-disjoint: the summed triangle area equals the area of their union.
  const sum = triangles.reduce(
    (total, triangle) => qadd(total, qdiv(twiceSignedArea(triangle), TWO)),
    Z,
  );
  const union = regionAreas(triangles, []).first;
  if (!qeq(sum, union)) findings.push('triangles overlap');

  const key = (a: number, b: number) => `${String(a)}>${String(b)}`;
  const undirected = new Map<string, number>();
  const directed: [number, number][] = [];
  for (let slot = 0; slot < indices.length; slot += 3) {
    for (let corner = 0; corner < 3; corner += 1) {
      const a = indices[slot + corner]!;
      const b = indices[slot + ((corner + 1) % 3)]!;
      directed.push([a, b]);
      const k = key(Math.min(a, b), Math.max(a, b));
      undirected.set(k, (undirected.get(k) ?? 0) + 1);
    }
  }
  const once = new Map<string, number>();
  let perimeter = 0;
  for (const [a, b] of directed) {
    if (undirected.get(key(Math.min(a, b), Math.max(a, b))) !== 1) continue;
    once.set(key(a, b), (once.get(key(a, b)) ?? 0) + 1);
    perimeter += Math.hypot(
      positions[2 * b]! - positions[2 * a]!,
      positions[2 * b + 1]! - positions[2 * a + 1]!,
    );
  }
  const listed = new Map<string, number>();
  for (let slot = 0; slot < boundary.length; slot += 2) {
    const k = key(boundary[slot]!, boundary[slot + 1]!);
    listed.set(k, (listed.get(k) ?? 0) + 1);
  }
  for (const k of new Set([...once.keys(), ...listed.keys()])) {
    if ((once.get(k) ?? 0) !== (listed.get(k) ?? 0)) {
      findings.push(`boundaryEdges differs from the edges used once at ${k}`);
      break;
    }
  }
  for (const k of undirected.keys()) {
    const [a, b] = k.split('>').map(Number) as [number, number];
    const start = vertices[a]!;
    const end = vertices[b]!;
    for (let v = 0; v < count; v += 1) {
      if (v === a || v === b) continue;
      const point = vertices[v]!;
      if (orient(start, end, point) !== 0) continue;
      const along = pdot(psub(point, start), psub(end, start));
      if (qsgn(along) > 0 && qcmp(along, pdot(psub(end, start), psub(end, start))) < 0) {
        findings.push(`vertex ${String(v)} hangs inside edge ${k}`);
        return { vertices, triangles, findings, perimeter };
      }
    }
  }
  return { vertices, triangles, findings, perimeter };
}

/**
 * ST-O3: the V2 mesh checks, and the mesh region against the exact nonzero
 * union of the emitted piece polygons. `exact` requires equal regions (and so
 * equal area and boundary); `band` requires `|area difference| <= perimeter·τ`.
 */
export function checkStrokeResolution(
  pieces: readonly StrokeDumpPiece[],
  mesh: StrokeOracleMesh,
  mode: 'exact' | 'band',
  tau: number,
): StrokeResolutionResult {
  const data = inspectMesh(mesh);
  const findings = [...data.findings];
  if (findings.length > 0) return { ok: false, findings, meshArea: null, unionArea: null };
  const polygons = pieces.flatMap((piece) =>
    piece.polygon === null ? [] : [piece.polygon.map(qp)],
  );
  const areas = regionAreas(polygons, data.triangles);
  if (mode === 'exact') {
    if (areas.xor.n !== 0n)
      findings.push(
        `mesh region differs from the piece union (symmetric difference ${String(qv(areas.xor))})`,
      );
  } else {
    const allowance = qmul(qn(data.perimeter * (1 + 2 ** -40)), qn(tau));
    if (qcmp(qabs(qsub(areas.first, areas.second)), allowance) > 0) {
      findings.push('mesh area differs from the piece union by more than perimeter times tau');
    }
  }
  return {
    ok: findings.length === 0,
    findings,
    meshArea: exactArea(areas.second),
    unionArea: exactArea(areas.first),
  };
}

// ---------------------------------------------------------------------------
// Ideal pieces, ST-O4 exact region and ST-O5 membership

/** Rational square root of a nonnegative rational, or null when irrational. */
function rationalSqrt(a: Q): Q | null {
  const n = isqrtBig(a.n);
  const d = isqrtBig(a.d);
  return n * n === a.n && d * d === a.d ? qr(n, d) : null;
}

type IdealBuild = { pieces: StrokeIdealPiece[]; exact: QPoint[][] | null };

function idealBuild(source: StrokeOracleSource): IdealBuild {
  const p = plan(source);
  const { r } = p;
  const pieces: StrokeIdealPiece[] = [];
  let exact: QPoint[][] | null = [];
  const rApprox = qv(r);
  const unit = (d: QPoint): { exact: QPoint | null; approx: Point } => {
    const length = rationalSqrt(pdot(d, d));
    const approxLength = Math.hypot(qv(d.x), qv(d.y));
    return {
      exact: length === null ? null : { x: qdiv(d.x, length), y: qdiv(d.y, length) },
      approx: [qv(d.x) / approxLength, qv(d.y) / approxLength],
    };
  };
  // A polygon given as base + Σ k_i·r·unit_i, exact when every unit is rational.
  const addPolygon = (
    role: string,
    corners: readonly { base: QPoint; terms: readonly [number, QPoint][] }[],
  ) => {
    const approx: Point[] = [];
    const exactCorners: QPoint[] = [];
    let isExact = true;
    for (const corner of corners) {
      let x = qv(corner.base.x);
      let y = qv(corner.base.y);
      let qx = corner.base.x;
      let qy = corner.base.y;
      for (const [k, d] of corner.terms) {
        const u = unit(d);
        x += k * rApprox * u.approx[0];
        y += k * rApprox * u.approx[1];
        if (u.exact === null) isExact = false;
        else {
          qx = qadd(qx, qmul(qmul(qi(k), r), u.exact.x));
          qy = qadd(qy, qmul(qmul(qi(k), r), u.exact.y));
        }
      }
      approx.push([x, y]);
      exactCorners.push({ x: qx, y: qy });
    }
    if (isExact) {
      const indices = hullIndices(exactCorners);
      if (indices === null) return;
      const hull = indices.map((index) => exactCorners[index]!);
      pieces.push({ kind: 'polygon', role, exact: true, polygon: hull.map(pv) });
      exact?.push(hull);
    } else {
      const hull = hullOf(approx);
      if (hull !== null) pieces.push({ kind: 'polygon', role, exact: false, polygon: hull });
      exact = null;
    }
  };
  const disk = (role: string, center: Point) => {
    pieces.push({ kind: 'disk', role, center, radius: rApprox });
    exact = null;
  };
  const sweep = (role: string, a: QPoint, b: QPoint, d: QPoint) => {
    const n = pperp(d);
    addPolygon(role, [
      { base: a, terms: [[-1, n]] },
      { base: b, terms: [[-1, n]] },
      { base: b, terms: [[1, n]] },
      { base: a, terms: [[1, n]] },
    ]);
  };
  if (r.n === 0n) return { pieces, exact };
  for (const slot of p.slots) {
    if (slot.kind === 'point-cap') {
      const c = qp(slot.point);
      if (source.cap === 'round') disk('point-cap', slot.point);
      else {
        const corners = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([sx, sy]) => ({
          base: { x: qadd(c.x, qmul(qi(sx!), r)), y: qadd(c.y, qmul(qi(sy!), r)) },
          terms: [],
        }));
        addPolygon('point-cap', corners);
      }
      continue;
    }
    if (slot.kind === 'cap') {
      if (source.cap === 'round') disk(`${slot.end}-cap`, slot.raw);
      else {
        const n = pperp(slot.d);
        const f = slot.end === 'end' ? slot.d : pneg(slot.d);
        addPolygon(`${slot.end}-cap`, [
          { base: slot.b, terms: [[-1, n]] },
          { base: slot.b, terms: [[1, n]] },
          {
            base: slot.b,
            terms: [
              [1, n],
              [1, f],
            ],
          },
          {
            base: slot.b,
            terms: [
              [-1, n],
              [1, f],
            ],
          },
        ]);
      }
      continue;
    }
    if (slot.kind === 'join') {
      const join = slot.join;
      if (join.piece === 'round') {
        disk('round-join', join.raw);
        continue;
      }
      const k = join.outer === 'plus' ? 1 : -1;
      const nIn = pperp(join.dIn);
      const nOut = pperp(join.dOut);
      const corners = [
        { base: join.b, terms: [] as [number, QPoint][] },
        { base: join.b, terms: [[k, nIn]] as [number, QPoint][] },
        { base: join.b, terms: [[k, nOut]] as [number, QPoint][] },
      ];
      if (join.piece === 'miter') {
        // T = B + r(n_in + n_out)/(1 + n_in·n_out), exact when both units are rational.
        const uIn = unit(nIn);
        const uOut = unit(nOut);
        const ax = k * (uIn.approx[0] + uOut.approx[0]);
        const ay = k * (uIn.approx[1] + uOut.approx[1]);
        const dotApprox = uIn.approx[0] * uOut.approx[0] + uIn.approx[1] * uOut.approx[1];
        if (uIn.exact !== null && uOut.exact !== null) {
          const sum = pscale(padd(uIn.exact, uOut.exact), qi(k));
          const factor = qdiv(r, qadd(ONE, pdot(uIn.exact, uOut.exact)));
          corners.push({ base: padd(join.b, pscale(sum, factor)), terms: [] });
        } else {
          const tip: Point = [
            qv(join.b.x) + (rApprox * ax) / (1 + dotApprox),
            qv(join.b.y) + (rApprox * ay) / (1 + dotApprox),
          ];
          corners.push({ base: qp(tip), terms: [] });
          exact = null;
        }
      }
      addPolygon(`${join.piece}-join`, corners);
      continue;
    }
    const segment = slot.segment;
    const info = slot.info;
    if (info === null) {
      sweep('line-sweep', segment.q[0]!, segment.q[1]!, psub(segment.q[1]!, segment.q[0]!));
      continue;
    }
    if (info.kind !== 'collinear') {
      pieces.push({ kind: 'curve-sweep', role: 'cubic-sweep', verb: segment.verb });
      exact = null;
      if (info.kind === 'cusp') disk('cusp-disk', pv(evalPoint(info.pw, info.root!)));
      continue;
    }
    // Turning points lie in Q(√s); an irrational one is approximated and makes the region inexact.
    const knots: QPoint[] = [
      segment.q[0]!,
      ...info.turning.map((turning) => {
        if (turning.point.x.b.n === 0n && turning.point.y.b.n === 0n)
          return { x: turning.point.x.a, y: turning.point.y.a };
        exact = null;
        return qp([qsApprox(turning.point.x, turning.s), qsApprox(turning.point.y, turning.s)]);
      }),
      segment.q[3]!,
    ];
    for (let part = 0; part + 1 < knots.length; part += 1) {
      sweep('collinear-sweep', knots[part]!, knots[part + 1]!, info.direction);
      if (part + 1 < knots.length - 1) disk('turning-disk', pv(knots[part + 1]!));
    }
  }
  return { pieces, exact };
}

/** The ideal stroke-region pieces of section 2.2 as the oracle builds them from the source. */
export function idealStrokePieces(source: StrokeOracleSource): readonly StrokeIdealPiece[] {
  return idealBuild(source).pieces;
}

/** Exact area of the ideal region when every ideal piece is an exact polygon, else null. */
export function idealStrokeExactArea(source: StrokeOracleSource): StrokeExactArea | null {
  const exact = idealBuild(source).exact;
  return exact === null ? null : exactArea(regionAreas(exact, []).first);
}

/**
 * ST-O4: on a fixture whose ideal pieces are exact polygons, the mesh region
 * (and so its area and boundary) equals the ideal union exactly.
 */
export function checkStrokeExactRegion(
  source: StrokeOracleSource,
  mesh: StrokeOracleMesh,
): StrokeExactRegionResult {
  const exact = idealBuild(source).exact;
  if (exact === null)
    return {
      ok: false,
      findings: ['the ideal region is not an exact polygon union'],
      idealArea: null,
    };
  const data = inspectMesh(mesh);
  const findings = [...data.findings];
  if (findings.length > 0) return { ok: false, findings, idealArea: null };
  const areas = regionAreas(exact, data.triangles);
  if (areas.xor.n !== 0n)
    findings.push(
      `mesh region differs from the ideal union (symmetric difference ${String(qv(areas.xor))})`,
    );
  return { ok: findings.length === 0, findings, idealArea: exactArea(areas.first) };
}

/** ST-O5: named points inside or outside the mesh region, decided exactly on its closed triangles. */
export function checkStrokeMembership(
  mesh: StrokeOracleMesh,
  points: readonly Readonly<{ point: Point; inside: boolean }>[],
): StrokeOracleResult {
  const positions = Array.from(mesh.positions);
  const indices = Array.from(mesh.indices);
  const vertex = (index: number): QPoint => qp([positions[2 * index]!, positions[2 * index + 1]!]);
  const findings: string[] = [];
  for (const { point, inside } of points) {
    const q = qp(point);
    let found = false;
    for (let slot = 0; slot + 2 < indices.length && !found; slot += 3) {
      const a = vertex(indices[slot]!);
      const b = vertex(indices[slot + 1]!);
      const c = vertex(indices[slot + 2]!);
      found = orient(a, b, q) >= 0 && orient(b, c, q) >= 0 && orient(c, a, q) >= 0;
    }
    if (found !== inside) {
      findings.push(
        `(${String(point[0])},${String(point[1])}) is ${found ? 'inside' : 'outside'}, expected ${inside ? 'inside' : 'outside'}`,
      );
    }
  }
  return { ok: findings.length === 0, findings };
}

// ---------------------------------------------------------------------------
// Named fixtures ST-F1 to ST-F26 (contract section 11.2)

export type StrokeFixtureStatus =
  | 'ok'
  | 'empty'
  | 'numeric-range'
  | 'work-limit'
  /** `ok` or `work-limit`, listed by the unit that runs it (ST-F15). */
  | 'ok-or-work-limit'
  /** At a current cap: `ok` or another listed status (ST-F26). */
  | 'ok-or-listed';

export type StrokeFixtureExpectation = Readonly<{
  status: StrokeFixtureStatus;
  /** Mesh-region area. */
  area?: number;
  /** 0 for an exact area; 1e-12 absolute for disk polygons and irrational normals. */
  areaTolerance?: number;
  bounds?: readonly [minX: number, minY: number, maxX: number, maxY: number];
  /** The ideal pieces are exact polygons and ST-O4 applies. */
  exactRegion?: boolean;
  inside?: readonly Point[];
  outside?: readonly Point[];
  /** Disk polygon vertex count `n`. */
  diskVertices?: number;
  /** The join piece the oracle decides at the path's only join. */
  join?: 'none' | StrokeJoin;
  /** Ideal miter tip; the emitted tip lies within `g_tip` of it. */
  tip?: Point;
  /** Oracle classification of the path's cubic. */
  cubic?: StrokeCubicClass['kind'];
  note?: string;
}>;

export type StrokeFixture = Readonly<{
  /** Unique case name, for example `ST-F4/miter-2`. */
  id: string;
  fixture: string;
  source: StrokeOracleSource;
  expected: StrokeFixtureExpectation;
}>;

/** Area of the 16-gon at r = 1, and its half and quarter (section 11.2). */
export const STROKE_16GON_AREA = 3.0614674589207183;
export const STROKE_16GON_HALF = 1.5307337294603591;
export const STROKE_16GON_QUARTER = 0.7653668647301796;

type Command =
  | readonly ['M' | 'L', number, number]
  | readonly ['C', number, number, number, number, number, number]
  | readonly ['Z'];

function pathOf(commands: readonly Command[]): { verbs: number[]; points: number[] } {
  const verbs: number[] = [];
  const points: number[] = [];
  for (const command of commands) {
    const [name, ...values] = command;
    verbs.push(
      name === 'M' ? VERB_MOVE : name === 'L' ? VERB_LINE : name === 'C' ? VERB_CUBIC : VERB_CLOSE,
    );
    points.push(...values);
  }
  return { verbs, points };
}

function strokeSource(
  commands: readonly Command[],
  width: number,
  cap: StrokeCap,
  join: StrokeJoin,
  miterLimit: number,
  toleranceExponent = -3,
): StrokeOracleSource {
  return { ...pathOf(commands), width, cap, join, miterLimit, toleranceExponent };
}

const CAPS: readonly StrokeCap[] = ['butt', 'round', 'square'];
const JOINS: readonly StrokeJoin[] = ['miter', 'round', 'bevel'];

function nextUp(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
}

/** Largest Float64 radius whose disk at `‖c‖∞ = center` still has `n <= 256` at `e`. */
function largestRadiusWith256(toleranceExponent: number, center: number): number {
  let low = 1;
  let high = 4096;
  for (let step = 0; step < 200; step += 1) {
    const mid = (low + high) / 2;
    if (mid === low || mid === high) break;
    if (strokeDiskVertexCount(mid, toleranceExponent, center) !== null) low = mid;
    else high = mid;
  }
  while (strokeDiskVertexCount(nextUp(low), toleranceExponent, center) !== null) low = nextUp(low);
  return low;
}

/** Axis-aligned staircase from (x, y): `count` steps of 4 alternating +x and +y, all 90° turns. */
function staircase(x: number, y: number, count: number): Command[] {
  const commands: Command[] = [['M', x, y]];
  let cx = x;
  let cy = y;
  for (let step = 0; step < count; step += 1) {
    if (step % 2 === 0) cx += 4;
    else cy += 4;
    commands.push(['L', cx, cy]);
  }
  return commands;
}

/** The s2 regular families R1-R6 with their stated widths. */
export const STROKE_S2_FAMILIES: readonly Readonly<{
  name: string;
  controls: readonly Point[];
  width: number;
}>[] = [
  {
    name: 'R1',
    controls: [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ],
    width: 2,
  },
  {
    name: 'R2',
    controls: [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ],
    width: 64,
  },
  {
    name: 'R3',
    controls: [
      [0, 0],
      [1, 0],
      [2, 1 / 64],
      [3, 3 / 64],
    ],
    width: 2,
  },
  {
    name: 'R4',
    controls: [
      [0, 0],
      [1, 0],
      [2, 1 / 64],
      [3, 3 / 64],
    ],
    width: 64,
  },
  {
    name: 'R5',
    controls: [
      [0, 0],
      [1, 1],
      [2, -1],
      [3, 0],
    ],
    width: 2,
  },
  {
    name: 'R6',
    controls: [
      [3, -3 / 64],
      [-1, -1 / 64],
      [-1, 1 / 64],
      [3, 3 / 64],
    ],
    width: 2,
  },
];

/** `e = floor(log2(0.125 / (zoom·DPR)))` at the nine s2 pairs, zoom 0.01/1/64 by DPR 1/2/3. */
export const STROKE_S2_EXPONENTS: readonly Readonly<{ zoom: number; dpr: number; e: number }>[] = [
  { zoom: 0.01, dpr: 1, e: 3 },
  { zoom: 0.01, dpr: 2, e: 2 },
  { zoom: 0.01, dpr: 3, e: 2 },
  { zoom: 1, dpr: 1, e: -3 },
  { zoom: 1, dpr: 2, e: -4 },
  { zoom: 1, dpr: 3, e: -5 },
  { zoom: 64, dpr: 1, e: -9 },
  { zoom: 64, dpr: 2, e: -10 },
  { zoom: 64, dpr: 3, e: -11 },
];

function buildFixtures(): StrokeFixture[] {
  const out: StrokeFixture[] = [];
  const add = (id: string, source: StrokeOracleSource, expected: StrokeFixtureExpectation) =>
    out.push({ id, fixture: id.split('/')[0]!, source, expected });
  const line: Command[] = [
    ['M', 0, 0],
    ['L', 4, 0],
  ];
  const corner: Command[] = [
    ['M', 0, 0],
    ['L', 4, 0],
    ['L', 4, 4],
  ];
  const exact = (
    area: number,
    extra: Partial<StrokeFixtureExpectation> = {},
  ): StrokeFixtureExpectation => ({
    status: 'ok',
    area,
    areaTolerance: 0,
    exactRegion: true,
    ...extra,
  });
  const approx = (
    area: number,
    extra: Partial<StrokeFixtureExpectation> = {},
  ): StrokeFixtureExpectation => ({
    status: 'ok',
    area,
    areaTolerance: 1e-12,
    ...extra,
  });

  add('ST-F1', strokeSource(line, 2, 'butt', 'miter', 4), exact(8, { bounds: [0, -1, 4, 1] }));
  add('ST-F2', strokeSource(line, 2, 'square', 'miter', 4), exact(12, { bounds: [-1, -1, 5, 1] }));
  add(
    'ST-F3',
    strokeSource(line, 2, 'round', 'miter', 4),
    approx(8 + STROKE_16GON_AREA, { diskVertices: 16 }),
  );

  add(
    'ST-F4/miter-2',
    strokeSource(corner, 2, 'butt', 'miter', 2),
    exact(16, { join: 'miter', tip: [5, -1] }),
  );
  add('ST-F4/miter-1', strokeSource(corner, 2, 'butt', 'miter', 1), exact(15.5, { join: 'bevel' }));
  add('ST-F4/bevel', strokeSource(corner, 2, 'butt', 'bevel', 4), exact(15.5, { join: 'bevel' }));
  add(
    'ST-F4/round',
    strokeSource(corner, 2, 'butt', 'round', 4),
    approx(15 + STROKE_16GON_QUARTER, { join: 'round', diskVertices: 16 }),
  );

  const turn5: Command[] = [
    ['M', 0, 0],
    ['L', 25, 0],
    ['L', 32, 24],
  ];
  add('ST-F5/limit-1.25', strokeSource(turn5, 2, 'butt', 'miter', 1.25), {
    status: 'ok',
    join: 'miter',
    tip: [25.75, -1],
    note: 'ratio exactly 5/4; equality keeps the miter',
  });
  add('ST-F5/limit-below', strokeSource(turn5, 2, 'butt', 'miter', 1.2499999999999998), {
    status: 'ok',
    join: 'bevel',
  });
  add('ST-F5/limit-above', strokeSource(turn5, 2, 'butt', 'miter', 1.2500000000000002), {
    status: 'ok',
    join: 'miter',
    tip: [25.75, -1],
  });

  const back: Command[] = [
    ['M', 0, 0],
    ['L', 4, 0],
    ['L', 0, 0],
  ];
  add(
    'ST-F6/miter-4',
    strokeSource(back, 2, 'butt', 'miter', 4),
    exact(8, { bounds: [0, -1, 4, 1], join: 'none' }),
  );
  add(
    'ST-F6/bevel',
    strokeSource(back, 2, 'butt', 'bevel', 4),
    exact(8, { bounds: [0, -1, 4, 1], join: 'none' }),
  );
  add(
    'ST-F6/round',
    strokeSource(back, 2, 'butt', 'round', 4),
    approx(8 + STROKE_16GON_HALF, { join: 'round', diskVertices: 16 }),
  );

  for (const cap of CAPS) {
    for (const join of JOINS) {
      add(`ST-F7/${cap}-${join}`, strokeSource([['M', 4, 5]], 2, cap, join, 4), {
        status: 'empty',
      });
    }
  }
  const dot: Command[] = [
    ['M', 4, 5],
    ['L', 4, 5],
  ];
  add('ST-F8/butt', strokeSource(dot, 2, 'butt', 'miter', 4), { status: 'empty' });
  add(
    'ST-F8/round',
    strokeSource(dot, 2, 'round', 'miter', 4),
    approx(STROKE_16GON_AREA, { diskVertices: 16 }),
  );
  add(
    'ST-F8/square',
    strokeSource(dot, 2, 'square', 'miter', 4),
    exact(4, { bounds: [3, 4, 5, 6] }),
  );
  for (const cap of CAPS) {
    for (const join of JOINS) {
      add(
        `ST-F9/${cap}-${join}`,
        strokeSource([['M', 4, 5], ['L', 4, 5], ['Z']], 2, cap, join, 4),
        { status: 'empty' },
      );
    }
  }

  add(
    'ST-F10',
    strokeSource(
      [
        ['M', 0, 0],
        ['L', 4, 0],
        ['L', 4, 0],
        ['L', 4, 4],
      ],
      2,
      'butt',
      'miter',
      2,
    ),
    exact(16, { join: 'miter' }),
  );

  const square: Command[] = [['M', 0, 0], ['L', 4, 0], ['L', 4, 4], ['L', 0, 4], ['Z']];
  for (const cap of CAPS) {
    add(
      `ST-F11/miter-2-${cap}`,
      strokeSource(square, 2, cap, 'miter', 2),
      exact(32, {
        bounds: [-1, -1, 5, 5],
        note: 'region [-1,5]² minus (1,3)²; the cap has no effect',
      }),
    );
    add(`ST-F11/bevel-${cap}`, strokeSource(square, 2, cap, 'bevel', 4), exact(30));
    add(
      `ST-F11/round-${cap}`,
      strokeSource(square, 2, cap, 'round', 4),
      approx(28 + STROKE_16GON_AREA, { diskVertices: 16 }),
    );
  }

  add(
    'ST-F12',
    strokeSource(
      [
        ['M', 0, 0],
        ['L', 8, 0],
        ['L', 0, 8],
      ],
      2,
      'butt',
      'bevel',
      4,
    ),
    {
      status: 'ok',
      inside: [
        [4, 4],
        [4, 0.5],
      ],
      outside: [
        [0, 4],
        [-0.5, 4],
      ],
      note: 'the implicit closing edge is not stroked',
    },
  );
  add(
    'ST-F13',
    strokeSource(
      [
        ['M', 0, 0],
        ['L', 3, 1],
        ['L', 12, 4],
      ],
      2,
      'butt',
      'miter',
      4,
    ),
    approx(2 * Math.sqrt(160), {
      join: 'none',
      note: 'forward continuation: the outgoing start triple equals the incoming end triple bit for bit; one boundary loop',
    }),
  );
  add(
    'ST-F14/a',
    strokeSource(
      [
        ['M', 0, 2],
        ['L', 4, 2],
        ['M', 2, 0],
        ['L', 2, 4],
      ],
      2,
      'butt',
      'miter',
      4,
    ),
    exact(12),
  );
  add(
    'ST-F14/b',
    strokeSource(
      [
        ['M', 0, 2],
        ['L', 4, 2],
        ['L', 4, 4],
        ['L', 2, 4],
        ['L', 2, 0],
      ],
      2,
      'butt',
      'miter',
      2,
    ),
    exact(20, {
      note: 'three unit miter squares; no overlap counted twice',
    }),
  );

  for (const family of STROKE_S2_FAMILIES) {
    const [p0, p1, p2, p3] = family.controls as [Point, Point, Point, Point];
    for (const { zoom, dpr, e } of STROKE_S2_EXPONENTS) {
      const required =
        family.name === 'R1' ||
        family.name === 'R2' ||
        ((family.name === 'R3' || family.name === 'R4') && e === -3);
      add(
        `ST-F15/${family.name}-zoom${String(zoom)}-dpr${String(dpr)}`,
        strokeSource(
          [
            ['M', p0[0], p0[1]],
            ['C', p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]],
          ],
          family.width,
          'butt',
          'miter',
          4,
          e,
        ),
        { status: required ? 'ok' : 'ok-or-work-limit', note: 'ST-O1 passes on every ok' },
      );
    }
  }

  add(
    'ST-F16',
    strokeSource(
      [
        ['M', 0, 0],
        ['C', 1, 1, 0, 1, 1, 0],
      ],
      0.125,
      'butt',
      'miter',
      4,
      -8,
    ),
    {
      status: 'ok',
      cubic: 'cusp',
      diskVertices: 32,
      inside: [[0.5, 0.8]],
      note: 'one interior reversal at t* = 1/2; cusp center exactly (0.5, 0.75)',
    },
  );
  const f17: Command[] = [
    ['M', 3, 0],
    ['C', -1, 0, -1, 0, 3, 0],
  ];
  add(
    'ST-F17/butt',
    strokeSource(f17, 2, 'butt', 'miter', 4),
    approx(6 + STROKE_16GON_HALF, { cubic: 'collinear', note: 'one turning point at (0,0)' }),
  );
  add(
    'ST-F17/square',
    strokeSource(f17, 2, 'square', 'miter', 4),
    approx(8 + STROKE_16GON_HALF, { cubic: 'collinear' }),
  );
  add(
    'ST-F17/round',
    strokeSource(f17, 2, 'round', 'miter', 4),
    approx(6 + STROKE_16GON_AREA, { cubic: 'collinear' }),
  );
  const f18: Command[] = [
    ['M', 0, 0],
    ['C', 0, 0, 1, 0, 3, 1],
  ];
  add('ST-F18', strokeSource(f18, 2, 'square', 'miter', 4), {
    status: 'ok',
    cubic: 'endpoint-stationary',
    inside: [[-0.9, 0.9]],
    outside: [
      [-1.1, 0],
      [-0.5, 1.1],
    ],
    note: 'start tangent (1,0); stationary start on the first leaf reduced cone',
  });
  const f19: Command[] = [
    ['M', -1, 0],
    ['C', 1, 0, -1, 0, 1, 0],
  ];
  add(
    'ST-F19',
    strokeSource(f19, 2, 'butt', 'miter', 4),
    exact(4, {
      bounds: [-1, -1, 1, 1],
      cubic: 'collinear',
      note: 'collinear continuation at t = 1/2, no cusp disk',
    }),
  );
  for (const cap of CAPS) {
    add(`ST-F20/endpoint-${cap}`, strokeSource(f18, 2, cap, 'miter', 4), {
      status: 'ok',
      cubic: 'endpoint-stationary',
    });
    add(`ST-F20/reversal-${cap}`, strokeSource(f17, 2, cap, 'miter', 4), {
      status: 'ok',
      cubic: 'collinear',
      note: 'collinear reversal',
    });
    add(`ST-F20/continuation-${cap}`, strokeSource(f19, 2, cap, 'miter', 4), {
      status: 'ok',
      cubic: 'collinear',
      note: 'collinear continuation',
    });
  }

  add('ST-F21', strokeSource(line, 2 ** -20, 'butt', 'miter', 4), exact(2 ** -18));
  add(
    'ST-F22',
    strokeSource(
      [
        ['M', 2 ** 40, 2 ** 40],
        ['L', 2 ** 40 + 1, 2 ** 40 + 1],
      ],
      2 ** -41,
      'butt',
      'miter',
      4,
    ),
    {
      status: 'empty',
      note: 'collapse, section 4.7',
    },
  );
  add(
    'ST-F23',
    strokeSource(
      [
        ['M', 2 ** 60, 0],
        ['L', 2 ** 60 + 2 ** 20, 0],
      ],
      2,
      'butt',
      'miter',
      4,
    ),
    { status: 'numeric-range', note: 'ST-G1' },
  );
  const f24: Command[] = [
    ['M', 0, 0],
    ['L', 1, 0],
    ['L', 0, 2 ** -20],
  ];
  add('ST-F24/limit-2^30', strokeSource(f24, 2, 'butt', 'miter', 2 ** 30), {
    status: 'numeric-range',
    join: 'miter',
    note: 'miter kept; ST-G3',
  });
  add('ST-F24/limit-4', strokeSource(f24, 2, 'butt', 'miter', 4), { status: 'ok', join: 'bevel' });

  // ST-F25: miter exactly where the ratio is at most L. Ratios squared are
  // 2, 25/9 and 50; the decision below compares them with L² exactly.
  const turns: readonly (readonly [string, Command[], Q])[] = [
    ['90', corner, qi(2)],
    [
      '5-3',
      [
        ['M', 0, 0],
        ['L', 25, 0],
        ['L', 18, 24],
      ],
      qr(25n, 9n),
    ],
    [
      'sqrt50',
      [
        ['M', 0, 0],
        ['L', 25, 0],
        ['L', 1, 7],
      ],
      qi(50),
    ],
  ];
  const limits: readonly (readonly [string, number])[] = [
    ['1', 1],
    ['SQRT2', Math.SQRT2],
    ['4', 4],
    ['100', 100],
  ];
  for (const [name, commands, ratioSquared] of turns) {
    for (const [limitName, limit] of limits) {
      const kept = qcmp(ratioSquared, qsq(qn(limit))) <= 0;
      add(`ST-F25/${name}-L${limitName}`, strokeSource(commands, 2, 'butt', 'miter', limit), {
        status: 'ok',
        join: kept ? 'miter' : 'bevel',
      });
    }
  }

  // ST-F26, labelled current-cap fixtures that a limit raise may re-baseline.
  // Pieces are sweeps + joins (+ caps). Input edges assume one arrangement edge
  // per emitted contour vertex on axis-aligned data: 6 per line sweep (the
  // collinear end points stay on the hull), 3 per bevel, 5 per square cap.
  add(
    'ST-F26/pieces-512',
    strokeSource([...staircase(0, 0, 256), ['M', 0, -8], ['L', 4, -8]], 2, 'butt', 'bevel', 4),
    {
      status: 'ok-or-listed',
      note: 'current cap: 512 pieces (256 + 255 + 1); the input-edge cap is expected to stop it first',
    },
  );
  add('ST-F26/pieces-513', strokeSource(staircase(0, 0, 257), 2, 'butt', 'bevel', 4), {
    status: 'work-limit',
    note: 'current cap: 513 pieces',
  });
  add('ST-F26/edges-1024', strokeSource(staircase(0, 0, 113), 2, 'square', 'bevel', 4), {
    status: 'ok-or-listed',
    note: 'current cap: 6·113 + 3·112 + 2·5 = 1,024 input edges',
  });
  const fiveSubpaths: Command[] = [
    ...staircase(0, 0, 106),
    ...[1, 2, 3, 4].flatMap((k): Command[] => [
      ['M', 0, -8 * k],
      ['L', 4, -8 * k],
    ]),
  ];
  add('ST-F26/edges-1025', strokeSource(fiveSubpaths, 2, 'square', 'bevel', 4), {
    status: 'work-limit',
    note: 'current cap: (6·106 + 3·105 + 10) + 4·(6 + 10) = 1,025 input edges',
  });
  const r256 = largestRadiusWith256(-3, 4);
  add('ST-F26/disk-256', strokeSource(line, 2 * r256, 'round', 'miter', 4), {
    status: 'ok-or-listed',
    diskVertices: 256,
    note: 'current cap: n = 256',
  });
  add('ST-F26/disk-512', strokeSource(line, 2 * nextUp(r256), 'round', 'miter', 4), {
    status: 'work-limit',
    note: 'the next width needs n = 512 (DiskLimit)',
  });
  return out;
}

/** Every named fixture case of section 11.2 with its literal expectation, fixed before execution. */
export const STROKE_FIXTURES: readonly StrokeFixture[] = Object.freeze(buildFixtures());
