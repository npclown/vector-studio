import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectTriangleMesh } from '../../packages/geometry-reference/src/triangle-mesh.js';
import { encodeNativeCubicFixture, fixedNativeCubicFixtureRows } from './native-cubic/fixtures.js';
import { parseNativeCubicValue, type NativeCubicCommand } from './native-cubic/native.js';
import { roundedFixture } from './native-cubic/verify.js';
import {
  encodeNativeMixedCubicFixture,
  fixedNativeMixedCubicFixtureRows,
} from './native-mixed-cubic/fixtures.js';
import {
  parseNativeMixedCubicRow,
  parseNativeMixedCubicValue,
  type NativeMixedCubicEdgeOwner,
  type NativeMixedCubicRow,
} from './native-mixed-cubic/native.js';
import { assertNativeMixedCubicCarrier } from './native-mixed-cubic/verify.js';
import {
  assertCarrierMatches,
  buildRoundedFillOracle,
  verifyRoundedFillCarrier,
} from './rounded-fill/oracle.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeMixedCubicFixtureRows();

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
  testName: 'native_cubic_fill_tests::emit_mixed_native_cubic_fill',
  environmentName: 'P3_NATIVE_MIXED_CUBIC_INPUT',
  directoryPrefix: 'p3-native-mixed-cubic-',
} as const;

function parseStrictFrame(stdout: string): readonly NativeMixedCubicRow[] {
  if ((stdout.match(/P3_NATIVE_MIXED_CUBIC_BEGIN/gu) ?? []).length !== 1)
    throw new Error('native mixed cubic begin marker count mismatch');
  if ((stdout.match(/P3_NATIVE_MIXED_CUBIC_END/gu) ?? []).length !== 1)
    throw new Error('native mixed cubic end marker count mismatch');
  const frame = /P3_NATIVE_MIXED_CUBIC_BEGIN\r?\n([\s\S]*?)\r?\nP3_NATIVE_MIXED_CUBIC_END/u.exec(
    stdout,
  );
  if (!frame) throw new Error('native mixed cubic frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  if (lines.length !== 4) throw new Error('native mixed cubic row count mismatch');
  const rows = lines.map((line, index) => parseNativeMixedCubicRow(line, index));
  const identities = rows.map(({ carrier }) => `${carrier.id}:${carrier.rule}`);
  if (new Set(identities).size !== rows.length)
    throw new Error('native mixed cubic duplicate row identity');
  const expected = fixtureRows.map(({ id, rule }) => `${id}:${rule}`);
  if (JSON.stringify(identities) !== JSON.stringify(expected))
    throw new Error('native mixed cubic row order mismatch');
  return rows;
}

function captureRows(): readonly NativeMixedCubicRow[] {
  const result = runNative(encodeNativeMixedCubicFixture(fixtureRows), mixedTarget);
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return parseStrictFrame(result.stdout);
}

let nativeRows: readonly NativeMixedCubicRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2w canonical mixed LINE/cubic composition', () => {
  it('freezes exact source order, masks, zero packing, closure forms, and counts', () => {
    expect(fixtureRows.map(({ id, rule }) => `${id}:${rule}`)).toEqual([
      'mixed/bowtie:nonzero',
      'mixed/bowtie:evenodd',
      'mixed/zero-closure:nonzero',
      'mixed/zero-closure:evenodd',
    ]);
    expect(fixtureRows.map(({ sourceKinds }) => sourceKinds.map(Number).join(''))).toEqual([
      '10000000',
      '10000000',
      '10001000',
      '10001000',
    ]);
    expect(fixtureRows.map(({ packedKinds }) => packedKinds.map(Number).join(''))).toEqual([
      '10000000',
      '10000000',
      '0001000',
      '0001000',
    ]);
    expect(fixtureRows.map(({ expectedCommandCount }) => expectedCommandCount)).toEqual([
      10, 10, 9, 9,
    ]);
    expect(fixtureRows.map(({ expectedCubicCount }) => expectedCubicCount)).toEqual([7, 7, 6, 6]);
    expect(
      fixtureRows.map(
        ({ sourceKinds }) => 2 + sourceKinds.reduce((sum, kind) => sum + (kind ? 2 : 6), 0),
      ),
    ).toEqual([46, 46, 42, 42]);
    expect(fixtureRows[0]!.contours[0]!.closeVerbOrdinal).toBe(9);
    expect(fixtureRows[2]!.contours[0]!.closeVerbOrdinal).toBeNull();
    const zero = fixtureRows[2]!.contours[0]!.cubics[0]!;
    expect(zero[0]).toEqual([3, 3]);
    expect(zero).toEqual([zero[0], zero[0], zero[0], zero[0]]);
    expect(fixtureRows[2]!.contours[0]!.cubicVerbOrdinals[4]).toBe(5);
    expect(fixtureRows[0]!.contours[0]!.cubicVerbOrdinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fixtureRows[2]!.contours[0]!.cubicVerbOrdinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fixtureRows[2]!.contours[0]!.cubicVerbOrdinals.slice(1)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(
      fixtureRows.reduce((sum, row) => sum + row.sourceKinds.filter((kind) => !kind).length, 0),
    ).toBe(26);
    const source = encodeNativeMixedCubicFixture(fixtureRows);
    expect(source).toMatch(/^# p3-native-mixed-cubic-v1\n# rows 4\n/u);
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThanOrEqual(512 * 1024);
    expect(() => encodeNativeMixedCubicFixture(fixtureRows.slice(1))).toThrow('4');
    expect(() => encodeNativeMixedCubicFixture([...fixtureRows, fixtureRows[0]!])).toThrow('4');
  });

  it.each(fixtureRows)(
    '$id:$rule matches all independent proofs and literal carriers',
    (fixture) => {
      const row = nativeRows[fixtureRows.indexOf(fixture)]!;
      expect(() => assertNativeMixedCubicCarrier(fixture, row)).not.toThrow();
    },
  );

  it('keeps exact retained storage and every measured attempt allocation-free', () => {
    expect(nativeRows.every(({ carrier }) => carrier.allocations === 0)).toBe(true);
    expect(nativeRows.every(({ carrier }) => carrier.allocated_bytes === 1_111_552)).toBe(true);
    expect(nativeRows.every(({ carrier }) => carrier.inline_bytes === 12_952)).toBe(true);
  });

  it('preserves the literal packed owner vectors independently of fixture helpers', () => {
    expect(nativeRows[0]!.carrier.edge_owners).toEqual([
      { kind: 'Line', source_verb: 1 },
      { kind: 'CubicLeaf', source_verb: 2, end_numerator: 1, depth: 0 },
      { kind: 'CubicLeaf', source_verb: 3, end_numerator: 1, depth: 0 },
      { kind: 'CubicLeaf', source_verb: 4, end_numerator: 1, depth: 0 },
      { kind: 'CubicLeaf', source_verb: 5, end_numerator: 1, depth: 0 },
      { kind: 'CubicLeaf', source_verb: 6, end_numerator: 1, depth: 0 },
      { kind: 'CubicLeaf', source_verb: 7, end_numerator: 1, depth: 0 },
      { kind: 'CubicLeaf', source_verb: 8, end_numerator: 1, depth: 0 },
    ]);
    expect(nativeRows[2]!.carrier.edge_owners).toEqual([
      { kind: 'CubicLeaf', source_verb: 2, end_numerator: 1, depth: 0 },
      { kind: 'CubicLeaf', source_verb: 3, end_numerator: 1, depth: 0 },
      { kind: 'CubicLeaf', source_verb: 4, end_numerator: 1, depth: 0 },
      { kind: 'Line', source_verb: 5 },
      { kind: 'CubicLeaf', source_verb: 6, end_numerator: 1, depth: 0 },
      { kind: 'CubicLeaf', source_verb: 7, end_numerator: 1, depth: 0 },
      { kind: 'CubicLeaf', source_verb: 8, end_numerator: 1, depth: 0 },
      { kind: 'ImplicitClosure', contour: 0 },
    ]);
  });

  it('strictly rejects outer, kind echo, Line owner, and topology corruption', () => {
    const row = nativeRows[0]!;
    const { source_kinds: omittedKinds, ...missingKinds } = row;
    void omittedKinds;
    expect(() => parseNativeMixedCubicValue(missingKinds, 0)).toThrow('keys mismatch');
    expect(() => parseNativeMixedCubicValue({ ...row, extra: 1 }, 0)).toThrow('keys mismatch');
    expect(() =>
      parseNativeMixedCubicValue({ ...row, source_kinds: row.source_kinds.slice(1) }, 0),
    ).toThrow('count mismatch');
    expect(() =>
      parseNativeMixedCubicValue({ ...row, source_kinds: [...row.source_kinds, false] }, 0),
    ).toThrow('count mismatch');
    expect(() =>
      parseNativeMixedCubicValue({ ...row, source_kinds: [1, ...row.source_kinds.slice(1)] }, 0),
    ).toThrow('shape invalid');
    const sparse = new Array<boolean>(row.source_kinds.length);
    row.source_kinds.forEach((kind, index) => {
      if (index !== 2) sparse[index] = kind;
    });
    expect(() => parseNativeMixedCubicValue({ ...row, source_kinds: sparse }, 0)).toThrow(
      'shape invalid',
    );
    const owners = row.carrier.edge_owners!;
    const line = owners[0]!;
    expect(line.kind).toBe('Line');
    const malformedOwners = [
      [{ kind: 'Line' }, 'keys mismatch'],
      [{ ...line, extra: 1 }, 'keys mismatch'],
      [{ kind: 'Line', source_verb: 0x1_0000_0000 }, 'exceeds u32'],
    ] as const;
    for (const [owner, error] of malformedOwners)
      expect(() =>
        parseNativeMixedCubicValue(
          { ...row, carrier: { ...row.carrier, edge_owners: [owner, ...owners.slice(1)] } },
          0,
        ),
      ).toThrow(error);
    const explicitClose = { kind: 'ExplicitClose', source_verb: 9 };
    const explicitCarrier = {
      ...row.carrier,
      edge_owners: [explicitClose, ...owners.slice(1)],
    };
    expect(() => parseNativeMixedCubicValue({ ...row, carrier: explicitCarrier }, 0)).toThrow(
      'kind invalid',
    );
    expect(() => parseNativeCubicValue(explicitCarrier, 0)).toThrow('kind invalid');
    expect(() => parseNativeCubicValue(row.carrier, 0)).toThrow('kind invalid');
    expect(() =>
      parseNativeMixedCubicValue(
        {
          ...row,
          topology: { ...row.topology, stats: { leaves: 8, pairs: 27 } },
        },
        0,
      ),
    ).toThrow('stats mismatch');
    expect(() =>
      parseNativeMixedCubicValue(
        { ...row, topology: { ...row.topology, transverse_topology_selected: false } },
        0,
      ),
    ).toThrow('route contradiction');
  });

  it('rejects source, original-kind, command, zero omission, and owner corruption independently', () => {
    const fixture = fixtureRows[2]!;
    const row = nativeRows[2]!;
    const sourceBits = row.carrier.source_bits.map((contour) => contour.map((cubic) => [...cubic]));
    sourceBits[0]![0]![0] = '0000000000000000';
    expect(() =>
      assertNativeMixedCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, source_bits: sourceBits },
      }),
    ).toThrow();
    expect(() =>
      assertNativeMixedCubicCarrier(fixture, {
        ...row,
        source_kinds: row.source_kinds.map((kind, index) => (index === 0 ? !kind : kind)),
      }),
    ).toThrow();
    const commands = row.carrier.commands!;
    expect(() =>
      assertNativeMixedCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, commands: [commands[0]!, ...commands.slice(2)] },
      }),
    ).toThrow();
    for (const provenance of [
      { source_verb: 99, end_numerator: 1, depth: 0 },
      { source_verb: 1, end_numerator: 2, depth: 0 },
      { source_verb: 1, end_numerator: 1, depth: 1 },
    ]) {
      const changed = structuredClone(commands) as NativeCubicCommand[];
      changed[1] = { ...changed[1]!, provenance };
      expect(() =>
        assertNativeMixedCubicCarrier(fixture, {
          ...row,
          carrier: { ...row.carrier, commands: changed },
        }),
      ).toThrow();
    }
    const changedEnd = structuredClone(commands) as NativeCubicCommand[];
    changedEnd[1] = { ...changedEnd[1]!, point: [4, 3] };
    expect(() =>
      assertNativeMixedCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, commands: changedEnd },
      }),
    ).toThrow();
    const owners = row.carrier.edge_owners!;
    const spurious: NativeMixedCubicEdgeOwner = { kind: 'Line', source_verb: 1 };
    expect(() =>
      assertNativeMixedCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, edge_owners: [spurious, ...owners] },
      }),
    ).toThrow();
    expect(() =>
      assertNativeMixedCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, edge_owners: owners.slice(1) },
      }),
    ).toThrow();
    const wrongLine = owners.map((owner) =>
      owner.kind === 'Line' ? { ...owner, source_verb: 4 } : owner,
    );
    expect(() =>
      assertNativeMixedCubicCarrier(fixture, {
        ...row,
        carrier: { ...row.carrier, edge_owners: wrongLine },
      }),
    ).toThrow();
  });

  it('rejects missing guard, inward bounds, and excessive outward bounds', () => {
    for (const [index, row] of nativeRows.entries()) {
      const fixture = fixtureRows[index]!;
      const bounds = row.carrier.flat_bounds!;
      const guard = 1344 * Number.EPSILON;
      for (const minX of [-3, -3 + 1 / 16, -3 - guard - 1 / 16]) {
        expect(() =>
          assertNativeMixedCubicCarrier(fixture, {
            ...row,
            carrier: { ...row.carrier, flat_bounds: [minX, bounds[1], bounds[2], bounds[3]] },
          }),
        ).toThrow();
      }
    }
  });

  it('rejects crossing, source-edge, contributor, region, and area corruption independently', () => {
    const fixture = fixtureRows[0]!;
    const row = nativeRows[0]!;
    expect(() =>
      assertNativeMixedCubicCarrier(
        {
          ...fixture,
          expectedCrossings: fixture.expectedCrossings.map((crossing) => ({
            ...crossing,
            orientation: -crossing.orientation as -1 | 1,
          })),
        },
        row,
      ),
    ).toThrow();
    expect(() =>
      assertNativeMixedCubicCarrier(
        {
          ...fixture,
          expectedCrossings: fixture.expectedCrossings.map((crossing) => ({
            ...crossing,
            rightLeaf: 5,
          })),
        },
        row,
      ),
    ).toThrow();
    const output = row.carrier.rounded!.output!;
    const wrongEdges = output.source_edges.map((edge, index) =>
      index === 0 ? { ...edge, start_vertex: 1 } : edge,
    );
    expect(() =>
      assertNativeMixedCubicCarrier(fixture, {
        ...row,
        carrier: {
          ...row.carrier,
          rounded: { ...row.carrier.rounded!, output: { ...output, source_edges: wrongEdges } },
        },
      }),
    ).toThrow();
    const roundedInput = roundedFixture(row.carrier);
    const oracle = buildRoundedFillOracle(roundedInput);
    if (!oracle.ok) throw new Error(`mixed corruption oracle failed: ${oracle.reason}`);
    expect(() =>
      verifyRoundedFillCarrier(roundedInput, oracle, {
        ...output,
        contributors: [8, ...output.contributors.slice(1)],
      }),
    ).toThrow();
    const cells = output.cells.map((cell, index) =>
      index === 0 ? { ...cell, lower_after: cell.lower_after + 1 } : cell,
    );
    expect(() => assertCarrierMatches(oracle.carrier, { ...output, cells })).toThrow(
      'cells mismatch',
    );
    const ranges = output.cells.map((cell, index) =>
      index === 0
        ? {
            ...cell,
            lower_sources: { ...cell.lower_sources, start: cell.lower_sources.start + 1 },
          }
        : cell,
    );
    expect(() => assertCarrierMatches(oracle.carrier, { ...output, cells: ranges })).toThrow(
      'cells mismatch',
    );
    expect(inspectTriangleMesh({ ...output, expectedArea: 35 })).toEqual({
      valid: false,
      issue: 'AREA_MISMATCH',
    });
  });

  it('rejects malformed masks and marked shape before composition, and old input rejects a mask', () => {
    const source = encodeNativeMixedCubicFixture(fixtureRows);
    const firstLine = source.split('\n')[2]!;
    const malformed: Array<readonly [string, string, string]> = [
      [
        'header',
        source.replace('# p3-native-mixed-cubic-v1', '# p3-native-mixed-cubic-v0'),
        'invalid fixture header',
      ],
      ['row-count', source.replace('# rows 4', '# rows 3'), 'invalid fixture row count header'],
      ['mask-missing', source.replace(' OK 10000000 |', ' OK |'), 'invalid fixture row header'],
      [
        'mask-extra',
        source.replace(' OK 10000000 |', ' OK 10000000 extra |'),
        'invalid fixture row header',
      ],
      [
        'mask-length',
        source.replace(' OK 10000000 |', ' OK 1000000 |'),
        'invalid source kind mask',
      ],
      [
        'mask-nonbinary',
        source.replace(' OK 10000000 |', ' OK 10002000 |'),
        'invalid source kind mask',
      ],
    ];
    const firstCubic = fixtureRows[0]!.sourceBits[0]![0]!.join(',');
    const changed = [...fixtureRows[0]!.sourceBits[0]![0]!];
    changed[2] = changed[2] === 'c008000000000000' ? 'c000000000000000' : 'c008000000000000';
    malformed.push([
      'marked-shape',
      source.replace(firstLine, firstLine.replace(firstCubic, changed.join(','))),
      'marked LINE source shape invalid',
    ]);
    for (const [label, corrupted, expectedError] of malformed) {
      const result = runNative(corrupted, {
        ...mixedTarget,
        directoryPrefix: `p3-native-mixed-cubic-bad-${label}-`,
      });
      if (result.error) throw result.error;
      const combined = result.stdout + result.stderr;
      expect(result.status, `${label}\n${combined}`).not.toBe(0);
      expect(combined, label).toContain(expectedError);
      expect(combined, label).not.toContain('P3_NATIVE_MIXED_CUBIC_BEGIN');
    }

    const oldRows = fixedNativeCubicFixtureRows();
    const oldSource = encodeNativeCubicFixture(oldRows);
    const oldCount = oldRows[0]!.sourceBits.reduce((sum, contour) => sum + contour.length, 0);
    const injected = oldSource.replace(
      /^([^\r\n]+? (?:OK|PATH_NUMERIC_RANGE)) \|/mu,
      `$1 ${'0'.repeat(oldCount)} |`,
    );
    const oldResult = runNative(injected, {
      testName: 'native_cubic_fill_tests::emit_native_cubic_fill',
      environmentName: 'P3_NATIVE_CUBIC_INPUT',
      directoryPrefix: 'p3-native-cubic-reject-mask-',
    });
    if (oldResult.error) throw oldResult.error;
    const oldCombined = oldResult.stdout + oldResult.stderr;
    expect(oldResult.status, oldCombined).not.toBe(0);
    expect(oldCombined).toContain('invalid fixture row header');
    expect(oldCombined).not.toContain('P3_NATIVE_CUBIC_BEGIN');
  });

  it('rejects missing, extra, duplicate, reordered, and incorrectly marked frames', () => {
    const lines = nativeRows.map((row) => JSON.stringify(row));
    const frame = (body: readonly string[]) =>
      `P3_NATIVE_MIXED_CUBIC_BEGIN\n${body.join('\n')}\nP3_NATIVE_MIXED_CUBIC_END`;
    expect(() => parseStrictFrame(frame(lines.slice(1)))).toThrow('row count');
    expect(() => parseStrictFrame(frame([...lines, lines[0]!]))).toThrow('row count');
    expect(() => parseStrictFrame(frame([lines[0]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'duplicate row identity',
    );
    expect(() => parseStrictFrame(frame([lines[1]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'row order',
    );
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_MIXED_CUBIC_BEGIN', 'WRONG_BEGIN')),
    ).toThrow('begin marker');
    expect(() =>
      parseStrictFrame(
        frame(lines).replace(
          'P3_NATIVE_MIXED_CUBIC_BEGIN',
          'P3_NATIVE_MIXED_CUBIC_BEGIN\nP3_NATIVE_MIXED_CUBIC_BEGIN',
        ),
      ),
    ).toThrow('begin marker');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_MIXED_CUBIC_END', 'WRONG_END')),
    ).toThrow('end marker');
    expect(() =>
      parseStrictFrame(
        frame(lines).replace(
          'P3_NATIVE_MIXED_CUBIC_END',
          'P3_NATIVE_MIXED_CUBIC_END\nP3_NATIVE_MIXED_CUBIC_END',
        ),
      ),
    ).toThrow('end marker');
  });
});
