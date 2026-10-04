import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Point } from '../../packages/geometry-reference/src/types.js';
import {
  encodeNativeTransverseArrangementFixture,
  fixedNativeTransverseArrangementFixtureRows,
  type NativeTransverseArrangementFixtureRow,
} from './native-transverse-arrangement/fixtures.js';
import {
  parseNativeTransverseArrangementRow,
  parseNativeTransverseArrangementValue,
  type NativeTransverseArrangementOutput,
  type NativeTransverseArrangementRow,
} from './native-transverse-arrangement/native.js';
import type { NativeTopologyRange } from './native-topology/native.js';
import { bitsOf } from './rounded-fill/exact.js';
import { certifyTransverseCubicArrangement } from './simple-cubic-topology/oracle.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeTransverseArrangementFixtureRows();
const certifiedFixtures = fixtureRows.filter(({ expectation }) => expectation === 'Certified');
const knotMismatchFixtures = fixtureRows.filter(
  ({ expectation }) => expectation === 'KnotMismatch',
);
const unresolvedFixtures = fixtureRows.filter(({ expectation }) => expectation === 'Unresolved');

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

function signedAreaTwice(polygon: readonly Point[]): number {
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    area += current[0] * next[1] - current[1] * next[0];
  }
  return area;
}

function expectedCrossings(fixture: NativeTransverseArrangementFixtureRow) {
  if (fixture.crossings === null) throw new Error('literal arrangement crossings missing');
  return fixture.crossings.map(({ leftLeaf, rightLeaf, orientation }) => ({
    left_leaf: leftLeaf,
    right_leaf: rightLeaf,
    orientation,
  }));
}

function assertIdentity(
  fixture: NativeTransverseArrangementFixtureRow,
  row: NativeTransverseArrangementRow,
): void {
  if (row.id !== fixture.id) throw new Error('transverse arrangement row identity mismatch');
  if (JSON.stringify(row.input_tokens) !== JSON.stringify(fixture.inputTokens))
    throw new Error('transverse arrangement source/control/provenance echo mismatch');
}

function assertOutput(
  fixture: NativeTransverseArrangementFixtureRow,
  actual: NativeTransverseArrangementOutput | null,
): void {
  if (actual === null || fixture.polygons === null || fixture.crossings === null)
    throw new Error('transverse arrangement certified output missing');
  const oracle = certifyTransverseCubicArrangement(fixture.contours);
  if (!oracle.ok || oracle.certificate === null)
    throw new Error(`independent arrangement oracle rejected ${fixture.id}: ${oracle.status}`);
  if (polygonBitStrings(oracle.certificate.polygons) !== polygonBitStrings(fixture.polygons))
    throw new Error('arrangement oracle polygon bits differ from literal fixture');
  if (JSON.stringify(oracle.certificate.crossings) !== JSON.stringify(fixture.crossings))
    throw new Error('arrangement oracle crossings differ from literal fixture');
  if (polygonBitStrings([actual.points]) !== polygonBitStrings([fixture.polygons.flat()]))
    throw new Error('arrangement owned polygon point bits mismatch');
  if (JSON.stringify(actual.contours) !== JSON.stringify(expectedRanges(fixture.polygons)))
    throw new Error('arrangement owned polygon ranges mismatch');
  if (JSON.stringify(actual.crossings) !== JSON.stringify(expectedCrossings(fixture)))
    throw new Error('arrangement crossings mismatch');
}

function assertCarrier(
  fixture: NativeTransverseArrangementFixtureRow,
  row: NativeTransverseArrangementRow,
): void {
  assertIdentity(fixture, row);
  const oracle = certifyTransverseCubicArrangement(fixture.contours);
  const expectedStatus =
    oracle.status === 'CERTIFIED'
      ? 'Certified'
      : oracle.status === 'KNOT_MISMATCH'
        ? 'KnotMismatch'
        : oracle.status === 'UNRESOLVED'
          ? 'Unresolved'
          : null;
  if (expectedStatus === null) throw new Error(`${fixture.id} oracle returned ${oracle.status}`);
  if (expectedStatus !== fixture.expectation || row.status !== fixture.expectation)
    throw new Error('transverse arrangement status mismatch');
  if (row.leaves !== oracle.leaves || row.pairs !== oracle.pairs)
    throw new Error('transverse arrangement oracle counter mismatch');
  if (
    row.leaves !== fixture.expectedCounters.leaves ||
    row.pairs !== fixture.expectedCounters.pairs
  )
    throw new Error('transverse arrangement literal counter mismatch');
  if (fixture.expectation === 'Certified') assertOutput(fixture, row.output);
  else if (row.output !== null) throw new Error('transverse arrangement failure published output');
  if (row.allocations !== 0) throw new Error('transverse arrangement certify allocated');
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
      'transverse_arrangement_tests::emit_transverse_arrangement',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_NATIVE_TRANSVERSE_ARRANGEMENT_INPUT: input },
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

function parseStrictFrame(stdout: string): readonly NativeTransverseArrangementRow[] {
  if ((stdout.match(/P3_NATIVE_TRANSVERSE_ARRANGEMENT_BEGIN/gu) ?? []).length !== 1)
    throw new Error('native transverse arrangement begin marker count mismatch');
  if ((stdout.match(/P3_NATIVE_TRANSVERSE_ARRANGEMENT_END/gu) ?? []).length !== 1)
    throw new Error('native transverse arrangement end marker count mismatch');
  const frame =
    /P3_NATIVE_TRANSVERSE_ARRANGEMENT_BEGIN\r?\n([\s\S]*?)\r?\nP3_NATIVE_TRANSVERSE_ARRANGEMENT_END/u.exec(
      stdout,
    );
  if (!frame) throw new Error('native transverse arrangement frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  if (lines.length !== 39) throw new Error('native transverse arrangement row count mismatch');
  const rows = lines.map(parseNativeTransverseArrangementRow);
  if (new Set(rows.map(({ id }) => id)).size !== rows.length)
    throw new Error('native transverse arrangement duplicate row ID');
  return rows;
}

function captureRows(): readonly NativeTransverseArrangementRow[] {
  const result = runEmitter(
    encodeNativeTransverseArrangementFixture(fixtureRows),
    'p3-native-transverse-arrangement-',
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return parseStrictFrame(result.stdout);
}

let nativeRows: readonly NativeTransverseArrangementRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2s native transverse arrangement preservation', () => {
  it('freezes the reviewed 12+11+5+8+2+1 source transport without result labels', () => {
    expect(fixtureRows).toHaveLength(39);
    expect(certifiedFixtures).toHaveLength(24);
    expect(knotMismatchFixtures).toHaveLength(2);
    expect(unresolvedFixtures).toHaveLength(13);
    expect(new Set(fixtureRows.map(({ id }) => id)).size).toBe(39);
    expect(fixtureRows.slice(23, 28).map(({ id }) => id)).toEqual([
      'control/multiple-partners',
      'control/triple-coincidence',
      'control/tangent-displaced-knot',
      'control/coincident-squares',
      'control/contact-squares',
    ]);
    expect(fixtureRows.slice(36, 38).every(({ id }) => id.startsWith('minimum/'))).toBe(true);
    expect(fixtureRows.at(-1)!.id).toBe('signed-zero/carry');
    const encoded = encodeNativeTransverseArrangementFixture(fixtureRows);
    expect(encoded.startsWith('# p3-native-transverse-arrangement-v1\n# rows 39\n')).toBe(true);
    for (const label of ['Certified', 'KnotMismatch', 'Unresolved'])
      expect(fixtureRows.every(({ inputTokens }) => !inputTokens.includes(label))).toBe(true);
    expect(() => encodeNativeTransverseArrangementFixture(fixtureRows.slice(1))).toThrow('39');
    expect(() =>
      encodeNativeTransverseArrangementFixture([...fixtureRows, fixtureRows[0]!]),
    ).toThrow('39');
  });

  it.each(fixtureRows)(
    '$id matches the independent arrangement oracle and frozen carrier',
    (fixture) => {
      const row = nativeRows[fixtureRows.indexOf(fixture)]!;
      expect(() => assertCarrier(fixture, row)).not.toThrow();
    },
  );

  it('preserves literal crossing identities, orientations, closure leaves, and empty inherited crossings', () => {
    for (const fixture of fixtureRows.slice(0, 12)) {
      expect(fixture.crossings!.length, fixture.id).toBeGreaterThan(0);
      expect(fixture.expectedCounters, fixture.id).toEqual({ leaves: 8, pairs: 28 });
    }
    for (const id of ['B-implicit', 'N-implicit', 'closure-crossing', 'closure-crossing-curved']) {
      const fixture = fixtureRows.find((candidate) => candidate.id === id)!;
      expect(fixture.contours[0], id).toHaveLength(7);
      expect(fixture.contours[0]!.at(-1)!.lines.at(-1)!.end, id).not.toEqual(
        fixture.contours[0]![0]!.cubic[0],
      );
      expect(fixture.crossings![0]!.rightLeaf, id).toBe(id.startsWith('closure-') ? 7 : 4);
    }
    for (const fixture of fixtureRows.slice(0, 10)) {
      expect(signedAreaTwice(fixture.polygons![0]!), fixture.id).toBe(0);
      const row = nativeRows[fixtureRows.indexOf(fixture)]!;
      expect(Object.keys(row.output!).sort(), fixture.id).toEqual([
        'contours',
        'crossings',
        'points',
      ]);
    }
    for (const fixture of [...fixtureRows.slice(12, 23), fixtureRows.at(-1)!])
      expect(fixture.crossings, fixture.id).toEqual([]);
    expect(fixtureRows[0]!.crossings).toEqual([{ leftLeaf: 0, rightLeaf: 4, orientation: -1 }]);
    expect(fixtureRows[1]!.crossings).toEqual([{ leftLeaf: 0, rightLeaf: 4, orientation: 1 }]);
    expect(fixtureRows[10]!.crossings).toEqual([
      { leftLeaf: 0, rightLeaf: 7, orientation: -1 },
      { leftLeaf: 1, rightLeaf: 6, orientation: 1 },
    ]);
  });

  it('keeps retained storage stable, bounded, and certify allocation-free', () => {
    expect(new Set(nativeRows.map(({ inline_bytes }) => inline_bytes)).size).toBe(1);
    expect(new Set(nativeRows.map(({ allocated_bytes }) => allocated_bytes)).size).toBe(1);
    expect(nativeRows.every(({ inline_bytes }) => inline_bytes > 0 && inline_bytes <= 4096)).toBe(
      true,
    );
    expect(
      nativeRows.every(
        ({ allocated_bytes }) => allocated_bytes > 0 && allocated_bytes <= 1024 * 1024,
      ),
    ).toBe(true);
    expect(nativeRows.every(({ allocations }) => allocations === 0)).toBe(true);
  });

  it('preserves the carried signed-zero source and owned point bits', () => {
    const fixture = fixtureRows.at(-1)!;
    const row = nativeRows.at(-1)!;
    if (row.output === null) throw new Error('signed-zero arrangement output missing');
    expect(fixture.inputTokens).toContain('8000000000000000');
    expect(bitsOf(row.output.points[4]![1])).toBe(0x8000000000000000n);
    assertOutput(fixture, row.output);
  });

  it('strictly rejects malformed envelopes, status publication, counters, and stale fields', () => {
    const success = nativeRows.find(({ id }) => id === 'overlapping-squares')!;
    const failure = nativeRows.find(({ status }) => status === 'Unresolved')!;
    const missing = Object.fromEntries(Object.entries(success).filter(([key]) => key !== 'id'));
    expect(() => parseNativeTransverseArrangementValue(missing, 0)).toThrow('keys mismatch');
    expect(() => parseNativeTransverseArrangementValue({ ...success, extra: 1 }, 0)).toThrow(
      'keys mismatch',
    );
    expect(() =>
      parseNativeTransverseArrangementValue({ ...success, status: 'Success' }, 0),
    ).toThrow('status invalid');
    expect(() =>
      parseNativeTransverseArrangementValue({ ...success, input_tokens: ['bad token'] }, 0),
    ).toThrow('noncanonical token');
    expect(() =>
      parseNativeTransverseArrangementValue({ ...success, leaves: success.leaves - 1 }, 0),
    ).toThrow('certified counters');
    expect(() =>
      parseNativeTransverseArrangementValue({ ...success, pairs: success.pairs - 1 }, 0),
    ).toThrow('certified counters');
    expect(() => parseNativeTransverseArrangementValue({ ...success, output: null }, 0)).toThrow(
      'output/status mismatch',
    );
    expect(() =>
      parseNativeTransverseArrangementValue({ ...failure, output: success.output }, 0),
    ).toThrow('output/status mismatch');
    expect(() =>
      parseNativeTransverseArrangementValue(
        {
          ...success,
          output: { ...success.output!, orientations: [1], winding: [[0, 0, 0, 0]] },
        },
        0,
      ),
    ).toThrow('keys mismatch');
  });

  it('rejects malformed point, contour, and crossing shapes independently', () => {
    const fixture = fixtureRows.find(({ id }) => id === 'overlapping-squares')!;
    const row = nativeRows[fixtureRows.indexOf(fixture)]!;
    if (row.output === null) throw new Error('two-crossing arrangement output missing');
    const output = row.output;
    expect(() =>
      parseNativeTransverseArrangementValue(
        { ...row, output: { ...output, points: [[Number.NaN, 0], ...output.points.slice(1)] } },
        0,
      ),
    ).toThrow('finite');
    expect(() =>
      parseNativeTransverseArrangementValue(
        {
          ...row,
          output: {
            ...output,
            contours: [{ ...output.contours[0]!, start: 1 }, ...output.contours.slice(1)],
          },
        },
        0,
      ),
    ).toThrow('partition');
    expect(() =>
      parseNativeTransverseArrangementValue(
        {
          ...row,
          output: {
            ...output,
            crossings: [{ ...output.crossings[0]!, orientation: 0 }, ...output.crossings.slice(1)],
          },
        },
        0,
      ),
    ).toThrow('must be -1 or 1');
    expect(() =>
      parseNativeTransverseArrangementValue(
        {
          ...row,
          output: {
            ...output,
            crossings: [
              { ...output.crossings[0]!, right_leaf: output.points.length },
              ...output.crossings.slice(1),
            ],
          },
        },
        0,
      ),
    ).toThrow('index');
    expect(() =>
      parseNativeTransverseArrangementValue(
        { ...row, output: { ...output, crossings: [...output.crossings].reverse() } },
        0,
      ),
    ).toThrow('order');
    expect(() =>
      parseNativeTransverseArrangementValue(
        {
          ...row,
          output: {
            ...output,
            crossings: [output.crossings[0]!, { ...output.crossings[1]!, right_leaf: 7 }],
          },
        },
        0,
      ),
    ).toThrow('partner repeated');
    expect(() =>
      parseNativeTransverseArrangementValue(
        {
          ...row,
          output: {
            ...output,
            crossings: output.crossings.map((crossing, index) =>
              index === 0 ? { ...crossing, extra: 1 } : crossing,
            ),
          },
        },
        0,
      ),
    ).toThrow('keys mismatch');
  });

  it('rejects corrupted identity, source bits, provenance, point bits, and literal crossings', () => {
    const fixture = fixtureRows.find(({ id }) => id === 'overlapping-squares')!;
    const row = nativeRows[fixtureRows.indexOf(fixture)]!;
    if (row.output === null) throw new Error('two-crossing arrangement output missing');
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
    const changedPoints = row.output.points.map((point, index) =>
      index === 0 ? ([point[0], -point[1]] as const) : point,
    );
    expect(() => assertOutput(fixture, { ...row.output!, points: changedPoints })).toThrow(
      'point bits',
    );
    expect(() =>
      assertOutput(fixture, {
        ...row.output!,
        crossings: row.output!.crossings.map((crossing, index) =>
          index === 0 ? { ...crossing, orientation: -crossing.orientation as -1 | 1 } : crossing,
        ),
      }),
    ).toThrow('crossings');
  });

  it('rejects wrong source headers and declared row counts before geometry', () => {
    const source = encodeNativeTransverseArrangementFixture(fixtureRows);
    for (const [label, corrupted] of [
      [
        'header',
        source.replace(
          '# p3-native-transverse-arrangement-v1',
          '# p3-native-transverse-arrangement-v0',
        ),
      ],
      ['row-count', source.replace('# rows 39', '# rows 38')],
    ] as const) {
      const result = runEmitter(corrupted, `p3-native-transverse-arrangement-bad-${label}-`);
      if (result.error) throw result.error;
      const combined = result.stdout + result.stderr;
      expect(result.status, `${label}\n${combined}`).not.toBe(0);
      expect(combined, label).toContain(
        label === 'header' ? '# p3-native-transverse-arrangement-v0' : '# rows 38',
      );
      expect(combined, label).not.toContain('P3_NATIVE_TRANSVERSE_ARRANGEMENT_BEGIN');
    }
  });

  it('rejects missing, extra, duplicate, and incorrectly marked output frames', () => {
    const lines = nativeRows.map((row) => JSON.stringify(row));
    const frame = (body: readonly string[]) =>
      `P3_NATIVE_TRANSVERSE_ARRANGEMENT_BEGIN\n${body.join('\n')}\nP3_NATIVE_TRANSVERSE_ARRANGEMENT_END`;
    expect(() => parseStrictFrame(frame(lines.slice(1)))).toThrow('row count');
    expect(() => parseStrictFrame(frame([...lines, lines[0]!]))).toThrow('row count');
    expect(() => parseStrictFrame(frame([lines[0]!, ...lines.slice(0, -1)]))).toThrow(
      'duplicate row ID',
    );
    expect(() =>
      parseStrictFrame(
        frame(lines).replace('P3_NATIVE_TRANSVERSE_ARRANGEMENT_BEGIN', 'WRONG_BEGIN'),
      ),
    ).toThrow('begin marker');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_TRANSVERSE_ARRANGEMENT_END', 'WRONG_END')),
    ).toThrow('end marker');
  });
});
