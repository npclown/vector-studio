import { describe, expect, it } from 'vitest';
import {
  aggregateP2Records,
  analyzeP2Capture,
  nearestRank,
  p2Profile,
  p2Hash,
  type P2RawRecord,
} from '../support/p2-benchmark-record.js';
import type {
  P2Capture,
  P2ProfileName,
  P2SessionCounters,
  P2VariantName,
  P2VariantSample,
  P2WorkCounter,
} from '../geometry-benchmark/types.js';

type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };
const wasm = 'a'.repeat(64),
  source = 'b'.repeat(64),
  build = 'c'.repeat(64);
const zeroWork = (): P2WorkCounter => ({
  logicalCubics: '0',
  sizingVisits: '0',
  emissionVisits: '0',
  emittedCubicLines: '0',
  attemptedPaths: '0',
  failedPaths: '0',
});
const stats = (): P2SessionCounters => ({
  hits: 0,
  misses: 0,
  kernelPathBuilds: 0,
  evictions: 0,
  retainedPayloadBytes: 0,
  liveLinearMemoryBytes: 2_097_152,
  residentNodes: 0,
  variantEntries: 0,
  kernelWork: zeroWork(),
});

// These synthetic counters describe straight-line cubics. They test record
// evaluation only and are never persisted as observed benchmark evidence.
function fixture(
  profile: P2ProfileName = 'functional',
  repetition = 1,
  batchMs = 10,
  perPathMs = 13,
): Mutable<P2Capture> {
  const schedule = p2Profile(profile);
  const previous: Record<P2VariantName, P2SessionCounters> = {
    batch: stats(),
    'per-path': stats(),
  };
  let time = 0;
  const sample = (variant: P2VariantName, preparation: boolean): P2VariantSample => {
    const before = previous[variant];
    const work: P2WorkCounter = {
      logicalCubics: '32000',
      sizingVisits: '32000',
      emissionVisits: '32000',
      emittedCubicLines: '32000',
      attemptedPaths: '1000',
      failedPaths: '0',
    };
    const after: P2SessionCounters = {
      ...before,
      misses: before.misses + 1000,
      kernelPathBuilds: before.kernelPathBuilds + 1000,
      kernelWork: Object.fromEntries(
        (Object.keys(work) as Array<keyof P2WorkCounter>).map((key) => [
          key,
          String(BigInt(before.kernelWork[key]) + BigInt(work[key])),
        ]),
      ) as unknown as P2WorkCounter,
    };
    previous[variant] = after;
    const calls = variant === 'batch' ? 1 : 1000;
    const durationMs = variant === 'batch' ? batchMs : perPathMs;
    const startMs = time;
    time += durationMs;
    return {
      variant,
      timing: { startMs, endMs: time, durationMs },
      batchStatuses: Array<string>(calls).fill('OK'),
      pathStatuses: { OK: 1000 },
      checksum: '0123456789abcdef',
      resultCount: 1000,
      copiedPayloadBytes: 957000,
      peakRetainedPayloadBytes: variant === 'batch' ? 957000 : 957,
      calls: {
        reserveStatuses: preparation ? [0] : [],
        processStatuses: Array<number>(calls).fill(0),
        disposeStatuses: [],
        growths: 0,
        sizingPasses: calls,
        emissionPasses: calls,
      },
      statisticsBefore: before,
      statisticsAfter: after,
      work,
      errors: [],
    };
  };
  const samples: P2Capture['samples'][number][] = [];
  for (const [phase, count] of [
    ['preparation', 1],
    ['warmup', schedule.warmupPairs],
    ['measured', schedule.measuredPairs],
  ] as const) {
    for (let pairIndex = 0; pairIndex < count; pairIndex++) {
      const order = (repetition - 1 + pairIndex) % 2 === 0 ? 'AB' : 'BA';
      const first = sample(order === 'AB' ? 'batch' : 'per-path', phase === 'preparation');
      const second = sample(order === 'AB' ? 'per-path' : 'batch', phase === 'preparation');
      samples.push({
        phase,
        pairIndex,
        order,
        batch: order === 'AB' ? first : second,
        perPath: order === 'AB' ? second : first,
        errors: [],
      });
    }
  }
  return structuredClone({
    schema: 'p2-geometry-benchmark/v1',
    profile: schedule,
    repetition,
    wasmSha256: wasm,
    configuration: {
      scenario: 'p2-batch/v1',
      seed: 0x12345678,
      paths: 1000,
      cubicsPerPath: 32,
      inputPathCount: 1000,
      inputCubicCount: 32000,
      localTolerance: 0.25,
      world: [1, 0, 0, 1],
      zoom: 1,
      devicePixelRatio: 1,
      cache: { maxNodes: 0, maxVariants: 0, maxPayloadBytes: 0 },
    },
    setup: {
      fetchMs: 1,
      compileMs: 1,
      instantiationMs: { batch: 1, 'per-path': 1 },
      preparationReserveMs: { batch: 1, 'per-path': 1 },
      preparedInputCapacity: { batch: 2000000, 'per-path': 2048 },
      preparedOutputCapacity: { batch: 1100000, 'per-path': 2048 },
      preparationChecksums: { batch: '0123456789abcdef', 'per-path': '0123456789abcdef' },
    },
    samples,
    environment: {
      visibilityStart: 'visible',
      visibilityEnd: 'visible',
      visibilityEvents: [],
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      window: {
        innerWidth: 1280,
        innerHeight: 720,
        outerWidth: 1300,
        outerHeight: 780,
        screenX: 0,
        screenY: 0,
      },
      screen: {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1040,
        colorDepth: 24,
        pixelDepth: 24,
        orientation: 'landscape-primary',
      },
      clockProbe: {
        targetPositiveIncrements: 32,
        maxAttempts: 1000000,
        maxDurationMs: 100,
        attempts: 100,
        durationMs: 1,
        positiveIncrementsMs: Array<number>(32).fill(0.01),
        minimumQuantumMs: 0.01,
      },
      navigator: {
        userAgent: 'unit fixture',
        platform: 'unit fixture',
        language: 'en',
        languages: ['en'],
        hardwareConcurrency: 1,
        deviceMemoryGiB: null,
      },
      gpu: { unavailable: 'unit fixture' },
    },
    cleanup: {
      batch: { ...previous.batch, liveLinearMemoryBytes: 0 },
      'per-path': { ...previous['per-path'], liveLinearMemoryBytes: 0 },
    },
    disposeStatuses: { batch: [0], 'per-path': [0] },
    errors: [],
  } satisfies P2Capture) as unknown as Mutable<P2Capture>;
}

function record(profile: P2ProfileName, project: string, repetition: number): P2RawRecord {
  const capture = fixture(profile, repetition);
  return {
    schema: 'p2-record/v1',
    project,
    browserVersion: '153.0.1',
    launchFlags: ['--enable-automation'],
    profile,
    repetition,
    recordedAt: '2026-09-26T00:00:00Z',
    instrumentation: {
      headed: profile === 'reference',
      tracing: false,
      video: false,
      devtools: false,
    },
    sourceSha256: source,
    buildSha256: build,
    wasmSha256: wasm,
    capture,
    configurationSha256: p2Hash({
      configuration: capture.configuration,
      profile: capture.profile,
      viewport: capture.environment.viewport,
    }),
    error: null,
  };
}

describe('P2 independent benchmark record evaluation', () => {
  it('keeps functional observations separate and computes exact nearest-rank reference criteria', () => {
    expect(analyzeP2Capture(fixture(), 'functional', 1, wasm).disposition).toBe('FUNCTIONAL_PASS');
    const passed = analyzeP2Capture(fixture('reference', 1, 10, 12), 'reference', 1, wasm);
    expect(passed.findings).toEqual([]);
    expect(passed.disposition).toBe('PASS');
    expect(passed.medianPairedSpeedup).toBe(1.2);
    expect(passed.batch).toMatchObject({ count: 30, median: 10, p95: 10, p99: 10 });
    expect(
      analyzeP2Capture(fixture('reference', 1, 10, 11), 'reference', 1, wasm).disposition,
    ).toBe('FAIL');
    expect(
      nearestRank(
        Array.from({ length: 30 }, (_, index) => index + 1),
        0.95,
      ),
    ).toBe(29);
  });

  it('rejects tampered workload, source, outputs, work, order, timing and lifetimes', () => {
    const corruptions: Array<(capture: Mutable<P2Capture>) => void> = [
      (c) => {
        c.configuration.seed++;
      },
      (c) => {
        c.wasmSha256 = source;
      },
      (c) => {
        c.samples.pop();
      },
      (c) => {
        c.samples[2]!.order = 'BA';
      },
      (c) => {
        c.samples[2]!.batch.timing.durationMs++;
      },
      (c) => {
        c.samples[2]!.batch.checksum = 'ffffffffffffffff';
      },
      (c) => {
        c.samples[2]!.batch.pathStatuses = { OK: 999, INVALID_PATH: 1 };
      },
      (c) => {
        c.samples[2]!.batch.calls.processStatuses.push(0);
      },
      (c) => {
        c.samples[2]!.batch.calls.reserveStatuses.push(0);
      },
      (c) => {
        c.samples[2]!.batch.calls.growths++;
      },
      (c) => {
        c.samples[2]!.batch.calls.sizingPasses++;
      },
      (c) => {
        c.samples[2]!.batch.work.logicalCubics = '1';
      },
      (c) => {
        c.samples[2]!.batch.copiedPayloadBytes--;
      },
      (c) => {
        c.samples[2]!.perPath.peakRetainedPayloadBytes = c.samples[2]!.perPath.copiedPayloadBytes;
      },
      (c) => {
        c.samples[2]!.batch.statisticsAfter.hits++;
      },
      (c) => {
        c.environment.visibilityEnd = 'hidden';
      },
      (c) => {
        c.cleanup.batch.liveLinearMemoryBytes = 1;
      },
      (c) => {
        c.environment.clockProbe.minimumQuantumMs = null;
      },
      (c) => {
        c.environment.navigator.userAgent = '';
      },
      (c) => {
        c.cleanup.batch.misses++;
      },
      (c) => {
        c.disposeStatuses.batch = [4];
      },
      (c) => {
        c.samples[2]!.batch.statisticsAfter.evictions = -1;
      },
      (c) => {
        c.samples[0]!.batch.calls.processStatuses.unshift(2, 2);
      },
    ];
    for (const corrupt of corruptions) {
      const capture = fixture();
      corrupt(capture);
      expect(analyzeP2Capture(capture, 'functional', 1, wasm).disposition, corrupt.toString()).toBe(
        'FUNCTIONAL_FAIL',
      );
    }
    expect(analyzeP2Capture(null, 'reference', 1, wasm).disposition).toBe('UNVERIFIED');
  });

  it('does not accept unresolved or insufficient timer resolution', () => {
    const capture = fixture('reference');
    capture.environment.clockProbe.minimumQuantumMs = null;
    expect(analyzeP2Capture(capture, 'reference', 1, wasm).disposition).toBe('UNVERIFIED');
    capture.environment.clockProbe.minimumQuantumMs = 1;
    capture.environment.clockProbe.positiveIncrementsMs.fill(1);
    expect(analyzeP2Capture(capture, 'reference', 1, wasm).disposition).toBe('UNVERIFIED');
  });

  it('requires every independent repetition and consistent source, browser and instrumentation', () => {
    const records = ['chrome', 'edge'].flatMap((project) =>
      Array.from({ length: 5 }, (_, index) => record('reference', project, index + 1)),
    );
    const identity = {
      profile: 'reference' as const,
      sourceSha256: source,
      buildSha256: build,
      wasmSha256: wasm,
      integrityFindings: [],
    };
    expect(aggregateP2Records(records, identity).disposition).toBe('PASS');
    expect(aggregateP2Records(records.slice(1), identity).disposition).toBe('UNVERIFIED');
    expect(aggregateP2Records([...records, records[0]], identity).disposition).toBe('UNVERIFIED');
    for (const update of [
      { sourceSha256: wasm },
      { configurationSha256: wasm },
      { browserVersion: 'changed' },
      { launchFlags: ['--headless'] },
      { error: 'page failed' },
    ]) {
      expect(
        aggregateP2Records([{ ...records[0], ...update }, ...records.slice(1)], identity)
          .disposition,
      ).toBe('UNVERIFIED');
    }
    expect(
      aggregateP2Records(records, { ...identity, integrityFindings: ['source changed'] })
        .disposition,
    ).toBe('UNVERIFIED');
    const functional = aggregateP2Records(
      [record('functional', 'chrome', 1), record('functional', 'edge', 1)],
      { ...identity, profile: 'functional' },
    );
    expect(functional.disposition).toBe('FUNCTIONAL_PASS');
    expect(functional.performanceDisposition).toBe('NOT_APPLICABLE');
  });
});
