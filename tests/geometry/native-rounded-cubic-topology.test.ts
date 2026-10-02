import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Point } from '../../packages/geometry-reference/src/types.js';
import {
  encodeNativeRoundedTopologyFixture,
  fixedNativeRoundedTopologyFixtureRows,
  type NativeRoundedTopologyFixtureRow,
} from './native-rounded-topology/fixtures.js';
import {
  parseNativeTopologyRow,
  parseNativeTopologyValue,
  type NativeTopologyOutput,
  type NativeTopologyRange,
  type NativeTopologyRow,
} from './native-topology/native.js';
import { certifyCubicBoundary } from './cubic-boundary/oracle.js';
import { bitsOf } from './rounded-fill/exact.js';
import { certifyRoundedKnotCubicTopology } from './simple-cubic-topology/oracle.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeRoundedTopologyFixtureRows();
const certifiedFixtures = fixtureRows.filter(({ expectation }) => expectation === 'Certified');
const knotMismatchFixtures = fixtureRows.filter(
  ({ expectation }) => expectation === 'KnotMismatch',
);
const unresolvedFixtures = fixtureRows.filter(({ expectation }) => expectation === 'Unresolved');

function pointBits([x, y]: Point): readonly [bigint, bigint] {
  return [bitsOf(x), bitsOf(y)];
}

function polygonBitStrings(polygons: readonly (readonly Point[])[]): string {
  return JSON.stringify(
    polygons.map((polygon) =>
      polygon.map(([x, y]) => [bitsOf(x).toString(16), bitsOf(y).toString(16)]),
    ),
  );
}

function expectedRanges(polygons: readonly (readonly Point[])[]): readonly NativeTopologyRange[] {
  let start = 0;
  return polygons.map((polygon) => {
    const range = { start, count: polygon.length };
    start += polygon.length;
    return range;
  });
}

function paddedWinding(
  winding: readonly (readonly (-1 | 0 | 1)[])[],
): readonly (readonly (-1 | 0 | 1)[])[] {
  return winding.map((row) => [row[0] ?? 0, row[1] ?? 0, row[2] ?? 0, row[3] ?? 0]);
}

function assertIdentity(fixture: NativeRoundedTopologyFixtureRow, row: NativeTopologyRow): void {
  if (row.id !== fixture.id) throw new Error('rounded topology row identity mismatch');
  if (JSON.stringify(row.input_tokens) !== JSON.stringify(fixture.inputTokens))
    throw new Error('rounded topology source/control/provenance echo mismatch');
}

function assertOutput(
  fixture: NativeRoundedTopologyFixtureRow,
  actual: NativeTopologyOutput | null,
): void {
  if (
    actual === null ||
    fixture.polygons === null ||
    fixture.orientations === null ||
    fixture.winding === null
  )
    throw new Error('rounded topology certified output missing');
  const oracle = certifyRoundedKnotCubicTopology(fixture.contours);
  if (!oracle.ok || oracle.certificate === null)
    throw new Error(`independent rounded oracle rejected ${fixture.id}: ${oracle.status}`);
  if (polygonBitStrings(oracle.certificate.polygons) !== polygonBitStrings(fixture.polygons))
    throw new Error('rounded oracle polygon bits differ from literal fixture');
  if (JSON.stringify(oracle.certificate.orientations) !== JSON.stringify(fixture.orientations))
    throw new Error('rounded oracle orientation differs from literal fixture');
  if (JSON.stringify(oracle.certificate.winding) !== JSON.stringify(fixture.winding))
    throw new Error('rounded oracle winding differs from literal fixture');
  if (polygonBitStrings([actual.points]) !== polygonBitStrings([fixture.polygons.flat()]))
    throw new Error('rounded owned polygon point bits mismatch');
  if (JSON.stringify(actual.contours) !== JSON.stringify(expectedRanges(fixture.polygons)))
    throw new Error('rounded owned polygon ranges mismatch');
  if (JSON.stringify(actual.orientations) !== JSON.stringify(fixture.orientations))
    throw new Error('rounded orientation mismatch');
  if (JSON.stringify(actual.winding) !== JSON.stringify(paddedWinding(fixture.winding)))
    throw new Error('rounded winding mismatch');
}

function assertCarrier(fixture: NativeRoundedTopologyFixtureRow, row: NativeTopologyRow): void {
  assertIdentity(fixture, row);
  const oracle = certifyRoundedKnotCubicTopology(fixture.contours);
  let expectedStatus: NativeRoundedTopologyFixtureRow['expectation'];
  if (oracle.status === 'CERTIFIED') expectedStatus = 'Certified';
  else if (oracle.status === 'KNOT_MISMATCH') expectedStatus = 'KnotMismatch';
  else if (oracle.status === 'UNRESOLVED') expectedStatus = 'Unresolved';
  else throw new Error(`${fixture.id} independent oracle returned ${oracle.status}`);
  if (expectedStatus !== fixture.expectation || row.status !== fixture.expectation)
    throw new Error('rounded topology status mismatch');
  if (row.leaves !== oracle.leaves || row.pairs !== oracle.pairs)
    throw new Error('rounded topology counter mismatch');
  if (
    fixture.expectedCounters !== null &&
    (row.leaves !== fixture.expectedCounters.leaves || row.pairs !== fixture.expectedCounters.pairs)
  )
    throw new Error('rounded topology literal counter mismatch');
  if (fixture.expectation === 'Certified') assertOutput(fixture, row.output);
  else if (row.output !== null) throw new Error('rounded topology failure published output');
  if (row.allocations !== 0) throw new Error('rounded topology certify allocated');
}

function runEmitter(source: string, directoryPrefix: string) {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const tools = path.join(root, '.tools');
  mkdirSync(tools, { recursive: true });
  const directory = mkdtempSync(path.join(tools, directoryPrefix));
  const input = path.join(directory, 'input.txt');
  writeFileSync(input, source, { encoding: 'utf8', flag: 'wx' });
  const result = spawnSync(
    rustup,
    [
      'run',
      '1.94.1',
      'cargo',
      'test',
      '--release',
      '--manifest-path',
      manifest,
      '--locked',
      '--offline',
      '--lib',
      'rounded_cubic_topology_tests::emit_rounded_cubic_topology',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_NATIVE_ROUNDED_TOPOLOGY_INPUT: input },
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  writeFileSync(path.join(directory, 'stdout.txt'), result.stdout ?? '', {
    encoding: 'utf8',
    flag: 'wx',
  });
  writeFileSync(path.join(directory, 'stderr.txt'), result.stderr ?? '', {
    encoding: 'utf8',
    flag: 'wx',
  });
  return result;
}

function parseStrictFrame(stdout: string): readonly NativeTopologyRow[] {
  if ((stdout.match(/P3_NATIVE_ROUNDED_TOPOLOGY_BEGIN/gu) ?? []).length !== 1)
    throw new Error('native rounded topology begin marker count mismatch');
  if ((stdout.match(/P3_NATIVE_ROUNDED_TOPOLOGY_END/gu) ?? []).length !== 1)
    throw new Error('native rounded topology end marker count mismatch');
  const frame =
    /P3_NATIVE_ROUNDED_TOPOLOGY_BEGIN\r?\n([\s\S]*?)\r?\nP3_NATIVE_ROUNDED_TOPOLOGY_END/u.exec(
      stdout,
    );
  if (!frame) throw new Error('native rounded topology frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  if (lines.length !== 29) throw new Error('native rounded topology row count mismatch');
  return lines.map(parseNativeTopologyRow);
}

function captureRows(): readonly NativeTopologyRow[] {
  const result = runEmitter(
    encodeNativeRoundedTopologyFixture(fixtureRows),
    'p3-native-rounded-topology-',
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return parseStrictFrame(result.stdout);
}

let nativeRows: readonly NativeTopologyRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2n native rounded internal-knot topology certificate', () => {
  it('freezes the reviewed 11+8+2+7+1 source transport without result labels', () => {
    expect(fixtureRows).toHaveLength(29);
    expect(certifiedFixtures).toHaveLength(12);
    expect(knotMismatchFixtures).toHaveLength(2);
    expect(unresolvedFixtures).toHaveLength(15);
    expect(new Set(fixtureRows.map(({ id }) => id)).size).toBe(29);
    const encoded = encodeNativeRoundedTopologyFixture(fixtureRows);
    expect(encoded.startsWith('# p3-native-rounded-topology-v1\n# rows 29\n')).toBe(true);
    for (const label of ['Certified', 'KnotMismatch', 'Unresolved'])
      expect(fixtureRows.every(({ inputTokens }) => !inputTokens.includes(label))).toBe(true);
    expect(() => encodeNativeRoundedTopologyFixture(fixtureRows.slice(1))).toThrow('29');
    expect(() => encodeNativeRoundedTopologyFixture([...fixtureRows, fixtureRows[0]!])).toThrow(
      '29',
    );
  });

  it.each(fixtureRows)(
    '$id matches the independent rounded oracle and frozen carrier',
    (fixture) => {
      const row = nativeRows[fixtureRows.indexOf(fixture)]!;
      expect(() => assertCarrier(fixture, row)).not.toThrow();
    },
  );

  it('retains every positive P3.1d source proof and signed-zero positional compatibility', () => {
    const positives = fixtureRows.slice(0, 11);
    expect(positives.flatMap(({ contours }) => contours.flat())).toHaveLength(50);
    const signedZero = fixtureRows.at(-1)!;
    for (const fixture of [...positives, signedZero]) {
      for (const segment of fixture.contours.flat()) {
        expect(
          certifyCubicBoundary({
            cubic: segment.cubic,
            lines: segment.lines,
            screen: [1, 0, 0, 1],
            sourceVerbOrdinal: segment.sourceVerbOrdinal,
          }).status,
          `${fixture.id}:${segment.sourceVerbOrdinal}`,
        ).toBe('CERTIFIED');
      }
    }
  });

  it('keeps fixed retained storage stable and certify allocation-free', () => {
    expect(new Set(nativeRows.map(({ inline_bytes }) => inline_bytes)).size).toBe(1);
    expect(new Set(nativeRows.map(({ allocated_bytes }) => allocated_bytes)).size).toBe(1);
    expect(
      nativeRows.every(({ inline_bytes }) => inline_bytes > 0 && inline_bytes < 32 * 1024),
    ).toBe(true);
    expect(
      nativeRows.every(
        ({ allocated_bytes }) => allocated_bytes > 0 && allocated_bytes <= 1024 * 1024,
      ),
    ).toBe(true);
    expect(nativeRows.every(({ allocations }) => allocations === 0)).toBe(true);
  });

  it('preserves the carried signed-zero source endpoint bit in source echo and output', () => {
    const fixture = fixtureRows.find(({ id }) => id === 'signed-zero/carry')!;
    const row = nativeRows[fixtureRows.indexOf(fixture)]!;
    if (row.output === null) throw new Error('signed-zero rounded output missing');
    expect(fixture.inputTokens).toContain('8000000000000000');
    expect(pointBits(row.output.points[4]!)[1]).toBe(0x8000000000000000n);
    assertOutput(fixture, row.output);
  });

  it('strictly rejects malformed outer rows, labels, counters, and output-null shape', () => {
    const success = nativeRows.find(({ status }) => status === 'Certified')!;
    const failure = nativeRows.find(({ status }) => status === 'Unresolved')!;
    const missing = Object.fromEntries(Object.entries(success).filter(([key]) => key !== 'id'));
    expect(() => parseNativeTopologyValue(missing, 0)).toThrow('keys mismatch');
    expect(() => parseNativeTopologyValue({ ...success, extra: 1 }, 0)).toThrow('keys mismatch');
    expect(() => parseNativeTopologyValue({ ...success, status: 'Success' }, 0)).toThrow(
      'status invalid',
    );
    expect(() => parseNativeTopologyValue({ ...success, input_tokens: ['bad token'] }, 0)).toThrow(
      'noncanonical token',
    );
    expect(() => parseNativeTopologyValue({ ...success, leaves: 65 }, 0)).toThrow('fixed limits');
    expect(() => parseNativeTopologyValue({ ...success, pairs: 2017 }, 0)).toThrow('fixed limits');
    expect(() => parseNativeTopologyValue({ ...success, output: null }, 0)).toThrow(
      'output/status mismatch',
    );
    expect(() => parseNativeTopologyValue({ ...failure, output: success.output }, 0)).toThrow(
      'output/status mismatch',
    );
    const fixture = certifiedFixtures[0]!;
    expect(() =>
      assertCarrier(fixture, { ...success, status: 'Unresolved', output: null }),
    ).toThrow('status mismatch');
    expect(() => assertCarrier(fixture, { ...success, leaves: success.leaves + 1 })).toThrow(
      'counter mismatch',
    );
  });

  it('rejects wrong source protocol headers and declared row counts before geometry', () => {
    const source = encodeNativeRoundedTopologyFixture(fixtureRows);
    for (const [label, corrupted] of [
      [
        'header',
        source.replace('# p3-native-rounded-topology-v1', '# p3-native-rounded-topology-v0'),
      ],
      ['row-count', source.replace('# rows 29', '# rows 28')],
    ] as const) {
      const result = runEmitter(corrupted, `p3-native-rounded-topology-bad-${label}-`);
      if (result.error) throw result.error;
      const combined = result.stdout + result.stderr;
      expect(result.status, `${label}\n${combined}`).not.toBe(0);
      expect(combined, label).toContain(
        label === 'header' ? '# p3-native-rounded-topology-v0' : '# rows 28',
      );
      expect(combined, label).not.toContain('P3_NATIVE_ROUNDED_TOPOLOGY_BEGIN');
    }
  });

  it('rejects missing, extra, and incorrectly marked output frames', () => {
    const lines = nativeRows.map((row) => JSON.stringify(row));
    const frame = (body: readonly string[]) =>
      `P3_NATIVE_ROUNDED_TOPOLOGY_BEGIN\n${body.join('\n')}\nP3_NATIVE_ROUNDED_TOPOLOGY_END`;
    expect(() => parseStrictFrame(frame(lines.slice(1)))).toThrow('row count');
    expect(() => parseStrictFrame(frame([...lines, lines[0]!]))).toThrow('row count');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_ROUNDED_TOPOLOGY_BEGIN', 'WRONG_BEGIN')),
    ).toThrow('begin marker');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_ROUNDED_TOPOLOGY_END', 'WRONG_END')),
    ).toThrow('end marker');
  });

  it('rejects corrupted identity, source bits, provenance, and owned certificate fields', () => {
    const fixture = certifiedFixtures.find(({ id }) => id === 'rounded/identity')!;
    const row = nativeRows[fixtureRows.indexOf(fixture)]!;
    if (row.output === null) throw new Error('rounded identity output missing');
    const output = row.output;
    expect(() => assertIdentity(fixture, { ...row, id: 'stale' })).toThrow('identity');

    const wrongSource = [...row.input_tokens];
    const cubic = wrongSource.indexOf('cubic');
    wrongSource[cubic + 1] = '999';
    expect(() => assertIdentity(fixture, { ...row, input_tokens: wrongSource })).toThrow(
      'source/control/provenance',
    );
    const wrongCoordinate = [...row.input_tokens];
    wrongCoordinate[cubic + 2] =
      wrongCoordinate[cubic + 2] === '0000000000000000' ? '8000000000000000' : '0000000000000000';
    expect(() => assertIdentity(fixture, { ...row, input_tokens: wrongCoordinate })).toThrow(
      'source/control/provenance',
    );
    const wrongProvenance = [...row.input_tokens];
    const leaf = wrongProvenance.indexOf('leaf');
    wrongProvenance[leaf + 2] = '0';
    expect(() => assertIdentity(fixture, { ...row, input_tokens: wrongProvenance })).toThrow(
      'source/control/provenance',
    );

    expect(() => assertOutput(fixture, { ...output, points: output.points.slice(1) })).toThrow(
      'point bits',
    );
    const changedPoint = output.points.map((point, index) =>
      index === 0 ? ([point[0], -point[1]] as const) : point,
    );
    expect(() => assertOutput(fixture, { ...output, points: changedPoint })).toThrow('point bits');
    expect(() =>
      assertOutput(fixture, {
        ...output,
        contours: [{ ...output.contours[0]!, start: 1 }, ...output.contours.slice(1)],
      }),
    ).toThrow('ranges');
    expect(() =>
      assertOutput(fixture, {
        ...output,
        orientations: output.orientations.map((value) => -value as -1 | 1),
      }),
    ).toThrow('orientation');
    const wrongWinding = output.winding.map((windingRow) => [...windingRow]);
    wrongWinding[0]![1] = wrongWinding[0]![1] === 0 ? 1 : 0;
    expect(() => assertOutput(fixture, { ...output, winding: wrongWinding })).toThrow('winding');
  });
});
