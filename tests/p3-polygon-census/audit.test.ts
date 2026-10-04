import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { auditEdges, auditExtractEdges, auditPair } from './audit.js';
import {
  CONTACT_DOMAIN,
  MAX_EDGES,
  MAX_RAW_EMITTED,
  RELATIONS,
  canonicalEdge,
  contactTuple,
  type CarriedPath,
  type Edge,
  type Pair,
  type Relation,
  type RelationCounts,
} from './types.js';

type Point = readonly [number, number];
type PairFixture = Readonly<{ name: string; first: Edge; second: Edge; expected: Relation }>;

function edge(start: Point, end: Point, rawIndex = 0): Edge {
  return {
    rawIndex,
    kind: 'emitted',
    sourceVerbOrdinal: rawIndex + 1,
    endNumerator: 1,
    depth: 0,
    start,
    end,
  };
}

function pair(
  first: readonly [Point, Point],
  second: readonly [Point, Point],
): readonly [Edge, Edge] {
  return [edge(first[0], first[1], 0), edge(second[0], second[1], 1)];
}

function reverse(value: Edge): Edge {
  return { ...value, start: value.end, end: value.start };
}

function rotatePoint(value: Point): Point {
  return [-value[1], value[0]];
}

function rotate(value: Edge): Edge {
  return { ...value, start: rotatePoint(value.start), end: rotatePoint(value.end) };
}

function counts(entries: Partial<RelationCounts>): RelationCounts {
  return Object.fromEntries(
    RELATIONS.map((relation) => [relation, entries[relation] ?? 0]),
  ) as RelationCounts;
}

function witnesses(entries: Partial<Record<Relation, Pair>>): Record<Relation, Pair | null> {
  return Object.fromEntries(
    RELATIONS.map((relation) => [relation, entries[relation] ?? null]),
  ) as Record<Relation, Pair | null>;
}

function contactHash(
  entries: readonly Readonly<{
    pair: Pair;
    raw: Pair;
    relation: Relation;
    adjacent: boolean;
  }>[],
): string {
  const hash = createHash('sha256').update(CONTACT_DOMAIN, 'utf8');
  for (const entry of entries) {
    hash.update(
      contactTuple(
        entry.pair[0],
        entry.pair[1],
        entry.raw[0],
        entry.raw[1],
        entry.relation,
        entry.adjacent,
      ),
    );
  }
  return hash.digest('hex');
}

function carried(points: readonly Point[]): CarriedPath {
  const verbs = new Uint8Array(points.length);
  const scalars = new Float64Array(points.length * 2);
  const provenance = new Uint32Array(points.length * 3);
  points.forEach((point, index) => {
    verbs[index] = index === 0 ? 0 : 1;
    scalars[index * 2] = point[0];
    scalars[index * 2 + 1] = point[1];
    provenance[index * 3] = index;
    provenance[index * 3 + 1] = 1;
    provenance[index * 3 + 2] = 0;
  });
  return { verbs, points: scalars, provenance };
}

const base: readonly [Point, Point] = [
  [0, 0],
  [2, 0],
];
const literalFixtures: readonly PairFixture[] = [
  {
    name: 'parallel separated',
    first: pair(base, [
      [0, 1],
      [2, 1],
    ])[0],
    second: pair(base, [
      [0, 1],
      [2, 1],
    ])[1],
    expected: 'DISJOINT',
  },
  {
    name: 'proper crossing',
    first: pair(base, [
      [1, -1],
      [1, 1],
    ])[0],
    second: pair(base, [
      [1, -1],
      [1, 1],
    ])[1],
    expected: 'PROPER_CROSSING',
  },
  {
    name: 'endpoint touch',
    first: pair(base, [
      [2, 0],
      [2, 2],
    ])[0],
    second: pair(base, [
      [2, 0],
      [2, 2],
    ])[1],
    expected: 'ENDPOINT_TOUCH',
  },
  {
    name: 'T-junction',
    first: pair(base, [
      [1, 0],
      [1, 2],
    ])[0],
    second: pair(base, [
      [1, 0],
      [1, 2],
    ])[1],
    expected: 'T_JUNCTION',
  },
  {
    name: 'collinear point',
    first: pair(base, [
      [2, 0],
      [3, 0],
    ])[0],
    second: pair(base, [
      [2, 0],
      [3, 0],
    ])[1],
    expected: 'COLLINEAR_POINT',
  },
  {
    name: 'coincident same',
    first: pair(base, base)[0],
    second: pair(base, base)[1],
    expected: 'COINCIDENT_SAME',
  },
  {
    name: 'coincident reversed',
    first: pair(base, [base[1], base[0]])[0],
    second: pair(base, [base[1], base[0]])[1],
    expected: 'COINCIDENT_REVERSED',
  },
  {
    name: 'partial collinear overlap',
    first: pair(base, [
      [1, 0],
      [3, 0],
    ])[0],
    second: pair(base, [
      [1, 0],
      [3, 0],
    ])[1],
    expected: 'COLLINEAR_OVERLAP',
  },
  {
    name: 'contained collinear overlap',
    first: pair(base, [
      [0.5, 0],
      [1.5, 0],
    ])[0],
    second: pair(base, [
      [0.5, 0],
      [1.5, 0],
    ])[1],
    expected: 'COLLINEAR_OVERLAP',
  },
  {
    name: 'parallel with overlapping boxes',
    first: pair(
      [
        [0, 0],
        [2, 2],
      ],
      [
        [0, 1],
        [1, 2],
      ],
    )[0],
    second: pair(
      [
        [0, 0],
        [2, 2],
      ],
      [
        [0, 1],
        [1, 2],
      ],
    )[1],
    expected: 'DISJOINT',
  },
  {
    name: 'box-boundary touch without segment contact',
    first: pair(
      [
        [0, 0],
        [1, 1],
      ],
      [
        [1, 0],
        [2, 1],
      ],
    )[0],
    second: pair(
      [
        [0, 0],
        [1, 1],
      ],
      [
        [1, 0],
        [2, 1],
      ],
    )[1],
    expected: 'DISJOINT',
  },
  {
    name: 'subnormal proper crossing',
    first: pair(
      [
        [0, 0],
        [2 * Number.MIN_VALUE, 0],
      ],
      [
        [Number.MIN_VALUE, -Number.MIN_VALUE],
        [Number.MIN_VALUE, Number.MIN_VALUE],
      ],
    )[0],
    second: pair(
      [
        [0, 0],
        [2 * Number.MIN_VALUE, 0],
      ],
      [
        [Number.MIN_VALUE, -Number.MIN_VALUE],
        [Number.MIN_VALUE, Number.MIN_VALUE],
      ],
    )[1],
    expected: 'PROPER_CROSSING',
  },
];

describe('P3 polygon relation independent parametric audit', () => {
  it.each(literalFixtures)('classifies $name literally', ({ first, second, expected }) => {
    expect(auditPair(first, second)).toBe(expected);
  });

  it.each(literalFixtures)('preserves $name under vertical rotation and pair swap', (fixture) => {
    expect(auditPair(rotate(fixture.first), rotate(fixture.second))).toBe(fixture.expected);
    expect(auditPair(fixture.second, fixture.first)).toBe(fixture.expected);
    expect(auditPair(rotate(fixture.second), rotate(fixture.first))).toBe(fixture.expected);
  });

  it.each(literalFixtures.filter(({ expected }) => !expected.startsWith('COINCIDENT_')))(
    'preserves $name when either or both directions reverse',
    ({ first, second, expected }) => {
      expect(auditPair(reverse(first), second)).toBe(expected);
      expect(auditPair(first, reverse(second))).toBe(expected);
      expect(auditPair(reverse(first), reverse(second))).toBe(expected);
    },
  );

  it('switches only coincidence direction when exactly one segment reverses', () => {
    const same = literalFixtures.find(({ expected }) => expected === 'COINCIDENT_SAME')!;
    const reversed = literalFixtures.find(({ expected }) => expected === 'COINCIDENT_REVERSED')!;
    expect(auditPair(reverse(same.first), same.second)).toBe('COINCIDENT_REVERSED');
    expect(auditPair(same.first, reverse(same.second))).toBe('COINCIDENT_REVERSED');
    expect(auditPair(reverse(same.first), reverse(same.second))).toBe('COINCIDENT_SAME');
    expect(auditPair(reverse(reversed.first), reversed.second)).toBe('COINCIDENT_SAME');
    expect(auditPair(reversed.first, reverse(reversed.second))).toBe('COINCIDENT_SAME');
    expect(auditPair(reverse(reversed.first), reverse(reversed.second))).toBe(
      'COINCIDENT_REVERSED',
    );
  });

  it('rejects nonfinite and mathematical-zero pair inputs', () => {
    expect(() => auditPair(edge([0, 0], [Number.NaN, 1]), edge([0, 1], [1, 1], 1))).toThrow(
      'finite',
    );
    expect(() => auditPair(edge([-0, 0], [0, -0]), edge([0, 1], [1, 1], 1))).toThrow('zero edge');
  });
});

describe('P3 polygon relation independent census aggregation', () => {
  it('counts the frozen returning triangle and hashes contacts in canonical order', () => {
    const normalized = auditExtractEdges(
      carried([
        [0, 0],
        [2, 0],
        [0, 2],
        [0, 0],
      ]),
    );
    const result = auditEdges(normalized.edges);
    expect(result).toMatchObject({
      edges: 3,
      pairs: 3,
      aabbRejected: 0,
      exactTested: 3,
      counts: counts({ ENDPOINT_TOUCH: 3 }),
      adjacent: counts({ ENDPOINT_TOUCH: 3 }),
      nonadjacent: counts({}),
      first: witnesses({ ENDPOINT_TOUCH: [0, 1] }),
      contactSha256: contactHash([
        { pair: [0, 1], raw: [0, 1], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [0, 2], raw: [0, 2], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [1, 2], raw: [1, 2], relation: 'ENDPOINT_TOUCH', adjacent: true },
      ]),
    });
    expect(result.peakCandidateRecords).toBeLessThanOrEqual(result.edges);
  });

  it('counts the frozen bowtie including the excluded DISJOINT pair', () => {
    const normalized = auditExtractEdges(
      carried([
        [0, 0],
        [2, 2],
        [0, 2],
        [2, 0],
      ]),
    );
    const result = auditEdges(normalized.edges);
    expect(result).toMatchObject({
      edges: 4,
      pairs: 6,
      aabbRejected: 1,
      exactTested: 5,
      counts: counts({ DISJOINT: 1, PROPER_CROSSING: 1, ENDPOINT_TOUCH: 4 }),
      adjacent: counts({ ENDPOINT_TOUCH: 4 }),
      nonadjacent: counts({ DISJOINT: 1, PROPER_CROSSING: 1 }),
      first: witnesses({
        DISJOINT: [1, 3],
        PROPER_CROSSING: [0, 2],
        ENDPOINT_TOUCH: [0, 1],
      }),
      contactSha256: contactHash([
        { pair: [0, 1], raw: [0, 1], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [0, 2], raw: [0, 2], relation: 'PROPER_CROSSING', adjacent: false },
        { pair: [0, 3], raw: [0, 3], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [1, 2], raw: [1, 2], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [2, 3], raw: [2, 3], relation: 'ENDPOINT_TOUCH', adjacent: true },
      ]),
    });
    expect(result.peakCandidateRecords).toBeLessThanOrEqual(result.edges);
  });

  it('counts the frozen retrace and collapsed carriers', () => {
    const retrace = auditEdges(
      auditExtractEdges(
        carried([
          [0, 0],
          [2, 0],
          [0, 0],
        ]),
      ).edges,
    );
    expect(retrace).toMatchObject({
      edges: 2,
      pairs: 1,
      aabbRejected: 0,
      exactTested: 1,
      counts: counts({ COINCIDENT_REVERSED: 1 }),
      adjacent: counts({ COINCIDENT_REVERSED: 1 }),
      nonadjacent: counts({}),
      first: witnesses({ COINCIDENT_REVERSED: [0, 1] }),
      contactSha256: contactHash([
        { pair: [0, 1], raw: [0, 1], relation: 'COINCIDENT_REVERSED', adjacent: true },
      ]),
    });

    const collapsed = auditEdges(
      auditExtractEdges(
        carried([
          [0, 0],
          [0, 0],
        ]),
      ).edges,
    );
    expect(collapsed).toMatchObject({
      edges: 0,
      pairs: 0,
      aabbRejected: 0,
      exactTested: 0,
      counts: counts({}),
      adjacent: counts({}),
      nonadjacent: counts({}),
      first: witnesses({}),
      contactSha256: createHash('sha256').update(CONTACT_DOMAIN, 'utf8').digest('hex'),
      peakCandidateRecords: 0,
    });
  });

  it('exact-tests closed boxes that merely touch and independently returns DISJOINT', () => {
    const fixture = literalFixtures.find(({ name }) => name.startsWith('box-boundary'))!;
    const result = auditEdges([fixture.first, fixture.second]);
    expect(result).toMatchObject({
      pairs: 1,
      aabbRejected: 0,
      exactTested: 1,
      counts: counts({ DISJOINT: 1 }),
      adjacent: counts({ DISJOINT: 1 }),
      first: witnesses({ DISJOINT: [0, 1] }),
    });
  });

  it('rejects holes and the edge cap before inspecting excess entries', () => {
    const hole = new Array<Edge>(1);
    expect(() => auditEdges(hole)).toThrow('absent');
    const excess = new Array<Edge>(MAX_EDGES + 1);
    expect(() => auditEdges(excess)).toThrow('fixed cap');
  });
});

describe('P3 polygon relation independent carried-edge normalization', () => {
  it('adds the frozen implicit closure and retains raw identities', () => {
    const result = auditExtractEdges(
      carried([
        [0, 0],
        [2, 0],
        [0, 2],
      ]),
    );
    expect(result).toMatchObject({
      rawEmitted: 2,
      omittedZero: 0,
      retainedEmitted: 2,
      closure: 1,
      normalizedEdges: 3,
    });
    expect(result.edges.map(({ rawIndex, kind }) => ({ rawIndex, kind }))).toEqual([
      { rawIndex: 0, kind: 'emitted' },
      { rawIndex: 1, kind: 'emitted' },
      { rawIndex: 2, kind: 'closure' },
    ]);
    expect(auditEdges(result.edges)).toMatchObject({
      counts: counts({ ENDPOINT_TOUCH: 3 }),
      first: witnesses({ ENDPOINT_TOUCH: [0, 1] }),
    });
  });

  it('preserves the frozen signed-zero and removed-source-boundary control', () => {
    const result = auditExtractEdges(
      carried([
        [-0, 0],
        [0, -0],
        [2, 0],
        [2, 0],
        [0, 2],
        [-0, 0],
      ]),
    );
    expect(result).toMatchObject({
      rawEmitted: 5,
      omittedZero: 2,
      retainedEmitted: 3,
      closure: 0,
      normalizedEdges: 3,
    });
    expect(result.edges.map(({ rawIndex }) => rawIndex)).toEqual([1, 3, 4]);
    expect(canonicalEdge(result.edges[0]!)).toMatchObject({
      rawIndex: 1,
      startBits: ['0000000000000000', '8000000000000000'],
    });
    expect(Object.is(result.edges[0]!.start[0], 0)).toBe(true);
    expect(Object.is(result.edges[0]!.start[1], -0)).toBe(true);
    expect(auditEdges(result.edges)).toMatchObject({
      counts: counts({ ENDPOINT_TOUCH: 3 }),
      adjacent: counts({ ENDPOINT_TOUCH: 3 }),
      first: witnesses({ ENDPOINT_TOUCH: [0, 1] }),
      contactSha256: contactHash([
        { pair: [0, 1], raw: [1, 3], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [0, 2], raw: [1, 4], relation: 'ENDPOINT_TOUCH', adjacent: true },
        { pair: [1, 2], raw: [3, 4], relation: 'ENDPOINT_TOUCH', adjacent: true },
      ]),
    });
  });

  it('starts each retained edge at the actual carried endpoint across source boundaries', () => {
    const result = auditExtractEdges(
      carried([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ]),
    );
    expect(result).toMatchObject({
      rawEmitted: 3,
      omittedZero: 0,
      retainedEmitted: 3,
      closure: 0,
      normalizedEdges: 3,
    });
    expect(result.edges[1]!.start).toEqual([1, 0]);
    expect(result.edges[1]!.start).toEqual(result.edges[0]!.end);
    expect(auditEdges(result.edges)).toMatchObject({
      counts: counts({ ENDPOINT_TOUCH: 3 }),
      first: witnesses({ ENDPOINT_TOUCH: [0, 1] }),
    });
  });

  it('accepts the exact raw/source cap and rejects cap plus one before payload inspection', () => {
    const verbs = new Uint8Array(MAX_RAW_EMITTED + 1);
    const points = new Float64Array(verbs.length * 2);
    const provenance = new Uint32Array(verbs.length * 3);
    provenance[1] = 1;
    for (let source = 1; source <= 32; source += 1) {
      for (let numerator = 1; numerator <= 128; numerator += 1) {
        const command = (source - 1) * 128 + numerator;
        verbs[command] = 1;
        provenance[command * 3] = source;
        provenance[command * 3 + 1] = numerator;
        provenance[command * 3 + 2] = 7;
      }
    }
    expect(auditExtractEdges({ verbs, points, provenance })).toMatchObject({
      rawEmitted: MAX_RAW_EMITTED,
      omittedZero: MAX_RAW_EMITTED,
      retainedEmitted: 0,
      closure: 0,
      normalizedEdges: 0,
    });

    const excess: CarriedPath = {
      verbs: new Uint8Array(MAX_RAW_EMITTED + 2).fill(255),
      points: new Float64Array(0),
      provenance: new Uint32Array(0),
    };
    expect(() => auditExtractEdges(excess)).toThrow('raw emitted count exceeds the fixed cap');
  });

  it('rejects malformed shape, finite values, commands, and provenance', () => {
    const valid = carried([
      [0, 0],
      [1, 0],
    ]);
    expect(() => auditExtractEdges({ ...valid, points: new Float64Array([0, 0, 1]) })).toThrow(
      'cardinality',
    );
    expect(() => auditExtractEdges({ ...valid, provenance: new Uint32Array([0, 1, 0]) })).toThrow(
      'cardinality',
    );
    expect(() => auditExtractEdges({ ...valid, verbs: new Uint8Array([1, 1]) })).toThrow('MOVE');
    expect(() =>
      auditExtractEdges({
        ...valid,
        points: new Float64Array([0, 0, Number.POSITIVE_INFINITY, 0]),
      }),
    ).toThrow('finite');
    expect(() =>
      auditExtractEdges({ ...valid, provenance: new Uint32Array([0, 1, 0, 2, 1, 0]) }),
    ).toThrow('source ordinals');
    expect(() =>
      auditExtractEdges({ ...valid, provenance: new Uint32Array([0, 1, 0, 1, 1, 8]) }),
    ).toThrow('depth');
    expect(() =>
      auditExtractEdges({ ...valid, provenance: new Uint32Array([0, 1, 0, 1, 0, 0]) }),
    ).toThrow('numerator');
  });
});
