import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectTriangleMesh } from '../../packages/geometry-reference/src/triangle-mesh.js';
import {
  encodeNativeNonlinearTransverseCubicFixture,
  fixedNativeNonlinearTransverseCubicFixtureRows,
} from './native-nonlinear-transverse-cubic/fixtures.js';
import {
  parseNativeNonlinearTransverseCubicRow,
  parseNativeNonlinearTransverseCubicValue,
  type NativeNonlinearTransverseCubicRow,
} from './native-nonlinear-transverse-cubic/native.js';
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
import { assertNativeTransverseCubicCarrier } from './native-transverse-cubic/verify.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeNonlinearTransverseCubicFixtureRows();

function cubicCoordinate(values: readonly [number, number, number, number], t: number): number {
  const u = 1 - t;
  return (
    u * u * u * values[0] +
    3 * u * u * t * values[1] +
    3 * u * t * t * values[2] +
    t * t * t * values[3]
  );
}

function controlDeterminants(
  cubic: (typeof fixtureRows)[number]['contours'][number]['cubics'][number],
) {
  const [start, one, two, end] = cubic;
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  return [
    dx * (one[1] - start[1]) - dy * (one[0] - start[0]),
    dx * (two[1] - start[1]) - dy * (two[0] - start[0]),
  ] as const;
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
      'native_cubic_fill_tests::emit_nonlinear_transverse_native_cubic_fill',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_NATIVE_NONLINEAR_TRANSVERSE_CUBIC_INPUT: input },
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

function parseStrictFrame(stdout: string): readonly NativeNonlinearTransverseCubicRow[] {
  if ((stdout.match(/P3_NATIVE_NONLINEAR_TRANSVERSE_CUBIC_BEGIN/gu) ?? []).length !== 1)
    throw new Error('native nonlinear transverse cubic begin marker count mismatch');
  if ((stdout.match(/P3_NATIVE_NONLINEAR_TRANSVERSE_CUBIC_END/gu) ?? []).length !== 1)
    throw new Error('native nonlinear transverse cubic end marker count mismatch');
  const frame =
    /P3_NATIVE_NONLINEAR_TRANSVERSE_CUBIC_BEGIN\r?\n([\s\S]*?)\r?\nP3_NATIVE_NONLINEAR_TRANSVERSE_CUBIC_END/u.exec(
      stdout,
    );
  if (!frame) throw new Error('native nonlinear transverse cubic frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  if (lines.length !== 8) throw new Error('native nonlinear transverse cubic row count mismatch');
  const rows = lines.map(parseNativeNonlinearTransverseCubicRow);
  const identities = rows.map(({ carrier }) => `${carrier.id}:${carrier.rule}`);
  if (new Set(identities).size !== rows.length)
    throw new Error('native nonlinear transverse cubic duplicate row identity');
  const expectedIdentities = fixtureRows.map(({ id, rule }) => `${id}:${rule}`);
  if (JSON.stringify(identities) !== JSON.stringify(expectedIdentities))
    throw new Error('native nonlinear transverse cubic row order mismatch');
  return rows;
}

function captureRows(): readonly NativeNonlinearTransverseCubicRow[] {
  const result = runEmitter(
    encodeNativeNonlinearTransverseCubicFixture(fixtureRows),
    'p3-native-nonlinear-transverse-cubic-',
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return parseStrictFrame(result.stdout);
}

let nativeRows: readonly NativeNonlinearTransverseCubicRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2u nonlinear transverse cubic composition', () => {
  it('freezes the exact eight-row inventory, nonlinear controls, closure forms, and metadata', () => {
    expect(fixtureRows.map(({ id, rule }) => `${id}:${rule}`)).toEqual([
      'nonlinear/bowtie:nonzero',
      'nonlinear/bowtie:evenodd',
      'nonlinear/closure:nonzero',
      'nonlinear/closure:evenodd',
      'nonlinear/reflected:nonzero',
      'nonlinear/reflected:evenodd',
      'nonlinear/subdivided:nonzero',
      'nonlinear/subdivided:evenodd',
    ]);
    expect(fixtureRows.map(({ expectedArea }) => expectedArea)).toEqual([
      36,
      36,
      36,
      36,
      9,
      9,
      585 / 16,
      585 / 16,
    ]);
    const nonlinear = fixtureRows[0]!;
    expect(nonlinear.contours[0]!.cubics[0]).toEqual([
      [-3, -3],
      [-1, -1 + 1 / 16],
      [1, 1 - 1 / 16],
      [3, 3],
    ]);
    expect(nonlinear.contours[0]!.cubics[4]).toEqual([
      [-3, 3],
      [-1, 1 + 1 / 16],
      [1, -1 - 1 / 16],
      [3, -3],
    ]);
    const edge0 = nonlinear.contours[0]!.cubics[0]!;
    const edge4 = nonlinear.contours[0]!.cubics[4]!;
    expect(controlDeterminants(edge0)).toEqual([3 / 8, -3 / 8]);
    expect(controlDeterminants(edge4)).toEqual([3 / 8, -3 / 8]);
    const yAtQuarter = cubicCoordinate([edge0[0][1], edge0[1][1], edge0[2][1], edge0[3][1]], 1 / 4);
    expect(yAtQuarter - (-3 + 6 / 4)).toBe(9 / 512);
    expect(nonlinear.contours[0]!.closeVerbOrdinal).toBe(9);
    expect(fixtureRows[2]!.contours[0]!.closeVerbOrdinal).toBeNull();
    expect(fixtureRows[2]!.contours[0]!.cubics).toHaveLength(7);
    expect(fixtureRows[2]!.expectedLeafPartitions).toEqual([[1, 1, 1, 1, 1, 1, 1]]);
    expect(fixtureRows[4]!.expectedCrossingNodes).toEqual([[12, -8]]);
    expect(fixtureRows[6]!.contours[0]!.cubics[2]).toEqual([
      [3, 9 / 2],
      [1, 19 / 4],
      [-1, 19 / 4],
      [-3, 9 / 2],
    ]);
    expect(fixtureRows[6]!.expectedPolygons[0]![3]).toEqual([0, 75 / 16]);
    expect(fixtureRows[6]!.expectedLeafPartitions).toEqual([[1, 1, 2, 1, 1, 1, 1, 1]]);
    expect(fixtureRows[6]!.expectedTopology).toEqual({ leaves: 9, pairs: 36 });
    expect(fixtureRows[6]!.expectedVisits).toBe(10);
    expect(
      fixtureRows.reduce(
        (sum, fixture) =>
          sum + fixture.contours.reduce((subtotal, contour) => subtotal + contour.cubics.length, 0),
        0,
      ),
    ).toBe(62);
    expect(
      fixtureRows.map(({ contours }) =>
        contours.reduce((sum, contour) => sum + 2 + contour.cubics.length * 6, 0),
      ),
    ).toEqual([50, 50, 44, 44, 50, 50, 50, 50]);
    const source = encodeNativeNonlinearTransverseCubicFixture(fixtureRows);
    expect(source).toMatch(/^# p3-native-cubic-v1\n# rows 8\n/u);
    expect(() => encodeNativeNonlinearTransverseCubicFixture(fixtureRows.slice(1))).toThrow('8');
    expect(fixtureRows.every(({ expectation }) => expectation === 'OK')).toBe(true);
  });

  it.each(fixtureRows)(
    '$id:$rule preserves nonlinear source, proof, ownership, and full mesh',
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

  it('strictly rejects wrapper fields, route contradictions, errors, and family stats', () => {
    const regular = nativeRows[0]!;
    const subdivided = nativeRows[6]!;
    const { topology: omittedTopology, ...missingTopology } = regular;
    void omittedTopology;
    expect(() => parseNativeNonlinearTransverseCubicValue(missingTopology, 0)).toThrow(
      'keys mismatch',
    );
    expect(() => parseNativeNonlinearTransverseCubicValue({ ...regular, extra: 1 }, 0)).toThrow(
      'keys mismatch',
    );
    const { transverse_topology_selected: omittedRoute, ...missingRoute } = regular.topology;
    void omittedRoute;
    expect(() =>
      parseNativeNonlinearTransverseCubicValue({ ...regular, topology: missingRoute }, 0),
    ).toThrow('keys mismatch');
    expect(() =>
      parseNativeNonlinearTransverseCubicValue(
        { ...regular, topology: { ...regular.topology, extra: 1 } },
        0,
      ),
    ).toThrow('keys mismatch');
    expect(() =>
      parseNativeNonlinearTransverseCubicValue(
        {
          ...regular,
          topology: { ...regular.topology, transverse_topology_selected: false },
        },
        0,
      ),
    ).toThrow('route contradiction');
    expect(() =>
      parseNativeNonlinearTransverseCubicValue(
        { ...subdivided, topology: { ...subdivided.topology, stats: { leaves: 8, pairs: 28 } } },
        6,
      ),
    ).toThrow('stats mismatch');
    expect(() => parseNativeNonlinearTransverseCubicValue(regular, 8)).toThrow('fixed inventory');
  });

  it('rejects nonlinear bits, S midpoint, and ordinal/depth/end provenance independently', () => {
    const fixture = fixtureRows[6]!;
    const actual = nativeRows[6]!;
    const row = actual.carrier;
    if (!row.commands) throw new Error('subdivided commands missing');
    const changedBits = row.source_bits.map((contour) => contour.map((cubic) => [...cubic]));
    changedBits[0]![0]![2] = '0000000000000000';
    expect(() => assertFixtureIdentity(fixture, { ...row, source_bits: changedBits })).toThrow(
      'source bits mismatch',
    );
    const midpointIndex = row.commands.findIndex(
      ({ provenance }) =>
        provenance.source_verb === 3 && provenance.depth === 1 && provenance.end_numerator === 1,
    );
    expect(midpointIndex).toBeGreaterThan(0);
    const changedMidpoint = structuredClone(row.commands) as NativeCubicCommand[];
    changedMidpoint[midpointIndex] = {
      ...changedMidpoint[midpointIndex]!,
      point: [0, 37 / 8],
    };
    expect(() =>
      assertNativeTransverseCubicCarrier(fixture, {
        ...actual,
        carrier: { ...row, commands: changedMidpoint },
      }),
    ).toThrow();
    for (const [label, provenance] of [
      ['ordinal', { source_verb: 99, end_numerator: 1, depth: 0 }],
      ['end', { source_verb: 1, end_numerator: 2, depth: 0 }],
      ['depth', { source_verb: 1, end_numerator: 1, depth: 1 }],
    ] as const) {
      const commands = structuredClone(row.commands) as NativeCubicCommand[];
      const firstLine = commands.findIndex(({ verb }) => verb === 1);
      commands[firstLine] = { ...commands[firstLine]!, provenance };
      expect(() => actualSegments(fixture, commands), label).toThrow();
    }
  });

  it('rejects crossing sign/index and owner identity corruption against independent proofs', () => {
    const fixture = fixtureRows[0]!;
    const actual = nativeRows[0]!;
    const wrongSign = {
      ...fixture,
      expectedCrossings: [{ leftLeaf: 0, rightLeaf: 4, orientation: 1 as const }],
    };
    const wrongIndex = {
      ...fixture,
      expectedCrossings: [{ leftLeaf: 0, rightLeaf: 3, orientation: -1 as const }],
    };
    expect(() => assertNativeTransverseCubicCarrier(wrongSign, actual)).toThrow();
    expect(() => assertNativeTransverseCubicCarrier(wrongIndex, actual)).toThrow();
    const row = actual.carrier;
    if (!row.commands) throw new Error('bowtie commands missing');
    const segments = actualSegments(fixture, row.commands);
    const points = collectedContours(segments);
    const owners = expectedOwners(fixture, segments);
    const firstOwner = owners[0];
    if (firstOwner?.kind !== 'CubicLeaf') throw new Error('first owner is not cubic');
    expect(() =>
      assertOwnerMapping([{ ...firstOwner, source_verb: 99 }, ...owners.slice(1)], points, row),
    ).toThrow('owner mapping');
  });

  it('rejects contributor, range, and analytic fill-area corruption independently', () => {
    const row = nativeRows[6]!.carrier;
    if (!row.rounded?.output) throw new Error('subdivided rounded carrier missing');
    const roundedInput = roundedFixture(row);
    const oracle = buildRoundedFillOracle(roundedInput);
    if (!oracle.ok) throw new Error(`subdivided oracle failed: ${oracle.reason}`);
    expect(() =>
      verifyRoundedFillCarrier(roundedInput, oracle, {
        ...row.rounded!.output!,
        contributors: [9, ...row.rounded!.output!.contributors.slice(1)],
      }),
    ).toThrow();
    const cells = row.rounded.output.cells.map((cell, index) =>
      index === 0
        ? {
            ...cell,
            lower_sources: { ...cell.lower_sources, start: cell.lower_sources.start + 1 },
          }
        : cell,
    );
    expect(() => assertCarrierMatches(oracle.carrier, { ...row.rounded!.output!, cells })).toThrow(
      'cells mismatch',
    );
    expect(inspectTriangleMesh({ ...row.rounded.output, expectedArea: 36 })).toEqual({
      valid: false,
      issue: 'AREA_MISMATCH',
    });
  });

  it('rejects wrong source headers and declared row counts before composition', () => {
    const source = encodeNativeNonlinearTransverseCubicFixture(fixtureRows);
    for (const [label, corrupted] of [
      ['header', source.replace('# p3-native-cubic-v1', '# p3-native-cubic-v0')],
      ['row-count', source.replace('# rows 8', '# rows 7')],
    ] as const) {
      const result = runEmitter(corrupted, `p3-native-nonlinear-transverse-cubic-bad-${label}-`);
      if (result.error) throw result.error;
      const combined = result.stdout + result.stderr;
      expect(result.status, `${label}\n${combined}`).not.toBe(0);
      expect(combined, label).not.toContain('P3_NATIVE_NONLINEAR_TRANSVERSE_CUBIC_BEGIN');
    }
  });

  it('rejects missing, extra, duplicate, reordered, and incorrectly marked frames', () => {
    const lines = nativeRows.map((row) => JSON.stringify(row));
    const frame = (body: readonly string[]) =>
      `P3_NATIVE_NONLINEAR_TRANSVERSE_CUBIC_BEGIN\n${body.join('\n')}\nP3_NATIVE_NONLINEAR_TRANSVERSE_CUBIC_END`;
    expect(() => parseStrictFrame(frame(lines.slice(1)))).toThrow('row count');
    expect(() => parseStrictFrame(frame([...lines, lines[0]!]))).toThrow('row count');
    expect(() => parseStrictFrame(frame([lines[0]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'duplicate row identity',
    );
    expect(() => parseStrictFrame(frame([lines[1]!, lines[0]!, ...lines.slice(2)]))).toThrow(
      'row order',
    );
    expect(() =>
      parseStrictFrame(
        frame(lines).replace('P3_NATIVE_NONLINEAR_TRANSVERSE_CUBIC_BEGIN', 'WRONG_BEGIN'),
      ),
    ).toThrow('begin marker');
    expect(() =>
      parseStrictFrame(
        frame(lines).replace('P3_NATIVE_NONLINEAR_TRANSVERSE_CUBIC_END', 'WRONG_END'),
      ),
    ).toThrow('end marker');
  });
});
