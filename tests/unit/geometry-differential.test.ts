import { describe, expect, it } from 'vitest';
import {
  createDifferentialCases,
  encodeCase,
  runPositiveControls,
} from '../geometry/differential/index.js';
import { endpointHullFixtureMetadata } from '../geometry/differential/endpoint-hull.js';

const Z = '0000000000000000';
const NZ = '8000000000000000';
const ONE = '3ff0000000000000';
const T1 = '3ff5555555555555';
const T2 = '3ffaaaaaaaaaaaaa';
const TWO = '4000000000000000';
const QUARTER = '3fd0000000000000';

describe('P2 differential test composition', () => {
  it('freezes the complete corpus and all supplemental categories', () => {
    const cases = createDifferentialCases();
    const categories = cases.reduce<Record<string, number>>((counts, testCase) => {
      counts[testCase.category] = (counts[testCase.category] ?? 0) + 1;
      return counts;
    }, {});
    expect(categories.corpus).toBe(10_000);
    expect(categories['named-cubic']).toBeGreaterThan(0);
    expect(categories['named-packed']).toBeGreaterThan(0);
    expect(categories.metamorphic).toBe(3);
    expect(categories.subdivision).toBe(1);
    expect(categories['endpoint-hull']).toBe(14);
    expect(categories.edge).toBeGreaterThanOrEqual(7);
    expect(cases.map((testCase) => testCase.id).length).toBe(
      new Set(cases.map(({ id }) => id)).size,
    );
  });

  it('freezes endpoint-hull identities, statuses, scalar bits, and signed zero', () => {
    const fixtures = endpointHullFixtureMetadata();
    expect(fixtures.map(({ id }) => id)).toEqual([
      'E01',
      'E02',
      'E03',
      'E04',
      'E05',
      'E06',
      'E07',
      'E08',
      'E09',
      'E10',
      'F01',
      'F02',
      'F03',
      'F04',
    ]);
    expect(fixtures.map(({ expectedStatuses }) => expectedStatuses)).toEqual([
      [0],
      [0],
      [0],
      [0],
      [0],
      [0],
      [0],
      [0],
      [0],
      [0],
      [4, 0],
      [4, 0],
      [4, 0],
      [4, 0],
    ]);
    expect(fixtures.map(({ toleranceBits }) => toleranceBits)).toEqual([
      [QUARTER],
      [QUARTER],
      [QUARTER],
      [QUARTER],
      [QUARTER],
      [QUARTER],
      [QUARTER],
      [QUARTER],
      [QUARTER],
      [QUARTER],
      [QUARTER, QUARTER],
      ['7e70000000000000', QUARTER],
      ['3cd0000000000000', QUARTER],
      [QUARTER, QUARTER],
    ]);
    const t = [ONE, Z, T1, Z, T2, Z, TWO, Z];
    expect(fixtures.map(({ pointBits }) => pointBits)).toEqual([
      [t],
      [[ONE, Z, '3fe5555555555556', Z, '3fd5555555555556', Z, Z, Z]],
      [
        [
          'bff0000000000000',
          Z,
          'bff5555555555555',
          Z,
          'bffaaaaaaaaaaaaa',
          Z,
          'c000000000000000',
          Z,
        ],
      ],
      [
        [
          '4022000000000000',
          Z,
          '4022aaaaaaaaaaab',
          Z,
          '4023555555555555',
          Z,
          '4024000000000000',
          Z,
        ],
      ],
      [[Z, ONE, Z, T1, Z, T2, Z, TWO]],
      [[ONE, NZ, T1, Z, T2, NZ, TWO, Z]],
      [[Z, Z, '4008000000000000', Z, ONE, Z, '4010000000000000', Z]],
      [[ONE, Z, T1, '4008000000000000', T2, '4008000000000000', TWO, Z]],
      [[Z, Z, '3fb0000000000000', Z, 'bfc0000000000000', Z, '3fdc000000000000', Z]],
      [[Z, Z, Z, Z, ONE, Z, ONE, Z]],
      [
        [
          '7fefffffffffffff',
          Z,
          'ffefffffffffffff',
          Z,
          '7fefffffffffffff',
          Z,
          'ffefffffffffffff',
          Z,
        ],
        t,
      ],
      [[Z, Z, '7fd8000000000000', Z, '7fd8000000000000', Z, '7fd8000000000000', Z], t],
      [t, t],
      [
        [
          Z,
          Z,
          ONE,
          Z,
          '7fefffffffffffff',
          Z,
          'ffefffffffffffff',
          Z,
          '7fefffffffffffff',
          Z,
          'ffefffffffffffff',
          Z,
        ],
        t,
      ],
    ]);
  });

  it('uses an independent canonical encoder and rejects every verifier positive control', () => {
    const cases = createDifferentialCases();
    for (const testCase of cases) {
      const bytes = encodeCase(testCase);
      expect(bytes.byteLength, testCase.id).toBeGreaterThanOrEqual(48);
      expect(new DataView(bytes.buffer).getUint32(8, true), testCase.id).toBe(bytes.byteLength);
    }
    const controls = runPositiveControls();
    expect(controls.rejected).toBe(controls.attempted);
    expect(controls.attempted).toBeGreaterThanOrEqual(12);
  });
});
