// Exact tolerance and fringe buckets of the P3 V3 contract, section c. Every Float64 is a
// dyadic rational, so S = DPR * zoom * L, F = |S|_F^2 and D = det S are formed exactly with
// BigInt numerators and binary exponents. No rounded log2 or quotient decides a boundary.

/** V2's accepted exponent range (V2 contract, section d). Internal; not part of the port. */
export const E_MIN = -1021;
export const E_MAX = 1023;
/**
 * The stroke port's accepted lower bound (B2 stroke contract, sections 7.7 and 9.3): a bucket
 * e < -1020 is the state failure tolerance-range for the stroke paint. E_MAX applies to both.
 */
export const STROKE_E_MIN = -1020;
/** Bounds rho = 2^f to positive finite Float64 values. */
export const F_MIN = -1074;
export const F_MAX = 1023;

/** value = n * 2^e */
type Dyadic = Readonly<{ n: bigint; e: number }>;

export type PathLinearMap = readonly [number, number, number, number];

export type PathBuckets =
  | Readonly<{ singular: true }>
  | Readonly<{
      singular: false;
      /** Largest e with 2^e * sigmaMax(S) <= 0.125, clamped into [E_MIN - 1, E_MAX + 1]. */
      e: number;
      /** Smallest f with 2^f * sigmaMin(S) >= 2, clamped into [F_MIN - 1, F_MAX + 1]. */
      f: number;
      /** sign(det L) from the exact determinant. */
      orientation: 1 | -1;
      /** True when the f32 lanes' determinant, evaluated exactly, is 0 or has the opposite sign. */
      f32OrientationMismatch: boolean;
    }>;

const ZERO: Dyadic = Object.freeze({ n: 0n, e: 0 });
const scratch = new DataView(new ArrayBuffer(8));

export function toDyadic(value: number): Dyadic {
  if (!Number.isFinite(value)) throw new RangeError('A dyadic value must be finite.');
  if (value === 0) return ZERO;
  scratch.setFloat64(0, value);
  const high = scratch.getUint32(0);
  const low = scratch.getUint32(4);
  const biased = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  let exponent: number;
  if (biased === 0) {
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n;
    exponent = biased - 1075;
  }
  return Object.freeze({ n: high >>> 31 === 1 ? -mantissa : mantissa, e: exponent });
}

function multiply(left: Dyadic, right: Dyadic): Dyadic {
  if (left.n === 0n || right.n === 0n) return ZERO;
  return { n: left.n * right.n, e: left.e + right.e };
}

function add(left: Dyadic, right: Dyadic): Dyadic {
  if (left.n === 0n) return right;
  if (right.n === 0n) return left;
  if (left.e === right.e) return { n: left.n + right.n, e: left.e };
  if (left.e < right.e) return { n: left.n + (right.n << BigInt(right.e - left.e)), e: left.e };
  return { n: (left.n << BigInt(left.e - right.e)) + right.n, e: right.e };
}

function negate(value: Dyadic): Dyadic {
  return { n: -value.n, e: value.e };
}

function sign(value: Dyadic): -1 | 0 | 1 {
  return value.n === 0n ? 0 : value.n > 0n ? 1 : -1;
}

function compare(left: Dyadic, right: Dyadic): -1 | 0 | 1 {
  return sign(add(left, negate(right)));
}

function powerOfTwo(exponent: number): Dyadic {
  return { n: 1n, e: exponent };
}

/** floor(log2 |value|) for a nonzero dyadic. */
function floorLog2(value: Dyadic): number {
  const magnitude = value.n < 0n ? -value.n : value.n;
  return magnitude.toString(2).length - 1 + value.e;
}

function determinant(a: Dyadic, b: Dyadic, c: Dyadic, d: Dyadic): Dyadic {
  // Affine lanes [a, b, c, d] map x' = a x + c y, y' = b x + d y.
  return add(multiply(a, d), negate(multiply(b, c)));
}

/** q(t) = t^2 - F t + D^2 >= 0 */
function quadraticNonnegative(t: Dyadic, frobenius: Dyadic, determinantSquared: Dyadic): boolean {
  return sign(add(add(multiply(t, t), negate(multiply(frobenius, t))), determinantSquared)) >= 0;
}

/** sigmaMax(S)^2 <= t exactly when 2t >= F and q(t) >= 0. */
function sigmaMaxSquaredAtMost(t: Dyadic, frobenius: Dyadic, determinantSquared: Dyadic): boolean {
  return (
    compare(multiply(t, powerOfTwo(1)), frobenius) >= 0 &&
    quadraticNonnegative(t, frobenius, determinantSquared)
  );
}

/** sigmaMin(S)^2 >= t exactly when 2t <= F and q(t) >= 0. */
function sigmaMinSquaredAtLeast(t: Dyadic, frobenius: Dyadic, determinantSquared: Dyadic): boolean {
  return (
    compare(multiply(t, powerOfTwo(1)), frobenius) <= 0 &&
    quadraticNonnegative(t, frobenius, determinantSquared)
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

/**
 * Computes the buckets for the node's Float64 world linear map L, the camera zoom and the DPR.
 * `zoom` and `devicePixelRatio` are finite and positive; L is finite by scene validation.
 */
export function computePathBuckets(
  linear: PathLinearMap,
  zoom: number,
  devicePixelRatio: number,
): PathBuckets {
  const lanes = linear.map(toDyadic) as unknown as readonly [Dyadic, Dyadic, Dyadic, Dyadic];
  const exactDeterminantL = determinant(lanes[0], lanes[1], lanes[2], lanes[3]);
  // D = 0 exactly (singular, including zero L) is not drawable: P1 D2's singular rule.
  if (exactDeterminantL.n === 0n) return Object.freeze({ singular: true });

  const scale = multiply(toDyadic(devicePixelRatio), toDyadic(zoom));
  const s = lanes.map((lane) => multiply(scale, lane)) as unknown as readonly [
    Dyadic,
    Dyadic,
    Dyadic,
    Dyadic,
  ];
  let frobenius: Dyadic = ZERO;
  for (const entry of s) frobenius = add(frobenius, multiply(entry, entry));
  const detS = determinant(s[0], s[1], s[2], s[3]);
  const determinantSquared = multiply(detS, detS);

  // e: the largest integer with sigmaMax^2 <= 2^(-6 - 2e). F/2 <= sigmaMax^2 <= F, so the start
  // from bitLength(F) lies within two steps of the answer.
  const logF = floorLog2(frobenius);
  const holdsE = (e: number) =>
    sigmaMaxSquaredAtMost(powerOfTwo(-6 - 2 * e), frobenius, determinantSquared);
  let e = clamp(Math.floor((-6 - logF) / 2), E_MIN - 1, E_MAX + 1);
  if (holdsE(e)) {
    while (e < E_MAX + 1 && holdsE(e + 1)) e += 1;
  } else {
    while (e > E_MIN - 1) {
      e -= 1;
      if (holdsE(e)) break;
    }
  }

  // f: the smallest integer with sigmaMin^2 >= 2^(2 - 2f). sigmaMin^2 = D^2 / sigmaMax^2 lies in
  // [D^2/F, 2 D^2/F], so the start from bitLength(D^2) - bitLength(F) is within two steps.
  const logMin = floorLog2(determinantSquared) - logF;
  const holdsF = (f: number) =>
    sigmaMinSquaredAtLeast(powerOfTwo(2 - 2 * f), frobenius, determinantSquared);
  let f = clamp(Math.ceil((2 - logMin) / 2), F_MIN - 1, F_MAX + 1);
  if (holdsF(f)) {
    while (f > F_MIN - 1 && holdsF(f - 1)) f -= 1;
  } else {
    while (f < F_MAX + 1) {
      f += 1;
      if (holdsF(f)) break;
    }
  }

  const orientation = sign(exactDeterminantL) > 0 ? 1 : -1;
  const f32Values = linear.map((lane) => Math.fround(lane));
  // A nonfinite f32 lane cannot carry the orientation either (section f's packing-range).
  let f32OrientationMismatch = !f32Values.every(Number.isFinite);
  if (!f32OrientationMismatch) {
    const f32Lanes = f32Values.map(toDyadic);
    const f32Determinant = determinant(f32Lanes[0]!, f32Lanes[1]!, f32Lanes[2]!, f32Lanes[3]!);
    f32OrientationMismatch = sign(f32Determinant) !== orientation;
  }
  return Object.freeze({ singular: false, e, f, orientation, f32OrientationMismatch });
}

/**
 * E26-U5d-3: what a path's buckets need to be checked at another zoom or DPR without the exact
 * computation: |L|_F^2 and (det L)^2, formed exactly and rounded to Float64 within 1 ulp, and the exact
 * buckets they were found with.
 */
export type BucketHint = Readonly<{
  frobenius: number;
  determinantSquared: number;
  buckets: Extract<PathBuckets, { singular: false }>;
}>;

/** E26-U5d-3: the relative margin of `bucketsHoldAt`; its float error is below 2e-7. */
const HINT_MARGIN = 1e-6;
/** E26-U5d-3: bucket exponents the hint decides; outside them it always declines. */
const HINT_EXPONENTS = 480;

/** E26-U5d-3: the hint for exact `buckets` of L, or null where `bucketsHoldAt` would decline. */
export function bucketHint(linear: PathLinearMap, buckets: PathBuckets): BucketHint | null {
  if (buckets.singular) return null;
  if (Math.abs(buckets.e) > HINT_EXPONENTS || Math.abs(buckets.f) > HINT_EXPONENTS) return null;
  const lanes = linear.map(toDyadic) as unknown as readonly [Dyadic, Dyadic, Dyadic, Dyadic];
  let frobenius: Dyadic = ZERO;
  for (const lane of lanes) frobenius = add(frobenius, multiply(lane, lane));
  const det = determinant(lanes[0], lanes[1], lanes[2], lanes[3]);
  const f = dyadicToNumber(frobenius);
  const d = dyadicToNumber(multiply(det, det));
  if (!(f > 2 ** -900 && f < 2 ** 400 && d > 2 ** -900 && d < 2 ** 800)) return null;
  return Object.freeze({ frobenius: f, determinantSquared: d, buckets });
}

/**
 * E26-U5d-3: true only when the hint's buckets are the exact buckets at this zoom and DPR (false
 * means only that the caller must compute them). With s = DPR * zoom, e holds when
 * s^2 sigmaMax(L)^2 lies in (2^(-8 - 2e), 2^(-6 - 2e)] and f when s^2 sigmaMin(L)^2 lies in
 * [2^(2 - 2f), 2^(4 - 2f)); the singular values come from F and D^2 in Float64
 * (sigmaMax^2 = (F + sqrt(F^2 - 4 D^2)) / 2, sigmaMin^2 = D^2 / sigmaMax^2). Their relative error is
 * below 2e-7 (the square root's argument loses at most about 8 ulp of F^2, which moves the root by
 * at most sqrt(8 eps) F), so each value must clear its interval by the 1e-6 margin. The
 * orientation and the f32 check do not depend on s. It declines whenever s^2 or s^2 D^2 would be
 * subnormal, and the hint declines for exponents past ±480 and extreme F or D^2. The buckets served are the hint's own object,
 * so an f of -0 from the exact computation's start estimate may stand for +0: f is used only as an
 * exponent and a fringe variant key, where the two are the same.
 */
export function bucketsHoldAt(hint: BucketHint, zoom: number, devicePixelRatio: number): boolean {
  const { e, f } = hint.buckets;
  const scale = devicePixelRatio * zoom;
  const scaleSquared = scale * scale;
  const { frobenius, determinantSquared } = hint;
  // Every intermediate must stay normal: a subnormal s^2 or s^2 D^2 carries no relative bound.
  if (!(scaleSquared >= 2 ** -1000 && scaleSquared * determinantSquared >= 2 ** -1000)) {
    return false;
  }
  const root = Math.sqrt(Math.max(0, frobenius * frobenius - 4 * determinantSquared));
  const maxSquared = (scaleSquared * (frobenius + root)) / 2;
  const minSquared = (scaleSquared * determinantSquared) / ((frobenius + root) / 2);
  if (!(maxSquared > 2 ** -1000 && minSquared > 2 ** -1000)) return false;
  if (!Number.isFinite(maxSquared) || !Number.isFinite(minSquared)) return false;
  return (
    maxSquared * (1 + HINT_MARGIN) <= 2 ** (-6 - 2 * e) &&
    maxSquared * (1 - HINT_MARGIN) > 2 ** (-8 - 2 * e) &&
    minSquared * (1 - HINT_MARGIN) >= 2 ** (2 - 2 * f) &&
    minSquared * (1 + HINT_MARGIN) < 2 ** (4 - 2 * f)
  );
}

/** A dyadic in Float64 within 1 ulp: a 2^-60 truncation, then one rounding. */
function dyadicToNumber(value: Dyadic): number {
  if (value.n === 0n) return 0;
  const magnitude = value.n < 0n ? -value.n : value.n;
  const shift = Math.max(0, magnitude.toString(2).length - 60);
  const head = Number(magnitude >> BigInt(shift));
  const exponent = value.e + shift;
  const result = head * 2 ** Math.trunc(exponent / 2) * 2 ** (exponent - Math.trunc(exponent / 2));
  return value.n < 0n ? -result : result;
}
