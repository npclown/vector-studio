import type { Cubic, Point } from '../../../packages/geometry-reference/src/types.js';
import {
  encodeNativeCubicRows,
  nativeCubicSourceBits,
  nativeCubicSourceContours,
  type NativeCubicRule,
} from '../native-cubic/fixtures.js';
import type { NativeTransverseCubicFixtureRow } from '../native-transverse-cubic/fixtures.js';

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
const RULES = ['nonzero', 'evenodd'] as const satisfies readonly NativeCubicRule[];

function linearCubic(start: Point, end: Point): Cubic {
  return [
    start,
    [(2 * start[0] + end[0]) / 3, (2 * start[1] + end[1]) / 3],
    [(start[0] + 2 * end[0]) / 3, (start[1] + 2 * end[1]) / 3],
    end,
  ];
}

function nonlinearCubics(): readonly Cubic[] {
  return B.map((start, index) => {
    const end = B[(index + 1) % B.length]!;
    if (index === 0) return [start, [-1, -1 + 1 / 16], [1, 1 - 1 / 16], end] as const;
    if (index === 4) return [start, [-1, 1 + 1 / 16], [1, -1 - 1 / 16], end] as const;
    return linearCubic(start, end);
  });
}

function transformPoint([x, y]: Point): Point {
  return [12 - x / 2, -8 + y / 2];
}

function rows(
  id: string,
  cubics: readonly Cubic[],
  expectedPolygons: readonly (readonly Point[])[],
  expectedCrossings: NativeTransverseCubicFixtureRow['expectedCrossings'],
  expectedCrossingNodes: readonly Point[],
  expectedLeafPartitions: readonly (readonly number[])[],
  expectedTopology: Readonly<{ leaves: number; pairs: number }>,
  expectedVisits: number,
  expectedCommandCount: number,
  expectedArea: number,
): readonly NativeTransverseCubicFixtureRow[] {
  const contours = nativeCubicSourceContours([cubics]);
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
    expectedArea,
  }));
}

/** Returns the frozen eight-row nonlinear transverse cubic source in protocol order. */
export function fixedNativeNonlinearTransverseCubicFixtureRows(): readonly NativeTransverseCubicFixtureRow[] {
  const nonlinear = nonlinearCubics();
  const closure = nonlinear.slice(1);
  const closurePolygon = [B[1], B[2], B[3], B[4], B[5], B[6], B[7], B[0]] as const;
  const reflected = nonlinear.map((cubic) => cubic.map(transformPoint) as unknown as Cubic);
  const reflectedPolygon = B.map(transformPoint);
  const subdivided = nonlinear.map((cubic, index) =>
    index === 2
      ? ([
          [3, 9 / 2],
          [1, 19 / 4],
          [-1, 19 / 4],
          [-3, 9 / 2],
        ] as const)
      : cubic,
  );
  const subdividedPolygon = [
    B[0],
    B[1],
    B[2],
    [0, 75 / 16],
    B[3],
    B[4],
    B[5],
    B[6],
    B[7],
  ] as const satisfies readonly Point[];
  return [
    ...rows(
      'nonlinear/bowtie',
      nonlinear,
      [B],
      [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }],
      [[0, 0]],
      [[1, 1, 1, 1, 1, 1, 1, 1]],
      { leaves: 8, pairs: 28 },
      8,
      10,
      36,
    ),
    ...rows(
      'nonlinear/closure',
      closure,
      [closurePolygon],
      [{ leftLeaf: 3, rightLeaf: 7, orientation: 1 }],
      [[0, 0]],
      [[1, 1, 1, 1, 1, 1, 1]],
      { leaves: 8, pairs: 28 },
      7,
      8,
      36,
    ),
    ...rows(
      'nonlinear/reflected',
      reflected,
      [reflectedPolygon],
      [{ leftLeaf: 0, rightLeaf: 4, orientation: 1 }],
      [[12, -8]],
      [[1, 1, 1, 1, 1, 1, 1, 1]],
      { leaves: 8, pairs: 28 },
      8,
      10,
      9,
    ),
    ...rows(
      'nonlinear/subdivided',
      subdivided,
      [subdividedPolygon],
      [{ leftLeaf: 0, rightLeaf: 5, orientation: -1 }],
      [[0, 0]],
      [[1, 1, 2, 1, 1, 1, 1, 1]],
      { leaves: 9, pairs: 36 },
      10,
      11,
      585 / 16,
    ),
  ];
}

/** Encodes the exact-eight wrapper around the unchanged native cubic source grammar. */
export function encodeNativeNonlinearTransverseCubicFixture(
  fixtures: readonly NativeTransverseCubicFixtureRow[],
): string {
  return encodeNativeCubicRows(fixtures, 8);
}
