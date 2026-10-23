// D9 E3 unit E3-U3: the exact CPU model of the V3 mesh shader's stored-point mapping, its f32
// forward error bound beta, the guard-band / clipping bound and the no-flip certificate
// (docs/plans/d9-e3-b4-precision-contract.md sections 3.2, 7.1 and 15.2).
//
// The mapping is the WGSL `toPhysical` of packages/renderer-webgpu/src/mesh-fill-shader.ts,
// `p = ((A * u + B) + (O_m - camera)) * zoom * DPR`, evaluated over the rationals from the f32
// lane values, so `p*` is exact. `beta(p)` bounds the distance from `p*` to the position that
// the f32 vertex stage and the NDC round trip produce. Test-only: nothing here imports the
// oracle, a port or a renderer.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { A04Scalar } from '../../../packages/geometry-reference/src/a04-region.js';
import { type Dyadic, dAdd, dMul, dNeg, dyadic } from './corpus.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// The f32 error model

/**
 * Relative rounding allowance of one f32 add, subtract or multiply: 2^-23. WGSL requires these
 * to be "correctly rounded", which its accuracy rules read as one of the two neighbouring f32
 * values (round to nearest even or toward zero), so the bound is one ulp, not half. The standard
 * gamma_n bound of the contract uses 2^-24 per operation; 2^-23 contains it (section 15.2).
 */
export const F32_OP = 2 ** -23;
/** WGSL division is accurate to 2.5 ulp, relatively 2.5 * 2^-23. */
export const F32_DIV = 2.5 * 2 ** -23;
/** Absolute floor per operation: subnormal and flush-to-zero results (2^-126). */
export const F32_TINY = 2 ** -126;
/** The largest finite f32; an intermediate that may exceed it is not computable. */
const F32_MAX = 3.4028234663852886e38;

/** Rounds a bound up: every `ru` covers a few binary64 operations (each at most 2^-53). */
const ru = (x: number): number => x * (1 + 2 ** -46);

/** A magnitude bound `m` of the ideal value and a bound `e` on `|computed - ideal|`. */
type B = Readonly<{ m: number; e: number }>;

type Flag = { overflow: boolean };

function guard(flag: Flag, b: B): B {
  if (!(b.m + b.e <= F32_MAX) || !Number.isFinite(b.e)) flag.overflow = true;
  return b;
}

/** Sum of two operands with ideal result magnitude `m` (exact, known from the ideal chain). */
function addB(flag: Flag, x: B, y: B, m: number): B {
  const e = x.e + y.e;
  return guard(flag, { m, e: ru(e + F32_OP * (m + e) + F32_TINY) });
}

/** Product of two operands; the ideal magnitude is the product of the ideal magnitudes. */
function mulB(flag: Flag, x: B, y: B): B {
  const cross = x.m * y.e + y.m * x.e + x.e * y.e;
  const m = ru(x.m * y.m);
  return guard(flag, { m, e: ru(cross + F32_OP * (m + cross) + F32_TINY) });
}

/** Division by an exact (error-free) f32 value `w`. */
function divB(flag: Flag, x: B, w: number): B {
  const m = ru(x.m / w);
  const e = ru(x.e / w);
  return guard(flag, { m, e: ru(e + F32_DIV * (m + e) + F32_TINY) });
}

/** Exact scaling by a power of two: both bounds scale. */
const scaleB = (x: B, k: number): B => ({ m: x.m * k, e: x.e * k });

const EXACT = (m: number): B => ({ m, e: 0 });

// ---------------------------------------------------------------------------------------------
// Exact dyadic helpers

function ldexp(x: number, k: number): number {
  let result = x;
  let rest = k;
  while (rest > 1000) {
    result *= 2 ** 1000;
    rest -= 1000;
  }
  while (rest < -1000) {
    result *= 2 ** -1000;
    rest += 1000;
  }
  return result * 2 ** rest;
}

/** An upper bound on |d| as a binary64 (the nearest double, widened by a few ulp). */
export function absUp(d: Dyadic): number {
  if (d.n === 0n) return 0;
  const n = d.n < 0n ? -d.n : d.n;
  const bits = n.toString(2).length;
  // Keep 60 high bits: Number() rounds to 53, and the dropped part is a lower-order remainder.
  const shift = Math.max(0, bits - 60);
  const high = Number(n >> BigInt(shift)) + 1;
  return ru(ldexp(high, shift + d.e));
}

/** The exact rational `num/den` of a dyadic, normalized (odd numerator when e < 0). */
export function dyadicScalar(d: Dyadic): A04Scalar {
  let { n, e } = d;
  if (n === 0n) return { num: 0n, den: 1n };
  while (e < 0 && (n & 1n) === 0n) {
    n >>= 1n;
    e += 1;
  }
  return e >= 0 ? { num: n << BigInt(e), den: 1n } : { num: n, den: 1n << BigInt(-e) };
}

// ---------------------------------------------------------------------------------------------
// The lanes and the exact mapping

/** The f32 lanes of one mesh draw, exactly as the shader reads them. Every value is an f32. */
export type ShaderLanes = Readonly<{
  /** `instance.linear`: x' = linear[0] * u.x + linear[2] * u.y, y' = linear[1] * u.x + linear[3] * u.y. */
  linear: readonly [number, number, number, number];
  /** `instance.anchor` (B). */
  anchor: readonly [number, number];
  /** `frame.originMinusCamera`. */
  originMinusCamera: readonly [number, number];
  zoom: number;
  devicePixelRatio: number;
  /** `frame.physicalSize`, physical pixels. */
  physicalSize: readonly [number, number];
}>;

export type ModelHooks = Readonly<{
  /** E3-D14: drop the NDC step from beta (the vertex path then equals the feature path). */
  omitNdc?: boolean;
  /** E3-D7 lives at the harness level; the model has no hook for it. */
}>;

export type MappedPoint = Readonly<{
  /** Exact physical-pixel position. */
  x: Dyadic;
  y: Dyadic;
  /** Upper bound on beta(p) of the vertex path (toPhysical, NDC, viewport transform). */
  betaVertex: number;
  /** Upper bound on beta(p) of the feature path (toPhysical only). */
  betaFeature: number;
  overflow: boolean;
}>;

/** The shader-identity hash: SHA-256 of the WGSL source file that defines the mapping. */
export function shaderIdentitySha256(): string {
  const file = path.resolve(here, '../../../packages/renderer-webgpu/src/mesh-fill-shader.ts');
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Maps one stored point (an f32 offset pair `u`) exactly, with its beta bounds (contract 7.1).
 * `W` and `H` are the physical surface size (exact integers).
 */
export function mapStoredPoint(
  ux: number,
  uy: number,
  lanes: ShaderLanes,
  hooks: ModelHooks = {},
): MappedPoint {
  const { linear, anchor, originMinusCamera: oc } = lanes;
  const z = dyadic(lanes.zoom);
  const dpr = dyadic(lanes.devicePixelRatio);
  const [W, H] = lanes.physicalSize;
  const flag: Flag = { overflow: false };

  // toPhysical, one axis at a time. `lin0`, `lin1` are the two linear lanes of this axis.
  const axis = (lin0: number, lin1: number, a: number, o: number) => {
    const t0 = dMul(dyadic(lin0), dyadic(ux));
    const t1 = dMul(dyadic(lin1), dyadic(uy));
    const lx = dAdd(t0, t1);
    const s1 = dAdd(lx, dyadic(a));
    const doc = dAdd(s1, dyadic(o));
    const dz = dMul(doc, z);
    const p = dMul(dz, dpr);
    // Error propagation, op by op.
    const bT0 = mulB(flag, EXACT(Math.abs(lin0)), EXACT(Math.abs(ux)));
    const bT1 = mulB(flag, EXACT(Math.abs(lin1)), EXACT(Math.abs(uy)));
    const bL = addB(flag, bT0, bT1, absUp(lx));
    const bS = addB(flag, bL, EXACT(Math.abs(a)), absUp(s1));
    const bD = addB(flag, bS, EXACT(Math.abs(o)), absUp(doc));
    const bZ = mulB(flag, bD, EXACT(Math.abs(lanes.zoom)));
    const bP = mulB(flag, bZ, EXACT(Math.abs(lanes.devicePixelRatio)));
    return { p, bP, mP: absUp(p) };
  };
  // x' = a * ux + c * uy, y' = b * ux + d * uy.
  const ax = axis(linear[0], linear[2], anchor[0], oc[0]);
  const ay = axis(linear[1], linear[3], anchor[1], oc[1]);

  const betaFeature = ru(Math.hypot(ax.bP.e, ay.bP.e));
  let betaVertex = betaFeature;
  if (hooks.omitNdc !== true) {
    // meshPositionNdc: x * 2 / W - 1 and 1 - y * 2 / H, then the viewport transform back.
    const one = EXACT(1);
    const back = (ideal: Dyadic, bP: B, size: number): number => {
      const twice = scaleB(bP, 2);
      const q = divB(flag, twice, size); // 2p / size (x), or 2p / size before the flip (y)
      const qIdeal = ru((2 * absUp(ideal)) / size);
      const ndc = addB(flag, q, one, ru(qIdeal + 1)); // x*2/W - 1 and 1 - y*2/H
      // The viewport transform: ((ndc + 1) * 0.5) * size, and ((1 - ndc) * 0.5) * size for y.
      // Its exact result is p again, and (ndc + 1) is 2p/size in magnitude.
      const s = addB(flag, ndc, one, qIdeal);
      const out = mulB(flag, scaleB(s, 0.5), EXACT(size));
      return out.e;
    };
    // The y chain differs from the x chain only in its signs (1 - q, 1 - ndc), which the
    // magnitude-based bounds do not see.
    const ex = back(ax.p, ax.bP, W);
    const ey = back(ay.p, ay.bP, H);
    betaVertex = Math.max(betaFeature, ru(Math.hypot(ex, ey)));
  }
  return {
    x: ax.p,
    y: ay.p,
    betaVertex,
    betaFeature,
    overflow: flag.overflow,
  };
}

// ---------------------------------------------------------------------------------------------
// The mapped mesh

export type MappedMesh = Readonly<{
  /** Exact positions, x then y per vertex. */
  positions: readonly A04Scalar[];
  /** The same positions as upper-bounded doubles |p|, for the cheap tests. */
  approx: Float64Array;
  indices: Uint32Array;
  /** Per-case maxima over the stored points. */
  betaVertex: number;
  betaFeature: number;
  beta: number;
  overflow: boolean;
  /** Exact dyadic positions (for the flip test). */
  dyadics: readonly (readonly [Dyadic, Dyadic])[];
}>;

export function mapMesh(
  offsets: Float32Array,
  indices: Uint32Array,
  lanes: ShaderLanes,
  hooks: ModelHooks = {},
): MappedMesh {
  const count = offsets.length / 2;
  const positions: A04Scalar[] = [];
  const dyadics: (readonly [Dyadic, Dyadic])[] = [];
  const approx = new Float64Array(offsets.length);
  let betaVertex = 0;
  let betaFeature = 0;
  let overflow = false;
  for (let v = 0; v < count; v += 1) {
    const p = mapStoredPoint(offsets[2 * v]!, offsets[2 * v + 1]!, lanes, hooks);
    positions.push(dyadicScalar(p.x), dyadicScalar(p.y));
    dyadics.push([p.x, p.y]);
    approx[2 * v] = signedApprox(p.x);
    approx[2 * v + 1] = signedApprox(p.y);
    betaVertex = Math.max(betaVertex, p.betaVertex);
    betaFeature = Math.max(betaFeature, p.betaFeature);
    overflow ||= p.overflow;
  }
  return {
    positions,
    approx,
    indices,
    betaVertex,
    betaFeature,
    beta: Math.max(betaVertex, betaFeature),
    overflow,
    dyadics,
  };
}

function signedApprox(d: Dyadic): number {
  const m = absUp(d);
  return d.n < 0n ? -m : m;
}

// ---------------------------------------------------------------------------------------------
// The no-flip certificate (contract 7.1)

export type FlipResult = Readonly<{ uncertain: number; zeroArea: number; first: number | null }>;

/**
 * Each mapped triangle's orientation is stable under a perturbation of every vertex by at most
 * `beta`: the doubled area `2A` changes by at most `2 beta (|u| + |v|) + 4 beta^2`, with `u`, `v`
 * the two edge vectors from one vertex. The certificate holds when `|2A|` exceeds that.
 */
export function noFlipCertificate(mesh: MappedMesh, beta: number): FlipResult {
  let uncertain = 0;
  let zeroArea = 0;
  let first: number | null = null;
  const d = mesh.dyadics;
  for (let k = 0; k + 2 < mesh.indices.length; k += 3) {
    const a = d[mesh.indices[k]!]!;
    const b = d[mesh.indices[k + 1]!]!;
    const c = d[mesh.indices[k + 2]!]!;
    const ux = dAdd(b[0], dNeg(a[0]));
    const uy = dAdd(b[1], dNeg(a[1]));
    const vx = dAdd(c[0], dNeg(a[0]));
    const vy = dAdd(c[1], dNeg(a[1]));
    const cross = dAdd(dMul(ux, vy), dNeg(dMul(uy, vx)));
    const area2 = absUp(cross);
    if (cross.n === 0n) zeroArea += 1;
    const lu = ru(Math.hypot(absUp(ux), absUp(uy)));
    const lv = ru(Math.hypot(absUp(vx), absUp(vy)));
    const bound = ru(2 * beta * (lu + lv) + 4 * beta * beta);
    // area2 is an upper bound of |cross|: use the lower bound |cross| >= area2 * (1 - 2^-40).
    const lower = area2 * (1 - 2 ** -40);
    if (!(lower > bound)) {
      uncertain += 1;
      first ??= k / 3;
    }
  }
  return { uncertain, zeroArea, first };
}

// ---------------------------------------------------------------------------------------------
// The guard band and clipping (contract 7.1, E3-Q11 (a))

export type ClipResult = Readonly<{
  /** True when some triangle may reach outside the viewport (with the beta margin). */
  clipped: boolean;
  /** Triangles that may be clipped. */
  triangles: number;
  /** Crossing edges whose new vertex was bounded. */
  crossings: number;
  /** The added bound (physical px), 0 when nothing is clipped; Infinity when not computable. */
  bound: number;
}>;

/**
 * The viewport (NDC [-1, 1]^2, physical [0, W] x [0, H]) is the guard band. A triangle with a
 * vertex outside it (by more than the `beta` margin inside) is clipped by the GPU. Exact plane
 * clipping leaves the visible set unchanged, so the oracle measures the unclipped `M*`; what
 * clipping adds is the f32 error of each new vertex, `P0 + t (P1 - P0)` with `t = b0 / (b0 - b1)`,
 * which is bounded here by the same op-by-op propagation as beta, for the four planes in turn
 * (a vertex made by one plane can be cut by the next). A case whose bound cannot be computed
 * (a denominator within its own error of 0, an f32 overflow) has bound Infinity.
 */
export function clipBound(mesh: MappedMesh, size: readonly [number, number], beta: number): ClipResult {
  const [W, H] = size;
  const px = mesh.approx;
  const margin = beta;
  const outside = (x: number, y: number): boolean =>
    x < margin || x > W - margin || y < margin || y > H - margin;
  const flag: Flag = { overflow: false };
  let triangles = 0;
  let crossings = 0;
  let bound = 0;
  for (let k = 0; k + 2 < mesh.indices.length; k += 3) {
    const v = [mesh.indices[k]!, mesh.indices[k + 1]!, mesh.indices[k + 2]!];
    const pts = v.map((i) => [px[2 * i]!, px[2 * i + 1]!] as const);
    if (!pts.some(([x, y]) => outside(x, y))) continue;
    // A triangle entirely beyond one plane (with margin) draws nothing there.
    if (
      pts.every(([x]) => x < -margin) ||
      pts.every(([x]) => x > W + margin) ||
      pts.every(([, y]) => y < -margin) ||
      pts.every(([, y]) => y > H + margin)
    )
      continue;
    triangles += 1;
    let stage = beta;
    for (const [axis, plane] of [
      [0, 0],
      [0, W],
      [1, 0],
      [1, H],
    ] as const) {
      let worst = 0;
      for (let e = 0; e < 3; e += 1) {
        const p0 = pts[e]!;
        const p1 = pts[(e + 1) % 3]!;
        const c0 = p0[axis];
        const c1 = p1[axis];
        // Opposite sides of the plane (the margin makes a near-touch count as crossing).
        if (!((c0 < plane + margin && c1 > plane - margin) || (c1 < plane + margin && c0 > plane - margin)))
          continue;
        if (c0 === c1) continue;
        crossings += 1;
        const b0 = EXACT(Math.abs(c0 - plane));
        const b1 = EXACT(Math.abs(c1 - plane));
        const den = Math.abs(c1 - c0);
        const eIn = stage;
        const in0: B = { m: b0.m, e: eIn };
        const in1: B = { m: b1.m, e: eIn };
        const eDen = addB(flag, in0, in1, den).e;
        if (!(den > eDen)) {
          worst = Infinity;
          break;
        }
        const t = ru(b0.m / den);
        const eT = ru((in0.e + t * eDen) / (den - eDen) + F32_DIV * (t + 1));
        let side = 0;
        for (const a of [0, 1] as const) {
          const d = Math.abs(p1[a] - p0[a]);
          const eD = ru(2 * eIn + F32_OP * (d + 2 * eIn));
          const prod = ru(d * eT + t * eD + eT * eD);
          const eProd = ru(prod + F32_OP * (t * d + prod));
          const eN = ru(eIn + eProd + F32_OP * (Math.abs(p0[a]) + Math.abs(p1[a]) + eProd + eIn));
          side = Math.max(side, eN);
        }
        // The two coordinates of the new vertex err independently.
        worst = Math.max(worst, ru(Math.hypot(side, side)));
      }
      if (!Number.isFinite(worst)) {
        bound = Infinity;
        break;
      }
      stage = Math.max(stage, worst);
    }
    bound = Math.max(bound, stage - beta);
    if (!Number.isFinite(bound)) break;
  }
  if (flag.overflow) bound = Infinity;
  return { clipped: triangles > 0, triangles, crossings, bound: Number.isFinite(bound) ? ru(bound) : Infinity };
}
