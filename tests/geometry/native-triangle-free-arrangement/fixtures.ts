import {
  fixedNativeMixedLineArrangementFixtureRows,
  type NativeMixedLineArrangementFixtureRow,
} from '../native-mixed-line-arrangement/fixtures.js';
import { encodeTopologyTokens, topologyInputTokensWithKinds } from '../native-topology/fixtures.js';
import {
  fixedTriangleFreeArrangementFixtures,
  triangleFreeArrangementControls,
} from '../triangle-free-arrangement/fixtures.js';

export type NativeTriangleFreeArrangementFixtureRow = Readonly<
  Omit<NativeMixedLineArrangementFixtureRow, 'expectation'> & {
    expectation: 'Certified' | 'Unresolved' | 'WorkLimit';
  }
>;

function controlExpectation(status: string): 'Unresolved' | 'WorkLimit' {
  if (status === 'UNRESOLVED') return 'Unresolved';
  if (status === 'WORK_LIMIT') return 'WorkLimit';
  throw new Error(`unexpected triangle-free control status ${status}`);
}

/** Returns the frozen 8 positive + 3 control + 31 inherited carrier. */
export function fixedNativeTriangleFreeArrangementFixtureRows(): readonly NativeTriangleFreeArrangementFixtureRow[] {
  const positives = fixedTriangleFreeArrangementFixtures();
  const controls = triangleFreeArrangementControls();
  const inherited = fixedNativeMixedLineArrangementFixtureRows().filter(
    (row) => row.expectation === 'Certified',
  );
  if (positives.length !== 8 || controls.length !== 3 || inherited.length !== 31)
    throw new Error(
      `expected 8+3+31 triangle-free fixtures, received ${positives.length}+${controls.length}+${inherited.length}`,
    );
  return [
    ...positives.map((fixture) => {
      const id = `new/${fixture.id}`;
      return {
        id,
        contours: fixture.contours,
        sourceKinds: fixture.sourceKinds,
        expectation: 'Certified' as const,
        expectedCounters: { leaves: fixture.expected.leaves, pairs: fixture.expected.pairs },
        polygons: fixture.expected.polygons,
        crossings: fixture.expected.crossings,
        inputTokens: topologyInputTokensWithKinds(id, fixture.contours, fixture.sourceKinds),
      };
    }),
    ...controls.map((control) => {
      const id = `new/${control.id}`;
      return {
        id,
        contours: control.contours,
        sourceKinds: control.sourceKinds,
        expectation: controlExpectation(control.status),
        expectedCounters: { leaves: control.leaves, pairs: control.pairs },
        polygons: null,
        crossings: null,
        inputTokens: topologyInputTokensWithKinds(id, control.contours, control.sourceKinds),
      };
    }),
    ...inherited.map((row) => ({ ...row, expectation: 'Certified' as const })),
  ];
}

/** Encodes exactly the frozen 42-row source protocol without result labels. */
export function encodeNativeTriangleFreeArrangementFixture(
  rows: readonly NativeTriangleFreeArrangementFixtureRow[],
): string {
  if (rows.length !== 42)
    throw new Error(`expected 42 native triangle-free arrangement rows, received ${rows.length}`);
  const text = [
    '# p3-native-triangle-free-arrangement-v1',
    '# rows 42',
    ...rows.map((row) => encodeTopologyTokens(row)),
    '',
  ].join('\n');
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024)
    throw new Error(
      'native triangle-free arrangement fixture exceeds the 512 KiB protocol ceiling',
    );
  return text;
}
