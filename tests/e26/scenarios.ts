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
import { generateM1A13Document, M1_A13_SEED, m1A13MoveSelection } from '../m1-a13/document.js';
import { layerRows } from '../../packages/ui/src/layer-model.js';
import {
  generateM9V2Document,
  M9_SECOND_FAMILY,
  M9_V2_PAGE,
  M9_V2_SEED,
  m9TypingTarget,
  projectM9Page,
  type M9GeneratedDocument,
} from '../m9/document.js';
import {
  m9ReplayLayout,
  M9_LAYOUT_TABLE,
  readM9LayoutTable,
  type CompactLayout,
  type M9LayoutTable,
} from '../m9/layouts.js';

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
  | 'e26-pointer-busy-10k/v1'
  | M9ScenarioId
  | V20Ui0ScenarioId
  | E41ScenarioId;

/** E41-U7c (E41 contract, section 5.6, E41-A10): the `e41-cards` scenarios. */
export type E41ScenarioId = 'e41-cards-view/v1' | 'e41-cards-drag/v1';

/** The M9 scenarios (M9 contract, section 3.2). */
export type M9ScenarioId =
  | 'e26-mixed-view-edit-10k/v2'
  | 'e26-mixed-all-edit-10k/v2'
  | 'e26-mixed-all-pan-10k/v2'
  | 'e26-simple-stress-10k/v2'
  | 'e26-pointer-busy-10k/v2'
  | 'm9-typing-10k/v1';

/**
 * V-20 contract (V20-U2, A06): the five v2 frame and latency scenarios with `ui=0` (the bench's
 * Appearance aside instead of the right column), under new IDs by the scenario identity rule.
 * Diagnostic only: the 17a2b0a-aside floor, not a column-free floor, and no verdict. The IDs
 * share no prefix with the v2 IDs, so an `E26_SCENARIOS` prefix filter keeps them apart.
 */
export type V20Ui0ScenarioId =
  | 'e26-ui0-mixed-view-edit-10k/v1'
  | 'e26-ui0-mixed-all-edit-10k/v1'
  | 'e26-ui0-mixed-all-pan-10k/v1'
  | 'e26-ui0-simple-stress-10k/v1'
  | 'e26-ui0-pointer-busy-10k/v1';

export type E26Scenario = Readonly<{
  id: E26ScenarioId;
  document: 'm1-a13' | 'stress' | 'm9-v2' | 'e41-cards';
  seed: number;
  camera: 'typical' | 'fitted';
  interaction: 'edit-drag' | 'pan-zoom' | 'latency-drag' | 'typing';
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
  /** M9 only (absent from every v1 scenario, so v1 configurations and hashes are unchanged). */
  m9?: M9Extras;
}>;

/** What an M9 scenario adds to its v1 counterpart (M9 contract, sections 3.2 and 4). */
export type M9Extras = Readonly<{
  /**
   * `ui=1`: the right column instead of the bench's Appearance aside. False only for the V-20
   * `ui=0` variant (`V20_UI0_SCENARIOS`).
   */
  ui: boolean;
  /** The page viewport of the v2 projects, wider than v1's 1400 x 1000 for the column. */
  window: Readonly<{ width: number; height: number }>;
  /** The font-load change: the test font registered under `family` at `armedAtMs`. */
  fontLoad: Readonly<{ armedAtMs: number; family: string; mark: 'm9-font-load' }> | null;
  /** The typing driver: `keys` characters of `text` at `intervalMs`, caret at `offset`. */
  typing: Readonly<{ offset: number; text: string; intervalMs: number }> | null;
}>;

const seedOf = (document: E26Scenario['document']) =>
  document === 'm1-a13'
    ? M1_A13_SEED
    : document === 'm9-v2'
      ? M9_V2_SEED
      : document === 'e41-cards'
        ? E41_CARDS.seed
        : E26_STRESS.seed;

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
    seed: seedOf(document),
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
// M9-U1 (M9 contract, section 3.2): the v2 scenarios and the typing observation. Each is its v1
// counterpart with `m9` (ui=1, the 1600 x 1000 window) and, for the M9 rows, the v2 document.

/** The v2 projects' page viewport (M9 contract, section 4). */
export const M9_WINDOW = Object.freeze({ width: 1600, height: 1000 });
/** The font-load change of `e26-pointer-busy-10k/v2`, armed after pointer down (section 4). */
export const M9_FONT_LOAD = Object.freeze({
  armedAtMs: 2_000,
  family: M9_SECOND_FAMILY,
  mark: 'm9-font-load' as const,
});
/** The typing driver (section 3.2): 40 ASCII characters at 120 ms, caret at offset 60. */
export const M9_TYPING = Object.freeze({
  offset: 60,
  text: 'abcdefghij'.repeat(4),
  intervalMs: 120,
});

const m9 = (
  scenario: E26Scenario,
  id: M9ScenarioId | V20Ui0ScenarioId,
  document: E26Scenario['document'],
  extras: Partial<Pick<M9Extras, 'fontLoad' | 'typing'>> = {},
): E26Scenario =>
  Object.freeze({
    ...scenario,
    id,
    document,
    seed: seedOf(document),
    m9: Object.freeze({
      ui: true as const,
      window: M9_WINDOW,
      fontLoad: extras.fontLoad ?? null,
      typing: extras.typing ?? null,
    }),
  });

const [viewEdit, allEdit, allPan, stressPan, busy] = E26_SCENARIOS as [
  E26Scenario,
  E26Scenario,
  E26Scenario,
  E26Scenario,
  E26Scenario,
];

/** The six M9 scenarios of section 3.2, in its order. */
export const M9_SCENARIOS: readonly E26Scenario[] = Object.freeze([
  m9(viewEdit, 'e26-mixed-view-edit-10k/v2', 'm9-v2'),
  m9(allEdit, 'e26-mixed-all-edit-10k/v2', 'm9-v2'),
  m9(allPan, 'e26-mixed-all-pan-10k/v2', 'm9-v2'),
  m9(stressPan, 'e26-simple-stress-10k/v2', 'stress'),
  m9(busy, 'e26-pointer-busy-10k/v2', 'm9-v2', { fontLoad: M9_FONT_LOAD }),
  Object.freeze({
    ...m9(busy, 'm9-typing-10k/v1', 'm9-v2', { typing: M9_TYPING }),
    interaction: 'typing' as const,
    // Recorded only (M9-Q4): no bound, no rejection, no background fill.
    latencyBoundMs: null,
    reject: null,
    setFillBeforeDownMs: null,
  }),
]);

/** V-20 (V20-U2): the `ui=0` variant of the five v2 frame and latency scenarios, in that order. */
export const V20_UI0_SCENARIOS: readonly E26Scenario[] = Object.freeze(
  (
    [
      'e26-ui0-mixed-view-edit-10k/v1',
      'e26-ui0-mixed-all-edit-10k/v1',
      'e26-ui0-mixed-all-pan-10k/v1',
      'e26-ui0-simple-stress-10k/v1',
      'e26-ui0-pointer-busy-10k/v1',
    ] as const
  ).map((id, index) => {
    const v2 = M9_SCENARIOS[index]!;
    return Object.freeze({ ...v2, id, m9: Object.freeze({ ...v2.m9!, ui: false }) });
  }),
);

// ---------------------------------------------------------------------------------------------
// E41-U7c (E41 contract, section 5.6, E41-A10): the `e41-cards` scene and its two scenarios.

/**
 * The `e41-cards` scene: 50 cards in a 10 × 5 grid. Each card is a group (a container effect
 * root) of a rounded background, a coloured header and an avatar ellipse, with one drop shadow
 * (radius 16, so σ 8); every tenth card (index 0, 10, …) also has a layer blur (radius 8). The
 * grid's aspect is near the 16:9 canvas, so the fitted camera shows every card at once: all 50
 * effect roots are drawn in every frame. `seed` picks the header colours (P1's LCG).
 */
export const E41_CARDS = Object.freeze({
  seed: 0x4541_0050,
  count: 50,
  columns: 10,
  card: Object.freeze({ width: 200, height: 230, cornerRadius: 12 }),
  gap: 40,
  shadow: Object.freeze({
    color: { r: 0, g: 0, b: 0, a: 0.25 },
    offsetX: 0,
    offsetY: 8,
    radius: 16,
  }),
  blurEvery: 10,
  blurRadius: 8,
  /** The dragged card (row 2, column 2), well inside the view through the drag. */
  dragged: 22,
});

const e41CardId = (i: number) => `card-${String(i).padStart(2, '0')}`;

/**
 * The `e41-cards` document at the current schema (v7, which has effects): generated as a v2
 * document without effects, parsed (migrated), then given each card's effects.
 */
export function generateE41CardsDocument() {
  const { card, gap, columns, count, seed } = E41_CARDS;
  const nodes: Record<string, Record<string, unknown>> = {};
  const children: string[] = [];
  const base = (id: string, parent: string, frame: Record<string, number>) => ({
    id,
    name: id,
    parent,
    frame,
    rotation: 0,
    constraints: { horizontal: 'start', vertical: 'start' },
    opacity: 1,
    visible: true,
  });
  for (let i = 0; i < count; i += 1) {
    const id = e41CardId(i);
    const x = (i % columns) * (card.width + gap);
    const y = Math.floor(i / columns) * (card.height + gap);
    const word = (Math.imul(1664525, (seed ^ i) >>> 0) + 1013904223) >>> 0;
    const q = (j: number) => ((word >>> (8 * j)) & 255) / 255;
    const r = card.cornerRadius;
    nodes[`${id}-bg`] = {
      ...base(`${id}-bg`, id, { x: 0, y: 0, width: card.width, height: card.height }),
      type: 'rectangle',
      cornerRadii: [r, r, r, r],
      fill: { r: 1, g: 1, b: 1, a: 1 },
      stroke: null,
    };
    nodes[`${id}-header`] = {
      ...base(`${id}-header`, id, { x: 0, y: 0, width: card.width, height: 60 }),
      type: 'rectangle',
      cornerRadii: [r, r, 0, 0],
      fill: { r: 0.2 + 0.6 * q(0), g: 0.2 + 0.6 * q(1), b: 0.2 + 0.6 * q(2), a: 1 },
      stroke: null,
    };
    nodes[`${id}-avatar`] = {
      ...base(`${id}-avatar`, id, { x: 16, y: 80, width: 48, height: 48 }),
      type: 'ellipse',
      fill: { r: 0.85, g: 0.85, b: 0.88, a: 1 },
      stroke: null,
    };
    nodes[id] = {
      ...base(id, 'cards-page', { x, y, width: card.width, height: card.height }),
      type: 'group',
      children: [`${id}-bg`, `${id}-header`, `${id}-avatar`],
    };
    children.push(id);
  }
  const v2 = {
    schemaVersion: 2 as const,
    id: 'e41-cards',
    pages: [{ id: 'cards-page', name: 'Cards', children }],
    nodes,
  };
  const parsed = parseDocument(JSON.stringify(v2));
  if (!parsed.ok) throw new Error(`e41-cards parse: ${parsed.code} ${parsed.path}`);
  const document = JSON.parse(JSON.stringify(parsed.document)) as {
    schemaVersion: number;
    nodes: Record<string, { effects: unknown[] }>;
  };
  if (document.schemaVersion !== 7) throw new Error('e41-cards: not schema version 7');
  for (let i = 0; i < count; i += 1) {
    const effects: unknown[] = [{ kind: 'dropShadow', visible: true, ...E41_CARDS.shadow }];
    if (i % E41_CARDS.blurEvery === 0)
      effects.push({ kind: 'layerBlur', visible: true, radius: E41_CARDS.blurRadius });
    document.nodes[e41CardId(i)]!.effects = effects;
  }
  return document;
}

/** The dragged card, as a move selection, and the leaf pressed (its background). */
export function e41CardsMoveSelection(): { group: string; ids: [string]; pressed: string } {
  const id = e41CardId(E41_CARDS.dragged);
  return { group: id, ids: [id], pressed: `${id}-bg` };
}

/**
 * The two `e41-cards` scenarios (section 5.6), both at the fitted camera, so all 50 roots draw:
 * the view under the pan and zoom driver, and the edit drag of one card. The ceiling is 16.7 ms
 * for both.
 */
export const E41_SCENARIOS: readonly E26Scenario[] = Object.freeze([
  frame('e41-cards-view/v1', 'e41-cards', 'fitted', 'pan-zoom', 16.7),
  frame('e41-cards-drag/v1', 'e41-cards', 'fitted', 'edit-drag', 16.7),
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

/**
 * M9-U1: the layout table's digest. Only the layouts count, with each result's `generation`
 * zeroed: the generation is the recording page's text port counter and `recordedWith` names the
 * recording browser, neither of which changes what Node projects.
 */
export function m9LayoutTableSha256(table: M9LayoutTable): string {
  const layouts: Record<string, CompactLayout> = {};
  for (const [key, layout] of Object.entries(table.layouts))
    layouts[key] = { ...layout, generation: 0 };
  return sha256(canonicalJson(layouts));
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

/**
 * Generates, parses (migrating to the current version) and projects a scenario document. The v2
 * page's text lays out from `table` (the committed one unless given: M9-U1's headed check passes
 * a browser's live layouts).
 */
export function loadScenarioDocument(
  document: E26Scenario['document'],
  table?: M9LayoutTable,
): E26Loaded {
  const generated =
    document === 'm1-a13'
      ? generateM1A13Document()
      : document === 'm9-v2'
        ? generateM9V2Document()
        : document === 'e41-cards'
          ? generateE41CardsDocument()
          : generateStressDocument();
  const parsed = parseDocument(JSON.stringify(generated));
  if (!parsed.ok) throw new Error(`parse: ${parsed.code} ${parsed.path}`);
  const pageId =
    document === 'm1-a13'
      ? 'page-1'
      : document === 'm9-v2'
        ? M9_V2_PAGE
        : document === 'e41-cards'
          ? 'cards-page'
          : 'stress-page';
  // M9-U1: the v2 page's text projects through the committed font's recorded layouts.
  const projection =
    document === 'm9-v2'
      ? projectM9Page(parsed.document, pageId, m9ReplayLayout(table ?? readM9LayoutTable()))
      : projectPage(parsed.document, pageId, () => null);
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

/** M9-U1: what an M9 scenario's configuration adds (M9 contract, sections 3.2 and 4). */
export type M9Configuration = E26Configuration &
  Readonly<{
    m9: Readonly<{
      /** The SHA-256 of the canonical JSON of the layout table the text bounds come from. */
      layoutTableSha256: string | null;
      /** The layer-tree toggles clicked before the warm-up (the move selection's ancestry). */
      expanded: readonly string[];
      /** The layer rows shown after them, with the move selection selected. */
      layerRows: number;
      /** The typing target, for `m9-typing-10k/v1`. */
      typingTarget: string | null;
    }>;
  }>;

/**
 * The layer-tree state of an M9 run: the move selection's containers from the page down (the
 * cluster frame, then group G), each expanded by its `layer-toggle-<id>`, and the row count the
 * tree then shows with the selection selected (ui `layerRows`).
 */
export function m9LayerTree(loaded: E26Loaded): { expanded: string[]; rows: number } {
  const generated = loaded.generated as Parameters<typeof m1A13MoveSelection>[0];
  const selection = m1A13MoveSelection(generated);
  const expanded: string[] = [];
  let cursor = loaded.document.nodes[selection.group]!;
  for (;;) {
    expanded.unshift(cursor.id);
    if (cursor.parent === loaded.pageId) break;
    cursor = loaded.document.nodes[cursor.parent]!;
  }
  const rows = layerRows(loaded.document, loaded.pageId, new Set(expanded), selection.ids);
  return { expanded, rows: rows.length };
}

/** The configuration of an M9 scenario: its E26 configuration and the `m9` record. */
export function m9Configuration(
  scenario: E26Scenario,
  devicePixelRatio: number,
  repetitions: number,
  loaded: E26Loaded = loadScenarioDocument(scenario.document),
): M9Configuration {
  if (scenario.m9 === undefined) throw new Error(`${scenario.id} is not an M9 scenario`);
  // The stress page has no containers: nothing to expand, every node one row.
  // V-20 `ui=0`: no column, so nothing to expand and no rows shown.
  const tree = !scenario.m9.ui
    ? { expanded: [], rows: 0 }
    : scenario.document === 'stress'
      ? { expanded: [], rows: layerRows(loaded.document, loaded.pageId, new Set(), []).length }
      : m9LayerTree(loaded);
  return {
    ...e26Configuration(scenario, devicePixelRatio, repetitions, loaded),
    m9: {
      layoutTableSha256:
        scenario.document === 'm9-v2'
          ? m9LayoutTableSha256(readM9LayoutTable(M9_LAYOUT_TABLE))
          : null,
      expanded: tree.expanded,
      layerRows: tree.rows,
      typingTarget:
        scenario.m9.typing === null
          ? null
          : m9TypingTarget(loaded.generated as M9GeneratedDocument),
    },
  };
}

/**
 * M9-U1 (M9-A02): the camera claims of the v2 document, judged over `loaded`'s draw bounds at the
 * cameras chosen from the committed layouts (the runs' cameras): the typical view shows 900 to
 * 1,100 drawn leaves at DPR 1 and 2; every drawn leaf is inside the viewport at F and along the
 * whole pan and zoom path (1 ms steps); and the move selection stays inside through the edit
 * drag at both cameras (10 ms steps). The unit test judges the committed layouts; the headed
 * `m9-v2-layouts` check judges a browser's live ones, so the claims hold where the runs measure.
 */
export function m9CameraClaims(
  loaded: E26Loaded,
  cameras: Readonly<{ typical: E26Camera; fitted: E26Camera }> = m9Cameras(),
) {
  const { typical, fitted } = cameras;
  const atDpr = [1, 2].map((dpr) => ({ dpr, ...visibility(loaded.bounds, typical, dpr) }));
  const typicalHolds = atDpr.every(
    (entry) =>
      entry.visible >= E26_TYPICAL_VISIBLE.min &&
      entry.visible <= E26_TYPICAL_VISIBLE.max &&
      entry.visible < entry.leaves,
  );
  const atF = visibility(loaded.bounds, fitted);
  let panMinInside = atF.inside;
  let panFirstMissMs: number | null = null;
  for (let t = 0; t < E26_DRIVERS.thetaPeriodMs; t += 1) {
    const { inside, leaves } = visibility(loaded.bounds, panZoomCamera(fitted, t));
    panMinInside = Math.min(panMinInside, inside);
    if (inside !== leaves && panFirstMissMs === null) panFirstMissMs = t;
  }
  const { ids } = m1A13MoveSelection(loaded.generated as Parameters<typeof m1A13MoveSelection>[0]);
  const drag = (camera: E26Camera) => {
    const view = worldViewport(camera);
    let firstMissMs: number | null = null;
    for (let t = 0; t < E26_DRIVERS.thetaPeriodMs && firstMissMs === null; t += 10) {
      const offset = editDragOffset(t);
      const dx = offset.x / camera.zoom;
      const dy = offset.y / camera.zoom;
      for (const id of ids) {
        const box = loaded.bounds.get(id);
        if (
          box == null ||
          !contains(view, {
            minX: box.minX + dx,
            minY: box.minY + dy,
            maxX: box.maxX + dx,
            maxY: box.maxY + dy,
          })
        ) {
          firstMissMs = t;
          break;
        }
      }
    }
    return { holds: firstMissMs === null, firstMissMs };
  };
  const moveSelection = { typical: drag(typical), fitted: drag(fitted) };
  const fittedHolds = atF.inside === atF.leaves && panFirstMissMs === null;
  return {
    typical: { zoom: typical.zoom, atDpr, holds: typicalHolds },
    fitted: {
      zoom: fitted.zoom,
      leaves: atF.leaves,
      insideAtF: atF.inside,
      panMinInside,
      panFirstMissMs,
      holds: fittedHolds,
    },
    moveSelection: {
      ...moveSelection,
      holds: moveSelection.typical.holds && moveSelection.fitted.holds,
    },
    holds: typicalHolds && fittedHolds && moveSelection.typical.holds && moveSelection.fitted.holds,
  };
}

/** The v2 runs' cameras: the typical view and F, chosen from the committed layouts. */
export function m9Cameras(loaded: E26Loaded = loadScenarioDocument('m9-v2')): {
  typical: E26Camera;
  fitted: E26Camera;
} {
  return {
    typical: typicalCamera(loaded.bounds),
    fitted: fittedCamera(contentBounds(loaded.bounds)),
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
