import type { RendererCapabilityResult, RendererDiagnostic } from '@vector-studio/contracts';
import { WebGpuBackend, type WebGpuSurface } from '@vector-studio/renderer-webgpu';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Playground root element is missing.');

const REFERENCE_SURFACE = Object.freeze({
  cssSize: Object.freeze({ width: 640, height: 360 }),
  devicePixelRatio: 1,
});
const MAX_RECENT_DIAGNOSTICS = 50;

interface InitializationTiming {
  readonly timeOrigin: number;
  readonly initializationStartedAtMs: number;
  readonly readyAtMs: number;
  readonly navigationToReadyMs: number;
  readonly initializationToReadyMs: number;
  readonly firstSubmissionAtMs?: number;
  readonly firstSubmissionMs?: number;
  readonly gpuCompletionAtMs?: number;
  readonly gpuCompletionMs?: number;
}

app.innerHTML = `
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #080d17; color: #e8edf7; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 960px; }
    #app { display: grid; grid-template-columns: minmax(680px, 1fr) 360px; gap: 20px; min-height: 100vh; padding: 20px; }
    .stage, .panel { border: 1px solid #263249; border-radius: 12px; background: #0d1422; box-shadow: 0 18px 50px #0007; }
    .stage { display: grid; align-content: start; justify-content: center; padding: 24px; overflow: auto; }
    .stage h1 { width: 640px; margin: 0 0 16px; font-size: 20px; font-weight: 650; }
    #webgpu-surface { display: block; width: 640px; height: 360px; border: 1px solid #34435e; border-radius: 8px; }
    .panel { padding: 16px; overflow: auto; }
    .panel h2 { margin: 0 0 12px; font-size: 15px; }
    .status-grid { display: grid; grid-template-columns: 120px 1fr; gap: 7px 10px; margin: 0 0 18px; font-size: 12px; }
    .status-grid dt { color: #8fa0ba; }
    .status-grid dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 18px; }
    button { min-height: 34px; border: 1px solid #394a67; border-radius: 7px; background: #17233a; color: inherit; cursor: pointer; }
    button:hover { background: #213151; }
    button:disabled { cursor: wait; opacity: .55; }
    #diagnostics-list { max-height: 240px; margin: 0; padding-left: 20px; font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; color: #b8c5d9; }
    #diagnostics-list li[data-severity="error"] { color: #ff9da5; }
    #diagnostics-list li[data-severity="warning"] { color: #ffd27d; }
  </style>
  <section class="stage">
    <h1>Vector Studio · WebGPU Foundation</h1>
    <canvas id="webgpu-surface" width="640" height="360"></canvas>
  </section>
  <aside class="panel" aria-label="WebGPU foundation controls">
    <h2>Backend</h2>
    <dl class="status-grid">
      <dt>Instance</dt><dd id="backend-instance">-</dd>
      <dt>State</dt><dd id="backend-state">-</dd>
      <dt>Generation</dt><dd id="backend-generation">-</dd>
      <dt>Adapter</dt><dd id="adapter-identity">-</dd>
      <dt>Surface</dt><dd id="surface-size">-</dd>
      <dt>Sample count</dt><dd id="sample-count">-</dd>
      <dt>Frames</dt><dd id="frame-counters">-</dd>
      <dt>Resources</dt><dd id="resource-counters">-</dd>
      <dt>Listeners</dt><dd id="listener-counters">-</dd>
      <dt>Timing</dt><dd id="timing-summary">inactive</dd>
    </dl>
    <h2>Controls</h2>
    <div class="controls">
      <button id="invalidate-once" type="button">Invalidate</button>
      <button id="invalidate-burst" type="button">Invalidate ×100</button>
      <button id="continuous-toggle" type="button">Start continuous</button>
      <button id="resize-storm" type="button">Resize storm</button>
      <button id="measurement-toggle" type="button">Start measurement</button>
      <button id="measurement-reset" type="button">Reset measurement</button>
      <button id="validation-error" type="button">Validation error</button>
      <button id="device-loss" type="button">Device loss</button>
      <button id="dispose-backend" type="button">Dispose</button>
      <button id="reinitialize-backend" type="button">Reinitialize</button>
      <button id="refresh-dashboard" type="button">Refresh</button>
    </div>
    <h2>Recent diagnostics</h2>
    <ol id="diagnostics-list"></ol>
  </aside>
`;

const canvasElement = document.querySelector<HTMLCanvasElement>('#webgpu-surface');
if (!canvasElement) throw new Error('Playground canvas is missing.');
const canvas: HTMLCanvasElement = canvasElement;

function element(id: string): HTMLElement {
  const value = document.querySelector<HTMLElement>(`#${id}`);
  if (!value) throw new Error(`Playground element #${id} is missing.`);
  return value;
}

function button(id: string): HTMLButtonElement {
  const value = document.querySelector<HTMLButtonElement>(`#${id}`);
  if (!value) throw new Error(`Playground button #${id} is missing.`);
  return value;
}

let backend: WebGpuBackend;
let capability: RendererCapabilityResult | undefined;
let diagnostics: RendererDiagnostic[] = [];
let backendInstance = 0;
let replacement: Promise<RendererCapabilityResult> | undefined;
let initializationTiming: InitializationTiming | undefined;
let initializationMilestones: Promise<void> = Promise.resolve();

function currentSurface(): WebGpuSurface {
  return {
    canvas,
    cssSize: REFERENCE_SURFACE.cssSize,
    devicePixelRatio: REFERENCE_SURFACE.devicePixelRatio,
  };
}

function percentile(values: readonly number[], percentileValue: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)];
}

function formatTiming(): string {
  const measurements = backend.getFrameMeasurements();
  const frameP95 = percentile(measurements.frameIntervalsMs, 0.95);
  const cpuP95 = percentile(measurements.encodeAndSubmitMs, 0.95);
  return [
    measurements.active ? 'active' : 'stopped',
    `frame n=${measurements.frameIntervalsMs.length} p95=${frameP95?.toFixed(2) ?? 'n/a'}ms`,
    `cpu n=${measurements.encodeAndSubmitMs.length} p95=${cpuP95?.toFixed(2) ?? 'n/a'}ms`,
    `dropped=${measurements.droppedSamples.frameIntervalsMs}/${measurements.droppedSamples.encodeAndSubmitMs}`,
  ].join(' · ');
}

function renderDashboard(): void {
  const statistics = backend.getStatistics();
  const currentCapability = backend.capabilityResult ?? capability;
  const adapter = currentCapability?.supported ? currentCapability.capabilities.adapter : undefined;
  const surface = backend.surfaceSize;
  element('backend-instance').textContent = String(backendInstance);
  element('backend-state').textContent = backend.state;
  element('backend-generation').textContent = String(backend.generation);
  element('adapter-identity').textContent =
    [adapter?.vendor, adapter?.architecture, adapter?.description].filter(Boolean).join(' / ') ||
    'unavailable';
  element('surface-size').textContent = surface
    ? `${surface.physical.width}×${surface.physical.height} @ DPR ${surface.devicePixelRatio}`
    : 'unavailable';
  element('sample-count').textContent = currentCapability?.supported
    ? String(currentCapability.capabilities.sampleCount)
    : 'unavailable';
  element('frame-counters').textContent =
    `${statistics.framesSubmitted} submitted / ${statistics.framesPresented} submission-path presented`;
  element('resource-counters').textContent =
    `${statistics.resources.live} live / ${statistics.resources.liveBytes} bytes`;
  element('listener-counters').textContent =
    `${statistics.diagnosticListeners} diagnostic / ${statistics.deviceListeners} device`;
  element('timing-summary').textContent = formatTiming();
  button('continuous-toggle').textContent =
    statistics.mode === 'continuous' ? 'Stop continuous' : 'Start continuous';
  button('measurement-toggle').textContent = backend.getFrameMeasurements().active
    ? 'Stop measurement'
    : 'Start measurement';

  const list = element('diagnostics-list');
  list.replaceChildren(
    ...diagnostics.slice(-MAX_RECENT_DIAGNOSTICS).map((diagnostic) => {
      const item = document.createElement('li');
      item.dataset.severity = diagnostic.severity;
      item.textContent = `g${diagnostic.generation} · ${diagnostic.code}`;
      return item;
    }),
  );
}

async function createBackend(): Promise<RendererCapabilityResult> {
  backendInstance += 1;
  diagnostics = [];
  const candidate = new WebGpuBackend({
    clock: () => performance.now(),
    now: () => performance.now(),
  });
  backend = candidate;
  const initializationStartedAtMs = performance.now();
  candidate.subscribeDiagnostics((diagnostic) => {
    if (backend !== candidate) return;
    diagnostics.push(diagnostic);
    if (diagnostics.length > MAX_RECENT_DIAGNOSTICS) diagnostics.shift();
    capability = candidate.capabilityResult ?? capability;
    renderDashboard();
  });
  capability = await candidate.initialize(currentSurface());
  const readyAtMs = performance.now();
  const timing = Object.freeze({
    timeOrigin: performance.timeOrigin,
    initializationStartedAtMs,
    readyAtMs,
    navigationToReadyMs: readyAtMs,
    initializationToReadyMs: readyAtMs - initializationStartedAtMs,
  });
  initializationTiming = timing;
  initializationMilestones = observeInitializationMilestones(candidate, timing);
  void initializationMilestones.catch(() => undefined);
  renderDashboard();
  return capability;
}

async function observeInitializationMilestones(
  candidate: WebGpuBackend,
  timing: InitializationTiming,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deadline = performance.now() + 5000;
    const observe = () => {
      if (candidate.getStatistics().framesSubmitted > 0) {
        resolve();
      } else if (backend !== candidate || candidate.state === 'disposed') {
        reject(new Error('Backend changed before its first submission.'));
      } else if (performance.now() >= deadline) {
        reject(new Error('Timed out waiting for the first submission.'));
      } else {
        requestAnimationFrame(observe);
      }
    };
    observe();
  });
  const firstSubmissionAtMs = performance.now();
  if (backend !== candidate) throw new Error('Backend changed before GPU completion observation.');
  await candidate.waitForSubmittedWork();
  const gpuCompletionAtMs = performance.now();
  if (backend !== candidate) return;
  initializationTiming = Object.freeze({
    ...timing,
    firstSubmissionAtMs,
    firstSubmissionMs: firstSubmissionAtMs - timing.initializationStartedAtMs,
    gpuCompletionAtMs,
    gpuCompletionMs: gpuCompletionAtMs - timing.initializationStartedAtMs,
  });
}

function reinitialize(): Promise<RendererCapabilityResult> {
  if (replacement) return replacement;
  backend.dispose();
  const attempt = createBackend();
  replacement = attempt;
  void attempt.finally(() => {
    if (replacement === attempt) replacement = undefined;
  });
  return attempt;
}

function resize(width: number, height: number, devicePixelRatio: number): unknown {
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const result = backend.resize({ width, height }, devicePixelRatio);
  renderDashboard();
  return result;
}

async function resizeStorm(): Promise<void> {
  const control = button('resize-storm');
  control.disabled = true;
  try {
    for (let index = 0; index < 120; index += 1) {
      const width = 480 + ((index * 37) % 320);
      const height = 270 + ((index * 23) % 180);
      resize(width, height, [1, 1.5, 2][index % 3] ?? 1);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    resize(
      REFERENCE_SURFACE.cssSize.width,
      REFERENCE_SURFACE.cssSize.height,
      REFERENCE_SURFACE.devicePixelRatio,
    );
  } finally {
    control.disabled = false;
    renderDashboard();
  }
}

await createBackend();

button('invalidate-once').addEventListener('click', () => {
  backend.invalidate({ reason: 'scene' });
  renderDashboard();
});
button('invalidate-burst').addEventListener('click', () => {
  for (let index = 0; index < 100; index += 1) backend.invalidate({ reason: 'scene' });
  renderDashboard();
});
button('continuous-toggle').addEventListener('click', () => {
  backend.setMode(backend.getStatistics().mode === 'continuous' ? 'on-demand' : 'continuous');
  renderDashboard();
});
button('resize-storm').addEventListener('click', () => void resizeStorm());
button('measurement-toggle').addEventListener('click', () => {
  if (backend.getFrameMeasurements().active) backend.stopFrameMeasurements();
  else backend.startFrameMeasurements();
  renderDashboard();
});
button('measurement-reset').addEventListener('click', () => {
  backend.resetFrameMeasurements();
  renderDashboard();
});
button('validation-error').addEventListener('click', () =>
  backend.triggerValidationErrorForTesting(),
);
button('device-loss').addEventListener('click', () => backend.destroyDeviceForTesting());
button('dispose-backend').addEventListener('click', () => {
  backend.dispose();
  renderDashboard();
});
button('reinitialize-backend').addEventListener('click', () => void reinitialize());
button('refresh-dashboard').addEventListener('click', renderDashboard);

const api = Object.freeze({
  snapshot: () => ({
    capability: backend.capabilityResult ?? capability,
    diagnostics: Object.freeze([...diagnostics]),
    backendInstance,
    presentationFormat: backend.presentationFormat,
    state: backend.state,
    surfaceRevision: backend.surfaceRevision,
    surfaceSize: backend.surfaceSize,
    statistics: backend.getStatistics(),
  }),
  dispose: () => {
    backend.dispose();
    renderDashboard();
  },
  destroyDeviceForTesting: () => backend.destroyDeviceForTesting(),
  getFrameMeasurements: () => backend.getFrameMeasurements(),
  getInitializationTiming: () => initializationTiming,
  invalidate: () => backend.invalidate({ reason: 'scene' }),
  reinitialize,
  resetFrameMeasurements: () => backend.resetFrameMeasurements(),
  resize,
  resizeStorm,
  startFrameMeasurements: (capacity?: number) => backend.startFrameMeasurements(capacity),
  stopFrameMeasurements: () => backend.stopFrameMeasurements(),
  setMode: (mode: 'on-demand' | 'continuous') => backend.setMode(mode),
  triggerValidationErrorForTesting: () => backend.triggerValidationErrorForTesting(),
  waitForInitializationMilestones: () => initializationMilestones,
  waitForSubmittedWork: () => backend.waitForSubmittedWork(),
});

Object.assign(globalThis, { __vectorStudioP0: api });
globalThis.dispatchEvent(new Event('vector-studio-ready'));
