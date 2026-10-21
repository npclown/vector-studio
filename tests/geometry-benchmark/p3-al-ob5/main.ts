/**
 * P3 Alt-A1 AL-OB5 unit OB5-U2, the browser leg of `p3-al-ob5-workload` v1
 * (`docs/plans/p3-al-ob5-workload-scenario-proposal.md` sections 3.2 and 3.3): the release WASM
 * through `createFillMeshPort` in a Vite production page, on the TypeScript-encoded framed
 * corpus, whose SHA-256 the page verifies, decoded into port requests outside timing. One
 * adapter per page (the spec opens a fresh page per repetition). Per set, in B0's shuffled set
 * order:
 *
 * 1. one untimed preparation call on the set's 1,000 requests (it provisions the arenas);
 * 2. OB5-SP-init: warm-up and timed calls, each window from before `buildFillMeshes` to after
 *    the fold of its result;
 * 3. OB5-SP-edit: three untimed one-path calls (paths 0-2), then every edit path timed once in
 *    the order shuffled by `0x0b5e0000 + r`, each window ending after its own fold;
 * 4. OB5-SP-cold: one call on a second adapter over a fresh instance, created and disposed
 *    outside timing; the window includes its reserve and arena growth;
 * 5. OB5-SR: `PathMeshPipeline.prepare` on the set's 1,000 path nodes with a cold cache, on the
 *    provisioned adapter of the SP stages, with the production limits and fringe builder.
 *
 * Integrity is read outside every window from the instance the factory created (OB5-V9): each
 * warm-up, timed and edit call must advance the fill memory epoch by exactly 1 and leave both
 * arena capacities and the linear memory size unchanged. The instance is observed by wrapping
 * `WebAssembly.instantiate` only while `createFillMeshPort` runs, as AL-S2's page does.
 */
import type { FillMeshRequest, RenderNodeSnapshot } from '@vector-studio/contracts';
import {
  createFillMeshPort,
  type FillMeshAdapter,
} from '../../../packages/geometry-wasm/src/index.js';
import { buildPathFringe } from '../../../packages/renderer-core/src/path-fringe.js';
import {
  PathMeshPipeline,
  type DerivedPath,
  type PathFringeBuilder,
  type PathMeshPrepareInput,
} from '../../../packages/renderer-core/src/path-mesh-pipeline.js';
import {
  batchStatuses,
  decodeOb5Sets,
  editOrder,
  EDIT_WARMUP_PATHS,
  Fnv1a64,
  pathFold,
  resultStatus,
  sceneVerbs,
  setOrder,
  type Ob5Capture,
  type Ob5Edits,
  type Ob5PageOptions,
  type Ob5Renderer,
  type Ob5Sample,
  type Ob5Set,
  type Ob5SetCapture,
  type StorageObservation,
} from './workload.js';

declare global {
  interface Window {
    runP3AlOb5Benchmark: (options: Ob5PageOptions) => Promise<Ob5Capture>;
  }
}

interface ObservedExports {
  readonly memory: WebAssembly.Memory;
  fill_v0_memory_epoch(): number;
  fill_v0_input_capacity(): number;
  fill_v0_output_capacity(): number;
}

interface ObservedPort {
  readonly port: FillMeshAdapter;
  readonly exports: ObservedExports;
}

function detail(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The P2.5 clock probe: the minimum positive `performance.now` increment. */
function probeClock(): Ob5Capture['clockProbe'] {
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
async function createObservedPort(module: WebAssembly.Module): Promise<ObservedPort> {
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

function stable(before: StorageObservation, after: StorageObservation): boolean {
  return (
    after.inputCapacity === before.inputCapacity &&
    after.outputCapacity === before.outputCapacity &&
    after.memoryBytes === before.memoryBytes
  );
}

const fold = new Fnv1a64();
const chainFold = new Fnv1a64();

/** One batch call and its fold inside the window; integrity read outside it. */
function sample(observed: ObservedPort, requests: readonly FillMeshRequest[]): Ob5Sample {
  const before = observe(observed.exports);
  const startMs = performance.now();
  const result = observed.port.buildFillMeshes(requests);
  fold.reset();
  const ok = fold.result(result);
  const endMs = performance.now();
  const checksum = fold.hex();
  const after = observe(observed.exports);
  return {
    startMs,
    endMs,
    checksum,
    epochDelta: after.epoch - before.epoch,
    storageStable: stable(before, after),
    batchFailures: ok ? 0 : 1,
  };
}

// Dispatches pending events between samples, outside every window.
const yieldToEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function measureEdits(
  observed: ObservedPort,
  singles: readonly (readonly FillMeshRequest[])[],
  order: readonly number[],
): Promise<Ob5Edits> {
  const startMs: number[] = [];
  const endMs: number[] = [];
  const checksums: string[] = [];
  const epochDeltas: number[] = [];
  const storageStable: boolean[] = [];
  const statuses: string[] = [];
  chainFold.reset();
  for (const [position, path] of order.entries()) {
    const request = singles[path]!;
    const before = observe(observed.exports);
    const start = performance.now();
    const result = observed.port.buildFillMeshes(request);
    fold.reset();
    fold.result(result);
    const end = performance.now();
    const after = observe(observed.exports);
    startMs.push(start);
    endMs.push(end);
    checksums.push(fold.hex());
    epochDeltas.push(after.epoch - before.epoch);
    storageStable.push(stable(before, after));
    statuses.push(batchStatuses(result)[0] ?? 'missing');
    chainFold.result(result);
    if (position % 100 === 99) await yieldToEvents();
  }
  return {
    order,
    startMs,
    endMs,
    checksums,
    epochDeltas,
    storageStable,
    statuses,
    chain: chainFold.hex(),
  };
}

/** The set's 1,000 path nodes for OB5-SR, built outside timing (identity world transform). */
function derivedPaths(set: Ob5Set): DerivedPath[] {
  return set.requests.map((request, index) => {
    const node: Extract<RenderNodeSnapshot, { kind: 'path' }> = {
      id: `${set.id}#${index}`,
      parentId: null,
      transform: [1, 0, 0, 1, 0, 0],
      visible: true,
      opacity: 1,
      kind: 'path',
      geometry: {
        kind: 'path',
        verbs: sceneVerbs(request.verbs),
        points: Array.from(request.points),
        fillRule: 'nonzero',
      },
      style: { fill: { r: 0, g: 0, b: 0, a: 1 }, stroke: null },
    };
    return { id: node.id, node, world: [1, 0, 0, 1, 0, 0], hidden: false };
  });
}

/** OB5-SR: one cold-cache prepare on a fresh pipeline over the provisioned adapter. */
function measureRenderer(
  observed: ObservedPort,
  paths: readonly DerivedPath[],
  options: Ob5PageOptions,
): Ob5Renderer {
  let builderCalls = 0;
  let builderMs = 0;
  // Wrapped only to count the production builder's calls and time; report-only.
  const fringeBuilder: PathFringeBuilder = (mesh, bucket) => {
    const start = performance.now();
    try {
      return buildPathFringe(mesh, bucket);
    } finally {
      builderCalls += 1;
      builderMs += performance.now() - start;
    }
  };
  const pipeline = new PathMeshPipeline({
    port: observed.port,
    fringeBuilder,
    memoryBytes: () => observed.port.linearMemoryBytes(),
  });
  const input: PathMeshPrepareInput = {
    paths,
    geometryRevision: () => 1,
    camera: options.renderer.camera,
    target: options.renderer.target,
    packing: { origin: { x: 0, y: 0 }, frameFinite: true },
  };
  const before = observe(observed.exports);
  const startMs = performance.now();
  const draws = pipeline.prepare(input);
  const endMs = performance.now();
  const after = observe(observed.exports);
  const notices: Record<string, number> = {};
  for (;;) {
    const batch = pipeline.takePacketNotices();
    if (batch.length === 0) break;
    for (const notice of batch)
      notices[notice.failureCode] = (notices[notice.failureCode] ?? 0) + 1;
  }
  const portCalls = pipeline.getStatistics().portCalls;
  pipeline.dispose();
  return {
    startMs,
    endMs,
    draws: draws.length,
    regionOnly: draws.filter((draw) => draw.fringe === null).length,
    fringed: draws.filter((draw) => draw.fringe !== null).length,
    toleranceExponents: [...new Set(draws.map((draw) => draw.toleranceExponent))].sort(
      (left, right) => left - right,
    ),
    builderCalls,
    builderMs,
    notices,
    portCalls,
    epochDelta: after.epoch - before.epoch,
    storageStable: stable(before, after),
  };
}

async function measureSet(
  observed: ObservedPort,
  module: WebAssembly.Module,
  set: Ob5Set,
  options: Ob5PageOptions,
): Promise<Ob5SetCapture> {
  const { requests } = set;
  const singles = requests.map((request) => [request]);
  const paths = derivedPaths(set);

  // 1. The untimed preparation call; the per-path record is read from its result.
  const preparationBefore = observe(observed.exports);
  const preparationStart = performance.now();
  const result = observed.port.buildFillMeshes(requests);
  fold.reset();
  const preparationOk = fold.result(result);
  const preparationEnd = performance.now();
  const preparationAfter = observe(observed.exports);
  const preparation: Ob5Sample = {
    startMs: preparationStart,
    endMs: preparationEnd,
    checksum: fold.hex(),
    epochDelta: preparationAfter.epoch - preparationBefore.epoch,
    storageStable: stable(preparationBefore, preparationAfter),
    batchFailures: preparationOk ? 0 : 1,
  };
  const items = result.status === 'ok' ? result.results : [];
  const statuses = result.status === 'ok' ? items.map(resultStatus) : batchStatuses(result);
  const vertices = items.map((item) => (item.status === 'ok' ? item.mesh.positions.length / 2 : 0));
  const triangles = items.map((item) => (item.status === 'ok' ? item.mesh.indices.length / 3 : 0));
  const boundaryPairs = items.map((item) =>
    item.status === 'ok' ? item.mesh.boundaryEdges.length / 2 : 0,
  );
  const pathChecksums = items.map(pathFold);
  await yieldToEvents();

  // 2. OB5-SP-init.
  const warmup: Ob5Sample[] = [];
  for (let index = 0; index < options.initWarmup; index += 1) {
    warmup.push(sample(observed, requests));
    await yieldToEvents();
  }
  const timed: Ob5Sample[] = [];
  for (let index = 0; index < options.initTimed; index += 1) {
    timed.push(sample(observed, requests));
    await yieldToEvents();
  }

  // 3. OB5-SP-edit.
  const editWarmup = {
    paths: [...EDIT_WARMUP_PATHS],
    checksums: EDIT_WARMUP_PATHS.map((path) => {
      fold.reset();
      fold.result(observed.port.buildFillMeshes(singles[path]!));
      return fold.hex();
    }),
  };
  await yieldToEvents();
  const edits = await measureEdits(
    observed,
    singles,
    editOrder(options.editPaths, options.repetition),
  );
  await yieldToEvents();

  // 4. OB5-SP-cold on a second adapter over a fresh instance, created and disposed outside.
  const second = await createObservedPort(module);
  let cold: Ob5Sample;
  try {
    cold = sample(second, requests);
  } finally {
    second.port.dispose();
  }
  await yieldToEvents();

  // 5. OB5-SR on the provisioned adapter, report-only.
  const renderer = measureRenderer(observed, paths, options);
  await yieldToEvents();

  return {
    set: set.id,
    paths: requests.length,
    preparation,
    statuses,
    vertices,
    triangles,
    boundaryPairs,
    pathChecksums,
    warmup,
    timed,
    editWarmup,
    edits,
    cold,
    renderer,
  };
}

window.runP3AlOb5Benchmark = async (options) => {
  const errors: string[] = [];
  const visibilityStart = document.visibilityState;
  const visibilityEvents: { atMs: number; state: string }[] = [];
  const onVisibility = () =>
    visibilityEvents.push({ atMs: performance.now(), state: document.visibilityState });
  document.addEventListener('visibilitychange', onVisibility);
  const clockProbe = probeClock();
  let wasmSha256 = '';
  let corpusSha256 = '';
  let adapter: Ob5Capture['adapter'] = null;
  let linearMemoryBytes: number | null = null;
  const setup = { fetchMs: 0, compileMs: 0, decodeMs: 0 };
  const sets: Ob5SetCapture[] = [];
  let order: string[] = [];
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
    const decoded = decodeOb5Sets(new Uint8Array(corpusBytes));
    setup.decodeMs = performance.now() - decodeStart;
    const byId = new Map(decoded.map((set) => [set.id, set]));
    const observed = await createObservedPort(module);
    port = observed.port;
    adapter = { operationId: port.operationId, portVersion: port.portVersion };
    order = setOrder(
      decoded.map((set) => set.id),
      options.repetition,
    );
    for (const id of order) sets.push(await measureSet(observed, module, byId.get(id)!, options));
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
    schema: 'p3-al-ob5-capture/v1',
    options,
    wasmSha256,
    corpusSha256,
    adapter,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    clockProbe,
    setup,
    order,
    sets,
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
  } satisfies Ob5Capture;
};
