import type { CarriedPath, PairWitnesses, Relation, RelationCounts } from './types.js';

export type CarrierFixture = Readonly<{
  id: string;
  path: CarriedPath;
  expected: Readonly<{
    rawEmitted: number;
    omittedZero: number;
    retainedEmitted: number;
    closure: 0 | 1;
    normalizedEdges: number;
    pairs: number;
    counts: RelationCounts;
    first: PairWitnesses;
    aabbRejected: number;
    exactTested: number;
  }>;
}>;

const relations: readonly Relation[] = [
  'DISJOINT',
  'PROPER_CROSSING',
  'ENDPOINT_TOUCH',
  'T_JUNCTION',
  'COLLINEAR_POINT',
  'COINCIDENT_SAME',
  'COINCIDENT_REVERSED',
  'COLLINEAR_OVERLAP',
];

export function emptyCounts(): RelationCounts {
  return Object.fromEntries(relations.map((relation) => [relation, 0])) as RelationCounts;
}

export function emptyWitnesses(): PairWitnesses {
  return Object.fromEntries(relations.map((relation) => [relation, null])) as PairWitnesses;
}

export function carried(points: readonly (readonly [number, number])[]): CarriedPath {
  const verbs = new Uint8Array(points.length);
  verbs.fill(1, 1);
  const coordinates = new Float64Array(points.length * 2);
  const provenance = new Uint32Array(points.length * 3);
  provenance.set([0, 1, 0], 0);
  points.forEach(([x, y], index) => {
    coordinates[index * 2] = x;
    coordinates[index * 2 + 1] = y;
    if (index > 0) provenance.set([index, 1, 0], index * 3);
  });
  return { verbs, points: coordinates, provenance };
}

function fixture(
  id: string,
  points: readonly (readonly [number, number])[],
  values: Partial<CarrierFixture['expected']> &
    Pick<CarrierFixture['expected'], 'counts' | 'first'>,
): CarrierFixture {
  const rawEmitted = points.length - 1;
  const retainedEmitted = values.retainedEmitted ?? rawEmitted;
  const closure = values.closure ?? 0;
  const normalizedEdges = values.normalizedEdges ?? retainedEmitted + closure;
  return {
    id,
    path: carried(points),
    expected: {
      rawEmitted,
      omittedZero: values.omittedZero ?? rawEmitted - retainedEmitted,
      retainedEmitted,
      closure,
      normalizedEdges,
      pairs: values.pairs ?? (normalizedEdges * (normalizedEdges - 1)) / 2,
      counts: values.counts,
      first: values.first,
      aabbRejected: values.aabbRejected ?? 0,
      exactTested: values.exactTested ?? (normalizedEdges * (normalizedEdges - 1)) / 2,
    },
  };
}

export function smokeFixtures(): readonly CarrierFixture[] {
  const triangleCounts = emptyCounts();
  triangleCounts.ENDPOINT_TOUCH = 3;
  const triangleFirst = emptyWitnesses();
  triangleFirst.ENDPOINT_TOUCH = [0, 1];
  const bowtieCounts = emptyCounts();
  bowtieCounts.DISJOINT = 1;
  bowtieCounts.PROPER_CROSSING = 1;
  bowtieCounts.ENDPOINT_TOUCH = 4;
  const bowtieFirst = emptyWitnesses();
  bowtieFirst.DISJOINT = [1, 3];
  bowtieFirst.PROPER_CROSSING = [0, 2];
  bowtieFirst.ENDPOINT_TOUCH = [0, 1];
  const retraceCounts = emptyCounts();
  retraceCounts.COINCIDENT_REVERSED = 1;
  const retraceFirst = emptyWitnesses();
  retraceFirst.COINCIDENT_REVERSED = [0, 1];
  return [
    fixture(
      'smoke/triangle',
      [
        [0, 0],
        [2, 0],
        [0, 2],
        [0, 0],
      ],
      {
        counts: triangleCounts,
        first: triangleFirst,
      },
    ),
    fixture(
      'smoke/bowtie',
      [
        [0, 0],
        [2, 2],
        [0, 2],
        [2, 0],
      ],
      {
        closure: 1,
        normalizedEdges: 4,
        counts: bowtieCounts,
        first: bowtieFirst,
        aabbRejected: 1,
        exactTested: 5,
      },
    ),
    fixture(
      'smoke/retrace',
      [
        [0, 0],
        [2, 0],
        [0, 0],
      ],
      {
        counts: retraceCounts,
        first: retraceFirst,
      },
    ),
    fixture(
      'smoke/collapsed',
      [
        [0, 0],
        [0, 0],
      ],
      {
        retainedEmitted: 0,
        omittedZero: 1,
        pairs: 0,
        counts: emptyCounts(),
        first: emptyWitnesses(),
        exactTested: 0,
      },
    ),
  ];
}

export function signedZeroCarrier(): CarriedPath {
  const result = carried([
    [-0, 0],
    [0, -0],
    [2, 0],
    [2, 0],
    [0, 2],
    [-0, 0],
  ]);
  return result;
}

export function carriedSourceStartCarrier(): CarriedPath {
  return carried([
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ]);
}

export function maximumCollapsedCarrier(): CarriedPath {
  const verbs = new Uint8Array(4097);
  verbs.fill(1, 1);
  const points = new Float64Array(4097 * 2);
  const provenance = new Uint32Array(4097 * 3);
  provenance.set([0, 1, 0], 0);
  for (let index = 1; index <= 4096; index += 1) {
    const sourceVerbOrdinal = Math.floor((index - 1) / 128) + 1;
    const endNumerator = ((index - 1) % 128) + 1;
    provenance.set([sourceVerbOrdinal, endNumerator, 7], index * 3);
  }
  return { verbs, points, provenance };
}
