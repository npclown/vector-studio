export type P2ProfileName = 'functional' | 'reference';
export type P2VariantName = 'batch' | 'per-path';
export type P2PairOrder = 'AB' | 'BA';

export interface P2BenchmarkProfile {
  readonly name: P2ProfileName;
  readonly warmupPairs: number;
  readonly measuredPairs: number;
  readonly repetitions: number;
}

export const P2_PROFILES: Readonly<Record<P2ProfileName, P2BenchmarkProfile>> = {
  functional: { name: 'functional', warmupPairs: 1, measuredPairs: 2, repetitions: 1 },
  reference: { name: 'reference', warmupPairs: 10, measuredPairs: 30, repetitions: 5 },
};

export const P2_CACHE = { maxVariants: 0, maxNodes: 0, maxPayloadBytes: 0 } as const;

export function p2PairOrder(pairIndex: number, repetition: number): P2PairOrder {
  return (repetition - 1 + pairIndex) % 2 === 0 ? 'AB' : 'BA';
}

export interface P2WorkCounter {
  readonly logicalCubics: string;
  readonly sizingVisits: string;
  readonly emissionVisits: string;
  readonly emittedCubicLines: string;
  readonly attemptedPaths: string;
  readonly failedPaths: string;
}

export interface P2KernelCalls {
  readonly reserveStatuses: readonly number[];
  readonly processStatuses: readonly number[];
  readonly disposeStatuses: readonly number[];
  readonly growths: number;
  readonly sizingPasses: number;
  readonly emissionPasses: number;
}

export interface P2SessionCounters {
  readonly hits: number;
  readonly misses: number;
  readonly kernelPathBuilds: number;
  readonly evictions: number;
  readonly retainedPayloadBytes: number;
  readonly liveLinearMemoryBytes: number;
  readonly residentNodes: number;
  readonly variantEntries: number;
  readonly kernelWork: P2WorkCounter;
}

export interface P2VariantSample {
  readonly variant: P2VariantName;
  readonly timing: Readonly<{ startMs: number; endMs: number; durationMs: number }>;
  readonly batchStatuses: readonly string[];
  readonly pathStatuses: Readonly<Record<string, number>>;
  readonly checksum: string;
  readonly resultCount: number;
  readonly copiedPayloadBytes: number;
  readonly peakRetainedPayloadBytes: number;
  readonly calls: P2KernelCalls;
  readonly statisticsBefore: P2SessionCounters;
  readonly statisticsAfter: P2SessionCounters;
  readonly work: P2WorkCounter;
  readonly errors: readonly string[];
}

export interface P2SamplePair {
  readonly phase: 'preparation' | 'warmup' | 'measured';
  readonly pairIndex: number;
  readonly order: P2PairOrder;
  readonly batch: P2VariantSample;
  readonly perPath: P2VariantSample;
  readonly errors: readonly string[];
}

export interface P2VisibilityEvent {
  readonly atMs: number;
  readonly state: DocumentVisibilityState;
}

export interface P2Capture {
  readonly schema: 'p2-geometry-benchmark/v1';
  readonly profile: P2BenchmarkProfile;
  readonly repetition: number;
  readonly wasmSha256: string;
  readonly configuration: Readonly<{
    scenario: 'p2-batch/v1';
    seed: number;
    paths: 1000;
    cubicsPerPath: 32;
    inputPathCount: 1000;
    inputCubicCount: 32000;
    localTolerance: 0.25;
    world: readonly [1, 0, 0, 1];
    zoom: 1;
    devicePixelRatio: 1;
    cache: Readonly<{ maxVariants: 0; maxNodes: 0; maxPayloadBytes: 0 }>;
  }>;
  readonly setup: Readonly<{
    fetchMs: number;
    compileMs: number;
    instantiationMs: Readonly<Record<P2VariantName, number>>;
    preparationReserveMs: Readonly<Record<P2VariantName, number>>;
    preparedInputCapacity: Readonly<Record<P2VariantName, number>>;
    preparedOutputCapacity: Readonly<Record<P2VariantName, number>>;
    preparationChecksums: Readonly<Record<P2VariantName, string>>;
  }>;
  readonly samples: readonly P2SamplePair[];
  readonly environment: Readonly<{
    visibilityStart: DocumentVisibilityState;
    visibilityEnd: DocumentVisibilityState;
    visibilityEvents: readonly P2VisibilityEvent[];
    viewport: Readonly<{ width: number; height: number; devicePixelRatio: number }>;
    window: Readonly<{
      innerWidth: number;
      innerHeight: number;
      outerWidth: number;
      outerHeight: number;
      screenX: number;
      screenY: number;
    }>;
    screen: Readonly<{
      width: number;
      height: number;
      availWidth: number;
      availHeight: number;
      colorDepth: number;
      pixelDepth: number;
      orientation: string | null;
    }>;
    clockProbe: Readonly<{
      targetPositiveIncrements: 32;
      maxAttempts: number;
      maxDurationMs: number;
      attempts: number;
      durationMs: number;
      positiveIncrementsMs: readonly number[];
      minimumQuantumMs: number | null;
    }>;
    navigator: Readonly<{
      userAgent: string;
      platform: string;
      language: string;
      languages: readonly string[];
      hardwareConcurrency: number | null;
      deviceMemoryGiB: number | null;
    }>;
    gpu: unknown;
  }>;
  readonly cleanup: Readonly<Record<P2VariantName, P2SessionCounters>>;
  readonly disposeStatuses: Readonly<Record<P2VariantName, readonly number[]>>;
  readonly errors: readonly string[];
}
