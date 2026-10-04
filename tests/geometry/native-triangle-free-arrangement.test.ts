import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Point } from '../../packages/geometry-reference/src/types.js';
import {
  encodeNativeTriangleFreeArrangementFixture,
  fixedNativeTriangleFreeArrangementFixtureRows,
  type NativeTriangleFreeArrangementFixtureRow,
} from './native-triangle-free-arrangement/fixtures.js';
import { fixedNativeMixedLineArrangementFixtureRows } from './native-mixed-line-arrangement/fixtures.js';
import {
  parseNativeTriangleFreeArrangementRow,
  parseNativeTriangleFreeArrangementValue,
  parseNativeTransverseArrangementValue,
  type NativeTransverseArrangementOutput,
  type NativeTransverseArrangementRow,
} from './native-transverse-arrangement/native.js';
import type { NativeTopologyRange } from './native-topology/native.js';
import { bitsOf } from './rounded-fill/exact.js';
import {
  certifyMixedTransverseCubicArrangement,
  certifyTriangleFreeCubicArrangement,
} from './simple-cubic-topology/oracle.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeTriangleFreeArrangementFixtureRows();

function polygonBits(polygons: readonly (readonly Point[])[]): string {
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

function oracleStatus(status: string): NativeTriangleFreeArrangementFixtureRow['expectation'] {
  if (status === 'CERTIFIED') return 'Certified';
  if (status === 'UNRESOLVED') return 'Unresolved';
  if (status === 'WORK_LIMIT') return 'WorkLimit';
  throw new Error(`triangle-free oracle returned ${status}`);
}

function expectedCrossings(fixture: NativeTriangleFreeArrangementFixtureRow) {
  if (fixture.crossings === null) throw new Error('literal triangle-free crossings missing');
  return fixture.crossings.map(({ leftLeaf, rightLeaf, orientation }) => ({
    left_leaf: leftLeaf,
    right_leaf: rightLeaf,
    orientation,
  }));
}

function assertIdentity(
  fixture: NativeTriangleFreeArrangementFixtureRow,
  row: NativeTransverseArrangementRow,
): void {
  if (row.id !== fixture.id) throw new Error('triangle-free row identity mismatch');
  if (JSON.stringify(row.input_tokens) !== JSON.stringify(fixture.inputTokens))
    throw new Error('triangle-free source/kind/provenance echo mismatch');
}

function assertOutput(
  fixture: NativeTriangleFreeArrangementFixtureRow,
  actual: NativeTransverseArrangementOutput | null,
): void {
  if (actual === null || fixture.polygons === null || fixture.crossings === null)
    throw new Error('triangle-free certified output missing');
  if (polygonBits([actual.points]) !== polygonBits([fixture.polygons.flat()]))
    throw new Error('triangle-free owned polygon point bits mismatch');
  if (JSON.stringify(actual.contours) !== JSON.stringify(expectedRanges(fixture.polygons)))
    throw new Error('triangle-free owned polygon ranges mismatch');
  if (JSON.stringify(actual.crossings) !== JSON.stringify(expectedCrossings(fixture)))
    throw new Error('triangle-free crossings mismatch');
}

function assertCarrier(
  fixture: NativeTriangleFreeArrangementFixtureRow,
  row: NativeTransverseArrangementRow,
): void {
  assertIdentity(fixture, row);
  const oracle = certifyTriangleFreeCubicArrangement(fixture.contours, fixture.sourceKinds);
  if (oracleStatus(oracle.status) !== fixture.expectation || row.status !== fixture.expectation)
    throw new Error('triangle-free status mismatch');
  if (
    oracle.leaves !== fixture.expectedCounters.leaves ||
    oracle.pairs !== fixture.expectedCounters.pairs
  )
    throw new Error('triangle-free oracle counter mismatch');
  if (
    row.leaves !== fixture.expectedCounters.leaves ||
    row.pairs !== fixture.expectedCounters.pairs
  )
    throw new Error('triangle-free literal counter mismatch');
  if (fixture.expectation === 'Certified') {
    if (!oracle.ok || oracle.certificate === null)
      throw new Error('triangle-free oracle certificate missing');
    if (polygonBits(oracle.certificate.polygons) !== polygonBits(fixture.polygons!))
      throw new Error('triangle-free oracle polygon bits differ from literal fixture');
    if (JSON.stringify(oracle.certificate.crossings) !== JSON.stringify(fixture.crossings))
      throw new Error('triangle-free oracle crossings differ from literal fixture');
    assertOutput(fixture, row.output);
  } else if (oracle.certificate !== null || row.output !== null) {
    throw new Error('triangle-free failure published output');
  }
  if (!fixture.id.startsWith('new/')) {
    const old = certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds);
    expect(old, fixture.id).toEqual(oracle);
  }
  if (row.allocations !== 0 || row.allocated_bytes !== 224256 || row.inline_bytes !== 2512)
    throw new Error('triangle-free retained resource mismatch');
}

type NativeTarget = Readonly<{
  testName: string;
  environmentName: string;
  directoryPrefix: string;
}>;

const target: NativeTarget = {
  testName: 'triangle_free_arrangement_tests::emit_triangle_free_arrangement',
  environmentName: 'P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_INPUT',
  directoryPrefix: 'p3-native-triangle-free-arrangement-',
};

function runNative(input: string, selected: NativeTarget = target) {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const tools = path.join(root, '.tools');
  mkdirSync(tools, { recursive: true });
  const directory = mkdtempSync(path.join(tools, selected.directoryPrefix));
  const inputPath = path.join(directory, 'input.txt');
  writeFileSync(inputPath, input, { encoding: 'utf8', flag: 'wx' });
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
      selected.testName,
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, [selected.environmentName]: inputPath },
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
  const begin = 'P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_BEGIN';
  const end = 'P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_END';
  if ((stdout.match(new RegExp(begin, 'gu')) ?? []).length !== 1)
    throw new Error('native triangle-free begin marker count mismatch');
  if ((stdout.match(new RegExp(end, 'gu')) ?? []).length !== 1)
    throw new Error('native triangle-free end marker count mismatch');
  const frame = new RegExp(`${begin}\\r?\\n([\\s\\S]*?)\\r?\\n${end}`, 'u').exec(stdout);
  if (!frame) throw new Error('native triangle-free frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  if (lines.length !== 42) throw new Error('native triangle-free row count mismatch');
  const rows = lines.map((line, index) => parseNativeTriangleFreeArrangementRow(line, index));
  if (new Set(rows.map(({ id }) => id)).size !== rows.length)
    throw new Error('native triangle-free duplicate row ID');
  if (rows.some((row, index) => row.id !== fixtureRows[index]!.id))
    throw new Error('native triangle-free row order mismatch');
  return rows;
}

function captureRows(): readonly NativeTransverseArrangementRow[] {
  const result = runNative(encodeNativeTriangleFreeArrangementFixture(fixtureRows));
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return parseStrictFrame(result.stdout);
}

let nativeRows: readonly NativeTransverseArrangementRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2x native triangle-free arrangement transport', () => {
  it('freezes the exact 8+3+7+24 carrier and canonical kind sidecars', () => {
    expect(fixtureRows).toHaveLength(42);
    expect(fixtureRows.filter(({ expectation }) => expectation === 'Certified')).toHaveLength(39);
    expect(fixtureRows.filter(({ expectation }) => expectation === 'Unresolved')).toHaveLength(2);
    expect(fixtureRows.filter(({ expectation }) => expectation === 'WorkLimit')).toHaveLength(1);
    expect(new Set(fixtureRows.map(({ id }) => id)).size).toBe(42);
    expect(fixtureRows.slice(0, 11).map(({ id }) => id)).toEqual([
      'new/star',
      'new/star-reflect',
      'new/star-reverse',
      'new/star-implicit',
      'new/star-mixed',
      'new/star-lines',
      'new/star-curved',
      'new/cap-32',
      'new/distinct-triangle',
      'new/concurrent-triangle',
      'new/cap-overflow',
    ]);
    expect(fixtureRows.slice(0, 11).every(({ id }) => id.startsWith('new/'))).toBe(true);
    expect(fixtureRows.slice(11, 18).every(({ id }) => id.startsWith('mixed/'))).toBe(true);
    expect(fixtureRows.slice(18).every(({ id }) => id.startsWith('legacy/'))).toBe(true);
    const inherited = fixedNativeMixedLineArrangementFixtureRows().filter(
      ({ expectation }) => expectation === 'Certified',
    );
    expect(fixtureRows.slice(11).map(({ id }) => id)).toEqual(inherited.map(({ id }) => id));
    for (const fixture of fixtureRows) {
      const kinds = fixture.inputTokens.indexOf('kinds');
      expect(kinds, fixture.id).toBeGreaterThan(0);
      expect(fixture.inputTokens.at(-1), fixture.id).toBe('end');
      expect(fixture.inputTokens[kinds + 1], fixture.id).toBe(String(fixture.sourceKinds.length));
      expect(fixture.inputTokens.slice(kinds + 2, -1), fixture.id).toEqual(
        fixture.sourceKinds.map((kind) => (kind ? '1' : '0')),
      );
      for (const status of ['Certified', 'Unresolved', 'WorkLimit'])
        expect(fixture.inputTokens, fixture.id).not.toContain(status);
    }
    expect(
      fixtureRows
        .slice(8, 11)
        .map(({ expectation, expectedCounters }) => [expectation, expectedCounters]),
    ).toEqual([
      ['Unresolved', { leaves: 7, pairs: 13 }],
      ['Unresolved', { leaves: 7, pairs: 13 }],
      ['WorkLimit', { leaves: 16, pairs: 81 }],
    ]);
    const encoded = encodeNativeTriangleFreeArrangementFixture(fixtureRows);
    expect(encoded.startsWith('# p3-native-triangle-free-arrangement-v1\n# rows 42\n')).toBe(true);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(() => encodeNativeTriangleFreeArrangementFixture(fixtureRows.slice(1))).toThrow('42');
    expect(() =>
      encodeNativeTriangleFreeArrangementFixture([...fixtureRows, fixtureRows[0]!]),
    ).toThrow('42');
  });

  it.each(fixtureRows)('$id matches literal data and the independent oracle', (fixture) => {
    expect(() => assertCarrier(fixture, nativeRows[fixtureRows.indexOf(fixture)]!)).not.toThrow();
  });

  it('preserves the 31 inherited certified rows and old mixed results', () => {
    for (const fixture of fixtureRows.slice(11)) {
      expect(fixture.expectation, fixture.id).toBe('Certified');
      const triangle = certifyTriangleFreeCubicArrangement(fixture.contours, fixture.sourceKinds);
      const mixed = certifyMixedTransverseCubicArrangement(fixture.contours, fixture.sourceKinds);
      expect(triangle, fixture.id).toEqual(mixed);
    }
  });

  it('accepts repeated partners and cap32 while the matching parser stays strict', () => {
    const star = nativeRows[0]!;
    const cap = nativeRows[7]!;
    expect(() => parseNativeTriangleFreeArrangementValue(star, 0)).not.toThrow();
    expect(() => parseNativeTransverseArrangementValue(star, 0)).toThrow('partner repeated');
    expect(() => parseNativeTriangleFreeArrangementValue(cap, 0)).not.toThrow();
    expect(cap.output?.crossings).toHaveLength(32);
  });

  it('rejects malformed envelopes, publication, counters, ranges, and extra fields', () => {
    const success = nativeRows[0]!;
    const failure = nativeRows[8]!;
    const missing = Object.fromEntries(Object.entries(success).filter(([key]) => key !== 'id'));
    expect(() => parseNativeTriangleFreeArrangementValue(missing, 0)).toThrow('keys mismatch');
    expect(() => parseNativeTriangleFreeArrangementValue({ ...success, extra: 1 }, 0)).toThrow(
      'keys mismatch',
    );
    expect(() =>
      parseNativeTriangleFreeArrangementValue({ ...success, status: 'Success' }, 0),
    ).toThrow('status invalid');
    expect(() =>
      parseNativeTriangleFreeArrangementValue({ ...success, leaves: success.leaves - 1 }, 0),
    ).toThrow('certified counters');
    expect(() =>
      parseNativeTriangleFreeArrangementValue({ ...success, pairs: success.pairs - 1 }, 0),
    ).toThrow('certified counters');
    expect(() => parseNativeTriangleFreeArrangementValue({ ...success, output: null }, 0)).toThrow(
      'output/status mismatch',
    );
    expect(() =>
      parseNativeTriangleFreeArrangementValue({ ...failure, output: success.output }, 0),
    ).toThrow('output/status mismatch');
    expect(() =>
      parseNativeTriangleFreeArrangementValue(
        {
          ...success,
          output: {
            ...success.output!,
            contours: [
              { ...success.output!.contours[0]!, start: 1 },
              ...success.output!.contours.slice(1),
            ],
          },
        },
        0,
      ),
    ).toThrow('partition');
    expect(() =>
      parseNativeTriangleFreeArrangementValue(
        { ...success, output: { ...success.output!, stale: 1 } },
        0,
      ),
    ).toThrow('keys mismatch');
  });

  it('isolates crossing parser and literal-output corruptions', () => {
    const fixture = fixtureRows[0]!;
    const row = nativeRows[0]!;
    const output = row.output!;
    expect(() =>
      assertOutput(fixture, {
        ...output,
        crossings: output.crossings.map((crossing, index) =>
          index === 0 ? { ...crossing, orientation: -crossing.orientation as -1 | 1 } : crossing,
        ),
      }),
    ).toThrow('crossings');
    expect(() =>
      assertOutput(fixture, {
        ...output,
        crossings: output.crossings.map((crossing, index) =>
          index === 0 ? { ...crossing, right_leaf: 5 } : crossing,
        ),
      }),
    ).toThrow('crossings');
    expect(() =>
      parseNativeTriangleFreeArrangementValue(
        { ...row, output: { ...output, crossings: [output.crossings[0]!, output.crossings[0]!] } },
        0,
      ),
    ).toThrow('order');
    expect(() =>
      parseNativeTriangleFreeArrangementValue(
        { ...row, output: { ...output, crossings: [...output.crossings].reverse() } },
        0,
      ),
    ).toThrow('order');
    const triangle = [
      { left_leaf: 0, right_leaf: 2, orientation: 1 as const },
      { left_leaf: 0, right_leaf: 4, orientation: 1 as const },
      { left_leaf: 2, right_leaf: 4, orientation: 1 as const },
    ];
    expect(() =>
      parseNativeTriangleFreeArrangementValue(
        { ...row, output: { ...output, crossings: triangle } },
        0,
      ),
    ).toThrow('triangle');
    const cap = nativeRows[7]!;
    expect(() =>
      parseNativeTriangleFreeArrangementValue(
        {
          ...cap,
          output: {
            ...cap.output!,
            crossings: [...cap.output!.crossings, { left_leaf: 7, right_leaf: 15, orientation: 1 }],
          },
        },
        0,
      ),
    ).toThrow('shape mismatch');
  });

  it('rejects signed-zero and echoed source/kind corruption through real verification', () => {
    const signedIndex = fixtureRows.findIndex(({ id }) => id === 'mixed/marked-signed-zero');
    const fixture = fixtureRows[signedIndex]!;
    const row = nativeRows[signedIndex]!;
    let changed = false;
    const points = row.output!.points.map(([x, y]) => {
      if (!changed && (Object.is(x, -0) || Object.is(y, -0))) {
        changed = true;
        return [Object.is(x, -0) ? 0 : x, Object.is(y, -0) ? 0 : y] as const;
      }
      return [x, y] as const;
    });
    expect(changed).toBe(true);
    expect(() => assertOutput(fixture, { ...row.output!, points })).toThrow('point bits');
    expect(() => assertIdentity(fixture, { ...row, id: 'stale' })).toThrow('identity');
    const wrongKind = [...row.input_tokens];
    const kind = wrongKind.indexOf('kinds') + 2;
    wrongKind[kind] = wrongKind[kind] === '0' ? '1' : '0';
    expect(() => assertIdentity(fixture, { ...row, input_tokens: wrongKind })).toThrow('echo');
    const wrongSource = [...row.input_tokens];
    const cubic = wrongSource.indexOf('cubic');
    wrongSource[cubic + 2] =
      wrongSource[cubic + 2] === '0000000000000000' ? '8000000000000000' : '0000000000000000';
    expect(() => assertIdentity(fixture, { ...row, input_tokens: wrongSource })).toThrow('echo');
  });

  it('rejects malformed native headers and required kinds before emitter markers', () => {
    const source = encodeNativeTriangleFreeArrangementFixture(fixtureRows);
    const kindsLine = /^kinds ([^\r\n]+)$/mu.exec(source)?.[0];
    if (!kindsLine) throw new Error('triangle-free source lacks a kinds line');
    const parts = kindsLine.split(' ');
    const count = Number(parts[1]);
    const malformed = [
      [
        'header',
        source.replace('# p3-native-triangle-free-arrangement-v1', '# bad-v1'),
        '# p3-native-triangle-free-arrangement-v1',
      ],
      ['row-count', source.replace('# rows 42', '# rows 41'), '# rows 42'],
      ['missing-kinds', source.replace(`${kindsLine}\nend`, 'end'), 'row 0 kinds field count'],
      ['kind-tag', source.replace(kindsLine, kindsLine.replace('kinds', 'kind')), 'kinds tag'],
      ['kind-token-count', source.replace(kindsLine, `${kindsLine} 0`), 'row 0 kinds field count'],
      [
        'kind-spacing',
        source.replace(kindsLine, kindsLine.replace('kinds ', 'kinds  ')),
        'row 0 kinds spacing',
      ],
      [
        'kind-declared-count',
        source.replace(kindsLine, kindsLine.replace(`kinds ${count}`, `kinds ${count - 1}`)),
        `left: ${count - 1}`,
        `right: ${count}`,
      ],
      [
        'kind-count-syntax',
        source.replace(kindsLine, kindsLine.replace(`kinds ${count}`, `kinds 0${count}`)),
        'kinds count canonical integer',
      ],
      [
        'kind-bit',
        source.replace(kindsLine, `${parts.slice(0, 2).join(' ')} 2 ${parts.slice(3).join(' ')}`),
        'kinds canonical bit',
      ],
      [
        'row-end',
        source.replace(`${kindsLine}\nend`, `${kindsLine}\ndone`),
        'left: "done"',
        'right: "end"',
      ],
      [
        'extra-kinds',
        source.replace(`${kindsLine}\nend`, `${kindsLine}\n${kindsLine}\nend`),
        'row 0 end field count',
      ],
    ] as const;
    for (const [label, corrupted, expectedError, secondExpectedError] of malformed) {
      const result = runNative(corrupted, {
        ...target,
        directoryPrefix: `p3-native-triangle-free-bad-${label}-`,
      });
      if (result.error) throw result.error;
      const combined = result.stdout + result.stderr;
      expect(result.status, `${label}\n${combined}`).not.toBe(0);
      expect(combined, label).toContain(expectedError);
      if (secondExpectedError !== undefined) expect(combined, label).toContain(secondExpectedError);
      expect(combined, label).not.toContain('P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_BEGIN');
    }
  });

  it('rejects missing, extra, duplicate, reordered, and incorrectly marked frames', () => {
    const lines = nativeRows.map((row) => JSON.stringify(row));
    const frame = (body: readonly string[]) =>
      `P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_BEGIN\n${body.join('\n')}\nP3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_END`;
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
        frame(lines).replace('P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_BEGIN', 'WRONG_BEGIN'),
      ),
    ).toThrow('begin marker');
    expect(() =>
      parseStrictFrame(
        frame(lines).replace('P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_END', 'WRONG_END'),
      ),
    ).toThrow('end marker');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_BEGIN\n', '')),
    ).toThrow('begin marker');
    expect(() =>
      parseStrictFrame(frame(lines).replace('\nP3_NATIVE_TRIANGLE_FREE_ARRANGEMENT_END', '')),
    ).toThrow('end marker');
  });
});
