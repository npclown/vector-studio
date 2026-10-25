// D9 E3 unit E3-U2e: tests of the oracle fixes made after the full freeze run of 2026-10-24
// (docs/plans/d9-e3-b4-precision-contract.md section 18). Each cover test takes a cell that the
// run left unresolved and checks the new step on it against exact membership.
import { describe, expect, it } from 'vitest';

import {
  type A04Case,
  a04CoverSelfTest,
  a04PseudoDivisionSelfTest,
} from '../../packages/geometry-reference/src/a04-region.js';
import { iterateA04Corpus } from './e3-a04/corpus.js';

function corpusCase(id: string): A04Case {
  for (const kase of iterateA04Corpus()) if (String(kase.id) === id) return kase;
  throw new Error(`no corpus case ${id}`);
}

const s = 2 ** -16;
// Level-16 cells, by their offsets from the freeze cell that holds them.
const cell = (x0: number, y0: number) => [{ x0, y0, x1: x0 + s, y1: y0 + s }];

describe('E3-U2e: pseudo-division', () => {
  it('keeps the remainder dense when it drops by more than one degree', () => {
    expect(a04PseudoDivisionSelfTest(0x2e1, 400)).toEqual([]);
  });
});

describe('E3-U2e: pair splits', () => {
  for (const [id, x0, y0] of [
    // Two line bodies of the path's legs, their edges nearly antiparallel across the cell.
    ['C5/g0090/T0/z0.01-d3/center/k0', 962.875 + 1827 * s, 544.5 + 2932 * s],
    // Two line bodies whose edges cross at about 27 degrees.
    ['C5/g0141/T6/z64-d3/center/k0', 743.9375 + 15 * s, 340.6875 + 3458 * s],
  ] as const)
    it(`decides an inside cell between two pieces on ${id}`, () => {
      const r = a04CoverSelfTest(corpusCase(id), 0x2e2, { boxes: cell(x0, y0), samples: 32 });
      expect(r.findings).toEqual([]);
      expect(r.decided).toBe(1);
    });
});

describe('E3-U2e: anisotropic cells (T7)', () => {
  for (const [id, x0, y0] of [
    // A thin outside gap across the cell, missed by the nine samples.
    ['C5/l78/T7/z64-d1/center/k0', 105.5625 + 2785 * s, 180 + 3805 * s],
    // An outside wedge on the cell's short edge, beside the crossing of two body edges.
    ['C5/l18/T7/z64-d2/center/k0', 842.9375 + 782 * s, 360.03125],
  ] as const)
    it(`finds an outside sample on ${id}`, () => {
      const r = a04CoverSelfTest(corpusCase(id), 0x2e3, { boxes: cell(x0, y0), samples: 32 });
      expect(r.findings).toEqual([]);
      expect(r.witnessed).toBe(1);
    });
  // The four quarters of the freeze cell that the run left unresolved.
  it('certifies IN by halves a strip inside a self-overlapping stroke (C9/k22)', () => {
    const r = a04CoverSelfTest(corpusCase('C9/k22/T7/z64-d1/center/k0'), 0x2e4, {
      boxes: [248.1875, 248.21875].flatMap((x0) =>
        [180.0625, 180.09375].map((y0) => ({ x0, y0, x1: x0 + 2 ** -5, y1: y0 + 2 ** -5 })),
      ),
      samples: 32,
    });
    expect(r.findings).toEqual([]);
    expect(r.halvesIn).toBeGreaterThan(0);
  });
});

describe('E3-U2e: OUT by the local hull (T6)', () => {
  // A freeze cell outside the stroke by about 0.02 local units, beside a foot, whose local
  // image is a skewed parallelogram well inside its axis-aligned box's reach of the curve.
  it('decides an outside cell that the box distance leaves open (C9/g0249)', () => {
    const r = a04CoverSelfTest(corpusCase('C9/g0249/T6/z1-d2/center/k0'), 0x2e5, {
      boxes: [{ x0: 44.875, y0: 59.5, x1: 44.9375, y1: 59.5625 }],
      samples: 32,
    });
    expect(r.findings).toEqual([]);
    expect(r.decided).toBe(1);
  });
});
