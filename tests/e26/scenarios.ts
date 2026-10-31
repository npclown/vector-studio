// E26-U1a (E26 contract, section 3): the scenario definitions, the stress document, the fitted
// and typical-view cameras, the per-frame drivers and the configuration hash. Pure data and
// arithmetic: no renderer or browser runs here, so the headed harness (U1c) and the host's bench
// option (U1b) share one source of truth.
//
// Visibility is counted over drawn leaf scene nodes (primitives, paths and text that are visible
// with their whole ancestry and are not inside a mask source), from the renderer's conservative
// draw bounds, widened by its 2-physical-pixel cull guard, with clips ignored. Clip culling is
// counted separately (section 3.3: the edit drag moves the selection out of its frame's clip).
import { createHash } from 'node:crypto';
import type { RenderNodeSnapshot, SceneAffine } from '@vector-studio/contracts';
import { parseDocument } from '@vector-studio/model';
import { projectPage, type PageProjection } from '../../packages/editor-core/src/projector.js';
import {
  composeSceneAffine,
  getPathLocalPointBounds,
  getPathLocalStrokeBounds,
  getPrimitiveLocalStrokeBounds,
  getTextLocalBounds,
  transformSceneBounds,
  type SceneBounds,
} from '../../packages/renderer-core/src/scene-numeric.js';
import { generateM1A13Document, M1_A13_SEED } from '../m1-a13/document.js';

/** The CSS viewport of every E26 run (section 3.5); DPR varies per run, not per scenario. */
export const E26_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
/** The fitted camera's margin, a fraction of the viewport on each side (section 3.1). */
export const E26_FIT_MARGIN = 0.1;
/** The typical view's drawn leaf count (section 3.1, as P1 Scene 3): range and bisection aim. */
export const E26_TYPICAL_VISIBLE = Object.freeze({ min: 900, max: 1100, target: 1000 });
/** The typical view's top-left inset from the content, in CSS px: more than the drag's 60. */
export const E26_TYPICAL_INSET_CSS = 80;
/** The renderer's cull guard, in physical px (P1 measurement contract). */
export const E26_CULL_GUARD_PX = 2;
/** The drivers' constants (section 3.3); all of them enter the configuration hash. */
export const E26_DRIVERS = Object.freeze({
  /** P1's theta(t) = 2·pi·((t mod period) / period), t in ms from the common start. */
  thetaPeriodMs: 10_000,
  /** P1's warm-up and half-open measured window, in ms. */
  warmUpMs: 5_000,
  windowEndMs: 15_000,
  /** Edit drag p(t) = start + (dragX·sin θ, dragY·(cos θ − 1)) CSS px. */
  dragX: 40,
  dragY: 30,
  /** Pan: position F + pan·viewport·(sin θ, cos θ − 1); zoom F·(zoomBase + zoomSwing·cos θ). */
  pan: 0.05,
  zoomBase: 0.95,
  zoomSwing: 0.05,
  /** The latency drag's real input (section 3.3). */
  latencyCadenceMs: 8,
  latencyDurationMs: 4_000,
});
/** The stress scene's seed and LCG: P1's (P1 measurement contract). */
export const E26_STRESS = Object.freeze({
  seed: 0x5031_0001,
  multiplier: 1664525,
  increment: 1013904223,
  count: 10_000,
  columns: 100,
  rows: 100,
  origin: Object.freeze({ x: 180, y: 160 }),
  span: Object.freeze({ x: 900, y: 400 }),
});

export type E26Camera = Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>;

export type E26ScenarioId =
  | 'e26-mixed-view-edit-10k/v1'
  | 'e26-mixed-all-edit-10k/v1'
  | 'e26-mixed-all-pan-10k/v1'
  | 'e26-simple-stress-10k/v1'
  | 'e26-pointer-busy-10k/v1';

export type E26Scenario = Readonly<{
  id: E26ScenarioId;
  document: 'm1-a13' | 'stress';
  seed: number;
  camera: 'typical' | 'fitted';
  interaction: 'edit-drag' | 'pan-zoom' | 'latency-drag';
  /** `rafCallbackIntervalMs` ceiling, or null for the latency scenario (section 3.2). */
  frameCeilingMs: number | null;
  /** `pointerToWorkDoneMs` bound (exclusive), or null. */
  latencyBoundMs: number | null;
  renderMode: 'continuous' | 'on-demand';
  persist: boolean;
  /** The injected rejection, or null (section 3.4). */
  reject: Readonly<{ mode: 'once'; armedAtMs: number; target: 'moved-leaf' }> | null;
  /** The `setFill` before pointer down, in ms before it, or null. */
  setFillBeforeDownMs: number | null;
}>;

const frame = (
  id: E26ScenarioId,
  document: E26Scenario['document'],
  camera: E26Scenario['camera'],
  interaction: 'edit-drag' | 'pan-zoom',
  frameCeilingMs: number,
): E26Scenario =>
  Object.freeze({
    id,
    document,
    seed: document === 'm1-a13' ? M1_A13_SEED : E26_STRESS.seed,
    camera,
    interaction,
    frameCeilingMs,
    latencyBoundMs: null,
    renderMode: 'continuous',
    persist: false,
    reject: null,
    setFillBeforeDownMs: null,
  });

/** The five v1 scenarios of section 3.1, in its order. */
export const E26_SCENARIOS: readonly E26Scenario[] = Object.freeze([
  frame('e26-mixed-view-edit-10k/v1', 'm1-a13', 'typical', 'edit-drag', 16.7),
  frame('e26-mixed-all-edit-10k/v1', 'm1-a13', 'fitted', 'edit-drag', 33.3),
  frame('e26-mixed-all-pan-10k/v1', 'm1-a13', 'fitted', 'pan-zoom', 33.3),
  frame('e26-simple-stress-10k/v1', 'stress', 'fitted', 'pan-zoom', 33.3),
  Object.freeze({
    id: 'e26-pointer-busy-10k/v1',
    document: 'm1-a13',
    seed: M1_A13_SEED,
    camera: 'typical',
    interaction: 'latency-drag',
    frameCeilingMs: null,
    latencyBoundMs: 50,
    renderMode: 'on-demand',
    persist: true,
    reject: Object.freeze({ mode: 'once', armedAtMs: 1_000, target: 'moved-leaf' }),
    setFillBeforeDownMs: 100,
  } satisfies E26Scenario),
]);

// ---------------------------------------------------------------------------------------------
// The stress document (section 3.1): P1's positions, sizes and seed, reduced styles.

/** P1's unsigned word u of node i. */
function p1Word(i: number): number {
  return (
    (Math.imul(E26_STRESS.multiplier, (E26_STRESS.seed ^ i) >>> 0) + E26_STRESS.increment) >>> 0
  );
}

/** P1's qj = ((u >>> 8j) & 255) / 255. */
export function p1Q(i: number, j: 0 | 1 | 2 | 3): number {
  return ((p1Word(i) >>> (8 * j)) & 255) / 255;
}

/** P1's `p1-pan-zoom-10k/v1` centre of node i: a 100 × 100 grid over 900 × 400, jitter ±1. */
export function stressCenter(i: number): { x: number; y: number } {
  const { columns, rows, origin, span } = E26_STRESS;
  return {
    x: origin.x + (span.x * (i % columns)) / (columns - 1) + 2 * p1Q(i, 0) - 1,
    y: origin.y + (span.y * Math.floor(i / columns)) / (rows - 1) + 2 * p1Q(i, 1) - 1,
  };
}

/** P1's fill colour of node i: `0.2 + 0.6·qj` per channel, alpha `0.45 + 0.4·q3`. */
export function stressFill(i: number) {
  return {
    r: 0.2 + 0.6 * p1Q(i, 0),
    g: 0.2 + 0.6 * p1Q(i, 1),
    b: 0.2 + 0.6 * p1Q(i, 2),
    a: 0.45 + 0.4 * p1Q(i, 3),
  };
}

/**
 * The 10,000-node stress document, generated as a schema-v2 document and migrated to the current
 * version on load, as M1-A13 is; the configuration records the loaded version and a digest of
 * the generated document. Node i keeps P1's centre, size, opacity `0.5 + 0.25·(i % 3)` and fill
 * formula; P1's lines (`i % 4 = 3`, which have no fill in P1) become 3.5 × 1 rectangles on the
 * line with that fill formula; no node has a stroke.
 */
export function generateStressDocument() {
  const nodes: Record<string, Record<string, unknown>> = {};
  const children: string[] = [];
  for (let i = 0; i < E26_STRESS.count; i += 1) {
    const id = `s${String(i).padStart(5, '0')}`;
    const { x, y } = stressCenter(i);
    const kind = i % 4;
    const [width, height] = kind === 1 ? [3, 3] : kind === 3 ? [3.5, 1] : [3, 2];
    nodes[id] = {
      id,
      name: id,
      parent: 'stress-page',
      frame: { x: x - width / 2, y: y - height / 2, width, height },
      rotation: 0,
      constraints: { horizontal: 'start', vertical: 'start' },
      opacity: 0.5 + 0.25 * (i % 3),
      visible: true,
      ...(kind === 2
        ? { type: 'ellipse' }
        : { type: 'rectangle', cornerRadii: kind === 1 ? [0.5, 1, 0.5, 1] : [0, 0, 0, 0] }),
      fill: stressFill(i),
      stroke: null,
    };
    children.push(id);
  }
  return {
    schemaVersion: 2 as const,
    id: 'e26-stress',
    pages: [{ id: 'stress-page', name: 'Stress', children }],
    nodes,
  };
}

// ---------------------------------------------------------------------------------------------
// World bounds, drawn leaves, the fitted camera and the typical view.

/** The world transform of every scene node. */
export function worldTransforms(
  nodes: ReadonlyMap<string, RenderNodeSnapshot>,
): Map<string, SceneAffine> {
  const world = new Map<string, SceneAffine>();
  const of = (node: RenderNodeSnapshot): SceneAffine => {
    const known = world.get(node.id);
    if (known !== undefined) return known;
    const parent: SceneAffine =
      node.parentId === null ? [1, 0, 0, 1, 0, 0] : of(nodes.get(node.parentId)!);
    const own = composeSceneAffine(parent, node.transform);
    if (own === null) throw new Error(`non-finite world transform at ${node.id}`);
    world.set(node.id, own);
    return own;
  };
  for (const node of nodes.values()) of(node);
  return world;
}

/**
 * Whether the renderer draws a leaf: it and every ancestor are visible, no container on the way
 * has opacity 0, and no ancestor is a mask source (the first child of a mask container), which feeds coverage instead.
 */
function drawn(nodes: ReadonlyMap<string, RenderNodeSnapshot>, node: RenderNodeSnapshot): boolean {
  let cursor: RenderNodeSnapshot | undefined = node;
  while (cursor !== undefined) {
    if (!cursor.visible) return false;
    // E25-K3: a container with opacity 0 hides its whole subtree.
    if (cursor.kind === 'container' && cursor.opacity === 0) return false;
    if (cursor.parentId === null) return true;
    const parent: RenderNodeSnapshot = nodes.get(cursor.parentId)!;
    if (parent.kind === 'container' && parent.clip?.kind === 'mask') {
      if (parent.children[0] === cursor.id) return false;
    }
    cursor = parent;
  }
  return true;
}

/**
 * The world draw bounds of every drawn leaf, by scene ID: the renderer's conservative bounds
 * (stroke-inclusive for primitives, the stroke box or else the point box for paths, which always
 * contains it, and the E28-K9 bound for text); null for a drawn leaf without bounds.
 */
export function leafWorldBounds(
  nodes: ReadonlyMap<string, RenderNodeSnapshot>,
): Map<string, SceneBounds | null> {
  const world = worldTransforms(nodes);
  const result = new Map<string, SceneBounds | null>();
  for (const node of nodes.values()) {
    let local: SceneBounds | null | undefined;
    if (node.kind === 'primitive') local = getPrimitiveLocalStrokeBounds(node);
    else if (node.kind === 'path') {
      local =
        getPathLocalStrokeBounds(node.geometry.points, node.style.stroke) ??
        getPathLocalPointBounds(node.geometry.points);
    } else if (node.kind === 'text') local = getTextLocalBounds(node);
    else continue;
    if (!drawn(nodes, node)) continue;
    result.set(node.id, local == null ? null : transformSceneBounds(local, world.get(node.id)!));
  }
  return result;
}

function union(a: SceneBounds, b: SceneBounds): SceneBounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** The union of all drawn leaf bounds. */
export function contentBounds(bounds: ReadonlyMap<string, SceneBounds | null>): SceneBounds {
  let all: SceneBounds | null = null;
  for (const box of bounds.values()) if (box !== null) all = all === null ? box : union(all, box);
  if (all === null) throw new Error('no leaf has bounds');
  return all;
}

/** The camera's viewport in world units (the camera position is its top-left corner). */
export function worldViewport(camera: E26Camera): SceneBounds {
  return {
    minX: camera.position.x,
    minY: camera.position.y,
    maxX: camera.position.x + E26_VIEWPORT.width / camera.zoom,
    maxY: camera.position.y + E26_VIEWPORT.height / camera.zoom,
  };
}

const intersects = (a: SceneBounds, b: SceneBounds) =>
  a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY;
export const contains = (outer: SceneBounds, inner: SceneBounds) =>
  inner.minX >= outer.minX &&
  inner.maxX <= outer.maxX &&
  inner.minY >= outer.minY &&
  inner.maxY <= outer.maxY;

/**
 * Drawn leaves whose guarded bounds meet the viewport (the renderer's viewport cull keeps
 * them), and drawn leaves wholly inside the unguarded viewport.
 */
export function visibility(
  bounds: ReadonlyMap<string, SceneBounds | null>,
  camera: E26Camera,
  devicePixelRatio = 1,
): { visible: number; inside: number; leaves: number } {
  const view = worldViewport(camera);
  const guard = E26_CULL_GUARD_PX / (camera.zoom * devicePixelRatio);
  let visible = 0;
  let within = 0;
  let leaves = 0;
  for (const box of bounds.values()) {
    if (box === null) continue;
    leaves += 1;
    const guarded = {
      minX: box.minX - guard,
      minY: box.minY - guard,
      maxX: box.maxX + guard,
      maxY: box.maxY + guard,
    };
    if (intersects(guarded, view)) visible += 1;
    if (contains(view, box)) within += 1;
  }
  return { visible, inside: within, leaves };
}

/**
 * The fitted camera F (section 3.1): the content fills at most 1 − 2·margin of the viewport on
 * each axis and is centred, so every side keeps at least the margin.
 */
export function fittedCamera(content: SceneBounds): E26Camera {
  const width = content.maxX - content.minX;
  const height = content.maxY - content.minY;
  const span = 1 - 2 * E26_FIT_MARGIN;
  const zoom = Math.min((E26_VIEWPORT.width * span) / width, (E26_VIEWPORT.height * span) / height);
  return {
    position: {
      x: (content.minX + content.maxX) / 2 - E26_VIEWPORT.width / zoom / 2,
      y: (content.minY + content.maxY) / 2 - E26_VIEWPORT.height / zoom / 2,
    },
    zoom,
  };
}

/**
 * The typical view (section 3.1): the viewport's top-left `E26_TYPICAL_INSET_CSS` above and left
 * of the content, and the zoom found by bisection toward 1,000 drawn leaves visible at DPR 1. With
 * the top-left fixed, the visible count only falls as the zoom rises. The result must hold
 * 900 to 1,100 at every DPR the runs use, which the unit test checks for DPR 1 and 2.
 */
export function typicalCamera(bounds: ReadonlyMap<string, SceneBounds | null>): E26Camera {
  const content = contentBounds(bounds);
  const at = (zoom: number): E26Camera => ({
    position: {
      x: content.minX - E26_TYPICAL_INSET_CSS / zoom,
      y: content.minY - E26_TYPICAL_INSET_CSS / zoom,
    },
    zoom,
  });
  let low = 1 / 64;
  let high = 64;
  for (let step = 0; step < 60; step += 1) {
    const zoom = Math.sqrt(low * high);
    if (visibility(bounds, at(zoom)).visible > E26_TYPICAL_VISIBLE.target) low = zoom;
    else high = zoom;
  }
  return at(high);
}

// ---------------------------------------------------------------------------------------------
// Drivers (section 3.3).

/** P1's theta(t) for t in ms from the common start. */
export function theta(tMs: number): number {
  const period = E26_DRIVERS.thetaPeriodMs;
  return (2 * Math.PI * (tMs % period)) / period;
}

/** The edit drag's pointer offset from its start, in CSS px. */
export function editDragOffset(tMs: number): { x: number; y: number } {
  const angle = theta(tMs);
  return { x: E26_DRIVERS.dragX * Math.sin(angle), y: E26_DRIVERS.dragY * (Math.cos(angle) - 1) };
}

/** The pan and zoom path's camera at t, from the fitted camera F. */
export function panZoomCamera(fitted: E26Camera, tMs: number): E26Camera {
  const angle = theta(tMs);
  const c = Math.cos(angle);
  const viewW = E26_VIEWPORT.width / fitted.zoom;
  const viewH = E26_VIEWPORT.height / fitted.zoom;
  return {
    position: {
      x: fitted.position.x + E26_DRIVERS.pan * viewW * Math.sin(angle),
      y: fitted.position.y + E26_DRIVERS.pan * viewH * (c - 1),
    },
    zoom: fitted.zoom * (E26_DRIVERS.zoomBase + E26_DRIVERS.zoomSwing * c),
  };
}

// ---------------------------------------------------------------------------------------------
// Loading and the configuration (benchmarks README, Scenario identity).

/** JSON with object keys sorted at every level; undefined and non-finite numbers are refused. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('canonicalJson: undefined');
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`canonicalJson: ${value}`);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The current schema's document, whatever its version (it follows `parseDocument`). */
type CurrentDocument = Extract<ReturnType<typeof parseDocument>, { ok: true }>['document'];

export type E26Loaded = Readonly<{
  /** The generated document as JSON data, before migration. */
  generated: unknown;
  document: CurrentDocument;
  pageId: string;
  projection: PageProjection;
  bounds: ReadonlyMap<string, SceneBounds | null>;
}>;

/** Generates, parses (migrating to the current version) and projects a scenario document. */
export function loadScenarioDocument(document: E26Scenario['document']): E26Loaded {
  const generated = document === 'm1-a13' ? generateM1A13Document() : generateStressDocument();
  const parsed = parseDocument(JSON.stringify(generated));
  if (!parsed.ok) throw new Error(`parse: ${parsed.code} ${parsed.path}`);
  const pageId = document === 'm1-a13' ? 'page-1' : 'stress-page';
  const projection = projectPage(parsed.document, pageId, () => null);
  return {
    generated,
    document: parsed.document,
    pageId,
    projection,
    bounds: leafWorldBounds(projection.nodes),
  };
}

export type E26Configuration = Readonly<{
  scenario: E26Scenario;
  documentSha256: string;
  /** The schema version the generated document was loaded as. */
  schemaVersion: number;
  viewport: typeof E26_VIEWPORT;
  devicePixelRatio: number;
  camera: E26Camera;
  fitMargin: number;
  typical: Readonly<{ insetCss: number; visible: typeof E26_TYPICAL_VISIBLE }>;
  cullGuardPx: number;
  drivers: typeof E26_DRIVERS;
  stress: typeof E26_STRESS;
  sceneNodes: number;
  drawnLeaves: number;
  repetitions: number;
}>;

/** The full configuration of one scenario run set, derived from the scenario alone. */
export function e26Configuration(
  scenario: E26Scenario,
  devicePixelRatio: number,
  repetitions: number,
  loaded: E26Loaded = loadScenarioDocument(scenario.document),
): E26Configuration {
  const camera =
    scenario.camera === 'typical'
      ? typicalCamera(loaded.bounds)
      : fittedCamera(contentBounds(loaded.bounds));
  return {
    scenario,
    documentSha256: sha256(canonicalJson(loaded.generated)),
    schemaVersion: loaded.document.schemaVersion,
    viewport: E26_VIEWPORT,
    devicePixelRatio,
    camera,
    fitMargin: E26_FIT_MARGIN,
    typical: { insetCss: E26_TYPICAL_INSET_CSS, visible: E26_TYPICAL_VISIBLE },
    cullGuardPx: E26_CULL_GUARD_PX,
    drivers: E26_DRIVERS,
    stress: E26_STRESS,
    sceneNodes: loaded.projection.nodes.size,
    drawnLeaves: [...loaded.bounds.values()].filter((box) => box !== null).length,
    repetitions,
  };
}

/** The SHA-256 of the canonical JSON of a configuration, as lowercase hex. */
export function configurationHash(configuration: E26Configuration): string {
  return sha256(canonicalJson(configuration));
}

// ---------------------------------------------------------------------------------------------
// E26-U6b: E26-A06, isolation of the M1-A13 page with persistent injected rejections.

/** A06's run: R is the median of five `replaceSnapshot` times, then one isolation of each kind. */
export const E26_ISOLATION = Object.freeze({
  id: 'e26-isolation-m1-a13/v1',
  document: 'm1-a13' as const,
  replaceRuns: 5,
  scattered: 16,
  one: Object.freeze({ factor: 3, constantMs: 50, capMs: 500 }),
  sixteen: Object.freeze({ factor: 6, constantMs: 100, capMs: 1000 }),
});

/**
 * The rejected leaves: the drawn leaves in projection order, the middle one for the single
 * rejection and 16 at evenly spaced ranks, floor((k + 1/2) · n / 16), for the scattered set.
 */
export function isolationTargets(loaded: E26Loaded): { one: string; sixteen: string[] } {
  const leaves = [...loaded.bounds].filter(([, box]) => box !== null).map(([id]) => id);
  const n = leaves.length;
  const count = E26_ISOLATION.scattered;
  if (n < count) throw new Error(`${n} drawn leaves, fewer than ${count}`);
  return {
    one: leaves[Math.floor(n / 2)]!,
    sixteen: Array.from({ length: count }, (_, k) => leaves[Math.floor(((k + 0.5) * n) / count)]!),
  };
}

/** A06's bounds for a median `replaceSnapshot` time R: min(3R + 50, 500) and min(6R + 100, 1000). */
export function isolationBoundsMs(r: number): { one: number; sixteen: number } {
  const bound = (rule: { factor: number; constantMs: number; capMs: number }) =>
    Math.min(rule.factor * r + rule.constantMs, rule.capMs);
  return { one: bound(E26_ISOLATION.one), sixteen: bound(E26_ISOLATION.sixteen) };
}
