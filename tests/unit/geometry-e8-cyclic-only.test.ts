// E8-U1, E8-Q3 extension of 2026-10-23 (docs/plans/p3-rounded-knot-topology-contract.md): the
// replacement cyclic-only rejection stays UNRESOLVED under d1 and d2 in every test-only oracle.
// Its native counterpart is `e8_direction_hint_tests::cyclic_only_replacement_is_unresolved_natively`
// with the same statuses and counters.
import { describe, expect, it } from 'vitest';

import {
  E8_ADMITTED_CYCLIC_ONLY,
  e8CyclicOnlyReplacement,
  roundedKnotTopologyControls,
} from '../geometry/rounded-knot-topology/fixtures.js';
import {
  certifyRoundedKnotCubicTopology,
  certifySimpleCubicTopology,
  certifyTransverseCubicArrangement,
  certifyTriangleFreeCubicArrangement,
} from '../geometry/simple-cubic-topology/oracle.js';

const control = e8CyclicOnlyReplacement();
const kinds = control.contours.flat().map(() => false);

describe('E8-U1 replacement cyclic-only control', () => {
  it('fails only at the last-to-first adjacent pair in P3.1f, P3.1g and P3.1i', () => {
    for (const result of [
      certifyRoundedKnotCubicTopology(control.contours),
      certifyTransverseCubicArrangement(control.contours),
      certifyTriangleFreeCubicArrangement(control.contours, kinds),
    ]) {
      expect(result.status).toBe(control.status);
      expect([result.leaves, result.pairs]).toEqual([control.leaves, control.pairs]);
      expect(result.finding).toContain(control.findingIncludes);
      expect(result.finding).toContain('lacks a common directed projection');
      expect(result.certificate).toBeNull();
    }
  });

  it('is rejected by the unchanged P3.1e certificate too (recorded deviation)', () => {
    const exact = certifySimpleCubicTopology(control.contours);
    expect(exact.status).toBe('UNRESOLVED');
    expect([exact.leaves, exact.pairs]).toEqual([6, 5]);
  });

  it('keeps every knot exact and leaves the admitted frozen original as a positive', () => {
    const lines = control.contours.flat().flatMap(({ lines }) => lines);
    expect(lines.map(({ provenance }) => provenance.depth)).toEqual([0, 0, 2, 2, 2, 2]);
    const original = roundedKnotTopologyControls().find(
      ({ id }) => id === E8_ADMITTED_CYCLIC_ONLY.id,
    )!;
    expect(certifyRoundedKnotCubicTopology(original.contours).status).toBe('CERTIFIED');
  });
});
