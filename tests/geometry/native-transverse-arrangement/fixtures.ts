import type { Point } from '../../../packages/geometry-reference/src/types.js';
import {
  fixedRoundedKnotTopologyFixtures,
  roundedKnotMinimumLeafControls,
  roundedKnotTopologyControls,
} from '../rounded-knot-topology/fixtures.js';
import type { CubicTopologySegmentFixture } from '../simple-cubic-topology/fixtures.js';
import {
  fixedTransverseArrangementFixtures,
  transverseArrangementControls,
  type TransverseArrangementCrossingFixture,
} from '../transverse-arrangement/fixtures.js';
import { encodeTopologyTokens, topologyInputTokens } from '../native-topology/fixtures.js';
import { signedZeroCarrier } from '../native-rounded-topology/fixtures.js';

export type NativeTransverseArrangementExpectation = 'Certified' | 'KnotMismatch' | 'Unresolved';

export type NativeTransverseArrangementFixtureRow = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  expectation: NativeTransverseArrangementExpectation;
  expectedCounters: Readonly<{ leaves: number; pairs: number }>;
  polygons: readonly (readonly Point[])[] | null;
  crossings: readonly TransverseArrangementCrossingFixture[] | null;
  inputTokens: readonly string[];
}>;

function row(
  id: string,
  contours: readonly (readonly CubicTopologySegmentFixture[])[],
  expectation: NativeTransverseArrangementExpectation,
  expectedCounters: NativeTransverseArrangementFixtureRow['expectedCounters'],
  certificate?: Readonly<{
    polygons: readonly (readonly Point[])[];
    crossings: readonly TransverseArrangementCrossingFixture[];
  }>,
): NativeTransverseArrangementFixtureRow {
  return {
    id,
    contours,
    expectation,
    expectedCounters,
    polygons: certificate?.polygons ?? null,
    crossings: certificate?.crossings ?? null,
    inputTokens: topologyInputTokens(id, contours),
  };
}

/** Returns the frozen 39-row native transverse-arrangement carrier in protocol order. */
export function fixedNativeTransverseArrangementFixtureRows(): readonly NativeTransverseArrangementFixtureRow[] {
  const transverse = fixedTransverseArrangementFixtures();
  const rounded = fixedRoundedKnotTopologyFixtures();
  const transverseControls = transverseArrangementControls();
  const roundedControls = roundedKnotTopologyControls();
  const minimum = roundedKnotMinimumLeafControls();
  if (
    transverse.length !== 12 ||
    rounded.length !== 11 ||
    transverseControls.length !== 5 ||
    roundedControls.length !== 8 ||
    minimum.length !== 2
  )
    throw new Error(
      `expected 12+11+5+8+2 transverse arrangement fixtures, received ${transverse.length}+${rounded.length}+${transverseControls.length}+${roundedControls.length}+${minimum.length}`,
    );
  const signedZero = signedZeroCarrier();
  return [
    ...transverse.map((fixture) =>
      row(
        fixture.id,
        fixture.contours,
        'Certified',
        { leaves: fixture.expected.leaves, pairs: fixture.expected.pairs },
        { polygons: fixture.expected.polygons, crossings: fixture.expected.crossings },
      ),
    ),
    ...rounded.map((fixture) => {
      const leaves = fixture.expected.polygons.reduce((sum, polygon) => sum + polygon.length, 0);
      return row(
        fixture.id,
        fixture.contours,
        'Certified',
        { leaves, pairs: (leaves * (leaves - 1)) / 2 },
        { polygons: fixture.expected.polygons, crossings: [] },
      );
    }),
    ...transverseControls.map((control) =>
      row(`control/${control.id}`, control.contours, 'Unresolved', {
        leaves: control.leaves,
        pairs: control.pairs,
      }),
    ),
    ...roundedControls.map((control) =>
      row(
        `control/${control.id}`,
        control.contours,
        control.status === 'KNOT_MISMATCH' ? 'KnotMismatch' : 'Unresolved',
        { leaves: control.leaves, pairs: control.pairs },
      ),
    ),
    ...minimum.map((control) =>
      row(`minimum/${control.id}`, control.contours, 'Unresolved', {
        leaves: control.leaves,
        pairs: control.pairs,
      }),
    ),
    row(
      'signed-zero/carry',
      signedZero.contours,
      'Certified',
      { leaves: 12, pairs: 66 },
      { polygons: signedZero.polygons, crossings: [] },
    ),
  ];
}

/** Encodes exactly the frozen 39-row source protocol without expected labels. */
export function encodeNativeTransverseArrangementFixture(
  rows: readonly NativeTransverseArrangementFixtureRow[],
): string {
  if (rows.length !== 39)
    throw new Error(`expected 39 native transverse arrangement rows, received ${rows.length}`);
  const text = [
    '# p3-native-transverse-arrangement-v1',
    '# rows 39',
    ...rows.map((fixture) => encodeTopologyTokens({ inputTokens: fixture.inputTokens })),
    '',
  ].join('\n');
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024)
    throw new Error('native transverse arrangement fixture exceeds the 512 KiB protocol ceiling');
  return text;
}
