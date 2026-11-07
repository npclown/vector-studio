import type {
  RenderCamera,
  RenderNodeSnapshot,
  RendererDiagnostic,
} from '@vector-studio/contracts';
import { createFillMeshPort, createStrokeMeshPort } from '@vector-studio/geometry-wasm';
import {
  PrimitiveRendererService,
  type PathDrawRecordForTesting,
} from '@vector-studio/renderer-core';
import { WebGpuBackend } from '@vector-studio/renderer-webgpu';

// E39 contract (docs/plans/d9-e39-gpu-stencil-path-contract.md), unit E39-U5, criterion E39-A6:
// the headed check page of stencil-then-cover paths. A test-only page, not a host: it sets the
// E10 test hooks from its query string (`samples=1|4`, `dpr`) and draws the scenes the spec hands
// it through the product path (the release WASM fill and stroke ports, PrimitiveRendererService
// and WebGpuBackend), returning the frame capture with the E10 count image (E39-R9). The spec
// (tests/gpu/e39-painted-once.spec.ts) checks the counts and colours in Node.

export type E39Scene = Readonly<{
  nodes: readonly RenderNodeSnapshot[];
  camera: RenderCamera;
}>;

export type E39RenderResult = Readonly<{
  width: number;
  height: number;
  sampleCount: number;
  devicePixelRatio: number;
  record: PathDrawRecordForTesting | null;
  diagnostics: readonly string[];
  rgbaBase64: string;
  counts: Readonly<{ samples: number; base64: string }>;
}>;

export type E39PaintedOnceApi = Readonly<{
  ready: Promise<Readonly<{ supported: boolean; reason: string | null }>>;
  /** Physical size of the canvas. */
  physical: Readonly<{ width: number; height: number }>;
  render(scene: E39Scene): Promise<E39RenderResult>;
}>;

declare global {
  interface Window {
    __vectorStudioE39: E39PaintedOnceApi;
  }
}

const WASM_URL = '/__vector-studio/geometry-kernel.wasm';
/** CSS size of the canvas; the physical size is this times the DPR. */
const VIEWPORT = Object.freeze({ width: 160, height: 120 });
const parameters = new URLSearchParams(window.location.search);
const samples = parameters.get('samples') === '1' ? 1 : 4;
const dpr = Number(parameters.get('dpr') ?? '1');
const physical = Object.freeze({ width: VIEWPORT.width * dpr, height: VIEWPORT.height * dpr });

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
}

const canvas = document.createElement('canvas');
canvas.style.width = `${VIEWPORT.width}px`;
canvas.style.height = `${VIEWPORT.height}px`;
document.body.append(canvas);
const diagnostics: RendererDiagnostic[] = [];
const backend = new WebGpuBackend({
  sampleCountForTesting: samples,
  frameCaptureForTesting: true,
  countPassForTesting: true,
});
backend.subscribeDiagnostics((event) => diagnostics.push(event));
let service: PrimitiveRendererService | null = null;
let revision = 0;

async function start() {
  const response = await fetch(WASM_URL, { cache: 'no-store' });
  if (!response.ok)
    throw new Error(
      `The geometry kernel WASM is not available at ${WASM_URL} (HTTP ${String(response.status)}).`,
    );
  const bytes = await response.arrayBuffer();
  service = new PrimitiveRendererService(backend, {
    fillMesh: await createFillMeshPort(bytes),
    strokeMesh: await createStrokeMeshPort(bytes),
    // The leak fixture's zero-alpha gradient needs gradient paints (E23).
    paints: 'gradient',
  });
  backend.attachPrimitiveFrameSource(service);
  const result = await backend.initialize({
    canvas,
    cssSize: { ...VIEWPORT },
    devicePixelRatio: dpr,
  });
  return {
    supported: result.supported,
    reason: result.supported ? null : result.diagnostic.code,
  } as const;
}

const ready = start();

async function render(scene: E39Scene): Promise<E39RenderResult> {
  if (service === null) throw new Error('e39: not ready');
  const from = diagnostics.length;
  revision += 1;
  const applied = service.replaceSnapshot({
    identity: { documentId: 'e39', pageId: 'page' },
    revision,
    nodes: scene.nodes,
    rootOrder: scene.nodes.filter((node) => node.parentId === null).map((node) => node.id),
  });
  if (applied.status !== 'applied') throw new Error(`e39: scene ${applied.status}`);
  service.setCamera(scene.camera);
  // Let the scene's own frame settle first, so the capture is of the settled scene.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const capture = await backend.captureFrameForTesting({ counts: true });
  return {
    width: capture.width,
    height: capture.height,
    sampleCount: capture.sampleCount,
    devicePixelRatio: capture.devicePixelRatio,
    record: service.getLastDrawRecordForTesting(),
    diagnostics: diagnostics.slice(from).map((event) => event.code),
    rgbaBase64: base64(capture.rgba),
    counts: {
      samples: capture.counts!.samples,
      base64: base64(new Uint8Array(capture.counts!.data.buffer)),
    },
  };
}

window.__vectorStudioE39 = Object.freeze({ ready, physical, render });
