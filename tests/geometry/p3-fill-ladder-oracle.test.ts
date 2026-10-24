/**
 * P3 Alt-A1 unit AL-U2 (`docs/plans/p3-alt-a1-fill-ladder-contract.md` section 4.2, AL-A7):
 * the permanent oracles of the production ladder on the CI dump set.
 *
 * It runs the spike's unchanged `emit_spike_fixtures` for the SL-F views, writes the `P3FLDIN1`
 * input of the CI dump set (every fixture of section 4.3, paths 0-1 of the 34 B0 decision
 * cells, 0-4 of the 26 O1 cells, all 60 X paths, the first 200 paths of
 * `p3-fill-ladder-random/v1`, and the seeded-defect entries), runs the ignored Rust test
 * `emit_fill_ladder_dump` with the pinned toolchain, and applies SL-O1 (at each path's own δ,
 * with AL-FR0 and AL-M5 exactly), SL-O2 (with `boundaryEdges` against the edges used once),
 * SL-O3 and AL-I3. With `fill_v0_revision()` 1 the export does not run the ladder yet, so
 * SL-O2 reads the module's fast mesh; from revision 2 it reads the export's output.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyOracleValidation,
  LADDER_CORPUS_SHA256,
  pathSources,
  validateChangedPaths,
} from '../../tooling/compare-p3-fill-identity.mjs';
import * as b0Corpus from './p3-b0/corpus.js';
import { corpusCells, generateCellPaths } from './p3-b0/corpus.js';
import * as randomCorpus from './p3-b0r/corpus.js';
import { SOURCE_CAPS, withinSourceCaps } from './p3-b0r/corpus.js';
import {
  exactHex,
  parseSpikeFixtures,
  sliverStatistics,
  verifyCertificate,
  verifyRegionMesh,
  type HexPoint,
  type RegionItem,
  type SpikeFixtures,
  type SpikeMesh,
} from './p3-b0-spike/oracle.js';
import {
  alClosureRectangle,
  b0Input,
  encodeDumpInput,
  encodeLadderCorpus,
  fixturePaths,
  generateLadderCorpus,
  LADDER_CI_PATHS,
  LADDER_CORPUS_ID,
  LADDER_PATHS,
  LADDER_SEED,
  ladderInput,
  MAX_FAST_EXPONENT,
  MIN_FAST_EXPONENT,
  type DumpInput,
} from './p3-fill-ladder/corpus.js';
import { parseLadderDump, type LadderDump, type LadderEntry } from './p3-fill-ladder/dump.js';
import {
  alM5Holds,
  evaluateEntry,
  evaluationFailures,
  judgeLadder,
  onceUsedEdges,
  powerOfTwo,
  verifyAlM5,
  verifyBoundaryEdges,
  verifyLadderCertificate,
  type EntryEvaluation,
} from './p3-fill-ladder/oracle.js';
import { compare, mul, rational } from './rounded-fill/exact.js';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
const B0_O1_PATHS = 5;
const B0_DECISION_PATHS = 2;

function cargoTest(filter: string, env: NodeJS.ProcessEnv): string {
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
      filter,
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  return result.stdout;
}

/** The seeded-defect entries (contract section 4.3) the oracles must reject. */
const DEFECTS = {
  '(11)': 'defect/(11)/AL-F3',
  '(12)': 'defect/(12)/AL-F1/e=511',
  '(13a)': 'defect/(13)/AL-F8b(a)/F01',
  '(13c)': 'defect/(13)/AL-F8b(c)/SL-F4',
  'AL-F8': 'defect/AL-F8/F01',
} as const;

function dumpInputs(spike: SpikeFixtures): DumpInput[] {
  const inputs: DumpInput[] = [];
  for (const fixture of spike.fixtures.filter(({ kind }) => kind === 'view'))
    inputs.push({
      name: `view/${fixture.id}`,
      kind: 'view',
      rule: fixture.rule === 'nonzero' ? 0 : 1,
      exponent: -3,
      view: fixture,
    });
  inputs.push({
    name: 'view/AL-F3',
    kind: 'view',
    rule: 0,
    exponent: -3,
    view: alClosureRectangle(1 / 16),
  });
  inputs.push({
    name: 'view/AL-F4',
    kind: 'view',
    rule: 0,
    exponent: -3,
    view: alClosureRectangle(1 / 64),
  });
  const fixtures = fixturePaths();
  inputs.push(...fixtures);
  for (const cell of corpusCells()) {
    const count =
      cell.role === 'decision' ? B0_DECISION_PATHS : cell.role === 'o1' ? B0_O1_PATHS : cell.paths;
    generateCellPaths(cell, count).forEach((item, index) =>
      inputs.push(b0Input(cell.id, index, item.verbs, item.points)),
    );
  }
  generateLadderCorpus(LADDER_CI_PATHS).forEach((item, index) =>
    inputs.push(ladderInput(index, item)),
  );
  const fixture = (name: string) => fixtures.find((item) => item.name === name)!;
  const f01 = fixture('fixture/AL-F5/nonzero');
  inputs.push(
    {
      name: DEFECTS['(11)'],
      kind: 'view',
      rule: 0,
      exponent: -3,
      view: alClosureRectangle(1 / 16),
      faults: ['AlM5Omitted'],
    },
    { ...fixture('fixture/AL-F1/e=511'), name: DEFECTS['(12)'], faults: ['RangeOmitted'] },
    { ...f01, name: DEFECTS['(13a)'], faults: ['TriangleDropped', 'MeshCheckItem3Disabled'] },
    {
      ...fixture('fixture/SL-F4'),
      name: DEFECTS['(13c)'],
      faults: ['VertexSubstituted', 'MeshCheckItem3Disabled'],
    },
    { ...f01, name: DEFECTS['AL-F8'], faults: ['TriangleFlipped'] },
  );
  return inputs;
}

let spike: SpikeFixtures;
let inputs: DumpInput[];
let dump: LadderDump;
let byName: Map<string, LadderEntry>;
let evaluations: Map<string, EntryEvaluation>;
let directory: string;

beforeAll(() => {
  spike = parseSpikeFixtures(cargoTest('p3_b0_spike_tests::emit_spike_fixtures', {}));
  inputs = dumpInputs(spike);
  directory = mkdtempSync(path.join(tmpdir(), 'p3-fill-ladder-oracle-'));
  const input = path.join(directory, 'input.bin');
  const output = path.join(directory, 'dump.txt');
  writeFileSync(input, encodeDumpInput(inputs));
  cargoTest('fill_ladder_dump_tests::emit_fill_ladder_dump', {
    P3_FILL_LADDER_INPUT: input,
    P3_FILL_LADDER_DUMP: output,
  });
  dump = parseLadderDump(readFileSync(output, 'utf8'));
  byName = new Map(dump.entries.map((entry) => [entry.name, entry]));
  evaluations = new Map(
    dump.entries.map((entry) => [entry.name, evaluateEntry(entry, dump.revision)]),
  );
}, 1_800_000);

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function entry(name: string): LadderEntry {
  const found = byName.get(name);
  if (found === undefined) throw new Error(`no dump entry ${name}`);
  return found;
}

const isDefect = (item: LadderEntry) => item.name.startsWith('defect/');
/** The report group of an entry: `b0/<series>` (O1 and X as their own), else the name's head. */
const group = (name: string) =>
  name.startsWith('b0/') ? `b0/${name.split('/')[1]!}` : name.split('/')[0]!;

function nextBits(bits: string): string {
  return (BigInt(`0x${bits}`) + 1n).toString(16).padStart(16, '0');
}

describe('P3 Alt-A1 AL-U2 permanent oracles', () => {
  it('parses the p3-fill-ladder-dump/1 hand-off of the whole CI dump set strictly', () => {
    expect(dump.schema).toBe('p3-fill-ladder-dump/1');
    expect(dump.revision).toBeGreaterThanOrEqual(1);
    expect(dump.entries.map(({ name }) => name)).toEqual(inputs.map(({ name }) => name));
    const count = (prefix: string) => inputs.filter(({ name }) => name.startsWith(prefix)).length;
    expect(count('view/')).toBe(29);
    expect(count('b0/') - count('b0/O1/') - count('b0/X/')).toBe(34 * B0_DECISION_PATHS);
    expect(count('b0/O1/')).toBe(26 * B0_O1_PATHS);
    expect(count('b0/X/')).toBe(60);
    expect(count('ladder/')).toBe(LADDER_CI_PATHS);
    expect(count('defect/')).toBe(Object.keys(DEFECTS).length);
    expect(() => parseLadderDump('no frame')).toThrow('exactly one frame');
    const raw = readFileSync(path.join(directory, 'dump.txt'), 'utf8');
    expect(() => parseLadderDump(raw.replace('"rung":"fast"', '"rung":"fallback"'))).toThrow(
      'rung/reason mismatch',
    );
    console.log(
      `AL-U2 dump: revision ${dump.revision}, ${dump.entries.length} entries, ${raw.length} bytes`,
    );
  });

  it('SL-O1, SL-O2, SL-O3, AL-I3 and the harness checks pass on every entry (AL-A7)', () => {
    const failures: string[] = [];
    const mix = new Map<string, Record<string, number>>();
    const checked = { 'SL-O1': 0, 'SL-O2': 0, 'SL-O3': 0, 'AL-I3': 0 };
    const allowed: string[] = [];
    let meshCheck = 0;
    for (const item of dump.entries.filter((value) => !isDefect(value))) {
      const evaluation = evaluations.get(item.name)!;
      for (const failure of evaluationFailures(evaluation))
        failures.push(`${item.name}: ${failure}`);
      for (const gate of Object.keys(checked) as (keyof typeof checked)[])
        if (evaluation.checked[gate]) checked[gate] += 1;
      if (evaluation.allowedDifference !== null)
        allowed.push(`${item.name} (${evaluation.allowedDifference})`);
      if (item.reason === 'MESH_CHECK') meshCheck += 1;
      const tally = mix.get(group(item.name)) ?? {};
      const key = item.rung === 'fast' ? 'fast' : item.reason!;
      tally[key] = (tally[key] ?? 0) + 1;
      mix.set(group(item.name), tally);
    }
    console.log(
      `AL-U2 oracles: checked ${JSON.stringify(checked)}; MESH_CHECK ${meshCheck}; ` +
        `allowed AL-I3 differences ${allowed.length}: ${allowed.join(', ')}\n` +
        [...mix].map(([name, tally]) => `${name}: ${JSON.stringify(tally)}`).join('\n'),
    );
    expect(failures).toEqual([]);
    expect(meshCheck).toBe(0);
    expect(checked['SL-O2']).toBeGreaterThan(0);
    expect(checked['SL-O3']).toBeGreaterThan(0);
  });

  it('every fixture meets its literal expectation (section 4.3)', () => {
    const mismatches: string[] = [];
    const expectFallback = (name: string, reason: string) => {
      const item = entry(name);
      if (item.rung !== 'fallback' || item.reason !== reason)
        mismatches.push(`${name}: expected ${reason}, got ${item.rung} ${item.reason}`);
    };
    const expectFast = (name: string, area: number | null) => {
      const item = entry(name);
      const evaluation = evaluations.get(name)!;
      if (item.rung !== 'fast' || evaluation.region === null) {
        mismatches.push(`${name}: expected fast, got ${item.rung} ${item.reason}`);
        return;
      }
      if (area !== null && compare(evaluation.region.meshArea, rational(BigInt(area))) !== 0)
        mismatches.push(`${name}: area differs from ${area}`);
    };
    // The spike's views at their literal expectations, and AL-F3/AL-F4.
    for (const fixture of spike.fixtures.filter(({ kind }) => kind === 'view')) {
      const name = `view/${fixture.id}`;
      const item = entry(name);
      const expected = fixture.expected;
      if (expected.kind === 'fallback') expectFallback(name, expected.reason);
      else if (expected.kind === 'fast') {
        expectFast(name, null);
        const region = evaluations.get(name)!.region;
        if (
          region &&
          expected.area !== null &&
          compare(region.meshArea, exactHex(expected.area)) !== 0
        )
          mismatches.push(`${name}: area differs from the literal`);
        if (
          region &&
          expected.boundary !== null &&
          JSON.stringify(region.boundary) !== JSON.stringify(expected.boundary)
        )
          mismatches.push(`${name}: boundary contours differ`);
        if (expected.triangles !== null && item.fastMesh?.triangles.length !== expected.triangles)
          mismatches.push(`${name}: triangle count differs`);
      }
      // Each view fallback's reason fails exactly, as in the spike's SL-U2 test.
      if (item.rung === 'fallback' && evaluations.get(name)!.judgement?.reason !== 'exact')
        mismatches.push(`${name}: ${item.reason} is not exact`);
    }
    expectFallback('view/AL-F3', 'CLOSURE');
    expectFast('view/AL-F4', 12);
    expect(entry('view/AL-F4').fastMesh?.triangles).toHaveLength(3);
    // AL-F1 and AL-F2: the range ends.
    expectFallback('fixture/AL-F1/e=511', 'RANGE');
    expectFallback('fixture/AL-F1/e=-512', 'RANGE');
    expectFallback('fixture/AL-F2/e=510', 'CLEARANCE');
    expectFast('fixture/AL-F2/e=-511', 100);
    // AL-F5: a line-only square under both rules, the four directed square edges.
    for (const name of ['fixture/AL-F5/nonzero', 'fixture/AL-F5/evenodd']) {
      expectFast(name, 100);
      const output = evaluations.get(name)!.fastOutput!;
      expect([...output.boundaryEdges].map(([a, b]) => `${a}>${b}`).sort(), name).toEqual([
        '0>1',
        '1>2',
        '2>3',
        '3>0',
      ]);
    }
    // AL-F6 and AL-F7's real inputs, each falling back to the exact rung.
    expectFallback('fixture/AL-F6', 'MONOTONE');
    expect(entry('fixture/AL-F6').exact).toMatchObject({ step: 'Legacy', status: 'OK' });
    expectFallback('fixture/F04', 'CROSSING');
    expectFallback('fixture/F07', 'CROSSING');
    expectFallback('fixture/F06', 'MONOTONE');
    expectFallback('fixture/SL-F3', 'CLEARANCE');
    expectFallback('fixture/SL-F15', 'STRUCTURE');
    expectFallback('fixture/big-circle', 'PREFIX');
    expect(entry('fixture/big-circle').exact?.status).toBe('CommandLimit');
    expectFallback('b0/O1/P2/s=3#0', 'CLOSURE');
    expectFallback('b0/O1/P4/s=16#0', 'PREFIX');
    // Re-baselined 2026-10-24 by E8-U2 (failure-to-success): with the canonical final knot the
    // exact rung no longer exceeds the owner cap (docs/evidence/e8-u2-2026-10-24.md).
    expect(entry('b0/O1/P4/s=16#0').exact?.status).toBe('OK');
    // AL-F9: SL-F13's two B0 paths are fast, and SL-O3 holds against the exact rung.
    for (const name of ['b0/P4/s=4#0', 'b0/K2/s=3#0']) {
      expectFast(name, null);
      expect(evaluations.get(name)!.checked['SL-O3'], name).toBe(true);
    }
    expect(mismatches).toEqual([]);
  });

  it('decides AL-M5 in the exact squared form (section 4.2)', () => {
    const delta2 = mul(rational(1n, 8n), rational(1n, 8n));
    const squared = (n: bigint, d: bigint) => mul(rational(n, d), rational(n, d));
    // AL-F3: 3/32 + 1/16 = 5/32 > 1/8; AL-F4: 3/32 + 1/64 = 7/64 < 1/8.
    expect(alM5Holds(squared(1n, 16n), squared(3n, 32n), delta2)).toBe(false);
    expect(alM5Holds(squared(1n, 64n), squared(3n, 32n), delta2)).toBe(true);
    // Equality, 3/32 + 1/32 = δ, fails; so does b ≥ D whatever a is.
    expect(alM5Holds(squared(1n, 32n), squared(3n, 32n), delta2)).toBe(false);
    expect(alM5Holds(rational(0n), delta2, delta2)).toBe(false);
    // On AL-F3's view SL-C4 holds and AL-M5 alone fails; on AL-F4 both hold.
    const f3 = alClosureRectangle(1 / 16);
    const certificate = verifyCertificate(f3, rational(1n, 8n));
    expect(certificate.holds['SL-C4']).toBe(true);
    expect(verifyAlM5(f3, rational(1n, 8n), certificate).holds).toBe(false);
    expect(verifyLadderCertificate(alClosureRectangle(1 / 64), -3).alM5).toMatchObject({
      holds: true,
      contracted: 1,
    });
    // δ per path: 2^e exactly.
    expect(powerOfTwo(-3)).toEqual(rational(1n, 8n));
    expect(powerOfTwo(4)).toEqual(rational(16n));
  });

  it('rejects the positive controls: mesh, boundary-pair, boundary-contour and range (AL-A7)', () => {
    const EXPECTED_ITEMS: Readonly<Record<string, readonly RegionItem[]>> = {
      flipped: ['item1', 'inspect'],
      missing: ['item3', 'item4'],
      duplicated: ['item3', 'inspect'],
      movedVertex: ['item2'],
    };
    const accepted: string[] = [];
    let controls = 0;
    const fast = dump.entries.filter(
      (item) => !isDefect(item) && item.rung === 'fast' && !item.name.startsWith('ladder/'),
    );
    expect(fast.length).toBeGreaterThan(20);
    for (const item of fast) {
      const output = evaluations.get(item.name)!.fastOutput!;
      const mesh = output.mesh;
      const [first, ...rest] = mesh.triangles;
      const moved = mesh.vertices.map((vertex, index): HexPoint =>
        index === first![0] ? [nextBits(vertex[0]), vertex[1]] : vertex,
      );
      const variants: Record<string, SpikeMesh> = {
        flipped: { ...mesh, triangles: [[first![0], first![2], first![1]], ...rest] },
        missing: { ...mesh, triangles: mesh.triangles.slice(0, -1) },
        duplicated: { ...mesh, triangles: [...mesh.triangles, first!] },
        movedVertex: { ...mesh, vertices: moved },
      };
      for (const [name, variant] of Object.entries(variants)) {
        controls += 1;
        const region = verifyRegionMesh(item.view!, item.rule, variant);
        const missing = EXPECTED_ITEMS[name]!.filter((value) => !region.failed.includes(value));
        if (region.ok || missing.length > 0)
          accepted.push(`${item.name} ${name}: missing [${missing.join(', ')}]`);
      }
      // A dropped boundary pair, and a reversed one.
      controls += 2;
      if (verifyBoundaryEdges(mesh.triangles, output.boundaryEdges.slice(1)).length === 0)
        accepted.push(`${item.name} dropped pair`);
      const reversed = output.boundaryEdges.map(([a, b], index) =>
        index === 0 ? ([b, a] as const) : ([a, b] as const),
      );
      if (verifyBoundaryEdges(mesh.triangles, reversed).length === 0)
        accepted.push(`${item.name} reversed pair`);
      expect(verifyBoundaryEdges(mesh.triangles, onceUsedEdges(mesh.triangles))).toEqual([]);
    }
    expect(controls).toBe(6 * fast.length);
    expect(accepted).toEqual([]);
    // A wrong boundary contour: SL-F6's nonzero and evenodd meshes swapped.
    const nonzero = entry('view/SL-F6/nonzero');
    const evenodd = entry('view/SL-F6/evenodd');
    expect(verifyRegionMesh(nonzero.view!, 'nonzero', evenodd.fastMesh!).failed).toEqual(
      expect.arrayContaining(['item2', 'item3']),
    );
    expect(verifyRegionMesh(evenodd.view!, 'evenodd', nonzero.fastMesh!).failed).toEqual(
      expect.arrayContaining(['item2', 'item3']),
    );
    // AL-FR0: a fast outcome outside the range, and RANGE inside it, are both rejected.
    const inside = entry('fixture/AL-F2/e=-511');
    const certificate = verifyLadderCertificate(inside.view!, -511);
    expect(judgeLadder(inside, certificate, -512).unsound).toEqual(['AL-FR0']);
    expect(judgeLadder({ rung: 'fallback', reason: 'RANGE' }, null, -511).reason).toBe(
      'reason-not-exact',
    );
    const range = evaluateEntry(
      { ...inside, rung: 'fallback', reason: 'RANGE', fastMesh: null, boundaryEdges: null },
      dump.revision,
    );
    expect(range.failures['SL-O1']).toEqual(['RANGE at exponent -511, inside the range']);
  });

  it('detects the seeded defects (11), (12) and (13), and AL-F8 falls back (section 4.3)', () => {
    const omitted = entry(DEFECTS['(11)']);
    expect(omitted.rung).toBe('fast');
    expect(evaluations.get(omitted.name)!.judgement!.unsound).toContain('AL-M5');
    const range = entry(DEFECTS['(12)']);
    expect(range.reason).not.toBe('RANGE');
    expect(evaluations.get(range.name)!.judgement!.unsound).toEqual(['AL-FR0']);
    for (const name of [DEFECTS['(13a)'], DEFECTS['(13c)']]) {
      const item = entry(name);
      expect(item.rung, name).toBe('fast');
      const failures = evaluations.get(name)!.failures['SL-O2'];
      expect(
        failures.some((failure) => failure.startsWith('item 3:')),
        name,
      ).toBe(true);
    }
    const flipped = entry(DEFECTS['AL-F8']);
    expect([flipped.rung, flipped.reason, flipped.meshCheckItem]).toEqual([
      'fallback',
      'MESH_CHECK',
      1,
    ]);
    expect(flipped.exact?.status).toBe('OK');
    expect(flipped.ladderExactAgrees).toBe(true);
  });

  it('judges a revision-2 export output and decodes the revision-1 export (AL-U3 readiness)', () => {
    // A fast path whose export fields carry the module mesh, as AL-U3's export must publish it.
    const item = entry('b0/P4/s=4#0');
    expect(item.rung).toBe('fast');
    const asExport = (
      triangles: readonly (readonly [number, number, number])[],
      boundaryEdges: readonly (readonly [number, number])[],
    ): LadderEntry => ({
      ...item,
      export: {
        ...item.export!,
        pathStatus: 0,
        positions: item.fastMesh!.vertices,
        triangles,
        boundaryEdges,
      },
    });
    const published = asExport(item.fastMesh!.triangles, item.boundaryEdges!);
    expect(evaluationFailures(evaluateEntry(published, 2))).toEqual([]);
    expect(evaluateEntry(published, 2).fastOutput?.mesh.triangles).toBe(
      published.export!.triangles,
    );
    // One triangle rotated (the same triangle, other corner order), and one pair reversed.
    const differs = 'SL-O2: the export output differs from the module fast mesh';
    const [first, ...rest] = item.fastMesh!.triangles;
    const rotated = asExport([[first![1], first![2], first![0]], ...rest], item.boundaryEdges!);
    expect(evaluationFailures(evaluateEntry(rotated, 2))).toContain(differs);
    const [pair, ...pairs] = item.boundaryEdges!;
    const reversed = asExport(item.fastMesh!.triangles, [[pair![1], pair![0]], ...pairs]);
    expect(evaluationFailures(evaluateEntry(reversed, 2))).toContain(differs);
    // Revision 1: the export decoder on V2's own output, `boundaryEdges` the edges used once.
    let decoded = 0;
    const issues: string[] = [];
    for (const value of dump.entries.filter((candidate) => candidate.kind === 'path')) {
      const exported = value.export!;
      if (exported.pathStatus !== 0) continue;
      decoded += 1;
      if (exported.positions === null || exported.triangles === null || !exported.boundaryEdges)
        issues.push(`${value.name}: an ok export without a block`);
      else
        for (const issue of verifyBoundaryEdges(exported.triangles, exported.boundaryEdges))
          issues.push(`${value.name}: ${issue}`);
    }
    console.log(`AL-U2 revision-1 export blocks decoded and checked: ${decoded}`);
    expect(decoded).toBeGreaterThan(100);
    expect(issues).toEqual([]);
  });

  it('validates changed paths end to end: sources, input, cargo dump, evaluation (S4)', async () => {
    const sources = pathSources(b0Corpus, randomCorpus, generateLadderCorpus());
    const paths = ['b0/P2/s=3/0000', 'b0/O1/P2/s=3/0000', 'rnd/L1-generic-ladder/0001'];
    const run = mkdtempSync(path.join(tmpdir(), 'p3-fill-ladder-validate-'));
    const wrong = mkdtempSync(path.join(tmpdir(), 'p3-fill-ladder-validate-'));
    try {
      const validation = await validateChangedPaths(paths, sources, run, dump.revision);
      expect([...validation.keys()]).toEqual(paths);
      // The same paths as in the CI dump, by their oracle-test names.
      expect(validation.get('b0/P2/s=3/0000')).toEqual({ rung: 'fast', failures: [] });
      expect(validation.get('b0/O1/P2/s=3/0000')?.rung).toBe('fallback');
      const ladder = entry('ladder/1');
      expect(validation.get('rnd/L1-generic-ladder/0001')?.rung).toBe(ladder.rung);
      const written = JSON.parse(
        readFileSync(path.join(run, 'oracle-validation.json'), 'utf8'),
      ) as { revision: number };
      expect(written.revision).toBe(dump.revision);
      // A changed-fast case passes; a newly admitted case whose path fell back fails.
      const cases = [
        { path: 'b0/P2/s=3/0000', class: 'changed-fast' },
        { path: 'b0/O1/P2/s=3/0000', class: 'newly-admitted' },
      ].map((item) => ({
        ...item,
        case: `${item.path}/fill_v0_cascade`,
        layer: 'native' as const,
        family: item.path.split('/').slice(0, 2).join('/'),
        oldStatus: 'path_status=0',
        reason: '-',
      })) as Parameters<typeof applyOracleValidation>[0];
      expect(applyOracleValidation(cases, validation)).toEqual([
        'b0/O1/P2/s=3/0000: the dump took rung fallback',
      ]);
      // A dump from a kernel of another revision is refused.
      await expect(
        validateChangedPaths(paths.slice(0, 1), sources, wrong, dump.revision + 1),
      ).rejects.toThrow(/revision/u);
    } finally {
      rmSync(run, { recursive: true, force: true });
      rmSync(wrong, { recursive: true, force: true });
    }
  }, 600_000);

  it('generates p3-fill-ladder-random/v1 deterministically within the source caps', () => {
    const paths = generateLadderCorpus();
    expect(LADDER_CORPUS_ID).toBe('p3-fill-ladder-random/v1');
    expect(LADDER_SEED).toBe(0x4c414452);
    expect(paths).toHaveLength(LADDER_PATHS);
    expect(generateLadderCorpus(LADDER_CI_PATHS)).toEqual(paths.slice(0, LADDER_CI_PATHS));
    for (const item of paths) {
      expect(withinSourceCaps(item)).toBe(true);
      expect(item.exponent).toBeGreaterThanOrEqual(-1021);
      expect(item.exponent).toBeLessThanOrEqual(1023);
    }
    expect(SOURCE_CAPS.contours).toBe(4);
    const outside = paths.filter(
      (item) => item.exponent < MIN_FAST_EXPONENT || item.exponent > MAX_FAST_EXPONENT,
    ).length;
    expect(outside).toBeGreaterThan(0);
    expect(new Set(paths.map((item) => item.rule))).toEqual(new Set([0, 1]));
    const hash = createHash('sha256').update(encodeLadderCorpus(paths)).digest('hex');
    expect(hash).toBe(LADDER_CORPUS_SHA256);
    console.log(
      `${LADDER_CORPUS_ID}: ${paths.length} paths, ${outside} outside AL-FR0's range, SHA-256 ${hash}`,
    );
  });

  it('reports SL-O5 sliver statistics and the SL-O6 geometric-error observation', () => {
    const rows = new Map<
      string,
      { fast: SpikeMesh[]; exact: SpikeMesh[]; bound: number; contracted: number }
    >();
    for (const item of dump.entries.filter((value) => !isDefect(value) && value.kind === 'path')) {
      const row = rows.get(group(item.name)) ?? { fast: [], exact: [], bound: 0, contracted: 0 };
      const evaluation = evaluations.get(item.name)!;
      if (item.rung === 'fast' && evaluation.fastOutput) {
        row.fast.push(evaluation.fastOutput.mesh);
        if (item.maxDeviationSquared !== null)
          row.bound = Math.max(
            row.bound,
            Math.sqrt(exactHexNumber(item.maxDeviationSquared)) / 2 ** item.exponent,
          );
        row.contracted += evaluation.certificate?.alM5.contracted ?? 0;
      }
      if (item.exact?.mesh) row.exact.push(item.exact.mesh);
      rows.set(group(item.name), row);
    }
    const lines: string[] = [];
    for (const [name, row] of rows) {
      const summary = (meshes: SpikeMesh[]) => {
        // Huge-scale paths can overflow the Float64 statistics; those triangles are counted.
        const all = meshes.flatMap((mesh) => sliverStatistics(mesh).perTriangle);
        const values = all.filter((value) => Number.isFinite(value.quality));
        if (values.length === 0) return 'none';
        const quality = Math.min(...values.map((value) => value.quality));
        const below = values.filter((value) => value.quality < 0.1).length;
        return `T ${all.length} (${all.length - values.length} non-finite), ρ min ${quality.toPrecision(3)}, ρ<0.1 ${((100 * below) / values.length).toFixed(0)}%`;
      };
      lines.push(
        `${name}: fast ${summary(row.fast)}; exact ${summary(row.exact)}; ` +
          `max certified δ̄/δ ${row.bound.toPrecision(4)}, contracted contours ${row.contracted}`,
      );
    }
    console.log(`SL-O5/SL-O6 (reported only):\n${lines.join('\n')}`);
    expect(lines.length).toBeGreaterThan(0);
  });
});

function exactHexNumber(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`));
  return view.getFloat64(0);
}
