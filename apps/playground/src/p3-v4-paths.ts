import type { RendererCapabilityResult, RendererDiagnostic } from '@vector-studio/contracts';
import { createFillMeshPort, type FillMeshAdapter } from '@vector-studio/geometry-wasm';
import { PrimitiveRendererService } from '@vector-studio/renderer-core';
import { WebGpuBackend } from '@vector-studio/renderer-webgpu';
import {
  SCENE_CENTER,
  V4_PATHS,
  V4_SURFACE,
  rotationTransform,
  v4Snapshot,
  viewAt,
  viewCamera,
  type V4View,
} from './p3-v4-paths-scene.js';

// P3 D8 checkpoint V4: the playground path page. This page is a host: it injects the real
// fill-mesh port, `createFillMeshPort` from geometry-wasm (fill-v0, revision 2), into the
// renderer service, as V3-A18 foresaw for V4. The renderer draws its meshes with the D8-interim
// TypeScript fringe builder under the V4 builder work cap (more than 128 distinct boundary
// vertices: region-only draw and a `fringe-work-cap` notice). Pan and zoom drive the camera;
// rotation is the world container's transform about the scene center.
//
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target
// until B4 has A04 evidence, and no Q4 coverage threshold is claimed.

/** Served by the playground's Vite config from the local kernel build; see vite.config.mjs. */
const WASM_URL = '/__vector-studio/geometry-kernel.wasm';
const MIN_ZOOM = 0.125;
const MAX_ZOOM = 64;
const MAX_DIAGNOSTICS = 200;

const canvas = document.querySelector<HTMLCanvasElement>('#p3-v4-surface')!;
const statusList = document.querySelector<HTMLElement>('#p3-v4-status')!;
const pathList = document.querySelector<HTMLOListElement>('#p3-v4-paths')!;
const diagnosticList = document.querySelector<HTMLOListElement>('#p3-v4-diagnostics')!;
const rotationInput = document.querySelector<HTMLInputElement>('#p3-v4-rotation')!;

for (const path of V4_PATHS) {
  const item = document.createElement('li');
  item.textContent = `${path.id}: ${path.label}`;
  pathList.append(item);
}

const diagnostics: RendererDiagnostic[] = [];
let port: FillMeshAdapter | null = null;
let wasmSha256: string | null = null;
let view: V4View = viewAt('initial', SCENE_CENTER, 1, 0);
let revision = 0;

const backend = new WebGpuBackend();
backend.subscribeDiagnostics((event) => {
  diagnostics.push(event);
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift();
  const item = document.createElement('li');
  item.dataset.severity = event.severity;
  item.textContent = `#${event.sequence} ${event.code}: ${event.message}`;
  diagnosticList.prepend(item);
  while (diagnosticList.childElementCount > MAX_DIAGNOSTICS)
    diagnosticList.lastElementChild!.remove();
});

let service: PrimitiveRendererService | null = null;

async function loadPort(): Promise<FillMeshAdapter> {
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
  return createFillMeshPort(bytes);
}

async function start(): Promise<RendererCapabilityResult> {
  port = await loadPort();
  const adapter = port;
  service = new PrimitiveRendererService(backend, {
    fillMesh: adapter,
    fillMeshMemoryBytes: () => adapter.linearMemoryBytes(),
  });
  backend.attachPrimitiveFrameSource(service);
  applyRotation(view.rotation);
  applyCamera();
  const capability = await backend.initialize({
    canvas,
    cssSize: V4_SURFACE,
    devicePixelRatio: window.devicePixelRatio,
  });
  renderStatus();
  return capability;
}

function applyRotation(degrees: number): void {
  revision += 1;
  const result = service!.replaceSnapshot(v4Snapshot(degrees, revision));
  if (result.status !== 'applied' && result.status !== 'replayed') {
    throw new Error(`Scene rejected: ${JSON.stringify(result)}`);
  }
}

function applyCamera(): void {
  const result = service!.setCamera(viewCamera(view));
  if (result.status !== 'applied' && result.status !== 'unchanged') {
    throw new Error(`Camera rejected: ${JSON.stringify(result)}`);
  }
}

function setView(next: V4View): void {
  const rotationChanged = next.rotation !== view.rotation;
  view = next;
  if (rotationChanged) applyRotation(view.rotation);
  applyCamera();
  rotationInput.value = String(Math.round(view.rotation));
  renderStatus();
}

/** Zooms by `factor` keeping the surface point (sx, sy), in CSS px, fixed. */
function zoomAround(factor: number, sx: number, sy: number): void {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
  const worldX = view.position.x + sx / view.zoom;
  const worldY = view.position.y + sy / view.zoom;
  setView({
    ...view,
    id: 'interactive',
    zoom,
    position: { x: worldX - sx / zoom, y: worldY - sy / zoom },
  });
}

function renderStatus(): void {
  const statistics = backend.getStatistics();
  const pathMesh = service?.getPathMeshStatistics() ?? null;
  const rows: Array<readonly [string, string]> = [
    ['lifecycle', statistics.lifecycle],
    ['port', port === null ? 'loading' : `${port.operationId} v${port.portVersion}`],
    ['kernel SHA-256', wasmSha256 === null ? '-' : `${wasmSha256.slice(0, 16)}...`],
    ['zoom', view.zoom.toFixed(3)],
    ['rotation', `${view.rotation.toFixed(1)} deg`],
    ['camera', `${view.position.x.toFixed(1)}, ${view.position.y.toFixed(1)}`],
    ['frames submitted', String(statistics.framesSubmitted)],
    ['port calls', String(pathMesh?.portCalls ?? 0)],
    ['mesh cache', `${pathMesh?.entries ?? 0} entries, ${pathMesh?.bytes ?? 0} B`],
    ['kernel memory', `${pathMesh?.portLinearMemoryBytes ?? 0} B`],
    ['D8 notices', String(diagnostics.filter(isInterimNotice).length)],
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

function isInterimNotice(event: RendererDiagnostic): boolean {
  return event.code === 'render.path-mesh-interim-failure';
}

// Interaction: drag pans, the wheel zooms about the cursor, Q/E and the slider rotate.
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
    position: { x: view.position.x - dx / view.zoom, y: view.position.y - dy / view.zoom },
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
window.addEventListener('keydown', (event) => {
  if (event.key === 'q' || event.key === 'e') {
    setView({
      ...view,
      id: 'interactive',
      rotation: view.rotation + (event.key === 'q' ? -15 : 15),
    });
  }
});
rotationInput.addEventListener('input', () => {
  setView({ ...view, id: 'interactive', rotation: Number(rotationInput.value) });
});
document
  .querySelector('#p3-v4-zoom-in')!
  .addEventListener('click', () => zoomAround(2, V4_SURFACE.width / 2, V4_SURFACE.height / 2));
document
  .querySelector('#p3-v4-zoom-out')!
  .addEventListener('click', () => zoomAround(0.5, V4_SURFACE.width / 2, V4_SURFACE.height / 2));
document
  .querySelector('#p3-v4-reset')!
  .addEventListener('click', () => setView(viewAt('initial', SCENE_CENTER, 1, 0)));
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

const api = {
  ready,
  /** Applies a view and resolves after a frame newer than the change has been submitted. */
  async show(next: V4View) {
    await ready;
    const before = backend.getStatistics().framesSubmitted;
    setView(next);
    backend.invalidate({ reason: 'viewport' });
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await nextAnimationFrame();
      if (backend.getStatistics().framesSubmitted > before) break;
    }
    // One more frame so the compositor shows the submitted texture before a screenshot.
    await nextAnimationFrame();
    await nextAnimationFrame();
    renderStatus();
    return api.snapshot();
  },
  snapshot() {
    return {
      view,
      containerTransform: rotationTransform(view.rotation),
      statistics: backend.getStatistics(),
      pathMesh: service?.getPathMeshStatistics() ?? null,
      diagnostics: diagnostics.slice(),
      port: port === null ? null : { operationId: port.operationId, portVersion: port.portVersion },
      wasmSha256,
      devicePixelRatio: window.devicePixelRatio,
    };
  },
  dispose() {
    service?.dispose();
    backend.dispose();
    port?.dispose();
    return backend.getStatistics();
  },
};

Object.assign(window, { __vectorStudioP3V4Paths: api });
export type P3V4PathsApi = typeof api;
