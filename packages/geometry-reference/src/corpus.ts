import { screenTolerance } from './tolerance.js';
import {
  REFERENCE_PATH_STATUS,
  REFERENCE_VERB,
  type ContinuousPositiveControl,
  type Cubic,
  type GeometryCorpusCase,
  type Matrix2,
  type MetamorphicCubicFixture,
  type NamedCubicFixture,
  type NamedPackedFixture,
  type Point,
  type ReferenceFlattenedLine,
  type SubdivisionMetamorphicFixture,
} from './types.js';

export const P2_CORPUS_VERSION = 'p2-geometry/v1' as const;
export const P2_CORPUS_SEEDS = Object.freeze([1, 0x1234_5678, 0x9e37_79b9, 0xdead_beef]);
export const P2_CUBICS_PER_SEED = 2_500;

function nextXorshift32(state: number): number {
  let value = state >>> 0;
  value = (value ^ (value << 13)) >>> 0;
  value = (value ^ (value >>> 17)) >>> 0;
  value = (value ^ (value << 5)) >>> 0;
  return value;
}

function transformPoint(point: Point, index: number): readonly [Point, string] {
  switch (index % 5) {
    case 0:
      return [point, 'identity'];
    case 1:
      return [[point[0] + 1e9, point[1] - 1e9], 'translate(1e9,-1e9)'];
    case 2:
      return [[point[0] * 1e-6, point[1] * 1e-6], 'scale(1e-6)'];
    case 3: {
      const angle = Math.PI / 7;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      return [
        [cosine * point[0] - sine * point[1], sine * point[0] + cosine * point[1]],
        'rotate(pi/7)',
      ];
    }
    default:
      return [[point[0] + 3 * point[1], point[1]], "shear(x'=x+3y)"];
  }
}

const WORLD_MATRICES: readonly Matrix2[] = Object.freeze([
  [1, 0, 0, 1],
  [4, 0, 0, 0.25],
  [1, 3, 0, 1],
  [Math.cos(Math.PI / 7), -Math.sin(Math.PI / 7), Math.sin(Math.PI / 7), Math.cos(Math.PI / 7)],
  [-1, 0, 0, 1],
]);
const ZOOMS = [0.01, 1, 64] as const;
const DPRS = [1, 2, 3] as const;

export function* iterateP2GeometryCorpus(): Generator<GeometryCorpusCase, void, undefined> {
  let globalIndex = 0;
  for (const seed of P2_CORPUS_SEEDS) {
    let state = seed;
    for (let seedIndex = 0; seedIndex < P2_CUBICS_PER_SEED; seedIndex += 1) {
      const base: Point[] = [];
      for (let pointIndex = 0; pointIndex < 4; pointIndex += 1) {
        state = nextXorshift32(state);
        const x = (2 * (state / 2 ** 32) - 1) * 1000;
        state = nextXorshift32(state);
        const y = (2 * (state / 2 ** 32) - 1) * 1000;
        base.push([x, y]);
      }
      const transformed = base.map((point) => transformPoint(point, globalIndex));
      const cubic = transformed.map((entry) => entry[0]) as unknown as Cubic;
      const localTransform = transformed[0]![1];
      const world = WORLD_MATRICES[Math.floor(globalIndex / 5) % WORLD_MATRICES.length]!;
      const zoom = ZOOMS[Math.floor(globalIndex / 25) % ZOOMS.length]!;
      const dpr = DPRS[Math.floor(globalIndex / 75) % DPRS.length]!;
      const tolerance = screenTolerance(world, zoom, dpr);
      if (!tolerance.ok)
        throw new RangeError(`frozen corpus tolerance failed: ${tolerance.finding}`);
      yield {
        version: P2_CORPUS_VERSION,
        index: globalIndex,
        seed,
        seedIndex,
        cubic,
        localTransform,
        world,
        zoom,
        dpr,
        bucketTolerance: tolerance.bucketTolerance,
      };
      globalIndex += 1;
    }
  }
}

export function generateP2GeometryCorpus(): readonly GeometryCorpusCase[] {
  return [...iterateP2GeometryCorpus()];
}

const lineEquivalent: Cubic = [
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 3],
];
const exactExtrema: Cubic = [
  [0, 0],
  [1, 2],
  [2, 2],
  [3, 0],
];
const sCurve: Cubic = [
  [0, 0],
  [1, 3],
  [2, -3],
  [3, 0],
];

export const NAMED_CUBIC_FIXTURES: readonly NamedCubicFixture[] = Object.freeze([
  { name: 'line-equivalent', cubic: lineEquivalent, expectation: 'success' },
  { name: 'exact-interior-extrema', cubic: exactExtrema, expectation: 'success' },
  {
    name: 'near-linear-derivative',
    cubic: [
      [0, 0],
      [1, 1e-14],
      [2, -1e-14],
      [3, 0],
    ],
    expectation: 'success',
  },
  {
    name: 'double-root',
    cubic: [
      [0, 0],
      [1, 1],
      [2, 0],
      [3, 1],
    ],
    expectation: 'success',
  },
  { name: 's-curve', cubic: sCurve, expectation: 'success' },
  {
    name: 'cusp',
    cubic: [
      [0.25, -0.125],
      [-1 / 12, 0.125],
      [-1 / 12, -0.125],
      [0.25, 0.125],
    ],
    expectation: 'success',
  },
  {
    name: 'collinear-overshoot',
    cubic: [
      [0, 0],
      [3, 0],
      [-2, 0],
      [1, 0],
    ],
    expectation: 'success',
  },
  {
    name: 'retracing',
    cubic: [
      [0, 0],
      [2, 0],
      [-2, 0],
      [0, 0],
    ],
    expectation: 'success',
  },
  {
    name: 'closed-loop',
    cubic: [
      [0, 0],
      [2, 3],
      [-2, 3],
      [0, 0],
    ],
    expectation: 'success',
  },
  {
    name: 'tiny-controls',
    cubic: [
      [0, 0],
      [1e-300, 0],
      [0, 1e-300],
      [1e-300, 1e-300],
    ],
    expectation: 'success',
  },
  {
    name: 'translated-controls',
    cubic: [
      [1e9, -1e9],
      [1e9 + 1, -1e9 + 2],
      [1e9 + 2, -1e9 - 2],
      [1e9 + 3, -1e9],
    ],
    expectation: 'success',
  },
  {
    name: 'huge-unrepresentable-arithmetic',
    cubic: [
      [-Number.MAX_VALUE, 0],
      [Number.MAX_VALUE, 1],
      [-Number.MAX_VALUE, 1],
      [Number.MAX_VALUE, 0],
    ],
    expectation: 'numeric-range',
  },
]);

const request = (bucketTolerance = 0.25) => ({
  requestId: 7,
  sourceEpoch: 2,
  sourceRevision: 9,
  bucketTolerance,
});

export const NAMED_PACKED_FIXTURES: readonly NamedPackedFixture[] = Object.freeze([
  {
    name: 'empty',
    input: {
      requests: [request()],
      pathOffsets: [0, 0],
      pointOffsets: [0, 0],
      verbs: [],
      points: [],
    },
    envelopeValid: true,
    statuses: [REFERENCE_PATH_STATUS.EMPTY],
  },
  {
    name: 'move-only',
    input: {
      requests: [request()],
      pathOffsets: [0, 1],
      pointOffsets: [0, 2],
      verbs: [REFERENCE_VERB.MOVE],
      points: [2, 3],
    },
    envelopeValid: true,
    statuses: [REFERENCE_PATH_STATUS.OK],
  },
  {
    name: 'line-close',
    input: {
      requests: [request()],
      pathOffsets: [0, 3],
      pointOffsets: [0, 4],
      verbs: [REFERENCE_VERB.MOVE, REFERENCE_VERB.LINE, REFERENCE_VERB.CLOSE],
      points: [0, 0, 2, 3],
    },
    envelopeValid: true,
    statuses: [REFERENCE_PATH_STATUS.OK],
  },
  {
    name: 'nested-subpaths',
    input: {
      requests: [request()],
      pathOffsets: [0, 5],
      pointOffsets: [0, 8],
      verbs: [0, 1, 0, 1, 3],
      points: [0, 0, 1, 0, 2, 2, 3, 2],
    },
    envelopeValid: true,
    statuses: [REFERENCE_PATH_STATUS.OK],
  },
  {
    name: 'invalid-state',
    input: {
      requests: [request()],
      pathOffsets: [0, 1],
      pointOffsets: [0, 2],
      verbs: [REFERENCE_VERB.LINE],
      points: [1, 1],
    },
    envelopeValid: true,
    statuses: [REFERENCE_PATH_STATUS.INVALID_PATH],
  },
  {
    name: 'invalid-arity',
    input: {
      requests: [request()],
      pathOffsets: [0, 2],
      pointOffsets: [0, 6],
      verbs: [REFERENCE_VERB.MOVE, REFERENCE_VERB.CUBIC],
      points: [0, 0, 1, 1, 2, 2],
    },
    envelopeValid: true,
    statuses: [REFERENCE_PATH_STATUS.INVALID_PATH],
  },
  {
    name: 'nonfinite-coordinate',
    input: {
      requests: [request()],
      pathOffsets: [0, 1],
      pointOffsets: [0, 2],
      verbs: [REFERENCE_VERB.MOVE],
      points: [Number.NaN, 0],
    },
    envelopeValid: true,
    statuses: [REFERENCE_PATH_STATUS.INVALID_PATH],
  },
  {
    name: 'invalid-tolerance',
    input: {
      requests: [request(0)],
      pathOffsets: [0, 0],
      pointOffsets: [0, 0],
      verbs: [],
      points: [],
    },
    envelopeValid: true,
    statuses: [REFERENCE_PATH_STATUS.INVALID_TOLERANCE],
  },
  {
    name: 'invalid-terminal-offset',
    input: {
      requests: [request()],
      pathOffsets: [0, 0],
      pointOffsets: [0, 0],
      verbs: [0],
      points: [],
    },
    envelopeValid: false,
  },
  {
    name: 'mixed-failed-success',
    input: {
      requests: [request(), request()],
      pathOffsets: [0, 1, 2],
      pointOffsets: [0, 2, 4],
      verbs: [1, 0],
      points: [1, 1, 2, 2],
    },
    envelopeValid: true,
    statuses: [REFERENCE_PATH_STATUS.INVALID_PATH, REFERENCE_PATH_STATUS.OK],
  },
]);

function translate(cubic: Cubic, x: number, y: number): Cubic {
  return cubic.map((point) => [point[0] + x, point[1] + y]) as unknown as Cubic;
}

export const METAMORPHIC_CUBIC_FIXTURES: readonly MetamorphicCubicFixture[] = Object.freeze([
  {
    name: 'reverse-s-curve',
    source: sCurve,
    transformed: [...sCurve].reverse() as unknown as Cubic,
    transform: 'reverse',
  },
  {
    name: 'translate-s-curve',
    source: sCurve,
    transformed: translate(sCurve, 1e6, -1e6),
    transform: 'translate',
  },
  {
    name: 'uniform-scale-s-curve',
    source: sCurve,
    transformed: sCurve.map((point) => [point[0] * 8, point[1] * 8]) as unknown as Cubic,
    transform: 'uniform-scale',
  },
]);

export const SUBDIVISION_METAMORPHIC_FIXTURE: SubdivisionMetamorphicFixture = Object.freeze({
  name: 'midpoint-subdivision-s-curve',
  source: sCurve,
  halves: [
    [
      [0, 0],
      [0.5, 1.5],
      [1, 0.75],
      [1.5, 0],
    ],
    [
      [1.5, 0],
      [2, -0.75],
      [2.5, -1.5],
      [3, 0],
    ],
  ] as const,
});

const validLine: ReferenceFlattenedLine = {
  end: lineEquivalent[3],
  provenance: { sourceVerbOrdinal: 2, endNumerator: 1, depth: 0 },
};

export const CONTINUOUS_ERROR_POSITIVE_CONTROLS: readonly ContinuousPositiveControl[] =
  Object.freeze([
    {
      name: 'perturbed-endpoint',
      cubic: lineEquivalent,
      lines: [{ ...validLine, end: [3.5, 3] }],
      expectedFinding: 'endpoint',
    },
    {
      name: 'removed-interval',
      cubic: lineEquivalent,
      lines: [],
      expectedFinding: 'at least one line',
    },
    {
      name: 'duplicated-interval',
      cubic: lineEquivalent,
      lines: [validLine, validLine],
      expectedFinding: 'gap or overlap',
    },
    {
      name: 'corrupt-provenance',
      cubic: lineEquivalent,
      lines: [{ ...validLine, provenance: { sourceVerbOrdinal: 99, endNumerator: 1, depth: 0 } }],
      expectedFinding: 'source verb ordinal',
    },
  ]);
