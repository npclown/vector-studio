/**
 * P3 Alt-A1 AL-U6, the AL-S2 browser leg (`docs/plans/p3-alt-a1-fill-ladder-contract.md`
 * section 5.2): the release WASM through `createFillMeshPort` in a Vite production page, on
 * the B0 framed corpus decoded into port requests outside timing. One adapter per page (the
 * spec opens a fresh page per repetition). Per cell: one untimed preparation sample that
 * provisions the adapter's arenas, then warm-up and timed samples of R consecutive
 * `buildFillMeshes` calls, each followed by the decoded checksum fold; the window runs from
 * before the first call to after the last call's fold.
 *
 * Integrity is read outside the window from the instance the factory created: each timed
 * sample must advance the fill memory epoch by exactly R (one `process` per call, so no
 * reserve and no OUTPUT_CAPACITY retry) and leave both arena capacities and the linear memory
 * size unchanged. The instance is observed by wrapping `WebAssembly.instantiate` only while
 * `createFillMeshPort` runs; the adapter itself is the package's, unchanged.
 */
import {
  createFillMeshPort,
  type FillMeshAdapter,
} from '../../../packages/geometry-wasm/src/index.js';
import {
  decodeDecisionCells,
  Fnv1a64,
  orderSeed,
  shuffled,
  type StorageObservation,
  type WasmCapture,
  type WasmCell,
  type WasmCellCapture,
  type WasmPageOptions,
  type WasmSample,
} from './workload.js';

declare global {
  interface Window {
    runP3B0WasmBenchmark: (options: WasmPageOptions) => Promise<WasmCapture>;
  }
}

interface ObservedExports {
  readonly memory: WebAssembly.Memory;
  fill_v0_memory_epoch(): number;
  fill_v0_input_capacity(): number;
  fill_v0_output_capacity(): number;
}

function detail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The P2.5 clock probe: the minimum positive `performance.now` increment. */
function probeClock(): WasmCapture['clockProbe'] {
  const positiveIncrementsMs: number[] = [];
  const start = performance.now();
  let previous = start;
  let attempts = 0;
  while (positiveIncrementsMs.length < 32 && attempts < 100_000 && previous - start < 250) {
    const current = performance.now();
    const increment = current - previous;
    if (Number.isFinite(increment) && increment > 0) positiveIncrementsMs.push(increment);
    previous = current;
    attempts += 1;
  }
  return {
    attempts,
    durationMs: performance.now() - start,
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

/** `createFillMeshPort(module)`, keeping a read-only handle on the instance it creates. */
async function createObservedPort(
  module: WebAssembly.Module,
): Promise<{ port: FillMeshAdapter; exports: ObservedExports }> {
  const original = WebAssembly.instantiate;
  let instance: WebAssembly.Instance | null = null;
  const observed = async (...args: unknown[]): Promise<unknown> => {
    const result: unknown = await (original as (...input: unknown[]) => Promise<unknown>).apply(
      WebAssembly,
      args,
    );
    instance =
      result instanceof WebAssembly.Instance
        ? result
        : (result as WebAssembly.WebAssemblyInstantiatedSource).instance;
    return result;
  };
  WebAssembly.instantiate = observed as typeof WebAssembly.instantiate;
  let port: FillMeshAdapter;
  try {
    port = await createFillMeshPort(module);
  } finally {
    WebAssembly.instantiate = original;
  }
  if (instance === null) throw new Error('the factory instance was not observed');
  return {
    port,
    exports: (instance as WebAssembly.Instance).exports as unknown as ObservedExports,
  };
}

function observe(exports: ObservedExports): StorageObservation {
  return {
    epoch: exports.fill_v0_memory_epoch(),
    inputCapacity: exports.fill_v0_input_capacity(),
    outputCapacity: exports.fill_v0_output_capacity(),
    memoryBytes: exports.memory.buffer.byteLength,
  };
}

const fold = new Fnv1a64();

function sample(
  port: FillMeshAdapter,
  exports: ObservedExports,
  requests: WasmCell['requests'],
  calls: number,
): WasmSample {
  const before = observe(exports);
  let batchFailures = 0;
  const start = performance.now();
  fold.reset();
  for (let call = 0; call < calls; call += 1) {
    if (!fold.result(port.buildFillMeshes(requests))) batchFailures += 1;
  }
  const end = performance.now();
  const checksum = fold.hex();
  const after = observe(exports);
  return {
    ms: end - start,
    checksum,
    epochDelta: after.epoch - before.epoch,
    storageStable:
      after.inputCapacity === before.inputCapacity &&
      after.outputCapacity === before.outputCapacity &&
      after.memoryBytes === before.memoryBytes,
    batchFailures,
  };
}

function statuses(port: FillMeshAdapter, requests: WasmCell['requests']): string[] {
  const result = port.buildFillMeshes(requests);
  if (result.status !== 'ok') return [`batch-failed:${result.code}`];
  return result.results.map((item) => (item.status === 'failed' ? item.code : item.status));
}

// Dispatches pending events between samples, outside every window.
const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function measureCell(
  port: FillMeshAdapter,
  exports: ObservedExports,
  cell: string,
  requests: WasmCell['requests'],
  calls: number,
  options: WasmPageOptions,
): Promise<WasmCellCapture> {
  const preparation = sample(port, exports, requests, calls);
  const cellStatuses = statuses(port, requests);
  await yieldToEvents();
  const warmup: WasmSample[] = [];
  for (let index = 0; index < options.warmup; index += 1) {
    warmup.push(sample(port, exports, requests, calls));
    await yieldToEvents();
  }
  const timed: WasmSample[] = [];
  for (let index = 0; index < options.timed; index += 1) {
    timed.push(sample(port, exports, requests, calls));
    await yieldToEvents();
  }
  return {
    cell,
    calls,
    paths: requests.length,
    preparation,
    statuses: cellStatuses,
    warmup,
    timed,
  };
}

window.runP3B0WasmBenchmark = async (options) => {
  const errors: string[] = [];
  const visibilityStart = document.visibilityState;
  const visibilityEvents: { atMs: number; state: string }[] = [];
  const onVisibility = () =>
    visibilityEvents.push({ atMs: performance.now(), state: document.visibilityState });
  document.addEventListener('visibilitychange', onVisibility);
  const clockProbe = probeClock();
  let wasmSha256 = '';
  let corpusSha256 = '';
  let adapter: WasmCapture['adapter'] = null;
  let linearMemoryBytes: number | null = null;
  const setup = { fetchMs: 0, compileMs: 0, decodeMs: 0 };
  const cells: WasmCellCapture[] = [];
  const onePath: WasmCellCapture[] = [];
  let order: string[] = [];
  let onePathOrder: string[] = [];
  let port: FillMeshAdapter | null = null;
  try {
    const fetchStart = performance.now();
    const [wasmResponse, corpusResponse] = await Promise.all([
      fetch('./geometry.wasm', { cache: 'no-store' }),
      fetch('./corpus.bin', { cache: 'no-store' }),
    ]);
    if (!wasmResponse.ok || !corpusResponse.ok) throw new Error('asset fetch failed');
    const wasmBytes = await wasmResponse.arrayBuffer();
    const corpusBytes = await corpusResponse.arrayBuffer();
    setup.fetchMs = performance.now() - fetchStart;
    wasmSha256 = await sha256(wasmBytes);
    corpusSha256 = await sha256(corpusBytes);
    if (wasmSha256 !== options.expectedWasmSha256) throw new Error('WASM SHA-256 mismatch');
    if (corpusSha256 !== options.expectedCorpusSha256) throw new Error('corpus SHA-256 mismatch');
    const compileStart = performance.now();
    const module = await WebAssembly.compile(wasmBytes);
    setup.compileMs = performance.now() - compileStart;
    const decodeStart = performance.now();
    const decision = decodeDecisionCells(new Uint8Array(corpusBytes));
    setup.decodeMs = performance.now() - decodeStart;
    const byId = new Map(decision.map((cell) => [cell.id, cell]));
    const observed = await createObservedPort(module);
    port = observed.port;
    adapter = { operationId: port.operationId, portVersion: port.portVersion };
    const seed = orderSeed(options.repetition);
    order = shuffled(
      decision.map((cell) => cell.id),
      seed,
    );
    onePathOrder = shuffled(options.onePathCells, seed);
    for (const id of order) {
      cells.push(
        await measureCell(
          port,
          observed.exports,
          id,
          byId.get(id)!.requests,
          options.calls,
          options,
        ),
      );
    }
    for (const id of onePathOrder) {
      const cell = byId.get(id);
      if (cell === undefined) throw new Error(`unknown one-path cell ${id}`);
      onePath.push(
        await measureCell(
          port,
          observed.exports,
          id,
          cell.requests.slice(0, 1),
          options.onePathCalls,
          options,
        ),
      );
    }
    linearMemoryBytes = port.linearMemoryBytes();
  } catch (error) {
    errors.push(detail(error));
  } finally {
    try {
      port?.dispose();
    } catch (error) {
      errors.push(`dispose: ${detail(error)}`);
    }
    document.removeEventListener('visibilitychange', onVisibility);
  }
  const visibilityEnd = document.visibilityState;
  if (visibilityStart !== 'visible' || visibilityEnd !== 'visible' || visibilityEvents.length > 0)
    errors.push('the page was not visible for the whole repetition');
  return {
    schema: 'p3-b0-wasm-capture/v1',
    options,
    wasmSha256,
    corpusSha256,
    adapter,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    clockProbe,
    setup,
    order,
    onePathOrder,
    cells,
    onePath,
    linearMemoryBytes,
    environment: {
      visibilityStart,
      visibilityEnd,
      visibilityEvents,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      screen: { width: screen.width, height: screen.height },
      navigator: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency)
          ? navigator.hardwareConcurrency
          : null,
      },
    },
    errors,
  } satisfies WasmCapture;
};
