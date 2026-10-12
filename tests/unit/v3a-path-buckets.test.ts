import { describe, expect, it } from 'vitest';
import {
  E_MAX,
  E_MIN,
  F_MAX,
  F_MIN,
  computePathBuckets,
  type PathLinearMap,
} from '../../packages/renderer-core/src/path-buckets.js';

// V3-A5 (P3 V3 contract, section c). The oracle below is independent of the implementation:
// it scales every Float64 to an integer over 2^1074 by repeated exact doubling, forms
// M = S^T S over a common power of two, and decides each bucket boundary with Sylvester's
// criterion on t I - M (or M - t I), scanning every candidate exponent (brute force) instead of
// the implementation's quadratic q(t) and bit-length start.

const SCALE = 1074;

function exactNumerator(value: number): bigint {
  // value = m * 2^k with m an integer: doubling a non-integer Float64 below 2^53 is exact.
  let mantissa = value;
  let exponent = 0;
  while (!Number.isInteger(mantissa)) {
    mantissa *= 2;
    exponent -= 1;
  }
  return BigInt(mantissa) << BigInt(SCALE + exponent);
}

type OracleMatrix = Readonly<{ m11: bigint; m22: bigint; m12: bigint; shift: number }>;

function oracleMatrix(linear: PathLinearMap, zoom: number, dpr: number): OracleMatrix {
  const k = exactNumerator(zoom) * exactNumerator(dpr);
  const [a, b, c, d] = linear.map((lane) => k * exactNumerator(lane)) as [
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  // S = [[a, c], [b, d]] over 2^(3 * SCALE); M = S^T S over 2^(6 * SCALE).
  return { m11: a * a + b * b, m22: c * c + d * d, m12: a * c + b * d, shift: 6 * SCALE };
}

function powerNumerator(p: number, shift: number): bigint {
  if (p + shift < 0) throw new Error('oracle scale too small');
  return 1n << BigInt(p + shift);
}

/** sigmaMax^2 <= 2^p, by Sylvester's criterion on 2^p I - M. */
function oracleMaxAtMost(matrix: OracleMatrix, p: number): boolean {
  const t = powerNumerator(p, matrix.shift);
  const x = t - matrix.m11;
  const y = t - matrix.m22;
  return x >= 0n && y >= 0n && x * y - matrix.m12 * matrix.m12 >= 0n;
}

/** sigmaMin^2 >= 2^p, by Sylvester's criterion on M - 2^p I. */
function oracleMinAtLeast(matrix: OracleMatrix, p: number): boolean {
  const t = powerNumerator(p, matrix.shift);
  const x = matrix.m11 - t;
  const y = matrix.m22 - t;
  return x >= 0n && y >= 0n && x * y - matrix.m12 * matrix.m12 >= 0n;
}

function oracleBuckets(linear: PathLinearMap, zoom: number, dpr: number) {
  const [a, b, c, d] = linear.map(exactNumerator) as [bigint, bigint, bigint, bigint];
  if (a * d - b * c === 0n) return { singular: true as const };
  const matrix = oracleMatrix(linear, zoom, dpr);
  let e = E_MIN - 1;
  for (let candidate = E_MAX + 1; candidate >= E_MIN - 1; candidate -= 1) {
    if (oracleMaxAtMost(matrix, -6 - 2 * candidate)) {
      e = candidate;
      break;
    }
  }
  let f = F_MAX + 1;
  for (let candidate = F_MIN - 1; candidate <= F_MAX + 1; candidate += 1) {
    if (oracleMinAtLeast(matrix, 2 - 2 * candidate)) {
      f = candidate;
      break;
    }
  }
  const sign = (value: bigint) => (value > 0n ? 1 : value < 0n ? -1 : 0);
  const exactSign = sign(a * d - b * c);
  const f32 = linear.map((lane) => Math.fround(lane));
  const f32Mismatch = !f32.every(Number.isFinite)
    ? true
    : (() => {
        const [fa, fb, fc, fd] = f32.map(exactNumerator) as [bigint, bigint, bigint, bigint];
        return sign(fa * fd - fb * fc) !== exactSign;
      })();
  return {
    singular: false as const,
    e,
    f,
    orientation: exactSign,
    f32OrientationMismatch: f32Mismatch,
  };
}

const third = 1 / 3;
const cos30 = Math.cos(Math.PI / 6);
const sin30 = Math.sin(Math.PI / 6);

const CASES: ReadonlyArray<
  Readonly<{ name: string; linear: PathLinearMap; zoom: number; dpr: number }>
> = [
  { name: 'identity', linear: [1, 0, 0, 1], zoom: 1, dpr: 1 },
  { name: 'scaled identity 2^-20', linear: [2 ** -20, 0, 0, 2 ** -20], zoom: 1, dpr: 1 },
  { name: 'scaled identity 2^7 at dpr 1.5', linear: [128, 0, 0, 128], zoom: 1, dpr: 1.5 },
  { name: 'scaled identity 3', linear: [3, 0, 0, 3], zoom: 1, dpr: 2 },
  { name: 'scaled identity 0.1', linear: [0.1, 0, 0, 0.1], zoom: 3, dpr: 1 },
  { name: 'rotation +90', linear: [0, 1, -1, 0], zoom: 1, dpr: 1 },
  { name: 'rotation -90 scaled', linear: [0, -4, 4, 0], zoom: 0.5, dpr: 1 },
  {
    name: 'rotation 30 anisotropic',
    linear: [3 * cos30, 3 * sin30, -0.5 * sin30, 0.5 * cos30],
    zoom: 1,
    dpr: 1,
  },
  { name: 'shear', linear: [1, 0, 0.5, 1], zoom: 1, dpr: 1 },
  { name: 'tiny shear', linear: [1, 2 ** -30, 0, 1], zoom: 1, dpr: 1 },
  { name: 'reflection x', linear: [-1, 0, 0, 1], zoom: 1, dpr: 1 },
  { name: 'reflection y scaled', linear: [2, 0, 0, -2], zoom: 1.25, dpr: 1 },
  { name: 'near-singular', linear: [1, 1, 1, 1 + 2 ** -52], zoom: 1, dpr: 1 },
  {
    name: 'near-singular small',
    linear: [2 ** -500, 2 ** -500, 2 ** -500, 2 ** -500 * (1 + 2 ** -52)],
    zoom: 1,
    dpr: 1,
  },
  { name: 'extreme anisotropy', linear: [2 ** 1000, 0, 0, 2 ** -1000], zoom: 1, dpr: 1 },
  { name: 'largest finite', linear: [Number.MAX_VALUE, 0, 0, Number.MAX_VALUE], zoom: 1, dpr: 1 },
  {
    name: 'largest finite at large zoom',
    linear: [Number.MAX_VALUE, 0, 0, 1],
    zoom: 2 ** 20,
    dpr: 2,
  },
  {
    name: 'smallest subnormal',
    linear: [Number.MIN_VALUE, 0, 0, Number.MIN_VALUE],
    zoom: 1,
    dpr: 1,
  },
  {
    name: 'smallest subnormal at tiny zoom',
    linear: [Number.MIN_VALUE, 0, 0, 1],
    zoom: 2 ** -20,
    dpr: 1,
  },
  {
    name: 'mixed extremes',
    linear: [Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 1],
    zoom: 1,
    dpr: 1,
  },
  { name: 'rounded quotient e', linear: [1, 0, 0, 1], zoom: third + 2 ** -54, dpr: 3 },
  { name: 'rounded quotient f', linear: [1, 0, 0, 1], zoom: third, dpr: 3 },
  { name: 'just above a power of two', linear: [1 + 2 ** -52, 0, 0, 1], zoom: 1, dpr: 1 },
  {
    name: 'just below a power of two',
    linear: [1 - 2 ** -53, 0, 0, 1 - 2 ** -53],
    zoom: 1,
    dpr: 1,
  },
  { name: 'f32 lane zero determinant', linear: [1, 1 + 2 ** -40, 1, 1], zoom: 1, dpr: 1 },
  {
    name: 'f32 lane opposite sign',
    linear: [1 + 2 ** -24 - 2 ** -41, 1, 1 + 2 ** -24 + 2 ** -41, 1 + 2 ** -24 - 2 ** -41],
    zoom: 1,
    dpr: 1,
  },
  { name: 'f32 lane overflow', linear: [2 ** 200, 0, 0, 1], zoom: 1, dpr: 1 },
];

describe('V3a exact buckets', () => {
  it('V3-A5: e, f, orientation and the f32 check equal the independent brute-force oracle on boundary matrices', () => {
    for (const { name, linear, zoom, dpr } of CASES) {
      expect(computePathBuckets(linear, zoom, dpr), name).toEqual(oracleBuckets(linear, zoom, dpr));
    }
  });

  it('V3-A5: a rounded Math.log2 of a rounded quotient picks the wrong bucket where the exact predicate does not', () => {
    // e: 3 * (fl(1/3) + 2^-54) = 1 + 2^-53 exactly, which Float64 rounds to 1.
    const zoomE = third + 2 ** -54;
    const naiveE = Math.floor(Math.log2(0.125 / (3 * zoomE)));
    const exactE = computePathBuckets([1, 0, 0, 1], zoomE, 3);
    expect(naiveE).toBe(-3);
    expect(exactE).toMatchObject({ e: -4 });
    expect(oracleBuckets([1, 0, 0, 1], zoomE, 3)).toMatchObject({ e: -4 });
    // f: 3 * fl(1/3) = 1 - 2^-54 exactly, which Float64 rounds to 1.
    const naiveF = Math.ceil(Math.log2(2 / (3 * third)));
    const exactF = computePathBuckets([1, 0, 0, 1], third, 3);
    expect(naiveF).toBe(1);
    expect(exactF).toMatchObject({ f: 2 });
    expect(oracleBuckets([1, 0, 0, 1], third, 3)).toMatchObject({ f: 2 });
  });

  it('V3-A5: an exactly singular map, including the zero map, is singular', () => {
    for (const linear of [
      [0, 0, 0, 0],
      [1, 1, 1, 1],
      [2, 4, 1, 2],
      [0, 1, 0, 3],
    ] as PathLinearMap[]) {
      expect(computePathBuckets(linear, 1, 1)).toEqual({ singular: true });
    }
  });

  it('V3-A5: buckets clamp to E_MAX + 1 and F_MIN - 1 / F_MAX + 1 at the search bounds', () => {
    const tiny = computePathBuckets([Number.MIN_VALUE, 0, 0, Number.MIN_VALUE], 1, 1);
    expect(tiny).toMatchObject({ e: E_MAX + 1, f: F_MAX + 1 });
    const huge = computePathBuckets([Number.MAX_VALUE, 0, 0, Number.MAX_VALUE], 2 ** 20, 2);
    expect(huge).toMatchObject({ e: E_MIN - 1 });
  });

  it('V3-A5: an exact nonzero determinant whose f32 lanes give zero or the opposite sign is flagged', () => {
    expect(computePathBuckets([1, 1 + 2 ** -40, 1, 1], 1, 1)).toMatchObject({
      singular: false,
      orientation: -1,
      f32OrientationMismatch: true,
    });
    const opposite: PathLinearMap = [
      1 + 2 ** -24 - 2 ** -41,
      1,
      1 + 2 ** -24 + 2 ** -41,
      1 + 2 ** -24 - 2 ** -41,
    ];
    const lanes = opposite.map((lane) => Math.fround(lane));
    expect(lanes[0]! * lanes[3]! - lanes[1]! * lanes[2]!).toBeLessThan(0);
    expect(computePathBuckets(opposite, 1, 1)).toMatchObject({
      orientation: 1,
      f32OrientationMismatch: true,
    });
    expect(computePathBuckets([-1, 0, 0, 1], 1, 1)).toMatchObject({
      orientation: -1,
      f32OrientationMismatch: false,
    });
  });
});
