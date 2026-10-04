import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Point } from '../../packages/geometry-reference/src/types.js';
import {
  encodeNativeMixedLineArrangementFixture,
  fixedNativeMixedLineArrangementFixtureRows,
  type NativeMixedLineArrangementFixtureRow,
} from './native-mixed-line-arrangement/fixtures.js';
import {
  encodeNativeTransverseArrangementFixture,
  fixedNativeTransverseArrangementFixtureRows,
} from './native-transverse-arrangement/fixtures.js';
import {
  parseNativeTransverseArrangementRow,
  parseNativeTransverseArrangementValue,
  type NativeTransverseArrangementOutput,
  type NativeTransverseArrangementRow,
} from './native-transverse-arrangement/native.js';
import type { NativeTopologyRange } from './native-topology/native.js';
import { bitsOf } from './rounded-fill/exact.js';
import {
  certifyMixedTransverseCubicArrangement,
  certifyTransverseCubicArrangement,
} from './simple-cubic-topology/oracle.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeMixedLineArrangementFixtureRows();
const legacyRows = fixedNativeTransverseArrangementFixtureRows();

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

function expectedCrossings(fixture: NativeMixedLineArrangementFixtureRow) {
  if (fixture.crossings === null) throw new Error('literal mixed arrangement crossings missing');
  return fixture.crossings.map(({ leftLeaf, rightLeaf, orientation }) => ({
    left_leaf: leftLeaf,
    right_leaf: rightLeaf,
    orientation,
  }));
}

function expectedStatus(status: string): NativeMixedLineArrangementFixtureRow['expectation'] {
  if (status === 'CERTIFIED') return 'Certified';
  if (status === 'KNOT_MISMATCH') return 'KnotMismatch';
  if (status === 'UNRESOLVED') return 'Unresolved';
  throw new Error(`mixed arrangement oracle returned ${status}`);
}

function assertIdentity(
  fixture: NativeMixedLineArrangementFixtureRow,
  row: NativeTransverseArrangementRow,
): void {
  if (row.id !== fixture.id) throw new Error('mixed arrangement row identity mismatch');
  if (JSON.stringify(row.input_tokens) !== JSON.stringify(fixture.inputTokens))
    throw new Error('mixed arrangement source/kind/provenance echo mismatch');
}

function assertOutput(
  fixture: NativeMixedLineArrangementFixtureRow,
  actual: NativeTransverseArrangementOutput | null,
): void {
  if (actual === null || fixture.polygons === null || fixture.crossings === null)
    throw new Error('mixed arrangement certified output missing');
  const oracle = certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds);
  if (!oracle.ok || oracle.certificate === null)
    throw new Error(
      `independent mixed arrangement oracle rejected ${fixture.id}: ${oracle.status}`,
    );
  if (polygonBitStrings(oracle.certificate.polygons) !== polygonBitStrings(fixture.polygons))
    throw new Error('mixed arrangement oracle polygon bits differ from literal fixture');
  if (JSON.stringify(oracle.certificate.crossings) !== JSON.stringify(fixture.crossings))
    throw new Error('mixed arrangement oracle crossings differ from literal fixture');
  if (polygonBitStrings([actual.points]) !== polygonBitStrings([fixture.polygons.flat()]))
    throw new Error('mixed arrangement owned polygon point bits mismatch');
  if (JSON.stringify(actual.contours) !== JSON.stringify(expectedRanges(fixture.polygons)))
    throw new Error('mixed arrangement owned polygon ranges mismatch');
  if (JSON.stringify(actual.crossings) !== JSON.stringify(expectedCrossings(fixture)))
    throw new Error('mixed arrangement crossings mismatch');
}

function assertCarrier(
  fixture: NativeMixedLineArrangementFixtureRow,
  row: NativeTransverseArrangementRow,
): void {
  assertIdentity(fixture, row);
  const oracle = certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds);
  if (expectedStatus(oracle.status) !== fixture.expectation || row.status !== fixture.expectation)
    throw new Error('mixed arrangement status mismatch');
  if (row.leaves !== oracle.leaves || row.pairs !== oracle.pairs)
    throw new Error('mixed arrangement oracle counter mismatch');
  if (
    row.leaves !== fixture.expectedCounters.leaves ||
    row.pairs !== fixture.expectedCounters.pairs
  )
    throw new Error('mixed arrangement literal counter mismatch');
  if (fixture.sourceKinds.every((kind) => !kind)) {
    const old = certifyTransverseCubicArrangement(fixture.contours);
    expect(oracle, `${fixture.id} all-false old-oracle parity`).toEqual(old);
  }
  if (fixture.expectation === 'Certified') assertOutput(fixture, row.output);
  else if (row.output !== null) throw new Error('mixed arrangement failure published output');
  if (row.allocations !== 0) throw new Error('mixed arrangement certify allocated');
  if (row.allocated_bytes !== 224256 || row.inline_bytes !== 2512)
    throw new Error('mixed arrangement retained storage changed');
}

type NativeTarget = Readonly<{
  testName: string;
  environmentName: string;
  directoryPrefix: string;
}>;

function runNative(source: string, target: NativeTarget) {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const tools = path.join(root, '.tools');
  mkdirSync(tools, { recursive: true });
  const directory = mkdtempSync(path.join(tools, target.directoryPrefix));
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
      target.testName,
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, [target.environmentName]: input },
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

const mixedTarget = {
  testName: 'mixed_line_arrangement_tests::emit_mixed_line_arrangement',
  environmentName: 'P3_NATIVE_MIXED_LINE_ARRANGEMENT_INPUT',
  directoryPrefix: 'p3-native-mixed-line-arrangement-',
} as const;

function parseStrictFrame(stdout: string): readonly NativeTransverseArrangementRow[] {
  const begin = 'P3_NATIVE_MIXED_LINE_ARRANGEMENT_BEGIN';
  const end = 'P3_NATIVE_MIXED_LINE_ARRANGEMENT_END';
  if ((stdout.match(new RegExp(begin, 'gu')) ?? []).length !== 1)
    throw new Error('native mixed arrangement begin marker count mismatch');
  if ((stdout.match(new RegExp(end, 'gu')) ?? []).length !== 1)
    throw new Error('native mixed arrangement end marker count mismatch');
  const frame = new RegExp(`${begin}\\r?\\n([\\s\\S]*?)\\r?\\n${end}`, 'u').exec(stdout);
  if (!frame) throw new Error('native mixed arrangement frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  if (lines.length !== 53) throw new Error('native mixed arrangement row count mismatch');
  const rows = lines.map((line, index) => parseNativeTransverseArrangementRow(line, index));
  if (new Set(rows.map(({ id }) => id)).size !== rows.length)
    throw new Error('native mixed arrangement duplicate row ID');
  if (rows.some((row, index) => row.id !== fixtureRows[index]!.id))
    throw new Error('native mixed arrangement row order mismatch');
  return rows;
}

function captureRows(): readonly NativeTransverseArrangementRow[] {
  const result = runNative(encodeNativeMixedLineArrangementFixture(fixtureRows), mixedTarget);
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return parseStrictFrame(result.stdout);
}

let nativeRows: readonly NativeTransverseArrangementRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2v native mixed LINE arrangement preservation', () => {
  it('freezes the reviewed 7+7+39 source transport with explicit kinds and no result labels', () => {
    expect(fixtureRows).toHaveLength(53);
    expect(fixtureRows.filter(({ expectation }) => expectation === 'Certified')).toHaveLength(31);
    expect(fixtureRows.filter(({ expectation }) => expectation === 'KnotMismatch')).toHaveLength(2);
    expect(fixtureRows.filter(({ expectation }) => expectation === 'Unresolved')).toHaveLength(20);
    expect(new Set(fixtureRows.map(({ id }) => id)).size).toBe(53);
    expect(fixtureRows.slice(0, 7).every(({ id }) => id.startsWith('mixed/'))).toBe(true);
    expect(fixtureRows.slice(7, 14).every(({ id }) => id.startsWith('cubic/'))).toBe(true);
    expect(fixtureRows.slice(14).every(({ id }) => id.startsWith('legacy/'))).toBe(true);
    for (const fixture of fixtureRows) {
      const kinds = fixture.inputTokens.indexOf('kinds');
      expect(kinds, fixture.id).toBeGreaterThan(0);
      expect(fixture.inputTokens.at(-1), fixture.id).toBe('end');
      expect(fixture.inputTokens[kinds + 1], fixture.id).toBe(String(fixture.sourceKinds.length));
      expect(fixture.inputTokens.slice(kinds + 2, -1), fixture.id).toEqual(
        fixture.sourceKinds.map((kind) => (kind ? '1' : '0')),
      );
      for (const label of ['Certified', 'KnotMismatch', 'Unresolved'])
        expect(fixture.inputTokens, fixture.id).not.toContain(label);
    }
    expect(
      fixtureRows.slice(7).every(({ sourceKinds }) => sourceKinds.every((kind) => !kind)),
    ).toBe(true);
    const encoded = encodeNativeMixedLineArrangementFixture(fixtureRows);
    expect(encoded.startsWith('# p3-native-mixed-line-arrangement-v1\n# rows 53\n')).toBe(true);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(() => encodeNativeMixedLineArrangementFixture(fixtureRows.slice(1))).toThrow('53');
    expect(() =>
      encodeNativeMixedLineArrangementFixture([...fixtureRows, fixtureRows[0]!]),
    ).toThrow('53');
  });

  it.each(fixtureRows)('$id matches the independent mixed oracle and frozen carrier', (fixture) => {
    const row = nativeRows[fixtureRows.indexOf(fixture)]!;
    expect(() => assertCarrier(fixture, row)).not.toThrow();
  });

  it('preserves the seven H kinds, counters, polygons, and crossing labels literally', () => {
    for (let index = 0; index < 7; index += 1) {
      const mixed = fixtureRows[index]!;
      const cubic = fixtureRows[index + 7]!;
      expect(cubic.contours, cubic.id).toEqual(mixed.contours);
      expect(
        cubic.sourceKinds.every((kind) => !kind),
        cubic.id,
      ).toBe(true);
      expect(mixed.polygons, mixed.id).not.toBeNull();
      expect(mixed.crossings, mixed.id).not.toBeNull();
      expect(mixed.expectedCounters, mixed.id).toEqual(
        index === 5 ? { leaves: 16, pairs: 120 } : { leaves: 8, pairs: 28 },
      );
    }
    expect(fixtureRows[2]!.crossings).toEqual([{ leftLeaf: 3, rightLeaf: 7, orientation: 1 }]);
    expect(fixtureRows[5]!.crossings).toEqual([
      { leftLeaf: 3, rightLeaf: 7, orientation: 1 },
      { leftLeaf: 11, rightLeaf: 15, orientation: 1 },
    ]);
  });

  it('preserves all 39 legacy rows and all-false old-oracle behavior', () => {
    fixtureRows.slice(14).forEach((fixture, index) => {
      const legacy = legacyRows[index]!;
      expect(fixture.id).toBe(`legacy/${legacy.id}`);
      expect(fixture.contours).toEqual(legacy.contours);
      expect(fixture.expectation).toBe(legacy.expectation);
      expect(fixture.expectedCounters).toEqual(legacy.expectedCounters);
      expect(polygonBitStrings(fixture.polygons ?? [])).toBe(
        polygonBitStrings(legacy.polygons ?? []),
      );
      expect(fixture.crossings).toEqual(legacy.crossings);
      expect(fixture.sourceKinds.every((kind) => !kind)).toBe(true);
    });
  });

  it('keeps retained storage exact and mixed certification allocation-free', () => {
    expect(nativeRows.every(({ allocations }) => allocations === 0)).toBe(true);
    expect(nativeRows.every(({ allocated_bytes }) => allocated_bytes === 224256)).toBe(true);
    expect(nativeRows.every(({ inline_bytes }) => inline_bytes === 2512)).toBe(true);
  });

  it('preserves signed-zero source and owned polygon bits', () => {
    for (const id of ['mixed/marked-signed-zero', 'legacy/signed-zero/carry']) {
      const fixture = fixtureRows.find((candidate) => candidate.id === id)!;
      const row = nativeRows[fixtureRows.indexOf(fixture)]!;
      expect(fixture.inputTokens, id).toContain('8000000000000000');
      expect(() => assertOutput(fixture, row.output)).not.toThrow();
    }
  });

  it('strictly rejects malformed envelopes, status publication, counters, and stale fields', () => {
    const success = nativeRows.find(({ id }) => id === 'mixed/line-cubic')!;
    const failure = nativeRows.find(({ id }) => id === 'cubic/line-cubic')!;
    const missing = Object.fromEntries(Object.entries(success).filter(([key]) => key !== 'id'));
    expect(() => parseNativeTransverseArrangementValue(missing, 0)).toThrow('keys mismatch');
    expect(() => parseNativeTransverseArrangementValue({ ...success, extra: 1 }, 0)).toThrow(
      'keys mismatch',
    );
    expect(() =>
      parseNativeTransverseArrangementValue({ ...success, status: 'Success' }, 0),
    ).toThrow('status invalid');
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
        { ...success, output: { ...success.output!, orientation: [1] } },
        0,
      ),
    ).toThrow('keys mismatch');
    expect(() =>
      parseNativeTransverseArrangementValue(
        { ...success, output: { ...success.output!, winding: [[0, 0, 0, 0]] } },
        0,
      ),
    ).toThrow('keys mismatch');
  });

  it('rejects corrupted ranges, crossings, point bits, and source/kind identity independently', () => {
    const fixture = fixtureRows.find(({ id }) => id === 'mixed/two-closures')!;
    const row = nativeRows[fixtureRows.indexOf(fixture)]!;
    if (row.output === null) throw new Error('two-closure mixed output missing');
    const output = row.output;
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
            crossings: [
              output.crossings[0]!,
              { ...output.crossings[1]!, left_leaf: output.crossings[0]!.right_leaf },
            ],
          },
        },
        0,
      ),
    ).toThrow('partner repeated');
    expect(() =>
      parseNativeTransverseArrangementValue(
        { ...row, output: { ...output, points: [[Number.NaN, 0], ...output.points.slice(1)] } },
        0,
      ),
    ).toThrow('finite');
    expect(() => assertIdentity(fixture, { ...row, id: 'stale' })).toThrow('identity');
    const wrongSource = [...row.input_tokens];
    const cubic = wrongSource.indexOf('cubic');
    wrongSource[cubic + 2] =
      wrongSource[cubic + 2] === '0000000000000000' ? '8000000000000000' : '0000000000000000';
    expect(() => assertIdentity(fixture, { ...row, input_tokens: wrongSource })).toThrow('echo');
    const wrongKind = [...row.input_tokens];
    const kind = wrongKind.indexOf('kinds') + 2;
    wrongKind[kind] = wrongKind[kind] === '0' ? '1' : '0';
    expect(() => assertIdentity(fixture, { ...row, input_tokens: wrongKind })).toThrow('echo');
    const signedFixture = fixtureRows.find(({ id }) => id === 'mixed/marked-signed-zero')!;
    const signedRow = nativeRows[fixtureRows.indexOf(signedFixture)]!;
    if (signedRow.output === null) throw new Error('signed-zero mixed output missing');
    let changed = false;
    const points = signedRow.output.points.map(([x, y]) => {
      if (!changed && (Object.is(x, -0) || Object.is(y, -0))) {
        changed = true;
        return [Object.is(x, -0) ? 0 : x, Object.is(y, -0) ? 0 : y] as const;
      }
      return [x, y] as const;
    });
    expect(changed).toBe(true);
    expect(() => assertOutput(signedFixture, { ...signedRow.output!, points })).toThrow(
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
    expect(() =>
      assertOutput(fixture, {
        ...row.output!,
        crossings: row.output!.crossings.map((crossing, index) =>
          index === 0 ? { ...crossing, right_leaf: 8 } : crossing,
        ),
      }),
    ).toThrow('crossings');
  });

  it('rejects malformed new kinds and rejects kinds through the old reader before frames', () => {
    const source = encodeNativeMixedLineArrangementFixture(fixtureRows);
    const kindsLine = /^kinds ([^\r\n]+)$/mu.exec(source)?.[0];
    if (!kindsLine) throw new Error('mixed source lacks a kinds line');
    const parts = kindsLine.split(' ');
    const count = Number(parts[1]);
    const malformed = [
      ['header', source.replace('# p3-native-mixed-line-arrangement-v1', '# bad-v1')],
      ['row-count', source.replace('# rows 53', '# rows 52')],
      ['missing-kinds', source.replace(`${kindsLine}\nend`, 'end')],
      ['extra-kinds', source.replace(`${kindsLine}\nend`, `${kindsLine}\n${kindsLine}\nend`)],
      [
        'kind-count',
        source.replace(kindsLine, kindsLine.replace(`kinds ${count}`, `kinds ${count - 1}`)),
      ],
      [
        'kind-bit',
        source.replace(kindsLine, `${parts.slice(0, 2).join(' ')} 2 ${parts.slice(3).join(' ')}`),
      ],
      ['kind-spacing', source.replace(kindsLine, kindsLine.replace('kinds ', 'kinds  '))],
    ] as const;
    for (const [label, corrupted] of malformed) {
      const result = runNative(corrupted, {
        ...mixedTarget,
        directoryPrefix: `p3-native-mixed-line-arrangement-bad-${label}-`,
      });
      if (result.error) throw result.error;
      const combined = result.stdout + result.stderr;
      expect(result.status, `${label}\n${combined}`).not.toBe(0);
      expect(combined, label).not.toContain('P3_NATIVE_MIXED_LINE_ARRANGEMENT_BEGIN');
    }

    const oldSource = encodeNativeTransverseArrangementFixture(legacyRows);
    const firstSources = legacyRows[0]!.contours.reduce((sum, contour) => sum + contour.length, 0);
    const injected = oldSource.replace(
      '\nend\n',
      `\nkinds ${firstSources} ${Array.from({ length: firstSources }, () => '0').join(' ')}\nend\n`,
    );
    const oldResult = runNative(injected, {
      testName: 'transverse_arrangement_tests::emit_transverse_arrangement',
      environmentName: 'P3_NATIVE_TRANSVERSE_ARRANGEMENT_INPUT',
      directoryPrefix: 'p3-native-transverse-arrangement-reject-kinds-',
    });
    if (oldResult.error) throw oldResult.error;
    expect(oldResult.status, oldResult.stdout + oldResult.stderr).not.toBe(0);
    expect(oldResult.stdout + oldResult.stderr).not.toContain(
      'P3_NATIVE_TRANSVERSE_ARRANGEMENT_BEGIN',
    );
  });

  it('rejects missing, extra, duplicate, reordered, and incorrectly marked output frames', () => {
    const lines = nativeRows.map((row) => JSON.stringify(row));
    const frame = (body: readonly string[]) =>
      `P3_NATIVE_MIXED_LINE_ARRANGEMENT_BEGIN\n${body.join('\n')}\nP3_NATIVE_MIXED_LINE_ARRANGEMENT_END`;
    expect(() => parseStrictFrame(frame(lines.slice(1)))).toThrow('row count');
    expect(() => parseStrictFrame(frame([...lines, lines[0]!]))).toThrow('row count');
    expect(() => parseStrictFrame(frame([lines[0]!, ...lines.slice(0, -1)]))).toThrow(
      'duplicate row ID',
    );
    expect(() => parseStrictFrame(frame([lines[1]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'row order',
    );
    expect(() =>
      parseStrictFrame(
        frame(lines).replace('P3_NATIVE_MIXED_LINE_ARRANGEMENT_BEGIN', 'WRONG_BEGIN'),
      ),
    ).toThrow('begin marker');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_MIXED_LINE_ARRANGEMENT_END', 'WRONG_END')),
    ).toThrow('end marker');
  });
});
