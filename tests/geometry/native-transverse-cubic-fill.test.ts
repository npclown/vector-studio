import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectTriangleMesh } from '../../packages/geometry-reference/src/triangle-mesh.js';
import {
  encodeNativeTransverseCubicFixture,
  fixedNativeTransverseCubicFixtureRows,
} from './native-transverse-cubic/fixtures.js';
import {
  parseNativeTransverseCubicRow,
  parseNativeTransverseCubicValue,
  type NativeTransverseCubicRow,
} from './native-transverse-cubic/native.js';
import type { NativeCubicCommand } from './native-cubic/native.js';
import {
  actualSegments,
  assertFixtureIdentity,
  assertOwnerMapping,
  collectedContours,
  expectedOwners,
  roundedFixture,
} from './native-cubic/verify.js';
import {
  assertCarrierMatches,
  buildRoundedFillOracle,
  verifyRoundedFillCarrier,
} from './rounded-fill/oracle.js';
import {
  assertLiteralPolygons,
  assertNativeTransverseCubicCarrier,
} from './native-transverse-cubic/verify.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeTransverseCubicFixtureRows();
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
      'native_cubic_fill_tests::emit_transverse_native_cubic_fill',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_NATIVE_TRANSVERSE_CUBIC_INPUT: input },
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

function parseStrictFrame(stdout: string): readonly NativeTransverseCubicRow[] {
  if ((stdout.match(/P3_NATIVE_TRANSVERSE_CUBIC_BEGIN/gu) ?? []).length !== 1)
    throw new Error('native transverse cubic begin marker count mismatch');
  if ((stdout.match(/P3_NATIVE_TRANSVERSE_CUBIC_END/gu) ?? []).length !== 1)
    throw new Error('native transverse cubic end marker count mismatch');
  const frame =
    /P3_NATIVE_TRANSVERSE_CUBIC_BEGIN\r?\n([\s\S]*?)\r?\nP3_NATIVE_TRANSVERSE_CUBIC_END/u.exec(
      stdout,
    );
  if (!frame) throw new Error('native transverse cubic frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  if (lines.length !== 6) throw new Error('native transverse cubic row count mismatch');
  const rows = lines.map(parseNativeTransverseCubicRow);
  const identities = rows.map(({ carrier }) => `${carrier.id}:${carrier.rule}`);
  if (new Set(identities).size !== rows.length)
    throw new Error('native transverse cubic duplicate row identity');
  const expectedIdentities = fixtureRows.map(({ id, rule }) => `${id}:${rule}`);
  if (JSON.stringify(identities) !== JSON.stringify(expectedIdentities))
    throw new Error('native transverse cubic row order mismatch');
  return rows;
}

function captureRows(): readonly NativeTransverseCubicRow[] {
  const result = runEmitter(
    encodeNativeTransverseCubicFixture(fixtureRows),
    'p3-native-transverse-cubic-',
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return parseStrictFrame(result.stdout);
}

let nativeRows: readonly NativeTransverseCubicRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2t explicit private transverse cubic composition', () => {
  it('freezes the exact six-row source grammar, order, closure forms, and literal areas', () => {
    expect(fixtureRows.map(({ id, rule }) => `${id}:${rule}`)).toEqual([
      'composition/bowtie:nonzero',
      'composition/bowtie:evenodd',
      'composition/closure:nonzero',
      'composition/closure:evenodd',
      'composition/squares:nonzero',
      'composition/squares:evenodd',
    ]);
    expect(fixtureRows.map(({ expectedArea }) => expectedArea)).toEqual([36, 36, 36, 36, 63, 54]);
    expect(fixtureRows[0]!.contours[0]!.closeVerbOrdinal).toBe(9);
    expect(fixtureRows[2]!.contours[0]!.closeVerbOrdinal).toBeNull();
    expect(fixtureRows[4]!.contours.map(({ closeVerbOrdinal }) => closeVerbOrdinal)).toEqual([
      5, 11,
    ]);
    expect(fixtureRows[2]!.contours[0]!.cubics).toHaveLength(7);
    expect(fixtureRows[2]!.contours[0]!.cubics.at(-1)!.at(-1)).not.toEqual(
      fixtureRows[2]!.contours[0]!.cubics[0]![0],
    );
    for (const fixture of fixtureRows) {
      for (const cubic of fixture.contours.flatMap(({ cubics }) => cubics)) {
        const [start, one, two, end] = cubic;
        expect(one).toEqual([(2 * start[0] + end[0]) / 3, (2 * start[1] + end[1]) / 3]);
        expect(two).toEqual([(start[0] + 2 * end[0]) / 3, (start[1] + 2 * end[1]) / 3]);
      }
    }
    const source = encodeNativeTransverseCubicFixture(fixtureRows);
    expect(source).toMatch(/^# p3-native-cubic-v1\n# rows 6\n/u);
    expect(() => encodeNativeTransverseCubicFixture(fixtureRows.slice(1))).toThrow('6');
    expect(fixtureRows.every(({ expectation }) => expectation === 'OK')).toBe(true);
  });

  it.each(fixtureRows)(
    '$id:$rule preserves source, transverse proof, ownership, and full mesh',
    (fixture) => {
      const row = nativeRows[fixtureRows.indexOf(fixture)]!;
      expect(() => assertNativeTransverseCubicCarrier(fixture, row)).not.toThrow();
    },
  );

  it('keeps retained storage stable and every measured attempt allocation-free', () => {
    expect(new Set(nativeRows.map(({ carrier }) => carrier.inline_bytes)).size).toBe(1);
    expect(new Set(nativeRows.map(({ carrier }) => carrier.allocated_bytes)).size).toBe(1);
    expect(nativeRows.every(({ carrier }) => carrier.inline_bytes < 64 * 1024)).toBe(true);
    expect(nativeRows.every(({ carrier }) => carrier.allocated_bytes <= 16 * 1024 * 1024)).toBe(
      true,
    );
    expect(nativeRows.every(({ carrier }) => carrier.allocations === 0)).toBe(true);
  });

  it('strictly rejects wrapper fields, route contradictions, errors, and incorrect stats', () => {
    const row = nativeRows[0]!;
    const { topology: omittedTopology, ...missingTopology } = row;
    void omittedTopology;
    expect(() => parseNativeTransverseCubicValue(missingTopology, 0)).toThrow('keys mismatch');
    expect(() => parseNativeTransverseCubicValue({ ...row, extra: 1 }, 0)).toThrow('keys mismatch');
    const { transverse_topology_selected: omittedRoute, ...missingRoute } = row.topology;
    void omittedRoute;
    expect(() => parseNativeTransverseCubicValue({ ...row, topology: missingRoute }, 0)).toThrow(
      'keys mismatch',
    );
    expect(() =>
      parseNativeTransverseCubicValue({ ...row, topology: { ...row.topology, extra: 1 } }, 0),
    ).toThrow('keys mismatch');
    expect(() =>
      parseNativeTransverseCubicValue(
        { ...row, topology: { ...row.topology, transverse_topology_invoked: false } },
        0,
      ),
    ).toThrow('route contradiction');
    expect(() =>
      parseNativeTransverseCubicValue(
        { ...row, topology: { ...row.topology, rounded_topology_invoked: true } },
        0,
      ),
    ).toThrow('route contradiction');
    expect(() =>
      parseNativeTransverseCubicValue(
        { ...row, topology: { ...row.topology, transverse_topology_error: 'Unresolved' } },
        0,
      ),
    ).toThrow('route contradiction');
    expect(() =>
      parseNativeTransverseCubicValue(
        { ...row, topology: { ...row.topology, transverse_topology_error: 'bad' } },
        0,
      ),
    ).toThrow('invalid');
    expect(() =>
      parseNativeTransverseCubicValue(
        { ...row, topology: { ...row.topology, stats: { leaves: 8, pairs: 27 } } },
        0,
      ),
    ).toThrow('stats mismatch');
  });

  it('rejects corrupted source bits, ordinal/depth/end provenance, points, ranges, and owners', () => {
    const fixture = fixtureRows[0]!;
    const actual = nativeRows[0]!;
    const row = actual.carrier;
    if (!row.commands || !row.edge_owners || !row.rounded?.output)
      throw new Error('bowtie carrier missing');
    const changedBits = row.source_bits.map((contour) => contour.map((cubic) => [...cubic]));
    changedBits[0]![0]![0] = '0000000000000000';
    expect(() => assertFixtureIdentity(fixture, { ...row, source_bits: changedBits })).toThrow(
      'source bits mismatch',
    );
    const firstLine = row.commands.findIndex(({ verb }) => verb === 1);
    for (const [label, provenance] of [
      ['ordinal', { source_verb: 99, end_numerator: 1, depth: 0 }],
      ['end', { source_verb: 1, end_numerator: 2, depth: 0 }],
      ['depth', { source_verb: 1, end_numerator: 1, depth: 1 }],
    ] as const) {
      const commands = structuredClone(row.commands) as NativeCubicCommand[];
      commands[firstLine] = { ...commands[firstLine]!, provenance };
      expect(() => actualSegments(fixture, commands), label).toThrow();
    }
    const changedEnd = structuredClone(row.commands) as NativeCubicCommand[];
    const end = changedEnd[firstLine]!.point!;
    changedEnd[firstLine] = { ...changedEnd[firstLine]!, point: [end[0] + 1, end[1]] };
    expect(() => actualSegments(fixture, changedEnd)).toThrow(/boundary/u);
    const segments = actualSegments(fixture, row.commands);
    const points = collectedContours(segments);
    const owners = expectedOwners(fixture, segments);
    const firstOwner = owners[0];
    if (firstOwner?.kind !== 'CubicLeaf') throw new Error('first bowtie owner is not cubic');
    expect(() =>
      assertOwnerMapping([{ ...firstOwner, source_verb: 99 }, ...owners.slice(1)], points, row),
    ).toThrow('owner mapping');
    expect(() =>
      assertOwnerMapping(owners, points, {
        ...row,
        rounded: {
          ...row.rounded!,
          output: {
            ...row.rounded!.output!,
            source_edges: [
              { ...row.rounded!.output!.source_edges[0]!, start_vertex: 1 },
              ...row.rounded!.output!.source_edges.slice(1),
            ],
          },
        },
      }),
    ).toThrow('source edge order');
    const contours = row.rounded.contours.map((contour) => [...contour]);
    contours[0]![0] = [contours[0]![0]![0] + 1, contours[0]![0]![1]];
    expect(() =>
      assertLiteralPolygons(fixture, { ...row, rounded: { ...row.rounded!, contours } }),
    ).toThrow('polygon bits');
    expect(() =>
      assertOwnerMapping(owners, points, {
        ...row,
        rounded: {
          ...row.rounded!,
          output: {
            ...row.rounded!.output!,
            source_edges: row.rounded!.output!.source_edges.slice(1),
          },
        },
      }),
    ).toThrow('source edge order');
  });

  it('rejects contributor, occupancy, and fill-area corruption independently', () => {
    const row = nativeRows[4]!.carrier;
    if (!row.rounded?.output) throw new Error('squares rounded carrier missing');
    const roundedInput = roundedFixture(row);
    const oracle = buildRoundedFillOracle(roundedInput);
    if (!oracle.ok) throw new Error(`squares oracle failed: ${oracle.reason}`);
    expect(() =>
      verifyRoundedFillCarrier(roundedInput, oracle, {
        ...row.rounded!.output!,
        contributors: [8, ...row.rounded!.output!.contributors.slice(1)],
      }),
    ).toThrow();
    const wrongRange = row.rounded.output.cells.map((cell, index) =>
      index === 0
        ? {
            ...cell,
            lower_sources: { ...cell.lower_sources, start: cell.lower_sources.start + 1 },
          }
        : cell,
    );
    expect(() =>
      assertCarrierMatches(oracle.carrier, { ...row.rounded!.output!, cells: wrongRange }),
    ).toThrow('cells mismatch');
    const cells = row.rounded.output.cells.map((cell, index) =>
      index === 0 ? { ...cell, lower_after: cell.lower_after + 1 } : cell,
    );
    expect(() => assertCarrierMatches(oracle.carrier, { ...row.rounded!.output!, cells })).toThrow(
      'cells mismatch',
    );
    expect(inspectTriangleMesh({ ...row.rounded.output, expectedArea: 54 })).toEqual({
      valid: false,
      issue: 'AREA_MISMATCH',
    });
  });

  it('rejects wrong source headers and declared row counts before composition', () => {
    const source = encodeNativeTransverseCubicFixture(fixtureRows);
    for (const [label, corrupted] of [
      ['header', source.replace('# p3-native-cubic-v1', '# p3-native-cubic-v0')],
      ['row-count', source.replace('# rows 6', '# rows 5')],
    ] as const) {
      const result = runEmitter(corrupted, `p3-native-transverse-cubic-bad-${label}-`);
      if (result.error) throw result.error;
      const combined = result.stdout + result.stderr;
      expect(result.status, `${label}\n${combined}`).not.toBe(0);
      expect(combined, label).not.toContain('P3_NATIVE_TRANSVERSE_CUBIC_BEGIN');
    }
  });

  it('rejects missing, extra, duplicate, reordered, and incorrectly marked frames', () => {
    const lines = nativeRows.map((row) => JSON.stringify(row));
    const frame = (body: readonly string[]) =>
      `P3_NATIVE_TRANSVERSE_CUBIC_BEGIN\n${body.join('\n')}\nP3_NATIVE_TRANSVERSE_CUBIC_END`;
    expect(() => parseStrictFrame(frame(lines.slice(1)))).toThrow('row count');
    expect(() => parseStrictFrame(frame([...lines, lines[0]!]))).toThrow('row count');
    expect(() => parseStrictFrame(frame([lines[0]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'duplicate row identity',
    );
    expect(() => parseStrictFrame(frame([lines[1]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'row order',
    );
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_TRANSVERSE_CUBIC_BEGIN', 'WRONG_BEGIN')),
    ).toThrow('begin marker');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_TRANSVERSE_CUBIC_END', 'WRONG_END')),
    ).toThrow('end marker');
  });
});
