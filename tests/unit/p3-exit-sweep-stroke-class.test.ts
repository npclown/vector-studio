// A03: the A01 sweep's stroke rejection labels and counting keys (E11 section 7.2), without the
// WASM build.
import { describe, expect, it } from 'vitest';

import { rowKey, strokeClassLabel } from '../geometry/p3-exit-sweep/stroke-class.js';

describe('p3-exit sweep stroke classes', () => {
  it('labels only work-limit as the closed-list stroke class and keeps every other code', () => {
    expect(strokeClassLabel('failed:work-limit')).toBe('stroke-work-limit');
    for (const outcome of [
      'failed:unsupported-geometry',
      'failed:numeric-range',
      'failed:invalid-tolerance',
      'batch-failed:internal-error',
      'empty',
    ])
      expect(strokeClassLabel(outcome)).toBe(outcome);
  });

  it('keys the scene as one row and corpus rows by stratum and named or generated', () => {
    expect(rowKey('scene', 'p3-exit-stress/v1/stroke/12')).toBe('scene');
    expect(rowKey('corpus', 'C5/l36/T6/z64-d3')).toBe('C5/named');
    expect(rowKey('corpus', 'C3/g0042/T1/z1-d1')).toBe('C3/generated');
    expect(rowKey('corpus', 'C3/g42x/T1')).toBe('C3/named');
  });
});
