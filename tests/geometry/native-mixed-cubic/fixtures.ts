import type { Cubic, Point } from '../../../packages/geometry-reference/src/types.js';
import {
  nativeCubicSourceBits,
  nativeCubicSourceContours,
  type NativeCubicRule,
  type NativeCubicSourceFixtureRow,
} from '../native-cubic/fixtures.js';
import type { TransverseArrangementCrossingFixture } from '../transverse-arrangement/fixtures.js';

export type NativeMixedCubicFixtureRow = NativeCubicSourceFixtureRow &
  Readonly<{
    sourceKinds: readonly boolean[];
    packedKinds: readonly boolean[];
    expectedPolygon: readonly Point[];
    expectedCrossings: readonly TransverseArrangementCrossingFixture[];
    expectedCrossingPoint: Point;
    expectedCommandCount: number;
    expectedCubicCount: number;
    expectedOldPairs: number;
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
const RULES = ['nonzero', 'evenodd'] as const satisfies readonly NativeCubicRule[];
const ID = /^[A-Za-z0-9/-]+$/u;

function linearCubic(start: Point, end: Point): Cubic {
  return [
    start,
    [(2 * start[0] + end[0]) / 3, (2 * start[1] + end[1]) / 3],
    [(start[0] + 2 * end[0]) / 3, (start[1] + 2 * end[1]) / 3],
    end,
  ];
}

function lineAdapter(start: Point, end: Point): Cubic {
  return [start, start, end, end];
}

function nonlinearN(): readonly Cubic[] {
  return B.map((start, index) => {
    const end = B[(index + 1) % B.length]!;
    if (index === 0) return [start, [-1, -1 + 1 / 16], [1, 1 - 1 / 16], end] as const;
    if (index === 4) return [start, [-1, 1 + 1 / 16], [1, -1 - 1 / 16], end] as const;
    return linearCubic(start, end);
  });
}

function fixtureRows(
  id: string,
  cubics: readonly Cubic[],
  sourceKinds: readonly boolean[],
  packedKinds: readonly boolean[],
  expectedPolygon: readonly Point[],
  expectedCrossings: readonly TransverseArrangementCrossingFixture[],
  expectedCommandCount: number,
  expectedCubicCount: number,
  expectedOldPairs: number,
): readonly NativeMixedCubicFixtureRow[] {
  const contours = nativeCubicSourceContours([cubics]);
  const sourceBits = nativeCubicSourceBits(contours);
  return RULES.map((rule) => ({
    id,
    rule,
    expectation: 'OK',
    contours,
    sourceBits,
    sourceKinds,
    packedKinds,
    expectedPolygon,
    expectedCrossings,
    expectedCrossingPoint: [0, 0],
    expectedCommandCount,
    expectedCubicCount,
    expectedOldPairs,
    expectedArea: 36,
  }));
}

/** Returns the exact four W source/rule rows in protocol order. */
export function fixedNativeMixedCubicFixtureRows(): readonly NativeMixedCubicFixtureRow[] {
  const n = nonlinearN();
  const bowtie = [lineAdapter(B[0], B[1]), ...n.slice(1)];
  const zeroClosure = [
    lineAdapter(B[1], B[1]),
    ...n.slice(1).map((cubic, index) => (index === 3 ? lineAdapter(cubic[0], cubic[3]) : cubic)),
  ];
  return [
    ...fixtureRows(
      'mixed/bowtie',
      bowtie,
      [true, false, false, false, false, false, false, false],
      [true, false, false, false, false, false, false, false],
      B,
      [{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }],
      10,
      7,
      4,
    ),
    ...fixtureRows(
      'mixed/zero-closure',
      zeroClosure,
      [true, false, false, false, true, false, false, false],
      [false, false, false, true, false, false, false],
      R,
      [{ leftLeaf: 3, rightLeaf: 7, orientation: 1 }],
      9,
      6,
      22,
    ),
  ];
}

function encodeRow(row: NativeMixedCubicFixtureRow): string {
  if (!ID.test(row.id)) throw new Error(`fixture id ${row.id} is not protocol-safe`);
  const sourceCount = row.sourceBits.reduce((sum, contour) => sum + contour.length, 0);
  if (row.sourceKinds.length !== sourceCount)
    throw new Error(`${row.id} kind count differs from original source count`);
  const mask = row.sourceKinds.map((kind) => (kind ? '1' : '0')).join('');
  const contours = row.sourceBits.map((contour) =>
    contour.map((cubic) => cubic.join(',')).join(';'),
  );
  return `${row.id} ${row.rule} ${row.expectation} ${mask} | ${contours.join(' | ')}`;
}

/** Encodes the strict exact-four mixed native cubic protocol. */
export function encodeNativeMixedCubicFixture(rows: readonly NativeMixedCubicFixtureRow[]): string {
  if (rows.length !== 4)
    throw new Error(`expected 4 native mixed cubic rows, received ${rows.length}`);
  const text = ['# p3-native-mixed-cubic-v1', '# rows 4', ...rows.map(encodeRow), ''].join('\n');
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024)
    throw new Error('native mixed cubic fixture exceeds the 512 KiB protocol ceiling');
  return text;
}
