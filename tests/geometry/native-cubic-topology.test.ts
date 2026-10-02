import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Point } from '../../packages/geometry-reference/src/types.js';
import {
  encodeNativeTopologyFixture,
  fixedNativeTopologyFixtureRows,
  type NativeTopologyFixtureRow,
} from './native-topology/fixtures.js';
import {
  parseNativeTopologyRow,
  parseNativeTopologyValue,
  type NativeTopologyOutput,
  type NativeTopologyRange,
  type NativeTopologyRow,
} from './native-topology/native.js';
import { bitsOf } from './rounded-fill/exact.js';
import { fixedSimpleCubicTopologyFixtures } from './simple-cubic-topology/fixtures.js';
import { certifySimpleCubicTopology } from './simple-cubic-topology/oracle.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeTopologyFixtureRows();
const certifiedFixtures = fixtureRows.filter(({ expectation }) => expectation === 'Certified');
const unresolvedFixtures = fixtureRows.filter(({ expectation }) => expectation === 'Unresolved');

function pointBits([x, y]: Point): readonly [bigint, bigint] {
  return [bitsOf(x), bitsOf(y)];
}

function polygonBits(
  polygons: readonly (readonly Point[])[],
): readonly (readonly (readonly [bigint, bigint])[])[] {
  return polygons.map((polygon) => polygon.map(pointBits));
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

function assertIdentity(fixture: NativeTopologyFixtureRow, row: NativeTopologyRow): void {
  if (row.id !== fixture.id) throw new Error('row identity mismatch');
  if (JSON.stringify(row.input_tokens) !== JSON.stringify(fixture.inputTokens))
    throw new Error('parsed source/control/provenance echo mismatch');
}

function assertOutput(
  fixture: NativeTopologyFixtureRow,
  actual: NativeTopologyOutput | null,
): void {
  if (actual === null || fixture.orientations === null || fixture.winding === null)
    throw new Error('certified output missing');
  const oracle = certifySimpleCubicTopology(fixture.contours);
  if (!oracle.ok || oracle.certificate === null)
    throw new Error(`independent oracle rejected ${fixture.id}: ${oracle.status}`);

  const original = fixedSimpleFixture(fixture.id);
  if (original === undefined) throw new Error(`original fixture ${fixture.id} missing`);
  if (polygonBitStrings(oracle.certificate.polygons) !== polygonBitStrings(original))
    throw new Error('oracle polygon ownership mismatch');
  if (JSON.stringify(oracle.certificate.orientations) !== JSON.stringify(fixture.orientations))
    throw new Error('oracle literal orientation mismatch');
  if (JSON.stringify(oracle.certificate.winding) !== JSON.stringify(fixture.winding))
    throw new Error('oracle literal winding mismatch');
  if (polygonBitStrings([actual.points]) !== polygonBitStrings([original.flat()]))
    throw new Error('owned polygon point bits mismatch');
  if (JSON.stringify(actual.contours) !== JSON.stringify(expectedRanges(original)))
    throw new Error('owned polygon ranges mismatch');
  if (JSON.stringify(actual.orientations) !== JSON.stringify(fixture.orientations))
    throw new Error('orientation mismatch');
  if (JSON.stringify(actual.winding) !== JSON.stringify(paddedWinding(fixture.winding)))
    throw new Error('winding mismatch');
}

const originalFixtures = new Map(
  fixedSimpleCubicTopologyFixtures().map(
    (fixture) => [fixture.id, fixture.expected.polygons] as const,
  ),
);

function fixedSimpleFixture(id: string): readonly (readonly Point[])[] | undefined {
  return originalFixtures.get(id);
}

function captureRows(): readonly NativeTopologyRow[] {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const tools = path.join(root, '.tools');
  mkdirSync(tools, { recursive: true });
  const directory = mkdtempSync(path.join(tools, 'p3-native-topology-'));
  const input = path.join(directory, 'input.txt');
  writeFileSync(input, encodeNativeTopologyFixture(fixtureRows), { encoding: 'utf8', flag: 'wx' });
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
      'simple_cubic_topology_tests::emit_simple_cubic_topology',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_NATIVE_TOPOLOGY_INPUT: input },
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.match(/P3_NATIVE_TOPOLOGY_BEGIN/gu)).toHaveLength(1);
  expect(result.stdout.match(/P3_NATIVE_TOPOLOGY_END/gu)).toHaveLength(1);
  const frame = /P3_NATIVE_TOPOLOGY_BEGIN\r?\n([\s\S]*?)\r?\nP3_NATIVE_TOPOLOGY_END/u.exec(
    result.stdout,
  );
  if (!frame) throw new Error('native topology frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  expect(lines).toHaveLength(54);
  return lines.map(parseNativeTopologyRow);
}

let nativeRows: readonly NativeTopologyRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2g native simple cubic topology certificate', () => {
  it('freezes the reviewed 47+7 source transport without result labels', () => {
    expect(fixtureRows).toHaveLength(54);
    expect(certifiedFixtures).toHaveLength(47);
    expect(unresolvedFixtures).toHaveLength(7);
    expect(new Set(fixtureRows.map(({ id }) => id)).size).toBe(54);
    expect(
      encodeNativeTopologyFixture(fixtureRows).startsWith('# p3-native-topology-v1\n# rows 54\n'),
    ).toBe(true);
    expect(fixtureRows.every(({ inputTokens }) => !inputTokens.includes('Certified'))).toBe(true);
    expect(fixtureRows.every(({ inputTokens }) => !inputTokens.includes('Unresolved'))).toBe(true);
  });

  it.each(certifiedFixtures)(
    '$id preserves its independent owned topology certificate',
    (fixture) => {
      const row = nativeRows[fixtureRows.indexOf(fixture)]!;
      assertIdentity(fixture, row);
      expect(row.status).toBe('Certified');
      const oracle = certifySimpleCubicTopology(fixture.contours);
      expect(oracle.status).toBe('CERTIFIED');
      expect(row.leaves).toBe(oracle.leaves);
      expect(row.pairs).toBe(oracle.pairs);
      assertOutput(fixture, row.output);
      expect(row.allocations).toBe(0);
    },
  );

  it.each(unresolvedFixtures)('$id preserves its prescribed unresolved rejection', (fixture) => {
    const row = nativeRows[fixtureRows.indexOf(fixture)]!;
    assertIdentity(fixture, row);
    const oracle = certifySimpleCubicTopology(fixture.contours);
    expect(oracle.status).toBe('UNRESOLVED');
    expect(row.status).toBe('Unresolved');
    expect(row.leaves).toBe(oracle.leaves);
    expect(row.pairs).toBe(oracle.pairs);
    expect(row.output).toBeNull();
    expect(row.allocations).toBe(0);
  });

  it('keeps the fixed workspace allocation-free with stable bounded storage', () => {
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

  it('preserves reviewed signed-zero point ownership bit for bit', () => {
    const fixture = certifiedFixtures.find(({ id }) => id === 'C01/reflect')!;
    const row = nativeRows[fixtureRows.indexOf(fixture)]!;
    if (row.output === null) throw new Error('reflected output missing');
    const expected = fixedSimpleFixture(fixture.id)!;
    expect(
      polygonBits(expected)
        .flat()
        .some(([x, y]) => x === 0x8000000000000000n || y === 0x8000000000000000n),
    ).toBe(true);
    expect(polygonBits([row.output.points])).toEqual(polygonBits([expected.flat()]));
  });

  it('strictly rejects malformed outer rows and invalid fixed output shape', () => {
    const success = nativeRows.find(({ status }) => status === 'Certified')!;
    expect(() => parseNativeTopologyValue({ ...success, extra: 1 }, 0)).toThrow('keys mismatch');
    expect(() => parseNativeTopologyValue({ ...success, input_tokens: ['bad token'] }, 0)).toThrow(
      'noncanonical token',
    );
    expect(() => parseNativeTopologyValue({ ...success, leaves: 65 }, 0)).toThrow('fixed limits');
    expect(() =>
      parseNativeTopologyValue(
        {
          ...success,
          output: {
            ...success.output!,
            winding: success.output!.winding.map((row, index) =>
              row.map((cell, column) => (index === 0 && column === 0 ? 1 : cell)),
            ),
          },
        },
        0,
      ),
    ).toThrow('diagonal');
  });

  it('rejects corrupted actual identity, parsed source, provenance, and owned polygons', () => {
    const fixture = certifiedFixtures.find(({ id }) => id === 'C02/identity')!;
    const row = nativeRows[fixtureRows.indexOf(fixture)]!;
    if (row.output === null) throw new Error('C02 output missing');
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
    const reordered = [...output.points];
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    expect(() => assertOutput(fixture, { ...output, points: reordered })).toThrow('point bits');
    expect(() =>
      assertOutput(fixture, { ...output, contours: [...output.contours].reverse() }),
    ).toThrow('ranges');
    expect(() =>
      assertOutput(fixture, {
        ...output,
        orientations: output.orientations.map((value) => -value as -1 | 1),
      }),
    ).toThrow('orientation');
    const wrongWinding = output.winding.map((windingRow) => [...windingRow]);
    wrongWinding[1]![0] = wrongWinding[1]![0] === 0 ? 1 : 0;
    expect(() => assertOutput(fixture, { ...output, winding: wrongWinding })).toThrow('winding');
  });

  it('rejects a failure row carrying stale successful publication', () => {
    const failure = nativeRows.find(({ status }) => status === 'Unresolved')!;
    const success = nativeRows.find(({ status }) => status === 'Certified')!;
    expect(() => parseNativeTopologyValue({ ...failure, output: success.output }, 0)).toThrow(
      'output/status mismatch',
    );
  });
});
