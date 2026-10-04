import type { Cubic, Point } from '../../../packages/geometry-reference/src/types.js';
import {
  encodeNativeCubicRows,
  nativeCubicSourceBits,
  nativeCubicSourceContours,
  type NativeCubicRule,
  type NativeCubicSourceFixtureRow,
} from '../native-cubic/fixtures.js';
import type { TransverseArrangementCrossingFixture } from '../transverse-arrangement/fixtures.js';

export type NativeTransverseCubicFixtureRow = NativeCubicSourceFixtureRow &
  Readonly<{
    expectedPolygons: readonly (readonly Point[])[];
    expectedCrossings: readonly TransverseArrangementCrossingFixture[];
    expectedCrossingNodes: readonly Point[];
    expectedLeafPartitions: readonly (readonly number[])[];
    expectedTopology: Readonly<{ leaves: number; pairs: number }>;
    expectedVisits: number;
    expectedCommandCount: number;
    expectedArea: number;
  }>;

const B = [
  [-3, -3],
  [3, 3],
  [3, 9 / 2],
  [-3, 9 / 2],
  [-3, 3],
  [3, -3],
  [3, -9 / 2],
  [-3, -9 / 2],
] as const satisfies readonly Point[];
const R = [B[1], B[2], B[3], B[4], B[5], B[6], B[7], B[0]] as const;
const SQUARE_A = [
  [0, 0],
  [6, 0],
  [6, 6],
  [0, 6],
] as const satisfies readonly Point[];
const SQUARE_B = [
  [3, -3],
  [9, -3],
  [9, 3],
  [3, 3],
] as const satisfies readonly Point[];
const RULES = ['nonzero', 'evenodd'] as const satisfies readonly NativeCubicRule[];

function linearCubic(start: Point, end: Point): Cubic {
  return [
    start,
    [(2 * start[0] + end[0]) / 3, (2 * start[1] + end[1]) / 3],
    [(start[0] + 2 * end[0]) / 3, (start[1] + 2 * end[1]) / 3],
    end,
  ];
}

function closedCubics(vertices: readonly Point[]): readonly Cubic[] {
  return vertices.map((start, index) =>
    linearCubic(start, vertices[(index + 1) % vertices.length]!),
  );
}

function openCubics(vertices: readonly Point[]): readonly Cubic[] {
  return vertices.slice(0, -1).map((start, index) => linearCubic(start, vertices[index + 1]!));
}

function rows(
  id: string,
  cubics: readonly (readonly Cubic[])[],
  expectedPolygons: readonly (readonly Point[])[],
  expectedCrossings: readonly TransverseArrangementCrossingFixture[],
  expectedCrossingNodes: readonly Point[],
  expectedLeafPartitions: readonly (readonly number[])[],
  expectedTopology: Readonly<{ leaves: number; pairs: number }>,
  expectedVisits: number,
  expectedCommandCount: number,
  areas: Readonly<Record<NativeCubicRule, number>>,
): readonly NativeTransverseCubicFixtureRow[] {
  const contours = nativeCubicSourceContours(cubics);
  const sourceBits = nativeCubicSourceBits(contours);
  return RULES.map((rule) => ({
    id,
    rule,
    expectation: 'OK',
    contours,
    sourceBits,
    expectedPolygons,
    expectedCrossings,
    expectedCrossingNodes,
    expectedLeafPartitions,
    expectedTopology,
    expectedVisits,
    expectedCommandCount,
    expectedArea: areas[rule],
  }));
}

/** Returns the frozen six-row explicit transverse cubic source in protocol order. */
export function fixedNativeTransverseCubicFixtureRows(): readonly NativeTransverseCubicFixtureRow[] {
  return [
    ...rows(
      'composition/bowtie',
      [closedCubics(B)],
      [B],
      [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }],
      [[0, 0]],
      [[1, 1, 1, 1, 1, 1, 1, 1]],
      { leaves: 8, pairs: 28 },
      8,
      10,
      { nonzero: 36, evenodd: 36 },
    ),
    ...rows(
      'composition/closure',
      [openCubics(R)],
      [R],
      [{ leftLeaf: 3, rightLeaf: 7, orientation: 1 }],
      [[0, 0]],
      [[1, 1, 1, 1, 1, 1, 1]],
      { leaves: 8, pairs: 28 },
      7,
      8,
      { nonzero: 36, evenodd: 36 },
    ),
    ...rows(
      'composition/squares',
      [closedCubics(SQUARE_A), closedCubics(SQUARE_B)],
      [SQUARE_A, SQUARE_B],
      [
        { leftLeaf: 0, rightLeaf: 7, orientation: -1 },
        { leftLeaf: 1, rightLeaf: 6, orientation: 1 },
      ],
      [
        [3, 0],
        [6, 3],
      ],
      [
        [1, 1, 1, 1],
        [1, 1, 1, 1],
      ],
      { leaves: 8, pairs: 28 },
      8,
      12,
      { nonzero: 63, evenodd: 54 },
    ),
  ];
}

/** Encodes the exact-six wrapper around the unchanged native cubic source grammar. */
export function encodeNativeTransverseCubicFixture(
  fixtures: readonly NativeTransverseCubicFixtureRow[],
): string {
  return encodeNativeCubicRows(fixtures, 6);
}
