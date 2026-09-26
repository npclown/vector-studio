import { describe, expect, it } from 'vitest';
import {
  createDifferentialCases,
  encodeCase,
  runPositiveControls,
} from '../geometry/differential/index.js';

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
    expect(categories.edge).toBeGreaterThanOrEqual(7);
    expect(cases.map((testCase) => testCase.id).length).toBe(
      new Set(cases.map(({ id }) => id)).size,
    );
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
