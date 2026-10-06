import type { ProjectionInput, ProjectionPoint } from '../mesh-projection/model.js';
import { bitsOf, rational, type Rational } from '../rounded-fill/exact.js';

/**
 * P3.1m N02: independent adversarial binary32 evaluator for the frozen L02 `projectVertex`
 * expression family F (docs/plans/p3-position-certificate-contract.md, M06 "N02 scope"). It
 * never imports N01. Lanes are recomputed here from K's CPU graph, every rounded binary32
 * operation is performed on exact dyadic BigInt `(mantissa, exponent)` values, and division by
 * the integer size lane uses an exact BigInt quotient and remainder.
 *
 * Resolved conventions (documented for review):
 * - y axis: a sum node that contains the constant 1 is written `left - right` with the
 *   constant-free child subtracted; constant-free nodes are positive sums of t_j, as in
 *   `1 - (py * 2) / H`. Adversarial derivative signs follow this orientation.
 * - Extremal division under round-to-nearest-even pushes away from P*: the direction is the sign
 *   of (quotient of the computed numerator - exact lane-ideal quotient); for the `1/W` operand it
 *   is sign(computed numerator - ideal numerator) * sign(computed numerator). Ties push the
 *   magnitude up.
 * - ULP(x) follows WGSL: 2^(e-23) inside a binade, 2^(e-24) at an exact power of two, 2^-149
 *   below 2^-126 (and for x = 0).
 */

type Dy = Readonly<{ m: bigint; e: number }>;
type F32 = Readonly<{ m: bigint; e: number; v: number }>;
type Mode = 'rne' | 'up' | 'down' | 'zero';
type Rounding = 'rne' | 'up' | 'down' | 'zero' | 'adv+' | 'adv-';
type Context = Readonly<{ rounding: Rounding; ftz: boolean; extremal: boolean }>;

export const ROUNDINGS: readonly Rounding[] = ['rne', 'up', 'down', 'zero', 'adv+', 'adv-'];
export const EVALUATIONS_PER_VERTEX_AXIS = 5400;

const MIN_NORMAL = 2 ** -126;
const TINY_EXPONENT = -179;
const float64 = new DataView(new ArrayBuffer(8));

function decode(value: number): Dy {
  if (!Number.isFinite(value)) throw new Error(`n02:nonfinite:${value}`);
  const bits = bitsOf(value);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0x000fffffffffffffn;
  const magnitude = exponent === 0 ? fraction : fraction | 0x0010000000000000n;
  const signed = bits >> 63n === 1n ? -magnitude : magnitude;
  return { m: signed, e: (exponent === 0 ? 1 : exponent) - 1075 };
}

function lane(value: number): F32 {
  if (Math.fround(value) !== value) throw new Error(`n02:not-binary32:${value}`);
  return { ...decode(value), v: value };
}

function bitLength(m: bigint): number {
  if (m === 0n) return 0;
  const n = Number(m);
  if (!Number.isFinite(n)) return m.toString(2).length;
  float64.setFloat64(0, n);
  const estimate = ((float64.getUint16(0) >> 4) & 0x7ff) - 1023;
  return m >> BigInt(estimate) === 0n ? estimate : estimate + 1;
}

const shiftLeft = (m: bigint, by: number) => (by === 0 ? m : m << BigInt(by));

function addDy(a: Dy, b: Dy): Dy {
  if (a.m === 0n) return b;
  if (b.m === 0n) return a;
  const e = Math.min(a.e, b.e);
  return { m: shiftLeft(a.m, a.e - e) + shiftLeft(b.m, b.e - e), e };
}

function negDy(a: Dy): Dy {
  return { m: -a.m, e: a.e };
}

function mulDy(a: Dy, b: Dy): Dy {
  return { m: a.m * b.m, e: a.e + b.e };
}

function signDy(a: Dy): -1 | 0 | 1 {
  return a.m < 0n ? -1 : a.m > 0n ? 1 : 0;
}

function compareDy(a: Dy, b: Dy): -1 | 0 | 1 {
  return signDy(addDy(a, negDy(b)));
}

function toRational(a: Dy): Rational {
  return a.e >= 0 ? rational(a.m << BigInt(a.e)) : rational(a.m, 1n << BigInt(-a.e));
}

function f32(m: bigint, e: number): F32 {
  return { m, e, v: Number(m) * 2 ** e };
}

/**
 * Round sign * (M + theta) * 2^e to binary32 with gradual underflow, where theta in [0, 1) is
 * nonzero exactly when `sticky`. The caller guarantees the rounding position lies above e.
 */
function roundParts(negative: boolean, M: bigint, e: number, sticky: boolean, mode: Mode): F32 {
  if (M === 0n && !sticky) return f32(0n, 0);
  const qe = Math.max(bitLength(M) + e - 24, -149);
  if (qe <= e) {
    if (sticky) throw new Error('n02:insufficient-precision');
    return f32(negative ? -M : M, e);
  }
  const shift = BigInt(qe - e);
  let T = M >> shift;
  const remainder = M - (T << shift);
  const half = 1n << (shift - 1n);
  const inexact = remainder !== 0n || sticky;
  const position = remainder > half ? 1 : remainder < half ? -1 : sticky ? 1 : 0;
  const up =
    mode === 'rne'
      ? position > 0 || (position === 0 && (T & 1n) === 1n)
      : mode === 'up'
        ? inexact && !negative
        : mode === 'down'
          ? inexact && negative
          : false;
  if (up) T += 1n;
  if (bitLength(T) + qe > 128) throw new Error('n02:overflow');
  return f32(negative ? -T : T, qe);
}

function roundDy(x: Dy, mode: Mode): F32 {
  return roundParts(x.m < 0n, x.m < 0n ? -x.m : x.m, x.e, false, mode);
}

/** Round sign(N) * |N| / W * 2^t, with t <= TINY_EXPONENT so precision always suffices. */
function roundQuotient(N: bigint, W: bigint, t: number, mode: Mode): F32 {
  const negative = N < 0n;
  const magnitude = negative ? -N : N;
  const Q = magnitude / W;
  return roundParts(negative, Q, t, Q * W !== magnitude, mode);
}

function flush(value: F32, ftz: boolean): F32 {
  return ftz && value.m !== 0n && Math.abs(value.v) < MIN_NORMAL ? f32(0n, 0) : value;
}

const ONE: F32 = lane(1);
const TWO: F32 = lane(2);

/** Exact original-input reference R (K formula) in physical pixels. */
function reference(input: ProjectionInput, vertex: number, axis: 0 | 1): Dy {
  const [x, y] = input.mesh.vertices[vertex]!.map(decode) as [Dy, Dy];
  const affine = input.affine.map(decode);
  const [p, r, t] =
    axis === 0 ? [affine[0]!, affine[2]!, affine[4]!] : [affine[1]!, affine[3]!, affine[5]!];
  const sum = addDy(addDy(addDy(mulDy(p, x), mulDy(r, y)), t), negDy(decode(input.camera[axis])));
  return mulDy(mulDy(sum, decode(input.zoom)), decode(input.dpr));
}

type Lanes = Readonly<{
  p: F32;
  r: F32;
  ux: F32;
  uy: F32;
  B: F32;
  F: F32;
  z: F32;
  q: F32;
  size: number;
}>;

/** K's frozen CPU graph, recomputed independently with the supplied origin. */
function lanes(
  input: ProjectionInput,
  origin: ProjectionPoint,
  vertex: number,
  axis: 0 | 1,
): Lanes {
  const f = Math.fround;
  const vertices = input.mesh.vertices;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of vertices) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const mid = [minX / 2 + maxX / 2, minY / 2 + maxY / 2] as const;
  const [vx, vy] = vertices[vertex]!;
  const [a, b, c, d, e, g] = input.affine;
  const anchor = axis === 0 ? a * mid[0] + c * mid[1] + e : b * mid[0] + d * mid[1] + g;
  return {
    p: lane(f(axis === 0 ? a : b)),
    r: lane(f(axis === 0 ? c : d)),
    ux: lane(f(vx - mid[0])),
    uy: lane(f(vy - mid[1])),
    B: lane(f(anchor - origin[axis])),
    F: lane(f(origin[axis] - input.camera[axis])),
    z: lane(f(input.zoom)),
    q: lane(f(input.dpr)),
    size: axis === 0 ? input.width : input.height,
  };
}

/** All unordered full binary trees over a leaf set, sharing subtrees by id. */
type Tree = Readonly<{ leaves: number; left: number; right: number; leaf: number }>;

function buildTrees(count: number): { nodes: Tree[]; roots: number[] } {
  const nodes: Tree[] = [];
  const bySet = new Map<number, number[]>();
  const of = (set: number): number[] => {
    const cached = bySet.get(set);
    if (cached !== undefined) return cached;
    const ids: number[] = [];
    if ((set & (set - 1)) === 0) {
      nodes.push({ leaves: set, left: -1, right: -1, leaf: Math.log2(set) });
      ids.push(nodes.length - 1);
    } else {
      const lowest = set & -set;
      // Unordered splits: the part containing the lowest leaf is the left child.
      for (let part = (set - 1) & set; part > 0; part = (part - 1) & set) {
        if ((part & lowest) === 0) continue;
        const rest = set & ~part;
        for (const left of of(part))
          for (const right of of(rest)) {
            nodes.push({ leaves: set, left, right, leaf: -1 });
            ids.push(nodes.length - 1);
          }
      }
    }
    bySet.set(set, ids);
    return ids;
  };
  const roots = of((1 << count) - 1);
  return { nodes, roots };
}

const TREES4 = buildTrees(4);
const TREES5 = buildTrees(5);
if (TREES4.roots.length !== 15 || TREES5.roots.length !== 105)
  throw new Error('n02:parenthesization-count');

export type AdversarialResult = Readonly<{ maxAbs: Rational; evaluations: number }>;

class Evaluator {
  private readonly W: bigint;

  constructor(
    size: number,
    private readonly context: Context,
  ) {
    this.W = BigInt(size);
  }

  private mode(sigma: number): Mode {
    const rounding = this.context.rounding;
    if (rounding === 'adv+' || rounding === 'adv-') {
      const direction = (rounding === 'adv+' ? 1 : -1) * sigma;
      return direction > 0 ? 'up' : direction < 0 ? 'down' : 'rne';
    }
    return rounding;
  }

  in(value: F32): F32 {
    return flush(value, this.context.ftz);
  }

  round(exact: Dy, sigma: number): F32 {
    return flush(roundDy(exact, this.mode(sigma)), this.context.ftz);
  }

  mul(a: F32, b: F32, sigma: number): F32 {
    return this.round(mulDy(this.in(a), this.in(b)), sigma);
  }

  add(a: F32, b: F32, sign: 1 | -1, sigma: number): F32 {
    const right = this.in(b);
    return this.round(addDy(this.in(a), sign > 0 ? right : negDy(right)), sigma);
  }

  /**
   * numerator / W. `away` is the push direction used by extremal round-to-nearest-even
   * (pushing away from P*); it is ignored by the other roundings.
   */
  divide(numerator: F32, sigma: number, away: 1 | -1): F32 {
    const x = this.in(numerator);
    const t = Math.min(x.e - 40, TINY_EXPONENT);
    const N = shiftLeft(x.m, x.e - t);
    const rounding = this.context.rounding;
    const mode = this.mode(sigma);
    if (!this.context.extremal) return flush(roundQuotient(N, this.W, t, mode), this.context.ftz);
    let direction: number;
    if (rounding === 'rne') direction = away;
    else if (rounding === 'zero') direction = -signDy(x);
    else direction = mode === 'up' ? 1 : mode === 'down' ? -1 : away;
    if (direction === 0) return flush(roundQuotient(N, this.W, t, 'rne'), this.context.ftz);
    // ULP of the exact quotient |N| / W * 2^t.
    const magnitude = N < 0n ? -N : N;
    const Q = magnitude / this.W;
    let ulpExponent = -149;
    if (Q !== 0n) {
      const floorLog = bitLength(Q) - 1 + t;
      const power = Q * this.W === magnitude && (Q & (Q - 1n)) === 0n;
      ulpExponent = floorLog < -126 ? -149 : Math.max(power ? floorLog - 24 : floorLog - 23, -149);
    }
    // Bound x +/- 2.5 ULP = (N + d * 5 * W * 2^(ulp - 1 - t)) / W * 2^t, rounded toward x.
    const s = Math.min(t, ulpExponent - 1);
    const bound =
      shiftLeft(N, t - s) + BigInt(direction) * shiftLeft(5n * this.W, ulpExponent - 1 - s);
    return flush(roundQuotient(bound, this.W, s, direction > 0 ? 'down' : 'up'), this.context.ftz);
  }
}

function sgn(value: Dy | F32): 1 | -1 {
  return signDy(value) < 0 ? -1 : 1;
}

/**
 * Exhaustive bounded adversarial displacement for one vertex-axis at the input camera with the
 * supplied origin: 225 forms x 6 roundings x 2 flush settings x 2 division variants.
 */
export function adversarialDisplacement(
  input: ProjectionInput,
  origin: ProjectionPoint,
  vertex: number,
  axis: 0 | 1,
  observe?: (root: number) => void,
): AdversarialResult {
  const L = lanes(input, origin, vertex, axis);
  const rho = axis === 0 ? 1 : -1;
  const exactLeaf1 = mulDy(L.p, L.ux);
  const exactLeaf2 = mulDy(L.r, L.uy);
  const zq2 = mulDy(mulDy(L.z, L.q), TWO);
  const idealNumerators: Dy[] = [exactLeaf1, exactLeaf2, L.B, L.F].map((leaf) => mulDy(leaf, zq2));
  const idealFactored = idealNumerators.reduce(addDy);
  // away direction for numerator / W given the lane-ideal numerator.
  const awayQuotient = (computed: Dy, ideal: Dy): 1 | -1 => {
    const difference = compareDy(computed, ideal);
    return difference !== 0 ? difference : sgn(computed);
  };
  const roots = new Set<number>();
  let evaluations = 0;
  const record = (root: F32) => {
    roots.add(root.v);
    observe?.(root.v);
    evaluations += 1;
  };
  for (const rounding of ROUNDINGS)
    for (const ftz of [false, true])
      for (const extremal of [false, true]) {
        const ev = new Evaluator(L.size, { rounding, ftz, extremal });
        // Factored forms: ((((s * z) * q) * 2) / W) - 1, or 1 - (...) on y.
        const leaves4 = [ev.mul(L.p, L.ux, rho), ev.mul(L.r, L.uy, rho), L.B, L.F];
        const values4: F32[] = [];
        for (let id = 0; id < TREES4.nodes.length; id += 1) {
          const node = TREES4.nodes[id]!;
          values4.push(
            node.leaf >= 0
              ? leaves4[node.leaf]!
              : ev.add(values4[node.left]!, values4[node.right]!, 1, rho),
          );
        }
        for (const id of TREES4.roots) {
          const a1 = ev.mul(values4[id]!, L.z, rho);
          const a2 = ev.mul(a1, L.q, rho);
          const a3 = ev.mul(a2, TWO, rho);
          const away = awayQuotient(ev.in(a3), idealFactored);
          const t = ev.divide(a3, rho, away);
          record(axis === 0 ? ev.add(t, ONE, -1, 1) : ev.add(ONE, t, -1, 1));
        }
        // Distributed forms: t_j = ((((leaf * z) * q) * 2) / W) or * (1 / W).
        const sigmaT = rho;
        const leaves = [ev.mul(L.p, L.ux, sigmaT), ev.mul(L.r, L.uy, sigmaT), L.B, L.F];
        for (const reciprocal of [false, true]) {
          const terms: F32[] = leaves.map((leaf, index) => {
            const a1 = ev.mul(leaf, L.z, sigmaT);
            const a2 = ev.mul(a1, L.q, sigmaT);
            const a3 = ev.mul(a2, TWO, sigmaT);
            const numerator = ev.in(a3);
            if (!reciprocal)
              return ev.divide(a3, sigmaT, awayQuotient(numerator, idealNumerators[index]!));
            const sigmaR = sigmaT * signDy(numerator);
            const awayR =
              signDy(numerator) === 0
                ? 1
                : (((compareDy(numerator, idealNumerators[index]!) || 1) * sgn(numerator)) as
                    1 | -1);
            const r = ev.divide(ONE, sigmaR, awayR);
            return ev.mul(a3, r, sigmaT);
          });
          // Leaf 4 is the constant: -1 on x, +1 on y.
          const constant = axis === 0 ? lane(-1) : ONE;
          const values5: F32[] = [];
          for (let id = 0; id < TREES5.nodes.length; id += 1) {
            const node = TREES5.nodes[id]!;
            if (node.leaf >= 0) {
              values5.push(node.leaf === 4 ? constant : terms[node.leaf]!);
              continue;
            }
            const hasConstant = (node.leaves & 16) !== 0;
            if (axis === 0 || !hasConstant) {
              values5.push(
                ev.add(values5[node.left]!, values5[node.right]!, 1, hasConstant ? 1 : rho),
              );
            } else {
              const leftHas = (TREES5.nodes[node.left]!.leaves & 16) !== 0;
              const [minuend, subtrahend] = leftHas
                ? [values5[node.left]!, values5[node.right]!]
                : [values5[node.right]!, values5[node.left]!];
              values5.push(ev.add(minuend, subtrahend, -1, 1));
            }
          }
          for (const id of TREES5.roots) record(values5[id]!);
        }
      }
  const R = reference(input, vertex, axis);
  const size = decode(L.size);
  let maxAbs: Dy = { m: 0n, e: 0 };
  for (const value of roots) {
    const root = decode(value);
    const shifted = axis === 0 ? addDy(root, decode(1)) : addDy(decode(1), negDy(root));
    const recovered = mulDy(mulDy(shifted, size), { m: 1n, e: -1 });
    const difference = addDy(recovered, negDy(R));
    const magnitude = signDy(difference) < 0 ? negDy(difference) : difference;
    if (compareDy(magnitude, maxAbs) > 0) maxAbs = magnitude;
  }
  return { maxAbs: toRational(maxAbs), evaluations };
}

/** Exact recovered physical coordinate of one binary32 NDC root (exported for unit checks). */
export function recoverRoot(root: number, size: number, axis: 0 | 1): Rational {
  const value = lane(root);
  const shifted = axis === 0 ? addDy(value, decode(1)) : addDy(decode(1), negDy(value));
  return toRational(mulDy(mulDy(shifted, decode(size)), { m: 1n, e: -1 }));
}

// ---------------------------------------------------------------------------------------------
// Independent M04 clearance summaries.

type P = readonly [Dy, Dy];

export type IndependentClearanceSummary = Readonly<{
  dV2: Rational | null;
  dE2: Rational | null;
  rhoBar: Rational | null;
  kappaBar: Rational | null;
  lambdaBar: Rational | null;
  plo: Rational | null;
  overlappingFan: boolean;
}>;

function vec(from: P, to: P): P {
  return [addDy(to[0], negDy(from[0])), addDy(to[1], negDy(from[1]))];
}

function crossDy(u: P, v: P): Dy {
  return addDy(mulDy(u[0], v[1]), negDy(mulDy(u[1], v[0])));
}

function dotDy(u: P, v: P): Dy {
  return addDy(mulDy(u[0], v[0]), mulDy(u[1], v[1]));
}

function absDy(a: Dy): Dy {
  return signDy(a) < 0 ? negDy(a) : a;
}

function l1Dy(u: P): Dy {
  return addDy(absDy(u[0]), absDy(u[1]));
}

function linfDy(u: P): Dy {
  return compareDy(absDy(u[0]), absDy(u[1])) >= 0 ? absDy(u[0]) : absDy(u[1]);
}

/** Exact ratio a / b as a Rational (b > 0). */
function ratio(a: Dy, b: Dy): Rational {
  const n = toRational(a);
  const d = toRational(b);
  return rational(n.n * d.d, n.d * d.n);
}

function lessRational(a: Rational, b: Rational): boolean {
  return a.n * b.d < b.n * a.d;
}

function keepMin(current: Rational | null, candidate: Rational): Rational {
  return current === null || lessRational(candidate, current) ? candidate : current;
}

/** Squared distance from p to segment [a, b], without clamped parameters. */
function pointSegment(p: P, a: P, b: P): Rational {
  const ab = vec(a, b);
  const ap = vec(a, p);
  const along = dotDy(ap, ab);
  if (signDy(along) <= 0) return toRational(dotDy(ap, ap));
  const length2 = dotDy(ab, ab);
  if (compareDy(along, length2) >= 0) {
    const bp = vec(b, p);
    return toRational(dotDy(bp, bp));
  }
  const c = crossDy(ab, ap);
  return ratio(mulDy(c, c), length2);
}

function onClosedSegment(p: P, a: P, b: P): boolean {
  if (signDy(crossDy(vec(a, b), vec(a, p))) !== 0) return false;
  return signDy(dotDy(vec(p, a), vec(p, b))) <= 0;
}

function segmentsMeet(a: P, b: P, c: P, d: P): boolean {
  const d1 = signDy(crossDy(vec(c, d), vec(c, a)));
  const d2 = signDy(crossDy(vec(c, d), vec(c, b)));
  const d3 = signDy(crossDy(vec(a, b), vec(a, c)));
  const d4 = signDy(crossDy(vec(a, b), vec(a, d)));
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  return (
    onClosedSegment(a, c, d) ||
    onClosedSegment(b, c, d) ||
    onClosedSegment(c, a, b) ||
    onClosedSegment(d, a, b)
  );
}

/**
 * Independent recomputation of the M04 geometry-owned summaries from original local coordinates.
 * Plo is the conservative minimum over triangle pairs and fan pairs (both use it as a denominator
 * lower bound); a same-direction collinear fan pair is reported as `overlappingFan`.
 */
export function independentClearanceSummary(
  mesh: ProjectionInput['mesh'],
): IndependentClearanceSummary {
  const points: P[] = mesh.vertices.map(([x, y]) => [decode(x), decode(y)] as const);
  const referenced = Array.from(new Set(mesh.indices)).sort((a, b) => a - b);
  let dV2: Rational | null = null;
  for (const [index, i] of referenced.entries())
    for (const j of referenced.slice(index + 1)) {
      const delta = vec(points[i]!, points[j]!);
      dV2 = keepMin(dV2, toRational(dotDy(delta, delta)));
    }
  const edgeSet = new Set<string>();
  const edges: (readonly [number, number])[] = [];
  const neighbours = new Map<number, Set<number>>();
  for (let t = 0; t + 2 < mesh.indices.length; t += 3)
    for (let k = 0; k < 3; k += 1) {
      const i = mesh.indices[t + k]!;
      const j = mesh.indices[t + ((k + 1) % 3)]!;
      const [lo, hi] = i < j ? [i, j] : [j, i];
      const key = `${lo}:${hi}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push([lo, hi]);
      if (!neighbours.has(lo)) neighbours.set(lo, new Set());
      if (!neighbours.has(hi)) neighbours.set(hi, new Set());
      neighbours.get(lo)!.add(hi);
      neighbours.get(hi)!.add(lo);
    }
  let dE2: Rational | null = null;
  for (const [index, [a, b]] of edges.entries())
    for (const [c, d] of edges.slice(index + 1)) {
      if (a === c || a === d || b === c || b === d) continue;
      const [pa, pb, pc, pd] = [points[a]!, points[b]!, points[c]!, points[d]!];
      if (segmentsMeet(pa, pb, pc, pd)) {
        dE2 = keepMin(dE2, rational(0n));
        continue;
      }
      for (const candidate of [
        pointSegment(pa, pc, pd),
        pointSegment(pb, pc, pd),
        pointSegment(pc, pa, pb),
        pointSegment(pd, pa, pb),
      ])
        dE2 = keepMin(dE2, candidate);
    }
  let rhoBar: Rational | null = null;
  let plo: Rational | null = null;
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const first = points[mesh.indices[t]!]!;
    const u = vec(first, points[mesh.indices[t + 1]!]!);
    const v = vec(first, points[mesh.indices[t + 2]!]!);
    rhoBar = keepMin(rhoBar, ratio(absDy(crossDy(u, v)), addDy(l1Dy(u), l1Dy(v))));
    plo = keepMin(plo, toRational(addDy(linfDy(u), linfDy(v))));
  }
  let kappaBar: Rational | null = null;
  let lambdaBar: Rational | null = null;
  let overlappingFan = false;
  for (const vertex of referenced) {
    const around = [...(neighbours.get(vertex) ?? [])].sort((a, b) => a - b);
    const rays = around.map((other) => vec(points[vertex]!, points[other]!));
    for (const [index, u] of rays.entries())
      for (const v of rays.slice(index + 1)) {
        const length = addDy(l1Dy(u), l1Dy(v));
        plo = keepMin(plo, toRational(addDy(linfDy(u), linfDy(v))));
        const c = crossDy(u, v);
        const dot = dotDy(u, v);
        if (signDy(c) !== 0) kappaBar = keepMin(kappaBar, ratio(absDy(c), length));
        else if (signDy(dot) < 0) lambdaBar = keepMin(lambdaBar, ratio(absDy(dot), length));
        else overlappingFan = true;
      }
  }
  return { dV2, dE2, rhoBar, kappaBar, lambdaBar, plo, overlappingFan };
}
