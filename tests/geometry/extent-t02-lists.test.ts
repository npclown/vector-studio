import { describe, expect, it } from 'vitest';

import { compare, rational, type Rational } from './rounded-fill/exact.js';
import type { Q2 } from './extent-t01/clip.js';
import type { Linear } from './extent-t02/clearance.js';
import {
  buildLists,
  featuresOf,
  featureTriangleLinf,
  pointSegmentLinf,
} from './extent-t02/lists.js';

const r = (n: number, d = 16): Rational => rational(BigInt(n), BigInt(d));
const pt = (x: number, y: number): Q2 => [r(x), r(y)];
const num = (value: Rational) => Number(value.n) / Number(value.d);

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

describe('P3.1p T02 lists', () => {
  it('pointSegmentLinf equals a dense numeric minimum within its resolution and never exceeds it', () => {
    const next = seeded(7);
    for (let trial = 0; trial < 300; trial += 1) {
      const coords = Array.from({ length: 6 }, () => (next() % 129) - 64);
      const p = pt(coords[0]!, coords[1]!);
      const a = pt(coords[2]!, coords[3]!);
      const b = pt(coords[4]!, coords[5]!);
      const exact = num(pointSegmentLinf(p, a, b));
      let best = Infinity;
      for (let k = 0; k <= 4096; k += 1) {
        const t = k / 4096;
        const x = num(a[0]) + t * (num(b[0]) - num(a[0])) - num(p[0]);
        const y = num(a[1]) + t * (num(b[1]) - num(a[1])) - num(p[1]);
        best = Math.min(best, Math.max(Math.abs(x), Math.abs(y)));
      }
      expect(exact).toBeLessThanOrEqual(best + 1e-12);
      expect(best - exact).toBeLessThan(0.01);
    }
  });

  it('featureTriangleLinf is zero on contact and matches sampling otherwise', () => {
    const triangle: [Q2, Q2, Q2] = [pt(0, 0), pt(64, 0), pt(0, 64)];
    expect(featureTriangleLinf([pt(8, 8)], triangle).n).toBe(0n);
    expect(featureTriangleLinf([pt(-8, 8), pt(8, 8)], triangle).n).toBe(0n);
    expect(compare(featureTriangleLinf([pt(-16, 8)], triangle), r(16))).toBe(0);
    expect(compare(featureTriangleLinf([pt(80, 80), pt(96, 96)], triangle), r(48))).toBe(0);
  });

  it('bucketed lists equal brute-force lists, and S5 passes when λ bounds the physical reach', () => {
    const next = seeded(11);
    const points: Q2[] = Array.from({ length: 40 }, () =>
      pt((next() % 2049) - 1024, (next() % 2049) - 1024),
    );
    const triangles: [number, number, number][] = [];
    for (let k = 0; k < 30; k += 1) triangles.push([next() % 40, next() % 40, next() % 40]);
    const valid = triangles.filter(
      ([a, b, c]) =>
        a !== b &&
        b !== c &&
        a !== c &&
        compare(
          rational(0n),
          rational(
            (points[b]![0].n - points[a]![0].n) * (points[c]![1].n - points[a]![1].n) -
              (points[b]![1].n - points[a]![1].n) * (points[c]![0].n - points[a]![0].n),
          ),
        ) !== 0,
    );
    const edges: [number, number][] = [];
    for (let k = 0; k < 20; k += 1) edges.push([k, k + 20]);
    const features = featuresOf(edges, [0, 5, 9, 33]);
    const lambda = r(80);
    const identity: Linear = [rational(1n), rational(0n), rational(0n), rational(1n)];
    // s_L chosen so that λ in local units equals 13/8 px exactly: s = (13/8) / λ.
    const sL = rational(13n * 16n, 8n * 80n);
    const result = buildLists(points, valid, features, lambda, identity, sL, 4);
    valid.forEach((ids, index) => {
      const triangle = ids.map((id) => points[id]!) as unknown as [Q2, Q2, Q2];
      const expected = features
        .map((feature, featureIndex) => ({ feature, featureIndex }))
        .filter(({ feature }) => {
          const pts =
            feature.kind === 'edge'
              ? [points[feature.a]!, points[feature.b]!]
              : [points[feature.v]!];
          return compare(featureTriangleLinf(pts, triangle), lambda) <= 0;
        })
        .map(({ featureIndex }) => featureIndex);
      expect(result.lists[index]).toEqual(expected);
    });
    expect(result.failing).toBeNull();
    // A too-small λ (local) at the same scale makes S5 fail.
    const tight = buildLists(points, valid, features, r(1), identity, sL, 4);
    expect(tight.lists.some((list, index) => list.length !== result.lists[index]!.length)).toBe(
      true,
    );
    expect(tight.failing).not.toBeNull();
  });
});
