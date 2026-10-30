// E26-U1a (E26 contract, section 3): the scenario definitions, the stress document, the fitted
// and typical-view cameras, the per-frame drivers and the configuration hash. Pure data and
// arithmetic: no editor, renderer or browser runs here, so the headed harness (U1c) and the
// host's bench option (U1b) share one source of truth.
//
// Visibility is counted over leaf scene nodes (primitives, paths and text), from their world
// stroke bounds, with clips ignored (conservative, as P1 culling). A container has no bounds of
// its own, so "every scene node visible" means every leaf's bounds lie inside the viewport.
import { createHash } from 'node:crypto';
import type { RenderNodeSnapshot, SceneAffine } from '@vector-studio/contracts';
import {
  composeSceneAffine,
  getPathLocalPointBounds,
  getPathLocalStrokeBounds,
  getPrimitiveLocalStrokeBounds,
  getTextLocalBounds,
  transformSceneBounds,
  type SceneBounds,
} from '../../packages/renderer-core/src/scene-numeric.js';
import { M1_A13_SEED } from '../m1-a13/document.js';

/** The CSS viewport of every E26 run (section 3.5); DPR varies per run, not per scenario. */
export const E26_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
/** The fitted camera's margin, a fraction of the viewport on each side (section 3.1). */
export const E26_FIT_MARGIN = 0.1;
/** The typical view's visible leaf count (section 3.1, as P1 Scene 3). */
export const E26_TYPICAL_VISIBLE = Object.freeze({ min: 900, max: 1100 });
/** The typical view's top-left inset from the page content, in CSS px: more than the edit drag's 60. */
export const E26_TYPICAL_INSET_CSS = 80;
/** P1's trajectory period (P1 measurement contract): theta(t) = 2·pi·((t mod 10000) / 10000). */
export const E26_THETA_PERIOD_MS = 10_000;
/** P1's warm-up and half-open measured window, in ms from the common start (section 3.3). */
export const E26_WINDOW_MS = Object.freeze({ warmUp: 5_000, end: 15_000 });
/** The stress scene's seed: P1's LCG constant (P1 measurement contract). */
export const E26_STRESS_SEED = 0x5031_0001;
export const E26_STRESS_NODE_COUNT = 10_000;

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
  /** The `setFill` before pointer down, in ms relative to it, or null. */
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
    seed: document === 'm1-a13' ? M1_A13_SEED : E26_STRESS_SEED,
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

type StressNode = Record<string, unknown> & { id: string };

/**
 * P1's `p1-pan-zoom-10k/v1` centres (P1 measurement contract, "Reproduce workload arithmetic"):
 * 100 columns and rows over 900 × 400 with the LCG jitter of ±1.
 */
export function stressCenter(i: number): { x: number; y: number } {
  const u = (Math.imul(1664525, (E26_STRESS_SEED ^ i) >>> 0) + 1013904223) >>> 0;
  return {
    x: 180 + (900 * (i % 100)) / 99 + (2 * (u & 255)) / 255 - 1,
    y: 160 + (400 * Math.floor(i / 100)) / 99 + (2 * ((u >>> 8) & 255)) / 255 - 1,
  };
}

/** P1's fill colour of node i: `0.2 + 0.6·qj` per channel, alpha `0.45 + 0.4·q3`. */
function stressFill(i: number) {
  const u = (Math.imul(1664525, (E26_STRESS_SEED ^ i) >>> 0) + 1013904223) >>> 0;
  const q = [0, 8, 16, 24].map((shift) => ((u >>> shift) & 255) / 255);
  return {
    r: 0.2 + 0.6 * q[0]!,
    g: 0.2 + 0.6 * q[1]!,
    b: 0.2 + 0.6 * q[2]!,
    a: 0.45 + 0.4 * q[3]!,
  };
}

/**
 * The 10,000-node stress document as a schema-v2 document, which `parseDocument` migrates to the
 * current version on load, as the M1-A13 generator does; the configuration hash names the
 * version it was loaded as. Node i keeps P1's centre, size and opacity `0.5 + 0.25·(i % 3)`;
 * P1's lines (`i % 4 = 3`) become 3.5 × 1 rectangles on the line; no node has a stroke.
 */
export function generateStressDocument() {
  const nodes: Record<string, StressNode> = {};
  const children: string[] = [];
  for (let i = 0; i < E26_STRESS_NODE_COUNT; i += 1) {
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
// World bounds, the fitted camera and the typical view.

/** The world stroke bounds of every leaf scene node, by scene ID; null for a leaf with none. */
export function leafWorldBounds(
  nodes: ReadonlyMap<string, RenderNodeSnapshot>,
): Map<string, SceneBounds | null> {
  const world = new Map<string, SceneAffine>();
  const worldOf = (node: RenderNodeSnapshot): SceneAffine => {
    const known = world.get(node.id);
    if (known !== undefined) return known;
    const parent: SceneAffine =
      node.parentId === null ? [1, 0, 0, 1, 0, 0] : worldOf(nodes.get(node.parentId)!);
    const own = composeSceneAffine(parent, node.transform);
    if (own === null) throw new Error(`non-finite world transform at ${node.id}`);
    world.set(node.id, own);
    return own;
  };
  const result = new Map<string, SceneBounds | null>();
  for (const node of nodes.values()) {
    let local: SceneBounds | null | undefined;
    if (node.kind === 'primitive') local = getPrimitiveLocalStrokeBounds(node);
    else if (node.kind === 'path') {
      const points = getPathLocalPointBounds(node.geometry.points);
      const stroke = getPathLocalStrokeBounds(node.geometry.points, node.style.stroke);
      local = stroke === null ? points : points === null ? stroke : union(points, stroke);
    } else if (node.kind === 'text') local = getTextLocalBounds(node);
    else continue;
    result.set(node.id, local == null ? null : transformSceneBounds(local, worldOf(node)));
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

/** The union of all leaf bounds. */
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
const inside = (a: SceneBounds, b: SceneBounds) =>
  a.minX >= b.minX && a.maxX <= b.maxX && a.minY >= b.minY && a.maxY <= b.maxY;

/** Leaves whose bounds meet the viewport, and leaves wholly inside it. */
export function visibility(
  bounds: ReadonlyMap<string, SceneBounds | null>,
  camera: E26Camera,
): { visible: number; inside: number; leaves: number } {
  const view = worldViewport(camera);
  let visible = 0;
  let within = 0;
  let leaves = 0;
  for (const box of bounds.values()) {
    if (box === null) continue;
    leaves += 1;
    if (intersects(box, view)) visible += 1;
    if (inside(box, view)) within += 1;
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
 * The typical view (section 3.1): the viewport's top-left at the content's top-left less
 * `E26_TYPICAL_INSET_CSS`, and the zoom found by bisection so that 900 to 1,100 leaves are
 * visible. Moving the top-left fixed, the visible count only falls as the zoom rises.
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
  for (let step = 0; step < 80; step += 1) {
    const zoom = Math.sqrt(low * high);
    const { visible } = visibility(bounds, at(zoom));
    if (visible >= E26_TYPICAL_VISIBLE.min && visible <= E26_TYPICAL_VISIBLE.max) return at(zoom);
    if (visible > E26_TYPICAL_VISIBLE.max) low = zoom;
    else high = zoom;
  }
  throw new Error('no zoom gives a typical view');
}

// ---------------------------------------------------------------------------------------------
// Drivers (section 3.3).

/** P1's theta(t) for t in ms from the common start. */
export function theta(tMs: number): number {
  return (2 * Math.PI * (tMs % E26_THETA_PERIOD_MS)) / E26_THETA_PERIOD_MS;
}

/** The edit drag's pointer offset from its start, in CSS px. */
export function editDragOffset(tMs: number): { x: number; y: number } {
  const angle = theta(tMs);
  return { x: 40 * Math.sin(angle), y: 30 * (Math.cos(angle) - 1) };
}

/** The pan and zoom path's camera at t, from the fitted camera F. */
export function panZoomCamera(fitted: E26Camera, tMs: number): E26Camera {
  const angle = theta(tMs);
  const c = Math.cos(angle);
  const viewW = E26_VIEWPORT.width / fitted.zoom;
  const viewH = E26_VIEWPORT.height / fitted.zoom;
  return {
    position: {
      x: fitted.position.x + 0.05 * viewW * Math.sin(angle),
      y: fitted.position.y + 0.05 * viewH * (c - 1),
    },
    zoom: fitted.zoom * (0.95 + 0.05 * c),
  };
}

// ---------------------------------------------------------------------------------------------
// Configuration hash (benchmarks README, Scenario identity).

/** JSON with object keys sorted at every level: the defined serialization of the hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export type E26Configuration = Readonly<{
  scenario: E26Scenario;
  /** The schema version the generated document was loaded as. */
  schemaVersion: number;
  viewport: typeof E26_VIEWPORT;
  devicePixelRatio: number;
  camera: E26Camera;
  sceneNodes: number;
  leaves: number;
  window: typeof E26_WINDOW_MS;
  repetitions: number;
}>;

/** The SHA-256 of the canonical JSON of a configuration, as lowercase hex. */
export function configurationHash(configuration: E26Configuration): string {
  return createHash('sha256').update(canonicalJson(configuration)).digest('hex');
}
