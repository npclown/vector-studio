import type { RendererCapabilityResult, RendererDiagnostic } from '@vector-studio/contracts';
import {
  createFillMeshPort,
  createStrokeMeshPort,
  type FillMeshAdapter,
  type StrokeMeshAdapter,
} from '@vector-studio/geometry-wasm';
import {
  PrimitiveRendererService,
  type PrimitiveFrameSource,
  type PrimitivePacket,
  type PrimitiveReceipt,
  type PrimitiveTarget,
} from '@vector-studio/renderer-core';
import { WebGpuBackend } from '@vector-studio/renderer-webgpu';
import {
  AppearanceEditor,
  CONTROL_KINDS,
  TargetStatusTracker,
  appliesOn,
  initialStates,
  interpretControl,
  parseNotice,
  toHex,
  type ControlEvent,
  type ControlId,
  type ParsedNotice,
} from './viz-v1-appearance-state.js';
import {
  DEFAULT_TARGET_ID,
  VIZ_V1_EVIDENCE_LABEL,
  VIZ_V1_SURFACE,
  VIZ_V1_TARGETS,
  VIZ_V1_VIEWS,
  targetById,
  viewCamera,
  type VizView,
} from './viz-v1-appearance-scene.js';

// Visualization track V-1 (docs/plans/viz-v1-path-appearance-contract.md): the path appearance
// page. This page is a host: it injects the real fill-mesh port (`createFillMeshPort`) and the
// real stroke-mesh port (`createStrokeMeshPort`) from geometry-wasm into the renderer service,
// exactly as the ST-U8 stroke page does, and edits one target path at a time through the
// existing `applyChanges` and `replaceSnapshot` calls. It adds no draw work, no kernel work and
// no renderer code. D8-interim notices are listed, never hidden or cleared.
//
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target until
// B4 has A04 evidence, and no Q4 coverage threshold is claimed. No appearance state is written to
// localStorage, IndexedDB or the URL; only `?target=` and `?view=` are read.

/** Served by the playground's Vite config from the local kernel build; see vite.config.mjs. */
const WASM_URL = '/__vector-studio/geometry-kernel.wasm';
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 64;
const MAX_LOG = 400;
const STABLE_FRAMES = 12;

const byId = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`)!;
const canvas = byId<HTMLCanvasElement>('viz-v1-surface');
const statusList = byId<HTMLElement>('viz-v1-status');
const noticeList = byId<HTMLOListElement>('viz-v1-notices');
const noticeDropped = byId<HTMLElement>('viz-v1-notices-dropped');
const diagnosticList = byId<HTMLOListElement>('viz-v1-diagnostics');
const errorList = byId<HTMLOListElement>('viz-v1-errors');
const targetStatusEl = byId<HTMLElement>('viz-v1-target-status');
const appearanceList = byId<HTMLElement>('viz-v1-appearance');
const viewBar = byId<HTMLElement>('viz-v1-views');
const targetRadios = byId<HTMLElement>('viz-v1-target-radios');

byId('viz-v1-label').textContent = VIZ_V1_EVIDENCE_LABEL;

const params = new URLSearchParams(location.search);
let selectedId: string = targetById(params.get('target') ?? '')?.id ?? DEFAULT_TARGET_ID;
let view: VizView =
  VIZ_V1_VIEWS.find((candidate) => candidate.id === params.get('view')) ?? VIZ_V1_VIEWS[0]!;

// ---------------------------------------------------------------------------------------------
// Ports, service, backend, notices
// ---------------------------------------------------------------------------------------------

type LoggedNotice = ParsedNotice & { message: string };

const diagnostics: RendererDiagnostic[] = [];
/** Every notice, uncapped: the hook keeps all of them even when the page list drops older ones. */
const allNotices: LoggedNotice[] = [];
let droppedFromList = 0;
const tracker = new TargetStatusTracker(initialStates());
let fillPort: FillMeshAdapter | null = null;
let strokePort: StrokeMeshAdapter | null = null;
let wasmSha256: string | null = null;
let service: PrimitiveRendererService | null = null;
let editor: AppearanceEditor | null = null;
/** The mesh and analytic draw counts of the most recently submitted packet. */
let lastDraws = { meshDraws: 0, analyticDraws: 0, meshTriangles: 0 };

const backend = new WebGpuBackend();
backend.subscribeDiagnostics((event) => {
  const notice = parseNotice(event);
  if (notice !== null) {
    allNotices.push({ ...notice, message: event.message });
    tracker.addNotice(notice);
    const item = document.createElement('li');
    item.dataset.severity = event.severity;
    item.dataset.node = String(notice.nodeId);
    item.dataset.paint = String(notice.paint);
    item.dataset.code = notice.failureCode;
    item.textContent =
      `#${event.sequence} ${notice.nodeId} ${notice.paint} ${notice.failureCode} ` +
      `e=${notice.toleranceExponent ?? '-'}`;
    noticeList.prepend(item);
    // The page list keeps the newest MAX_LOG entries and counts the older ones it dropped.
    while (noticeList.childElementCount > MAX_LOG) {
      noticeList.lastElementChild!.remove();
      droppedFromList += 1;
    }
    noticeDropped.textContent =
      droppedFromList > 0 ? `${droppedFromList} older notices dropped from this list` : '';
    renderTargetStatus();
    return;
  }
  diagnostics.push(event);
  if (diagnostics.length > MAX_LOG) diagnostics.shift();
  const item = document.createElement('li');
  item.dataset.severity = event.severity;
  item.textContent = `#${event.sequence} ${event.code}: ${event.message}`;
  diagnosticList.prepend(item);
  while (diagnosticList.childElementCount > MAX_LOG) diagnosticList.lastElementChild!.remove();
});

/** Forwards to the service and records the draw counts of each packet the backend submits. */
function observedSource(inner: PrimitiveRendererService): PrimitiveFrameSource {
  const pending = new Map<symbol, typeof lastDraws>();
  return {
    requiresMeshPipeline: inner.requiresMeshPipeline,
    prepare(target: PrimitiveTarget): PrimitivePacket | null {
      const packet = inner.prepare(target);
      if (packet !== null) {
        pending.set(packet.packetId, {
          meshDraws: packet.mesh?.draws.length ?? 0,
          analyticDraws: packet.draws.length,
          meshTriangles: packet.mesh?.draws.reduce((sum, draw) => sum + draw.triangleCount, 0) ?? 0,
        });
      }
      return packet;
    },
    acknowledge(receipt: PrimitiveReceipt): void {
      const draws = pending.get(receipt.packetId);
      if (draws !== undefined) lastDraws = draws;
      pending.clear();
      inner.acknowledge(receipt);
    },
  };
}

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
  backend.attachPrimitiveFrameSource(observedSource(service));
  editor = new AppearanceEditor({
    sync: service,
    schedule: (run) => {
      requestAnimationFrame(() => run());
    },
  });
  editor.subscribe(onEditorChange);
  const result = editor.start();
  if (result.status !== 'applied' && result.status !== 'replayed') {
    throw new Error(`Scene rejected: ${JSON.stringify(result)}`);
  }
  applyCamera();
  const capability = await backend.initialize({
    canvas,
    cssSize: VIZ_V1_SURFACE,
    devicePixelRatio: window.devicePixelRatio,
  });
  setControlsDisabled(editor.disabledReason !== null);
  syncControls();
  renderAll();
  return capability;
}

function applyCamera(): void {
  const result = service!.setCamera(viewCamera(view));
  if (result.status !== 'applied' && result.status !== 'unchanged') {
    throw new Error(`Camera rejected: ${JSON.stringify(result)}`);
  }
}

function setView(next: VizView): void {
  const zoomChanged = next.zoom !== view.zoom;
  view = next;
  if (zoomChanged) tracker.zoomChanged();
  applyCamera();
  renderAll();
}

/** Zooms by `factor` keeping the surface point (sx, sy), in CSS px, fixed. */
function zoomAround(factor: number, sx: number, sy: number): void {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  const camera = viewCamera(view);
  const worldX = camera.position.x + sx / view.zoom;
  const worldY = camera.position.y + sy / view.zoom;
  setView({
    id: 'interactive',
    label: 'Interactive',
    zoom,
    focus: {
      x: worldX - sx / zoom + VIZ_V1_SURFACE.width / 2 / zoom,
      y: worldY - sy / zoom + VIZ_V1_SURFACE.height / 2 / zoom,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

const input = (id: string) => byId<HTMLInputElement>(id);
const fillOn = input('viz-v1-fill-on');
const fillColor = input('viz-v1-fill-color');
const fillAlpha = input('viz-v1-fill-alpha');
const strokeOn = input('viz-v1-stroke-on');
const strokeColor = input('viz-v1-stroke-color');
const strokeAlpha = input('viz-v1-stroke-alpha');
const widthSlider = input('viz-v1-width-slider');
const widthNumber = input('viz-v1-width-number');
const miterSlider = input('viz-v1-miter-slider');
const miterNumber = input('viz-v1-miter-number');
const opacitySlider = input('viz-v1-opacity-slider');
const opacityNumber = input('viz-v1-opacity-number');
const radiosOf = (name: string) =>
  Array.from(document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`));
const fillRuleRadios = radiosOf('viz-v1-fill-rule');
const capRadios = radiosOf('viz-v1-cap');
const joinRadios = radiosOf('viz-v1-join');

const allControls: HTMLInputElement[] = [
  fillOn,
  fillColor,
  fillAlpha,
  strokeOn,
  strokeColor,
  strokeAlpha,
  widthSlider,
  widthNumber,
  miterSlider,
  miterNumber,
  opacitySlider,
  opacityNumber,
  ...fillRuleRadios,
  ...capRadios,
  ...joinRadios,
];
const resetTargetButton = byId<HTMLButtonElement>('viz-v1-reset-target');
const resetAllButton = byId<HTMLButtonElement>('viz-v1-reset-all');

function setControlsDisabled(disabled: boolean): void {
  for (const control of allControls) control.disabled = disabled;
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="viz-v1-target"]')) {
    radio.disabled = disabled;
  }
  resetTargetButton.disabled = disabled;
  resetAllButton.disabled = disabled;
}
setControlsDisabled(true);

for (const target of VIZ_V1_TARGETS) {
  const label = document.createElement('label');
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'viz-v1-target';
  radio.value = target.id;
  radio.checked = target.id === selectedId;
  radio.addEventListener('input', () => selectTarget(target.id));
  label.title = target.label;
  label.append(radio, ` ${target.id}`);
  targetRadios.append(label);
}

function selectTarget(id: string): void {
  selectedId = id;
  for (const control of document.querySelectorAll('input[aria-invalid]')) {
    control.removeAttribute('aria-invalid');
  }
  for (const message of document.querySelectorAll('.message')) message.textContent = '';
  syncControls();
  renderAll();
}

/** Writes the selected target's state into the controls, leaving invalid typed text alone. */
function syncControls(): void {
  if (editor === null) return;
  const state = editor.states[selectedId]!;
  const set = (control: HTMLInputElement, value: string) => {
    if (control.getAttribute('aria-invalid') === 'true') return;
    if (control.value !== value) control.value = value;
  };
  fillOn.checked = state.fillOn;
  set(fillColor, toHex(state.fill));
  set(fillAlpha, String(state.fill.a));
  strokeOn.checked = state.strokeOn;
  set(strokeColor, toHex(state.stroke.color));
  set(strokeAlpha, String(state.stroke.color.a));
  set(widthSlider, String(state.stroke.width));
  set(widthNumber, String(state.stroke.width));
  set(miterSlider, String(state.stroke.miterLimit));
  set(miterNumber, String(state.stroke.miterLimit));
  set(opacitySlider, String(state.opacity));
  set(opacityNumber, String(state.opacity));
  for (const radio of fillRuleRadios) radio.checked = radio.value === state.fillRule;
  for (const radio of capRadios) radio.checked = radio.value === state.stroke.cap;
  for (const radio of joinRadios) radio.checked = radio.value === state.stroke.join;
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="viz-v1-target"]')) {
    radio.checked = radio.value === selectedId;
  }
}

type Latency = {
  control: string;
  startedAt: number;
  revisionAtStart: number;
  toFrameMs: number | null;
  toSettleMs: number | null;
};
const latencies: Latency[] = [];

function startLatency(control: string, startedAt: number): void {
  latencies.push({
    control,
    startedAt,
    revisionAtStart: editor!.revision,
    toFrameMs: null,
    toSettleMs: null,
  });
}

function messageFor(field: HTMLInputElement): HTMLElement | null {
  const id = field.getAttribute('aria-describedby');
  return id === null ? null : document.getElementById(id);
}

function onControl(
  id: ControlId,
  event: ControlEvent,
  field: HTMLInputElement,
  raw: string | boolean,
): void {
  const startedAt = performance.now();
  if (editor === null) return;
  const kind = CONTROL_KINDS[id];
  // Before a commit, `input` events update the displayed value only.
  if (event === 'input') {
    if (id === 'stroke-width-slider') widthNumber.value = widthSlider.value;
    if (id === 'miter-slider') miterNumber.value = miterSlider.value;
  }
  if (!appliesOn(kind, event)) return;
  const result = interpretControl(id, raw);
  const message = messageFor(field);
  if (!result.ok) {
    field.setAttribute('aria-invalid', 'true');
    if (message !== null) message.textContent = result.message;
    return;
  }
  field.removeAttribute('aria-invalid');
  if (message !== null) message.textContent = '';
  if (editor.edit(selectedId, result.patch)) startLatency(id, startedAt);
  syncControls();
}

function bindToggle(id: ControlId, field: HTMLInputElement, read: () => string | boolean): void {
  field.addEventListener('input', () => onControl(id, 'input', field, read()));
}
function bindSlider(id: ControlId, field: HTMLInputElement): void {
  field.addEventListener('input', () => onControl(id, 'input', field, field.value));
  field.addEventListener('change', () => onControl(id, 'change', field, field.value));
}
function bindNumber(id: ControlId, field: HTMLInputElement): void {
  field.addEventListener('change', () => onControl(id, 'change', field, field.value));
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onControl(id, 'enter', field, field.value);
  });
  field.addEventListener('blur', () => onControl(id, 'blur', field, field.value));
}

bindToggle('fill-on', fillOn, () => fillOn.checked);
bindToggle('fill-color', fillColor, () => fillColor.value);
bindNumber('fill-alpha', fillAlpha);
bindToggle('stroke-on', strokeOn, () => strokeOn.checked);
bindToggle('stroke-color', strokeColor, () => strokeColor.value);
bindNumber('stroke-alpha', strokeAlpha);
bindSlider('stroke-width-slider', widthSlider);
bindNumber('stroke-width-number', widthNumber);
bindSlider('miter-slider', miterSlider);
bindNumber('miter-number', miterNumber);
bindSlider('opacity-slider', opacitySlider);
bindNumber('opacity-number', opacityNumber);
for (const radio of fillRuleRadios) bindToggle('fill-rule', radio, () => radio.value);
for (const radio of capRadios) bindToggle('cap', radio, () => radio.value);
for (const radio of joinRadios) bindToggle('join', radio, () => radio.value);

resetTargetButton.addEventListener('click', () => {
  if (editor === null) return;
  const startedAt = performance.now();
  for (const field of allControls) field.removeAttribute('aria-invalid');
  for (const message of document.querySelectorAll('.message')) message.textContent = '';
  if (editor.resetTarget(selectedId)) startLatency('reset-target', startedAt);
  syncControls();
});
resetAllButton.addEventListener('click', () => {
  if (editor === null) return;
  const startedAt = performance.now();
  for (const field of allControls) field.removeAttribute('aria-invalid');
  for (const message of document.querySelectorAll('.message')) message.textContent = '';
  startLatency('reset-all', startedAt);
  editor.resetAll();
  syncControls();
});

function onEditorChange(): void {
  if (editor === null) return;
  for (const [id, state] of Object.entries(editor.states)) tracker.setState(id, state);
  setControlsDisabled(editor.disabledReason !== null || editor.stopped);
  syncControls();
  renderAll();
}

// ---------------------------------------------------------------------------------------------
// Status rendering
// ---------------------------------------------------------------------------------------------

let lastStatusText = '';
function renderTargetStatus(): void {
  const status = tracker.status(selectedId);
  const lines = [
    `${status.targetId}: path ${status.pathDrawn ? 'drawn' : 'not drawn'}`,
    `fill: ${status.fill.text}`,
    `stroke: ${status.stroke.text}`,
    status.overlay.text,
    status.label,
  ];
  const text = lines.join('\n');
  if (text === lastStatusText) return;
  lastStatusText = text;
  const rows = [
    [
      'path',
      `${status.targetId}: path ${status.pathDrawn ? 'drawn' : 'not drawn'}`,
      status.pathDrawn ? 'drawn' : 'not drawn',
    ],
    ['fill', `fill: ${status.fill.text}`, status.fill.outcome],
    ['stroke', `stroke: ${status.stroke.text}`, status.stroke.outcome],
    ['overlay', status.overlay.text, status.overlay.notDrawn ? 'not drawn' : 'drawn'],
    ['label', status.label, 'label'],
  ] as const;
  targetStatusEl.replaceChildren(
    ...rows.map(([kind, content, outcome]) => {
      const row = document.createElement('div');
      row.dataset.kind = kind;
      row.dataset.outcome = outcome;
      row.textContent = content;
      return row;
    }),
  );
}

function describeAppearance(id: string): string {
  const state = editor?.states[id] ?? initialStates()[id]!;
  const fill = state.fillOn
    ? `fill ${toHex(state.fill)} a=${state.fill.a} ${state.fillRule}`
    : 'fill off';
  const stroke = state.strokeOn
    ? `stroke ${toHex(state.stroke.color)} a=${state.stroke.color.a} width ${state.stroke.width} ` +
      `${state.stroke.cap} ${state.stroke.join} limit ${state.stroke.miterLimit}`
    : 'stroke off';
  return `${id}: ${fill}; ${stroke}; opacity ${state.opacity}`;
}

function renderAppearance(): void {
  appearanceList.replaceChildren(
    ...VIZ_V1_TARGETS.map((target) => {
      const item = document.createElement('li');
      item.dataset.target = target.id;
      item.textContent = describeAppearance(target.id);
      return item;
    }),
  );
}

function renderErrors(): void {
  errorList.replaceChildren(
    ...(editor?.errors ?? []).map((error) => {
      const item = document.createElement('li');
      item.textContent = error;
      return item;
    }),
  );
}

function renderStatus(): void {
  const statistics = backend.getStatistics();
  const pathMesh = service?.getPathMeshStatistics() ?? null;
  const rows: Array<readonly [string, string]> = [
    ['lifecycle', statistics.lifecycle],
    [
      'ports',
      fillPort === null || strokePort === null
        ? 'loading'
        : `${fillPort.operationId} v${fillPort.portVersion}; ${strokePort.operationId} v${strokePort.portVersion}`,
    ],
    ['kernel SHA-256', wasmSha256 === null ? '-' : `${wasmSha256.slice(0, 16)}...`],
    ['edit target', selectedId],
    ['scene revision', String(editor?.revision ?? 0)],
    ['view', view.id],
    ['zoom', view.zoom.toFixed(3)],
    ['focus', `${view.focus.x.toFixed(2)}, ${view.focus.y.toFixed(2)}`],
    ['frames submitted', String(statistics.framesSubmitted)],
    ['mesh draws', String(lastDraws.meshDraws)],
    ['fill port calls', String(pathMesh?.portCalls ?? 0)],
    ['stroke port calls', String(pathMesh?.strokePortCalls ?? 0)],
    ['mesh cache', `${pathMesh?.entries ?? 0} entries, ${pathMesh?.bytes ?? 0} B`],
    ['D8 notices', String(allNotices.length)],
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
}

function renderAll(): void {
  renderStatus();
  renderAppearance();
  renderErrors();
  renderTargetStatus();
}

for (const named of VIZ_V1_VIEWS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = named.id;
  button.title = named.label;
  button.addEventListener('click', () => setView(named));
  viewBar.append(button);
}

// Interaction: drag pans, the wheel zooms about the cursor.
let drag: { pointerId: number; x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (event) => {
  drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');
});
canvas.addEventListener('pointermove', (event) => {
  if (drag === null || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  drag = { ...drag, x: event.clientX, y: event.clientY };
  setView({
    ...view,
    id: 'interactive',
    focus: { x: view.focus.x - dx / view.zoom, y: view.focus.y - dy / view.zoom },
  });
});
const endDrag = (event: PointerEvent) => {
  if (drag?.pointerId !== event.pointerId) return;
  drag = null;
  canvas.classList.remove('dragging');
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    zoomAround(
      Math.pow(2, -event.deltaY / 500),
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
  },
  { passive: false },
);
byId('viz-v1-zoom-in').addEventListener('click', () =>
  zoomAround(2, VIZ_V1_SURFACE.width / 2, VIZ_V1_SURFACE.height / 2),
);
byId('viz-v1-zoom-out').addEventListener('click', () =>
  zoomAround(0.5, VIZ_V1_SURFACE.width / 2, VIZ_V1_SURFACE.height / 2),
);
byId('viz-v1-reset-view').addEventListener('click', () => setView(VIZ_V1_VIEWS[0]!));
window.setInterval(renderStatus, 500);

const ready = start();
// A missing or mismatched kernel is reported on the page, for example after a static build.
ready.catch((error: unknown) => {
  const item = document.createElement('li');
  item.dataset.severity = 'error';
  item.textContent = error instanceof Error ? error.message : String(error);
  diagnosticList.prepend(item);
});

const nextAnimationFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

// V1-A13: edit latency as a FUNCTIONAL observation (no performance claim, no threshold). The
// time from the control event to the first frame submitted after the change reached the
// renderer, and to the last frame before the page settled.
{
  let previousFrames = -1;
  let stable = 0;
  let lastChangeAt = 0;
  const tick = (now: number) => {
    const frames = backend.getStatistics().framesSubmitted;
    if (frames !== previousFrames) {
      previousFrames = frames;
      stable = 0;
      lastChangeAt = now;
      for (const latency of latencies) {
        if (
          latency.toFrameMs === null &&
          editor !== null &&
          !editor.hasPending &&
          editor.revision > latency.revisionAtStart
        ) {
          latency.toFrameMs = Math.max(0, now - latency.startedAt);
        }
      }
    } else {
      stable += 1;
      if (stable === STABLE_FRAMES) {
        for (const latency of latencies) {
          if (latency.toFrameMs !== null && latency.toSettleMs === null) {
            latency.toSettleMs = Math.max(latency.toFrameMs, lastChangeAt - latency.startedAt);
          }
        }
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const api = {
  ready,
  /**
   * Resolves once no edit is pending and frames stop being submitted: path meshes can take
   * several prepares (one isolation step per prepare), so a settled page has submitted every
   * frame it will.
   */
  async settle() {
    await ready;
    let stable = 0;
    let previous = -1;
    for (let attempt = 0; attempt < 1200 && stable < STABLE_FRAMES; attempt += 1) {
      await nextAnimationFrame();
      const frames = backend.getStatistics().framesSubmitted;
      const idle = editor === null || !editor.hasPending;
      stable = idle && frames > 0 && frames === previous ? stable + 1 : 0;
      previous = frames;
    }
    renderAll();
    return api.snapshot();
  },
  snapshot() {
    return {
      view,
      targetId: selectedId,
      revision: editor?.revision ?? 0,
      states: editor === null ? null : (JSON.parse(JSON.stringify(editor.states)) as unknown),
      disabledReason: editor?.disabledReason ?? null,
      errors: editor === null ? [] : editor.errors.slice(),
      statistics: backend.getStatistics(),
      pathMesh: service?.getPathMeshStatistics() ?? null,
      draws: lastDraws,
      diagnostics: diagnostics.slice(),
      notices: allNotices.slice(),
      noticesOnPage: noticeList.childElementCount,
      noticesDroppedFromList: droppedFromList,
      targetStatus: tracker.status(selectedId),
      latencies: latencies.map((latency) => ({ ...latency })),
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
  },
  dispose() {
    service?.dispose();
    backend.dispose();
    fillPort?.dispose();
    strokePort?.dispose();
    return backend.getStatistics();
  },
};

Object.assign(window, { __vectorStudioVizV1Appearance: api });
export type VizV1AppearanceApi = typeof api;
