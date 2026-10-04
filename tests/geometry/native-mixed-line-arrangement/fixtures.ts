import type { Point } from '../../../packages/geometry-reference/src/types.js';
import {
  fixedMixedLineArrangementFixtures,
  type MixedLineArrangementFixture,
} from '../mixed-line-arrangement/fixtures.js';
import {
  fixedNativeTransverseArrangementFixtureRows,
  type NativeTransverseArrangementExpectation,
} from '../native-transverse-arrangement/fixtures.js';
import type { CubicTopologySegmentFixture } from '../simple-cubic-topology/fixtures.js';
import type { TransverseArrangementCrossingFixture } from '../transverse-arrangement/fixtures.js';
import { encodeTopologyTokens, topologyInputTokens } from '../native-topology/fixtures.js';

export type NativeMixedLineArrangementFixtureRow = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  sourceKinds: readonly boolean[];
  expectation: NativeTransverseArrangementExpectation;
  expectedCounters: Readonly<{ leaves: number; pairs: number }>;
  polygons: readonly (readonly Point[])[] | null;
  crossings: readonly TransverseArrangementCrossingFixture[] | null;
  inputTokens: readonly string[];
}>;

function sourceCount(contours: readonly (readonly CubicTopologySegmentFixture[])[]): number {
  return contours.reduce((count, contour) => count + contour.length, 0);
}

function tokensWithKinds(
  id: string,
  contours: readonly (readonly CubicTopologySegmentFixture[])[],
  sourceKinds: readonly boolean[],
): readonly string[] {
  const count = sourceCount(contours);
  if (sourceKinds.length !== count)
    throw new Error(`${id} source-kind count ${sourceKinds.length} differs from ${count} sources`);
  const tokens = topologyInputTokens(id, contours);
  if (tokens.at(-1) !== 'end') throw new Error(`${id} topology tokens lack the final end marker`);
  return [
    ...tokens.slice(0, -1),
    'kinds',
    String(count),
    ...sourceKinds.map((kind) => (kind ? '1' : '0')),
    'end',
  ];
}

function mixedRow(
  prefix: 'mixed' | 'cubic',
  fixture: MixedLineArrangementFixture,
): NativeMixedLineArrangementFixtureRow {
  const id = `${prefix}/${fixture.id}`;
  const sourceKinds =
    prefix === 'mixed'
      ? fixture.sourceKinds
      : Array.from({ length: sourceCount(fixture.contours) }, () => false);
  const certified = prefix === 'mixed';
  return {
    id,
    contours: fixture.contours,
    sourceKinds,
    expectation: certified ? 'Certified' : 'Unresolved',
    expectedCounters: certified
      ? { leaves: fixture.expected.leaves, pairs: fixture.expected.pairs }
      : fixture.allFalse,
    polygons: certified ? fixture.expected.polygons : null,
    crossings: certified ? fixture.expected.crossings : null,
    inputTokens: tokensWithKinds(id, fixture.contours, sourceKinds),
  };
}

/** Returns the frozen 7 mixed + 7 all-cubic + 39 legacy carrier in protocol order. */
export function fixedNativeMixedLineArrangementFixtureRows(): readonly NativeMixedLineArrangementFixtureRow[] {
  const mixed = fixedMixedLineArrangementFixtures();
  const legacy = fixedNativeTransverseArrangementFixtureRows();
  if (mixed.length !== 7 || legacy.length !== 39)
    throw new Error(
      `expected 7+39 mixed/legacy fixtures, received ${mixed.length}+${legacy.length}`,
    );
  return [
    ...mixed.map((fixture) => mixedRow('mixed', fixture)),
    ...mixed.map((fixture) => mixedRow('cubic', fixture)),
    ...legacy.map((fixture) => {
      const id = `legacy/${fixture.id}`;
      const sourceKinds = Array.from({ length: sourceCount(fixture.contours) }, () => false);
      return {
        id,
        contours: fixture.contours,
        sourceKinds,
        expectation: fixture.expectation,
        expectedCounters: fixture.expectedCounters,
        polygons: fixture.polygons,
        crossings: fixture.crossings,
        inputTokens: tokensWithKinds(id, fixture.contours, sourceKinds),
      };
    }),
  ];
}

/** Encodes exactly the frozen 53-row source protocol without expected labels. */
export function encodeNativeMixedLineArrangementFixture(
  rows: readonly NativeMixedLineArrangementFixtureRow[],
): string {
  if (rows.length !== 53)
    throw new Error(`expected 53 native mixed-line arrangement rows, received ${rows.length}`);
  const text = [
    '# p3-native-mixed-line-arrangement-v1',
    '# rows 53',
    ...rows.map((fixture) => encodeTopologyTokens({ inputTokens: fixture.inputTokens })),
    '',
  ].join('\n');
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024)
    throw new Error('native mixed-line arrangement fixture exceeds the 512 KiB protocol ceiling');
  return text;
}
