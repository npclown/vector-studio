import type { RendererHandle } from '@vector-studio/react';
import {
  E28_RASTER_CAP,
  isUniformScale,
  sizeBucket,
  snappedPlacement,
  textDeviceMap,
  type PrimitiveRendererService,
} from '@vector-studio/renderer-core';
import type { WebGpuBackend } from '@vector-studio/renderer-webgpu';
import type { HostGlyphRaster } from './renderer-options';

// M6c-U2 (MVP M6c contract, section 5, M6c-Q5 (a)): the next-host-local cluster probe, loaded
// only under `?test=1` (src/webgpu-renderer.ts and app/page.tsx import it dynamically). It has
// two halves:
// - `SceneRecorder` wraps the host's service and keeps the scene and camera it last accepted,
//   so `scene()` lists the projected text leaves as the renderer has them, in paint order, with
//   their world transforms and E28-K9 bounds in device px. It is pure and unit tested in Node.
// - `readCluster` draws one GPU cluster (section 6.1): a one-cluster scene built from the
//   projected leaf (same world transform, generation, `lang`, `fontList`, `size`, `x`, `y`,
//   black, opacity 1) over a white backdrop, through the probe's own `PrimitiveRendererService`
//   and `WebGpuBackend` with next-host's options (src/renderer-options.ts; no mesh ports, since
//   the probe draws text and one rectangle) and the host's glyph raster port, on a hidden canvas
//   of the host canvas's CSS size at its DPR under the host's last camera. The device map is then
//   the host's, so `o`'s fraction, `phaseX` and the vertical snap equal what the host draws. The
//   E10 capture is returned cropped to the cluster's K9 bound, with its E28-K3 placement and the
//   port's bitmap rectangle. The host's editor, scene and revisions are untouched. It follows
//   E28-U4's `readCluster` (apps/playground/src/e23-gradient-paint.ts) as a separate copy, since
//   page code cannot import from `tests/` and moving that hook into a package root would be a
//   shared-surface change.

// The scene contract's types, as the host's dependencies carry them (no `contracts` import).
type RendererSceneSynchronization = RendererHandle['renderer'];
type RenderSceneSnapshot = Parameters<RendererSceneSynchronization['replaceSnapshot']>[0];
type RenderChangeSet = Parameters<RendererSceneSynchronization['applyChanges']>[0];
type RenderNodeSnapshot = RenderSceneSnapshot['nodes'][number];
type RenderCamera = Parameters<RendererSceneSynchronization['setCamera']>[0];
type SceneAffine = RenderNodeSnapshot['transform'];
type SceneIdentity = RenderSceneSnapshot['identity'];
type GlyphRasterRequest = Parameters<HostGlyphRaster['rasterize']>[0];

/** A projected text leaf, as the renderer accepted it. */
export type TextLeaf = Extract<RenderNodeSnapshot, { kind: 'text' }>;

/** An axis-aligned box in device px of the canvas, edges inclusive of fractions. */
export type DeviceBox = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;

/** One text leaf of `scene()`. */
export type TextSceneLeaf = Readonly<{
  id: string;
  /** Its ancestors' transforms, then its own: page space. */
  world: SceneAffine;
  /**
   * The leaf and every ancestor are visible and its clip chain is not empty (P4: a zero-size
   * rect clip, a singular clipping container, or a mask source that fills nothing hides it, as
   * `PrimitiveSceneSource` does); opacity is not considered.
   */
  shown: boolean;
  leaf: TextLeaf;
  /** Union of the E28-K9 bounds of every cluster drawn (device size ≥ 0.5), in device px. */
  bounds: DeviceBox | null;
  /** The same union over clusters whose text is not white space only: where ink may be. */
  inkBounds: DeviceBox | null;
}>;

/** `window.__p5Host.text.scene()`: the text leaves the host's renderer last accepted. */
export type TextScene = Readonly<{
  identity: SceneIdentity;
  revision: number;
  /** The camera the renderer last accepted; null before the first. */
  camera: RenderCamera | null;
  devicePixelRatio: number;
  /** In paint order. */
  leaves: readonly TextSceneLeaf[];
}>;

/** One cluster's E28-K1 to K3 placement (the playground's `E28Placement`, plus `index`). */
export type ClusterPlacement = Readonly<{
  nodeId: string;
  run: number;
  /** Within its run. */
  cluster: number;
  /** Across the leaf's runs, in text order: the `index` of `readCluster(id, index)`. */
  index: number;
  text: string;
  fontList: string;
  lang: string;
  size: number;
  /** The device pen origin `o`, unquantized. */
  origin: readonly [number, number];
  deviceSize: number;
  bucket: number;
  phaseX: number;
  /** `omitted`: below 0.5 device px, E28 draws nothing. */
  mode: 'snapped' | 'general' | 'omitted';
  /** Snapped: the device pixel corner `P` of the pen point. */
  corner: readonly [number, number] | null;
  /** The device map `M`: the world transform, then the camera and DPR. */
  map: SceneAffine;
  /** The cluster's E28-K9 bound in device px. */
  bound: DeviceBox;
}>;

const multiplyAffine = (left: SceneAffine, right: SceneAffine): SceneAffine => [
  left[0] * right[0] + left[2] * right[1],
  left[1] * right[0] + left[3] * right[1],
  left[0] * right[2] + left[2] * right[3],
  left[1] * right[2] + left[3] * right[3],
  left[0] * right[4] + left[2] * right[5] + left[4],
  left[1] * right[4] + left[3] * right[5] + left[5],
];

function union(a: DeviceBox | null, b: DeviceBox): DeviceBox {
  if (a === null) return b;
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

/** E28-K9: the cluster's local bound mapped by `map`, as an axis-aligned device box. */
export function clusterDeviceBound(
  map: SceneAffine,
  cluster: Readonly<{ x: number; y: number; advance: number }>,
  size: number,
): DeviceBox {
  const left = cluster.x + Math.min(cluster.advance, 0) - size;
  const right = cluster.x + Math.max(cluster.advance, 0) + size;
  const top = cluster.y - 2 * size;
  const bottom = cluster.y + size;
  const [a, b, c, d, e, f] = map;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ] as const) {
    xs.push(a * x + c * y + e);
    ys.push(b * x + d * y + f);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Every cluster of a leaf in text order, placed by E28-K1 to K3 at a camera and DPR. */
export function clusterPlacements(
  entry: Readonly<{ world: SceneAffine; leaf: TextLeaf }>,
  camera: RenderCamera,
  devicePixelRatio: number,
): ClusterPlacement[] {
  const { leaf } = entry;
  const map = textDeviceMap(entry.world, camera, devicePixelRatio);
  const [a, b, c, d, e, f] = map;
  const sigma = Math.sqrt(Math.abs(a * d - b * c));
  const uniform = isUniformScale(map, sigma);
  const out: ClusterPlacement[] = [];
  leaf.runs.forEach((run, runIndex) => {
    const deviceSize = run.size * sigma;
    const drawn = deviceSize >= 0.5;
    const bucket = sizeBucket(deviceSize);
    const snapped = drawn && uniform && deviceSize <= E28_RASTER_CAP;
    run.clusters.forEach((cluster, clusterIndex) => {
      const ox = a * cluster.x + c * cluster.y + e;
      const oy = b * cluster.x + d * cluster.y + f;
      const snap = snapped ? snappedPlacement(ox, oy) : null;
      out.push({
        nodeId: leaf.id,
        run: runIndex,
        cluster: clusterIndex,
        index: out.length,
        text: cluster.text,
        fontList: run.fontList,
        lang: leaf.lang,
        size: run.size,
        origin: [ox, oy],
        deviceSize,
        bucket,
        phaseX: snap?.phaseX ?? 0,
        mode: !drawn ? 'omitted' : snapped ? 'snapped' : 'general',
        corner: snap === null ? null : [snap.px, snap.py],
        map,
        bound: clusterDeviceBound(map, cluster, run.size),
      });
    });
  });
  return out;
}

/**
 * Keeps the scene and camera a renderer accepted: `wrap` returns the renderer with
 * `replaceSnapshot`, `applyChanges` and `setCamera` recorded after an `applied` result (a
 * rejected or replayed set leaves the record as it was), applying a change set as
 * `RetainedSceneMirror` does.
 */
export class SceneRecorder {
  #identity: SceneIdentity | null = null;
  #revision = 0;
  #nodes = new Map<string, RenderNodeSnapshot>();
  #rootOrder: readonly string[] = [];
  #camera: RenderCamera | null = null;

  wrap<T extends RendererSceneSynchronization>(renderer: T): T {
    return new Proxy(renderer, {
      get: (object, key) => {
        if (key === 'replaceSnapshot') {
          return (snapshot: RenderSceneSnapshot) => {
            const result = object.replaceSnapshot(snapshot);
            if (result.status === 'applied') this.recordSnapshot(snapshot);
            return result;
          };
        }
        if (key === 'applyChanges') {
          return (changes: RenderChangeSet) => {
            const result = object.applyChanges(changes);
            if (result.status === 'applied') this.recordChanges(changes);
            return result;
          };
        }
        if (key === 'setCamera') {
          return (camera: RenderCamera) => {
            const result = object.setCamera(camera);
            if (result.status === 'applied' || result.status === 'unchanged') {
              this.#camera = result.current.camera;
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(object, key, object);
        return typeof value === 'function' ? (value as () => unknown).bind(object) : value;
      },
    });
  }

  /** The last accepted camera, null before the first. */
  get camera(): RenderCamera | null {
    return this.#camera;
  }

  recordSnapshot(snapshot: RenderSceneSnapshot): void {
    this.#identity = snapshot.identity;
    this.#revision = snapshot.revision;
    this.#nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    this.#rootOrder = snapshot.rootOrder;
  }

  recordChanges(changes: RenderChangeSet): void {
    this.#identity = changes.identity;
    this.#revision = changes.revision;
    for (const id of changes.removed) this.#nodes.delete(id);
    for (const node of changes.inserted) this.#nodes.set(node.id, node);
    for (const node of changes.updated) this.#nodes.set(node.id, node);
    for (const order of changes.orders) {
      if (order.parentId === null) {
        this.#rootOrder = order.children;
      } else {
        const parent = this.#nodes.get(order.parentId);
        if (parent?.kind === 'container') {
          this.#nodes.set(parent.id, { ...parent, children: order.children });
        }
      }
    }
  }

  /** The text leaves in paint order; null before the first accepted snapshot. */
  textScene(devicePixelRatio: number): TextScene | null {
    if (this.#identity === null) return null;
    const leaves: TextSceneLeaf[] = [];
    const camera = this.#camera;
    const visit = (id: string, parent: SceneAffine | null, shown: boolean) => {
      const node = this.#nodes.get(id);
      if (node === undefined) return;
      const world = parent === null ? node.transform : multiplyAffine(parent, node.transform);
      const visible = shown && node.visible;
      if (node.kind === 'container') {
        const source =
          node.children[0] === undefined ? undefined : this.#nodes.get(node.children[0]);
        const empty = clipIsEmpty(node, world, source);
        for (const child of node.children) visit(child, world, visible && !empty);
        return;
      }
      if (node.kind !== 'text') return;
      let bounds: DeviceBox | null = null;
      let inkBounds: DeviceBox | null = null;
      if (camera !== null) {
        for (const placement of clusterPlacements(
          { world, leaf: node },
          camera,
          devicePixelRatio,
        )) {
          if (placement.mode === 'omitted') continue;
          bounds = union(bounds, placement.bound);
          if (placement.text.trim().length > 0) inkBounds = union(inkBounds, placement.bound);
        }
      }
      leaves.push({ id, world, shown: visible, leaf: node, bounds, inkBounds });
    };
    for (const id of this.#rootOrder) visit(id, null, true);
    return {
      identity: this.#identity,
      revision: this.#revision,
      camera,
      devicePixelRatio,
      leaves,
    };
  }
}

const singular = (m: SceneAffine) => m[0] * m[3] - m[1] * m[2] === 0;

/**
 * P4's structural empty clip (renderer-core `extendClipChain`, `maskSourceBounds`): a rect clip
 * of zero size or under a singular affine, or a mask whose source fills nothing. Null clip: false.
 */
export function clipIsEmpty(
  container: Extract<RenderNodeSnapshot, { kind: 'container' }>,
  world: SceneAffine,
  source: RenderNodeSnapshot | undefined,
): boolean {
  const clip = container.clip;
  if (clip === null) return false;
  if (singular(world)) return true;
  if (clip.kind === 'rect') return clip.width === 0 || clip.height === 0;
  if (source === undefined || source.kind === 'container' || source.kind === 'text') return true;
  if (singular(multiplyAffine(world, source.transform))) return true;
  if (source.kind === 'path') return source.geometry.points.length === 0;
  if (source.geometry.kind === 'line') return true;
  return source.geometry.width === 0 || source.geometry.height === 0;
}

/** A device px rectangle. */
export type DeviceRect = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * E28-K3, snapped: the device rectangle the port's bitmap for `placement` covers, the record's
 * `(P.x − left, P.y − top, width, height)`; null for a general or omitted cluster and for an
 * empty or failed raster.
 */
export function bitmapRect(
  placement: ClusterPlacement,
  glyphRaster: HostGlyphRaster,
): DeviceRect | null {
  if (placement.corner === null) return null;
  const bitmap = glyphRaster.rasterize({
    text: placement.text,
    fontList: placement.fontList,
    lang: placement.lang,
    pixelSize: placement.bucket,
    phaseX: placement.phaseX as GlyphRasterRequest['phaseX'],
  });
  if (bitmap.status !== 'ok') return null;
  return {
    x: placement.corner[0] - bitmap.left,
    y: placement.corner[1] - bitmap.top,
    width: bitmap.width,
    height: bitmap.height,
  };
}

export const PROBE_BACKDROP_ID = 'm6c-probe-backdrop';
export const PROBE_CLUSTER_ID = 'm6c-probe-cluster';

/**
 * Section 6.1's GPU side: a scene of one cluster of `entry` (its world transform, generation,
 * `lang`, run `fontList` and `size`, the cluster's `x`, `y` and `advance`, black, opacity 1) over
 * an opaque white rectangle that covers the canvas at `camera`.
 */
export function clusterScene(
  entry: Readonly<{ world: SceneAffine; leaf: TextLeaf }>,
  placement: Pick<ClusterPlacement, 'run' | 'cluster'>,
  camera: RenderCamera,
  cssSize: Readonly<{ width: number; height: number }>,
  revision: number,
): RenderSceneSnapshot {
  const run = entry.leaf.runs[placement.run]!;
  const cluster = run.clusters[placement.cluster]!;
  const { position, zoom } = camera;
  return {
    identity: { documentId: 'm6c-text-probe', pageId: 'probe' },
    revision,
    nodes: [
      {
        id: PROBE_BACKDROP_ID,
        parentId: null,
        transform: [1, 0, 0, 1, position.x, position.y],
        visible: true,
        opacity: 1,
        kind: 'primitive',
        geometry: {
          kind: 'rectangle',
          width: cssSize.width / zoom,
          height: cssSize.height / zoom,
          cornerRadii: [0, 0, 0, 0],
        },
        style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke: null },
      },
      {
        id: PROBE_CLUSTER_ID,
        parentId: null,
        transform: entry.world,
        visible: true,
        opacity: 1,
        kind: 'text',
        generation: entry.leaf.generation,
        lang: entry.leaf.lang,
        runs: [
          {
            fontList: run.fontList,
            size: run.size,
            color: { r: 0, g: 0, b: 0, a: 1 },
            clusters: [
              { text: cluster.text, x: cluster.x, y: cluster.y, advance: cluster.advance },
            ],
          },
        ],
      },
    ],
    rootOrder: [PROBE_BACKDROP_ID, PROBE_CLUSTER_ID],
  };
}

/** A crop of an RGBA frame (rows top first), in whole device px. */
export type FrameCrop = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
  rgbaBase64: string;
}>;

/** The whole device pixels that `box`, padded by `pad`, touches, clamped to the frame. */
export function cropRect(
  box: DeviceBox,
  pad: number,
  frame: Readonly<{ width: number; height: number }>,
): Readonly<{ x: number; y: number; width: number; height: number }> {
  const x = Math.max(0, Math.floor(box.x0 - pad));
  const y = Math.max(0, Math.floor(box.y0 - pad));
  const x1 = Math.min(frame.width, Math.ceil(box.x1 + pad));
  const y1 = Math.min(frame.height, Math.ceil(box.y1 + pad));
  return { x, y, width: Math.max(0, x1 - x), height: Math.max(0, y1 - y) };
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(text);
}

export function cropFrame(
  frame: Readonly<{ width: number; height: number; rgba: Uint8Array }>,
  rect: Readonly<{ x: number; y: number; width: number; height: number }>,
): FrameCrop {
  const rgba = new Uint8Array(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row += 1) {
    const start = ((rect.y + row) * frame.width + rect.x) * 4;
    rgba.set(frame.rgba.subarray(start, start + rect.width * 4), row * rect.width * 4);
  }
  return { ...rect, rgbaBase64: base64(rgba) };
}

/** What the host hands the probe when its renderer is created under `?test=1`. */
export type TextProbeHost = Readonly<{
  recorder: SceneRecorder;
  /** The host canvas's CSS size and DPR, as the host backend was initialized. */
  size: Readonly<{ width: number; height: number; devicePixelRatio: number }>;
  /** The host's glyph raster port. */
  glyphRaster: HostGlyphRaster;
  /** A backend with the E10 frame capture. */
  createBackend(): WebGpuBackend;
  /** A service on `backend` with next-host's options (src/renderer-options.ts). */
  createService(backend: WebGpuBackend): PrimitiveRendererService;
}>;

/** `window.__p5Host.text.readCluster(id, index)`. */
export type ClusterRead = Readonly<{
  /** The probe service's result for the one-cluster scene. */
  status: string;
  placement: ClusterPlacement;
  /** Snapped clusters: the port's bitmap rectangle in device px, null for none or general. */
  rect: DeviceRect | null;
  frame: Readonly<{ width: number; height: number; devicePixelRatio: number }>;
  /** The capture over the cluster's K9 bound padded by 2 device px. */
  crop: FrameCrop;
  /** The probe service's counters after the draw. */
  counters: Readonly<{ glyphRasterCalls: number; glyphUploads: number }>;
}>;

type Drawing = Readonly<{
  canvas: HTMLCanvasElement;
  backend: WebGpuBackend;
  service: PrimitiveRendererService;
  dispose(): void;
}>;

/** The registered host; `drawing` is created on the first `readCluster`. */
let current: { readonly host: TextProbeHost; drawing: Promise<Drawing> | null } | null = null;
let revision = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Registers the host's renderer; the returned release disposes the probe's own resources. */
export function attachTextProbe(host: TextProbeHost): () => void {
  const entry = { host, drawing: null as Promise<Drawing> | null };
  current = entry;
  return () => {
    if (current === entry) current = null;
    void entry.drawing?.then((drawing) => drawing.dispose()).catch(() => {});
  };
}

/** The text leaves the host's renderer last accepted; null without a renderer or a scene. */
export function textScene(): TextScene | null {
  if (current === null) return null;
  return current.host.recorder.textScene(current.host.size.devicePixelRatio);
}

/** The host canvas's CSS size and DPR, as the host backend was initialized; null without one. */
export function probeHostSize(): TextProbeHost['size'] | null {
  return current?.host.size ?? null;
}

/** One cluster of `clusterRects(id)`. */
export type ClusterRect = Readonly<{ index: number; text: string; rect: DeviceRect | null }>;

/**
 * Every cluster of the projected leaf `id` with its port bitmap rectangle at the host's camera
 * and DPR (`bitmapRect`), so a spec can judge ink per cluster in the host's own frame.
 */
export function clusterRects(id: string): readonly ClusterRect[] {
  if (current === null) throw new Error('The cluster probe has no host renderer.');
  const { host } = current;
  const scene = host.recorder.textScene(host.size.devicePixelRatio);
  const leaf = scene?.leaves.find((value) => value.id === id);
  if (scene === null || leaf === undefined) throw new Error(`No projected text leaf ${id}.`);
  if (scene.camera === null) throw new Error('The host renderer has no camera yet.');
  return clusterPlacements(leaf, scene.camera, host.size.devicePixelRatio).map((placement) => ({
    index: placement.index,
    text: placement.text,
    rect: bitmapRect(placement, host.glyphRaster),
  }));
}

const nextAnimationFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function createDrawing(host: TextProbeHost): Promise<Drawing> {
  const canvas = document.createElement('canvas');
  // Hidden and out of the page's flow, never under a pointer.
  canvas.style.cssText =
    'position: fixed; left: 0; top: 0; visibility: hidden; pointer-events: none;' +
    ` width: ${host.size.width}px; height: ${host.size.height}px`;
  canvas.dataset.testid = 'm6c-text-probe';
  document.body.append(canvas);
  const backend = host.createBackend();
  const service = host.createService(backend);
  const source = backend.attachPrimitiveFrameSource(service);
  const dispose = () => {
    source.dispose();
    service.dispose();
    backend.dispose();
    canvas.remove();
  };
  try {
    const capability = await backend.initialize({
      canvas,
      cssSize: { width: host.size.width, height: host.size.height },
      devicePixelRatio: host.size.devicePixelRatio,
    });
    if (!capability.supported) {
      throw new Error(`WebGPU is not available: ${capability.diagnostic.message}`);
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { canvas, backend, service, dispose };
}

/** Invalidates and waits until the backend has submitted a new frame. */
async function submitted(backend: WebGpuBackend): Promise<void> {
  const before = backend.getStatistics().framesSubmitted;
  backend.invalidate({ reason: 'scene' });
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await nextAnimationFrame();
    if (backend.getStatistics().framesSubmitted > before) return;
  }
  throw new Error('The probe backend submitted no frame in 600 animation frames.');
}

/**
 * Draws cluster `index` (text order across runs) of the projected leaf `id` alone, as section
 * 6.1's GPU side, and returns its placement and the capture around it. Calls run one at a time.
 */
export function readCluster(id: string, index: number): Promise<ClusterRead> {
  const run = queue.then(() => draw(id, index));
  queue = run.catch(() => {});
  return run;
}

async function draw(id: string, index: number): Promise<ClusterRead> {
  const entry = current;
  if (entry === null) throw new Error('The cluster probe has no host renderer.');
  const { host } = entry;
  const scene = host.recorder.textScene(host.size.devicePixelRatio);
  const leaf = scene?.leaves.find((value) => value.id === id);
  if (scene === null || leaf === undefined) throw new Error(`No projected text leaf ${id}.`);
  if (scene.camera === null) throw new Error('The host renderer has no camera yet.');
  const camera = scene.camera;
  const placement = clusterPlacements(leaf, camera, host.size.devicePixelRatio)[index];
  if (placement === undefined) throw new Error(`Leaf ${id} has no cluster ${index}.`);
  entry.drawing ??= createDrawing(host);
  const { backend, service } = await entry.drawing;
  revision += 1;
  const result = service.replaceSnapshot(
    clusterScene(leaf, placement, camera, host.size, revision),
  );
  const moved = service.setCamera(camera);
  if (moved.status !== 'applied' && moved.status !== 'unchanged') {
    throw new Error(`The probe camera was rejected: ${moved.status}`);
  }
  await submitted(backend);
  // Two frames for the raster budget to settle, then the next presented frame (E10).
  backend.invalidate({ reason: 'scene' });
  await nextAnimationFrame();
  await nextAnimationFrame();
  const frame = await backend.captureFrameForTesting({ timeoutMs: 30_000 });
  const rect = bitmapRect(placement, host.glyphRaster);
  return {
    status: result.status,
    placement,
    rect,
    frame: { width: frame.width, height: frame.height, devicePixelRatio: frame.devicePixelRatio },
    crop: cropFrame(frame, cropRect(placement.bound, 2, frame)),
    counters: {
      glyphRasterCalls: service.getGlyphRasterCallsForTesting(),
      glyphUploads: service.getGlyphUploadsForTesting(),
    },
  };
}
