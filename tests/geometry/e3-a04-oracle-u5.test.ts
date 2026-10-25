// D9 E3 unit E3-U5: the oracle fix found by the first corpus measurement sample
// (docs/plans/d9-e3-b4-precision-contract.md section 19). The fill arrangement cuts its curves only
// at crossings with curves that meet the index region. A kept edge that extends beyond the region
// was therefore not cut where a dropped edge crosses it outside, and one portion was classified at
// its midpoint for the whole edge. On two overlapping squares under T3 and T4 at z = 64, the inner
// edge of one square was taken as part of ∂R inside the window, and B_R scored it at 384 and
// 512 px against a mesh that equals R exactly.
import { describe, expect, it } from 'vitest';

import { type A04Case, a04Measure } from '../../packages/geometry-reference/src/a04-region.js';
import { iterateA04Corpus } from './e3-a04/corpus.js';

function corpusCase(id: string): A04Case {
  for (const kase of iterateA04Corpus()) if (String(kase.id) === id) return kase;
  throw new Error(`no corpus case ${id}`);
}

/** The squares [0, 16]² and [8, 24]² mapped by T3 at z = 64, d = 2 (physical px, exact). */
const X = [-3200, -640, 1920, 4480];
const Y = [-216, 168, 552, 936];
/** The union as eight triangles, the kernel's own triangulation of the case. */
const UNION: [number, number][][] = [
  [
    [X[0]!, Y[0]!],
    [X[1]!, Y[0]!],
    [X[0]!, Y[2]!],
  ],
  [
    [X[0]!, Y[2]!],
    [X[1]!, Y[0]!],
    [X[1]!, Y[2]!],
  ],
  [
    [X[1]!, Y[0]!],
    [X[2]!, Y[0]!],
    [X[2]!, Y[1]!],
  ],
  [
    [X[1]!, Y[0]!],
    [X[2]!, Y[1]!],
    [X[1]!, Y[2]!],
  ],
  [
    [X[1]!, Y[2]!],
    [X[2]!, Y[1]!],
    [X[1]!, Y[3]!],
  ],
  [
    [X[1]!, Y[3]!],
    [X[2]!, Y[1]!],
    [X[2]!, Y[3]!],
  ],
  [
    [X[2]!, Y[1]!],
    [X[3]!, Y[1]!],
    [X[2]!, Y[3]!],
  ],
  [
    [X[2]!, Y[3]!],
    [X[3]!, Y[1]!],
    [X[3]!, Y[3]!],
  ],
];

function mesh(triangles: readonly (readonly [number, number])[][]) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const tri of triangles)
    for (const [x, y] of tri) {
      indices.push(positions.length / 2);
      positions.push(x, y);
    }
  return { positions, indices };
}

describe('E3-U5: fill portions cut by crossings outside the index region', () => {
  it('finds no ∂R in the window of two overlapping squares whose mesh equals R', () => {
    // The window lies inside both squares' union: ∂R and ∂M are both off Ω (window-empty).
    for (const id of ['C1/s15-I/T3/z64-d2/center/k0']) {
      const m = a04Measure(corpusCase(id), mesh(UNION), { resolution: 2 ** -6 });
      expect(m.status).toBe('window-empty');
      expect(m.windowPoint).toEqual({ r: true, m: true });
    }
  });

  it('still fails a mesh that leaves out the part of the upper square above the lower one', () => {
    // Without the two triangles over [X1, X2] × [Y2, Y3], the window's lower part is uncovered.
    const partial = UNION.filter((_, i) => i !== 4 && i !== 5);
    const m = a04Measure(corpusCase('C1/s15-I/T3/z64-d2/center/k0'), mesh(partial), {
      resolution: 2 ** -6,
    });
    expect(m.status).toBe('fail');
  });
});
