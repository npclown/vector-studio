import { bitsOf } from '../rounded-fill/exact.js';
import {
  fixedSimpleCubicTopologyFixtures,
  simpleCubicTopologyRejectingControls,
  type CubicTopologySegmentFixture,
} from '../simple-cubic-topology/fixtures.js';

export type NativeTopologyExpectation = 'Certified' | 'Unresolved';

export type NativeTopologyFixtureRow = Readonly<{
  id: string;
  contours: readonly (readonly CubicTopologySegmentFixture[])[];
  expectation: NativeTopologyExpectation;
  orientations: readonly (-1 | 1)[] | null;
  winding: readonly (readonly (-1 | 0 | 1)[])[] | null;
  inputTokens: readonly string[];
}>;

const ID = /^[A-Za-z0-9/-]+$/u;

function hex(value: number): string {
  return bitsOf(value).toString(16).padStart(16, '0');
}

function unsigned(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be unsigned`);
  return String(value);
}

export function topologyInputTokens(
  id: string,
  contours: readonly (readonly CubicTopologySegmentFixture[])[],
): readonly string[] {
  if (!ID.test(id)) throw new Error(`fixture id ${id} is not protocol-safe`);
  const result = ['row', id, unsigned(contours.length, 'contour count')];
  contours.forEach((contour, contourIndex) => {
    result.push('contour', unsigned(contour.length, `contour ${contourIndex} cubic count`));
    contour.forEach((segment, segmentIndex) => {
      result.push(
        'cubic',
        unsigned(segment.sourceVerbOrdinal, `contour ${contourIndex} cubic ${segmentIndex} source`),
        ...segment.cubic.flatMap(([x, y]) => [hex(x), hex(y)]),
        unsigned(segment.lines.length, `contour ${contourIndex} cubic ${segmentIndex} leaf count`),
      );
      segment.lines.forEach((line, leafIndex) => {
        result.push(
          'leaf',
          unsigned(
            line.provenance.sourceVerbOrdinal,
            `contour ${contourIndex} cubic ${segmentIndex} leaf ${leafIndex} source`,
          ),
          unsigned(
            line.provenance.endNumerator,
            `contour ${contourIndex} cubic ${segmentIndex} leaf ${leafIndex} numerator`,
          ),
          unsigned(
            line.provenance.depth,
            `contour ${contourIndex} cubic ${segmentIndex} leaf ${leafIndex} depth`,
          ),
          hex(line.end[0]),
          hex(line.end[1]),
        );
      });
    });
  });
  result.push('end');
  return result;
}

/** Builds the frozen 47-success plus seven-Unresolved transported corpus. */
export function fixedNativeTopologyFixtureRows(): readonly NativeTopologyFixtureRow[] {
  const successes = fixedSimpleCubicTopologyFixtures();
  const rejections = simpleCubicTopologyRejectingControls();
  if (successes.length !== 47 || rejections.length !== 7)
    throw new Error(
      `expected 47+7 topology fixtures, received ${successes.length}+${rejections.length}`,
    );
  return [
    ...successes.map((fixture) => ({
      id: fixture.id,
      contours: fixture.contours,
      expectation: 'Certified' as const,
      orientations: fixture.expected.orientations,
      winding: fixture.expected.winding,
      inputTokens: topologyInputTokens(fixture.id, fixture.contours),
    })),
    ...rejections.map((fixture) => ({
      id: fixture.id,
      contours: fixture.contours,
      expectation: 'Unresolved' as const,
      orientations: null,
      winding: null,
      inputTokens: topologyInputTokens(fixture.id, fixture.contours),
    })),
  ];
}

export function encodeTopologyTokens(row: Readonly<{ inputTokens: readonly string[] }>): string {
  const lines: string[] = [];
  let index = 0;
  lines.push(row.inputTokens.slice(index, 3).join(' '));
  index += 3;
  while (index < row.inputTokens.length) {
    const tag = row.inputTokens[index];
    if (tag === 'end') {
      lines.push('end');
      index += 1;
    } else if (tag === 'contour') {
      lines.push(row.inputTokens.slice(index, index + 2).join(' '));
      index += 2;
    } else if (tag === 'cubic') {
      lines.push(row.inputTokens.slice(index, index + 11).join(' '));
      index += 11;
    } else if (tag === 'leaf') {
      lines.push(row.inputTokens.slice(index, index + 6).join(' '));
      index += 6;
    } else {
      throw new Error(`unexpected fixture token ${String(tag)}`);
    }
  }
  return lines.join('\n');
}

/** Encodes the strict bounded source protocol without expected result labels. */
export function encodeNativeTopologyFixture(rows: readonly NativeTopologyFixtureRow[]): string {
  if (rows.length !== 54)
    throw new Error(`expected 54 native topology rows, received ${rows.length}`);
  const text = ['# p3-native-topology-v1', '# rows 54', ...rows.map(encodeTopologyTokens), ''].join(
    '\n',
  );
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024)
    throw new Error('native topology fixture exceeds the 512 KiB protocol ceiling');
  return text;
}
