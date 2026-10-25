import type {
  RenderCamera,
  RendererCapabilityResult,
  RendererDiagnostic,
} from '@vector-studio/contracts';
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
import { parseNotice, type ControlEvent, type ParsedNotice } from './viz-v1-appearance-state.js';
import {
  INITIAL_APPEARANCE,
  MAX_ZOOM,
  MIN_ZOOM,
  NODE_ID,
  PathDataEditor,
  PathStatusTracker,
  VIZ_V2_EVIDENCE_LABEL,
  VIZ_V2_SURFACE,
  DEFAULT_PATH_TEXT,
  controlApplies,
  fitCamera,
  interpretControl,
  type ApplyOutcome,
  type V2ControlId,
} from './viz-v2-path-data-state.js';
import type { PathDataError } from './viz-v2-path-data-parse.js';

// Visualization track V-2 (docs/plans/viz-v2-path-data-contract.md): the SVG path-data page. This
// page is a host: it injects the real fill-mesh port (`createFillMeshPort`) and the real
// stroke-mesh port (`createStrokeMeshPort`) from geometry-wasm into the renderer service, exactly
// as the V-1 page does, and sends one scene path node through the existing `applyChanges` and
// `replaceSnapshot` calls. It adds no draw work, no kernel work and no renderer code. The path text
// is parsed on Apply only. Path notices are listed, never hidden or cleared.
//
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target until
// B4 has A04 evidence. No path text or appearance state is written to localStorage, IndexedDB or
// the URL, and no query parameter is read.

/** Served by the playground's Vite config from the local kernel build; see vite.config.mjs. */
const WASM_URL = '/__vector-studio/geometry-kernel.wasm';
const MAX_LOG = 400;
const STABLE_FRAMES = 12;

const byId = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`)!;
const canvas = byId<HTMLCanvasElement>('viz-v2-surface');
const statusList = byId<HTMLElement>('viz-v2-status');
const noticeList = byId<HTMLOListElement>('viz-v2-notices');
const noticeDropped = byId<HTMLElement>('viz-v2-notices-dropped');
const diagnosticList = byId<HTMLOListElement>('viz-v2-diagnostics');
const errorList = byId<HTMLOListElement>('viz-v2-errors');
const pathStatusEl = byId<HTMLElement>('viz-v2-path-status');
const appliedEl = byId<HTMLElement>('viz-v2-applied');
const editStateEl = byId<HTMLElement>('viz-v2-edit-state');
const parseErrorEl = byId<HTMLElement>('viz-v2-error');
const pathText = byId<HTMLTextAreaElement>('viz-v2-path-text');
const applyButton = byId<HTMLButtonElement>('viz-v2-apply');
const fitButton = byId<HTMLButtonElement>('viz-v2-fit');

byId('viz-v2-label').textContent = VIZ_V2_EVIDENCE_LABEL;
pathText.value = DEFAULT_PATH_TEXT;

// ---------------------------------------------------------------------------------------------
// Ports, service, backend, notices
// ---------------------------------------------------------------------------------------------

type LoggedNotice = ParsedNotice & { message: string };

const diagnostics: RendererDiagnostic[] = [];
/** Every notice, uncapped: the hook keeps all of them even when the page list drops older ones. */
const allNotices: LoggedNotice[] = [];
let droppedFromList = 0;
const tracker = new PathStatusTracker(1, INITIAL_APPEARANCE);
let fillPort: FillMeshAdapter | null = null;
let strokePort: StrokeMeshAdapter | null = null;
let wasmSha256: string | null = null;
let service: PrimitiveRendererService | null = null;
let editor: PathDataEditor | null = null;
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
    renderPathStatus();
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

// The camera the page last set: the world point at the top-left corner and the zoom.
let camera: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };

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
  editor = new PathDataEditor({
    sync: service,
    schedule: (run) => {
      requestAnimationFrame(() => run());
    },
  });
  editor.subscribe(onEditorChange);
  // V2-A15: the default path is applied at load; its time is recorded like an Apply.
  const loadStartedAt = performance.now();
  startLatency('load', loadStartedAt, null, DEFAULT_PATH_TEXT.length);
  const result = editor.start();
  applyTimings.push({
    inputLength: DEFAULT_PATH_TEXT.length,
    status: 'load',
    parseMs: performance.now() - loadStartedAt,
  });
  if (result.status !== 'applied' && result.status !== 'replayed') {
    throw new Error(`Scene rejected: ${JSON.stringify(result)}`);
  }
  appliedTextShown = editor.appliedText;
  setCamera(fitCamera(editor.geometry, editor.appearance), false);
  const capability = await backend.initialize({
    canvas,
    cssSize: VIZ_V2_SURFACE,
    devicePixelRatio: window.devicePixelRatio,
  });
  setControlsDisabled(editor.disabledReason !== null);
  syncControls();
  renderAll();
  return capability;
}

/** Sets the camera. `userView` marks a view change that makes the status label "may differ". */
function setCamera(next: RenderCamera, userView: boolean): void {
  const zoomChanged = next.zoom !== camera.zoom;
  camera = next;
  if (userView && zoomChanged) tracker.zoomChanged();
  const result = service!.setCamera(camera);
  if (result.status !== 'applied' && result.status !== 'unchanged') {
    throw new Error(`Camera rejected: ${JSON.stringify(result)}`);
  }
  renderAll();
}

/** Zooms by `factor` keeping the surface point (sx, sy), in CSS px, fixed. */
function zoomAround(factor: number, sx: number, sy: number): void {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * factor));
  const worldX = camera.position.x + sx / camera.zoom;
  const worldY = camera.position.y + sy / camera.zoom;
  setCamera({ position: { x: worldX - sx / zoom, y: worldY - sy / zoom }, zoom }, true);
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

const input = (id: string) => byId<HTMLInputElement>(id);
const fillOn = input('viz-v2-fill-on');
const strokeOn = input('viz-v2-stroke-on');
const widthNumber = input('viz-v2-width-number');
const radiosOf = (name: string) =>
  Array.from(document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`));
const fillRuleRadios = radiosOf('viz-v2-fill-rule');
const capRadios = radiosOf('viz-v2-cap');
const joinRadios = radiosOf('viz-v2-join');

const allControls: HTMLInputElement[] = [
  fillOn,
  strokeOn,
  widthNumber,
  ...fillRuleRadios,
  ...capRadios,
  ...joinRadios,
];

function setControlsDisabled(disabled: boolean): void {
  for (const control of allControls) control.disabled = disabled;
  pathText.disabled = disabled;
  applyButton.disabled = disabled;
  fitButton.disabled = disabled;
}
setControlsDisabled(true);

/** Writes the appearance into the controls, leaving invalid typed text alone. */
function syncControls(): void {
  const state = editor?.appearance ?? INITIAL_APPEARANCE;
  fillOn.checked = state.fillOn;
  strokeOn.checked = state.strokeOn;
  if (widthNumber.getAttribute('aria-invalid') !== 'true') {
    const value = String(state.strokeWidth);
    if (widthNumber.value !== value) widthNumber.value = value;
  }
  for (const radio of fillRuleRadios) radio.checked = radio.value === state.fillRule;
  for (const radio of capRadios) radio.checked = radio.value === state.cap;
  for (const radio of joinRadios) radio.checked = radio.value === state.join;
}

type Latency = {
  control: string;
  startedAt: number;
  revisionAtStart: number;
  toFrameMs: number | null;
  toSettleMs: number | null;
  /** Parse time of an Apply, in ms; null for a control edit. */
  parseMs: number | null;
  inputLength: number | null;
};
const latencies: Latency[] = [];

function startLatency(
  control: string,
  startedAt: number,
  parseMs: number | null = null,
  inputLength: number | null = null,
  revisionAtStart: number = editor!.revision,
): void {
  latencies.push({
    control,
    startedAt,
    revisionAtStart,
    toFrameMs: null,
    toSettleMs: null,
    parseMs,
    inputLength,
  });
}

function onControl(
  id: V2ControlId,
  event: ControlEvent,
  field: HTMLInputElement,
  raw: string | boolean,
): void {
  const startedAt = performance.now();
  if (editor === null) return;
  if (!controlApplies(id, event)) return;
  const result = interpretControl(id, raw);
  const message = id === 'stroke-width-number' ? byId('viz-v2-width-message') : null;
  if (!result.ok) {
    field.setAttribute('aria-invalid', 'true');
    if (message !== null) message.textContent = result.message;
    return;
  }
  field.removeAttribute('aria-invalid');
  if (message !== null) message.textContent = '';
  if (editor.edit(result.patch)) startLatency(id, startedAt);
  syncControls();
}

function bindToggle(id: V2ControlId, field: HTMLInputElement, read: () => string | boolean): void {
  field.addEventListener('input', () => onControl(id, 'input', field, read()));
}
function bindNumber(id: V2ControlId, field: HTMLInputElement): void {
  field.addEventListener('change', () => onControl(id, 'change', field, field.value));
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') onControl(id, 'enter', field, field.value);
  });
  field.addEventListener('blur', () => onControl(id, 'blur', field, field.value));
}

bindToggle('fill-on', fillOn, () => fillOn.checked);
bindToggle('stroke-on', strokeOn, () => strokeOn.checked);
bindNumber('stroke-width-number', widthNumber);
for (const radio of fillRuleRadios) bindToggle('fill-rule', radio, () => radio.value);
for (const radio of capRadios) bindToggle('cap', radio, () => radio.value);
for (const radio of joinRadios) bindToggle('join', radio, () => radio.value);

// ---------------------------------------------------------------------------------------------
// Path text: typing and blur change nothing; Apply parses (section 3.3)
// ---------------------------------------------------------------------------------------------

let appliedTextShown = DEFAULT_PATH_TEXT;
let lastParseError: PathDataError | null = null;
let lastOutcome: 'none' | 'applied' | 'unchanged' | 'error' = 'none';
/** The parse and apply timings of each Apply, for observations.json (V2-A15). */
const applyTimings: Array<{
  inputLength: number;
  status: string;
  parseMs: number;
}> = [];

function excerptWithCaret(text: string, error: PathDataError): string {
  const lineStart = text.lastIndexOf('\n', error.offset - 1) + 1;
  let lineEnd = text.indexOf('\n', error.offset);
  if (lineEnd === -1) lineEnd = text.length;
  const lineText = text.slice(lineStart, lineEnd);
  // One-line excerpt: at most 60 code units around the offset.
  const column = error.offset - lineStart;
  const from = Math.max(0, column - 30);
  const excerpt = lineText.slice(from, from + 60);
  return `${excerpt}\n${' '.repeat(column - from)}^`;
}

function showError(text: string, error: PathDataError): void {
  parseErrorEl.textContent =
    `${error.code}: line ${error.line}, column ${error.column}\n${error.message}\n` +
    excerptWithCaret(text, error);
  pathText.setAttribute('aria-invalid', 'true');
  pathText.setAttribute('aria-describedby', 'viz-v2-error');
  pathText.focus();
  pathText.setSelectionRange(error.offset, error.offset);
}

function clearError(): void {
  parseErrorEl.textContent = '';
  pathText.removeAttribute('aria-invalid');
  lastParseError = null;
}

function applyPathData(): void {
  if (editor === null) return;
  const text = pathText.value;
  const startedAt = performance.now();
  const revisionBefore = editor.revision;
  const outcome: ApplyOutcome = editor.apply(text);
  const parseMs = performance.now() - startedAt;
  applyTimings.push({ inputLength: text.length, status: outcome.status, parseMs });
  switch (outcome.status) {
    case 'error':
      lastParseError = outcome.error;
      lastOutcome = 'error';
      showError(text, outcome.error);
      break;
    case 'unchanged':
      clearError();
      lastOutcome = 'unchanged';
      appliedTextShown = text;
      break;
    case 'applied':
      clearError();
      lastOutcome = 'applied';
      appliedTextShown = text;
      if (editor.revision > revisionBefore) {
        startLatency('apply', startedAt, parseMs, text.length, revisionBefore);
      }
      // The fit is part of this Apply and runs before the next frame (section 3.4).
      setCamera(fitCamera(editor.geometry, editor.appearance), false);
      break;
    case 'not-applied':
      lastOutcome = 'none';
      break;
  }
  renderAll();
}

applyButton.addEventListener('click', applyPathData);
fitButton.addEventListener('click', () => {
  if (editor === null) return;
  setCamera(fitCamera(editor.geometry, editor.appearance), true);
});
// Typing, pasting and `input` events change the text area only; the label shows the difference.
pathText.addEventListener('input', () => renderEditState());

function onEditorChange(): void {
  if (editor === null) return;
  tracker.setState(editor.generation, editor.appearance);
  setControlsDisabled(editor.disabledReason !== null || editor.stopped);
  syncControls();
  renderAll();
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

function renderEditState(): void {
  if (pathText.value !== appliedTextShown) editStateEl.textContent = 'Edited, not applied';
  else if (lastOutcome === 'unchanged') editStateEl.textContent = 'Unchanged';
  else editStateEl.textContent = '';
}

let lastStatusText = '';
function renderPathStatus(): void {
  const status = tracker.status();
  const lines = [
    `${NODE_ID}: path ${status.pathDrawn ? 'drawn' : 'not drawn'}`,
    `fill: ${status.fill.text}`,
    `stroke: ${status.stroke.text}`,
    status.label,
  ];
  const text = lines.join('\n');
  if (text === lastStatusText) return;
  lastStatusText = text;
  const rows = [
    ['path', lines[0]!, status.pathDrawn ? 'drawn' : 'not drawn'],
    ['fill', lines[1]!, status.fill.outcome],
    ['stroke', lines[2]!, status.stroke.outcome],
    ['label', lines[3]!, 'label'],
  ] as const;
  pathStatusEl.replaceChildren(
    ...rows.map(([kind, content, outcome]) => {
      const row = document.createElement('div');
      row.dataset.kind = kind;
      row.dataset.outcome = outcome;
      row.textContent = content;
      return row;
    }),
  );
}
function boundingBox(points: readonly number[]): string {
  if (points.length === 0) return 'none';
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < points.length; index += 2) {
    minX = Math.min(minX, points[index]!);
    maxX = Math.max(maxX, points[index]!);
    minY = Math.min(minY, points[index + 1]!);
    maxY = Math.max(maxY, points[index + 1]!);
  }
  return `x ${minX} to ${maxX}, y ${minY} to ${maxY}`;
}

function renderApplied(): void {
  const geometry = editor?.geometry;
  appliedEl.textContent =
    geometry === undefined
      ? 'loading'
      : `${geometry.verbs.length} verbs, ${geometry.points.length / 2} points, bounding box ${boundingBox(geometry.points)} (control points included)`;
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
    ['scene revision', String(editor?.revision ?? 0)],
    ['geometry generation', String(editor?.generation ?? 0)],
    ['zoom', camera.zoom.toPrecision(6)],
    ['camera position', `${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}`],
    ['frames submitted', String(statistics.framesSubmitted)],
    ['mesh draws', String(lastDraws.meshDraws)],
    ['fill port calls', String(pathMesh?.portCalls ?? 0)],
    ['stroke port calls', String(pathMesh?.strokePortCalls ?? 0)],
    ['mesh cache', `${pathMesh?.entries ?? 0} entries, ${pathMesh?.bytes ?? 0} B`],
    ['Path notices', String(allNotices.length)],
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
  renderApplied();
  renderErrors();
  renderPathStatus();
  renderEditState();
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
  setCamera(
    {
      position: {
        x: camera.position.x - dx / camera.zoom,
        y: camera.position.y - dy / camera.zoom,
      },
      zoom: camera.zoom,
    },
    true,
  );
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
byId('viz-v2-zoom-in').addEventListener('click', () =>
  zoomAround(2, VIZ_V2_SURFACE.width / 2, VIZ_V2_SURFACE.height / 2),
);
byId('viz-v2-zoom-out').addEventListener('click', () =>
  zoomAround(0.5, VIZ_V2_SURFACE.width / 2, VIZ_V2_SURFACE.height / 2),
);
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

// V2-A15: Apply latency as a FUNCTIONAL observation (no performance claim, no threshold). The time
// from the Apply event to the first frame submitted after the change reached the renderer, and to
// the last frame before the page settled.
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
      camera: { position: { ...camera.position }, zoom: camera.zoom },
      revision: editor?.revision ?? 0,
      generation: editor?.generation ?? 0,
      verbs: editor === null ? [] : editor.geometry.verbs.slice(),
      points: editor === null ? [] : editor.geometry.points.slice(),
      appliedText: editor?.appliedText ?? '',
      appearance: editor === null ? null : { ...editor.appearance },
      lastOutcome,
      lastParseError,
      editState: editStateEl.textContent ?? '',
      disabledReason: editor?.disabledReason ?? null,
      errors: editor === null ? [] : editor.errors.slice(),
      statistics: backend.getStatistics(),
      pathMesh: service?.getPathMeshStatistics() ?? null,
      draws: lastDraws,
      diagnostics: diagnostics.slice(),
      notices: allNotices.slice(),
      noticesOnPage: noticeList.childElementCount,
      noticesDroppedFromList: droppedFromList,
      targetStatus: tracker.status(),
      latencies: latencies.map((latency) => ({ ...latency })),
      applyTimings: applyTimings.map((timing) => ({ ...timing })),
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

Object.assign(window, { __vectorStudioVizV2PathData: api });
export type VizV2PathDataApi = typeof api;
