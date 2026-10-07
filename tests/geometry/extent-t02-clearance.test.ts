import { describe, expect, it } from 'vitest';

import { q } from './position-certificate/certificate.js';
import { loadFixtureRows } from './position-certificate/corpus.js';
import { compare, mul, rational, type Rational } from './rounded-fill/exact.js';
import type { Q2 } from './extent-t01/clip.js';
import { c2Q } from './extent-t01/core.js';
import { c2Merged, type Linear } from './extent-t02/clearance.js';

/** Pruned C2 equals brute-force c2Q (extent-t01 core.ts) in failing terms and unpruned slacks. */

const DELTAS = [
  rational(1n, 1n << 20n),
  rational(1n, 4096n),
  rational(1n, 256n),
  rational(1n, 64n),
  rational(1n, 16n),
  rational(1n, 4n),
  rational(4n),
];

function exponentFor(points: readonly Q2[]): number {
  let span = rational(1n);
  for (const point of points)
    for (const value of point) {
      const magnitude = value.n < 0n ? rational(-value.n, value.d) : value;
      if (compare(magnitude, span) > 0) span = magnitude;
    }
  let k = 0;
  while (compare(rational(1n << BigInt(k)), span) < 0) k += 1;
  return k + 1;
}

describe('P3.1p T02 pruned merged-mesh C2', () => {
  it('matches brute-force c2Q on the C2 fixture corpus at several δ²', () => {
    let compared = 0;
    let failures = 0;
    for (const row of loadFixtureRows()) {
      const input = row.input;
      const points = input.mesh.vertices.map((v) => [q(v[0]), q(v[1])] as Q2);
      const indices = input.mesh.indices;
      if (indices.length > 3 * 64) continue;
      const linear = input.affine.slice(0, 4).map(q) as unknown as Linear;
      const s = mul(q(input.zoom), q(input.dpr));
      for (const base of DELTAS) {
        const delta2: Rational = mul(base, base);
        let brute;
        try {
          brute = c2Q(
            points,
            indices,
            { affine: input.affine, zoom: input.zoom, dpr: input.dpr },
            delta2,
          );
        } catch (error) {
          expect(() => c2Merged(points, indices, linear, s, delta2, exponentFor(points))).toThrow(
            (error as Error).message,
          );
          continue;
        }
        const pruned = c2Merged(points, indices, linear, s, delta2, exponentFor(points));
        expect(pruned.term).toBe(brute.term);
        expect(pruned.failing).toEqual(brute.failing);
        for (const term of ['triangle', 'wedge'] as const) {
          if (brute.slacks[term] === null) expect(pruned.slacks[term]).toBeNull();
          else expect(compare(pruned.slacks[term]!, brute.slacks[term])).toBe(0);
        }
        compared += 1;
        if (brute.term !== null) failures += 1;
      }
    }
    expect(compared).toBeGreaterThan(500);
    expect(failures).toBeGreaterThan(50);
  }, 60_000);
});
