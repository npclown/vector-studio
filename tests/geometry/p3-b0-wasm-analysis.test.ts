/**
 * P3 Alt-A1 unit AL-U6 (`docs/plans/p3-alt-a1-fill-ladder-contract.md` sections 5.2 and 5.3,
 * AL-A13): the AL-S2 configuration and its pinned hash, the page's corpus decoder, shuffle and
 * checksum fold against independent references, the analysis, k̂ and k̂₁, the validity items,
 * the combined verdict with k = k̂, and `validateWasmRecord` on synthetic records (each
 * tampered record is rejected).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, configHash } from './p3-b0/analysis.js';
import { corpusCells, encodeCorpus, generateCellPaths } from './p3-b0/corpus.js';
import { B0_IDENTITY_RECORD } from './p3-b0-spike/analysis.js';
import { ratioModeConfig, type RatioOutput } from './p3-fill-ladder/analysis.js';
import {
  analyze,
  BROWSER_PROJECTS,
  CORPUS_SHA256,
  K_LABEL,
  largestCells,
  linkAlS1,
  pageOptions,
  scenarioConfig,
  sha256Hex,
  validateWasmRecord,
  type BrowserRecord,
  type WasmRecord,
} from './p3-b0-wasm/analysis.js';
import {
  decodeDecisionCells,
  Fnv1a64,
  orderSeed,
  shuffled,
  type WasmCapture,
  type WasmCellCapture,
  type WasmSample,
} from '../geometry-benchmark/p3-b0-wasm/workload.js';
import { parseArguments } from '../../tooling/run-p3-b0-wasm-benchmark.mjs';

const root = path.resolve(import.meta.dirname, '../..');
/** Recorded in the plan when AL-U6 merges; any configuration change shows up here. */
const REFERENCE_CONFIG_HASH = 'f337d0efb6c457118c624dacc9bcd6a9946f2c495437282c987f20be884c2bfd';
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const clone = <T>(value: T): Mutable<T> => JSON.parse(JSON.stringify(value)) as Mutable<T>;
const decision = corpusCells().filter((cell) => cell.role === 'decision');
const decisionIds = decision.map((cell) => cell.id);

/** FNV-1a 64 with BigInt, the independent reference of the two-word fold. */
function fnvBig(bytes: Uint8Array, start = 0xcbf29ce484222325n): bigint {
  let hash = start;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

describe('AL-S2 configuration', () => {
  it('embeds the ratio mode and pins its identity (section 5.2)', () => {
    const config = scenarioConfig('reference');
    expect(config.scenario).toEqual({ id: 'p3-b0-wasm', version: 1 });
    expect(config.runner).toBe('p3-b0-wasm-runner/1');
    expect(config.corpus.sha256).toBe(CORPUS_SHA256);
    expect(CORPUS_SHA256.startsWith('206cf6e9') && CORPUS_SHA256.endsWith('9796')).toBe(true);
    expect(config.native).toEqual(ratioModeConfig('reference'));
    expect(configHash(config.native)).toBe(
      'ff36ec78a920d704df431cf411f9c064bf1d3a0cb21523c83857a6bdad9ef9c3',
    );
    expect(config.operation.id).toBe('geometry-wasm/fill-v0+r2');
    expect(config.sampling).toMatchObject({ repetitions: 5, warmup: 3, timed: 20, calls: 100 });
    expect(config.sampling.onePath).toEqual({ cells: largestCells(), path: 0, calls: 1000 });
    expect(largestCells()).toEqual(['P2/s=16', 'P4/s=16', 'P8/s=8']);
    expect(config.ratio.label).toBe(K_LABEL);
    expect(config.browser.headed).toBe(true);
    expect(configHash(config)).toBe(REFERENCE_CONFIG_HASH);
    expect(configHash(scenarioConfig('functional'))).not.toBe(configHash(config));
    expect(scenarioConfig('functional').sampling).toMatchObject({ repetitions: 1, timed: 2 });
  });

  it('parses the runner arguments as B0 does, plus --al-s1', () => {
    expect(parseArguments(['--profile', 'functional'])).toEqual({
      profile: 'functional',
      environmentJson: null,
      alS1: null,
    });
    expect(
      parseArguments([
        '--al-s1',
        'docs/x.json',
        '--profile',
        'reference',
        '--environment-json',
        'e',
      ]),
    ).toEqual({ profile: 'reference', environmentJson: 'e', alS1: 'docs/x.json' });
    expect(() => parseArguments(['--profile', 'reference'])).toThrow(/environment-json/);
    expect(() => parseArguments(['--profile', 'functional', '--al-s1'])).toThrow(/al-s1/);
    expect(() => parseArguments(['--profile', 'functional', '--bogus', 'x'])).toThrow(/Unknown/);
  });
});

describe('AL-S2 page workload', () => {
  it('decodes the B0 corpus bytes into the 34 decision cells as port requests', () => {
    const bytes = encodeCorpus(corpusCells());
    expect(sha256Hex(bytes)).toBe(CORPUS_SHA256);
    const cells = decodeDecisionCells(bytes);
    expect(cells.map((cell) => cell.id)).toEqual(decisionIds);
    for (const cell of decision) {
      const decoded = cells.find((item) => item.id === cell.id)!;
      const paths = generateCellPaths(cell, 10);
      expect(decoded.requests).toHaveLength(10);
      decoded.requests.forEach((request, index) => {
        expect(request.requestId).toBe(index);
        expect(request.fillRule).toBe('nonzero');
        expect(request.toleranceExponent).toBe(-3);
        expect([...request.verbs]).toEqual(paths[index]!.verbs);
        expect([...request.points]).toEqual(paths[index]!.points);
      });
    }
    expect(() => decodeDecisionCells(bytes.subarray(0, bytes.length - 1))).toThrow();
  });

  it('shuffles as the native harness: the committed B0 record orders', () => {
    const record = JSON.parse(readFileSync(path.join(root, B0_IDENTITY_RECORD), 'utf8')) as {
      repetitions: { repetition: number; order: string[] }[];
    };
    expect(record.repetitions).toHaveLength(5);
    for (const repetition of record.repetitions)
      expect(shuffled(decisionIds, orderSeed(repetition.repetition))).toEqual(repetition.order);
  });

  it('folds bytes as FNV-1a 64 (BigInt reference)', () => {
    let state = 0x2545f491;
    const bytes = Uint8Array.from({ length: 4096 }, () => {
      state = (state ^ (state << 13)) >>> 0;
      state = (state ^ (state >>> 17)) >>> 0;
      state = (state ^ (state << 5)) >>> 0;
      return state & 0xff;
    });
    const fold = new Fnv1a64();
    fold.bytes(bytes);
    expect(fold.hex()).toBe(fnvBig(bytes).toString(16).padStart(16, '0'));
    fold.reset();
    fold.u32(0xdeadbeef);
    expect(fold.hex()).toBe(fnvBig(Uint8Array.of(0xef, 0xbe, 0xad, 0xde)).toString(16));
  });

  it('folds a port result as fold_decoded: status, V, T, pairs, then the block bytes', () => {
    const positions = Float64Array.of(0, 0, 1, 0, 0, 1);
    const indices = Uint32Array.of(0, 1, 2);
    const boundaryEdges = Uint32Array.of(0, 1, 1, 2, 2, 0);
    const fold = new Fnv1a64();
    expect(
      fold.result({
        status: 'ok',
        results: [
          {
            requestId: 0,
            toleranceExponent: -3,
            status: 'ok',
            mesh: {
              positions,
              indices,
              boundaryEdges,
              bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
            },
          },
          { requestId: 1, toleranceExponent: -3, status: 'failed', code: 'work-limit' },
          { requestId: 2, toleranceExponent: -3, status: 'empty' },
        ],
      }),
    ).toBe(true);
    const u32 = (...values: number[]) => new Uint8Array(Uint32Array.from(values).buffer);
    const expected = new Uint8Array([
      ...u32(0, 3, 1, 3),
      ...new Uint8Array(positions.buffer),
      ...new Uint8Array(indices.buffer),
      ...new Uint8Array(boundaryEdges.buffer),
      ...u32(5),
      ...u32(1),
    ]);
    expect(fold.hex()).toBe(fnvBig(expected).toString(16).padStart(16, '0'));
    fold.reset();
    expect(fold.result({ status: 'batch-failed', code: 'internal-error' })).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------
// Synthetic records.

const NATIVE_NS = 50_000; // per call of a 10-path cell
const NATIVE_ONE_NS = 10_000; // per one-path call
const checksumOf = (cell: string, onePath: boolean) =>
  sha256Hex(`${cell}${onePath ? '/1' : ''}`).slice(0, 16);

function nativeOutputs(profile: 'functional' | 'reference'): RatioOutput[] {
  const config = ratioModeConfig(profile);
  return Array.from({ length: config.sampling.repetitions }, (_, repetition) => {
    const cell = (id: string, onePath: boolean) => ({
      cell: id,
      allocations: 0,
      storageStable: true,
      sampleNs: Array.from(
        { length: config.sampling.timed },
        (_, index) =>
          (onePath ? NATIVE_ONE_NS * config.onePath.calls : NATIVE_NS * config.calls) + index,
      ),
      checksums: Array.from({ length: config.sampling.timed }, () => checksumOf(id, onePath)),
    });
    return {
      kind: 'ratio',
      repetition,
      revision: 2,
      clockQuantumNs: 100,
      calls: config.calls,
      onePathCalls: config.onePath.calls,
      order: shuffled(decisionIds, orderSeed(repetition)),
      cells: decisionIds.map((id) => cell(id, false)),
      onePath: config.onePath.cells.map((id) => cell(id, true)),
    };
  });
}

function captureFor(
  profile: 'functional' | 'reference',
  repetition: number,
  factor: number,
  wasmSha256: string,
): WasmCapture {
  const config = scenarioConfig(profile);
  const sample = (ms: number, checksum: string, calls: number): WasmSample => ({
    ms,
    checksum,
    epochDelta: calls,
    storageStable: true,
    batchFailures: 0,
  });
  const cell = (id: string, onePath: boolean): WasmCellCapture => {
    const calls = onePath ? config.sampling.onePath.calls : config.sampling.calls;
    const paths = onePath ? 1 : 10;
    const ms = ((onePath ? NATIVE_ONE_NS : NATIVE_NS) * calls * factor) / 1e6;
    const checksum = checksumOf(id, onePath);
    return {
      cell: id,
      calls,
      paths,
      preparation: sample(ms, checksum, calls),
      statuses: Array.from({ length: paths }, () => 'ok'),
      warmup: Array.from({ length: config.sampling.warmup }, () => sample(ms, checksum, calls)),
      timed: Array.from({ length: config.sampling.timed }, () => sample(ms, checksum, calls)),
    };
  };
  return {
    schema: 'p3-b0-wasm-capture/v1',
    options: { ...pageOptions(config, wasmSha256), repetition },
    wasmSha256,
    corpusSha256: CORPUS_SHA256,
    adapter: { operationId: 'geometry-wasm/fill-v0+r2', portVersion: 0 },
    crossOriginIsolated: true,
    clockProbe: {
      attempts: 10,
      durationMs: 1,
      positiveIncrementsMs: [0.005],
      minimumQuantumMs: 0.005,
    },
    setup: { fetchMs: 1, compileMs: 1, decodeMs: 1 },
    order: shuffled(decisionIds, orderSeed(repetition)),
    onePathOrder: shuffled(config.sampling.onePath.cells, orderSeed(repetition)),
    cells: decisionIds.map((id) => cell(id, false)),
    onePath: config.sampling.onePath.cells.map((id) => cell(id, true)),
    linearMemoryBytes: 4 * 2 ** 20,
    environment: {
      visibilityStart: 'visible',
      visibilityEnd: 'visible',
      visibilityEvents: [],
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      screen: { width: 1920, height: 1080 },
      navigator: { userAgent: 'test', platform: 'Win32', hardwareConcurrency: 12 },
    },
    errors: [],
  };
}

/** The kernel entries of a source manifest, as both runners record them. */
const KERNEL_MANIFEST = {
  'packages/geometry-wasm/kernel/Cargo.lock': '1'.repeat(64),
  'packages/geometry-wasm/kernel/Cargo.toml': '2'.repeat(64),
  'packages/geometry-wasm/kernel/src/lib.rs': '3'.repeat(64),
};

function alS1Bytes(
  perPathNs: number,
  p95Ns: number,
  manifest: Record<string, string> = KERNEL_MANIFEST,
): Uint8Array {
  const record = {
    schemaVersion: 1,
    scenario: { id: 'p3-fill-ladder', version: 1, profile: 'reference', configHash: 'abc' },
    run: {
      runId: '20261020T000000Z-00000000',
      sourceManifest: { ...manifest, 'tooling/run-p3-fill-ladder-benchmark.mjs': '4'.repeat(64) },
    },
    analysis: {
      estimates: {
        wasmFactor: 2,
        provisional: true,
        perPathNs,
        p95Ns,
        meshPerPathBytes: 5000,
        payloadPerPathBytes: 6000,
        initialMs: (1000 * perPathNs * 2) / 1e6,
        editMs: (p95Ns * 2) / 1e6,
        meshBytes: 5_000_000,
        payloadBytes: 6_000_000,
      },
      checks: [{ id: '2-prediction-factor', pass: true, detail: 'ok' }],
      invalidReasons: [],
      verdict: 'FEASIBLE',
    },
  };
  return new TextEncoder().encode(JSON.stringify(record));
}

const ALS1_PATH = 'docs/benchmarks/results/2026-10-20_p3_p3-fill-ladder-v1_native_x_y.json';
const acceptAlS1 = () => undefined;

function syntheticRecord(
  profile: 'functional' | 'reference',
  factors: Readonly<Record<string, number>> = { chrome: 1.5, edge: 1.25 },
  alS1: Uint8Array | null = alS1Bytes(500_000, 1_000_000),
): WasmRecord {
  const config = scenarioConfig(profile);
  const wasmSha256 = 'a'.repeat(64);
  const nativeConfig = ratioModeConfig(profile);
  const browsers: BrowserRecord[] = BROWSER_PROJECTS.flatMap((project) =>
    Array.from({ length: config.sampling.repetitions }, (_, repetition) => ({
      schema: 'p3-b0-wasm-browser/v1' as const,
      project,
      channel: project === 'chrome' ? 'chrome' : 'msedge',
      browserVersion: '141.0.0.0',
      launchFlags: ['--enable-automation'],
      repetition,
      startedAt: '2026-10-20T00:00:00.000Z',
      recordedAt: '2026-10-20T00:01:00.000Z',
      instrumentation: { headed: true, tracing: false, video: false, devtools: false },
      capture: captureFor(profile, repetition, factors[project]!, wasmSha256),
      error: null,
    })),
  );
  const record: WasmRecord = {
    schemaVersion: 1,
    scenario: { id: 'p3-b0-wasm', version: 1, profile, config, configHash: configHash(config) },
    run: {
      commit: 'deadbeef',
      utcStart: '2026-10-20T00:00:00.000Z',
      timezone: 'Asia/Seoul',
      sourceManifest: {
        ...KERNEL_MANIFEST,
        'tooling/run-p3-b0-wasm-benchmark.mjs': '5'.repeat(64),
      },
    },
    environment: {
      os: { type: 'Windows_NT' },
      cpu: 'test cpu',
      power: { value: 'AC', source: 'test' },
      backgroundLoad: { value: 'idle', source: 'test' },
    },
    builds: { wasm: { sha256: wasmSha256, bytes: 1 }, page: { sha256: 'b'.repeat(64) } },
    corpus: { sha256: CORPUS_SHA256, bytes: 1 },
    native: {
      config: nativeConfig,
      configHash: configHash(nativeConfig),
      toolchain: { release: '1.94.1' },
      build: { command: 'cargo test', targetDirectory: '.tools/geometry-build', rustflags: [] },
      corpus: { sha256: CORPUS_SHA256, bytes: 1 },
      repetitions: nativeOutputs(profile),
      failures: [],
    },
    browsers,
    alS1: alS1 === null ? null : linkAlS1(ALS1_PATH, alS1),
    failures: [],
  };
  return { ...record, analysis: analyze(record) };
}

describe('AL-S2 analysis and combined verdict', () => {
  it('computes k̂ at the largest primary cells, k̂₁ report-only, and the product verdict', () => {
    const record = syntheticRecord('reference');
    const analysis = analyze(record);
    expect(analysis.checks.filter((item) => !item.pass)).toEqual([]);
    expect(analysis.valid).toBe(true);
    // Chrome 1.5 > Edge 1.25; the native samples carry +index ns, so r is just below 1.5.
    expect(analysis.kHat).toBeCloseTo(1.5, 3);
    expect(analysis.kHat!).toBeLessThanOrEqual(1.5);
    expect(analysis.kHatOnePath).toBeCloseTo(1.5, 3);
    expect(analysis.kLabel).toBe(K_LABEL);
    // T̂ = 1000 · 0.5 ms · k̂ = 750 ms ≤ 1000; t̂_edit = 1 ms · k̂ = 1.5 ms ≤ 4; M̂ ≤ 64 MiB.
    expect(analysis.product.verdict).toBe('FEASIBLE');
    expect(analysis.product.estimates!.initialMs).toBeCloseTo(750, 0);
    expect(analysis.product.estimates!.editOnePathContextMs).toBeCloseTo(1.5, 2);
    validateWasmRecord(clone(record), alS1Bytes(500_000, 1_000_000), acceptAlS1);
  });

  it('is INFEASIBLE when k̂ pushes an estimate over its budget', () => {
    const record = syntheticRecord('reference', { chrome: 2.5, edge: 1 });
    expect(record.analysis).toMatchObject({ product: { verdict: 'INFEASIBLE' } });
  });

  it('takes the maximum over browsers of the per-cell median over repetitions', () => {
    const record = clone(syntheticRecord('reference', { chrome: 1, edge: 1 }));
    // One outlier repetition of Edge does not move its median; a 3-of-5 shift does.
    for (const browser of record.browsers.filter((item) => item.project === 'edge')) {
      if (browser.repetition > 2) continue;
      for (const sample of browser.capture!.cells.find((cell) => cell.cell === 'P8/s=8')!.timed)
        sample.ms *= 2;
    }
    const analysis = analyze(record);
    expect(analysis.kHat).toBeCloseTo(2, 3);
  });

  it('has no verdict on a checksum mismatch and is INCONCLUSIVE on other validity failures', () => {
    const mismatch = clone(syntheticRecord('reference'));
    mismatch.browsers[0]!.capture!.cells[0]!.timed[0]!.checksum = '0'.repeat(16);
    const invalid = analyze(mismatch);
    expect(invalid.checks.find((item) => item.id === 'checksums-equal-native')!.pass).toBe(false);
    expect(invalid.product.verdict).toBe('INVALID');

    const reserve = clone(syntheticRecord('reference'));
    reserve.browsers[0]!.capture!.cells[3]!.timed[1]!.epochDelta += 1;
    const growth = analyze(reserve);
    expect(growth.checks.find((item) => item.id === 'no-reserve-or-growth')!.pass).toBe(false);
    expect(growth.product.verdict).toBe('INCONCLUSIVE');

    const quantum = clone(syntheticRecord('reference'));
    quantum.browsers[1]!.capture!.clockProbe.minimumQuantumMs = 1;
    const coarse = analyze(quantum);
    expect(coarse.checks.find((item) => item.id === 'largest-primary-verified')!.pass).toBe(false);
    expect(coarse.product.verdict).toBe('INCONCLUSIVE');

    const missing = clone(syntheticRecord('reference'));
    missing.browsers.pop();
    expect(analyze(missing as WasmRecord).product.verdict).toBe('INCONCLUSIVE');

    const unlinked = syntheticRecord('reference', undefined, null);
    expect(unlinked.analysis).toMatchObject({ product: { verdict: 'INCONCLUSIVE' } });
  });

  const failing = (record: WasmRecord) =>
    analyze(record)
      .checks.filter((item) => !item.pass)
      .map((item) => item.id);

  it('reports a whole missing browser or native leg as incomplete, not as a mismatch (B1)', () => {
    const noEdge = clone(syntheticRecord('reference'));
    noEdge.browsers = noEdge.browsers.filter((item) => item.project !== 'edge');
    expect(failing(noEdge)).toContain('repetitions-complete');
    expect(failing(noEdge)).not.toContain('checksums-equal-native');
    expect(analyze(noEdge).product.verdict).toBe('INCONCLUSIVE');

    const noNative = clone(syntheticRecord('reference'));
    noNative.native = null;
    expect(failing(noNative)).toContain('repetitions-complete');
    expect(failing(noNative)).not.toContain('checksums-equal-native');
    expect(analyze(noNative).product.verdict).toBe('INCONCLUSIVE');

    const noCell = clone(syntheticRecord('reference'));
    noCell.browsers[0]!.capture!.cells.splice(4, 1);
    expect(failing(noCell)).toContain('repetitions-complete');
    expect(failing(noCell)).not.toContain('checksums-equal-native');
  });

  it('is INCONCLUSIVE when the linked AL-S1 record measured other kernel sources (S1)', () => {
    const changed = {
      ...KERNEL_MANIFEST,
      'packages/geometry-wasm/kernel/src/lib.rs': '9'.repeat(64),
    };
    const record = syntheticRecord('reference', undefined, alS1Bytes(500_000, 1_000_000, changed));
    const analysis = record.analysis as ReturnType<typeof analyze>;
    expect(analysis.alS1Kernel.equal).toBe(false);
    expect(failing(record)).toEqual(['al-s1-same-kernel']);
    expect(analysis.product.verdict).toBe('INCONCLUSIVE');
    const unlisted = syntheticRecord('reference', undefined, alS1Bytes(500_000, 1_000_000, {}));
    expect(failing(unlisted)).toEqual(['al-s1-same-kernel']);
    expect(syntheticRecord('reference').analysis).toMatchObject({ alS1Kernel: { equal: true } });
  });

  it('requires cross-origin isolation, B0 orders and the README browser fields (S3, S4, S7)', () => {
    const isolated = clone(syntheticRecord('reference'));
    isolated.browsers[1]!.capture!.crossOriginIsolated = false;
    expect(failing(isolated)).toEqual(['cross-origin-isolated']);

    const order = clone(syntheticRecord('reference'));
    order.browsers[0]!.capture!.order.reverse();
    expect(failing(order)).toEqual(['operation-identity']);
    const onePathOrder = clone(syntheticRecord('reference'));
    onePathOrder.browsers[0]!.capture!.onePathOrder.reverse();
    expect(failing(onePathOrder)).toEqual(['operation-identity']);
    const nativeOrder = clone(syntheticRecord('reference'));
    nativeOrder.native!.repetitions[2]!.order.reverse();
    expect(failing(nativeOrder)).toEqual(['operation-identity']);

    const flags = clone(syntheticRecord('reference'));
    flags.browsers[3]!.launchFlags = [];
    expect(failing(flags)).toEqual(['metadata-complete']);
    const channel = clone(syntheticRecord('reference'));
    channel.browsers[3]!.channel = null;
    expect(failing(channel)).toEqual(['metadata-complete']);
    const dpr = clone(syntheticRecord('reference'));
    (
      dpr.browsers[0]!.capture!.environment.viewport as { devicePixelRatio: unknown }
    ).devicePixelRatio = null;
    expect(failing(dpr)).toEqual(['metadata-complete']);
    for (const record of [isolated, order, flags])
      expect(analyze(record).product.verdict).toBe('INCONCLUSIVE');
  });

  it('gives a functional run no verdict', () => {
    const record = syntheticRecord('functional', undefined, null);
    expect(record.analysis).toMatchObject({ valid: true, product: { verdict: 'NONE' } });
    validateWasmRecord(clone(record), null, acceptAlS1);
  });
});

describe('validateWasmRecord tamper tests', () => {
  const bytes = alS1Bytes(500_000, 1_000_000);
  const base = () => clone(syntheticRecord('reference'));
  const rejects = (record: unknown, message: RegExp, alS1: Uint8Array | null = bytes) =>
    expect(() => validateWasmRecord(record as WasmRecord, alS1, acceptAlS1)).toThrow(message);

  it('rejects a changed sample, k̂ or verdict', () => {
    const sample = base();
    for (const item of sample.browsers[2]!.capture!.cells[5]!.timed) item.ms *= 1.01;
    rejects(sample, /stored analysis/);
    const native = base();
    const nativeSamples = native.native!.repetitions[0]!.cells[0]!.sampleNs;
    nativeSamples.forEach((value, index) => (nativeSamples[index] = value + 1000));
    rejects(native, /stored analysis/);
    const k = base();
    (k.analysis as { kHat: number }).kHat = 1;
    rejects(k, /stored analysis/);
    const verdict = base();
    (verdict.analysis as { product: { verdict: string } }).product.verdict = 'INFEASIBLE';
    rejects(verdict, /stored analysis/);
  });

  it('pins the configuration and its hash', () => {
    const config = base();
    config.scenario.config.sampling.timed = 19;
    config.scenario.configHash = configHash(config.scenario.config);
    rejects(config, /differs from scenarioConfig/);
    const hash = base();
    hash.scenario.configHash = '0'.repeat(64);
    rejects(hash, /configuration hash/);
    const nativeConfig = base();
    nativeConfig.native!.config.calls = 10;
    rejects(nativeConfig, /native configuration/);
    const corpus = base();
    corpus.corpus.sha256 = '0'.repeat(64);
    rejects(corpus, /corpus hash/);
  });

  it('checks the AL-S1 link against the linked bytes', () => {
    rejects(base(), /hash mismatch/, alS1Bytes(400_000, 1_000_000));
    rejects(base(), /required/, null);
    const link = base();
    link.alS1!.analysis.estimates!.perPathNs = 1;
    rejects(link, /link differs/);
    const failing = base();
    expect(() =>
      validateWasmRecord(failing as WasmRecord, bytes, () => {
        throw new Error('AL-S1 record rejected');
      }),
    ).toThrow(/AL-S1 record rejected/);
    expect(canonicalJson(base().alS1)).toBe(canonicalJson(linkAlS1(ALS1_PATH, bytes)));
  });
});
