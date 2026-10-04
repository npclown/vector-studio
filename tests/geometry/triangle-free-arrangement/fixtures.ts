import type { Cubic, Point } from '../../../packages/geometry-reference/src/types.js';
import type { CubicTopologySegmentFixture } from '../simple-cubic-topology/fixtures.js';
import type {
  TransverseArrangementControl,
  TransverseArrangementFixture,
} from '../transverse-arrangement/fixtures.js';

export type TriangleFreeArrangementFixture = TransverseArrangementFixture &
  Readonly<{
    sourceKinds: readonly boolean[];
    directedPartnerOrder?: readonly Readonly<{
      leaf: number;
      partners: readonly number[];
    }>[];
  }>;

export type TriangleFreeArrangementControl = TransverseArrangementControl &
  Readonly<{ sourceKinds: readonly boolean[] }>;

type RawSegment = Readonly<{ cubic: Cubic; end: Point }>;

const A = [
  [-3, 0],
  [3, 0],
  [0, -10],
] as const satisfies readonly Point[];
const B = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const satisfies readonly Point[];
const CAP_A = [
  [-20, -2],
  [20, -1],
  [-20, 0],
  [20, 1],
  [-20, 2],
  [20, 3],
  [20, 4],
  [-41 / 2, 4],
] as const satisfies readonly Point[];

function quarterCubic(start: Point, end: Point): Cubic {
  return [
    start,
    [(3 * start[0] + end[0]) / 4, (3 * start[1] + end[1]) / 4],
    [(start[0] + 3 * end[0]) / 4, (start[1] + 3 * end[1]) / 4],
    end,
  ];
}

function lineAdapter(start: Point, end: Point): Cubic {
  return [start, start, end, end];
}

function closed(vertices: readonly Point[], lines: readonly boolean[] = []): readonly RawSegment[] {
  return vertices.map((start, index) => {
    const end = vertices[(index + 1) % vertices.length]!;
    return { cubic: lines[index] ? lineAdapter(start, end) : quarterCubic(start, end), end };
  });
}

function segments(
  rawContours: readonly (readonly RawSegment[])[],
): readonly (readonly CubicTopologySegmentFixture[])[] {
  let sourceVerbOrdinal = 1;
  return rawContours.map((contour) =>
    contour.map(({ cubic, end }) => {
      const ordinal = sourceVerbOrdinal++;
      return {
        cubic,
        sourceVerbOrdinal: ordinal,
        lines: [{ end, provenance: { sourceVerbOrdinal: ordinal, endNumerator: 1, depth: 0 } }],
      };
    }),
  );
}

function reflect(vertices: readonly Point[]): readonly Point[] {
  return vertices.map(([x, y]) => [-x, y] as const);
}

function reverseAtFirst(vertices: readonly Point[]): readonly Point[] {
  return [vertices[0]!, ...vertices.slice(1).reverse()];
}

function star(
  id: string,
  a: readonly RawSegment[],
  b: readonly RawSegment[],
  polygons: readonly (readonly Point[])[],
  sourceKinds: readonly boolean[],
  crossings: TransverseArrangementFixture['expected']['crossings'],
  directedPartnerOrder: TriangleFreeArrangementFixture['directedPartnerOrder'],
): TriangleFreeArrangementFixture {
  return {
    id,
    contours: segments([a, b]),
    sourceKinds,
    ...(directedPartnerOrder === undefined ? {} : { directedPartnerOrder }),
    expected: { leaves: 7, pairs: 21, polygons, crossings },
  };
}

const STAR_CROSSINGS = [
  { leftLeaf: 0, rightLeaf: 4, orientation: 1 },
  { leftLeaf: 0, rightLeaf: 6, orientation: -1 },
] as const;
const STAR_ORDER = [{ leaf: 0, partners: [6, 4] }] as const;

/** Returns the eight frozen triangle-free positives in contract order. */
export function fixedTriangleFreeArrangementFixtures(): readonly TriangleFreeArrangementFixture[] {
  const explicitA = closed(A);
  const explicitB = closed(B);
  const reflectedA = reflect(A);
  const reflectedB = reflect(B);
  const reversedA = reverseAtFirst(A);
  const reversedB = reverseAtFirst(B);
  const implicitA = explicitA.slice(0, -1);
  const implicitB = explicitB.slice(0, -1);
  const mixedKinds = [true, false, false, false, false, false, false] as const;
  const curvedA = [...explicitA];
  curvedA[0] = {
    cubic: [A[0], [-1, 1 / 16], [1, -1 / 16], A[1]],
    end: A[1],
  };
  const capB = [
    [-8, -5],
    [-4, 7 / 2],
    [0, -5],
    [4, 7 / 2],
    [8, -5],
    [12, 5],
    [16, 5],
    [16, -6],
  ] as const satisfies readonly Point[];
  return [
    star('star', explicitA, explicitB, [A, B], Array(7).fill(false), STAR_CROSSINGS, STAR_ORDER),
    star(
      'star-reflect',
      closed(reflectedA),
      closed(reflectedB),
      [reflectedA, reflectedB],
      Array(7).fill(false),
      [
        { leftLeaf: 0, rightLeaf: 4, orientation: -1 },
        { leftLeaf: 0, rightLeaf: 6, orientation: 1 },
      ],
      STAR_ORDER,
    ),
    star(
      'star-reverse',
      closed(reversedA),
      closed(reversedB),
      [reversedA, reversedB],
      Array(7).fill(false),
      [
        { leftLeaf: 2, rightLeaf: 3, orientation: -1 },
        { leftLeaf: 2, rightLeaf: 5, orientation: 1 },
      ],
      [{ leaf: 2, partners: [5, 3] }],
    ),
    star(
      'star-implicit',
      implicitA,
      implicitB,
      [A, B],
      Array(5).fill(false),
      STAR_CROSSINGS,
      STAR_ORDER,
    ),
    star(
      'star-mixed',
      closed(A, mixedKinds.slice(0, 3)),
      explicitB,
      [A, B],
      mixedKinds,
      STAR_CROSSINGS,
      STAR_ORDER,
    ),
    star(
      'star-lines',
      closed(A, [true, true, true]),
      closed(B, [true, true, true, true]),
      [A, B],
      Array(7).fill(true),
      STAR_CROSSINGS,
      STAR_ORDER,
    ),
    star(
      'star-curved',
      curvedA,
      explicitB,
      [A, B],
      Array(7).fill(false),
      STAR_CROSSINGS,
      STAR_ORDER,
    ),
    {
      id: 'cap-32',
      contours: segments([closed(CAP_A), closed(capB)]),
      sourceKinds: Array(16).fill(false),
      expected: {
        leaves: 16,
        pairs: 120,
        polygons: [CAP_A, capB],
        crossings: [
          { leftLeaf: 0, rightLeaf: 8, orientation: 1 },
          { leftLeaf: 0, rightLeaf: 9, orientation: -1 },
          { leftLeaf: 0, rightLeaf: 10, orientation: 1 },
          { leftLeaf: 0, rightLeaf: 11, orientation: -1 },
          { leftLeaf: 0, rightLeaf: 12, orientation: 1 },
          { leftLeaf: 0, rightLeaf: 14, orientation: -1 },
          { leftLeaf: 1, rightLeaf: 8, orientation: -1 },
          { leftLeaf: 1, rightLeaf: 9, orientation: 1 },
          { leftLeaf: 1, rightLeaf: 10, orientation: -1 },
          { leftLeaf: 1, rightLeaf: 11, orientation: 1 },
          { leftLeaf: 1, rightLeaf: 12, orientation: -1 },
          { leftLeaf: 1, rightLeaf: 14, orientation: 1 },
          { leftLeaf: 2, rightLeaf: 8, orientation: 1 },
          { leftLeaf: 2, rightLeaf: 9, orientation: -1 },
          { leftLeaf: 2, rightLeaf: 10, orientation: 1 },
          { leftLeaf: 2, rightLeaf: 11, orientation: -1 },
          { leftLeaf: 2, rightLeaf: 12, orientation: 1 },
          { leftLeaf: 2, rightLeaf: 14, orientation: -1 },
          { leftLeaf: 3, rightLeaf: 8, orientation: -1 },
          { leftLeaf: 3, rightLeaf: 9, orientation: 1 },
          { leftLeaf: 3, rightLeaf: 10, orientation: -1 },
          { leftLeaf: 3, rightLeaf: 11, orientation: 1 },
          { leftLeaf: 3, rightLeaf: 12, orientation: -1 },
          { leftLeaf: 3, rightLeaf: 14, orientation: 1 },
          { leftLeaf: 4, rightLeaf: 8, orientation: 1 },
          { leftLeaf: 4, rightLeaf: 9, orientation: -1 },
          { leftLeaf: 4, rightLeaf: 10, orientation: 1 },
          { leftLeaf: 4, rightLeaf: 11, orientation: -1 },
          { leftLeaf: 4, rightLeaf: 12, orientation: 1 },
          { leftLeaf: 4, rightLeaf: 14, orientation: -1 },
          { leftLeaf: 6, rightLeaf: 12, orientation: -1 },
          { leftLeaf: 6, rightLeaf: 14, orientation: 1 },
        ],
      },
    },
  ];
}

function triangleControl(id: string, vertices: readonly Point[]): TriangleFreeArrangementControl {
  return {
    id,
    contours: segments([closed(vertices)]),
    sourceKinds: Array(7).fill(false),
    status: 'UNRESOLVED',
    leaves: 7,
    pairs: 13,
    findingIncludes: ['triangle', '2,4'],
  };
}

/** Returns the two K3 rejections and the crossing-publication overflow control. */
export function triangleFreeArrangementControls(): readonly TriangleFreeArrangementControl[] {
  const distinct = [
    [0, 0],
    [5, 6],
    [5, -1],
    [-1, 5],
    [7, 2],
    [-2, 2],
    [-3, -2],
  ] as const satisfies readonly Point[];
  const concurrent = [
    [0, 0],
    [6, 6],
    [6, -2],
    [-1, 5],
    [15 / 2, 2],
    [-2, 2],
    [-3, -2],
  ] as const satisfies readonly Point[];
  const overflowB = [
    [-8, -5],
    [-4, 7 / 2],
    [0, -5],
    [4, 5],
    [8, -5],
    [12, 5],
    [16, 5],
    [16, -6],
  ] as const satisfies readonly Point[];
  return [
    triangleControl('distinct-triangle', distinct),
    triangleControl('concurrent-triangle', concurrent),
    {
      id: 'cap-overflow',
      contours: segments([closed(CAP_A), closed(overflowB)]),
      sourceKinds: Array(16).fill(false),
      status: 'WORK_LIMIT',
      leaves: 16,
      pairs: 81,
      findingIncludes: ['32', 'crossings'],
    },
  ];
}
