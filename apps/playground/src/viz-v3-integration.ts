import type {
  RenderChangeSet,
  RendererCapabilityResult,
  RendererDiagnostic,
  RendererStatistics,
  SceneApplyResult,
  SceneSynchronizationState,
} from '@vector-studio/contracts';
import {
  createFillMeshPort,
  createStrokeMeshPort,
  type FillMeshAdapter,
  type StrokeMeshAdapter,
} from '@vector-studio/geometry-wasm';
import { PrimitiveRendererService } from '@vector-studio/renderer-core';
import { WebGpuBackend } from '@vector-studio/renderer-webgpu';
import {
  VIZ_V3_CAMERA,
  VIZ_V3_CHURN,
  VIZ_V3_EVIDENCE_LABEL,
  VIZ_V3_SURFACE,
  buildVizV3Script,
  churnStepId,
  type VizV3ChurnStep,
  type VizV3Step,
} from './viz-v3-integration-scene.js';

// Visualization track V-3 (docs/plans/viz-v3-a07-integration-contract.md): the A07 integration
// page. This page is a host: it injects the real fill-mesh port (`createFillMeshPort`) and the
// real stroke-mesh port (`createStrokeMeshPort`) from geometry-wasm into the renderer service, as
// the V-1 page does, and drives a scene of P1 primitives and P3 paths through the existing
// `replaceSnapshot` and `applyChanges` calls: the ordered states S0 to S5, a churn script, and
// device losses induced with the published `WebGpuBackend.destroyDeviceForTesting()`. It adds no
// draw work, no kernel work and no renderer code, and reads no packet: only the published
// statistics and diagnostics.
//
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target until
// B4 has A04 evidence, no Q4 coverage threshold and no performance claim is made. The scene state
// is plain JSON in the scene module; nothing is written to localStorage, IndexedDB or the URL.

/** Served by the playground's Vite config from the local kernel build; see vite.config.mjs. */
const WASM_URL = '/__vector-studio/geometry-kernel.wasm';
const MAX_LOG = 400;
const STABLE_FRAMES = 12;

const byId = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`)!;
const canvas = byId<HTMLCanvasElement>('viz-v3-surface');
const statusList = byId<HTMLElement>('viz-v3-status');
const lifecycleLive = byId<HTMLElement>('viz-v3-lifecycle');
const diagnosticList = byId<HTMLOListElement>('viz-v3-diagnostics');
const runOrderedButton = byId<HTMLButtonElement>('viz-v3-run-ordered');
const runChurnButton = byId<HTMLButtonElement>('viz-v3-run-churn');
const loseDeviceButton = byId<HTMLButtonElement>('viz-v3-lose-device');
const resetButton = byId<HTMLButtonElement>('viz-v3-reset');

byId('viz-v3-label').textContent = VIZ_V3_EVIDENCE_LABEL;

const script = buildVizV3Script();
const stepById = new Map(script.steps.map((step) => [step.id, step]));

// ---------------------------------------------------------------------------------------------
// Ports, service, backend, diagnostics
// ---------------------------------------------------------------------------------------------

/** Every diagnostic, uncapped: the page list shows the newest MAX_LOG, the hook keeps all. */
const diagnostics: RendererDiagnostic[] = [];
let fillPort: FillMeshAdapter | null = null;
let strokePort: StrokeMeshAdapter | null = null;
let wasmSha256: string | null = null;
let service: PrimitiveRendererService | null = null;
let revision = 0;
/** The last script step applied ('s0' after a snapshot), shown on the page. */
let position = 'loading';

type LossWatch = {
  generation: number;
  inWindow: readonly string[];
  record: LossRecord;
  resolve: (record: LossRecord) => void;
  reject: (error: Error) => void;
};
type InWindowApplication = {
  step: string;
  status: SceneApplyResult['status'];
  revision: number;
  /** Index in the hook's diagnostics list of the diagnostic after which the step was applied. */
  afterDiagnosticIndex: number;
  afterDiagnosticCode: string;
  lifecycle: string;
  sample: Sample;
};
type LossRecord = {
  lostGeneration: number;
  diagnosticIndexAtLoss: number;
  framesPresentedAtLoss: number;
  staleGenerationSubmissionsAtLoss: number;
  detectedIndex: number | null;
  detectedContext: unknown;
  succeededIndex: number | null;
  staleGenerationSubmissionsAtRecovery: number | null;
  applied: InWindowApplication[];
};
let lossWatch: LossWatch | null = null;

const backend = new WebGpuBackend();
backend.subscribeDiagnostics((event) => {
  diagnostics.push(event);
  const index = diagnostics.length - 1;
  const item = document.createElement('li');
  item.dataset.severity = event.severity;
  item.dataset.code = event.code;
  item.textContent =
    `#${event.sequence} g${event.generation} ${event.severity} ${event.code}: ${event.message}` +
    (event.context === undefined ? '' : ` ${JSON.stringify(event.context)}`);
  diagnosticList.prepend(item);
  while (diagnosticList.childElementCount > MAX_LOG) diagnosticList.lastElementChild!.remove();
  if (
    event.code === 'device-loss.detected' ||
    event.code === 'recovery.started' ||
    event.code === 'recovery.succeeded' ||
    event.code === 'recovery.failed'
  ) {
    announceLifecycle();
  }
  const watch = lossWatch;
  if (watch === null) return;
  if (event.code === 'device-loss.detected' && event.generation === watch.generation) {
    watch.record.detectedIndex = index;
    watch.record.detectedContext = event.context ?? null;
    // Section 3.5: the in-window change sets are applied here, synchronously, inside the loss
    // window that opens at `device-loss.detected` for the destroyed generation.
    for (const id of watch.inWindow) {
      const result = applyStep(id);
      watch.record.applied.push({
        step: id,
        status: result.status,
        revision,
        afterDiagnosticIndex: diagnostics.length - 1,
        afterDiagnosticCode: diagnostics.at(-1)!.code,
        lifecycle: backend.getStatistics().lifecycle,
        sample: takeSample(`${id} (in loss window)`, true),
      });
    }
    return;
  }
  if (event.code === 'recovery.succeeded' && event.generation === watch.generation + 1) {
    watch.record.succeededIndex = index;
    watch.record.staleGenerationSubmissionsAtRecovery =
      backend.getStatistics().staleGenerationSubmissions;
    lossWatch = null;
    watch.resolve(watch.record);
    return;
  }
  if (event.code === 'recovery.failed') {
    lossWatch = null;
    watch.reject(new Error(`recovery.failed: ${event.message}`));
  }
});

async function loadPorts(): Promise<void> {
  const response = await fetch(WASM_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      `The geometry kernel WASM is not available at ${WASM_URL} (HTTP ${response.status}). ` +
        'Build it with `pnpm test:geometry`, or set VECTOR_STUDIO_GEOMETRY_WASM for the dev server.',
    );
  }
  const bytes = await response.arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  wasmSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  // Two instances of the one kernel: each port owns its own linear memory.
  fillPort = await createFillMeshPort(bytes);
  strokePort = await createStrokeMeshPort(bytes);
}

async function start(): Promise<RendererCapabilityResult> {
  await loadPorts();
  const fill = fillPort!;
  const strokes = strokePort!;
  service = new PrimitiveRendererService(backend, {
    fillMesh: fill,
    fillMeshMemoryBytes: () => fill.linearMemoryBytes(),
    strokeMesh: strokes,
    strokeMeshMemoryBytes: () => strokes.linearMemoryBytes(),
  });
  backend.attachPrimitiveFrameSource(service);
  const result = service.replaceSnapshot(script.initial);
  if (result.status !== 'applied') throw new Error(`Scene rejected: ${JSON.stringify(result)}`);
  revision = script.initial.revision;
  position = 's0';
  const camera = service.setCamera(VIZ_V3_CAMERA);
  if (camera.status !== 'applied' && camera.status !== 'unchanged') {
    throw new Error(`Camera rejected: ${JSON.stringify(camera)}`);
  }
  const capability = await backend.initialize({
    canvas,
    cssSize: VIZ_V3_SURFACE,
    devicePixelRatio: window.devicePixelRatio,
  });
  renderStatus();
  updateButtons();
  return capability;
}

// ---------------------------------------------------------------------------------------------
// Scene steps and samples
// ---------------------------------------------------------------------------------------------

/** Applies a change set at the next revision of the current scene. */
function applyChangeSet(changes: RenderChangeSet): SceneApplyResult {
  if (service === null) throw new Error('The page is not ready.');
  const result = service.applyChanges({
    ...changes,
    revision: revision + 1,
    baseRevision: revision,
  });
  if (result.status === 'applied') revision += 1;
  return result;
}

/**
 * Applies a script step. Run in script order, the revisions equal the script's; the page's
 * buttons may skip steps, so each change set is applied at the next revision of the scene.
 */
function applyStep(id: string): SceneApplyResult {
  const step = stepById.get(id);
  if (step === undefined) throw new Error(`Unknown step ${id}.`);
  const result = applyChangeSet(step.changes);
  if (result.status === 'applied') position = id;
  return result;
}

type Sample = Readonly<{
  label: string;
  position: string;
  revision: number;
  inLossWindow: boolean;
  statistics: RendererStatistics;
  pathMesh: ReturnType<PrimitiveRendererService['getPathMeshStatistics']>;
  preparation: ReturnType<PrimitiveRendererService['getPreparationStatistics']> | null;
  synchronization: SceneSynchronizationState | null;
}>;
const samples: Sample[] = [];

function takeSample(label: string, inLossWindow = false): Sample {
  const sample: Sample = {
    label,
    position,
    revision,
    inLossWindow,
    statistics: backend.getStatistics(),
    pathMesh: service?.getPathMeshStatistics() ?? null,
    preparation: service?.getPreparationStatistics() ?? null,
    synchronization: service?.getSynchronizationState() ?? null,
  };
  samples.push(sample);
  return sample;
}

const nextAnimationFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** V-1's settle: 12 stable frames with no new submission, at most 1,200 frames. */
async function settle() {
  await ready;
  let stable = 0;
  let previous = -1;
  for (let attempt = 0; attempt < 1200 && stable < STABLE_FRAMES; attempt += 1) {
    await nextAnimationFrame();
    const frames = backend.getStatistics().framesSubmitted;
    stable = frames > 0 && frames === previous ? stable + 1 : 0;
    previous = frames;
  }
  renderStatus();
  return snapshot();
}

async function applyState(id: string) {
  const result = applyStep(id);
  const settled = await settle();
  return { result, revision, sample: takeSample(id), settled };
}

async function runCycle(c: number, step: VizV3ChurnStep) {
  return applyState(churnStepId(c, step));
}

/**
 * Induces a device loss from a settled page (section 3.5). The `inWindow` steps are applied from
 * the diagnostics listener when `device-loss.detected` arrives for the destroyed generation; the
 * promise resolves with the window record after `recovery.succeeded` for the next generation, or
 * rejects on `recovery.failed`.
 */
function loseDevice(inWindow: readonly string[] = []): Promise<LossRecord> {
  const statistics = backend.getStatistics();
  if (statistics.lifecycle !== 'ready') {
    return Promise.reject(new Error(`loseDevice needs a ready backend (${statistics.lifecycle}).`));
  }
  if (statistics.pendingFrameCallbacks !== 0) {
    return Promise.reject(new Error('loseDevice needs a settled page (pending frame callbacks).'));
  }
  if (lossWatch !== null) return Promise.reject(new Error('A loss is already pending.'));
  for (const id of inWindow) {
    if (!stepById.has(id)) return Promise.reject(new Error(`Unknown step ${id}.`));
  }
  const record: LossRecord = {
    lostGeneration: statistics.generation,
    diagnosticIndexAtLoss: diagnostics.length,
    framesPresentedAtLoss: statistics.framesPresented,
    staleGenerationSubmissionsAtLoss: statistics.staleGenerationSubmissions,
    detectedIndex: null,
    detectedContext: null,
    succeededIndex: null,
    staleGenerationSubmissionsAtRecovery: null,
    applied: [],
  };
  const promise = new Promise<LossRecord>((resolve, reject) => {
    lossWatch = { generation: statistics.generation, inWindow, record, resolve, reject };
  });
  backend.destroyDeviceForTesting();
  updateButtons();
  return promise;
}

function snapshot() {
  return {
    position,
    revision,
    statistics: backend.getStatistics(),
    pathMesh: service?.getPathMeshStatistics() ?? null,
    preparation: service?.getPreparationStatistics() ?? null,
    synchronization: service?.getSynchronizationState() ?? null,
    requiresMeshPipeline: service?.requiresMeshPipeline ?? null,
    diagnostics: diagnostics.slice(),
    notices: diagnostics.filter((event) => event.code === 'render.path-mesh-interim-failure'),
    diagnosticsOnPage: diagnosticList.childElementCount,
    ports:
      fillPort === null || strokePort === null
        ? null
        : {
            fill: { operationId: fillPort.operationId, portVersion: fillPort.portVersion },
            stroke: { operationId: strokePort.operationId, portVersion: strokePort.portVersion },
          },
    wasmSha256,
    devicePixelRatio: window.devicePixelRatio,
  };
}

// ---------------------------------------------------------------------------------------------
// Buttons and status
// ---------------------------------------------------------------------------------------------

let busy = false;
const ORDER_IDS = ['s1', 's2', 's3', 's4', 's5'];

function updateButtons(): void {
  const lifecycle = backend.getStatistics().lifecycle;
  const ready = lifecycle === 'ready' && service !== null;
  runOrderedButton.disabled = !ready || busy || position !== 's0';
  runChurnButton.disabled =
    !ready || busy || position === 'loading' || position.startsWith('churn');
  // VZ3-Q4 (a): enabled only while the backend is ready, as destroyDeviceForTesting requires.
  loseDeviceButton.disabled = !ready || busy || lossWatch !== null;
  resetButton.disabled = !ready || busy;
}

function busyWhile(body: () => Promise<unknown>): void {
  void runBusy(body);
}

async function runBusy(body: () => Promise<unknown>): Promise<void> {
  busy = true;
  updateButtons();
  try {
    await body();
  } catch (error) {
    const item = document.createElement('li');
    item.dataset.severity = 'error';
    item.textContent = error instanceof Error ? error.message : String(error);
    diagnosticList.prepend(item);
  } finally {
    busy = false;
    updateButtons();
    renderStatus();
  }
}

runOrderedButton.addEventListener('click', () =>
  busyWhile(async () => {
    for (const id of ORDER_IDS) await applyState(id);
  }),
);
runChurnButton.addEventListener('click', () =>
  busyWhile(async () => {
    for (let c = 1; c <= VIZ_V3_CHURN.cycles; c += 1) {
      for (const step of ['add', 'replace', 'remove'] as const) await runCycle(c, step);
    }
  }),
);
loseDeviceButton.addEventListener('click', () =>
  busyWhile(async () => {
    await settle();
    await loseDevice();
    await settle();
  }),
);
resetButton.addEventListener('click', () =>
  busyWhile(async () => {
    if (service === null) return;
    const result = service.replaceSnapshot({ ...script.initial, revision: revision + 1 });
    if (result.status === 'applied') {
      revision += 1;
      position = 's0';
    }
    await settle();
  }),
);

let lastLifecycle = '';
function announceLifecycle(): void {
  // The live region announces lifecycle changes only (section 3.6).
  const statistics = backend.getStatistics();
  const text = `Lifecycle ${statistics.lifecycle}, generation ${statistics.generation}`;
  if (text === lastLifecycle) return;
  lastLifecycle = text;
  lifecycleLive.textContent = text;
}

function renderStatus(): void {
  const statistics = backend.getStatistics();
  const pathMesh = service?.getPathMeshStatistics() ?? null;
  const resources = statistics.resources;
  const rows: Array<readonly [string, string]> = [
    ['lifecycle', statistics.lifecycle],
    ['generation', String(statistics.generation)],
    ['recovery attempts', String(statistics.recoveryAttempts)],
    [
      'ports',
      fillPort === null || strokePort === null
        ? 'loading'
        : `${fillPort.operationId} v${fillPort.portVersion}; ${strokePort.operationId} v${strokePort.portVersion}`,
    ],
    ['kernel SHA-256', wasmSha256 === null ? '-' : `${wasmSha256.slice(0, 16)}...`],
    ['state or cycle', position],
    ['scene revision', String(revision)],
    ['live resources', String(resources.live)],
    ['live bytes', String(resources.liveBytes)],
    ['peak live bytes', String(resources.peakLiveBytes)],
    ['pipelines created', String(statistics.pipelinesCreated)],
    ['shader modules created', String(statistics.shaderModulesCreated)],
    ['frames submitted', String(statistics.framesSubmitted)],
    ['frames presented', String(statistics.framesPresented)],
    ['mesh cache', `${pathMesh?.entries ?? 0} entries, ${pathMesh?.bytes ?? 0} B`],
    ['memo entries', String(pathMesh?.memoEntries ?? 0)],
    ['fill port calls', String(pathMesh?.portCalls ?? 0)],
    ['stroke port calls', String(pathMesh?.strokePortCalls ?? 0)],
    ['notices queued', String(pathMesh?.noticesQueued ?? 0)],
    ['notices dropped', String(pathMesh?.noticesDropped ?? 0)],
  ];
  statusList.replaceChildren(
    ...rows.flatMap(([name, value]) => {
      const term = document.createElement('dt');
      term.textContent = name;
      const detail = document.createElement('dd');
      detail.textContent = value;
      return [term, detail];
    }),
  );
  announceLifecycle();
}

window.setInterval(() => {
  renderStatus();
  updateButtons();
}, 500);

const ready = start();
// A missing or mismatched kernel is reported on the page, for example after a static build.
ready.catch((error: unknown) => {
  const item = document.createElement('li');
  item.dataset.severity = 'error';
  item.textContent = error instanceof Error ? error.message : String(error);
  diagnosticList.prepend(item);
});

const api = {
  ready,
  settle,
  applyState,
  runCycle,
  /** Applies an arbitrary change set at the next revision (section 3.6). */
  applyEdit(changes: RenderChangeSet) {
    return applyChangeSet(changes);
  },
  loseDevice,
  /** Requests one frame with no scene change (VZ3-A6). */
  invalidate() {
    backend.invalidate({ reason: 'scene' });
  },
  /** Records a sample now, for example the end-of-cycle sample after a recovery. */
  recordSample(label: string) {
    return takeSample(label);
  },
  samples() {
    return samples.slice();
  },
  /** The script's scene after a step, as plain data, for the spec's oracle. */
  sceneAfter(id: string): VizV3Step['scene'] | null {
    return id === 's0' ? script.initial : (stepById.get(id)?.scene ?? null);
  },
  snapshot,
  dispose() {
    service?.dispose();
    backend.dispose();
    fillPort?.dispose();
    strokePort?.dispose();
    updateButtons();
    return { statistics: backend.getStatistics(), diagnostics: diagnostics.slice() };
  },
};

Object.assign(window, { __vectorStudioVizV3Integration: api });
export type VizV3IntegrationApi = typeof api;
