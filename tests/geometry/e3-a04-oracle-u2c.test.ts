// D9 E3 unit E3-U2c: tests of the exact steps that the oracle speed-up added
// (docs/plans/d9-e3-b4-precision-contract.md section 14.8), from the review of PR #216. Each
// compares a faster step against an exact reference: the integer clip against the rational clip
// of E3-U2b, the scaled local frame against the unscaled region, the outward-rounded Bernstein
// halving against exact coefficients, and the interval prefilter of signAtRoot against the
// exact gcd and Sturm test.
import { describe, expect, it } from 'vitest';

import {
  type A04Scalar,
  a04BernsteinSelfTest,
  a04ClipSelfTest,
  a04Contains,
  a04ContainsUnscaled,
  a04ContainsWith,
  a04SignAtRootSelfTest,
} from '../../packages/geometry-reference/src/a04-region.js';
import { dAdd, dMul, dyadic, type Dyadic, transformMatrix } from './e3-a04/corpus.js';
import { makeCase, stroke } from './e3-a04/oracle-cases.js';

describe('E3-U2c: integer homogeneous clipping (zClip)', () => {
  it('agrees with the rational clip on 4,000 chains, the review repro first', () => {
    expect(a04ClipSelfTest(0x5eed216, 4000)).toEqual([]);
  });
});

describe('E3-U2c: Bernstein coefficients of the sweep equation', () => {
  it('powerToBernstein and the outward-rounded halvings enclose the exact coefficients', () => {
    expect(a04BernsteinSelfTest(0xb3e2, 400)).toEqual([]);
  });
});

describe('E3-U2c: the interval prefilter of signAtRoot', () => {
  it('gives the sign of the exact test near zeros of h', () => {
    expect(a04SignAtRootSelfTest(0x51a7, 600)).toEqual([]);
  });
});

describe('E3-U2c: the scaled local frame σ·y', () => {
  // Local coordinates: a polyline with a corner at (10, 0), then a cubic. Width 2 (r = 1).
  const verbs = 'MLLC';
  const points = [0, 0, 10, 0, 10, 10, 10, 14, 4, 16, 0, 12];
  const scalar = (d: Dyadic): A04Scalar =>
    d.e >= 0 ? { num: d.n << BigInt(d.e), den: 1n } : { num: d.n, den: 1n << BigInt(-d.e) };
  type M = readonly [number, number, number, number];
  // T3, T6 and T7 have det L > 0; T5 and the reflected T3 (det L < 0) cover σ < 0.
  const transforms: [string, M][] = [
    ['T3', transformMatrix('T3')],
    ['T6', transformMatrix('T6')],
    ['T7', transformMatrix('T7')],
    ['T5', transformMatrix('T5')],
    ['T3 reflected', [-2.5, 0, 0, 0.375]],
  ];
  // The physical point Φ(y) = L·y exactly (zoom 1, dpr 1, no translation).
  const phys = (l: M, x: number, y: number): [A04Scalar, A04Scalar] => {
    const [a, b, c, d] = l.map(dyadic) as [Dyadic, Dyadic, Dyadic, Dyadic];
    const dx = dyadic(x);
    const dy = dyadic(y);
    return [scalar(dAdd(dMul(a, dx), dMul(b, dy))), scalar(dAdd(dMul(c, dx), dMul(d, dy)))];
  };
  const tiny = 2 ** -20;
  // Points on the boundary (inside, the region is closed) and just outside, per cap and join.
  const paints = [
    {
      cap: 'butt',
      join: 'miter',
      on: [
        [5, 1],
        [5, -1],
        [0, 0.5],
        [11, -1],
      ],
      off: [
        [-tiny, 0],
        [11 + tiny, -1],
      ],
    },
    {
      cap: 'square',
      join: 'bevel',
      on: [
        [-1, 0.5],
        [-1, -1],
        [10.5, -0.5],
      ],
      off: [
        [-1 - tiny, 0],
        [10.5 + tiny, -0.5 - tiny],
      ],
    },
    {
      cap: 'round',
      join: 'round',
      // Dyadic points on a unit circle lie on its axes only, so the arcs are probed at 45/64
      // (inside, 2·45² < 64²) and 46/64 (outside) along the diagonals.
      on: [
        [-1, 0],
        [-45 / 64, -45 / 64],
        [10 + 45 / 64, -45 / 64],
      ],
      off: [
        [-1 - tiny, 0],
        [-46 / 64, 46 / 64],
        [10 + 46 / 64, -46 / 64],
      ],
    },
  ] as const;
  for (const [name, l] of transforms)
    for (const paint of paints)
      it(`${name}, ${paint.cap} cap and ${paint.join} join: scaled membership equals unscaled`, () => {
        const kase = makeCase({ verbs, points, paint: stroke(2, paint.cap, paint.join), l });
        let state = 0x9e3779b9;
        const next = () => {
          state ^= state << 13;
          state >>>= 0;
          state ^= state >>> 17;
          state ^= state << 5;
          state >>>= 0;
          return state / 2 ** 32;
        };
        const samples: [number, number, boolean | null][] = [
          ...paint.on.map(([x, y]) => [x, y, true] as [number, number, boolean]),
          ...paint.off.map(([x, y]) => [x, y, false] as [number, number, boolean]),
        ];
        // Random 1/64-grid points around the path, the cubic and its end cap included.
        for (let i = 0; i < 16; i += 1)
          samples.push([
            Math.round((next() * 15 - 2) * 64) / 64,
            Math.round((next() * 19 - 2) * 64) / 64,
            null,
          ]);
        for (const [x, y, want] of samples) {
          const p = phys(l, x, y);
          const reference = a04ContainsUnscaled(kase, p);
          if (want !== null) expect([x, y, reference]).toEqual([x, y, want]);
          expect([x, y, a04Contains(kase, p)]).toEqual([x, y, reference]);
          expect([x, y, a04ContainsWith(kase, p, {})]).toEqual([x, y, reference]);
        }
      });
});
