import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectLineFillMesh } from '../../packages/geometry-reference/src/fill-region.js';
import { inspectTriangleMesh } from '../../packages/geometry-reference/src/triangle-mesh.js';
import { bitsOf, fromBits } from './rounded-fill/exact.js';
import { readRoundedFillFixture } from './rounded-fill/fixture.js';
import {
  assertCarrierMatches,
  assertSourceEcho,
  buildRoundedFillOracle,
  verifyRoundedFillCarrier,
} from './rounded-fill/oracle.js';
import { parseNativeRoundedRow, type NativeRoundedRow } from './rounded-fill/native.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const fixturePath = path.join(root, 'tests/fixtures/p3-rounded-fill-v1.txt');
const fixtureRows = readRoundedFillFixture(fixturePath);
const oracleRows = fixtureRows.map(buildRoundedFillOracle);

function captureRows(): readonly NativeRoundedRow[] {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
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
      'rounded_line_fill_tests::emit_rounded_fill_meshes',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout.match(/P3_ROUNDED_FILL_BEGIN/g)).toHaveLength(1);
  expect(result.stdout.match(/P3_ROUNDED_FILL_END/g)).toHaveLength(1);
  const frame = /P3_ROUNDED_FILL_BEGIN\r?\n([\s\S]*?)\r?\nP3_ROUNDED_FILL_END/u.exec(result.stdout);
  if (!frame) throw new Error('native rounded-fill frame is incomplete');
  const lines = frame[1]!.split(/\r?\n/u);
  expect(lines).toHaveLength(202);
  return lines.map(parseNativeRoundedRow);
}

const sourceNumbers = (index: number) =>
  fixtureRows[index]!.contours.map((contour) =>
    contour.map(([x, y]) => [fromBits(x), fromBits(y)] as const),
  );

const F_AREAS = new Map<string, number>([
  ['F01', 100],
  ['F02:nonzero', 100],
  ['F02:evenodd', 84],
  ['F03', 84],
  ['F04:nonzero', 100],
  ['F04:evenodd', 0],
  ['F05', 0],
  ['F06', 8],
  ['F07', 8],
  ['F08', 32],
  ['F09-repeat', 100],
  ['F09-permuted:nonzero', 100],
  ['F09-permuted:evenodd', 84],
  ['F10:nonzero', 24],
  ['F10:evenodd', 16],
  ['F10-reversed', 16],
  ['F11', 32],
  ['F03-global-reversed', 84],
  ['F06-global-reversed', 8],
  ['F10-global-reversed:nonzero', 24],
  ['F10-global-reversed:evenodd', 16],
]);

let nativeRows: readonly NativeRoundedRow[] = [];

beforeAll(() => {
  nativeRows = captureRows();
}, 300_000);

describe('P3.2e independent native rounded line-fill bridge', () => {
  it('matches all 202 frozen source echoes, expectations, profiles, and strict carrier rows (R02)', () => {
    expect(nativeRows).toHaveLength(fixtureRows.length);
    nativeRows.forEach((native, index) => {
      const fixture = fixtureRows[index]!;
      const oracle = oracleRows[index]!;
      expect(`${native.id}:${native.rule}`, `row ${index} identity`).toBe(
        `${fixture.id}:${fixture.rule}`,
      );
      expect(native.tau_bits, `row ${index} tau`).toBe(
        fixture.tauBits.toString(16).padStart(16, '0'),
      );
      expect(native.profile, `row ${index} profile`).toBe(fixture.profile);
      const echoBits = native.contours.map((contour) =>
        contour.map(([x, y]) => [bitsOf(x), bitsOf(y)] as const),
      );
      assertSourceEcho(fixture, echoBits);
      expect(native.stats.input_vertices).toBeLessThanOrEqual(32);
      expect(native.stats.edges).toBeLessThanOrEqual(32);
      expect(native.stats.pair_checks).toBeLessThanOrEqual(496);
      expect(native.stats.events).toBeLessThanOrEqual(560);
      expect(native.stats.columns).toBeLessThanOrEqual(560);
      expect(native.stats.sections).toBeLessThanOrEqual(8192);
      expect(native.stats.nodes).toBeLessThanOrEqual(256);
      expect(native.stats.cells).toBeLessThanOrEqual(256);
      expect(native.stats.boundaries).toBeLessThanOrEqual(512);
      expect(native.stats.contributors).toBeLessThanOrEqual(16_384);
      expect(native.stats.work_units).toBeLessThanOrEqual(2_000_000);
      if (fixture.expectation === 'TOPOLOGY_AMBIGUOUS') {
        expect(oracle.ok, `${fixture.id}:${fixture.rule} oracle expectation`).toBe(false);
        expect(native.error).toBe('TopologyAmbiguous');
        expect(native.output).toBeNull();
        return;
      }
      if (!oracle.ok) throw new Error(`${fixture.id}:${fixture.rule} oracle unexpectedly failed`);
      expect(native.error).toBeNull();
      const output = native.output;
      if (!output) throw new Error(`${fixture.id}:${fixture.rule} native output missing`);
      verifyRoundedFillCarrier(fixture, oracle, output);
      assertCarrierMatches(oracle.carrier, output);
      expect(inspectTriangleMesh(output), `${fixture.id}:${fixture.rule} mesh`).toEqual({
        valid: true,
        issue: null,
      });
      expect(native.stats).toEqual({
        input_vertices: fixture.contours.reduce((sum, contour) => sum + contour.length, 0),
        edges: output.source_edges.length,
        pair_checks: (output.source_edges.length * (output.source_edges.length - 1)) / 2,
        events: oracle.rawEvents,
        columns: output.columns.length,
        sections: output.sections.length,
        nodes: output.nodes.length,
        cells: output.cells.length,
        boundaries: output.boundaries.length,
        contributors: output.contributors.length,
        work_units: native.stats.work_units,
      });
    });
  });

  it('preserves the unchanged exact F source regions and analytic areas', () => {
    nativeRows.slice(0, 32).forEach((native, index) => {
      const area = F_AREAS.get(`${native.id}:${native.rule}`) ?? F_AREAS.get(native.id);
      if (area === undefined || !native.output)
        throw new Error(`${native.id}:${native.rule} missing F output`);
      expect(
        inspectLineFillMesh({
          contours: sourceNumbers(index),
          rule: native.rule,
          mesh: {
            vertices: native.output.vertices,
            indices: native.output.indices,
            bounds: native.output.bounds,
            expectedArea: area,
          },
        }),
        `${native.id}:${native.rule}`,
      ).toEqual({ valid: true, issue: null });
    });
  });

  it('preserves R05 negative-zero input bits while normalizing every output scalar', () => {
    const indexes = fixtureRows.flatMap((row, index) => (row.id === 'R05' ? [index] : []));
    expect(indexes).toHaveLength(2);
    for (const index of indexes) {
      const fixture = fixtureRows[index]!;
      const native = nativeRows[index]!;
      expect(fixture.contours.flat().some(([x, y]) => x >> 63n === 1n || y >> 63n === 1n)).toBe(
        true,
      );
      expect(native.contours.flat().some(([x, y]) => Object.is(x, -0) || Object.is(y, -0))).toBe(
        true,
      );
      if (!native.output) throw new Error('R05 output missing');
      const scalars = [
        ...native.output.columns.map(({ x }) => x),
        ...native.output.nodes.flatMap(({ point }) => point),
        ...native.output.vertices.flatMap((point) => point),
        ...native.output.bounds,
        native.output.error_bound,
      ];
      expect(scalars.some((value) => Object.is(value, -0))).toBe(false);
    }
  });
});
