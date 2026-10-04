import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyEdges, classifyPair } from './classifier.js';
import {
  CONTACT_DOMAIN,
  MAX_EDGES,
  MAX_PAIRS,
  RELATIONS,
  type Edge,
  type Pair,
  type PairWitnesses,
  type Point,
  type Relation,
  type RelationCounts,
} from './types.js';

function edge(rawIndex: number, start: Point, end: Point, kind: Edge['kind'] = 'emitted'): Edge {
  return {
    rawIndex,
    kind,
    sourceVerbOrdinal: kind === 'emitted' ? rawIndex + 1 : null,
    endNumerator: kind === 'emitted' ? 1 : null,
    depth: kind === 'emitted' ? 0 : null,
    start,
    end,
  };
}

function relationMap(overrides: Partial<RelationCounts> = {}): RelationCounts {
  return {
    DISJOINT: 0,
    PROPER_CROSSING: 0,
    ENDPOINT_TOUCH: 0,
    T_JUNCTION: 0,
    COLLINEAR_POINT: 0,
    COINCIDENT_SAME: 0,
    COINCIDENT_REVERSED: 0,
    COLLINEAR_OVERLAP: 0,
    ...overrides,
  };
}

function witnesses(overrides: Partial<PairWitnesses> = {}): PairWitnesses {
  return {
    DISJOINT: null,
    PROPER_CROSSING: null,
    ENDPOINT_TOUCH: null,
    T_JUNCTION: null,
    COLLINEAR_POINT: null,
    COINCIDENT_SAME: null,
    COINCIDENT_REVERSED: null,
    COLLINEAR_OVERLAP: null,
    ...overrides,
  };
}

function rotate([x, y]: Point): Point {
  return [-y, x];
}

function reverse(value: Edge): Edge {
  return { ...value, start: value.end, end: value.start };
}

type PairCase = Readonly<{
  name: string;
  first: Edge;
  second: Edge;
  expected: Relation;
}>;

const base = edge(0, [0, 0], [2, 0]);
const literalPairCases: readonly PairCase[] = [
  { name: 'parallel disjoint', first: base, second: edge(1, [0, 1], [2, 1]), expected: 'DISJOINT' },
  {
    name: 'proper crossing',
    first: base,
    second: edge(1, [1, -1], [1, 1]),
    expected: 'PROPER_CROSSING',
  },
  {
    name: 'endpoint touch',
    first: base,
    second: edge(1, [2, 0], [2, 2]),
    expected: 'ENDPOINT_TOUCH',
  },
  { name: 'T-junction', first: base, second: edge(1, [1, 0], [1, 2]), expected: 'T_JUNCTION' },
  {
    name: 'collinear point',
    first: base,
    second: edge(1, [2, 0], [3, 0]),
    expected: 'COLLINEAR_POINT',
  },
  {
    name: 'coincident same',
    first: base,
    second: edge(1, [0, 0], [2, 0]),
    expected: 'COINCIDENT_SAME',
  },
  {
    name: 'coincident reversed',
    first: base,
    second: edge(1, [2, 0], [0, 0]),
    expected: 'COINCIDENT_REVERSED',
  },
  {
    name: 'partial overlap',
    first: base,
    second: edge(1, [1, 0], [3, 0]),
    expected: 'COLLINEAR_OVERLAP',
  },
  {
    name: 'contained overlap',
    first: base,
    second: edge(1, [1 / 2, 0], [3 / 2, 0]),
    expected: 'COLLINEAR_OVERLAP',
  },
];

function manualContactDigest(
  entries: readonly Readonly<{
    pair: Pair;
    raw: Pair;
    relation: Relation;
    adjacent: boolean;
  }>[],
): string {
  const hash = createHash('sha256').update(CONTACT_DOMAIN, 'utf8');
  for (const entry of entries) {
    const tuple = Buffer.alloc(18);
    tuple.writeUInt32LE(entry.pair[0], 0);
    tuple.writeUInt32LE(entry.pair[1], 4);
    tuple.writeUInt32LE(entry.raw[0], 8);
    tuple.writeUInt32LE(entry.raw[1], 12);
    tuple[16] = RELATIONS.indexOf(entry.relation);
    tuple[17] = entry.adjacent ? 1 : 0;
    hash.update(tuple);
  }
  return hash.digest('hex');
}

describe('P3 polygon primary exact pair classifier', () => {
  it.each(literalPairCases)('classifies the literal $name case', ({ first, second, expected }) => {
    expect(classifyPair(first, second)).toBe(expected);
  });

  it.each(literalPairCases)(
    'preserves $name under the frozen variants',
    ({ first, second, expected }) => {
      const verticalFirst = { ...first, start: rotate(first.start), end: rotate(first.end) };
      const verticalSecond = { ...second, start: rotate(second.start), end: rotate(second.end) };
      expect(classifyPair(second, first)).toBe(expected);
      expect(classifyPair(reverse(first), reverse(second))).toBe(expected);
      expect(classifyPair(verticalFirst, verticalSecond)).toBe(expected);

      const oneReversed = classifyPair(reverse(first), second);
      if (expected === 'COINCIDENT_SAME') expect(oneReversed).toBe('COINCIDENT_REVERSED');
      else if (expected === 'COINCIDENT_REVERSED') expect(oneReversed).toBe('COINCIDENT_SAME');
      else expect(oneReversed).toBe(expected);
    },
  );

  it('exact-tests parallel separated diagonals whose closed AABBs overlap', () => {
    const result = classifyEdges([edge(0, [0, 0], [2, 2]), edge(1, [0, 1], [1, 2])]);
    expect(result.aabbRejected).toBe(0);
    expect(result.exactTested).toBe(1);
    expect(result.counts).toEqual(relationMap({ DISJOINT: 1 }));
    expect(result.first).toEqual(witnesses({ DISJOINT: [0, 1] }));
  });

  it('does not reject a box-boundary T-junction', () => {
    const result = classifyEdges([base, edge(1, [2, -1], [2, 1])]);
    expect(result.aabbRejected).toBe(0);
    expect(result.exactTested).toBe(1);
    expect(result.counts).toEqual(relationMap({ T_JUNCTION: 1 }));
  });

  it('classifies a subnormal proper crossing without rounding its determinant to zero', () => {
    const unit = Number.MIN_VALUE;
    expect(classifyPair(edge(0, [0, 0], [2 * unit, 0]), edge(1, [unit, -unit], [unit, unit]))).toBe(
      'PROPER_CROSSING',
    );
  });

  it('rejects nonfinite and zero-length pair input before classification', () => {
    expect(() => classifyPair(edge(0, [0, 0], [1, 0]), edge(1, [2, 0], [Number.NaN, 0]))).toThrow(
      'finite',
    );
    expect(() => classifyPair(edge(0, [0, 0], [0, -0]), edge(1, [0, 0], [1, 0]))).toThrow(
      'nonzero',
    );
    expect(() => classifyPair(edge(-1, [0, 0], [1, 0]), edge(1, [2, 0], [3, 0]))).toThrow('uint32');
  });
});

describe('P3 polygon primary aggregation', () => {
  it('pins the triangle counts, witnesses, adjacency, and contact encoding', () => {
    const edges = [edge(0, [0, 0], [2, 0]), edge(1, [2, 0], [0, 2]), edge(2, [0, 2], [0, 0])];
    const result = classifyEdges(edges);
    expect(result).toEqual({
      edges: 3,
      pairs: 3,
      aabbRejected: 0,
      exactTested: 3,
      counts: relationMap({ ENDPOINT_TOUCH: 3 }),
      adjacent: relationMap({ ENDPOINT_TOUCH: 3 }),
      nonadjacent: relationMap(),
      first: witnesses({ ENDPOINT_TOUCH: [0, 1] }),
      contactSha256: manualContactDigest([
        { pair: [0, 1], raw: [0, 1], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [0, 2], raw: [0, 2], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [1, 2], raw: [1, 2], relation: 'ENDPOINT_TOUCH', adjacent: true },
      ]),
      peakCandidateRecords: 0,
    });
  });

  it('pins the bowtie lexicographic counts and first witnesses', () => {
    const result = classifyEdges([
      edge(0, [0, 0], [2, 2]),
      edge(1, [2, 2], [0, 2]),
      edge(2, [0, 2], [2, 0]),
      edge(3, [2, 0], [0, 0], 'closure'),
    ]);
    expect(result.edges).toBe(4);
    expect(result.pairs).toBe(6);
    expect(result.aabbRejected).toBe(1);
    expect(result.exactTested).toBe(5);
    expect(result.counts).toEqual(
      relationMap({ DISJOINT: 1, PROPER_CROSSING: 1, ENDPOINT_TOUCH: 4 }),
    );
    expect(result.adjacent).toEqual(relationMap({ ENDPOINT_TOUCH: 4 }));
    expect(result.nonadjacent).toEqual(relationMap({ DISJOINT: 1, PROPER_CROSSING: 1 }));
    expect(result.first).toEqual(
      witnesses({ DISJOINT: [1, 3], PROPER_CROSSING: [0, 2], ENDPOINT_TOUCH: [0, 1] }),
    );
    expect(result.contactSha256).toBe(
      manualContactDigest([
        { pair: [0, 1], raw: [0, 1], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [0, 2], raw: [0, 2], relation: 'PROPER_CROSSING', adjacent: false },
        { pair: [0, 3], raw: [0, 3], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [1, 2], raw: [1, 2], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [2, 3], raw: [2, 3], relation: 'ENDPOINT_TOUCH', adjacent: true },
      ]),
    );
  });

  it('counts a two-edge retrace once as adjacent and reversed', () => {
    const result = classifyEdges([edge(0, [0, 0], [2, 0]), edge(1, [2, 0], [0, 0])]);
    expect(result.pairs).toBe(1);
    expect(result.counts).toEqual(relationMap({ COINCIDENT_REVERSED: 1 }));
    expect(result.adjacent).toEqual(relationMap({ COINCIDENT_REVERSED: 1 }));
    expect(result.nonadjacent).toEqual(relationMap());
    expect(result.first).toEqual(witnesses({ COINCIDENT_REVERSED: [0, 1] }));
  });

  it('returns explicit zero maps and the empty contact digest for no edges', () => {
    expect(classifyEdges([])).toEqual({
      edges: 0,
      pairs: 0,
      aabbRejected: 0,
      exactTested: 0,
      counts: relationMap(),
      adjacent: relationMap(),
      nonadjacent: relationMap(),
      first: witnesses(),
      contactSha256: createHash('sha256').update(CONTACT_DOMAIN, 'utf8').digest('hex'),
      peakCandidateRecords: 0,
    });
  });

  it('accepts the exact edge and pair caps with bounded disjoint work', () => {
    const edges = Array.from({ length: MAX_EDGES }, (_, index) =>
      edge(index, [2 * index, 0], [2 * index + 1, 0]),
    );
    const result = classifyEdges(edges);
    expect(result.edges).toBe(4_097);
    expect(result.pairs).toBe(MAX_PAIRS);
    expect(result.aabbRejected).toBe(MAX_PAIRS);
    expect(result.exactTested).toBe(0);
    expect(result.counts).toEqual(relationMap({ DISJOINT: 8_390_656 }));
    expect(result.adjacent).toEqual(relationMap({ DISJOINT: 4_097 }));
    expect(result.nonadjacent).toEqual(relationMap({ DISJOINT: 8_386_559 }));
    expect(result.first).toEqual(witnesses({ DISJOINT: [0, 1] }));
    expect(result.peakCandidateRecords).toBe(0);
  });

  it('rejects cap plus one from cardinality before reading any edge', () => {
    const oversized = new Array<Edge>(MAX_EDGES + 1);
    Object.defineProperty(oversized, 0, {
      get() {
        throw new Error('inspected oversized input contents');
      },
    });
    expect(() => classifyEdges(oversized)).toThrow(`edge count exceeds ${MAX_EDGES}`);
  });

  it('validates every in-cap edge before doing pair work', () => {
    expect(() =>
      classifyEdges([edge(0, [0, 0], [1, 0]), edge(1, [100, 0], [Number.POSITIVE_INFINITY, 0])]),
    ).toThrow('finite');
    expect(() => classifyEdges([edge(0, [0, 0], [-0, 0])])).toThrow('nonzero');
  });
});
