import type {
  Cubic,
  Point,
  ReferenceFlattenedLine,
} from '../../../packages/geometry-reference/src/types.js';
import {
  nativeCubicSourceBits,
  nativeCubicSourceContours,
  type NativeCubicRule,
  type NativeCubicSourceFixtureRow,
} from '../native-cubic/fixtures.js';
import { encodeNativeMixedCubicRows } from '../native-mixed-cubic/fixtures.js';
import type { TransverseArrangementCrossingFixture } from '../transverse-arrangement/fixtures.js';

export type NativeDepthPositiveCubicFixtureRow = NativeCubicSourceFixtureRow &
  Readonly<{
    sourceKinds: readonly boolean[];
    packedKinds: readonly boolean[];
    expectedLeafPartitions: readonly (readonly (readonly ReferenceFlattenedLine[])[])[];
    expectedPolygons: readonly (readonly Point[])[];
    expectedCrossings: readonly TransverseArrangementCrossingFixture[];
    expectedCrossingPoints: readonly Point[];
    expectedCommandCount: number;
    expectedPointCount: number;
    expectedInputScalars: number;
    expectedPolygonArea: number;
  }>;

const A = [
  [-3, 0],
  [0, 3 / 32],
  [3, 0],
  [0, -10],
] as const satisfies readonly Point[];
const B = [
  [1, -1],
  [2, -1],
  [2, 1],
  [1, 1],
] as const satisfies readonly Point[];
const ARCH: Cubic = [
  [-3, 0],
  [-1, 1 / 8],
  [1, 1 / 8],
  [3, 0],
];
const RULES = ['nonzero', 'evenodd'] as const satisfies readonly NativeCubicRule[];

function line(start: Point, end: Point): Cubic {
  return [start, start, end, end];
}

function leaf(
  end: Point,
  sourceVerbOrdinal: number,
  endNumerator = 1,
  depth = 0,
): ReferenceFlattenedLine {
  return { end, provenance: { sourceVerbOrdinal, endNumerator, depth } };
}

function rows(
  id: string,
  cubics: readonly (readonly Cubic[])[],
  sourceKinds: readonly boolean[],
  packedKinds: readonly boolean[],
  expectedLeafPartitions: NativeDepthPositiveCubicFixtureRow['expectedLeafPartitions'],
  expectedCommandCount: number,
  expectedPointCount: number,
  expectedInputScalars: number,
): readonly NativeDepthPositiveCubicFixtureRow[] {
  const contours = nativeCubicSourceContours(cubics);
  const sourceBits = nativeCubicSourceBits(contours);
  return RULES.map((rule) => ({
    id,
    rule,
    expectation: 'OK',
    contours,
    sourceBits,
    sourceKinds,
    packedKinds,
    expectedLeafPartitions,
    expectedPolygons: [A, B],
    expectedCrossings: [
      { leftLeaf: 1, rightLeaf: 5, orientation: 1 },
      { leftLeaf: 1, rightLeaf: 7, orientation: -1 },
    ],
    expectedCrossingPoints: [
      [2, 1 / 32],
      [1, 1 / 16],
    ],
    expectedCommandCount,
    expectedPointCount,
    expectedInputScalars,
    expectedPolygonArea: 483 / 16,
  }));
}

/** Returns the exact four Z source/rule rows in protocol order. */
export function fixedNativeDepthPositiveCubicFixtureRows(): readonly NativeDepthPositiveCubicFixtureRow[] {
  const explicitA = [ARCH, line(A[2], A[3]), line(A[3], A[0])];
  const explicitB = B.map((start, index) => line(start, B[(index + 1) % B.length]!));
  const openA = [line(A[0], A[0]), ARCH, line(A[2], A[3])];
  const openB = B.slice(0, -1).map((start, index) => line(start, B[index + 1]!));
  return [
    ...rows(
      'depth-positive/star',
      [explicitA, explicitB],
      [false, true, true, true, true, true, true],
      [false, true, true, true, true, true, true],
      [
        [[leaf(A[1], 1, 1, 1), leaf(A[2], 1, 2, 1)], [leaf(A[3], 2)], [leaf(A[0], 3)]],
        [[leaf(B[1], 6)], [leaf(B[2], 7)], [leaf(B[3], 8)], [leaf(B[0], 9)]],
      ],
      12,
      20,
      22,
    ),
    ...rows(
      'depth-positive/zero-closure',
      [openA, openB],
      [true, false, true, true, true, true],
      [false, true, true, true, true],
      [
        [[leaf(A[0], 1)], [leaf(A[1], 2, 1, 1), leaf(A[2], 2, 2, 1)], [leaf(A[3], 3)]],
        [[leaf(B[1], 5)], [leaf(B[2], 6)], [leaf(B[3], 7)]],
      ],
      9,
      18,
      20,
    ),
  ];
}

export function encodeNativeDepthPositiveCubicFixture(
  rows: readonly NativeDepthPositiveCubicFixtureRow[],
): string {
  return encodeNativeMixedCubicRows(rows, 4, '# p3-native-depth-positive-cubic-v1');
}
