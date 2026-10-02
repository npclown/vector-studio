import type { Point } from '../../../packages/geometry-reference/src/types.js';
import {
  fixedRoundedKnotTopologyFixtures,
  roundedKnotMinimumLeafControls,
  roundedKnotTopologyControls,
} from '../rounded-knot-topology/fixtures.js';
import {
  simpleCubicTopologyRejectingControls,
  type CubicTopologySegmentFixture,
} from '../simple-cubic-topology/fixtures.js';
import { encodeTopologyTokens, topologyInputTokens } from '../native-topology/fixtures.js';

export type NativeRoundedTopologyExpectation = 'Certified' | 'KnotMismatch' | 'Unresolved';

export type NativeRoundedTopologyFixtureRow = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  expectation: NativeRoundedTopologyExpectation;
  expectedCounters: Readonly<{ leaves: number; pairs: number }> | null;
  polygons: readonly (readonly Point[])[] | null;
  orientations: readonly (-1 | 1)[] | null;
  winding: readonly (readonly (-1 | 0 | 1)[])[] | null;
  inputTokens: readonly string[];
}>;

function row(
  id: string,
  contours: readonly (readonly CubicTopologySegmentFixture[])[],
  expectation: NativeRoundedTopologyExpectation,
  expectedCounters: NativeRoundedTopologyFixtureRow['expectedCounters'],
  certificate?: Readonly<{
    polygons: readonly (readonly Point[])[];
    orientations: readonly (-1 | 1)[];
    winding: readonly (readonly (-1 | 0 | 1)[])[];
  }>,
): NativeRoundedTopologyFixtureRow {
  return {
    id,
    contours,
    expectation,
    expectedCounters,
    polygons: certificate?.polygons ?? null,
    orientations: certificate?.orientations ?? null,
    winding: certificate?.winding ?? null,
    inputTokens: topologyInputTokens(id, contours),
  };
}

function signedZeroCarrier(): Readonly<{
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  polygons: readonly (readonly Point[])[];
  orientations: readonly (-1 | 1)[];
  winding: readonly (readonly (-1 | 0 | 1)[])[];
}> {
  const base = fixedRoundedKnotTopologyFixtures().find(({ id }) => id === 'rounded/identity');
  if (base === undefined) throw new Error('rounded identity fixture missing');
  const contours = base.contours.map((contour, contourIndex) =>
    contourIndex === 0
      ? contour.map((segment, segmentIndex) =>
          segmentIndex === 0
            ? {
                ...segment,
                lines: [
                  ...segment.lines.slice(0, -1),
                  { ...segment.lines.at(-1)!, end: [3, -0] as const },
                ],
              }
            : segment,
        )
      : contour,
  );
  const polygons = base.expected.polygons.map((polygon, contourIndex) =>
    contourIndex === 0
      ? polygon.map((point, pointIndex) => (pointIndex === 4 ? ([3, -0] as const) : point))
      : polygon,
  );
  return {
    contours,
    polygons,
    orientations: base.expected.orientations,
    winding: base.expected.winding,
  };
}

/** Returns the frozen 29-row native rounded-knot carrier in protocol order. */
export function fixedNativeRoundedTopologyFixtureRows(): readonly NativeRoundedTopologyFixtureRow[] {
  const positives = fixedRoundedKnotTopologyFixtures();
  const controls = roundedKnotTopologyControls();
  const minimum = roundedKnotMinimumLeafControls();
  const legacy = simpleCubicTopologyRejectingControls();
  if (
    positives.length !== 11 ||
    controls.length !== 8 ||
    minimum.length !== 2 ||
    legacy.length !== 7
  )
    throw new Error(
      `expected 11+8+2+7 rounded topology fixtures, received ${positives.length}+${controls.length}+${minimum.length}+${legacy.length}`,
    );
  const signedZero = signedZeroCarrier();
  return [
    ...positives.map((fixture) =>
      row(
        fixture.id,
        fixture.contours,
        'Certified',
        {
          leaves: fixture.expected.polygons.reduce((sum, polygon) => sum + polygon.length, 0),
          pairs: (() => {
            const leaves = fixture.expected.polygons.reduce(
              (sum, polygon) => sum + polygon.length,
              0,
            );
            return (leaves * (leaves - 1)) / 2;
          })(),
        },
        fixture.expected,
      ),
    ),
    ...controls.map((control) =>
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
    ...legacy.map((control) => row(`legacy/${control.id}`, control.contours, 'Unresolved', null)),
    row(
      'signed-zero/carry',
      signedZero.contours,
      'Certified',
      { leaves: 12, pairs: 66 },
      signedZero,
    ),
  ];
}

/** Encodes exactly the frozen 29-row source protocol without expected labels. */
export function encodeNativeRoundedTopologyFixture(
  rows: readonly NativeRoundedTopologyFixtureRow[],
): string {
  if (rows.length !== 29)
    throw new Error(`expected 29 native rounded topology rows, received ${rows.length}`);
  const text = [
    '# p3-native-rounded-topology-v1',
    '# rows 29',
    ...rows.map((fixture) => encodeTopologyTokens({ inputTokens: fixture.inputTokens })),
    '',
  ].join('\n');
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024)
    throw new Error('native rounded topology fixture exceeds the 512 KiB protocol ceiling');
  return text;
}
