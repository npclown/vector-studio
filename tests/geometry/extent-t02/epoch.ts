import type { ProjectionInput, ProjectionPoint } from '../mesh-projection/model.js';
import { GAMMA8, PHI, q, sqrtUp } from '../position-certificate/certificate.js';
import { originPXTarget } from '../position-certificate/r3-window.js';
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
import { A_MAX, LANE_MAX, LIMIT, packLanesCore } from '../extent-t01/core.js';
import { levelFor, pow2, TILE_CAP } from '../extent-t01/tile.js';

/**
 * P3.1p T02 epoch, epoch window, candidate cells, reach constants and the S2 epoch position bound
 * E_ep (docs/plans/p3-r2-tiling-contract.md, "Terms" and "S2"). Test-only and exact.
 */

const f = Math.fround;
const ZERO = rational(0n);
const ONE = rational(1n);
const TWO = rational(2n);

export const T_TILE = 256;
export const ORIGIN_TARGET = 128;
export const GUARD = 4;
/** (2^-24 + 2^-52) and 2^-149: certificate.ts F_LANE_REL / F_LANE_ABS (not exported there). */
export const F_LANE_REL = add(pow2(-24), pow2(-52));
export const F_LANE_ABS = pow2(-149);
/** |zq − s0| ≤ ZQ_SLACK · s0 for f32-rounded zoom and DPR lanes. */
export const ZQ_SLACK = add(pow2(-23), pow2(-48));
const BAND_LOW = sub(ONE, pow2(-22));
const BAND_HIGH = add(ONE, pow2(-22));
const SCALE_MIN = pow2(-20);
const SCALE_MAX = pow2(10);
/** List reach in physical px: 3/2 + 2·(1/16). */
export const LIST_REACH_PX = rational(13n, 8n);
export const FRINGE_REACH_PX = rational(2n);

export type OriginState = Readonly<{ origin: ProjectionPoint; g: number }>;

export type Epoch = Readonly<{
  origin: ProjectionPoint;
  g: number;
  L: number;
  /** ‖A‖∞ from the f32 linear lanes. */
  normA: Rational;
  zq: Rational;
  zqLo: Rational;
  zqHi: Rational;
  sLo: Rational;
  sHi: Rational;
  /** Level-band floor 128 / (2^L ‖A‖∞) · (1 − 2^-22). */
  sL: Rational;
  n: Rational;
  rhoL: Rational;
  lambdaL: Rational;
  width: number;
  height: number;
}>;

export type EpochInput = Pick<
  ProjectionInput,
  'affine' | 'camera' | 'zoom' | 'dpr' | 'width' | 'height'
>;

const maxR = (a: Rational, b: Rational) => (compare(a, b) >= 0 ? a : b);
const minR = (a: Rational, b: Rational) => (compare(a, b) <= 0 ? a : b);

/** ‖A‖∞ = max(|a| + |c|, |b| + |d|) on the f32 linear lanes (tile.ts levelScale's norm). */
export function laneNormA(affine: EpochInput['affine']): Rational {
  const [a, b, c, d] = affine.slice(0, 4).map((value) => absolute(q(f(value)))) as [
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  return maxR(add(a, c), add(b, d));
}

/** n = sqrtUp(max(c² + d², a² + b²)) / |ad − bc| on the exact binary64 A0. Null when singular. */
export function inverseRowBound(affine: EpochInput['affine']): Rational | null {
  const [a, b, c, d] = affine.slice(0, 4).map(q) as [Rational, Rational, Rational, Rational];
  const det = absolute(sub(mul(a, d), mul(b, c)));
  if (det.n === 0n) return null;
  const rows = maxR(add(mul(c, c), mul(d, d)), add(mul(a, a), mul(b, b)));
  return div(sqrtUp(rows), det);
}

/**
 * The epoch of a frame (contract "Epoch"), or null when no level exists or A0 is singular. The
 * lane interval is the intersection of the g band, the L band and M01 guard checks 2 and 3 for
 * the zoom lane at the frame's fixed DPR lane.
 */
export function epochOf(input: EpochInput, previous?: OriginState): Epoch | null {
  const L = levelFor(input, T_TILE);
  const n = inverseRowBound(input.affine);
  if (L === null || n === null) return null;
  const { origin, g } = originPXTarget(
    input.camera,
    input.zoom,
    input.dpr,
    ORIGIN_TARGET,
    previous,
  );
  const normA = laneNormA(input.affine);
  const qLane = q(f(input.dpr));
  const zq = mul(q(f(input.zoom)), qLane);
  const gQ = q(g);
  const levelUnit = mul(pow2(L), normA);
  const zqLo = maxR(
    maxR(div(rational(64n), gQ), div(rational(128n), levelUnit)),
    mul(SCALE_MIN, qLane),
  );
  const zqHi = minR(
    minR(div(rational(128n), gQ), div(rational(256n), levelUnit)),
    mul(SCALE_MAX, qLane),
  );
  const sL = mul(div(rational(128n), levelUnit), BAND_LOW);
  return {
    origin,
    g,
    L,
    normA,
    zq,
    zqLo,
    zqHi,
    sLo: mul(zqLo, BAND_LOW),
    sHi: mul(zqHi, BAND_HIGH),
    sL,
    n,
    rhoL: div(mul(FRINGE_REACH_PX, n), sL),
    lambdaL: div(mul(LIST_REACH_PX, n), sL),
    width: input.width,
    height: input.height,
  };
}

/** Membership of a frame in an epoch (key fields, camera window and lane interval). */
export function frameInEpoch(epoch: Epoch, frame: EpochInput, frameEpoch: Epoch): boolean {
  const zq = mul(q(f(frame.zoom)), q(f(frame.dpr)));
  const camera = frame.camera.map(q);
  const origin = epoch.origin.map(q);
  const reach = mul(TWO, q(epoch.g));
  return (
    frameEpoch.origin[0] === epoch.origin[0] &&
    frameEpoch.origin[1] === epoch.origin[1] &&
    frameEpoch.g === epoch.g &&
    frameEpoch.L === epoch.L &&
    frame.width === epoch.width &&
    frame.height === epoch.height &&
    compare(zq, epoch.zqLo) > 0 &&
    compare(zq, epoch.zqHi) <= 0 &&
    [0, 1].every((axis) => compare(absolute(sub(camera[axis]!, origin[axis]!)), reach) <= 0)
  );
}

export type DocRect = Readonly<{ x0: Rational; y0: Rational; x1: Rational; y1: Rational }>;

/** D̂: the document rectangle containing V_γ's preimage for every camera and scale of the epoch. */
export function epochWindow(epoch: Epoch, guard = GUARD): DocRect {
  const [ox, oy] = epoch.origin.map(q) as [Rational, Rational];
  const reach = mul(TWO, q(epoch.g));
  const before = div(q(guard), epoch.sLo);
  const afterX = div(q(epoch.width + guard), epoch.sLo);
  const afterY = div(q(epoch.height + guard), epoch.sLo);
  return {
    x0: sub(sub(ox, reach), before),
    y0: sub(sub(oy, reach), before),
    x1: add(add(ox, reach), afterX),
    y1: add(add(oy, reach), afterY),
  };
}

/** Exact local preimage of a document point under A0·p + e0. */
export function localOf(affine: EpochInput['affine'], point: Q2): Q2 {
  const [a, b, c, d, e, g] = affine.map(q) as [
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const det = sub(mul(a, d), mul(b, c));
  const x = sub(point[0], e);
  const y = sub(point[1], g);
  return [div(sub(mul(d, x), mul(c, y)), det), div(sub(mul(a, y), mul(b, x)), det)];
}

/** P̂ = A0⁻¹(D̂ − e0), as four exact local points in rectangle-corner order. */
export function preimageQuad(affine: EpochInput['affine'], rect: DocRect): readonly Q2[] {
  return (
    [
      [rect.x0, rect.y0],
      [rect.x1, rect.y0],
      [rect.x1, rect.y1],
      [rect.x0, rect.y1],
    ] as Q2[]
  ).map((point) => localOf(affine, point));
}

function floorDiv(value: Rational, L: number): bigint {
  const scaled = mul(value, pow2(-L));
  const quotient = scaled.n / scaled.d;
  return quotient * scaled.d !== scaled.n && scaled.n < 0n ? quotient - 1n : quotient;
}

function ceilDiv(value: Rational, L: number): bigint {
  const scaled = mul(value, pow2(-L));
  const quotient = scaled.n / scaled.d;
  return quotient * scaled.d !== scaled.n && scaled.n > 0n ? quotient + 1n : quotient;
}

/** Closed half-plane clip (Sutherland-Hodgman) of a convex polygon against y ≥ bound or y ≤ bound. */
function clipY(polygon: readonly Q2[], bound: Rational, keepAbove: boolean): Q2[] {
  const inside = (point: Q2) =>
    keepAbove ? compare(point[1], bound) >= 0 : compare(point[1], bound) <= 0;
  const result: Q2[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    if (inside(current)) result.push(current);
    if (inside(current) !== inside(next)) {
      const t = div(sub(bound, current[1]), sub(next[1], current[1]));
      result.push([add(current[0], mul(t, sub(next[0], current[0]))), bound]);
    }
  }
  return result;
}

export type CandidateResult =
  | Readonly<{ status: 'OK'; cells: readonly (readonly [bigint, bigint])[] }>
  | Readonly<{ status: 'TILE_CAP_EXCEEDED'; count: number }>;

/**
 * Cells whose closed square meets the closed convex quad, in (j, then i) order. Each row strip's
 * intersection with the quad is convex, so its x-extent gives the row's cells exactly.
 */
export function candidateCells(quad: readonly Q2[], L: number, cap = TILE_CAP): CandidateResult {
  const ys = quad.map((point) => point[1]);
  const yMin = ys.reduce(minR);
  const yMax = ys.reduce(maxR);
  const jFirst = ceilDiv(yMin, L) - 1n;
  const jLast = floorDiv(yMax, L);
  if (jLast - jFirst + 1n > BigInt(cap)) return { status: 'TILE_CAP_EXCEEDED', count: cap + 1 };
  const cells: [bigint, bigint][] = [];
  for (let j = jFirst; j <= jLast; j += 1n) {
    const y0 = mul(rational(j), pow2(L));
    const y1 = mul(rational(j + 1n), pow2(L));
    const strip = clipY(clipY(quad, y0, true), y1, false);
    if (strip.length === 0) continue;
    const xs = strip.map((point) => point[0]);
    const iFirst = ceilDiv(xs.reduce(minR), L) - 1n;
    const iLast = floorDiv(xs.reduce(maxR), L);
    if (BigInt(cells.length) + (iLast - iFirst + 1n) > BigInt(cap))
      return { status: 'TILE_CAP_EXCEEDED', count: cap + 1 };
    for (let i = iFirst; i <= iLast; i += 1n) cells.push([i, j]);
  }
  return { status: 'OK', cells };
}

// ---------------------------------------------------------------------------------------------
// S2: the epoch position bound E_ep on each record's owner carrier.

export type EpochRecord = Readonly<{
  /** Exact reference position R(v). */
  pos: Q2;
  /** v64 = RN64(R(v)). */
  v64: ProjectionPoint;
  /** Owner cell centre m (exact binary64). */
  m: ProjectionPoint;
}>;

export type EpochError = Readonly<{ ex: Rational; ey: Rational }>;

export type EpochOptions = Readonly<{
  /** Identity-test reduction: s_hi := s0 (original zoom · DPR) and no zq slack. */
  reduce?: boolean;
  gamma?: Rational;
}>;

export type EpochBound =
  | Readonly<{ status: 'OK'; errors: readonly EpochError[] }>
  | Readonly<{ status: 'lane-range'; record: number }>;

/**
 * E_ep per record and axis (contract S2):
 * max_c (s_hi·|ΔPack| + s_hi·k·|carrierDoc(c)|) + (F_LANE_REL·2g + F_LANE_ABS)·s_hi
 *   + Γ·(s_hi·absDoc_fmax + size/2) + Phi,
 * with carrierDoc(c) = p·u_x + r·u_y + B + (O − c), referenceDoc(c) = p0·x + r0·y + t0 − c,
 * ΔPack = carrierDoc − referenceDoc (independent of c) and |carrierDoc(c)| ≤ |base| + 2g at the
 * corners c = O ± 2g. Lane-range: lanes beyond 2^20, fmax beyond 2^20, or Pack64's A beyond 2^1000.
 */
export function certifyEpochCore(
  input: EpochInput,
  epoch: Epoch,
  records: readonly EpochRecord[],
  options: EpochOptions = {},
): EpochBound {
  const gamma = options.gamma ?? GAMMA8;
  const s0 = mul(q(input.zoom), q(input.dpr));
  const sHi = options.reduce === true ? s0 : epoch.sHi;
  const slack = options.reduce === true ? ZERO : ZQ_SLACK;
  const d = mul(TWO, q(epoch.g));
  const fmax = mul(d, add(ONE, pow2(-23)));
  if (compare(fmax, LANE_MAX) > 0) return { status: 'lane-range', record: -1 };
  const laneRounding = mul(add(mul(F_LANE_REL, d), F_LANE_ABS), sHi);
  const affine = input.affine.map(q);
  const origins = epoch.origin.map(q) as [Rational, Rational];
  const errors: EpochError[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const lanes = packLanesCore(
      [record.v64],
      input.affine,
      epoch.origin,
      input.zoom,
      input.dpr,
      record.m,
      epoch.origin,
    );
    const lanes32 = [...lanes.linear, ...lanes.local[0]!, ...lanes.anchor];
    if (
      lanes32.some((value) => !Number.isFinite(value) || compare(absolute(q(value)), LANE_MAX) > 0)
    )
      return { status: 'lane-range', record: index };
    const [ux, uy] = lanes.local[0]!.map(q) as [Rational, Rational];
    const [la, lb, lc, ld] = lanes.linear.map(q) as [Rational, Rational, Rational, Rational];
    const axes = ([0, 1] as const).map((axis) => {
      const [p, r] = axis === 0 ? [la, lc] : [lb, ld];
      const [p0, r0, t0] =
        axis === 0 ? [affine[0]!, affine[2]!, affine[4]!] : [affine[1]!, affine[3]!, affine[5]!];
      const anchor = q(lanes.anchor[axis]);
      const base = add(add(mul(p, ux), mul(r, uy)), anchor);
      const referenceBase = add(add(mul(p0, record.pos[0]), mul(r0, record.pos[1])), t0);
      const deltaPack = absolute(sub(add(base, origins[axis]), referenceBase));
      const carrierMax = add(absolute(base), d);
      const absDoc = add(
        add(add(absolute(mul(p, ux)), absolute(mul(r, uy))), absolute(anchor)),
        fmax,
      );
      const referenceAbs = add(
        add(add(absolute(mul(p0, record.pos[0])), absolute(mul(r0, record.pos[1]))), absolute(t0)),
        add(absolute(origins[axis]), d),
      );
      const a = mul(add(absDoc, referenceAbs), sHi);
      const size = axis === 0 ? input.width : input.height;
      const value = add(
        add(add(mul(sHi, deltaPack), mul(mul(sHi, slack), carrierMax)), laneRounding),
        add(mul(gamma, add(mul(sHi, absDoc), rational(BigInt(size), 2n))), PHI),
      );
      return { value, a };
    });
    if (axes.some((axis) => compare(axis.a, A_MAX) > 0))
      return { status: 'lane-range', record: index };
    errors.push({ ex: axes[0]!.value, ey: axes[1]!.value });
  }
  return { status: 'OK', errors };
}

/** S2 summary: Ē = sqrtUp(max E²) and the lowest failing record (E² > 1/256). */
export function epochPosition(errors: readonly EpochError[]): {
  eBar: Rational | null;
  firstFailing: number | null;
} {
  let max: Rational | null = null;
  let firstFailing: number | null = null;
  errors.forEach((error, index) => {
    const e2 = add(mul(error.ex, error.ex), mul(error.ey, error.ey));
    if (max === null || compare(e2, max) > 0) max = e2;
    if (firstFailing === null && compare(e2, LIMIT) > 0) firstFailing = index;
  });
  return { eBar: max === null ? null : sqrtUp(max), firstFailing };
}
