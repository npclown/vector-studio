export type Rational = Readonly<{ n: bigint; d: bigint }>;

const FRACTION_MASK = 0x000fffffffffffffn;
const SIGN = 0x8000000000000000n;
const view = new DataView(new ArrayBuffer(8));

export const ZERO = rational(0n);
export const ONE = rational(1n);

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function rational(n: bigint, d = 1n): Rational {
  if (d === 0n) throw new Error('zero rational denominator');
  if (n === 0n) return { n: 0n, d: 1n };
  if (d < 0n) [n, d] = [-n, -d];
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mul(a: Rational, b: Rational): Rational {
  return rational(a.n * b.n, a.d * b.d);
}

export function div(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d, a.d * b.n);
}

export function half(a: Rational): Rational {
  return rational(a.n, 2n * a.d);
}

export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const difference = a.n * b.d - b.n * a.d;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function sign(a: Rational): -1 | 0 | 1 {
  return a.n < 0n ? -1 : a.n > 0n ? 1 : 0;
}

export function absolute(a: Rational): Rational {
  return a.n < 0n ? rational(-a.n, a.d) : a;
}

export function bitsOf(value: number): bigint {
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

export function fromBits(bits: bigint): number {
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

export function exactInteger(bits: bigint): bigint {
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & FRACTION_MASK;
  if (exponent === 0x7ff) throw new Error(`nonfinite bits ${bits.toString(16)}`);
  const magnitude =
    exponent === 0 ? fraction : (0x0010000000000000n | fraction) << BigInt(exponent - 1);
  return bits & SIGN && magnitude !== 0n ? -magnitude : magnitude;
}

export function exactNumber(value: number): Rational {
  return rational(exactInteger(bitsOf(value)));
}

export function exactBits(bits: bigint): Rational {
  return rational(exactInteger(bits));
}

export function square(a: Rational): Rational {
  return mul(a, a);
}

export function toNumber(a: Rational): number {
  return Number(a.n) / Number(a.d);
}

export function format(a: Rational): string {
  return a.d === 1n ? a.n.toString() : `${a.n}/${a.d}`;
}
