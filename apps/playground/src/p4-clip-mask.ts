import type {
  RenderCamera,
  RendererDiagnostic,
  RendererStatistics,
  RenderSceneSnapshot,
  SceneApplyResult,
} from '@vector-studio/contracts';
import {
  createFillMeshPort,
  createStrokeMeshPort,
  type FillMeshAdapter,
  type StrokeMeshAdapter,
} from '@vector-studio/geometry-wasm';
import {
  PrimitiveRendererService,
  type PathMeshStatistics,
  type PrimitiveFrameSource,
  type PrimitivePacket,
} from '@vector-studio/renderer-core';
import { WebGpuBackend } from '@vector-studio/renderer-webgpu';

// P4 contract, unit U5 (docs/plans/p4-clip-mask.md, section 6): the headed check page of clips
// and masks. This page is a host: it injects the real fill-mesh port (`createFillMeshPort`) and
// the real stroke-mesh port (`createStrokeMeshPort`) from geometry-wasm, with `clips: 'all'`,
// as the P3 pages do. It sets the E10 test hooks from its query string (`samples=1|4`, `dpr`)
// and draws the scenes that tests/gpu/p4-clip-mask.spec.ts hands it; the spec owns the scenes,
// the CPU oracle and the checks. The frame source is wrapped only to summarize each packet's
// draws and clip part; packets pass through unchanged.

/** Served by the playground's Vite config from the local kernel build; see vite.config.mjs. */
const WASM_URL = '/__vector-studio/geometry-kernel.wasm';

const parameters = new URLSearchParams(window.location.search);
const samples = parameters.get('samples') === '1' ? 1 : 4;
const dpr = Number(parameters.get('dpr') ?? '1');
/** Physical size of the canvas at load; `resize` changes it. */
const PHYSICAL = Object.freeze({ width: 512, height: 320 });

export type P4PacketSummary = Readonly<{
  generation: number;
  /** Analytic draw runs (batches) in paint order, with their instance counts and clip states. */
  analytic: readonly Readonly<{ count: number; clipState: number }>[];
  /** Mesh draws in paint order: the analytic runs before each, and its clip state. */
  mesh: readonly Readonly<{ position: number; clipState: number; triangles: number }>[];
  clipStates: number;
  maskLevels: number;
  clipNotices: number;
}>;

export type P4Frame = Readonly<{
  width: number;
  height: number;
  sampleCount: number;
  devicePixelRatio: number;
  rgbaBase64: string;
  packet: P4PacketSummary | null;
}>;

export type P4Counters = Readonly<{
  statistics: RendererStatistics;
  maskPasses: number;
  clipStateWrites: number;
  pathMesh: PathMeshStatistics | null;
  overlayBuilds: number;
}>;

declare global {
  interface Window {
    __vectorStudioP4: P4ClipMaskApi;
  }
}

function summarize(packet: PrimitivePacket): P4PacketSummary {
  return {
    generation: packet.generation,
    analytic: packet.draws.map((draw) => ({ count: draw.count, clipState: draw.clipState ?? 0 })),
    mesh: (packet.mesh?.draws ?? []).map((draw) => ({
      position: draw.position,
      clipState: draw.clipState ?? 0,
      triangles: draw.triangleCount,
    })),
    clipStates: packet.clip?.states.length ?? 0,
    maskLevels: packet.clip?.masks.length ?? 0,
    clipNotices: packet.clipNotices?.length ?? 0,
  };
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
}

const nextAnimationFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

const canvas = document.createElement('canvas');
canvas.style.display = 'block';
document.body.append(canvas);
const diagnostics: RendererDiagnostic[] = [];
const backend = new WebGpuBackend({ sampleCountForTesting: samples, frameCaptureForTesting: true });
backend.subscribeDiagnostics((event) => diagnostics.push(event));
let service: PrimitiveRendererService | null = null;
let fillPort: FillMeshAdapter | null = null;
let strokePort: StrokeMeshAdapter | null = null;
let wasmSha256: string | null = null;
let lastPacket: P4PacketSummary | null = null;
let revision = 0;
let surface = { css: { width: PHYSICAL.width / dpr, height: PHYSICAL.height / dpr }, dpr };

async function start() {
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
  fillPort = await createFillMeshPort(bytes);
  strokePort = await createStrokeMeshPort(bytes);
  const fill = fillPort;
  const strokes = strokePort;
  const product = new PrimitiveRendererService(backend, {
    fillMesh: fill,
    fillMeshMemoryBytes: () => fill.linearMemoryBytes(),
    strokeMesh: strokes,
    strokeMeshMemoryBytes: () => strokes.linearMemoryBytes(),
    clips: 'all',
  });
  service = product;
  const source: PrimitiveFrameSource = {
    requiresMeshPipeline: product.requiresMeshPipeline,
    requiresClipPipeline: product.requiresClipPipeline,
    prepare(target) {
      const packet = product.prepare(target);
      if (packet !== null) lastPacket = summarize(packet);
      return packet;
    },
    acknowledge(receipt) {
      product.acknowledge(receipt);
    },
  };
  backend.attachPrimitiveFrameSource(source);
  canvas.style.width = `${surface.css.width}px`;
  canvas.style.height = `${surface.css.height}px`;
  const capability = await backend.initialize({
    canvas,
    cssSize: surface.css,
    devicePixelRatio: surface.dpr,
  });
  return {
    supported: capability.supported,
    reason: capability.supported ? null : capability.diagnostic.code,
    adapter: capability.supported ? { ...capability.capabilities.adapter } : {},
    wasmSha256,
    samples,
    dpr,
  };
}

const ready = start();

/** Captures the next frame after the current state has had two frames to settle. */
async function capture(): Promise<P4Frame> {
  backend.invalidate({ reason: 'scene' });
  await nextAnimationFrame();
  await nextAnimationFrame();
  // Generous: a software adapter can take seconds for a 2048 x 2048 frame with 20 masks.
  const frame = await backend.captureFrameForTesting({ timeoutMs: 30_000 });
  return {
    width: frame.width,
    height: frame.height,
    sampleCount: frame.sampleCount,
    devicePixelRatio: frame.devicePixelRatio,
    rgbaBase64: base64(frame.rgba),
    packet: lastPacket,
  };
}

function counters(): P4Counters {
  return {
    statistics: backend.getStatistics(),
    maskPasses: backend.getMaskPassesForTesting(),
    clipStateWrites: service!.getClipStateWritesForTesting(),
    pathMesh: service!.getPathMeshStatistics(),
    overlayBuilds: service!.getOverlayBuildCountForTesting(),
  };
}

function apply(snapshot: RenderSceneSnapshot, camera: RenderCamera): SceneApplyResult {
  revision += 1;
  const result = service!.replaceSnapshot({ ...snapshot, revision });
  const moved = service!.setCamera(camera);
  if (moved.status !== 'applied' && moved.status !== 'unchanged') {
    throw new Error(`Camera rejected: ${JSON.stringify(moved)}`);
  }
  return result;
}

const api = {
  ready,
  physical: PHYSICAL,
  /** Replaces the scene, sets the camera and captures a frame; a rejected scene still captures. */
  async render(snapshot: RenderSceneSnapshot, camera: RenderCamera) {
    await ready;
    const result = apply(snapshot, camera);
    const frame = await capture();
    return { status: result.status, result, frame, counters: counters() };
  },
  /** Applies the scene and camera and waits for a submitted frame, without a readback. */
  async show(snapshot: RenderSceneSnapshot, camera: RenderCamera) {
    await ready;
    const result = apply(snapshot, camera);
    const before = backend.getStatistics().framesSubmitted;
    backend.invalidate({ reason: 'scene' });
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await nextAnimationFrame();
      if (backend.getStatistics().framesSubmitted > before) break;
    }
    return { status: result.status, counters: counters(), packet: lastPacket };
  },
  /** Resizes the surface (CSS size and DPR) and captures a frame. */
  async resize(cssWidth: number, cssHeight: number, devicePixelRatio: number) {
    await ready;
    surface = { css: { width: cssWidth, height: cssHeight }, dpr: devicePixelRatio };
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    backend.resize(surface.css, devicePixelRatio);
    const frame = await capture();
    return { frame, counters: counters() };
  },
  /** Destroys the device and captures the first frame of the recovered generation. */
  async recover() {
    await ready;
    const generation = backend.getStatistics().generation;
    backend.destroyDeviceForTesting();
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      await nextAnimationFrame();
      if (backend.state === 'ready' && backend.getStatistics().generation > generation) break;
    }
    const frame = await capture();
    return { frame, counters: counters() };
  },
  /**
   * P4-A11 (observation only): applies the scene, then pans the camera by `step` world units
   * each frame for `frames` submitted frames and returns the backend's frame measurements.
   */
  async measure(
    snapshot: RenderSceneSnapshot,
    camera: RenderCamera,
    frames: number,
    step: Readonly<{ x: number; y: number }>,
  ) {
    await ready;
    apply(snapshot, camera);
    await capture();
    const passes = backend.getMaskPassesForTesting();
    backend.startFrameMeasurements();
    const first = backend.getStatistics().framesSubmitted;
    let submitted = first;
    for (let attempt = 0; submitted - first < frames && attempt < frames * 20; attempt += 1) {
      const moved = service!.setCamera({
        ...camera,
        position: {
          x: camera.position.x + step.x * (submitted - first + 1),
          y: camera.position.y + step.y * (submitted - first + 1),
        },
      });
      if (moved.status !== 'applied' && moved.status !== 'unchanged') {
        throw new Error(`Camera rejected: ${JSON.stringify(moved)}`);
      }
      await nextAnimationFrame();
      submitted = backend.getStatistics().framesSubmitted;
    }
    const measurements = backend.stopFrameMeasurements();
    return {
      measurements,
      framesSubmitted: submitted - first,
      maskPasses: backend.getMaskPassesForTesting() - passes,
      counters: counters(),
    };
  },
  counters() {
    return counters();
  },
  diagnostics() {
    return diagnostics.slice();
  },
  dispose() {
    service?.dispose();
    backend.dispose();
    fillPort?.dispose();
    strokePort?.dispose();
    return backend.getStatistics();
  },
};

window.__vectorStudioP4 = api;
export type P4ClipMaskApi = typeof api;
