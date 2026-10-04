import type { Cubic, Point } from '../../../packages/geometry-reference/src/types.js';
import {
  encodeNativeCubicRows,
  nativeCubicSourceBits,
  nativeCubicSourceContours,
  type NativeCubicFixtureRow,
  type NativeCubicRule,
} from '../native-cubic/fixtures.js';

export type NativeRoundedCubicFixtureRow = NativeCubicFixtureRow &
  Readonly<{
    sourceKind: 'exact' | 'rounded';
    expectedPolygon: readonly Point[];
    expectedUpperLines: readonly Point[];
  }>;

const A = [0, 0] as const satisfies Point;
const B = [3, 0] as const satisfies Point;
const C = [3 / 2, -3] as const satisfies Point;
const LOWER_POINTS = [
  B,
  [21 / 8, -3 / 4],
  [9 / 4, -3 / 2],
  [15 / 8, -9 / 4],
  C,
  [9 / 8, -9 / 4],
  [3 / 4, -3 / 2],
  [3 / 8, -3 / 4],
  A,
] as const satisfies readonly Point[];
const EXPECTED_UPPER_LINES = [
  [3 / 4, 9 / 64],
  [3 / 2, 3 / 8],
  [9 / 4, 27 / 64],
  B,
] as const satisfies readonly Point[];
const EXPECTED_POLYGON = [
  A,
  ...EXPECTED_UPPER_LINES,
  ...LOWER_POINTS.slice(1, -1),
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

function sourceCubics(sourceKind: NativeRoundedCubicFixtureRow['sourceKind']): readonly Cubic[] {
  const upper: Cubic = [A, [1, sourceKind === 'rounded' ? 2 ** -54 : 0], [2, 1], B];
  return [
    upper,
    ...LOWER_POINTS.slice(0, -1).map((start, index) =>
      linearCubic(start, LOWER_POINTS[index + 1]!),
    ),
  ];
}

function fixture(
  sourceKind: NativeRoundedCubicFixtureRow['sourceKind'],
  rule: NativeCubicRule,
): NativeRoundedCubicFixtureRow {
  const contours = nativeCubicSourceContours([sourceCubics(sourceKind)]);
  return {
    id: `adoption/${sourceKind}`,
    rule,
    expectation: 'OK',
    contours,
    sourceBits: nativeCubicSourceBits(contours),
    orientations: [-1],
    winding: [[0]],
    sourceKind,
    expectedPolygon: EXPECTED_POLYGON,
    expectedUpperLines: EXPECTED_UPPER_LINES,
  };
}

/** Returns the frozen four-row rounded-topology adoption source in contract order. */
export function fixedNativeRoundedCubicFixtureRows(): readonly NativeRoundedCubicFixtureRow[] {
  return (['exact', 'rounded'] as const).flatMap((sourceKind) =>
    RULES.map((rule) => fixture(sourceKind, rule)),
  );
}

/** Encodes the fixed-four wrapper around the unchanged native cubic source grammar. */
export function encodeNativeRoundedCubicFixture(
  rows: readonly NativeRoundedCubicFixtureRow[],
): string {
  return encodeNativeCubicRows(rows, 4);
}
