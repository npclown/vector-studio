import { describe, expect, it } from 'vitest';
import {
  add,
  compare,
  div,
  bitsOf,
  exactInteger,
  mul,
  rational,
  sub,
  toNumber,
  type Rational,
} from '../geometry/rounded-fill/exact.js';
import {
  jointFillComposite,
  type JointCompositeSeededDefect,
  type PremultipliedColor,
} from '../../packages/renderer-core/src/path-joint-overlay.js';

// P3 B2 ST-U7 addendum, unit ST-U7b, acceptance row ST-A13: the joint fill draw's composite
// X = o·F'·(1 − S'.a)/(1 − o·S'.a) (section 3.2), followed by the unchanged stroke draw o·S',
// equals the P1 D2 target P + D·(1 − P.a) with P = o·(S' + F'·(1 − S'.a)): exactly in BigInt
// rationals for the formula, and within 2^-40 for the Float64 reference model in
// path-joint-overlay.ts. The rational model below is independent of that module. Seeded defects
// ST7-D1, ST7-D2 and ST7-D10 (the TypeScript model) must fail. Functional evidence only.

type Q4 = readonly [Rational, Rational, Rational, Rational];
type Color = readonly [number, number, number, number];

const ZERO = rational(0n);
const ONE = rational(1n);
/** The exact value of a Float64: exactInteger is the value in units of 2^-1074. */
const exactValues = new Map<number, Rational>();
const q = (value: number): Rational => {
  let exact = exactValues.get(value);
  if (exact === undefined) {
    exact = rational(exactInteger(bitsOf(value)), 1n << 1074n);
    exactValues.set(value, exact);
  }
  return exact;
};
const scale = (c: Q4, k: Rational): Q4 => [mul(c[0], k), mul(c[1], k), mul(c[2], k), mul(c[3], k)];
const plus = (a: Q4, b: Q4): Q4 => [
  add(a[0], b[0]),
  add(a[1], b[1]),
  add(a[2], b[2]),
  add(a[3], b[3]),
];
/** Premultiplied source-over: src + dst·(1 − src.a). */
const over = (src: Q4, dst: Q4): Q4 => plus(src, scale(dst, sub(ONE, src[3])));

/** Coverage-adjusted premultiplied paint c·(rgb·a, a) from a straight color. */
function paint(color: Color, coverage: Rational): Q4 {
  const a = q(color[3]);
  return [
    mul(coverage, mul(q(color[0]), a)),
    mul(coverage, mul(q(color[1]), a)),
    mul(coverage, mul(q(color[2]), a)),
    mul(coverage, a),
  ];
}

/** The P1 D2 target for one pixel: P = o·(S' + F'·(1 − S'.a)), then P over D. */
function target(F: Q4, S: Q4, o: Rational, D: Q4): Q4 {
  const L = plus(S, scale(F, sub(ONE, S[3])));
  return over(scale(L, o), D);
}

/** The two draws exactly: X = o·F'·(1 − S'.a)/(1 − o·S'.a) over D, then o·S' over that. */
function twoDraws(
  F: Q4,
  S: Q4,
  o: Rational,
  D: Q4,
): Readonly<{ X: Q4; result: Q4; den: Rational }> {
  const den = sub(ONE, mul(o, S[3]));
  const X = scale(F, div(mul(o, sub(ONE, S[3])), den));
  return { X, result: over(scale(S, o), over(X, D)), den };
}

const GRID = Array.from({ length: 9 }, (_, i) => i / 8);
const OPACITIES = Array.from({ length: 7 }, (_, i) => (i + 1) / 8);
const ALPHAS = [0, 0.5, 1];
/** Fill and stroke colour channels in pairs: the approved red and blue, and a mixed pair. */
const RGB_PAIRS = [
  [
    [1, 0, 0],
    [0, 0, 1],
  ],
  [
    [0.25, 0.5, 0.75],
    [0.75, 0.125, 0.5],
  ],
] as const;
/** Premultiplied destinations: transparent, opaque white, two translucent. */
const DESTINATIONS: readonly Color[] = [
  [0, 0, 0, 0],
  [1, 1, 1, 1],
  [0.25, 0.125, 0.375, 0.5],
  [0.1, 0.3, 0.2, 0.6],
];

type Case = Readonly<{
  fill: Color;
  stroke: Color;
  cF: number;
  cS: number;
  o: number;
  D: Color;
}>;

function* cases(): Generator<Case> {
  for (const [[fr, fg, fb], [sr, sg, sb]] of RGB_PAIRS)
    for (const fa of ALPHAS)
      for (const sa of ALPHAS)
        for (const cF of GRID)
          for (const cS of GRID)
            for (const o of OPACITIES)
              for (const D of DESTINATIONS)
                yield { fill: [fr, fg, fb, fa], stroke: [sr, sg, sb, sa], cF, cS, o, D };
}

/** The Float64 composite of the module's model, then its maximum deviation from the target. */
/** The exact targets as Float64 values, computed once per case. */
const targets = new Map<string, number[]>();

function float64Deviation(c: Case, defect?: JointCompositeSeededDefect): number {
  const F: PremultipliedColor = [
    c.cF * c.fill[0] * c.fill[3],
    c.cF * c.fill[1] * c.fill[3],
    c.cF * c.fill[2] * c.fill[3],
    c.cF * c.fill[3],
  ];
  const S = [
    c.cS * c.stroke[0] * c.stroke[3],
    c.cS * c.stroke[1] * c.stroke[3],
    c.cS * c.stroke[2] * c.stroke[3],
    c.cS * c.stroke[3],
  ];
  const X = jointFillComposite(F, S[3]!, c.o, defect);
  const afterFill = X.map((value, i) => value + c.D[i]! * (1 - X[3]));
  const result = S.map((value, i) => c.o * value + afterFill[i]! * (1 - c.o * S[3]!));
  const key = JSON.stringify(c);
  let exact = targets.get(key);
  if (exact === undefined) {
    exact = target(
      paint(c.fill, q(c.cF)),
      paint(c.stroke, q(c.cS)),
      q(c.o),
      c.D.map(q) as unknown as Q4,
    ).map(toNumber);
    targets.set(key, exact);
  }
  return Math.max(...result.map((value, i) => Math.abs(value - exact[i]!)));
}

describe('ST-A13: the joint composite formula (addendum section 3.2)', () => {
  it(
    'fill-then-stroke source-over with X equals P + D·(1 − P.a) exactly in rationals',
    { timeout: 120_000 },
    () => {
      let count = 0;
      for (const c of cases()) {
        const F = paint(c.fill, q(c.cF));
        const S = paint(c.stroke, q(c.cS));
        const o = q(c.o);
        const D = c.D.map(q) as unknown as Q4;
        const { X, result, den } = twoDraws(F, S, o, D);
        const expected = target(F, S, o, D);
        for (let i = 0; i < 4; i += 1) expect(compare(result[i]!, expected[i]!)).toBe(0);
        // The denominator is at least 1 − o > 0, and X is a valid premultiplied color with
        // 0 ≤ X ≤ o·F' and X.rgb ≤ X.a.
        expect(compare(den, sub(ONE, o))).toBeGreaterThanOrEqual(0);
        const bound = scale(F, o);
        for (let i = 0; i < 4; i += 1) {
          expect(compare(X[i]!, ZERO)).toBeGreaterThanOrEqual(0);
          expect(compare(X[i]!, bound[i]!)).toBeLessThanOrEqual(0);
          if (i < 3) expect(compare(X[i]!, X[3])).toBeLessThanOrEqual(0);
        }
        count += 1;
      }
      expect(count).toBe(2 * 3 * 3 * 9 * 9 * 7 * 4);
    },
  );

  it('the Float64 reference model meets the target within 2^-40 on the whole grid', () => {
    let worst = 0;
    for (const c of cases()) worst = Math.max(worst, float64Deviation(c));
    expect(worst).toBeLessThanOrEqual(2 ** -40);
  });

  it('the approved example and ST-A11 at 0.25: opaque red under opaque blue, transparent black', () => {
    const red: Color = [1, 0, 0, 1];
    const blue: Color = [0, 0, 1, 1];
    const black: Q4 = [ZERO, ZERO, ZERO, ZERO];
    for (const [o, expected, doubled] of [
      [0.5, [0, 0, 0.5, 0.5], [0.25, 0, 0.5, 0.75]],
      [0.25, [0, 0, 0.25, 0.25], [0.1875, 0, 0.25, 0.4375]],
    ] as const) {
      const F = paint(red, ONE);
      const S = paint(blue, ONE);
      const { X, result } = twoDraws(F, S, q(o), black);
      expect(X.map(toNumber)).toEqual([0, 0, 0, 0]);
      expect(result.map(toNumber)).toEqual(expected);
      // Opacity applied twice (ST-U6's two plain draws) is the separated double-opacity value.
      const twice = over(scale(S, q(o)), over(scale(F, q(o)), black));
      expect(twice.map(toNumber)).toEqual(doubled);
      const model = jointFillComposite([1, 0, 0, 1], 1, o);
      expect(Array.from(model)).toEqual([0, 0, 0, 0]);
    }
  });

  it('ST7-F10: translucent fill and stroke (f.a = s.a = 0.5) at o = 0.5 and 0.25', () => {
    for (const o of [0.5, 0.25])
      for (const cF of GRID)
        for (const cS of GRID)
          for (const D of DESTINATIONS) {
            const c: Case = { fill: [1, 0, 0, 0.5], stroke: [0, 0, 1, 0.5], cF, cS, o, D };
            expect(float64Deviation(c)).toBeLessThanOrEqual(2 ** -40);
          }
  });

  for (const defect of ['ST7-D1', 'ST7-D2', 'ST7-D10'] as const) {
    it(`${defect} fails the 2^-40 check`, () => {
      let failed = 0;
      for (const c of cases()) if (float64Deviation(c, defect) > 2 ** -40) failed += 1;
      expect(failed).toBeGreaterThan(0);
    });
  }

  it('ST7-D1 is the double-opacity value of the approved example; ST7-D10 shows at o = 0.25', () => {
    const d1 = jointFillComposite([1, 0, 0, 1], 1, 0.5, 'ST7-D1');
    expect(Array.from(d1)).toEqual([0.5, 0, 0, 0.5]);
    // At o = 0.25 with a half-alpha stroke, swapping o and 1 − o changes X.
    const right = jointFillComposite([1, 0, 0, 1], 0.5, 0.25);
    const swapped = jointFillComposite([1, 0, 0, 1], 0.5, 0.25, 'ST7-D10');
    expect(Math.abs(swapped[3] - right[3])).toBeGreaterThan(0.1);
  });
});
