import type {
  GlyphRasterPort,
  GlyphRasterRequest,
  GlyphRasterResult,
  RenderCamera,
  RenderNodeSnapshot,
  RendererDiagnostic,
  RendererStatistics,
  RenderSceneSnapshot,
  SceneAffine,
  SceneApplyResult,
} from '@vector-studio/contracts';
import {
  createFillMeshPort,
  createStrokeMeshPort,
  type FillMeshAdapter,
  type StrokeMeshAdapter,
} from '@vector-studio/geometry-wasm';
import {
  E28_RASTER_CAP,
  E28_RASTER_PER_FRAME,
  PrimitiveRendererService,
  isUniformScale,
  sizeBucket,
  snappedPlacement,
  textDeviceMap,
  type PathMeshStatistics,
  type PrimitiveFrameSource,
  type PrimitivePacket,
} from '@vector-studio/renderer-core';
import { WebGpuBackend, createCanvasGlyphRaster } from '@vector-studio/renderer-webgpu';

// E23 contract, unit U4 (docs/plans/d9-e23-gradient-paint-contract.md, section 6): the headed
// check page of gradient paints. Like the P4 page it hosts the real fill-mesh and stroke-mesh
// ports from geometry-wasm, with `clips: 'all'` and `paints: 'gradient'`, sets the E10 test
// hooks from its query string (`samples=1|4`, `dpr`) and draws the scenes that
// tests/gpu/e23-gradient-paint.spec.ts hands it; the spec owns the scenes, the CPU oracle and the
// checks. The frame source is wrapped only to summarize each packet's draws and paint part.
// E25 contract, unit U4: `groups=isolated` sets the service's `groups` option, `isolate=1` its
// `isolateUnitOpacityForTesting` hook and `tile=N` the backend's `layerTileSizeForTesting`;
// tests/gpu/e25-isolated-opacity.spec.ts uses them. Without them the page is as before.
// E28 contract, unit U3: `text=atlas` sets the service's `text` option with the canvas raster
// port, whose bitmaps `rasterize` returns; docs/evidence/e28/u3-swiftshader-captures.mjs uses it.
// E28 contract, unit U4: `raster=fake` swaps in a fake port whose pattern `setFakePattern`
// selects (T9), `pages=N` and `pagesize=S` set the service's atlas test options (T8), and
// `placements`, `readCluster` and `rasterCost` are the M6c hand-off and the raster-cost
// observation; tests/gpu/e28-text-atlas.spec.ts uses them.

/** Served by the playground's Vite config from the local kernel build; see vite.config.mjs. */
const WASM_URL = '/__vector-studio/geometry-kernel.wasm';

const parameters = new URLSearchParams(window.location.search);
const samples = parameters.get('samples') === '1' ? 1 : 4;
const groups = parameters.get('groups') === 'isolated' ? 'isolated' : 'flat';
const isolateUnit = parameters.get('isolate') === '1';
const tileParameter = parameters.get('tile');
const text = parameters.get('text') === 'atlas' ? 'atlas' : 'none';
const canvasRaster = createCanvasGlyphRaster();
const pagesParameter = parameters.get('pages');
const pageSizeParameter = parameters.get('pagesize');
/** E28 U4, T9: the fake port's pattern; 1 draws vertical stripes, 2 horizontal ones. */
let fakePattern = 1;
/** A 12 × 14 bitmap with a 2 px empty border and the pen corner at (2, 10). */
const fakeRaster: GlyphRasterPort = Object.freeze({
  portVersion: 0,
  operationId: 'e28-u4/fake-pattern',
  rasterize(request: GlyphRasterRequest): GlyphRasterResult {
    if (request.text.trim().length === 0) return { status: 'empty' };
    const width = 12;
    const height = 14;
    const coverage = new Uint8Array(width * height);
    for (let y = 2; y < height - 2; y += 1) {
      for (let x = 2; x < width - 2; x += 1) {
        const on = fakePattern === 1 ? x % 2 === 0 : y % 2 === 0;
        coverage[y * width + x] = on ? 255 : 64;
      }
    }
    return { status: 'ok', width, height, left: 2, top: 10, coverage };
  },
});
const glyphRaster = parameters.get('raster') === 'fake' ? fakeRaster : canvasRaster;
const dpr = Number(parameters.get('dpr') ?? '1');
/** CSS size of the canvas at load (the spec uses 512 × 320 at every DPR); `resize` changes it. */
const CSS_SIZE = Object.freeze({ width: 512, height: 320 });

export type E23PacketSummary = Readonly<{
  generation: number;
  /** Analytic draw runs (batches) in paint order, with their instance counts and clip states. */
  analytic: readonly Readonly<{ count: number; clipState: number; paint: boolean }>[];
  /** Mesh draws in paint order: the analytic runs before each, and its clip state. */
  mesh: readonly Readonly<{
    position: number;
    clipState: number;
    triangles: number;
    gradient: number;
    strokeGradient: number;
  }>[];
  /** The paint part: record count and records built this frame (E23-A05); null without one. */
  paint: Readonly<{ records: number; builds: number }> | null;
  clipStates: number;
  maskLevels: number;
  clipNotices: number;
  /** E25: the layers part, null without one. */
  layers: Readonly<{
    layers: readonly Readonly<{
      nodeId: string;
      opacity: number;
      bound: Readonly<{ x: number; y: number; width: number; height: number }>;
      parent: number;
      draws: number;
      meshDraws: number;
    }>[];
    composites: number;
    notices: readonly string[];
  }> | null;
  /** E28: the text part, null without one. */
  text: Readonly<{ pageCount: number; draws: number; instances: number }> | null;
}>;

export type E23Frame = Readonly<{
  width: number;
  height: number;
  sampleCount: number;
  devicePixelRatio: number;
  rgbaBase64: string;
  packet: E23PacketSummary | null;
}>;

export type E23Counters = Readonly<{
  statistics: RendererStatistics;
  maskPasses: number;
  clipStateWrites: number;
  pathMesh: PathMeshStatistics | null;
  overlayBuilds: number;
  /** E24 U3: dash expansions of the path-mesh pipeline (E24-A04). */
  dashExpansions: number;
  preparation: ReturnType<PrimitiveRendererService['getPreparationStatistics']>;
  /** E25: layer passes of the current generation so far, one per layer (section 4, Lifetime). */
  layerPasses: number;
  /** E28: glyph raster port calls and bitmaps uploaded by acknowledged packets. */
  glyphRasterCalls: number;
  glyphUploads: number;
  /** E28 U4: atlas pages evicted (E28-A06). */
  atlasEvictions: number;
}>;

/** E28 U4: one cluster's E28-K1 to K3 placement, for the oracle and the M6c hand-off. */
export type E28Placement = Readonly<{
  nodeId: string;
  run: number;
  cluster: number;
  text: string;
  fontList: string;
  lang: string;
  size: number;
  /** The device pen origin `o` and the device size `s`. */
  origin: readonly [number, number];
  deviceSize: number;
  bucket: number;
  phaseX: number;
  mode: 'snapped' | 'general';
  /** Snapped: the device pixel corner `P` of the pen point. */
  corner: readonly [number, number] | null;
  /** The device map `M` of the node: its world transform, then the camera. */
  map: SceneAffine;
  /** Straight run colour times the node's opacity. */
  color: Readonly<{ r: number; g: number; b: number; a: number }>;
}>;

declare global {
  interface Window {
    __vectorStudioE23: E23GradientPaintApi;
  }
}

function summarize(packet: PrimitivePacket): E23PacketSummary {
  return {
    generation: packet.generation,
    analytic: packet.draws.map((draw) => ({
      count: draw.count,
      clipState: draw.clipState ?? 0,
      paint: draw.paint === 'gradient',
    })),
    mesh: (packet.mesh?.draws ?? []).map((draw) => ({
      position: draw.position,
      clipState: draw.clipState ?? 0,
      triangles: draw.triangleCount,
      gradient: draw.gradient ?? 0,
      strokeGradient: draw.strokeGradient ?? 0,
    })),
    paint:
      packet.paint === undefined
        ? null
        : { records: packet.paint.records.length, builds: packet.paint.builds },
    clipStates: packet.clip?.states.length ?? 0,
    maskLevels: packet.clip?.masks.length ?? 0,
    clipNotices: packet.clipNotices?.length ?? 0,
    layers:
      packet.layers === undefined
        ? null
        : {
            layers: packet.layers.layers.map((layer) => ({
              nodeId: layer.nodeId,
              opacity: layer.opacity,
              bound: { ...layer.bound },
              parent: layer.parent,
              draws: layer.draws.length,
              meshDraws: layer.meshDraws.length,
            })),
            composites: packet.layers.composites.length,
            notices: packet.layers.notices.map((notice) => notice.nodeId),
          },
    text:
      packet.text === undefined
        ? null
        : {
            pageCount: packet.text.pageCount,
            draws: packet.text.draws.length,
            instances: packet.text.instances.length / 16,
          },
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
const backend = new WebGpuBackend({
  sampleCountForTesting: samples,
  frameCaptureForTesting: true,
  ...(tileParameter === null ? {} : { layerTileSizeForTesting: Number(tileParameter) }),
});
backend.subscribeDiagnostics((event) => diagnostics.push(event));
let service: PrimitiveRendererService | null = null;
let fillPort: FillMeshAdapter | null = null;
let strokePort: StrokeMeshAdapter | null = null;
let wasmSha256: string | null = null;
let lastPacket: E23PacketSummary | null = null;
let revision = 0;
let surface: { css: { width: number; height: number }; dpr: number } = {
  css: { ...CSS_SIZE },
  dpr,
};

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
    paints: 'gradient',
    groups,
    ...(isolateUnit ? { isolateUnitOpacityForTesting: true } : {}),
    ...(text === 'atlas' ? { text, glyphRaster } : {}),
    ...(pagesParameter === null ? {} : { textAtlasPagesForTesting: Number(pagesParameter) }),
    ...(pageSizeParameter === null
      ? {}
      : { textAtlasPageSizeForTesting: Number(pageSizeParameter) }),
  });
  service = product;
  const source: PrimitiveFrameSource = {
    requiresMeshPipeline: product.requiresMeshPipeline,
    requiresClipPipeline: product.requiresClipPipeline,
    requiresPaintPipeline: product.requiresPaintPipeline,
    requiresLayerPipeline: product.requiresLayerPipeline,
    requiresTextPipeline: product.requiresTextPipeline,
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
    groups,
    isolateUnit,
    tile: tileParameter === null ? null : Number(tileParameter),
    text,
  };
}

const ready = start();

/** Captures the next frame after the current state has had two frames to settle. */
async function capture(): Promise<E23Frame> {
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

function counters(): E23Counters {
  return {
    statistics: backend.getStatistics(),
    maskPasses: backend.getMaskPassesForTesting(),
    clipStateWrites: service!.getClipStateWritesForTesting(),
    pathMesh: service!.getPathMeshStatistics(),
    overlayBuilds: service!.getOverlayBuildCountForTesting(),
    dashExpansions: service!.getDashExpansionCountForTesting(),
    preparation: service!.getPreparationStatistics(),
    layerPasses: backend.getLayerPassesForTesting(),
    glyphRasterCalls: service!.getGlyphRasterCallsForTesting(),
    glyphUploads: service!.getGlyphUploadsForTesting(),
    atlasEvictions: service!.getAtlasEvictionsForTesting(),
  };
}

const multiplyAffine = (left: SceneAffine, right: SceneAffine): SceneAffine => [
  left[0] * right[0] + left[2] * right[1],
  left[1] * right[0] + left[3] * right[1],
  left[0] * right[2] + left[2] * right[3],
  left[1] * right[2] + left[3] * right[3],
  left[0] * right[4] + left[2] * right[5] + left[4],
  left[1] * right[4] + left[3] * right[5] + left[5],
];

/**
 * E28 U4: every cluster's placement by E28-K1 to K3, with the renderer-core helpers the plan
 * uses, at the current surface's DPR. Culling, the raster budget and fallbacks are not applied.
 */
function placements(snapshot: RenderSceneSnapshot, camera: RenderCamera): E28Placement[] {
  const byId = new Map(snapshot.nodes.map((item) => [item.id, item]));
  const world = (id: string): SceneAffine => {
    const item = byId.get(id)!;
    return item.parentId === null
      ? item.transform
      : multiplyAffine(world(item.parentId), item.transform);
  };
  const out: E28Placement[] = [];
  for (const item of snapshot.nodes) {
    if (item.kind !== 'text') continue;
    const map = textDeviceMap(world(item.id), camera, surface.dpr);
    const [a, b, c, d, e, f] = map;
    const sigma = Math.sqrt(Math.abs(a * d - b * c));
    const uniform = isUniformScale(map, sigma);
    item.runs.forEach((run, runIndex) => {
      const deviceSize = run.size * sigma;
      if (!(deviceSize >= 0.5)) return;
      const bucket = sizeBucket(deviceSize);
      const snapped = uniform && deviceSize <= E28_RASTER_CAP;
      run.clusters.forEach((cluster, clusterIndex) => {
        const ox = a * cluster.x + c * cluster.y + e;
        const oy = b * cluster.x + d * cluster.y + f;
        const snap = snapped ? snappedPlacement(ox, oy) : null;
        out.push({
          nodeId: item.id,
          run: runIndex,
          cluster: clusterIndex,
          text: cluster.text,
          fontList: run.fontList,
          lang: item.lang,
          size: run.size,
          origin: [ox, oy],
          deviceSize,
          bucket,
          phaseX: snap?.phaseX ?? 0,
          mode: snapped ? 'snapped' : 'general',
          corner: snap === null ? null : [snap.px, snap.py],
          map,
          color: { ...run.color, a: run.color.a * item.opacity },
        });
      });
    });
  }
  return out;
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

/** Invalidates and waits until the backend has submitted a new frame. */
async function submitted(): Promise<void> {
  const before = backend.getStatistics().framesSubmitted;
  backend.invalidate({ reason: 'scene' });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await nextAnimationFrame();
    if (backend.getStatistics().framesSubmitted > before) break;
  }
}

const api = {
  ready,
  css: CSS_SIZE,
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
    await submitted();
    return { status: result.status, counters: counters(), packet: lastPacket };
  },
  /**
   * E25 U4: applies a change set that updates `updated` (same ids, same parents and children)
   * and waits for a submitted frame, so that an edit keeps the scene's records.
   */
  async edit(identity: RenderSceneSnapshot['identity'], updated: readonly RenderNodeSnapshot[]) {
    await ready;
    revision += 1;
    const result = service!.applyChanges({
      identity,
      baseRevision: revision - 1,
      revision,
      inserted: [],
      updated,
      removed: [],
      orders: [],
    });
    // A rejected change set leaves the mirror at its revision.
    if (result.status !== 'applied') revision -= 1;
    await submitted();
    return { status: result.status, result, counters: counters(), packet: lastPacket };
  },
  /** Moves the camera only (the scene is kept) and waits for a submitted frame. */
  async pan(camera: RenderCamera) {
    await ready;
    const moved = service!.setCamera(camera);
    if (moved.status !== 'applied' && moved.status !== 'unchanged') {
      throw new Error(`Camera rejected: ${JSON.stringify(moved)}`);
    }
    await submitted();
    return { status: moved.status, counters: counters(), packet: lastPacket };
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
  /** E28 U3: the page port's bitmap for a request (U4: the fake one with `raster=fake`). */
  rasterize(request: GlyphRasterRequest) {
    const result = glyphRaster.rasterize(request);
    return result.status === 'ok' ? { ...result, coverage: base64(result.coverage) } : result;
  },
  /** E28 U4, T9: selects the fake port's pattern. */
  setFakePattern(pattern: 1 | 2) {
    fakePattern = pattern;
  },
  /** E28 U4: the E28-K1 to K3 placement of every cluster of a scene under a camera. */
  placements(snapshot: RenderSceneSnapshot, camera: RenderCamera) {
    return placements(snapshot, camera);
  },
  /**
   * E28 U4, the M6c hand-off: draws one cluster alone (white on the page's black) through the
   * atlas, after a frame that rasterizes it, and returns the frame with the cluster's placement
   * and the port's bitmap rectangle in device px (snapped clusters only).
   */
  async readCluster(
    cluster: Readonly<{
      text: string;
      fontList: string;
      lang: string;
      size: number;
      x: number;
      y: number;
      generation?: number;
    }>,
    camera: RenderCamera,
  ) {
    await ready;
    const snapshot: RenderSceneSnapshot = {
      identity: { documentId: 'e28-u4-read-cluster', pageId: 'page' },
      revision: 1,
      nodes: [
        {
          id: 'cluster',
          parentId: null,
          transform: [1, 0, 0, 1, 0, 0],
          visible: true,
          opacity: 1,
          kind: 'text',
          generation: cluster.generation ?? 1,
          lang: cluster.lang,
          runs: [
            {
              fontList: cluster.fontList,
              size: cluster.size,
              color: { r: 1, g: 1, b: 1, a: 1 },
              clusters: [
                { text: cluster.text, x: cluster.x, y: cluster.y, advance: cluster.size / 2 },
              ],
            },
          ],
        },
      ],
      rootOrder: ['cluster'],
    };
    const applied = apply(snapshot, camera);
    await submitted();
    const frame = await capture();
    const placement = placements(snapshot, camera)[0] ?? null;
    let rect: Readonly<{ x: number; y: number; width: number; height: number }> | null = null;
    if (placement?.corner != null) {
      const bitmap = glyphRaster.rasterize({
        text: cluster.text,
        fontList: cluster.fontList,
        lang: cluster.lang,
        pixelSize: placement.bucket,
        phaseX: placement.phaseX as GlyphRasterRequest['phaseX'],
      });
      if (bitmap.status === 'ok') {
        rect = {
          x: placement.corner[0] - bitmap.left,
          y: placement.corner[1] - bitmap.top,
          width: bitmap.width,
          height: bitmap.height,
        };
      }
    }
    return { status: applied.status, frame, placement, rect, counters: counters() };
  },
  /**
   * E28 U4, raster cost: times `repeat` passes over `requests` through the page's port, and
   * one frame's budget (`E28_RASTER_PER_FRAME`) of distinct requests built from them at new sizes.
   */
  rasterCost(requests: readonly GlyphRasterRequest[], repeat: number) {
    // The first pass meets each request once (cold); later passes repeat it (warm).
    const cold: number[] = [];
    const warm: number[] = [];
    for (let pass = 0; pass < repeat; pass += 1) {
      for (const request of requests) {
        const start = performance.now();
        glyphRaster.rasterize(request);
        (pass === 0 ? cold : warm).push(performance.now() - start);
      }
    }
    // One frame's budget of distinct requests at sizes not timed above: each base request steps up
    // by a quarter pixel per round.
    const frame: GlyphRasterRequest[] = [];
    const seen = new Set<string>();
    for (let index = 0; frame.length < E28_RASTER_PER_FRAME; index += 1) {
      const base = requests[index % requests.length]!;
      const request = {
        ...base,
        pixelSize: base.pixelSize + (1 + Math.floor(index / requests.length)) * 0.25,
      };
      const key = JSON.stringify([
        request.text,
        request.fontList,
        request.lang,
        request.pixelSize,
        request.phaseX,
      ]);
      if (seen.has(key)) continue;
      seen.add(key);
      frame.push(request);
    }
    const start = performance.now();
    for (const request of frame) glyphRaster.rasterize(request);
    const frameMs = performance.now() - start;
    const summary = (values: number[]) => {
      const sorted = [...values].sort((left, right) => left - right);
      const quantile = (q: number) =>
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
      return {
        calls: sorted.length,
        meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
        medianMs: quantile(0.5),
        p95Ms: quantile(0.95),
      };
    };
    return {
      cold: summary(cold),
      warm: summary(warm),
      frameDistinct: seen.size,
      frameCalls: E28_RASTER_PER_FRAME,
      frameMs,
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

window.__vectorStudioE23 = api;
export type E23GradientPaintApi = typeof api;
