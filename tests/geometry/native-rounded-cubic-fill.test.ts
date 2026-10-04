import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Point } from '../../packages/geometry-reference/src/types.js';
import { inspectTriangleMesh } from '../../packages/geometry-reference/src/triangle-mesh.js';
import {
  fixedNativeRoundedCubicFixtureRows,
  encodeNativeRoundedCubicFixture,
  type NativeRoundedCubicFixtureRow,
} from './native-rounded-cubic/fixtures.js';
import {
  parseNativeCubicValue,
  type NativeCubicCommand,
  type NativeCubicRow,
} from './native-cubic/native.js';
import {
  actualSegments,
  assertFixtureIdentity,
  assertFlatBounds,
  assertOwnerMapping,
  collectedContours,
  expectedOwners,
  normalizedPoint,
  roundedFixture,
} from './native-cubic/verify.js';
import { bitsOf } from './rounded-fill/exact.js';
import {
  assertCarrierMatches,
  buildRoundedFillOracle,
  verifyRoundedFillCarrier,
} from './rounded-fill/oracle.js';
import {
  certifyRoundedKnotCubicTopology,
  certifySimpleCubicTopology,
} from './simple-cubic-topology/oracle.js';

type TopologyError =
  | 'InvalidLimits'
  | 'AllocationFailed'
  | 'ByteLimit'
  | 'InvalidInput'
  | 'InvalidProvenance'
  | 'KnotMismatch'
  | 'Unresolved'
  | 'WorkLimit';

type AdoptionTopology = Readonly<{
  topology_invoked: boolean;
  rounded_topology_invoked: boolean;
  rounded_topology_selected: boolean;
  rounded_topology_error: TopologyError | null;
  stats: Readonly<{ leaves: number; pairs: number }>;
}>;

type AdoptionRow = Readonly<{ carrier: NativeCubicRow; topology: AdoptionTopology }>;

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeRoundedCubicFixtureRows();
const FLATTEN_BITS = bitsOf(1 / 8)
  .toString(16)
  .padStart(16, '0');
const TOPOLOGY_BITS = bitsOf(1 / 16)
  .toString(16)
  .padStart(16, '0');
const TOPOLOGY_ERRORS = new Set<TopologyError>([
  'InvalidLimits',
  'AllocationFailed',
  'ByteLimit',
  'InvalidInput',
  'InvalidProvenance',
  'KnotMismatch',
  'Unresolved',
  'WorkLimit',
]);

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort()))
    throw new Error(`${label} keys mismatch`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function counter(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    throw new Error(`${label} outside fixed limits`);
  return value as number;
}

function parseAdoptionValue(value: unknown, index: number): AdoptionRow {
  const label = `row ${index}`;
  const item = record(value, label, ['carrier', 'topology']);
  const topology = record(item.topology, `${label}.topology`, [
    'topology_invoked',
    'rounded_topology_invoked',
    'rounded_topology_selected',
    'rounded_topology_error',
    'stats',
  ]);
  const topology_invoked = boolean(topology.topology_invoked, `${label}.topology.topology_invoked`);
  const rounded_topology_invoked = boolean(
    topology.rounded_topology_invoked,
    `${label}.topology.rounded_topology_invoked`,
  );
  const rounded_topology_selected = boolean(
    topology.rounded_topology_selected,
    `${label}.topology.rounded_topology_selected`,
  );
  const rawError = topology.rounded_topology_error;
  if (
    rawError !== null &&
    (typeof rawError !== 'string' || !TOPOLOGY_ERRORS.has(rawError as TopologyError))
  )
    throw new Error(`${label}.topology.rounded_topology_error invalid`);
  const rounded_topology_error = rawError as TopologyError | null;
  if (
    rounded_topology_selected &&
    (!topology_invoked || !rounded_topology_invoked || rounded_topology_error !== null)
  )
    throw new Error(`${label}.topology selected route contradiction`);
  if (rounded_topology_invoked && !topology_invoked)
    throw new Error(`${label}.topology invoked route contradiction`);
  if (!rounded_topology_invoked && (rounded_topology_selected || rounded_topology_error !== null))
    throw new Error(`${label}.topology skipped route contradiction`);
  if (rounded_topology_invoked && rounded_topology_selected === (rounded_topology_error !== null))
    throw new Error(`${label}.topology invoked route contradiction`);
  if (rounded_topology_error !== null && rounded_topology_selected)
    throw new Error(`${label}.topology error route contradiction`);
  const stats = record(topology.stats, `${label}.topology.stats`, ['leaves', 'pairs']);
  return {
    carrier: parseNativeCubicValue(item.carrier, index),
    topology: {
      topology_invoked,
      rounded_topology_invoked,
      rounded_topology_selected,
      rounded_topology_error,
      stats: {
        leaves: counter(stats.leaves, `${label}.topology.stats.leaves`, 64),
        pairs: counter(stats.pairs, `${label}.topology.stats.pairs`, 2016),
      },
    },
  };
}

function parseAdoptionRow(line: string, index: number): AdoptionRow {
  return parseAdoptionValue(JSON.parse(line) as unknown, index);
}

function parseStrictFrame(stdout: string): readonly AdoptionRow[] {
  if ((stdout.match(/P3_NATIVE_ROUNDED_CUBIC_BEGIN/gu) ?? []).length !== 1)
    throw new Error('native rounded cubic begin marker count mismatch');
  if ((stdout.match(/P3_NATIVE_ROUNDED_CUBIC_END/gu) ?? []).length !== 1)
    throw new Error('native rounded cubic end marker count mismatch');
  const frame =
    /P3_NATIVE_ROUNDED_CUBIC_BEGIN\r?\n([\s\S]*?)\r?\nP3_NATIVE_ROUNDED_CUBIC_END/u.exec(stdout);
  if (!frame) throw new Error('native rounded cubic frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  if (lines.length !== 4) throw new Error('native rounded cubic row count mismatch');
  return lines.map(parseAdoptionRow);
}

function captureRows(): readonly AdoptionRow[] {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const tools = path.join(root, '.tools');
  mkdirSync(tools, { recursive: true });
  const directory = mkdtempSync(path.join(tools, 'p3-native-rounded-cubic-'));
  const input = path.join(directory, 'input.txt');
  writeFileSync(input, encodeNativeRoundedCubicFixture(fixtureRows), {
    encoding: 'utf8',
    flag: 'wx',
  });
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
      'native_cubic_fill_tests::emit_rounded_native_cubic_fill',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_NATIVE_ROUNDED_CUBIC_INPUT: input },
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
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return parseStrictFrame(result.stdout);
}

function pointBits(point: Point): readonly [bigint, bigint] {
  return [bitsOf(point[0]), bitsOf(point[1])];
}

function pointBitStrings(points: readonly Point[]): readonly (readonly string[])[] {
  return points.map((point) => pointBits(point).map((value) => value.toString(16)));
}

function signedArea(points: readonly Point[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twice += current[0] * next[1] - current[1] * next[0];
  }
  return twice / 2;
}

function assertAdoptionCarrier(fixture: NativeRoundedCubicFixtureRow, actual: AdoptionRow): void {
  const row = actual.carrier;
  assertFixtureIdentity(fixture, row);
  expect(actual.topology).toEqual({
    topology_invoked: true,
    rounded_topology_invoked: fixture.sourceKind === 'rounded',
    rounded_topology_selected: fixture.sourceKind === 'rounded',
    rounded_topology_error: null,
    stats: { leaves: 12, pairs: 66 },
  });
  expect(row.flat_status).toBe(0);
  expect(row.flatten_tolerance_bits).toBe(FLATTEN_BITS);
  expect(row.topology_tolerance_bits).toBe(TOPOLOGY_BITS);
  expect(row.allocations).toBe(0);
  expect(row.inline_bytes).toBeGreaterThan(0);
  expect(row.inline_bytes).toBeLessThan(64 * 1024);
  expect(row.allocated_bytes).toBeGreaterThan(0);
  expect(row.allocated_bytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  if (!row.commands || !row.emission_plan || !row.rounded?.output)
    throw new Error('rounded adoption carrier is incomplete');
  expect(row.commands).toHaveLength(14);
  expect(row.sizing_plan).toEqual({ status: 0, verb_count: 14, point_count: 26 });
  expect(row.emission_plan).toEqual(row.sizing_plan);
  expect(row.statistics).toEqual({
    logical_cubics: 9,
    sizing_visits: 15,
    emission_visits: 15,
    emitted_cubic_lines: 12,
  });
  assertFlatBounds(row);

  const segments = actualSegments(fixture, row.commands);
  expect(segments).toHaveLength(1);
  expect(segments[0]).toHaveLength(9);
  const upperLines = segments[0]![0]!.lines;
  expect(pointBitStrings(upperLines.map(({ end }) => end))).toEqual(
    pointBitStrings(fixture.expectedUpperLines),
  );
  expect(upperLines.map(({ provenance }) => provenance)).toEqual(
    [1, 2, 3, 4].map((endNumerator) => ({
      sourceVerbOrdinal: 1,
      endNumerator,
      depth: 2,
    })),
  );
  for (let source = 1; source < 9; source += 1) {
    expect(segments[0]![source]!.lines).toEqual([
      {
        end: fixture.contours[0]!.cubics[source]![3],
        provenance: { sourceVerbOrdinal: source + 1, endNumerator: 1, depth: 0 },
      },
    ]);
  }

  const points = collectedContours(segments);
  expect(points.map((contour) => contour.map(normalizedPoint))).toEqual([
    fixture.expectedPolygon.map(normalizedPoint),
  ]);
  expect(signedArea(points[0]!)).toBe(-333 / 64);
  expect(row.rounded.contours.map((contour) => contour.map(normalizedPoint))).toEqual(
    points.map((contour) => contour.map(normalizedPoint)),
  );
  const oldTopology = certifySimpleCubicTopology(segments);
  expect(oldTopology.status).toBe(fixture.sourceKind === 'exact' ? 'CERTIFIED' : 'KNOT_MISMATCH');
  const roundedTopology = certifyRoundedKnotCubicTopology(segments);
  expect(roundedTopology.status).toBe('CERTIFIED');
  expect(roundedTopology.leaves).toBe(12);
  expect(roundedTopology.pairs).toBe(66);
  expect(
    roundedTopology.certificate?.polygons.map((polygon) => polygon.map(normalizedPoint)),
  ).toEqual([fixture.expectedPolygon.map(normalizedPoint)]);
  expect(roundedTopology.certificate?.orientations).toEqual([-1]);
  expect(roundedTopology.certificate?.winding).toEqual([[0]]);

  const owners = expectedOwners(fixture, segments);
  expect(owners).toHaveLength(12);
  assertOwnerMapping(owners, points, row);
  const roundedInput = roundedFixture(row);
  expect(row.rounded.tau_bits).toBe(TOPOLOGY_BITS);
  expect(row.rounded.profile).toBe('I');
  const oracle = buildRoundedFillOracle(roundedInput);
  if (!oracle.ok) throw new Error(`${fixture.id}:${fixture.rule} oracle failed: ${oracle.reason}`);
  verifyRoundedFillCarrier(roundedInput, oracle, row.rounded.output);
  assertCarrierMatches(oracle.carrier, row.rounded.output);
  expect(inspectTriangleMesh({ ...row.rounded.output, expectedArea: 333 / 64 })).toEqual({
    valid: true,
    issue: null,
  });
  expect(row.rounded.stats).toEqual({
    input_vertices: 12,
    edges: 12,
    pair_checks: 66,
    events: oracle.rawEvents,
    columns: row.rounded.output.columns.length,
    sections: row.rounded.output.sections.length,
    nodes: row.rounded.output.nodes.length,
    cells: row.rounded.output.cells.length,
    boundaries: row.rounded.output.boundaries.length,
    contributors: row.rounded.output.contributors.length,
    work_units: row.rounded.stats.work_units,
  });
  expect(row.rounded.stats.work_units).toBeLessThanOrEqual(2_000_000);
  expect(row.rounded.stats.events).toBeLessThanOrEqual(128);
  expect(row.rounded.stats.columns).toBeLessThanOrEqual(36);
  expect(row.rounded.stats.sections).toBeLessThanOrEqual(8320);
  expect(row.rounded.stats.nodes).toBeLessThanOrEqual(256);
  expect(row.rounded.stats.cells).toBeLessThanOrEqual(256);
  expect(row.rounded.stats.boundaries).toBeLessThanOrEqual(512);
  expect(row.rounded.stats.contributors).toBeLessThanOrEqual(512);
  expect(row.rounded.output.vertices.length).toBeLessThanOrEqual(256);
  expect(row.rounded.output.indices.length / 3).toBeLessThanOrEqual(256);
}

let nativeRows: readonly AdoptionRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2o native rounded-knot topology adoption', () => {
  it('freezes the four-row source protocol and literal analytic carrier', () => {
    expect(fixtureRows.map(({ id, rule }) => `${id}:${rule}`)).toEqual([
      'adoption/exact:nonzero',
      'adoption/exact:evenodd',
      'adoption/rounded:nonzero',
      'adoption/rounded:evenodd',
    ]);
    expect(encodeNativeRoundedCubicFixture(fixtureRows)).toMatch(
      /^# p3-native-cubic-v1\n# rows 4\n/u,
    );
    expect(() => encodeNativeRoundedCubicFixture(fixtureRows.slice(1))).toThrow('4');
    for (const fixture of fixtureRows) {
      expect(fixture.contours).toHaveLength(1);
      expect(fixture.contours[0]!.cubics).toHaveLength(9);
      expect(fixture.contours[0]!.moveVerbOrdinal).toBe(0);
      expect(fixture.contours[0]!.cubicVerbOrdinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(fixture.contours[0]!.closeVerbOrdinal).toBe(10);
      expect(fixture.orientations).toEqual([-1]);
      expect(fixture.winding).toEqual([[0]]);
      expect(pointBitStrings(fixture.expectedUpperLines)).toEqual(
        pointBitStrings([
          [3 / 4, 9 / 64],
          [3 / 2, 3 / 8],
          [9 / 4, 27 / 64],
          [3, 0],
        ]),
      );
      expect(signedArea(fixture.expectedPolygon)).toBe(-333 / 64);
    }
  });

  it.each(fixtureRows)('$id:$rule selects and verifies the frozen certificate chain', (fixture) => {
    assertAdoptionCarrier(fixture, nativeRows[fixtureRows.indexOf(fixture)]!);
  });

  it('keeps fixed retained storage and every measured attempt allocation-free', () => {
    expect(new Set(nativeRows.map(({ carrier }) => carrier.inline_bytes)).size).toBe(1);
    expect(new Set(nativeRows.map(({ carrier }) => carrier.allocated_bytes)).size).toBe(1);
    expect(nativeRows.every(({ carrier }) => carrier.allocations === 0)).toBe(true);
  });

  it('strictly rejects malformed frames and adoption diagnostics', () => {
    const lines = nativeRows.map((row) => JSON.stringify(row));
    const frame = (body: readonly string[]) =>
      `P3_NATIVE_ROUNDED_CUBIC_BEGIN\n${body.join('\n')}\nP3_NATIVE_ROUNDED_CUBIC_END`;
    expect(() => parseStrictFrame(frame(lines.slice(1)))).toThrow('row count');
    expect(() => parseStrictFrame(frame([...lines, lines[0]!]))).toThrow('row count');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_ROUNDED_CUBIC_BEGIN', 'WRONG_BEGIN')),
    ).toThrow('begin marker');
    expect(() =>
      parseStrictFrame(frame(lines).replace('P3_NATIVE_ROUNDED_CUBIC_END', 'WRONG_END')),
    ).toThrow('end marker');

    const exact = nativeRows[0]!;
    const rounded = nativeRows[2]!;
    expect(() => parseAdoptionValue({ ...exact, extra: 1 }, 0)).toThrow('keys mismatch');
    expect(() =>
      parseAdoptionValue({ ...exact, topology: { ...exact.topology, extra: 1 } }, 0),
    ).toThrow('keys mismatch');
    expect(() =>
      parseAdoptionValue({ ...exact, topology: { ...exact.topology, topology_invoked: 1 } }, 0),
    ).toThrow('boolean');
    expect(() =>
      parseAdoptionValue(
        { ...exact, topology: { ...exact.topology, rounded_topology_selected: true } },
        0,
      ),
    ).toThrow('contradiction');
    expect(() =>
      parseAdoptionValue(
        {
          ...rounded,
          topology: { ...rounded.topology, rounded_topology_error: 'Unresolved' },
        },
        0,
      ),
    ).toThrow('contradiction');
    expect(() =>
      parseAdoptionValue(
        { ...rounded, topology: { ...rounded.topology, stats: { leaves: 65, pairs: 66 } } },
        0,
      ),
    ).toThrow('fixed limits');
  });

  it('rejects source, command, provenance, route, counter, and mesh corruption', () => {
    const fixture = fixtureRows[2]!;
    const actual = nativeRows[2]!;
    const row = actual.carrier;
    if (!row.commands || !row.rounded?.output) throw new Error('rounded adoption row missing');
    const output = row.rounded.output;

    const changedBits = row.source_bits.map((contour) => contour.map((cubic) => [...cubic]));
    changedBits[0]![0]![3] = '0000000000000000';
    expect(() =>
      assertAdoptionCarrier(fixture, { ...actual, carrier: { ...row, source_bits: changedBits } }),
    ).toThrow('source bits');
    expect(() =>
      assertAdoptionCarrier(fixture, {
        ...actual,
        topology: { ...actual.topology, rounded_topology_selected: false },
      }),
    ).toThrow();
    expect(() =>
      assertAdoptionCarrier(fixture, {
        ...actual,
        topology: { ...actual.topology, stats: { leaves: 12, pairs: 65 } },
      }),
    ).toThrow();

    const wrongCommand = structuredClone(row.commands) as NativeCubicCommand[];
    wrongCommand[0] = { ...wrongCommand[0]!, point: [1, 0] };
    expect(() => actualSegments(fixture, wrongCommand)).toThrow('point mismatch');
    const wrongProvenance = structuredClone(row.commands) as NativeCubicCommand[];
    wrongProvenance[1] = {
      ...wrongProvenance[1]!,
      provenance: { ...wrongProvenance[1]!.provenance, end_numerator: 2 },
    };
    expect(() => actualSegments(fixture, wrongProvenance)).toThrow(/boundary/u);

    const roundedInput = roundedFixture(row);
    const oracle = buildRoundedFillOracle(roundedInput);
    if (!oracle.ok) throw new Error('rounded adoption oracle unexpectedly failed');
    expect(() =>
      assertCarrierMatches(oracle.carrier, {
        ...output,
        indices: output.indices.slice(3),
      }),
    ).toThrow('indices mismatch');
    expect(
      inspectTriangleMesh({
        ...output,
        indices: output.indices.slice(3),
        expectedArea: 333 / 64,
      }).valid,
    ).toBe(false);
  });
});
