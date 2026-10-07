import { compare, rational, type Rational } from '../rounded-fill/exact.js';
import type { Crop } from './crop.js';
import { approxNumber, ExactSum, exactJson, type ExactJson } from './numeric.js';
import { CLASS_BAND, CLASS_EXTERIOR, CLASS_INTERIOR, type CoverageOracle } from './oracle.js';
import type { CoverageRowGeometry } from './positions.js';

/**
 * P3.1o O01 metrics (docs/plans/p3-o01-coverage-experiment-contract.md, "Metrics"). Every exact value
 * is {n, d, approx} with approx = toExponential(5). Missing populations are reported as strings:
 * `N/A:none` (no pixel of that class), `N/A:L=0` (no boundary length inside V'),
 * `N/A:length-unresolved` (positive length whose 2^-64 lower bound is 0).
 */

export const CANDIDATES = ['A1', 'A2', 'A5'] as const;
export type Candidate = (typeof CANDIDATES)[number];

/** Decoded crop samples of one candidate: unorm8 main passes and binary16 diagnostic words. */
export type CandidatePasses = Readonly<{
  candidate: Candidate;
  main1: Uint8Array;
  main4: Uint8Array;
  diagMax: Uint16Array;
  diagAdd: Uint16Array;
}>;

type Maybe<T> = T | string;

export type BandStats = Readonly<{
  count: number;
  max: Maybe<ExactJson>;
  min: Maybe<ExactJson>;
  maxAbs: Maybe<ExactJson>;
  meanSquare: Maybe<ExactJson>;
  rms: Maybe<string>;
}>;

export type SampleMetrics = Readonly<{
  sampleCount: 1 | 4;
  interiorError: Maybe<ExactJson>;
  exteriorError: Maybe<ExactJson>;
  band: Readonly<{ withCorners: BandStats; withoutCorners: BandStats }>;
  boundaryShift: Maybe<
    Readonly<{ sum: ExactJson; lower: ExactJson; upper: ExactJson; approx: string }>
  >;
  seamError: Maybe<ExactJson>;
  thinArea?: Readonly<{ observed: ExactJson; reference: ExactJson }>;
}>;

export type OverlapStats = Readonly<{ count: number; max: Maybe<ExactJson>; mass: ExactJson }>;

export type CandidateMetrics = Readonly<{
  candidate: Candidate;
  samples: readonly [SampleMetrics, SampleMetrics];
  difference1x4x: ExactJson;
  overlap: Readonly<{
    interior: OverlapStats;
    exterior: OverlapStats;
    band: OverlapStats;
    corner: OverlapStats;
    seam: OverlapStats;
  }>;
}>;

export type ClassCounts = Readonly<{
  interior: number;
  exterior: number;
  band: number;
  corner: number;
  seam: number;
  crossing: number;
}>;

export type RowMetrics = Readonly<{
  classes: ClassCounts;
  boundaryLength: Readonly<{ lower: ExactJson; upper: ExactJson }>;
  candidates: readonly CandidateMetrics[];
}>;

const NONE = 'N/A:none';
const ZERO = rational(0n);
const ONE = rational(1n);
const DIFF_255 = 255n;

/** obs - ref as an exact fraction num / den (den > 0) for obs = k / 255 and ref = n / d. */
type Fraction = Readonly<{ num: bigint; den: bigint }>;

function lessThan(a: Fraction, b: Fraction): boolean {
  return a.num * b.den < b.num * a.den;
}

function fractionJson(value: Fraction): ExactJson {
  return exactJson(rational(value.num, value.den));
}

class BandAccumulator {
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

  result(): BandStats {
    if (this.count === 0 || this.max === null || this.min === null)
      return { count: 0, max: NONE, min: NONE, maxAbs: NONE, meanSquare: NONE, rms: NONE };
    const negatedMin: Fraction = { num: -this.min.num, den: this.min.den };
    const maxAbs = lessThan(this.max, negatedMin) ? negatedMin : this.max;
    const sum = this.squares.value();
    const meanSquare = rational(sum.n, sum.d * BigInt(this.count));
    return {
      count: this.count,
      max: fractionJson(this.max),
      min: fractionJson(this.min),
      maxAbs: fractionJson(maxAbs),
      meanSquare: exactJson(meanSquare),
      rms: Math.sqrt(approxNumber(meanSquare)).toExponential(5),
    };
  }
}

function deviation(k: number, ref: Rational): Fraction {
  return { num: BigInt(k) * ref.d - DIFF_255 * ref.n, den: DIFF_255 * ref.d };
}

function unorm(k: number): ExactJson {
  return exactJson(rational(BigInt(k), DIFF_255));
}

/** Exact binary16 value times 2^24 (an integer, finite words only). */
function half24(word: number): number {
  const exponent = (word >>> 10) & 0x1f;
  if (exponent === 0x1f) throw new Error(`metrics:f16-nonfinite:${word}`);
  const fraction = word & 0x3ff;
  const magnitude = exponent === 0 ? fraction : (fraction | 0x400) * 2 ** (exponent - 1);
  return (word & 0x8000) !== 0 ? -magnitude : magnitude;
}

function sampleMetrics(
  geometry: CoverageRowGeometry,
  crop: Crop,
  oracle: CoverageOracle,
  observed: Uint8Array,
  sampleCount: 1 | 4,
): SampleMetrics {
  const total = crop.w * crop.h;
  let interiorMin = -1;
  let exteriorMax = -1;
  let seamMin = -1;
  const withCorners = new BandAccumulator();
  const withoutCorners = new BandAccumulator();
  const shiftSum = new ExactSum();
  let observedSum = 0;
  const referenceSum = new ExactSum();
  const thin = geometry.id === 'THIN-Z1';
  const W = geometry.width;
  const H = geometry.height;
  for (let index = 0; index < total; index += 1) {
    const k = observed[index]!;
    const cls = oracle.classes[index]!;
    const ref = oracle.crossing.get(index) ?? (oracle.inside[index] ? ONE : ZERO);
    if (thin) {
      observedSum += k;
      referenceSum.add(ref);
    }
    if (cls === CLASS_INTERIOR) {
      if (interiorMin < 0 || k < interiorMin) interiorMin = k;
      if (oracle.seam[index] && (seamMin < 0 || k < seamMin)) seamMin = k;
    } else if (cls === CLASS_EXTERIOR) {
      if (k > exteriorMax) exteriorMax = k;
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
  let boundaryShift: SampleMetrics['boundaryShift'];
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
  const result: SampleMetrics = {
    sampleCount,
    interiorError: interiorMin < 0 ? NONE : unorm(255 - interiorMin),
    exteriorError: exteriorMax < 0 ? NONE : unorm(exteriorMax),
    band: { withCorners: withCorners.result(), withoutCorners: withoutCorners.result() },
    boundaryShift,
    seamError: seamMin < 0 ? NONE : unorm(255 - seamMin),
  };
  if (!thin) return result;
  return {
    ...result,
    thinArea: {
      observed: unorm(observedSum),
      reference: exactJson(referenceSum.value()),
    },
  };
}

function overlapStats(passes: CandidatePasses, select: (index: number) => boolean): OverlapStats {
  let count = 0;
  let max: number | null = null;
  let mass = 0n;
  for (let index = 0; index < passes.diagAdd.length; index += 1) {
    if (!select(index)) continue;
    const difference = half24(passes.diagAdd[index]!) - half24(passes.diagMax[index]!);
    if (difference !== 0) count += 1;
    if (max === null || difference > max) max = difference;
    mass += BigInt(difference);
  }
  const scale = 1n << 24n;
  return {
    count,
    max: max === null ? NONE : exactJson(rational(BigInt(max), scale)),
    mass: exactJson(rational(mass, scale)),
  };
}

export function classCounts(oracle: CoverageOracle): ClassCounts {
  let interior = 0;
  let exterior = 0;
  let band = 0;
  let corner = 0;
  let seam = 0;
  oracle.classes.forEach((cls, index) => {
    if (cls === CLASS_INTERIOR) interior += 1;
    else if (cls === CLASS_EXTERIOR) exterior += 1;
    else band += 1;
    corner += oracle.corner[index]!;
    seam += oracle.seam[index]!;
  });
  return { interior, exterior, band, corner, seam, crossing: oracle.crossing.size };
}

export function computeRowMetrics(
  geometry: CoverageRowGeometry,
  crop: Crop,
  oracle: CoverageOracle,
  passes: readonly CandidatePasses[],
): RowMetrics {
  const total = crop.w * crop.h;
  if (passes.map((pass) => pass.candidate).join() !== CANDIDATES.join())
    throw new Error('metrics:candidate-order');
  const candidates = passes.map((pass): CandidateMetrics => {
    for (const samples of [pass.main1, pass.main4, pass.diagMax, pass.diagAdd])
      if (samples.length !== total) throw new Error('metrics:sample-count');
    let difference = 0;
    for (let index = 0; index < total; index += 1)
      difference = Math.max(difference, Math.abs(pass.main1[index]! - pass.main4[index]!));
    return {
      candidate: pass.candidate,
      samples: [
        sampleMetrics(geometry, crop, oracle, pass.main1, 1),
        sampleMetrics(geometry, crop, oracle, pass.main4, 4),
      ],
      difference1x4x: unorm(difference),
      overlap: {
        interior: overlapStats(pass, (i) => oracle.classes[i] === CLASS_INTERIOR),
        exterior: overlapStats(pass, (i) => oracle.classes[i] === CLASS_EXTERIOR),
        band: overlapStats(pass, (i) => oracle.classes[i] === CLASS_BAND),
        corner: overlapStats(pass, (i) => oracle.corner[i] === 1),
        seam: overlapStats(pass, (i) => oracle.seam[i] === 1),
      },
    };
  });
  return {
    classes: classCounts(oracle),
    boundaryLength: {
      lower: exactJson(oracle.boundaryLength.lower),
      upper: exactJson(oracle.boundaryLength.upper),
    },
    candidates,
  };
}
