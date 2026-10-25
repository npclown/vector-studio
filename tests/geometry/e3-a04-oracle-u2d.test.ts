// D9 E3 unit E3-U2d: tests of the oracle steps that E3-U2d added
// (docs/plans/d9-e3-b4-precision-contract.md section 17). The point test started from a cell's
// sub-arc frontiers is compared with the point test from the root and with exact membership; the
// witness pairs and the OUT-by-halves test of anisotropic cells are checked against exact
// membership, on the case whose cell they were made for (C9/k10/T7/z64-d3) and on others.
import { describe, expect, it } from 'vitest';

import {
  type A04Case,
  a04CoverSelfTest,
} from '../../packages/geometry-reference/src/a04-region.js';
import { iterateA04Corpus } from './e3-a04/corpus.js';

function corpusCase(id: string): A04Case {
  for (const kase of iterateA04Corpus()) if (String(kase.id) === id) return kase;
  throw new Error(`no corpus case ${id}`);
}

describe('E3-U2d: sub-arc frontiers (warm start)', () => {
  for (const id of [
    'C9/g0187/T4/z0.01-d2/center/k0',
    'C9/k05/T0/z64-d1/center/k0',
    'C5/l05/T7/z64-d1/center/k0',
    'C5/l02/T6/z64-d1/center/k0',
  ])
    it(`agrees with the root and with exact membership on ${id}`, () => {
      const r = a04CoverSelfTest(corpusCase(id), 0xd2d, { cells: 12, samples: 16 });
      expect(r.findings).toEqual([]);
      expect(r.cells).toBeGreaterThan(0);
      // The frontiers only skip sub-arcs, so the point test decides at least as often.
      expect(r.decidedWarm).toBeGreaterThanOrEqual(r.decidedCold);
    });
});

describe('E3-U2d: anisotropic cells beside a butt corner (C9/k10/T7/z64-d3)', () => {
  const kase = corpusCase('C9/k10/T7/z64-d3/center/k0');
  const s = 2 ** -11;
  it('finds a witness in a cell across the thin wedge', () => {
    const boxes = [1333.8125, 1333.8125 + 16 * s, 1333.8125 + 64 * s].map((x0) => ({
      x0,
      y0: 540.0048828125,
      x1: x0 + s,
      y1: 540.0048828125 + s,
    }));
    const r = a04CoverSelfTest(kase, 0x10, { boxes, samples: 64 });
    expect(r.findings).toEqual([]);
    expect(r.witnessed).toBe(3);
  });
  it('certifies OUT by halves a cell beyond the corner that the cell test leaves open', () => {
    const t = 2 ** -16;
    // The level-16 cells at (1333.8125 + (3441 + k)·t, 540 + 324·t), just past the corner.
    const boxes = [0, 4, 16, 64].map((k) => ({
      x0: 1333.8125 + (3441 + k) * t,
      y0: 540 + 324 * t,
      x1: 1333.8125 + (3442 + k) * t,
      y1: 540 + 325 * t,
    }));
    const r = a04CoverSelfTest(kase, 0x11, { boxes, samples: 64 });
    expect(r.findings).toEqual([]);
    expect(r.halvesOut).toBeGreaterThan(0);
  });
});
