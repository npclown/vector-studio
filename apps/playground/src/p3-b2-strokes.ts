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
import { isPathNotice } from './path-notices.js';
import {
  B2_PATHS,
  B2_SURFACE,
  B2_VIEWS,
  b2Snapshot,
  viewCamera,
  type B2View,
} from './p3-b2-strokes-scene.js';

// B2 stroke contract, unit ST-U8: the playground stroke page. This page is a host: it injects
// the real fill-mesh port (`createFillMeshPort`, fill-v0 revision 2) and the real stroke-mesh
// port (`createStrokeMeshPort`, stroke-v0 revision 5) from geometry-wasm into the renderer
// service. A path whose stroke or fill the kernel cannot mesh within its limits is not drawn and
// reports the `work-limit` notice; this page lists those notices (the open ST-U9
// decision) instead of hiding them.
//
// Functional evidence only: precision is UNVERIFIED against the 0.25 physical-pixel target until
// B4 has A04 evidence, and no Q4 coverage threshold is claimed.

/** Served by the playground's Vite config from the local kernel build; see vite.config.mjs. */
const WASM_URL = '/__vector-studio/geometry-kernel.wasm';
const MIN_ZOOM = 0.01;
const MAX_ZOOM = 64;
const MAX_DIAGNOSTICS = 400;

const canvas = document.querySelector<HTMLCanvasElement>('#p3-b2-surface')!;
const statusList = document.querySelector<HTMLElement>('#p3-b2-status')!;
const pathList = document.querySelector<HTMLOListElement>('#p3-b2-paths')!;
const noticeList = document.querySelector<HTMLOListElement>('#p3-b2-notices')!;
const diagnosticList = document.querySelector<HTMLOListElement>('#p3-b2-diagnostics')!;
const viewBar = document.querySelector<HTMLElement>('#p3-b2-views')!;

for (const path of B2_PATHS) {
  const item = document.createElement('li');
  item.textContent = `${path.id}: ${path.label}`;
  pathList.append(item);
}

const diagnostics: RendererDiagnostic[] = [];
let fillPort: FillMeshAdapter | null = null;
let strokePort: StrokeMeshAdapter | null = null;
let wasmSha256: string | null = null;
const requested = new URLSearchParams(location.search).get('view');
let view: B2View = B2_VIEWS.find((candidate) => candidate.id === requested) ?? B2_VIEWS[0]!;

const backend = new WebGpuBackend();
backend.subscribeDiagnostics((event) => {
  diagnostics.push(event);
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.shift();
  const item = document.createElement('li');
  item.dataset.severity = event.severity;
  item.textContent = `#${event.sequence} ${event.code}: ${event.message}`;
  (isPathNotice(event) ? noticeList : diagnosticList).prepend(item);
  while (diagnosticList.childElementCount > MAX_DIAGNOSTICS)
    diagnosticList.lastElementChild!.remove();
});

let service: PrimitiveRendererService | null = null;
/** The mesh and analytic draw counts of the most recently submitted packet. */
let lastDraws = { meshDraws: 0, analyticDraws: 0, meshTriangles: 0 };

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
  const result = service.replaceSnapshot(b2Snapshot(1));
  if (result.status !== 'applied' && result.status !== 'replayed') {
    throw new Error(`Scene rejected: ${JSON.stringify(result)}`);
  }
  applyCamera();
  const capability = await backend.initialize({
    canvas,
    cssSize: B2_SURFACE,
    devicePixelRatio: window.devicePixelRatio,
  });
  renderStatus();
  return capability;
}

function applyCamera(): void {
  const result = service!.setCamera(viewCamera(view));
  if (result.status !== 'applied' && result.status !== 'unchanged') {
    throw new Error(`Camera rejected: ${JSON.stringify(result)}`);
  }
}

function setView(next: B2View): void {
  view = next;
  applyCamera();
  renderStatus();
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
      x: worldX - sx / zoom + B2_SURFACE.width / 2 / zoom,
      y: worldY - sy / zoom + B2_SURFACE.height / 2 / zoom,
    },
  });
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
    ['view', view.id],
    ['zoom', view.zoom.toFixed(3)],
    ['focus', `${view.focus.x.toFixed(2)}, ${view.focus.y.toFixed(2)}`],
    ['frames submitted', String(statistics.framesSubmitted)],
    ['mesh draws', String(lastDraws.meshDraws)],
    ['fill port calls', String(pathMesh?.portCalls ?? 0)],
    ['stroke port calls', String(pathMesh?.strokePortCalls ?? 0)],
    ['mesh cache', `${pathMesh?.entries ?? 0} entries, ${pathMesh?.bytes ?? 0} B`],
    ['Path notices', String(diagnostics.filter(isPathNotice).length)],
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

for (const named of B2_VIEWS) {
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
document
  .querySelector('#p3-b2-zoom-in')!
  .addEventListener('click', () => zoomAround(2, B2_SURFACE.width / 2, B2_SURFACE.height / 2));
document
  .querySelector('#p3-b2-zoom-out')!
  .addEventListener('click', () => zoomAround(0.5, B2_SURFACE.width / 2, B2_SURFACE.height / 2));
document.querySelector('#p3-b2-reset')!.addEventListener('click', () => setView(B2_VIEWS[0]!));
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
  /**
   * Resolves once frames stop being submitted: path meshes can take several prepares (one
   * isolation step per prepare), so a settled page has submitted every frame it will.
   */
  async settle() {
    await ready;
    let stable = 0;
    let previous = -1;
    for (let attempt = 0; attempt < 1200 && stable < 12; attempt += 1) {
      await nextAnimationFrame();
      const frames = backend.getStatistics().framesSubmitted;
      stable = frames > 0 && frames === previous ? stable + 1 : 0;
      previous = frames;
    }
    renderStatus();
    return api.snapshot();
  },
  snapshot() {
    return {
      view,
      statistics: backend.getStatistics(),
      pathMesh: service?.getPathMeshStatistics() ?? null,
      draws: lastDraws,
      diagnostics: diagnostics.slice(),
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

Object.assign(window, { __vectorStudioP3B2Strokes: api });
export type P3B2StrokesApi = typeof api;
