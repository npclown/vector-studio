import {
  GeometrySession,
  type GeometryKernelExports,
} from '../../packages/geometry-wasm/src/index.js';

import { measureVariant, observeKernel, sessionCounters, type KernelObserver } from './measure.js';
import type {
  P2Capture,
  P2PairOrder,
  P2SamplePair,
  P2VariantName,
  P2VisibilityEvent,
} from './types.js';
import { P2_CACHE, P2_PROFILES, p2PairOrder } from './types.js';
import {
  createP2Workload,
  P2_DEVICE_PIXEL_RATIO,
  P2_LOCAL_TOLERANCE,
  P2_SCENARIO,
  P2_WORKLOAD_CUBICS_PER_PATH,
  P2_WORKLOAD_CUBIC_COUNT,
  P2_WORKLOAD_PATHS,
  P2_WORKLOAD_SEED,
  P2_WORLD,
  P2_ZOOM,
} from './workload.js';

declare global {
  interface Window {
    runP2Benchmark: (options: {
      profile: 'functional' | 'reference';
      repetition: number;
      expectedWasmSha256: string;
    }) => Promise<P2Capture>;
  }
}

const WORKLOAD = createP2Workload();

interface VariantRuntime {
  readonly name: P2VariantName;
  readonly observer: KernelObserver;
  readonly session: GeometrySession;
  readonly instantiationMs: number;
}

function detail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function probeClock() {
  const targetPositiveIncrements = 32 as const;
  const maxAttempts = 100_000;
  const maxDurationMs = 250;
  const positiveIncrementsMs: number[] = [];
  const start = performance.now();
  let previous = start;
  let attempts = 0;
  while (
    positiveIncrementsMs.length < targetPositiveIncrements &&
    attempts < maxAttempts &&
    performance.now() - start < maxDurationMs
  ) {
    const current = performance.now();
    const increment = current - previous;
    if (Number.isFinite(increment) && increment > 0) positiveIncrementsMs.push(increment);
    previous = current;
    attempts += 1;
  }
  const durationMs = performance.now() - start;
  return {
    targetPositiveIncrements,
    maxAttempts,
    maxDurationMs,
    attempts,
    durationMs,
    positiveIncrementsMs,
    minimumQuantumMs: positiveIncrementsMs.length === 0 ? null : Math.min(...positiveIncrementsMs),
  };
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

async function gpuMetadata(): Promise<unknown> {
  const gpu = navigator.gpu;
  if (gpu === undefined)
    return { available: false, reason: 'navigator.gpu is unavailable', deviceRequested: false };
  try {
    const adapter = await gpu.requestAdapter();
    if (adapter === null)
      return { available: false, reason: 'GPU adapter unavailable', deviceRequested: false };
    const limits = {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    };
    let info: unknown = { available: false, reason: 'adapter info API unavailable' };
    const withInfo = adapter as GPUAdapter & { requestAdapterInfo?: () => Promise<GPUAdapterInfo> };
    if (adapter.info !== undefined) {
      info = {
        available: true,
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      };
    } else if (withInfo.requestAdapterInfo !== undefined) {
      try {
        const adapterInfo = await withInfo.requestAdapterInfo();
        info = {
          available: true,
          vendor: adapterInfo.vendor,
          architecture: adapterInfo.architecture,
          device: adapterInfo.device,
          description: adapterInfo.description,
        };
      } catch (error) {
        info = { available: false, reason: detail(error) };
      }
    }
    return {
      available: true,
      features: [...adapter.features].sort(),
      limits,
      info,
      deviceRequested: false,
      scope: 'optional adapter metadata only; benchmark performs CPU/WASM geometry work',
    };
  } catch (error) {
    return { available: false, reason: detail(error), deviceRequested: false };
  }
}

async function instantiateVariant(
  name: P2VariantName,
  module: WebAssembly.Module,
): Promise<VariantRuntime> {
  const start = performance.now();
  const instance = await WebAssembly.instantiate(module, {});
  const observer = observeKernel(instance.exports as unknown as GeometryKernelExports);
  const session = new GeometrySession(observer.kernel, { cache: P2_CACHE });
  return { name, observer, session, instantiationMs: performance.now() - start };
}

function samplePair(
  phase: P2SamplePair['phase'],
  pairIndex: number,
  order: P2PairOrder,
  batch: VariantRuntime,
  perPath: VariantRuntime,
): P2SamplePair {
  const first = order === 'AB' ? batch : perPath;
  const second = order === 'AB' ? perPath : batch;
  const byName = new Map<P2VariantName, ReturnType<typeof measureVariant>>();
  byName.set(
    first.name,
    measureVariant(first.name, first.session, first.observer, WORKLOAD.requests),
  );
  byName.set(
    second.name,
    measureVariant(second.name, second.session, second.observer, WORKLOAD.requests),
  );
  const batchSample = byName.get('batch');
  const perPathSample = byName.get('per-path');
  if (batchSample === undefined || perPathSample === undefined)
    throw new Error('sample pair did not execute both variants');
  const errors = [
    ...batchSample.errors.map((value) => `batch: ${value}`),
    ...perPathSample.errors.map((value) => `per-path: ${value}`),
  ];
  if (batchSample.checksum !== perPathSample.checksum) errors.push('variant checksums differ');
  return { phase, pairIndex, order, batch: batchSample, perPath: perPathSample, errors };
}

function emptyCounters() {
  return {
    hits: 0,
    misses: 0,
    kernelPathBuilds: 0,
    evictions: 0,
    retainedPayloadBytes: 0,
    liveLinearMemoryBytes: 0,
    residentNodes: 0,
    variantEntries: 0,
    kernelWork: {
      logicalCubics: '0',
      sizingVisits: '0',
      emissionVisits: '0',
      emittedCubicLines: '0',
      attemptedPaths: '0',
      failedPaths: '0',
    },
  };
}

window.runP2Benchmark = async ({ profile: profileName, repetition, expectedWasmSha256 }) => {
  const profile = P2_PROFILES[profileName];
  if (profile === undefined) throw new RangeError('profile must be functional or reference');
  if (!Number.isSafeInteger(repetition) || repetition < 1 || repetition > profile.repetitions)
    throw new RangeError('repetition is outside the frozen profile');
  if (!/^[0-9a-f]{64}$/iu.test(expectedWasmSha256))
    throw new RangeError('expectedWasmSha256 must be a 64-character hexadecimal digest');

  const errors: string[] = [];
  const visibilityStart = document.visibilityState;
  const visibilityEvents: P2VisibilityEvent[] = [];
  const onVisibilityChange = () => {
    visibilityEvents.push({ atMs: performance.now(), state: document.visibilityState });
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  const clockProbe = probeClock();
  const gpu = await gpuMetadata();
  let fetchMs = 0;
  let compileMs = 0;
  let wasmSha256 = '';
  let batch: VariantRuntime | null = null;
  let perPath: VariantRuntime | null = null;
  let preparationReserveMs = { batch: 0, 'per-path': 0 };
  let preparedInputCapacity = { batch: 0, 'per-path': 0 };
  let preparedOutputCapacity = { batch: 0, 'per-path': 0 };
  const samples: P2SamplePair[] = [];
  // Dispatch pending visibility events between pairs, outside either timed variant.
  const flushEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    const fetchStart = performance.now();
    const response = await fetch('/geometry.wasm', { cache: 'no-store' });
    if (!response.ok) throw new Error(`WASM fetch failed with HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    fetchMs = performance.now() - fetchStart;
    wasmSha256 = await sha256(bytes);
    if (wasmSha256 !== expectedWasmSha256.toLowerCase())
      throw new Error('WASM SHA-256 does not match expectedWasmSha256');
    const compileStart = performance.now();
    const module = await WebAssembly.compile(bytes);
    compileMs = performance.now() - compileStart;
    batch = await instantiateVariant('batch', module);
    perPath = await instantiateVariant('per-path', module);

    const preparation = samplePair('preparation', 0, p2PairOrder(0, repetition), batch, perPath);
    samples.push(preparation);
    errors.push(...preparation.errors.map((value) => `preparation: ${value}`));
    preparationReserveMs = {
      batch: batch.observer.reserveDurationMs(),
      'per-path': perPath.observer.reserveDurationMs(),
    };
    preparedInputCapacity = {
      batch: batch.observer.kernel.input_capacity(),
      'per-path': perPath.observer.kernel.input_capacity(),
    };
    preparedOutputCapacity = {
      batch: batch.observer.kernel.output_capacity(),
      'per-path': perPath.observer.kernel.output_capacity(),
    };
    await flushEvents();

    for (let index = 0; index < profile.warmupPairs; index += 1) {
      const pair = samplePair('warmup', index, p2PairOrder(index, repetition), batch, perPath);
      samples.push(pair);
      errors.push(...pair.errors.map((value) => `warmup ${index}: ${value}`));
      await flushEvents();
    }
    for (let index = 0; index < profile.measuredPairs; index += 1) {
      const pair = samplePair('measured', index, p2PairOrder(index, repetition), batch, perPath);
      samples.push(pair);
      errors.push(...pair.errors.map((value) => `measured ${index}: ${value}`));
      await flushEvents();
    }
  } catch (error) {
    errors.push(detail(error));
  } finally {
    try {
      batch?.session.dispose();
    } catch (error) {
      errors.push(`batch dispose: ${detail(error)}`);
    }
    try {
      perPath?.session.dispose();
    } catch (error) {
      errors.push(`per-path dispose: ${detail(error)}`);
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  const visibilityEnd = document.visibilityState;
  const orientation = screen.orientation?.type ?? null;
  const navigatorWithMemory = navigator as Navigator & { deviceMemory?: number };
  return {
    schema: 'p2-geometry-benchmark/v1',
    profile,
    repetition,
    wasmSha256,
    configuration: {
      scenario: P2_SCENARIO,
      seed: P2_WORKLOAD_SEED,
      paths: P2_WORKLOAD_PATHS,
      cubicsPerPath: P2_WORKLOAD_CUBICS_PER_PATH,
      inputPathCount: P2_WORKLOAD_PATHS,
      inputCubicCount: P2_WORKLOAD_CUBIC_COUNT,
      localTolerance: P2_LOCAL_TOLERANCE,
      world: P2_WORLD,
      zoom: P2_ZOOM,
      devicePixelRatio: P2_DEVICE_PIXEL_RATIO,
      cache: P2_CACHE,
    },
    setup: {
      fetchMs,
      compileMs,
      instantiationMs: {
        batch: batch?.instantiationMs ?? 0,
        'per-path': perPath?.instantiationMs ?? 0,
      },
      preparationReserveMs,
      preparedInputCapacity,
      preparedOutputCapacity,
      preparationChecksums: {
        batch: samples[0]?.batch.checksum ?? '',
        'per-path': samples[0]?.perPath.checksum ?? '',
      },
    },
    samples,
    environment: {
      visibilityStart,
      visibilityEnd,
      visibilityEvents,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      window: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        screenX: window.screenX,
        screenY: window.screenY,
      },
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
        orientation,
      },
      clockProbe,
      navigator: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        languages: [...navigator.languages],
        hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency)
          ? navigator.hardwareConcurrency
          : null,
        deviceMemoryGiB:
          typeof navigatorWithMemory.deviceMemory === 'number' &&
          Number.isFinite(navigatorWithMemory.deviceMemory)
            ? navigatorWithMemory.deviceMemory
            : null,
      },
      gpu,
    },
    cleanup: {
      batch: batch === null ? emptyCounters() : sessionCounters(batch.session.snapshotStatistics()),
      'per-path':
        perPath === null ? emptyCounters() : sessionCounters(perPath.session.snapshotStatistics()),
    },
    disposeStatuses: {
      batch: batch?.observer.snapshot().disposeStatuses ?? [],
      'per-path': perPath?.observer.snapshot().disposeStatuses ?? [],
    },
    errors,
  } satisfies P2Capture;
};
