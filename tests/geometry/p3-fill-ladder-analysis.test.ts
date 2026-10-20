/**
 * P3 Alt-A1 unit AL-U5 (`docs/plans/p3-alt-a1-fill-ladder-contract.md` sections 5.2-5.3,
 * AL-A13): scenario AL-S1's configuration with B0's and the spike's unchanged hashes; the
 * analysis and `validateLadderRecord` on synthetic records (tampered records are rejected);
 * the verdict rules, with oracle, `MESH_CHECK`, AL-I2, harness and storage failures making a
 * run INVALID; the product verdict with k = k̂; the ratio mode's native analysis; and the Rust
 * harness itself on the B0 corpus: a decision repetition and a ratio repetition with minimal
 * sampling, and the oracle run on a subset dump with positive controls for each gate.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configHash, type B0Record } from './p3-b0/analysis.js';
import { corpusCells, encodeCorpus, scenarioConfig as b0ScenarioConfig } from './p3-b0/corpus.js';
import { scenarioConfig as spikeScenarioConfig } from './p3-b0-spike/analysis.js';
import { encodeDumpInput, encodeLadderCorpus } from './p3-fill-ladder/corpus.js';
import { parseLadderDump, type LadderDump } from './p3-fill-ladder/dump.js';
import {
  analyze,
  analyzeRatioNative,
  B0_IDENTITY_RECORD,
  B0_REFERENCE_CONFIG_HASH,
  CORPUS_SHA256,
  evaluateLadderOracle,
  LADDER_CORPUS_SHA256,
  largestPrimaryCells,
  ORACLE_GATES,
  oracleDumpInputs,
  oracleDumpNames,
  oracleStatus,
  productEstimates,
  productVerdict,
  ratioModeConfig,
  scenarioConfig,
  SPIKE_REFERENCE_CONFIG_HASH,
  validateLadderRecord,
  type LadderDecisionOutput,
  type LadderOracleHarness,
  type LadderOracleResults,
  type LadderRecord,
  type RatioOutput,
} from './p3-fill-ladder/analysis.js';
import { parseArguments } from '../../tooling/run-p3-fill-ladder-benchmark.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const manifest = path.join(root, 'packages/geometry-wasm/kernel/Cargo.toml');
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const clone = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value)) as Mutable<T>;
/** `configHash(ratioModeConfig('reference'))`, recorded in the plan for AL-U6. */
const RATIO_CONFIG_HASH = 'ff36ec78a920d704df431cf411f9c064bf1d3a0cb21523c83857a6bdad9ef9c3';
/** `configHash(scenarioConfig('reference'))`, recorded in the plan when AL-U5 merges. */
const REFERENCE_CONFIG_HASH = '8f07f1467b1e396fd1a9c02e6f27c17131cf203e287b5ea690391536b7f3672e';

describe('P3 Alt-A1 AL-S1 configuration (section 5.3)', () => {
  it("keeps B0's and the spike's configurations unchanged and gives AL-S1 its own", () => {
    expect(configHash(b0ScenarioConfig('reference'))).toBe(B0_REFERENCE_CONFIG_HASH);
    expect(configHash(spikeScenarioConfig('reference'))).toBe(SPIKE_REFERENCE_CONFIG_HASH);
    const config = scenarioConfig('reference');
    expect(config.scenario).toEqual({ id: 'p3-fill-ladder', version: 1 });
    expect(config.runner).toBe('p3-fill-ladder-runner/1');
    expect(config.operation).toMatchObject({ id: 'geometry-wasm/fill-v0+r2', revision: 2 });
    expect(config.cells).toEqual(b0ScenarioConfig('reference').cells);
    expect(config.decision).toEqual(b0ScenarioConfig('reference').decision);
    expect(config.decision.wasmFactor).toBe(2);
    expect(config.fits).toMatchObject(b0ScenarioConfig('reference').fits);
    expect(config.sampling).toMatchObject({
      repetitions: 5,
      warmup: 3,
      timed: 20,
      linearityWarmup: 2,
      linearityTimed: 5,
    });
    expect(scenarioConfig('functional').sampling).toMatchObject({ repetitions: 1, timed: 2 });
    expect(configHash(config)).not.toBe(configHash(scenarioConfig('functional')));
    expect(configHash(config)).toBe(REFERENCE_CONFIG_HASH);
    const hash = createHash('sha256').update(encodeCorpus(corpusCells())).digest('hex');
    expect(hash).toBe(CORPUS_SHA256);
    expect(createHash('sha256').update(encodeLadderCorpus()).digest('hex')).toBe(
      LADDER_CORPUS_SHA256,
    );
    console.log(
      `AL-S1 configuration hashes: reference ${configHash(config)}, functional ${configHash(scenarioConfig('functional'))}`,
    );
  });

  it('defines the ratio mode outside the AL-S1 hash, on the largest primary cells', () => {
    expect(largestPrimaryCells()).toEqual(['P2/s=16', 'P4/s=16', 'P8/s=8']);
    const ratio = ratioModeConfig('reference');
    expect(ratio).toMatchObject({
      calls: 100,
      onePath: { cells: ['P2/s=16', 'P4/s=16', 'P8/s=8'], path: 0, calls: 1000 },
      sampling: { repetitions: 5, warmup: 3, timed: 20 },
    });
    expect(JSON.stringify(scenarioConfig('reference'))).not.toContain('run_ladder_ratio');
    // Recorded in the plan for AL-U6 to embed in AL-S2's configuration.
    expect(configHash(ratio)).toBe(RATIO_CONFIG_HASH);
  });

  it('parses the runner arguments as B0 does', () => {
    expect(parseArguments(['--profile', 'functional'])).toEqual({
      profile: 'functional',
      environmentJson: null,
    });
    expect(() => parseArguments(['--profile', 'reference'])).toThrow(/environment-json/);
  });

  it('lists the full dump set of section 4.2 in order', () => {
    const names = oracleDumpNames();
    expect(names).toHaveLength(1270 + 2000);
    expect(new Set(names).size).toBe(names.length);
    expect(oracleDumpInputs().map((input) => input.name)).toEqual(names);
  });
});

function syntheticOracle(): LadderOracleResults {
  return {
    dump: { sha256: '0', bytes: 1, entries: 1, revision: 2 },
    gates: Object.fromEntries(
      ORACLE_GATES.map((id) => [id, { checked: 1, failures: [] }]),
    ) as unknown as LadderOracleResults['gates'],
    meshCheck: { count: 0, entries: [] },
    alI3: { checked: 1, identical: 1, allowed: { RANGE: 0, 'AL-M5': 0 }, differing: [] },
    mix: [],
    o1: [],
    o2: [],
    slivers: [],
    geometricError: [],
    checksums: [],
  };
}

function syntheticRecord(
  perPathNs: (leaves: number) => number,
  profile: 'functional' | 'reference' = 'reference',
): LadderRecord {
  const config = scenarioConfig(profile);
  const decision = config.cells.filter((cell) => cell.role === 'decision');
  const leavesOf = (cell: (typeof decision)[number]) =>
    cell.contours * cell.cubicsPerContour * cell.lambda;
  const repetitions: LadderDecisionOutput[] = Array.from(
    { length: config.sampling.repetitions },
    (_, repetition) => ({
      kind: 'decision',
      repetition,
      revision: 2,
      clockQuantumNs: 1,
      engine: { inlineBytes: 1, heapBytes: 1 },
      admission: decision.map((cell) => ({
        cell: cell.id,
        paths: Array.from({ length: cell.paths }, () => ({
          status: 'OK',
          rung: 'fast' as const,
          reason: null,
          step: null,
          flatCommands: leavesOf(cell) + 2 * cell.contours,
          vertices: leavesOf(cell),
          triangles: leavesOf(cell) - 2,
          boundaryPairs: leavesOf(cell),
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
          engineNs: 1,
          heapBytes: 1,
          bufferBytes: 2,
          batchAllocations: 0,
          storageStable: true,
          batchNs: Array.from({ length: 20 }, (_, index) => 10 * base * (1 + (index % 3) * 0.001)),
          pathNs: Array.from({ length: 200 }, (_, index) => base * (1 + (index % 5) * 0.002)),
          checksums: Array.from({ length: 20 }, () => '00000000000000aa'),
          pathChecksums: Array.from({ length: 20 }, () => '00000000000000cc'),
        };
      }),
      linearity: {
        cell: 'P4/s=16',
        storageStable: true,
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
    run: { commit: 'test', runner: 'p3-fill-ladder-runner/1', sourceManifest: { file: 'hash' } },
    environment: {
      observedAt: '2026-10-20T00:00:00Z',
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
    oracle: syntheticOracle(),
  };
}

function complete(record: LadderRecord): LadderRecord {
  return clone({ ...record, analysis: analyze(record) });
}

describe('P3 Alt-A1 AL-S1 analysis and validateLadderRecord (AL-A13)', () => {
  it('recomputes a valid record and rejects tampered ones', () => {
    const record = complete(syntheticRecord((value) => value ** 2));
    expect(() => validateLadderRecord(record)).not.toThrow();
    const analysis = record.analysis as ReturnType<typeof analyze>;
    expect(analysis.verdict).toBe('FEASIBLE');
    expect(analysis.verdictLabel).toBe('provisional at k = 2');
    expect(analysis.timedFastShare).toBe(1);
    expect(analysis.estimates).toMatchObject({ wasmFactor: 2, provisional: true });

    const tamper = (mutate: (copy: Mutable<LadderRecord>) => void, message: RegExp) => {
      const copy = clone(record);
      mutate(copy);
      expect(() => validateLadderRecord(copy as LadderRecord)).toThrow(message);
    };
    tamper((copy) => {
      copy.repetitions[0]!.cells[0]!.batchNs[0]! += 1_000_000;
    }, /analysis differs/);
    tamper((copy) => {
      copy.repetitions[0]!.cells[0]!.pathNs[7]! += 1_000_000;
    }, /analysis differs/);
    tamper((copy) => {
      copy.repetitions[3]!.cells[2]!.pathChecksums[1] = 'ffffffffffffffff';
    }, /analysis differs/);
    tamper((copy) => {
      copy.repetitions[2]!.admission[0]!.paths[0]!.rung = 'exact';
      copy.repetitions[2]!.admission[0]!.paths[0]!.reason = 'CLEARANCE';
    }, /analysis differs/);
    tamper((copy) => {
      copy.oracle!.gates['AL-I2'].failures.push('b0/P2/s=3#0: export output differs');
    }, /analysis differs/);
    tamper((copy) => {
      copy.oracle!.meshCheck.count = 1;
    }, /analysis differs/);
    tamper((copy) => {
      (copy.analysis as { verdict: string }).verdict = 'INFEASIBLE';
    }, /analysis differs/);
    tamper((copy) => {
      copy.scenario.config.decision.wasmFactor = 1;
    }, /hash mismatch/);
    tamper((copy) => {
      copy.scenario.id = 'p3-b0-spike-ladder';
    }, /scenario identity/);
    tamper((copy) => {
      copy.corpus.sha256 = '0'.repeat(64);
    }, /corpus hash/);
    // An edited configuration with its hash recomputed is still rejected: it is pinned.
    for (const mutate of [
      (copy: Mutable<LadderRecord>) => {
        copy.scenario.config.decision.budgets.initialMs = 2000;
      },
      (copy: Mutable<LadderRecord>) => {
        copy.scenario.config.sampling.timed = 50;
      },
      (copy: Mutable<LadderRecord>) => {
        copy.scenario.config.operation.revision = 1;
      },
    ]) {
      const copy = clone(record);
      mutate(copy);
      copy.scenario.configHash = configHash(copy.scenario.config);
      copy.analysis = clone(analyze(copy as LadderRecord));
      expect(() => validateLadderRecord(copy as LadderRecord)).toThrow(
        /configuration differs from scenarioConfig/,
      );
    }
  });

  it('makes oracle, MESH_CHECK, checksum, storage and revision failures INVALID', () => {
    const cases: readonly [string, (record: Mutable<LadderRecord>) => void][] = [
      ...ORACLE_GATES.map((gate): [string, (record: Mutable<LadderRecord>) => void] => [
        'oracle gate',
        (record) => {
          record.oracle!.gates[gate].failures.push('x');
        },
      ]),
      [
        'oracle gate',
        (record) => {
          record.oracle!.gates['SL-O3'].checked = 0;
        },
      ],
      [
        'MESH_CHECK',
        (record) => {
          record.oracle!.meshCheck = { count: 1, entries: ['b0/P2/s=3#0'] };
        },
      ],
      [
        'checksum mismatch',
        (record) => {
          record.repetitions[1]!.cells[4]!.checksums[0] = 'ffffffffffffffff';
        },
      ],
      [
        'checksum mismatch',
        (record) => {
          record.repetitions[1]!.linearity!.checksums100[0] = 'ffffffffffffffff';
        },
      ],
      [
        'storage moved during timing',
        (record) => {
          record.repetitions[0]!.cells[3]!.storageStable = false;
        },
      ],
      [
        'kernel revision',
        (record) => {
          record.repetitions[4]!.revision = 1;
        },
      ],
    ];
    for (const [reason, mutate] of cases) {
      const record = clone(syntheticRecord((value) => value ** 2));
      mutate(record);
      const analysis = analyze(record);
      expect(analysis.verdict, reason).toBe('INVALID');
      expect(analysis.invalidReasons, reason).toEqual([reason]);
      // It validates only as INVALID.
      const stored = complete(record);
      expect(() => validateLadderRecord(stored)).not.toThrow();
      const relabelled = clone(stored);
      (relabelled.analysis as { verdict: string }).verdict = 'FEASIBLE';
      expect(() => validateLadderRecord(relabelled as LadderRecord)).toThrow(/analysis differs/);
    }
    const missing = analyze({ ...syntheticRecord((value) => value ** 2), oracle: null });
    expect(missing.verdict).toBe('INVALID');
    expect(missing.invalidReasons).toEqual(['oracle gate', 'MESH_CHECK']);
  });

  it("applies B0's decision rule and checks, provisional at k = 2", () => {
    expect(analyze(syntheticRecord((value) => 2e5 * value ** 2)).verdict).toBe('INFEASIBLE');
    expect(analyze(syntheticRecord((value) => value ** 2, 'functional')).verdict).toBe('NONE');
    const short = syntheticRecord((value) => value ** 2);
    expect(analyze({ ...short, repetitions: short.repetitions.slice(0, 4) }).verdict).toBe(
      'INCONCLUSIVE',
    );
    const mix = clone(syntheticRecord((value) => value ** 2));
    mix.repetitions[1]!.admission[3]!.paths[2]!.rung = 'exact';
    mix.repetitions[1]!.admission[3]!.paths[2]!.reason = 'MONOTONE';
    mix.repetitions[1]!.admission[3]!.paths[2]!.step = 'Legacy';
    const mixed = analyze(mix);
    expect(
      mixed.checks.find((item) => item.id === '5b-admission-and-ladder-mix-identical')!.pass,
    ).toBe(false);
    expect(mixed.verdict).toBe('INCONCLUSIVE');
    // The export's cap status classifies a cell CAP-BOUND, as B0's cap codes did.
    const capped = clone(syntheticRecord((value) => value ** 2));
    for (const rep of capped.repetitions) {
      const path = rep.admission.find((cell) => cell.cell === 'P8/s=8')!.paths[3]!;
      path.status = 'WORK_LIMIT';
    }
    const cap = analyze(capped);
    expect(cap.admission.find((item) => item.cell === 'P8/s=8')!.classification).toBe('CAP-BOUND');
    expect(cap.checks.find((item) => item.id === '1-admitted-P8')!.pass).toBe(false);
    const bare = clone(syntheticRecord((value) => value ** 2));
    delete (bare.environment as Record<string, unknown>).processListing;
    expect(analyze(bare as LadderRecord).verdict).toBe('INCONCLUSIVE');
    // E2 is decided on 16 V + 12 T; the boundary pairs are reported beside it.
    const estimates = analyze(syntheticRecord((value) => value ** 2)).estimates!;
    expect(estimates.payloadBytes! - estimates.meshBytes).toBeCloseTo(1000 * 8 * 256, 6);
  });

  it('computes the product verdict with k = k-hat from the AL-S1 analysis (section 5.3)', () => {
    const analysis = analyze(syntheticRecord((value) => 1000 * value));
    const estimates = analysis.estimates!;
    const product = productEstimates(analysis, 1.5, 3)!;
    expect(product.initialMs).toBeCloseTo((1000 * estimates.perPathNs * 1.5) / 1e6, 12);
    expect(product.editMs).toBeCloseTo((estimates.p95Ns * 1.5) / 1e6, 12);
    expect(product.editOnePathContextMs).toBeCloseTo((estimates.p95Ns * 3) / 1e6, 12);
    expect(product.meshBytes).toBe(estimates.meshBytes);
    // The decision factor is k-hat alone; k-hat-one never decides.
    const kFeasible = 0.9 * (1e9 / (1000 * estimates.perPathNs));
    const ok = { invalid: false, valid: true };
    expect(productVerdict(analysis, kFeasible, ok, 1e6).verdict).toBe('FEASIBLE');
    expect(productVerdict(analysis, 1.2 * (1e9 / (1000 * estimates.perPathNs)), ok).verdict).toBe(
      'INFEASIBLE',
    );
    // An AL-S2 validity failure is INCONCLUSIVE; an AL-S2 no-verdict cause is INVALID.
    expect(productVerdict(analysis, kFeasible, { invalid: false, valid: false }).verdict).toBe(
      'INCONCLUSIVE',
    );
    expect(productVerdict(analysis, kFeasible, { invalid: true, valid: true }).verdict).toBe(
      'INVALID',
    );
    expect(productVerdict(analysis, kFeasible, { invalid: true, valid: false }).verdict).toBe(
      'INVALID',
    );
    const invalid = analyze({ ...syntheticRecord((value) => 1000 * value), oracle: null });
    expect(productVerdict(invalid, kFeasible, ok).verdict).toBe('INVALID');
    // B0's rule gives a functional AL-S1 analysis no verdict, whatever k-hat and AL-S2 say (B1).
    const functional = analyze(syntheticRecord((value) => 1000 * value, 'functional'));
    expect(functional.verdict).toBe('NONE');
    for (const s2 of [ok, { invalid: true, valid: false }])
      for (const k of [kFeasible, 1e6])
        expect(productVerdict(functional, k, s2).verdict).toBe('NONE');
    expect(productEstimates(analysis, Number.NaN)).toBeNull();
  });
});

function syntheticRatio(repetition: number): RatioOutput {
  const config = ratioModeConfig('reference');
  const decision = corpusCells().filter((cell) => cell.role === 'decision');
  const cell = (id: string, calls: number, paths: number) => ({
    cell: id,
    allocations: 0,
    storageStable: true,
    sampleNs: Array.from({ length: 20 }, (_, index) => calls * paths * (1000 + index)),
    checksums: Array.from({ length: 20 }, () => `${id.length}`.padStart(16, '0')),
  });
  return {
    kind: 'ratio',
    repetition,
    revision: 2,
    clockQuantumNs: 100,
    calls: config.calls,
    onePathCalls: config.onePath.calls,
    order: decision.map((item) => item.id),
    cells: decision.map((item) => cell(item.id, config.calls, 10)),
    onePath: config.onePath.cells.map((id) => cell(id, config.onePath.calls, 1)),
  };
}

describe('P3 Alt-A1 ratio mode, native analysis (section 5.2)', () => {
  it('reports per-path medians and the validity items of the native leg', () => {
    const config = ratioModeConfig('reference');
    const outputs = Array.from({ length: 5 }, (_, index) => syntheticRatio(index));
    const analysis = analyzeRatioNative(outputs, config);
    expect(analysis.issues).toEqual([]);
    expect(analysis.valid).toBe(true);
    expect(analysis.tenPath).toHaveLength(34);
    expect(analysis.tenPath[0]!.perRepetition[0]!.perPathMedianNs).toBe(1009);
    expect(analysis.onePath.map((item) => item.cell)).toEqual(['P2/s=16', 'P4/s=16', 'P8/s=8']);
    expect(analysis.onePath[0]!.perRepetition[4]!.perPathMedianNs).toBe(1009);

    const broken = (mutate: (outputs: Mutable<RatioOutput>[]) => void) => {
      const copy = outputs.map((output) => clone(output));
      mutate(copy);
      return analyzeRatioNative(copy, config);
    };
    expect(broken((copy) => copy.pop()).valid).toBe(false);
    expect(broken((copy) => (copy[1]!.cells[0]!.allocations = 2)).issues[0]).toMatch(/allocates/);
    expect(broken((copy) => (copy[2]!.onePath[1]!.storageStable = false)).issues[0]).toMatch(
      /storage moved/,
    );
    expect(broken((copy) => (copy[3]!.cells[5]!.checksums[2] = 'ff')).issues[0]).toMatch(
      /checksums 2/,
    );
    expect(broken((copy) => (copy[0]!.revision = 1)).issues).toEqual(['r0 revision']);
    const fast = broken((copy) => {
      const cell = copy[0]!.cells.find((item) => item.cell === 'P8/s=8')!;
      cell.sampleNs[0] = 50;
    });
    expect(fast.issues).toEqual(['UNVERIFIED P8/s=8']);
  });
});

// ------------------------------------------------------------------------------------------
// The Rust harness on the B0 corpus.

let scratch: string;
let reference: B0Record;

function cargoTest(name: string, env: Record<string, string>): void {
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
      `p3_fill_ladder_bench::${name}`,
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
}

beforeAll(() => {
  const parent = path.join(root, '.tools/geometry-tmp');
  mkdirSync(parent, { recursive: true });
  scratch = mkdtempSync(path.join(parent, 'p3-fill-ladder-analysis-'));
  writeFileSync(path.join(scratch, 'corpus.bin'), encodeCorpus(corpusCells()));
  reference = JSON.parse(readFileSync(path.join(root, B0_IDENTITY_RECORD), 'utf8')) as B0Record;
}, 60_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('P3 Alt-A1 AL-S1 harness on the B0 corpus (AL-A13)', () => {
  it('runs a decision repetition through the export, allocation-free and fast', () => {
    const output = path.join(scratch, 'decision.json');
    cargoTest('run_ladder_decision', {
      P3_B0_INPUT: path.join(scratch, 'corpus.bin'),
      P3_B0_OUTPUT: output,
      P3_B0_REPETITION: '0',
      P3_B0_WARMUP: '0',
      P3_B0_TIMED: '1',
      P3_B0_LIN_WARMUP: '0',
      P3_B0_LIN_TIMED: '1',
    });
    const decision = JSON.parse(readFileSync(output, 'utf8')) as LadderDecisionOutput;
    expect(decision.revision).toBe(2);
    expect(decision.admission).toHaveLength(34);
    const paths = decision.admission.flatMap((cell) => cell.paths);
    expect(paths).toHaveLength(430);
    expect(paths.every((item) => item.status === 'OK' && item.allocations === 0)).toBe(true);
    expect(paths.every((item) => item.rung === 'fast' && item.reason === null)).toBe(true);
    // A fast mesh has V = L vertices, all on the boundary: as many boundary pairs.
    expect(paths.every((item) => item.vertices === item.boundaryPairs)).toBe(true);
    expect(decision.cells).toHaveLength(34);
    for (const cell of decision.cells) {
      expect(cell.batchNs).toHaveLength(1);
      expect(cell.pathNs).toHaveLength(10);
      expect([cell.batchAllocations, cell.storageStable]).toEqual([0, true]);
    }
    expect(decision.linearity).toMatchObject({ cell: 'P4/s=16', storageStable: true });
    expect(decision.engine.heapBytes).toBeGreaterThan(0);
    // E5 does not depend on the input: every prepared cell engine has the admission engine's.
    expect(new Set(decision.cells.map((cell) => cell.heapBytes))).toEqual(
      new Set([decision.engine.heapBytes]),
    );
    expect(decision.cells.every((cell) => cell.bufferBytes > 0)).toBe(true);
  }, 900_000);

  it('runs a ratio repetition with the decoded fold on every call', () => {
    const output = path.join(scratch, 'ratio.json');
    cargoTest('run_ladder_ratio', {
      P3_B0_INPUT: path.join(scratch, 'corpus.bin'),
      P3_B0_OUTPUT: output,
      P3_B0_REPETITION: '0',
      P3_B0_WARMUP: '0',
      P3_B0_TIMED: '2',
      P3_FL_RATIO_CALLS: '2',
      P3_FL_RATIO_ONE_PATH_CALLS: '3',
      P3_FL_RATIO_ONE_PATH_CELLS: largestPrimaryCells().join(','),
    });
    const ratio = JSON.parse(readFileSync(output, 'utf8')) as RatioOutput;
    const config = {
      ...ratioModeConfig('functional'),
      calls: 2,
      onePath: { ...ratioModeConfig('functional').onePath, calls: 3 },
    };
    const analysis = analyzeRatioNative([ratio], config);
    // Minimal samples may be shorter than 100 quanta; every other item holds.
    expect(analysis.issues.filter((issue) => !issue.startsWith('UNVERIFIED'))).toEqual([]);
    expect(analysis.tenPath.every((item) => item.checksum !== null)).toBe(true);
    expect(ratio.onePath.map((item) => item.cell).sort()).toEqual(
      [...largestPrimaryCells()].sort(),
    );
  }, 900_000);
});

describe('P3 Alt-A1 AL-S1 oracle run on a subset dump (section 5.3)', () => {
  let dump: LadderDump;
  let harness: LadderOracleHarness;
  let names: string[];

  beforeAll(() => {
    // Path 0 of every B0 cell and the first 20 paths of the randomized family.
    const inputs = oracleDumpInputs().filter(
      (input) =>
        input.name.endsWith('#0') ||
        (input.name.startsWith('ladder/') && Number(input.name.slice(7)) < 20),
    );
    names = inputs.map((input) => input.name);
    const input = path.join(scratch, 'oracle-input.bin');
    writeFileSync(input, encodeDumpInput(inputs));
    const output = path.join(scratch, 'oracle.json');
    const dumpFile = path.join(scratch, 'oracle-dump.txt');
    cargoTest('run_ladder_oracle', {
      P3_B0_INPUT: path.join(scratch, 'corpus.bin'),
      P3_B0_OUTPUT: output,
      P3_FILL_LADDER_INPUT: input,
      P3_FILL_LADDER_DUMP: dumpFile,
    });
    harness = JSON.parse(readFileSync(output, 'utf8')) as LadderOracleHarness;
    dump = parseLadderDump(readFileSync(dumpFile, 'utf8'));
  }, 900_000);

  const failures = (results: LadderOracleResults) =>
    Object.fromEntries(ORACLE_GATES.map((id) => [id, results.gates[id].failures.length]));
  const evaluate = (
    dumpValue: LadderDump,
    harnessValue: LadderOracleHarness,
    referenceValue: B0Record = reference,
    expected: readonly string[] = names,
  ) =>
    evaluateLadderOracle(
      dumpValue,
      harnessValue,
      { sha256: '0', bytes: 0 },
      referenceValue,
      expected,
    );

  it('passes every gate, with SL-O4 over every corpus path, AL-I2 and MESH_CHECK 0', () => {
    expect(harness.entries).toBe(names.length);
    expect(dump.entries.map((entry) => entry.name)).toEqual(names);
    const results = evaluate(dump, harness);
    expect(failures(results)).toEqual(Object.fromEntries(ORACLE_GATES.map((id) => [id, 0])));
    const status = oracleStatus(results);
    expect(status.valid && status.meshCheckZero).toBe(true);
    expect(results.gates['SL-O4'].checked).toBe(1270 + 35);
    expect(results.gates['AL-I2'].checked).toBeGreaterThan(20);
    expect(results.gates['SL-O3'].checked).toBeGreaterThan(20);
    expect(results.checksums.every((item) => item.checksum10 === item.reference10)).toBe(true);
    expect(results.alI3.differing).toEqual([]);
    expect(results.o2.every((item) => item.asExpected)).toBe(true);
    console.log(
      `AL-S1 subset oracle run: ${JSON.stringify(Object.fromEntries(ORACLE_GATES.map((id) => [id, results.gates[id].checked])))}; AL-I3 ${JSON.stringify(results.alI3.allowed)}`,
    );
  }, 600_000);

  it('rejects positive controls, each by its gate', () => {
    const target = dump.entries.findIndex((entry) => entry.name === 'b0/P4/s=4#0');
    const fallback = dump.entries.findIndex((entry) => entry.rung === 'fallback');
    expect(target).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThanOrEqual(0);
    const mutateEntry = (
      index: number,
      mutate: (entry: Mutable<LadderDump['entries'][number]>) => void,
    ) => {
      const copy = clone(dump);
      mutate(copy.entries[index]!);
      return failures(evaluate(copy, harness));
    };
    // SL-O2: a flipped exported triangle.
    expect(
      mutateEntry(target, (entry) => {
        const [a, b, c] = entry.export!.triangles![0]!;
        entry.export!.triangles![0] = [a, c, b];
      })['SL-O2'],
    ).toBeGreaterThanOrEqual(1);
    // SL-O1: a certified deviation bound below the exact value.
    expect(
      mutateEntry(target, (entry) => {
        entry.maxDeviationSquared = '0000000000000001';
      })['SL-O1'],
    ).toBeGreaterThanOrEqual(1);
    // AL-I2 (module level) and the harness checks.
    expect(
      mutateEntry(fallback, (entry) => {
        entry.ladderExactAgrees = false;
      })['AL-I2'],
    ).toBe(1);
    expect(
      mutateEntry(target, (entry) => {
        entry.allocations = 3;
      }).harness,
    ).toBe(1);
    // MESH_CHECK on an unfaulted entry is counted and invalidates.
    const meshCheck = clone(dump);
    const entry = meshCheck.entries[fallback]!;
    entry.reason = 'MESH_CHECK';
    const counted = evaluate(meshCheck, harness);
    expect(counted.meshCheck.count).toBe(1);
    expect(oracleStatus(counted).meshCheckZero).toBe(false);
    // AL-I2 at export level, and a build_path record that disagrees with the ladder.
    const exported = clone(harness);
    exported.alI2.failures.push('b0/O1/P2/s=3#0');
    expect(failures(evaluate(dump, exported as LadderOracleHarness))['AL-I2']).toBe(1);
    const record = clone(harness);
    const built = record.paths.find((item) => item.name === 'b0/P4/s=4#0')!;
    built.rung = 'exact';
    built.reason = 'CLEARANCE';
    expect(failures(evaluate(dump, record as LadderOracleHarness)).harness).toBe(1);
    // SL-O4: a changed exact outcome, a changed checksum, a tampered identity record.
    const outcome = clone(harness);
    outcome.exactOutcomes[0]!.paths[0]!.triangles! += 1;
    expect(failures(evaluate(dump, outcome as LadderOracleHarness))['SL-O4']).toBe(1);
    const checksum = clone(harness);
    checksum.exactChecksums[0]!.checksum10 = 'ffffffffffffffff';
    expect(failures(evaluate(dump, checksum as LadderOracleHarness))['SL-O4']).toBe(1);
    const tampered = clone(reference);
    (tampered.analysis as { verdict: string }).verdict = 'FEASIBLE';
    expect(evaluate(dump, harness, tampered as B0Record).gates['SL-O4'].failures).toEqual([
      "identity record rejected by B0's validator: stored analysis differs from the recomputation",
    ]);
    // An incomplete dump: one entry dropped.
    const dropped = clone(dump);
    const [removed] = dropped.entries.splice(5, 1);
    expect(evaluate(dropped as LadderDump, harness).gates['SL-O4'].failures).toEqual([
      `dump has ${removed!.name} 0 times`,
      `dump has ${names.length - 1} entries (harness ${names.length}) for ${names.length} expected`,
    ]);
    // A dump from a revision-1 kernel.
    expect(failures(evaluate({ ...dump, revision: 1 }, harness)).harness).toBeGreaterThanOrEqual(1);
  }, 600_000);
});
