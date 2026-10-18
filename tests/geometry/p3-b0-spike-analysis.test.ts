/**
 * P3 B0 spike, unit SL-U3 (`docs/plans/p3-b0-spike-ladder-contract.md` sections 5 and 7.2,
 * SL-A3, SL-A7 and SL-A8): the spike's configuration and B0's unchanged hash, the analysis and
 * `validateSpikeRecord` on synthetic records (a tampered record is rejected), the verdict rules,
 * and the Rust oracle harness on the B0 corpus: the corpus-wide S1 accessor equality test of
 * section 2.2, the allocation-free ladder check of SL-A7 and SL-O4's checksums, then the oracle
 * evaluation on a subset of the dump with positive controls for each gate.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configHash, type B0Record } from './p3-b0/analysis.js';
import { corpusCells, encodeCorpus, scenarioConfig as b0ScenarioConfig } from './p3-b0/corpus.js';
import {
  analyze,
  B0_IDENTITY_RECORD,
  B0_REFERENCE_CONFIG_HASH,
  CORPUS_SHA256,
  evaluateOracle,
  ORACLE_GATES,
  oracleStatus,
  scenarioConfig,
  validateSpikeRecord,
  type DumpPath,
  type OracleDump,
  type OracleHarnessOutput,
  type OracleResults,
  type SpikeDecisionOutput,
  type SpikeRecord,
} from './p3-b0-spike/analysis.js';
import { parseArguments } from '../../tooling/run-p3-b0-spike-benchmark.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const clone = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value)) as Mutable<T>;

describe('P3 B0 spike configuration', () => {
  it('keeps B0 v1 unchanged and gives the spike its own identity (SL-A3, section 5.1)', () => {
    expect(configHash(b0ScenarioConfig('reference'))).toBe(B0_REFERENCE_CONFIG_HASH);
    const config = scenarioConfig('reference');
    expect(config.scenario).toEqual({ id: 'p3-b0-spike-ladder', version: 1 });
    expect(config.corpus.sha256).toBe(CORPUS_SHA256);
    expect(config.cells).toEqual(b0ScenarioConfig('reference').cells);
    expect(config.decision).toEqual(b0ScenarioConfig('reference').decision);
    expect(configHash(config)).not.toBe(configHash(scenarioConfig('functional')));
    expect(config.sampling.repetitions).toBe(5);
    expect(scenarioConfig('functional').sampling).toMatchObject({
      repetitions: 1,
      timed: 2,
      diagnostic: null,
    });
    const hash = createHash('sha256').update(encodeCorpus(corpusCells())).digest('hex');
    expect(hash).toBe(CORPUS_SHA256);
  });

  it('parses the runner arguments as B0 does', () => {
    expect(parseArguments(['--profile', 'functional'])).toEqual({
      profile: 'functional',
      environmentJson: null,
    });
    expect(() => parseArguments(['--profile', 'reference'])).toThrow(/environment-json/);
  });
});

function syntheticOracle(): OracleResults {
  return {
    dump: { sha256: '0', bytes: 1, paths: 1 },
    harness: {
      ladderCalls: 1,
      allocatingCalls: [],
      s1Accessor: { published: 1, other: 0, failures: [] },
    },
    gates: Object.fromEntries(
      ORACLE_GATES.map((id) => [id, { checked: 1, failures: [] }]),
    ) as unknown as OracleResults['gates'],
    cells: [],
    slivers: [],
    geometricError: [],
    o1: [],
    o2: [],
    checksums: [],
  };
}

function syntheticRecord(
  perPathNs: (leaves: number) => number,
  profile: 'functional' | 'reference' = 'reference',
): SpikeRecord {
  const config = scenarioConfig(profile);
  const decision = config.cells.filter((cell) => cell.role === 'decision');
  const leavesOf = (cell: (typeof decision)[number]) =>
    cell.contours * cell.cubicsPerContour * cell.lambda;
  const repetitions: SpikeDecisionOutput[] = Array.from(
    { length: config.sampling.repetitions },
    (_, repetition) => ({
      kind: 'decision',
      repetition,
      clockQuantumNs: 1,
      workspace: { inlineBytes: 1, allocatedBytes: 1 },
      admission: decision.map((cell) => ({
        cell: cell.id,
        paths: Array.from({ length: cell.paths }, () => ({
          status: 'OK',
          rung: 'fast' as const,
          reason: null,
          flatCommands: leavesOf(cell) + 2 * cell.contours,
          vertices: 2 * leavesOf(cell),
          triangles: 2 * leavesOf(cell) - 2,
          rounded: false,
          transverse: false,
          allocations: 0,
        })),
      })),
      order: decision.map((cell) => cell.id),
      cells: decision.map((cell) => {
        const base = perPathNs(leavesOf(cell));
        return {
          cell: cell.id,
          workspaceNs: 1,
          batchAllocations: 0,
          batchNs: Array.from({ length: 20 }, (_, index) => 10 * base * (1 + (index % 3) * 0.001)),
          pathNs: Array.from({ length: 200 }, (_, index) => base * (1 + (index % 5) * 0.002)),
          checksums: Array.from({ length: 20 }, () => '00000000000000aa'),
        };
      }),
      linearity: {
        cell: 'P4/s=16',
        batch10Ns: Array.from({ length: 20 }, () => 10 * perPathNs(64)),
        checksums10: Array.from({ length: 20 }, () => '00000000000000aa'),
        batch100Ns: Array.from({ length: 5 }, () => 100 * perPathNs(64)),
        checksums100: Array.from({ length: 5 }, () => '00000000000000bb'),
      },
    }),
  );
  return {
    schemaVersion: 1,
    scenario: {
      id: config.scenario.id,
      version: config.scenario.version,
      profile,
      config,
      configHash: configHash(config),
    },
    run: { commit: 'test', runner: 'p3-b0-spike-runner/1', sourceManifest: { file: 'hash' } },
    environment: {
      observedAt: '2026-10-18T00:00:00Z',
      os: 'test',
      cpu: 'test',
      logicalCores: 1,
      memoryBytes: 1,
      timezone: 'UTC',
      power: { value: 'AC', source: 'test' },
      backgroundLoad: { value: 'idle', source: 'test' },
      processListing: { processes: 1 },
    },
    builds: { toolchain: {}, decision: {} },
    corpus: { sha256: CORPUS_SHA256, bytes: 0 },
    repetitions,
    diagnostic: null,
    oracle: syntheticOracle(),
  };
}

function complete(record: SpikeRecord): SpikeRecord {
  return clone({ ...record, analysis: analyze(record) });
}

describe('P3 B0 spike analysis and validator (section 5.12, SL-A8)', () => {
  it('recomputes a valid record and rejects tampered ones', () => {
    const record = complete(syntheticRecord((value) => value ** 2));
    expect(() => validateSpikeRecord(record)).not.toThrow();
    expect((record.analysis as { verdict: string }).verdict).toBe('FEASIBLE');
    expect((record.analysis as { timedFastShare: number }).timedFastShare).toBe(1);

    const sample = clone(record);
    sample.repetitions[0]!.cells[0]!.batchNs[0]! += 1_000_000;
    expect(() => validateSpikeRecord(sample as SpikeRecord)).toThrow(/analysis differs/);

    const mix = clone(record);
    mix.repetitions[2]!.admission[0]!.paths[0]!.rung = 'exact';
    mix.repetitions[2]!.admission[0]!.paths[0]!.reason = 'CLEARANCE';
    expect(() => validateSpikeRecord(mix as SpikeRecord)).toThrow(/analysis differs/);

    const gate = clone(record);
    gate.oracle!.gates['SL-O2'].failures.push('P2/s=3#0: item 1');
    expect(() => validateSpikeRecord(gate as SpikeRecord)).toThrow(/analysis differs/);

    const stored = clone(record);
    (stored.analysis as { verdict: string }).verdict = 'INFEASIBLE';
    expect(() => validateSpikeRecord(stored as SpikeRecord)).toThrow(/analysis differs/);

    const rehashed = clone(record);
    rehashed.scenario.config.decision.wasmFactor = 1;
    expect(() => validateSpikeRecord(rehashed as SpikeRecord)).toThrow(/hash mismatch/);

    const renamed = clone(record);
    renamed.scenario.id = 'p3-b0-feasibility';
    expect(() => validateSpikeRecord(renamed as SpikeRecord)).toThrow(/scenario identity/);

    // A budget edited with its hash recomputed is still rejected: the configuration is pinned.
    const budget = clone(record);
    budget.scenario.config.decision.budgets.initialMs = 2000;
    budget.scenario.configHash = configHash(budget.scenario.config);
    budget.analysis = clone(analyze(budget as SpikeRecord));
    expect(() => validateSpikeRecord(budget as SpikeRecord)).toThrow(
      /configuration differs from scenarioConfig/,
    );
  });

  it('invalidates a run whose oracle harness allocated or whose S1 accessor differed', () => {
    const cases = [
      [
        'allocating ladder call',
        (record: Mutable<SpikeRecord>) => record.oracle!.harness.allocatingCalls.push('P2/s=3#0'),
      ],
      [
        'S1 accessor mismatch',
        (record: Mutable<SpikeRecord>) =>
          record.oracle!.harness.s1Accessor.failures.push('P2/s=3#0'),
      ],
    ] as const;
    for (const [reason, mutate] of cases) {
      const record = clone(syntheticRecord((value) => value ** 2));
      mutate(record);
      const analysis = analyze(record);
      expect(analysis.verdict).toBe('INVALID');
      expect(analysis.invalidReasons).toEqual([reason]);
      // It validates only as INVALID.
      const stored = complete(record);
      expect(() => validateSpikeRecord(stored)).not.toThrow();
      const relabelled = clone(stored);
      (relabelled.analysis as { verdict: string }).verdict = 'FEASIBLE';
      expect(() => validateSpikeRecord(relabelled as SpikeRecord)).toThrow(/analysis differs/);
    }
  });

  it('applies the decision rule, the oracle gates and the checksum rule (sections 4 and 6)', () => {
    expect(analyze(syntheticRecord((value) => 2e5 * value ** 2)).verdict).toBe('INFEASIBLE');
    expect(analyze(syntheticRecord((value) => value ** 2, 'functional')).verdict).toBe('NONE');

    const short = syntheticRecord((value) => value ** 2);
    expect(analyze({ ...short, repetitions: short.repetitions.slice(0, 4) }).verdict).toBe(
      'INCONCLUSIVE',
    );

    const mix = clone(syntheticRecord((value) => value ** 2));
    mix.repetitions[1]!.admission[3]!.paths[2]!.rung = 'exact';
    mix.repetitions[1]!.admission[3]!.paths[2]!.reason = 'MONOTONE';
    const mixed = analyze(mix);
    expect(
      mixed.checks.find((item) => item.id === '5b-admission-and-ladder-mix-identical')!.pass,
    ).toBe(false);
    expect(mixed.verdict).toBe('INCONCLUSIVE');

    for (const gateId of ORACLE_GATES) {
      const failed = clone(syntheticRecord((value) => value ** 2));
      failed.oracle!.gates[gateId].failures.push('x');
      const analysis = analyze(failed);
      expect(analysis.verdict).toBe('INVALID');
      expect(analysis.invalidReasons).toEqual(['oracle gate']);
    }
    const unchecked = clone(syntheticRecord((value) => value ** 2));
    unchecked.oracle!.gates['SL-O3'].checked = 0;
    expect(analyze(unchecked as SpikeRecord).verdict).toBe('INVALID');
    expect(analyze({ ...syntheticRecord((value) => value ** 2), oracle: null }).verdict).toBe(
      'INVALID',
    );
    expect(
      analyze({ ...syntheticRecord((value) => value ** 2), oracle: null }).invalidReasons,
    ).toEqual(['oracle gate', 'allocating ladder call', 'S1 accessor mismatch']);

    const checksum = clone(syntheticRecord((value) => value ** 2));
    checksum.repetitions[1]!.cells[4]!.checksums[0] = 'ffffffffffffffff';
    const invalid = analyze(checksum);
    expect(invalid.verdict).toBe('INVALID');
    expect(invalid.invalidReasons).toEqual(['checksum mismatch']);

    const bare = clone(syntheticRecord((value) => value ** 2));
    delete (bare.environment as Record<string, unknown>).processListing;
    expect(analyze(bare as SpikeRecord).verdict).toBe('INCONCLUSIVE');
  });

  it('reports fallback rates per cell and the timed fast-rung share (section 5.7)', () => {
    const record = clone(syntheticRecord((value) => value ** 2));
    for (const rep of record.repetitions)
      for (const path of rep.admission.find((cell) => cell.cell === 'P2/s=16')!.paths.slice(0, 5)) {
        path.rung = 'exact';
        path.reason = 'CLEARANCE';
      }
    const analysis = analyze(record);
    expect(analysis.seriesFallback.find((item) => item.series === 'P2')!.fallbackRate).toBe(0.5);
    expect(analysis.timedFastShare).toBeCloseTo(1 - 5 / 340, 12);
    expect(analysis.verdict).toBe('FEASIBLE');
  });
});

// ------------------------------------------------------------------------------------------
// The Rust oracle harness on the B0 corpus.

let scratch: string;
let harness: OracleHarnessOutput;
let dump: OracleDump;
let reference: B0Record;

beforeAll(() => {
  const rustup = process.env.P2_NATIVE_RUSTUP;
  if (!rustup) throw new Error('Run pnpm test:geometry to select the pinned native toolchain.');
  const parent = path.join(root, '.tools/geometry-tmp');
  mkdirSync(parent, { recursive: true });
  scratch = mkdtempSync(path.join(parent, 'p3-b0-spike-oracle-'));
  const corpus = path.join(scratch, 'corpus.bin');
  writeFileSync(corpus, encodeCorpus(corpusCells()));
  const output = path.join(scratch, 'oracle.json');
  const dumpFile = path.join(scratch, 'dump.json');
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
      'p3_b0_spike_bench::run_spike_oracle',
      '--',
      '--ignored',
      '--exact',
      '--nocapture',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        P3_B0_INPUT: corpus,
        P3_B0_OUTPUT: output,
        P3_B0_SPIKE_DUMP: dumpFile,
      },
      encoding: 'utf8',
      timeout: 900_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  expect(result.status, result.stdout + result.stderr).toBe(0);
  harness = JSON.parse(readFileSync(output, 'utf8')) as OracleHarnessOutput;
  dump = JSON.parse(readFileSync(dumpFile, 'utf8')) as OracleDump;
  reference = JSON.parse(readFileSync(path.join(root, B0_IDENTITY_RECORD), 'utf8')) as B0Record;
}, 900_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** The first `count` paths of every cell, with a harness whose call count matches. */
function subset(count: number): { dump: OracleDump; harness: OracleHarnessOutput } {
  const paths = dump.paths.filter((path) => path.path < count);
  return { dump: { ...dump, paths }, harness: { ...harness, ladderCalls: paths.length } };
}

/** The oracle list restricted to the first `count` paths of every cell (dump completeness). */
function expectedSubset(count: number) {
  return b0ScenarioConfig('reference').cells.map((cell) => ({
    id: cell.id,
    paths: Math.min(cell.paths, count),
  }));
}

function gateFailures(results: OracleResults) {
  return Object.fromEntries(ORACLE_GATES.map((id) => [id, results.gates[id].failures.length]));
}

describe('P3 B0 spike oracle harness on the B0 corpus (sections 2.2, 4.4 and SL-A7)', () => {
  it('runs every corpus path allocation-free with the S1 accessor equal (SL-A7, section 2.2)', () => {
    expect(harness.ladderCalls).toBe(1270);
    expect(dump.paths).toHaveLength(1270);
    expect(harness.allocatingCalls).toEqual([]);
    expect(dump.paths.every((path) => path.allocations === 0)).toBe(true);
    expect(harness.s1Accessor.failures).toEqual([]);
    expect(harness.s1Accessor.published).toBe(453);
    expect(harness.s1Accessor.published + harness.s1Accessor.other).toBe(1270);
  });

  it('reproduces the exact rung of the 2026-10-17 record (SL-O4) on the full dump', () => {
    // SL-O4 alone is cheap: without the S1 views, SL-O1 to SL-O3 do not run their exact
    // checks (SL-O2 then reports every fast path, which this test does not assert).
    const stripped: OracleDump = {
      ...dump,
      paths: dump.paths.map((path): DumpPath => ({ ...path, view: null })),
    };
    const results = evaluateOracle(stripped, harness, { sha256: '0', bytes: 0 }, reference);
    expect(results.gates['SL-O4'].failures).toEqual([]);
    // A dump with one entry dropped is incomplete.
    const dropped = evaluateOracle(
      { ...stripped, paths: stripped.paths.filter((_, index) => index !== 500) },
      { ...harness, ladderCalls: 1269 },
      { sha256: '0', bytes: 0 },
      reference,
    );
    const missing = stripped.paths[500]!;
    expect(dropped.gates['SL-O4'].failures).toEqual([
      `dump has ${missing.cell}#${missing.path} 0 times`,
      'dump has 1269 paths for 1270 expected',
    ]);
    // A tampered identity record fails B0's own validator.
    const tampered = clone(reference);
    (tampered.analysis as { verdict: string }).verdict = 'FEASIBLE';
    expect(
      evaluateOracle(stripped, harness, { sha256: '0', bytes: 0 }, tampered as B0Record).gates[
        'SL-O4'
      ].failures,
    ).toEqual([
      "identity record rejected by B0's validator: stored analysis differs from the recomputation",
    ]);
    expect(results.gates['SL-O4'].checked).toBe(1270 + 35);
    expect(results.checksums.every((item) => item.checksum10 === item.reference10)).toBe(true);
    expect(results.o2.every((item) => item.asExpected)).toBe(true);
  });

  it('passes every gate on path 0 of every cell and rejects positive controls', () => {
    const base = subset(1);
    const ref = reference;
    const results = evaluateOracle(
      base.dump,
      base.harness,
      { sha256: '0', bytes: 0 },
      ref,
      expectedSubset(1),
    );
    expect(gateFailures(results)).toEqual({ 'SL-O1': 0, 'SL-O2': 0, 'SL-O3': 0, 'SL-O4': 0 });
    expect(oracleStatus(results).valid).toBe(true);
    expect(results.gates['SL-O1'].checked).toBeGreaterThan(60);
    expect(results.gates['SL-O2'].checked).toBeGreaterThan(50);
    expect(results.gates['SL-O3'].checked).toBeGreaterThan(30);

    // Each control mutates P4/s=4 path 0, evaluated alone (with a harness of one call).
    const target = base.dump.paths.find((path) => path.cell === 'P4/s=4' && path.path === 0)!;
    const single = { ...base.harness, ladderCalls: 1 };
    const one = [{ id: 'P4/s=4', paths: 1 }];
    expect(
      gateFailures(
        evaluateOracle({ ...dump, paths: [target] }, single, { sha256: '0', bytes: 0 }, ref, one),
      ),
    ).toEqual({ 'SL-O1': 0, 'SL-O2': 0, 'SL-O3': 0, 'SL-O4': 0 });
    const run = (mutate: (path: Mutable<DumpPath>) => void) => {
      const path = clone(target);
      mutate(path);
      return gateFailures(
        evaluateOracle({ ...dump, paths: [path] }, single, { sha256: '0', bytes: 0 }, ref, one),
      );
    };
    // SL-O2: a flipped triangle.
    expect(
      run((path) => {
        const [a, b, c] = path.fastMesh!.triangles[0]!;
        path.fastMesh!.triangles[0] = [a, c, b];
      })['SL-O2'],
    ).toBeGreaterThanOrEqual(1);
    // SL-O1: a certified deviation bound below the exact value.
    expect(
      run((path) => {
        path.maxDeviationSquared = '0000000000000001';
      })['SL-O1'],
    ).toBeGreaterThanOrEqual(1);
    // SL-O1: a polygon vertex moved by 3/16, so that SL-C1 fails exactly on a fast path.
    expect(
      run((path) => {
        const point = path.view!.points[1]!;
        const value = new DataView(new ArrayBuffer(8));
        value.setBigUint64(0, BigInt(`0x${point[0]}`));
        value.setFloat64(0, value.getFloat64(0) + 3 / 16);
        point[0] = value.getBigUint64(0).toString(16).padStart(16, '0');
      })['SL-O1'],
    ).toBeGreaterThanOrEqual(1);
    // SL-O3: the exact rung's published polygon differs from the S1 view.
    expect(
      run((path) => {
        path.exact.published!.points[0]![0] = path.exact.published!.points[1]![0];
      })['SL-O3'],
    ).toBeGreaterThanOrEqual(1);
    // SL-O4: an exact outcome that differs from the record.
    expect(
      run((path) => {
        path.exact.triangles = path.exact.triangles! + 1;
      })['SL-O4'],
    ).toBeGreaterThanOrEqual(1);
    const checksum = clone(single);
    checksum.exactChecksums[0]!.checksum10 = 'ffffffffffffffff';
    expect(
      evaluateOracle(
        { ...dump, paths: [target] },
        checksum as OracleHarnessOutput,
        { sha256: '0', bytes: 0 },
        ref,
        one,
      ).gates['SL-O4'].failures,
    ).toHaveLength(1);
  }, 600_000);
});
