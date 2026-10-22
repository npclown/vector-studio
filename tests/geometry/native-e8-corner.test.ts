// D9 E8 unit E8-U1, E8-K10 (docs/plans/p3-rounded-knot-topology-contract.md, E8 addendum E8.8):
// the native-versus-oracle differential of the amended adjacent-pair test on the E8 fixtures and
// on a sample of `e8-corner/v1`. Each path is flattened natively with the fill-v0 caps; its
// topology input, built as `CubicFillWorkspace::certify_topology` builds it, is certified by the
// native P3.2n, P3.2s and P3.2x workspaces at the oracles' default ceilings
// (`e8_direction_hint_tests::emit_e8_corner_topology`) and by the independently written
// TypeScript mirror of E8.3 in the P3.1f, P3.1g and P3.1i oracles. Status, leaf and pair counts
// must agree for every certificate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Point } from '../../packages/geometry-reference/src/types.js';
import { generateE8CornerCorpus } from './e8-corner/corpus.js';
import { E8_FIXTURES, e8PathScalars } from './e8-corner/fixtures.js';
import {
  certifyRoundedKnotCubicTopology,
  certifyTransverseCubicArrangement,
  certifyTriangleFreeCubicArrangement,
  type CubicTopologySegment,
} from './simple-cubic-topology/oracle.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');

type InputRow = Readonly<{ id: string; exponent: number; verbs: number[]; points: number[] }>;

const bits = (value: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
};
const fromBits = (hex: string) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

// The flattening work limit of E8-F1 at e = -8..-6 ends before topology and is not compared.
const fixtureRows: InputRow[] = E8_FIXTURES.flatMap((fixture) =>
  fixture.cases
    .filter(({ status }) => status !== 'work-limit')
    .map(({ exponent }) => ({
      id: `${fixture.id}/e${exponent}`,
      exponent,
      ...e8PathScalars(fixture.data, fixture.offset),
    })),
);
// Every tenth path of every corpus family.
const corpusRows: InputRow[] = generateE8CornerCorpus().flatMap((family) =>
  family.paths
    .filter((_, index) => index % 10 === 0)
    .map((pathData, offset) => ({
      id: `${family.id}/${offset * 10}`,
      exponent: pathData.exponent,
      verbs: [...pathData.verbs],
      points: [...pathData.points],
    })),
);
const rows = [...fixtureRows, ...corpusRows];

type Result = Readonly<{ status: string; leaves: number; pairs: number }>;
type NativeRow = Readonly<{
  id: string;
  exponent: number;
  prefix?: string;
  contours?: readonly (readonly Readonly<{
    cubic: readonly (readonly [string, string])[];
    sourceVerbOrdinal: number;
    line: boolean;
    lines: readonly Readonly<{
      end: readonly [string, string];
      provenance: Readonly<{ sourceVerbOrdinal: number; endNumerator: number; depth: number }>;
    }>[];
  }>[])[];
  rounded?: Result;
  transverse?: Result;
  triangleFree?: Result;
}>;

function runEmitter(): readonly NativeRow[] {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const tools = path.join(root, '.tools');
  mkdirSync(tools, { recursive: true });
  const directory = mkdtempSync(path.join(tools, 'p3-native-e8-corner-'));
  const input = path.join(directory, 'input.txt');
  writeFileSync(
    input,
    rows
      .map(
        (row) =>
          `${row.id}\t${row.exponent}\t${row.verbs.join(',')}\t${row.points.map(bits).join(',')}\n`,
      )
      .join(''),
    { flag: 'wx' },
  );
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
      'e8_direction_hint_tests::emit_e8_corner_topology',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, P3_E8_TOPOLOGY_INPUT: input },
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  writeFileSync(path.join(directory, 'stdout.txt'), result.stdout ?? '', { flag: 'wx' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  const frame = /P3_E8_CORNER_TOPOLOGY_BEGIN\r?\n([\s\S]*?)\r?\nP3_E8_CORNER_TOPOLOGY_END/u.exec(
    result.stdout,
  );
  if (!frame) throw new Error('native E8 topology frame is incomplete');
  return frame[1]!.split(/\r?\n/u).map((line) => JSON.parse(line) as NativeRow);
}

const point = ([x, y]: readonly [string, string]): Point => [fromBits(x), fromBits(y)];

function oracleInput(row: NativeRow): Readonly<{
  contours: CubicTopologySegment[][];
  kinds: boolean[];
}> {
  const kinds: boolean[] = [];
  const contours = row.contours!.map((contour) =>
    contour.map((segment) => {
      kinds.push(segment.line);
      return {
        cubic: segment.cubic.map(point) as unknown as CubicTopologySegment['cubic'],
        sourceVerbOrdinal: segment.sourceVerbOrdinal,
        lines: segment.lines.map(({ end, provenance }) => ({ end: point(end), provenance })),
      };
    }),
  );
  return { contours, kinds };
}

const summary = (result: Readonly<{ status: string; leaves: number; pairs: number }>) => ({
  status: result.status,
  leaves: result.leaves,
  pairs: result.pairs,
});

let nativeRows: readonly NativeRow[] = [];

beforeAll(() => {
  nativeRows = runEmitter();
}, 600_000);

describe('E8-K10 native versus the TypeScript mirror of E8.3', () => {
  it('captures one row per input in order', () => {
    expect(nativeRows.map(({ id }) => id)).toEqual(rows.map(({ id }) => id));
    expect(nativeRows.every((row) => row.prefix === undefined)).toBe(true);
  });

  it.each(rows.map((row, index) => [row.id, index] as const))(
    '%s agrees in P3.2n/P3.1f, P3.2s/P3.1g and P3.2x/P3.1i',
    (_, index) => {
      const row = nativeRows[index]!;
      const { contours, kinds } = oracleInput(row);
      expect(summary(certifyRoundedKnotCubicTopology(contours)), 'P3.1f').toEqual(row.rounded);
      expect(summary(certifyTransverseCubicArrangement(contours)), 'P3.1g').toEqual(row.transverse);
      expect(summary(certifyTriangleFreeCubicArrangement(contours, kinds)), 'P3.1i').toEqual(
        row.triangleFree,
      );
    },
  );

  it('exercises the amended test: certificates on fixtures that the frozen test rejected', () => {
    const certified = (prefix: string) =>
      nativeRows.filter(
        ({ id, triangleFree }) => id.startsWith(prefix) && triangleFree?.status === 'CERTIFIED',
      ).length;
    const statuses = Object.fromEntries(
      nativeRows
        .filter(({ id }) => id.startsWith('E8-'))
        .map(({ id, rounded, triangleFree }) => [id, `${rounded?.status}/${triangleFree?.status}`]),
    );
    console.log(
      `E8 fixture topology (P3.2n/P3.2x at the oracle ceilings): ${JSON.stringify(statuses)}`,
    );
    expect(certified('E8-F1') + certified('E8-F2') + certified('E8-F4')).toBeGreaterThan(0);
    expect(certified('E8-C1') + certified('E8-C2')).toBe(0);
  });
});
