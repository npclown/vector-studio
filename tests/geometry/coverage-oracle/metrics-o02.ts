import { compare, rational, type Rational } from '../rounded-fill/exact.js';
import type { Crop } from './crop.js';
import { approxNumber, ExactSum, exactJson, type ExactJson } from './numeric.js';
import {
  CLASS_BAND,
  CLASS_EXTERIOR,
  CLASS_INTERIOR,
  referenceAt,
  traverseSegment,
  type CoverageOracle,
} from './oracle.js';
import type { CoverageRowGeometry } from './positions.js';
import { coverageOf, nearestFeature, segmentDistanceSquared, type RuleContext } from './rule.js';

/**
 * P3.1o O02 per-variant metrics (docs/plans/p3-o02-a5-coverage-contract.md, "Oracles and
 * acceptance"). Everything is computed from the decoded crops and the recomputed variant geometry.
 * Exact values are {n, d, approx}; a missing population is the string `N/A:none`.
 *
 * Pixel classes use the exact squared distance d^2 from the pixel center to the closed boundary
 * segments. It is computed for every crop pixel within Chebyshev distance 2 of a boundary segment
 * (traverseSegment, r = 2); every other pixel center is more than 2.5 px away.
 *
 * - G1: centers with d^2 >= 4; obs within 2/255 of 255 inside and of 0 outside.
 * - G2: obs >= 128 is classified inside; a center whose class differs from the exact inside test
 *   (O01 parity at the center) must have d^2 <= 1. THIN-Z1: obs > 0 in every column whose center
 *   lies within the strip's x-extent, in the row whose center is nearest the strip (exact distance
 *   to the region, ties to the lower row index).
 * - G3: centers inside or with d^2 <= 0.708^2 need every count word = 1.0; all other crop pixels
 *   need every count <= 1.0. 1x checks the single R count, 4x the four RGBA counts.
 * - obs - rule: rule is exact (rule.ts) where d < 1 and saturated (inside ? 1 : 0) elsewhere,
 *   because |s / w| >= |v| / sqrt(2) >= 1/2 once |v| >= 0.7072. Reported per O01 class.
 * - obs - ref, boundary shift, seam and THIN-Z1 area follow O01 (metrics.ts).
 */

export const G1_TOLERANCE = 2;
export const G3_LIMIT_SQUARED = rational(708n * 708n, 1000n * 1000n);
const HALF_ONE = 0x3c00;

export type O02Passes = Readonly<{
  main1: Uint8Array;
  main4: Uint8Array;
  /** R count words, one per pixel. */
  count1: Uint16Array;
  /** RGBA count words, four per pixel, channel fastest. */
  count4: Uint16Array;
}>;

type Maybe<T> = T | string;
const NONE = 'N/A:none';
const DIFF_255 = 255n;

type Fraction = Readonly<{ num: bigint; den: bigint }>;

function lessThan(a: Fraction, b: Fraction): boolean {
  return a.num * b.den < b.num * a.den;
}

export type DeviationStats = Readonly<{
  count: number;
  max: Maybe<ExactJson>;
  min: Maybe<ExactJson>;
  maxAbs: Maybe<ExactJson>;
  meanSquare: Maybe<ExactJson>;
  rms: Maybe<string>;
}>;

class Accumulator {
  count = 0;
  private max: Fraction | null = null;
  private min: Fraction | null = null;
  private readonly squares = new ExactSum();

  add(value: Fraction): void {
    this.count += 1;
    if (this.max === null || lessThan(this.max, value)) this.max = value;
    if (this.min === null || lessThan(value, this.min)) this.min = value;
    this.squares.addParts(value.num * value.num, value.den * value.den);
  }

  result(): DeviationStats {
    if (this.count === 0 || this.max === null || this.min === null)
      return { count: 0, max: NONE, min: NONE, maxAbs: NONE, meanSquare: NONE, rms: NONE };
    const negatedMin: Fraction = { num: -this.min.num, den: this.min.den };
    const maxAbs = lessThan(this.max, negatedMin) ? negatedMin : this.max;
    const sum = this.squares.value();
    const meanSquare = rational(sum.n, sum.d * BigInt(this.count));
    return {
      count: this.count,
      max: exactJson(rational(this.max.num, this.max.den)),
      min: exactJson(rational(this.min.num, this.min.den)),
      maxAbs: exactJson(rational(maxAbs.num, maxAbs.den)),
      meanSquare: exactJson(meanSquare),
      rms: Math.sqrt(approxNumber(meanSquare)).toExponential(5),
    };
  }
}

function deviation(k: number, value: Rational): Fraction {
  return { num: BigInt(k) * value.d - DIFF_255 * value.n, den: DIFF_255 * value.d };
}

function unorm(k: number): ExactJson {
  return exactJson(rational(BigInt(k), DIFF_255));
}

/** Exact binary16 value times 2^24 (finite words only). */
export function half24(word: number): number {
  const exponent = (word >>> 10) & 0x1f;
  if (exponent === 0x1f) throw new Error(`metrics-o02:f16-nonfinite:${word}`);
  const fraction = word & 0x3ff;
  const magnitude = exponent === 0 ? fraction : (fraction | 0x400) * 2 ** (exponent - 1);
  return (word & 0x8000) !== 0 ? -magnitude : magnitude;
}

const ONE24 = 2 ** 24;

// ---------------------------------------------------------------------------------------------
// Distance classes.

export const NEAR = 1;
export const WITHIN_1 = 2;
export const WITHIN_G3 = 4;
export const AT_LEAST_2 = 8;

/**
 * Per crop pixel flags: NEAR (d^2 computed), WITHIN_1 (d^2 <= 1), WITHIN_G3 (d^2 <= 0.708^2),
 * AT_LEAST_2 (d^2 >= 4; also set for every pixel that is not NEAR).
 */
export function distanceFlags(geometry: CoverageRowGeometry, crop: Crop): Uint8Array {
  const S = 1n << BigInt(geometry.scaleExponent);
  const half = S >> 1n;
  const flags = new Uint8Array(crop.w * crop.h).fill(AT_LEAST_2);
  const near: number[] = [];
  for (const edge of geometry.boundaryEdges)
    traverseSegment(geometry.scaled[edge.a]!, geometry.scaled[edge.b]!, S, crop, 2, (i, j) => {
      const index = (j - crop.y) * crop.w + (i - crop.x);
      if (flags[index]! & NEAR) return;
      flags[index] = NEAR;
      near.push(index);
    });
  const S2 = S * S;
  const g3n = G3_LIMIT_SQUARED.n;
  const g3d = G3_LIMIT_SQUARED.d;
  for (const index of near) {
    const i = crop.x + (index % crop.w);
    const j = crop.y + Math.floor(index / crop.w);
    const [num, den] = segmentDistanceSquared(
      geometry,
      BigInt(2 * i + 1) * half,
      BigInt(2 * j + 1) * half,
    );
    // d^2 = num / (den S^2) px^2.
    let value = NEAR;
    if (num <= den * S2) value |= WITHIN_1;
    if (num * g3d <= g3n * den * S2) value |= WITHIN_G3;
    if (num >= 4n * den * S2) value |= AT_LEAST_2;
    flags[index] = value;
  }
  return flags;
}

/**
 * Rule coverage of crop pixel `index`: exact (rule.ts) when d <= 1, otherwise saturated to the
 * exact inside test, since |s / w| >= |v| / sqrt(2) > 1/2 there.
 */
export function ruleValue(
  context: RuleContext,
  oracle: CoverageOracle,
  flags: Uint8Array,
  crop: Crop,
  index: number,
): Rational {
  if (!(flags[index]! & WITHIN_1)) return oracle.inside[index] ? rational(1n) : rational(0n);
  const i = crop.x + (index % crop.w);
  const j = crop.y + Math.floor(index / crop.w);
  const half = context.scale >> 1n;
  return coverageOf(
    nearestFeature(context, BigInt(2 * i + 1) * half, BigInt(2 * j + 1) * half),
    context.scale,
  );
}

// ---------------------------------------------------------------------------------------------

export type GateCounts = Readonly<{ pixels: number; violations: number }>;

export type SampleMetricsO02 = Readonly<{
  sampleCount: 1 | 4;
  g1: Readonly<{
    pixels: number;
    violations: number;
    maxInsideError: Maybe<ExactJson>;
    maxOutsideError: Maybe<ExactJson>;
  }>;
  g2: Readonly<{
    misclassified: number;
    violations: number;
    thin?: Readonly<{ columns: number; violations: number; rows: readonly number[] }>;
  }>;
  g3: Readonly<{
    fullPixels: number;
    fullViolations: number;
    otherPixels: number;
    otherViolations: number;
    maxCount: ExactJson;
    overdrawPixels: number;
  }>;
  rule: Readonly<{ interior: DeviationStats; exterior: DeviationStats; band: DeviationStats }>;
  ref: Readonly<{ withCorners: DeviationStats; withoutCorners: DeviationStats }>;
  boundaryShift: Maybe<
    Readonly<{ sum: ExactJson; lower: ExactJson; upper: ExactJson; approx: string }>
  >;
  seam: Readonly<{ pixels: number; min: Maybe<number>; max: Maybe<number> }>;
  thinArea?: Readonly<{ observed: ExactJson; reference: ExactJson }>;
}>;

export type VariantMetrics = Readonly<{
  classes: Readonly<{ interior: number; exterior: number; band: number; near: number }>;
  samples: readonly [SampleMetricsO02, SampleMetricsO02];
  difference1x4x: Readonly<{ max: ExactJson; pixels: number }>;
}>;

function thinColumns(
  geometry: CoverageRowGeometry,
  crop: Crop,
  oracle: CoverageOracle,
): { i: number; j: number }[] {
  const S = 1n << BigInt(geometry.scaleExponent);
  const half = S >> 1n;
  const xs = geometry.referenced.map((v) => geometry.scaled[v]![0]);
  const minX = xs.reduce((a, b) => (b < a ? b : a));
  const maxX = xs.reduce((a, b) => (b > a ? b : a));
  const out: { i: number; j: number }[] = [];
  for (let i = crop.x; i < crop.x + crop.w; i += 1) {
    const cx = BigInt(2 * i + 1) * half;
    if (cx < minX || cx > maxX) continue;
    let best: { j: number; num: bigint; den: bigint } | null = null;
    for (let j = crop.y; j < crop.y + crop.h; j += 1) {
      const index = (j - crop.y) * crop.w + (i - crop.x);
      const [num, den] = oracle.inside[index]
        ? [0n, 1n]
        : segmentDistanceSquared(geometry, cx, BigInt(2 * j + 1) * half);
      if (best === null || num * best.den < best.num * den) best = { j, num, den };
    }
    if (best !== null) out.push({ i, j: best.j });
  }
  return out;
}

function sampleMetrics(
  geometry: CoverageRowGeometry,
  crop: Crop,
  oracle: CoverageOracle,
  flags: Uint8Array,
  rule: (index: number) => Rational,
  observed: Uint8Array,
  counts: Uint16Array,
  sampleCount: 1 | 4,
): SampleMetricsO02 {
  const total = crop.w * crop.h;
  const thin = geometry.id === 'THIN-Z1';
  let g1Pixels = 0;
  let g1Violations = 0;
  let g1Inside = -1;
  let g1Outside = -1;
  let misclassified = 0;
  let g2Violations = 0;
  let fullPixels = 0;
  let fullViolations = 0;
  let otherPixels = 0;
  let otherViolations = 0;
  let maxCount = 0;
  let overdraw = 0;
  const ruleStats = [new Accumulator(), new Accumulator(), new Accumulator()];
  const withCorners = new Accumulator();
  const withoutCorners = new Accumulator();
  const shiftSum = new ExactSum();
  let seamPixels = 0;
  let seamMin = -1;
  let seamMax = -1;
  let observedSum = 0;
  const referenceSum = new ExactSum();
  const W = geometry.width;
  const H = geometry.height;
  for (let index = 0; index < total; index += 1) {
    const k = observed[index]!;
    const f = flags[index]!;
    const inside = oracle.inside[index] === 1;
    const cls = oracle.classes[index]!;
    // G1.
    if (f & AT_LEAST_2) {
      g1Pixels += 1;
      const error = inside ? 255 - k : k;
      if (inside) g1Inside = Math.max(g1Inside, error);
      else g1Outside = Math.max(g1Outside, error);
      if (error > G1_TOLERANCE) g1Violations += 1;
    }
    // G2.
    if (k >= 128 !== inside) {
      misclassified += 1;
      if (!(f & WITHIN_1)) g2Violations += 1;
    }
    // G3.
    const full = inside || (f & WITHIN_G3) !== 0;
    let allOne = true;
    let allAtMostOne = true;
    for (let s = 0; s < sampleCount; s += 1) {
      const word = counts[index * sampleCount + s]!;
      const value = half24(word);
      if (value > maxCount) maxCount = value;
      if (word !== HALF_ONE) allOne = false;
      if (value > ONE24) allAtMostOne = false;
    }
    if (!allAtMostOne) overdraw += 1;
    if (full) {
      fullPixels += 1;
      if (!allOne) fullViolations += 1;
    } else {
      otherPixels += 1;
      if (!allAtMostOne) otherViolations += 1;
    }
    // obs - rule.
    ruleStats[cls]!.add(deviation(k, rule(index)));
    // obs - ref (O01).
    const ref = referenceAt(oracle, index);
    if (thin) {
      observedSum += k;
      referenceSum.add(ref);
    }
    if (cls === CLASS_INTERIOR && oracle.seam[index]) {
      seamPixels += 1;
      if (seamMin < 0 || k < seamMin) seamMin = k;
      if (k > seamMax) seamMax = k;
    } else if (cls === CLASS_BAND) {
      const value = deviation(k, ref);
      withCorners.add(value);
      if (!oracle.corner[index]) withoutCorners.add(value);
      const i = crop.x + (index % crop.w);
      const j = crop.y + Math.floor(index / crop.w);
      if (i >= 3 && i + 1 <= W - 3 && j >= 3 && j + 1 <= H - 3)
        shiftSum.addParts(value.num, value.den);
    }
  }
  let boundaryShift: SampleMetricsO02['boundaryShift'];
  const { lower, upper } = oracle.boundaryLength;
  if (!oracle.boundaryInInset) boundaryShift = 'N/A:L=0';
  else if (lower.n === 0n) boundaryShift = 'N/A:length-unresolved';
  else {
    const sum = shiftSum.value();
    const byUpper = rational(sum.n * upper.d, sum.d * upper.n);
    const byLower = rational(sum.n * lower.d, sum.d * lower.n);
    const [low, high] = compare(byUpper, byLower) <= 0 ? [byUpper, byLower] : [byLower, byUpper];
    boundaryShift = {
      sum: exactJson(sum),
      lower: exactJson(low),
      upper: exactJson(high),
      approx: ((approxNumber(low) + approxNumber(high)) / 2).toExponential(5),
    };
  }
  let thinGate: SampleMetricsO02['g2']['thin'];
  if (thin) {
    const columns = thinColumns(geometry, crop, oracle);
    let violations = 0;
    for (const { i, j } of columns)
      if (observed[(j - crop.y) * crop.w + (i - crop.x)]! === 0) violations += 1;
    thinGate = {
      columns: columns.length,
      violations,
      rows: [...new Set(columns.map((column) => column.j))].sort((a, b) => a - b),
    };
  }
  const result: SampleMetricsO02 = {
    sampleCount,
    g1: {
      pixels: g1Pixels,
      violations: g1Violations,
      maxInsideError: g1Inside < 0 ? NONE : unorm(g1Inside),
      maxOutsideError: g1Outside < 0 ? NONE : unorm(g1Outside),
    },
    g2: thinGate
      ? { misclassified, violations: g2Violations, thin: thinGate }
      : { misclassified, violations: g2Violations },
    g3: {
      fullPixels,
      fullViolations,
      otherPixels,
      otherViolations,
      maxCount: exactJson(rational(BigInt(maxCount), 1n << 24n)),
      overdrawPixels: overdraw,
    },
    rule: {
      interior: ruleStats[CLASS_INTERIOR]!.result(),
      exterior: ruleStats[CLASS_EXTERIOR]!.result(),
      band: ruleStats[CLASS_BAND]!.result(),
    },
    ref: { withCorners: withCorners.result(), withoutCorners: withoutCorners.result() },
    boundaryShift,
    seam: {
      pixels: seamPixels,
      min: seamMin < 0 ? NONE : seamMin,
      max: seamMax < 0 ? NONE : seamMax,
    },
  };
  if (!thin) return result;
  return {
    ...result,
    thinArea: { observed: unorm(observedSum), reference: exactJson(referenceSum.value()) },
  };
}

/** True when every G1-G3 obligation of one sample count holds. */
export function gatesHold(sample: SampleMetricsO02): boolean {
  return (
    sample.g1.violations === 0 &&
    sample.g2.violations === 0 &&
    (sample.g2.thin?.violations ?? 0) === 0 &&
    sample.g3.fullViolations === 0 &&
    sample.g3.otherViolations === 0
  );
}

export type VariantEvaluation = Readonly<{
  metrics: VariantMetrics;
  /** Exact rule value of a crop pixel (memoized). */
  rule: (index: number) => Rational;
}>;

export function computeVariantMetrics(
  geometry: CoverageRowGeometry,
  crop: Crop,
  oracle: CoverageOracle,
  context: RuleContext,
  passes: O02Passes,
): VariantEvaluation {
  const total = crop.w * crop.h;
  if (
    passes.main1.length !== total ||
    passes.main4.length !== total ||
    passes.count1.length !== total ||
    passes.count4.length !== 4 * total
  )
    throw new Error('metrics-o02:sample-count');
  const flags = distanceFlags(geometry, crop);
  const memo = new Map<number, Rational>();
  const rule = (index: number) => {
    let value = memo.get(index);
    if (value === undefined) {
      value = ruleValue(context, oracle, flags, crop, index);
      if (flags[index]! & WITHIN_1) memo.set(index, value);
    }
    return value;
  };
  let interior = 0;
  let exterior = 0;
  let band = 0;
  let near = 0;
  let difference = 0;
  let differing = 0;
  for (let index = 0; index < total; index += 1) {
    const cls = oracle.classes[index]!;
    if (cls === CLASS_INTERIOR) interior += 1;
    else if (cls === CLASS_EXTERIOR) exterior += 1;
    else band += 1;
    if (flags[index]! & NEAR) near += 1;
    const delta = Math.abs(passes.main1[index]! - passes.main4[index]!);
    if (delta > 0) differing += 1;
    difference = Math.max(difference, delta);
  }
  const metrics: VariantMetrics = {
    classes: { interior, exterior, band, near },
    samples: [
      sampleMetrics(geometry, crop, oracle, flags, rule, passes.main1, passes.count1, 1),
      sampleMetrics(geometry, crop, oracle, flags, rule, passes.main4, passes.count4, 4),
    ],
    difference1x4x: { max: unorm(difference), pixels: differing },
  };
  return { metrics, rule };
}

// ---------------------------------------------------------------------------------------------
// Draw observations (reported only): fragment feature evaluations and clip-volume exposure.

export type DrawStats = Readonly<{
  regionPrimitives: number;
  exteriorPrimitives: number;
  droppedExterior: number;
  maxFeatures: number;
  p99Features: number;
  featureBytes: number;
  /** Drawn primitives only, in draw order. */
  perPrimitive: readonly Readonly<{
    triangle: readonly [number, number, number];
    role: 0 | 1;
    count: number;
  }>[];
}>;

export type DrawObservations = Readonly<{
  maxFeatures: number;
  p99Features: number;
  featureBytes: number;
  droppedExterior: number;
  fragmentFeatureEvaluations: Readonly<{
    label: 'proxy, crop-limited';
    /** Sum over drawn primitives of crop pixel centers in the closed triangle times its count. */
    value: string;
    /** Crop pixel centers on a closed edge shared by two drawn primitives (counted for both). */
    sharedEdgeCenters: number;
  }>;
  /** Some drawn vertex has |NDC x| > 1 or |NDC y| > 1. */
  clipOutside: boolean;
}>;

/** Odd t = 2i + 1 with a t h + b >= 0 restricted to [lo, hi]; returns the i range or null. */
function halfPlaneRange(a: bigint, b: bigint, h: bigint, lo: bigint, hi: bigint) {
  // a h t >= -b
  const k = a * h;
  if (k === 0n) return b >= 0n ? [lo, hi] : null;
  if (k > 0n) {
    const t = ceilDivBig(-b, k);
    const i = ceilDivBig(t - 1n, 2n);
    return [i > lo ? i : lo, hi];
  }
  const t = floorDivBig(b, -k);
  const i = floorDivBig(t - 1n, 2n);
  return [lo, i < hi ? i : hi];
}

function floorDivBig(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

function ceilDivBig(a: bigint, b: bigint): bigint {
  return -floorDivBig(-a, b);
}

/** Number of crop pixel centers in the closed triangle (exact, scaled points, unit 2^-k). */
export function centersInTriangle(
  points: readonly (readonly [bigint, bigint])[],
  triangle: readonly [number, number, number],
  scaleExponent: number,
  crop: Crop,
): number {
  if (scaleExponent < 1) throw new Error('metrics-o02:scale');
  const h = 1n << BigInt(scaleExponent - 1);
  const [p, q, r] = triangle.map((v) => points[v]!) as [
    readonly [bigint, bigint],
    readonly [bigint, bigint],
    readonly [bigint, bigint],
  ];
  const o = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (o === 0n) return 0;
  const s = o > 0n ? 1n : -1n;
  const ys = [p[1], q[1], r[1]];
  const yMin = ys.reduce((x, y) => (y < x ? y : x));
  const yMax = ys.reduce((x, y) => (y > x ? y : x));
  let j0 = ceilDivBig(ceilDivBig(yMin, h) - 1n, 2n);
  let j1 = floorDivBig(floorDivBig(yMax, h) - 1n, 2n);
  if (j0 < BigInt(crop.y)) j0 = BigInt(crop.y);
  if (j1 > BigInt(crop.y + crop.h - 1)) j1 = BigInt(crop.y + crop.h - 1);
  const edges = [
    [p, q],
    [q, r],
    [r, p],
  ] as const;
  let total = 0;
  for (let j = j0; j <= j1; j += 1n) {
    const Y = (2n * j + 1n) * h;
    let lo = BigInt(crop.x);
    let hi = BigInt(crop.x + crop.w - 1);
    for (const [u, v] of edges) {
      const dx = v[0] - u[0];
      const dy = v[1] - u[1];
      // s (dx (Y - uy) - dy (X - ux)) >= 0  <=>  (-s dy) X + s (dx (Y - uy) + dy ux) >= 0.
      const range = halfPlaneRange(-s * dy, s * (dx * (Y - u[1]) + dy * u[0]), h, lo, hi);
      if (range === null) {
        lo = 1n;
        hi = 0n;
        break;
      }
      [lo, hi] = range as [bigint, bigint];
      if (lo > hi) break;
    }
    if (lo <= hi) total += Number(hi - lo + 1n);
  }
  return total;
}

/** Crop pixel centers lying on the closed segment ab (scaled points), as crop indices. */
function centersOnSegment(
  a: readonly [bigint, bigint],
  b: readonly [bigint, bigint],
  scaleExponent: number,
  crop: Crop,
  out: Set<number>,
): void {
  const h = 1n << BigInt(scaleExponent - 1);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const inCrop = (i: bigint, j: bigint) =>
    i >= BigInt(crop.x) &&
    i < BigInt(crop.x + crop.w) &&
    j >= BigInt(crop.y) &&
    j < BigInt(crop.y + crop.h);
  const isCenter = (value: bigint) => value % h === 0n && ((value / h) & 1n) !== 0n;
  const [major, minor] = (dx < 0n ? -dx : dx) >= (dy < 0n ? -dy : dy) ? [0, 1] : [1, 0];
  const d = [dx, dy];
  const lowM = a[major]! < b[major]! ? a[major]! : b[major]!;
  const highM = a[major]! < b[major]! ? b[major]! : a[major]!;
  let k0 = ceilDivBig(ceilDivBig(lowM, h) - 1n, 2n);
  let k1 = floorDivBig(floorDivBig(highM, h) - 1n, 2n);
  const [cLo, cHi] = major === 0 ? [crop.x, crop.x + crop.w - 1] : [crop.y, crop.y + crop.h - 1];
  if (k0 < BigInt(cLo)) k0 = BigInt(cLo);
  if (k1 > BigInt(cHi)) k1 = BigInt(cHi);
  for (let k = k0; k <= k1; k += 1n) {
    const M = (2n * k + 1n) * h;
    // minor = a_minor + d_minor (M - a_major) / d_major, exactly.
    const num = a[minor]! * d[major]! + d[minor]! * (M - a[major]!);
    if (num % d[major]! !== 0n) continue;
    const value = num / d[major]!;
    if (!isCenter(value)) continue;
    const other = (value / h - 1n) / 2n;
    const [i, j] = major === 0 ? [k, other] : [other, k];
    if (inCrop(i, j)) out.add(Number((j - BigInt(crop.y)) * BigInt(crop.w) + (i - BigInt(crop.x))));
  }
}

export function drawObservations(
  scaled: readonly (readonly [bigint, bigint])[],
  scaleExponent: number,
  ndcBits: readonly (readonly [number, number])[],
  crop: Crop,
  stats: DrawStats,
): DrawObservations {
  let evaluations = 0n;
  const uses = new Map<string, number>();
  let clipOutside = false;
  const view = new DataView(new ArrayBuffer(4));
  const ndc = (word: number) => {
    view.setUint32(0, word >>> 0);
    return view.getFloat32(0);
  };
  for (const primitive of stats.perPrimitive) {
    const covered = centersInTriangle(scaled, primitive.triangle, scaleExponent, crop);
    evaluations += BigInt(covered) * BigInt(primitive.count);
    for (let side = 0; side < 3; side += 1) {
      const u = primitive.triangle[side]!;
      const v = primitive.triangle[(side + 1) % 3]!;
      const key = `${Math.min(u, v)}:${Math.max(u, v)}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
    for (const vertex of primitive.triangle) {
      const [x, y] = ndcBits[vertex]!;
      if (Math.abs(ndc(x)) > 1 || Math.abs(ndc(y)) > 1) clipOutside = true;
    }
  }
  const shared = new Set<number>();
  for (const [key, count] of [...uses.entries()].sort()) {
    if (count < 2) continue;
    const [u, v] = key.split(':').map(Number) as [number, number];
    centersOnSegment(scaled[u]!, scaled[v]!, scaleExponent, crop, shared);
  }
  return {
    maxFeatures: stats.maxFeatures,
    p99Features: stats.p99Features,
    featureBytes: stats.featureBytes,
    droppedExterior: stats.droppedExterior,
    fragmentFeatureEvaluations: {
      label: 'proxy, crop-limited',
      value: evaluations.toString(),
      sharedEdgeCenters: shared.size,
    },
    clipOutside,
  };
}
