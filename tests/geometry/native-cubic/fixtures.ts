import type { Cubic } from '../../../packages/geometry-reference/src/types.js';
import { bitsOf } from '../rounded-fill/exact.js';
import { fixedSimpleCubicTopologyFixtures } from '../simple-cubic-topology/fixtures.js';

export type NativeCubicRule = 'nonzero' | 'evenodd';
export type NativeCubicExpectation = 'OK' | 'PATH_NUMERIC_RANGE';

export type NativeCubicSourceContour = Readonly<{
  cubics: readonly Cubic[];
  moveVerbOrdinal: number;
  cubicVerbOrdinals: readonly number[];
  closeVerbOrdinal: number | null;
}>;

export type NativeCubicFixtureRow = Readonly<{
  id: string;
  rule: NativeCubicRule;
  expectation: NativeCubicExpectation;
  contours: readonly NativeCubicSourceContour[];
  sourceBits: readonly (readonly (readonly string[])[])[];
  orientations: readonly (-1 | 1)[];
  winding: readonly (readonly (-1 | 0 | 1)[])[];
}>;

const RULES = ['nonzero', 'evenodd'] as const;
const ID = /^[A-Za-z0-9/-]+$/u;

function samePoint(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function hex(value: number): string {
  return bitsOf(value).toString(16).padStart(16, '0');
}

function cubicBits(cubic: Cubic): readonly string[] {
  return cubic.flatMap(([x, y]) => [hex(x), hex(y)]);
}

function sourceContours(
  contours: readonly (readonly Cubic[])[],
): readonly NativeCubicSourceContour[] {
  let verbOrdinal = 0;
  return contours.map((cubics) => {
    const moveVerbOrdinal = verbOrdinal;
    verbOrdinal += 1;
    const cubicVerbOrdinals = cubics.map(() => {
      const ordinal = verbOrdinal;
      verbOrdinal += 1;
      return ordinal;
    });
    const first = cubics[0]!.at(0)!;
    const last = cubics.at(-1)!.at(-1)!;
    const closeVerbOrdinal = samePoint(first, last) ? verbOrdinal++ : null;
    return { cubics, moveVerbOrdinal, cubicVerbOrdinals, closeVerbOrdinal };
  });
}

/** Builds the frozen 94-row native bridge source without consulting native or oracle output. */
export function fixedNativeCubicFixtureRows(): readonly NativeCubicFixtureRow[] {
  const fixtures = fixedSimpleCubicTopologyFixtures();
  if (fixtures.length !== 47)
    throw new Error(`expected 47 topology fixtures, received ${fixtures.length}`);
  return fixtures.flatMap((fixture) => {
    const cubics = fixture.contours.map((contour) => contour.map(({ cubic }) => cubic));
    const contours = sourceContours(cubics);
    const sourceBits = cubics.map((contour) => contour.map(cubicBits));
    const expectation: NativeCubicExpectation =
      fixture.id === 'extreme/large-square' ? 'PATH_NUMERIC_RANGE' : 'OK';
    return RULES.map((rule) => ({
      id: fixture.id,
      rule,
      expectation,
      contours,
      sourceBits,
      orientations: fixture.expected.orientations,
      winding: fixture.expected.winding,
    }));
  });
}

function encodeRow(row: NativeCubicFixtureRow): string {
  if (!ID.test(row.id)) throw new Error(`fixture id ${row.id} is not protocol-safe`);
  const contours = row.sourceBits.map((contour) =>
    contour.map((cubic) => cubic.join(',')).join(';'),
  );
  return `${row.id} ${row.rule} ${row.expectation} | ${contours.join(' | ')}`;
}

/** Encodes the reviewed bounded UTF-8 protocol consumed by the ignored native bridge test. */
export function encodeNativeCubicFixture(rows: readonly NativeCubicFixtureRow[]): string {
  if (rows.length !== 94) throw new Error(`expected 94 native cubic rows, received ${rows.length}`);
  const text = ['# p3-native-cubic-v1', '# rows 94', ...rows.map(encodeRow), ''].join('\n');
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024)
    throw new Error('native cubic fixture exceeds the 512 KiB protocol ceiling');
  return text;
}
