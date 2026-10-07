import { rational, type Rational } from '../rounded-fill/exact.js';

/**
 * P3.1o O01 coverage oracle: small exact helpers shared by positions, oracle and metrics
 * (docs/plans/p3-o01-coverage-experiment-contract.md).
 */

export type ExactJson = Readonly<{ n: string; d: string; approx: string }>;

/** floor(a / b) for any sign of a and b > 0. */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('floorDiv:nonpositive-divisor');
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/** ceil(a / b) for any sign of a and b > 0. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}

function bitLength(value: bigint): number {
  const magnitude = value < 0n ? -value : value;
  return magnitude === 0n ? 0 : magnitude.toString(2).length;
}

/** Deterministic binary64 approximation of a rational of any size. */
export function approxNumber(value: Rational): number {
  if (value.n === 0n) return 0;
  const shiftN = Math.max(0, bitLength(value.n) - 62);
  const shiftD = Math.max(0, bitLength(value.d) - 62);
  const n = Number(value.n >> BigInt(shiftN));
  const d = Number(value.d >> BigInt(shiftD));
  return (n / d) * 2 ** (shiftN - shiftD);
}

export function exactJson(value: Rational): ExactJson {
  return {
    n: value.n.toString(),
    d: value.d.toString(),
    approx: approxNumber(value).toExponential(5),
  };
}

/** Unscaled exact value of a finite binary64 number (exact.ts helpers are scaled by 2^1074). */
export function q64(value: number): Rational {
  if (!Number.isFinite(value)) throw new Error('q64:nonfinite');
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0x000fffffffffffffn;
  const magnitude =
    exponent === 0 ? fraction : (0x0010000000000000n | fraction) << BigInt(exponent - 1);
  return rational(bits >> 63n === 1n ? -magnitude : magnitude, 1n << 1074n);
}

/** Unscaled exact value of a finite binary32 word. */
export function q32Bits(word: number): Rational {
  const exponent = (word >>> 23) & 0xff;
  if (exponent === 0xff) throw new Error(`q32:nonfinite:${word}`);
  const fraction = BigInt(word & 0x7fffff);
  const magnitude = exponent === 0 ? fraction : (fraction | 0x800000n) << BigInt(exponent - 1);
  return rational(word >>> 31 === 1 ? -magnitude : magnitude, 1n << 149n);
}

const f32 = new DataView(new ArrayBuffer(4));

export function f32Bits(value: number): number {
  f32.setFloat32(0, value, false);
  return f32.getUint32(0, false);
}

export function f32FromBits(bits: number): number {
  f32.setUint32(0, bits >>> 0, false);
  return f32.getFloat32(0, false);
}

/** Exact value of an IEEE binary16 word (finite only). */
export function q16Bits(word: number): Rational {
  const exponent = (word >>> 10) & 0x1f;
  if (exponent === 0x1f) throw new Error(`q16:nonfinite:${word}`);
  const fraction = BigInt(word & 0x3ff);
  const magnitude = exponent === 0 ? fraction : (fraction | 0x400n) << BigInt(exponent - 1);
  return rational((word & 0x8000) !== 0 ? -magnitude : magnitude, 1n << 24n);
}

/** log2 of a power-of-two denominator; throws for a non-dyadic rational. */
export function dyadicExponent(value: Rational): number {
  const d = value.d;
  if ((d & (d - 1n)) !== 0n) throw new Error('dyadic:non-power-of-two');
  return d.toString(2).length - 1;
}

/**
 * Exact sum of many rationals without a gcd per step: numerators are grouped by denominator and
 * combined once at the end.
 */
export class ExactSum {
  private readonly groups = new Map<bigint, bigint>();

  add(value: Rational): void {
    if (value.n === 0n) return;
    this.groups.set(value.d, (this.groups.get(value.d) ?? 0n) + value.n);
  }

  addParts(n: bigint, d: bigint): void {
    if (n === 0n) return;
    this.groups.set(d, (this.groups.get(d) ?? 0n) + n);
  }

  value(): Rational {
    const denominators = [...this.groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let n = 0n;
    let d = 1n;
    for (const key of denominators) {
      const part = rational(this.groups.get(key)!, key);
      n = n * part.d + part.n * d;
      d *= part.d;
      const reduced = rational(n, d);
      n = reduced.n;
      d = reduced.d;
    }
    return rational(n, d);
  }
}
