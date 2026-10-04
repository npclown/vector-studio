import type { Cubic, Point } from '../../../packages/geometry-reference/src/types.js';
import {
  nativeCubicSourceBits,
  nativeCubicSourceContours,
  type NativeCubicRule,
  type NativeCubicSourceFixtureRow,
} from '../native-cubic/fixtures.js';
import { encodeNativeMixedCubicRows } from '../native-mixed-cubic/fixtures.js';
import type { TransverseArrangementCrossingFixture } from '../transverse-arrangement/fixtures.js';

export type NativeTriangleFreeCubicFixtureRow = NativeCubicSourceFixtureRow &
  Readonly<{
    sourceKinds: readonly boolean[];
    packedKinds: readonly boolean[];
    expectedPolygons: readonly (readonly Point[])[];
    expectedCrossings: readonly TransverseArrangementCrossingFixture[];
    expectedCrossingPoints: readonly Point[];
    expectedCommandCount: number;
    expectedPointCount: number;
    expectedInputScalars: number;
    expectedSourceArea: number;
  }>;

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
const RULES = ['nonzero', 'evenodd'] as const satisfies readonly NativeCubicRule[];

function line(start: Point, end: Point): Cubic {
  return [start, start, end, end];
}

function rows(
  id: string,
  cubics: readonly (readonly Cubic[])[],
  sourceKinds: readonly boolean[],
  packedKinds: readonly boolean[],
  expectedCommandCount: number,
  expectedPointCount: number,
  expectedInputScalars: number,
): readonly NativeTriangleFreeCubicFixtureRow[] {
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
    expectedPolygons: [A, B],
    expectedCrossings: [
      { leftLeaf: 0, rightLeaf: 4, orientation: 1 },
      { leftLeaf: 0, rightLeaf: 6, orientation: -1 },
    ],
    expectedCrossingPoints: [
      [1, 0],
      [-1, 0],
    ],
    expectedCommandCount,
    expectedPointCount,
    expectedInputScalars,
    expectedSourceArea: 30,
  }));
}

/** Returns the exact four Y source/rule rows in protocol order. */
export function fixedNativeTriangleFreeCubicFixtureRows(): readonly NativeTriangleFreeCubicFixtureRow[] {
  const first: Cubic = [A[0], [-1, 0], [1, 0], A[1]];
  const explicitA = [first, line(A[1], A[2]), line(A[2], A[0])];
  const explicitB = B.map((start, index) => line(start, B[(index + 1) % B.length]!));
  const openA = [line(A[0], A[0]), first, line(A[1], A[2])];
  const openB = B.slice(0, -1).map((start, index) => line(start, B[index + 1]!));
  return [
    ...rows(
      'triangle-free/star',
      [explicitA, explicitB],
      [false, true, true, true, true, true, true],
      [false, true, true, true, true, true, true],
      11,
      18,
      22,
    ),
    ...rows(
      'triangle-free/zero-closure',
      [openA, openB],
      [true, false, true, true, true, true],
      [false, true, true, true, true],
      8,
      16,
      20,
    ),
  ];
}

export function encodeNativeTriangleFreeCubicFixture(
  rows: readonly NativeTriangleFreeCubicFixtureRow[],
): string {
  return encodeNativeMixedCubicRows(rows, 4, '# p3-native-triangle-free-cubic-v1');
}
