import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectTriangleMesh } from '../../packages/geometry-reference/src/triangle-mesh.js';
import { certifyCubicBoundary } from './cubic-boundary/oracle.js';
import { encodeNativeCubicFixture, fixedNativeCubicFixtureRows } from './native-cubic/fixtures.js';
import {
  parseNativeCubicRow,
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
import { certifySimpleCubicTopology } from './simple-cubic-topology/oracle.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixtureRows = fixedNativeCubicFixtureRows();
const successfulFixtures = fixtureRows.filter(({ expectation }) => expectation === 'OK');
const numericRangeFixtures = fixtureRows.filter(
  ({ expectation }) => expectation === 'PATH_NUMERIC_RANGE',
);
const FLATTEN_BITS = bitsOf(1 / 8)
  .toString(16)
  .padStart(16, '0');
const TOPOLOGY_BITS = bitsOf(1 / 16)
  .toString(16)
  .padStart(16, '0');

function nextUp(value: number): number {
  if (!Number.isFinite(value)) throw new Error('finite nextUp input required');
  if (value === 0) return Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  view.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n, false);
  return view.getFloat64(0, false);
}

function captureRows(): readonly NativeCubicRow[] {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const tools = path.join(root, '.tools');
  mkdirSync(tools, { recursive: true });
  const directory = mkdtempSync(path.join(tools, 'p3-native-cubic-'));
  const input = path.join(directory, 'input.txt');
  writeFileSync(input, encodeNativeCubicFixture(fixtureRows), { encoding: 'utf8', flag: 'wx' });
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
      'native_cubic_fill_tests::emit_native_cubic_fill',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_NATIVE_CUBIC_INPUT: input },
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.match(/P3_NATIVE_CUBIC_BEGIN/gu)).toHaveLength(1);
  expect(result.stdout.match(/P3_NATIVE_CUBIC_END/gu)).toHaveLength(1);
  const frame = /P3_NATIVE_CUBIC_BEGIN\r?\n([\s\S]*?)\r?\nP3_NATIVE_CUBIC_END/u.exec(result.stdout);
  if (!frame) throw new Error('native cubic frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  expect(lines).toHaveLength(94);
  return lines.map(parseNativeCubicRow);
}

let nativeRows: readonly NativeCubicRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2f native cubic fill compatibility bridge', () => {
  it('freezes the 94-row source protocol and analytic status split', () => {
    expect(fixtureRows).toHaveLength(94);
    expect(successfulFixtures).toHaveLength(92);
    expect(numericRangeFixtures).toHaveLength(2);
    expect(fixtureRows.map(({ id, rule }) => `${id}:${rule}`)).toEqual(
      fixtureRows.flatMap((row, index) =>
        index % 2 === 0 ? [`${row.id}:nonzero`, `${row.id}:evenodd`] : [],
      ),
    );
    expect(
      encodeNativeCubicFixture(fixtureRows).startsWith('# p3-native-cubic-v1\n# rows 94\n'),
    ).toBe(true);
  });

  it.each(successfulFixtures)(
    '$id:$rule certifies actual flattening, topology, ownership, and mesh',
    (fixture) => {
      const index = fixtureRows.indexOf(fixture);
      const row = nativeRows[index]!;
      assertFixtureIdentity(fixture, row);
      expect(row.flat_status).toBe(0);
      expect(row.flatten_tolerance_bits).toBe(FLATTEN_BITS);
      expect(row.topology_tolerance_bits).toBe(TOPOLOGY_BITS);
      expect(row.allocations).toBe(0);
      expect(row.inline_bytes).toBeLessThan(64 * 1024);
      if (!row.commands || !row.rounded || !row.rounded.output || !row.emission_plan)
        throw new Error('successful native row is incomplete');
      expect(row.sizing_plan).toEqual(row.emission_plan);
      expect(row.sizing_plan).toEqual({
        status: 0,
        verb_count: row.commands.length,
        point_count: row.commands.filter(({ verb }) => verb !== 3).length * 2,
      });
      const sourceCubics = fixture.contours.reduce(
        (sum, contour) => sum + contour.cubics.length,
        0,
      );
      const lineCount = row.commands.filter(({ verb }) => verb === 1).length;
      expect(row.statistics.logical_cubics).toBe(sourceCubics);
      expect(row.statistics.sizing_visits).toBe(2 * lineCount - sourceCubics);
      expect(row.statistics.emission_visits).toBe(row.statistics.sizing_visits);
      expect(row.statistics.emitted_cubic_lines).toBe(lineCount);
      assertFlatBounds(row);

      const segments = actualSegments(fixture, row.commands);
      const depths = segments
        .flat(2)
        .flatMap(({ lines }) => lines.map(({ provenance }) => provenance.depth));
      if (fixture.id === 'extreme/min-subnormal-square')
        expect(depths.every((depth) => depth === 0)).toBe(true);
      else expect(depths.every((depth) => depth <= 2)).toBe(true);
      const points = collectedContours(segments);
      expect(row.rounded.contours.map((contour) => contour.map(normalizedPoint))).toEqual(
        points.map((contour) => contour.map(normalizedPoint)),
      );
      const topology = certifySimpleCubicTopology(segments);
      expect(topology.status).toBe('CERTIFIED');
      expect(topology.certificate?.orientations).toEqual(fixture.orientations);
      expect(topology.certificate?.winding).toEqual(fixture.winding);
      expect(topology.certificate?.polygons.map((contour) => contour.map(normalizedPoint))).toEqual(
        points.map((contour) => contour.map(normalizedPoint)),
      );
      assertOwnerMapping(expectedOwners(fixture, segments), points, row);

      const roundedInput = roundedFixture(row);
      expect(row.rounded.tau_bits).toBe(TOPOLOGY_BITS);
      expect(row.rounded.profile).toBe('I');
      const oracle = buildRoundedFillOracle(roundedInput);
      if (!oracle.ok)
        throw new Error(`${row.id}:${row.rule} rounded oracle failed: ${oracle.reason}`);
      verifyRoundedFillCarrier(roundedInput, oracle, row.rounded.output);
      assertCarrierMatches(oracle.carrier, row.rounded.output);
      expect(inspectTriangleMesh(row.rounded.output)).toEqual({ valid: true, issue: null });
      expect(row.rounded.stats).toEqual({
        input_vertices: points.reduce((sum, contour) => sum + contour.length, 0),
        edges: row.rounded.output.source_edges.length,
        pair_checks:
          (row.rounded.output.source_edges.length * (row.rounded.output.source_edges.length - 1)) /
          2,
        events: oracle.rawEvents,
        columns: row.rounded.output.columns.length,
        sections: row.rounded.output.sections.length,
        nodes: row.rounded.output.nodes.length,
        cells: row.rounded.output.cells.length,
        boundaries: row.rounded.output.boundaries.length,
        contributors: row.rounded.output.contributors.length,
        work_units: row.rounded.stats.work_units,
      });
      expect(row.rounded.stats.input_vertices).toBeLessThanOrEqual(64);
      expect(row.rounded.stats.edges).toBeLessThanOrEqual(64);
      expect(row.rounded.stats.pair_checks).toBeLessThanOrEqual(2016);
      expect(row.rounded.stats.events).toBeLessThanOrEqual(128);
      expect(row.rounded.stats.columns).toBeLessThanOrEqual(36);
      expect(row.rounded.stats.sections).toBeLessThanOrEqual(8320);
      expect(row.rounded.stats.nodes).toBeLessThanOrEqual(256);
      expect(row.rounded.stats.cells).toBeLessThanOrEqual(256);
      expect(row.rounded.stats.boundaries).toBeLessThanOrEqual(512);
      expect(row.rounded.stats.contributors).toBeLessThanOrEqual(512);
      expect(row.rounded.stats.work_units).toBeLessThanOrEqual(2_000_000);
      expect(row.rounded.output.vertices.length).toBeLessThanOrEqual(256);
      expect(row.rounded.output.indices.length / 3).toBeLessThanOrEqual(256);
    },
  );

  it.each(numericRangeFixtures)(
    '$id:$rule fails sizing atomically with PATH_NUMERIC_RANGE',
    (fixture) => {
      const row = nativeRows[fixtureRows.indexOf(fixture)]!;
      assertFixtureIdentity(fixture, row);
      expect(row.flat_status).toBe(4);
      expect(row.flatten_tolerance_bits).toBe(FLATTEN_BITS);
      expect(row.topology_tolerance_bits).toBe(TOPOLOGY_BITS);
      expect(row.sizing_plan.status).toBe(4);
      expect(row.sizing_plan).toEqual({ status: 4, verb_count: 0, point_count: 0 });
      expect(row.statistics).toEqual({
        logical_cubics: 1,
        sizing_visits: 0,
        emission_visits: 0,
        emitted_cubic_lines: 0,
      });
      expect(row.emission_plan).toBeNull();
      expect(row.flat_bounds).toBeNull();
      expect(row.commands).toBeNull();
      expect(row.edge_owners).toBeNull();
      expect(row.rounded).toBeNull();
      expect(row.allocations).toBe(0);
    },
  );

  it('keeps inline/heap capacity fixed and every measured attempt allocation-free', () => {
    expect(new Set(nativeRows.map(({ inline_bytes }) => inline_bytes)).size).toBe(1);
    expect(new Set(nativeRows.map(({ allocated_bytes }) => allocated_bytes)).size).toBe(1);
    expect(nativeRows.every(({ inline_bytes }) => inline_bytes > 0)).toBe(true);
    expect(nativeRows.every(({ allocated_bytes }) => allocated_bytes > 0)).toBe(true);
    expect(nativeRows.every(({ inline_bytes }) => inline_bytes < 64 * 1024)).toBe(true);
    expect(nativeRows.every(({ allocated_bytes }) => allocated_bytes <= 16 * 1024 * 1024)).toBe(
      true,
    );
    expect(nativeRows.every(({ allocations }) => allocations === 0)).toBe(true);
  });

  it('preserves nested negative zero through the direct rounded-value parser seam', () => {
    const row = nativeRows.find(({ rounded }) => rounded !== null)!;
    if (!row.rounded) throw new Error('native rounded row missing');
    const contours = row.rounded.contours.map((contour) =>
      contour.map(([x, y]) => [x, y] as [number, number]),
    );
    const point = contours.flat().find(([x, y]) => x === 0 || y === 0);
    if (!point) throw new Error('native zero coordinate missing');
    const axis = point[0] === 0 ? 0 : 1;
    point[axis] = -0;
    const parsed = parseNativeCubicValue({ ...row, rounded: { ...row.rounded, contours } }, 0);
    expect(
      parsed.rounded?.contours.flat().some(([x, y]) => Object.is(x, -0) || Object.is(y, -0)),
    ).toBe(true);
  });

  it('strictly rejects malformed outer rows and stale nested identity', () => {
    const row = nativeRows.find(({ flat_status }) => flat_status === 0)!;
    expect(() => parseNativeCubicValue({ ...row, extra: 1 }, 0)).toThrow('keys mismatch');
    expect(() => parseNativeCubicValue({ ...row, source_bits: [[['xyz']]] }, 0)).toThrow();
    expect(() =>
      parseNativeCubicValue({ ...row, rounded: { ...row.rounded!, id: 'stale' } }, 0),
    ).toThrow('rounded identity mismatch');
  });

  it('rejects actual-copy corruption for source, provenance, knots, order, owners, contributors, and mesh', () => {
    const fixture = fixtureRows.find(
      ({ id, rule }) => id === 'C01/identity' && rule === 'nonzero',
    )!;
    const row = nativeRows[fixtureRows.indexOf(fixture)]!;
    const commands = row.commands;
    const edgeOwners = row.edge_owners;
    const rounded = row.rounded;
    if (commands === null || edgeOwners === null || rounded === null || rounded.output === null)
      throw new Error('C01 native output missing');
    const output = rounded.output;

    const changedBits = row.source_bits.map((contour) => contour.map((cubic) => [...cubic]));
    changedBits[0]![0]![0] = '0000000000000000';
    expect(() => assertFixtureIdentity(fixture, { ...row, source_bits: changedBits })).toThrow(
      'source bits mismatch',
    );
    expect(() => assertFixtureIdentity(fixture, { ...row, id: 'stale' })).toThrow(
      'row identity mismatch',
    );

    const wrongOrdinal = structuredClone(commands) as NativeCubicCommand[];
    wrongOrdinal[0] = {
      ...wrongOrdinal[0]!,
      provenance: { ...wrongOrdinal[0]!.provenance, source_verb: 99 },
    };
    expect(() => actualSegments(fixture, wrongOrdinal)).toThrow('MOVE provenance mismatch');

    const firstLine = commands.findIndex(({ verb }) => verb === 1);
    const wrongLeafSource = structuredClone(commands) as NativeCubicCommand[];
    wrongLeafSource[firstLine] = {
      ...wrongLeafSource[firstLine]!,
      provenance: { ...wrongLeafSource[firstLine]!.provenance, source_verb: 99 },
    };
    expect(() => actualSegments(fixture, wrongLeafSource)).toThrow('emitted no leaves');
    const changedKnot = structuredClone(commands) as NativeCubicCommand[];
    const knot = changedKnot[firstLine]!.point!;
    changedKnot[firstLine] = { ...changedKnot[firstLine]!, point: [nextUp(knot[0]), knot[1]] };
    const changedSegments = actualSegments(fixture, changedKnot);
    expect(certifySimpleCubicTopology(changedSegments).status).toBe('KNOT_MISMATCH');

    const segments = actualSegments(fixture, commands);
    const firstSegment = segments[0]![0]!;
    expect(
      certifyCubicBoundary({
        cubic: firstSegment.cubic,
        lines: firstSegment.lines.slice(1),
        screen: [1, 0, 0, 1],
        sourceVerbOrdinal: firstSegment.sourceVerbOrdinal,
      }).status,
    ).toBe('INVALID_PROVENANCE');
    const reorderedLines = [...firstSegment.lines];
    [reorderedLines[0], reorderedLines[1]] = [reorderedLines[1]!, reorderedLines[0]!];
    expect(
      certifyCubicBoundary({
        cubic: firstSegment.cubic,
        lines: reorderedLines,
        screen: [1, 0, 0, 1],
        sourceVerbOrdinal: firstSegment.sourceVerbOrdinal,
      }).status,
    ).toBe('INVALID_PROVENANCE');
    const points = collectedContours(segments);
    const owners = expectedOwners(fixture, segments);

    const openFixture = fixtureRows.find(
      ({ id, rule }) => id === 'C04/identity' && rule === 'nonzero',
    )!;
    const openRow = nativeRows[fixtureRows.indexOf(openFixture)]!;
    if (!openRow.commands || !openRow.edge_owners) throw new Error('C04 native output missing');
    const openSegments = actualSegments(openFixture, openRow.commands);
    const openPoints = collectedContours(openSegments);
    const openOwners = expectedOwners(openFixture, openSegments);
    expect(openOwners.at(-1)).toEqual({ kind: 'ImplicitClosure', contour: 0 });
    const corruptedActualOwners = [...openRow.edge_owners];
    corruptedActualOwners[corruptedActualOwners.length - 1] = {
      kind: 'ImplicitClosure',
      contour: 1,
    };
    expect(() =>
      assertOwnerMapping(openOwners, openPoints, {
        ...openRow,
        edge_owners: corruptedActualOwners,
      }),
    ).toThrow('edge owner mapping mismatch');
    const lostContributor = {
      ...row,
      rounded: {
        ...rounded,
        output: {
          ...output,
          contributors: [owners.length, ...output.contributors.slice(1)],
        },
      },
    };
    expect(() => assertOwnerMapping(owners, points, lostContributor)).toThrow(
      'rounded contributor lost owner attribution',
    );

    const roundedInput = roundedFixture(row);
    const oracle = buildRoundedFillOracle(roundedInput);
    if (!oracle.ok) throw new Error('C01 rounded oracle unexpectedly failed');
    const inRangeContributors = [...output.contributors];
    inRangeContributors[0] = (inRangeContributors[0]! + 1) % owners.length;
    expect(() =>
      verifyRoundedFillCarrier(roundedInput, oracle, {
        ...output,
        contributors: inRangeContributors,
      }),
    ).toThrow(/attribution|contributor/u);
    expect(() =>
      assertCarrierMatches(oracle.carrier, {
        ...output,
        indices: output.indices.slice(3),
      }),
    ).toThrow('indices mismatch');
    expect(() =>
      assertCarrierMatches(oracle.carrier, {
        ...output,
        indices: [...output.indices, ...output.indices.slice(0, 3)],
      }),
    ).toThrow('indices mismatch');
  });
});
