import { describe, expect, it } from 'vitest';
import { canonicalEdge, contactTuple } from './types.js';

describe('polygon census canonical serialization', () => {
  it('pins both raw identities, class code, adjacency and little-endian tuple order', () => {
    expect(contactTuple(1, 2, 3, 4, 'T_JUNCTION', true).toString('hex')).toBe(
      '010000000200000003000000040000000301',
    );
    expect(contactTuple(0, 5, 6, 7, 'COINCIDENT_REVERSED', false).toString('hex')).toBe(
      '000000000500000006000000070000000600',
    );
  });

  it('retains signed zero and subnormal bits with the frozen property order', () => {
    expect(
      JSON.stringify(
        canonicalEdge({
          rawIndex: 4,
          kind: 'closure',
          sourceVerbOrdinal: null,
          endNumerator: null,
          depth: null,
          start: [-0, Number.MIN_VALUE],
          end: [1, 0],
        }),
      ),
    ).toBe(
      '{"rawIndex":4,"kind":"closure","sourceVerbOrdinal":null,"endNumerator":null,"depth":null,"startBits":["8000000000000000","0000000000000001"],"endBits":["3ff0000000000000","0000000000000000"]}',
    );
  });
});
