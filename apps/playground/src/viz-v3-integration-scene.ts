import type {
  PathStroke,
  RenderCamera,
  RenderChangeSet,
  RenderChildOrder,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneAffine,
  SceneColor,
  SceneIdentity,
} from '@vector-studio/contracts';
import { B2_PATHS } from './p3-b2-strokes-scene.js';
import { V4_PATHS } from './p3-v4-paths-scene.js';
import { solidColor } from './scene-paint.js';

// Visualization track V-3 (docs/plans/viz-v3-a07-integration-contract.md, sections 3.2 to 3.5):
// the scene of the A07 integration page, its ordered-check states S0 to S5, the recovery edit X
// of R2 and the churn script. Plain JSON data and pure functions: this module has no DOM, GPU
// or WASM import, so unit tests can load it. It adds no geometry: every path comes from the
// exported specs of the ST-U8 stroke page (B2_PATHS) and the V4 path page (V4_PATHS), placed by
// translation-only transforms at zoom 1. Functional evidence only: precision is UNVERIFIED
// against the 0.25 physical-pixel target until B4 has A04 evidence.

export const VIZ_V3_EVIDENCE_LABEL =
  'UNVERIFIED: functional V-3 A07 integration page evidence only (ordered path/primitive integration, resource lifetime under churn, latest-scene device recovery); precision is UNVERIFIED against the 0.25 physical-pixel target until B4 has A04 evidence, no Q4 coverage threshold and no performance claim is made.';

export const VIZ_V3_SURFACE = Object.freeze({ width: 720, height: 480 });
/** The fixed camera: the scene center (360, 240) at the surface center, zoom 1. */
export const VIZ_V3_CAMERA: RenderCamera = Object.freeze({
  position: Object.freeze({ x: 0, y: 0 }),
  zoom: 1,
});
export const VIZ_V3_IDENTITY: SceneIdentity = Object.freeze({
  documentId: 'viz-v3-integration',
  pageId: 'page-1',
});

/** Section 3.4, VZ3-Q6 (a): N cycles, warm-up W, and the R3 loss cycle. */
export const VIZ_V3_CHURN = Object.freeze({ cycles: 64, warmup: 4, lossCycle: 32 });

const b2 = (id: string) => B2_PATHS.find((path) => path.id === id)!;
const v4 = (id: string) => V4_PATHS.find((path) => path.id === id)!;
const SQUARE = b2('fill-stroke-square');
const CIRCLE = b2('fill-stroke-circle');
const STAR = v4('star-nonzero');

const rgb = (r: number, g: number, b: number, a = 1): SceneColor => Object.freeze({ r, g, b, a });

/** Colors of the scene. Every overlap's two possible orders differ by more than 24/255. */
export const VIZ_V3_COLORS = Object.freeze({
  bg: rgb(0.85, 0.85, 0.85),
  squareFill: SQUARE.fill!,
  squareStroke: solidColor(SQUARE.stroke!.color),
  squareFillS2: rgb(0.95, 0.75, 0.1),
  squareStrokeS2: rgb(0.6, 0.2, 0.75),
  band: rgb(0.2, 0.7, 0.3),
  circle: rgb(1, 0.6, 0.2),
  circleX: rgb(0.55, 0.3, 0.9),
  line: rgb(0.05, 0.05, 0.05),
  dot: rgb(1, 0.9, 0.2),
  star: rgb(0.5, 0.2, 0.7),
  under: rgb(0.9, 0.1, 0.8),
  half: rgb(0.1, 0.8, 0.9),
  solid: rgb(0.1, 0.15, 0.5),
  white: rgb(1, 1, 1),
  xRect: rgb(0.45, 0.3, 0.1),
  persist: rgb(0.45, 0.55, 0.1),
  churnEllipse: rgb(0.1, 0.6, 0.6),
  churnStar: rgb(0.5, 0.2, 0.7),
});
const C = VIZ_V3_COLORS;

const translate = (x: number, y: number): SceneAffine => [1, 0, 0, 1, x, y];
const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];

/** B2 `fill-stroke-square`'s stroke: width 10, butt, miter, limit 4. */
const SQUARE_STROKE = (color: SceneColor): PathStroke => ({ ...SQUARE.stroke!, color });

type Geometry = 'square' | 'circle' | 'star';
const GEOMETRY = {
  square: SQUARE.data,
  circle: CIRCLE.data,
  star: STAR.data,
} as const;

function pathNode(
  id: string,
  geometry: Geometry,
  center: readonly [number, number],
  fill: SceneColor | null,
  stroke: PathStroke | null,
  options: Readonly<{ opacity?: number; parentId?: string | null; visible?: boolean }> = {},
): RenderNodeSnapshot {
  const data = GEOMETRY[geometry];
  return {
    id,
    parentId: options.parentId ?? null,
    transform: translate(center[0], center[1]),
    visible: options.visible ?? true,
    opacity: options.opacity ?? 1,
    kind: 'path',
    geometry: {
      kind: 'path',
      verbs: [...data.verbs],
      points: [...data.points],
      fillRule: 'nonzero',
    },
    style: { fill, stroke },
  };
}

function rectNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: SceneColor,
  opacity = 1,
): RenderNodeSnapshot {
  return {
    id,
    parentId: null,
    transform: translate(x, y),
    visible: true,
    opacity,
    kind: 'primitive',
    geometry: { kind: 'rectangle', width, height, cornerRadii: [0, 0, 0, 0] },
    style: { fill, stroke: null },
  };
}

/** An ellipse centered at (cx, cy); P1 ellipses span [0, width] x [0, height] locally. */
function ellipseNode(
  id: string,
  cx: number,
  cy: number,
  width: number,
  height: number,
  fill: SceneColor,
  parentId: string | null = null,
): RenderNodeSnapshot {
  return {
    id,
    parentId,
    transform: translate(cx - width / 2, cy - height / 2),
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry: { kind: 'ellipse', width, height },
    style: { fill, stroke: null },
  };
}

// ---------------------------------------------------------------------------------------------
// Layout (world == surface CSS px at zoom 1). Order zone x < 480, churn zone x >= 480.
// ---------------------------------------------------------------------------------------------

export const VIZ_V3_LAYOUT = Object.freeze({
  square: [90, 100] as const,
  band: Object.freeze({ x: 100, y: 90, width: 140, height: 20 }),
  circle: [200, 100] as const,
  star: [380, 110] as const,
  line: Object.freeze({ start: { x: -70, y: 20 }, end: { x: 70, y: 20 }, width: 6 }),
  dot: Object.freeze({ width: 120, height: 14 }),
  under: Object.freeze({ x: 40, y: 230, width: 80, height: 60 }),
  half: [130, 260] as const,
  solid: [280, 260] as const,
  rHalf: Object.freeze({ x: 290, y: 235, width: 80, height: 50 }),
  jbase: Object.freeze({ x: 40, y: 345, width: 120, height: 110 }),
  joint: [100, 400] as const,
  xRect: Object.freeze({ x: 200, y: 380, width: 60, height: 40 }),
  persist: [600, 80] as const,
  /** Transient churn pair centers: odd cycles (geometry B) and even cycles (geometry A). */
  churnOdd: [600, 240] as const,
  churnEven: [600, 390] as const,
  churnEllipse: Object.freeze({ width: 110, height: 16 }),
});
const L = VIZ_V3_LAYOUT;

const ORDER_ZONE_ROOT = [
  'bg',
  'p-square',
  'r-band',
  'p-circle',
  'l-line',
  'g-group',
  'r-under',
  'p-half',
  'p-solid',
  'r-half',
  'r-jbase',
  'p-joint',
] as const;

function initialNodes(): RenderNodeSnapshot[] {
  return [
    rectNode('bg', 0, 0, VIZ_V3_SURFACE.width, VIZ_V3_SURFACE.height, C.bg),
    pathNode('p-square', 'square', L.square, C.squareFill, SQUARE_STROKE(C.squareStroke)),
    rectNode('r-band', L.band.x, L.band.y, L.band.width, L.band.height, C.band),
    pathNode('p-circle', 'circle', L.circle, C.circle, null),
    {
      id: 'l-line',
      parentId: null,
      transform: translate(L.star[0], L.star[1]),
      visible: true,
      opacity: 1,
      kind: 'primitive',
      geometry: { kind: 'line', start: L.line.start, end: L.line.end },
      style: { fill: null, stroke: { color: C.line, width: L.line.width } },
    },
    {
      id: 'g-group',
      parentId: null,
      transform: IDENTITY,
      visible: true,
      opacity: 1,
      kind: 'container',
      clip: null,
      children: ['e-dot', 'p-star'],
    },
    ellipseNode('e-dot', L.star[0], L.star[1], L.dot.width, L.dot.height, C.dot, 'g-group'),
    pathNode('p-star', 'star', L.star, C.star, null, { parentId: 'g-group' }),
    rectNode('r-under', L.under.x, L.under.y, L.under.width, L.under.height, C.under),
    pathNode('p-half', 'square', L.half, C.half, null, { opacity: 0.5 }),
    pathNode('p-solid', 'circle', L.solid, C.solid, null),
    rectNode('r-half', L.rHalf.x, L.rHalf.y, L.rHalf.width, L.rHalf.height, C.white, 0.5),
    rectNode('r-jbase', L.jbase.x, L.jbase.y, L.jbase.width, L.jbase.height, C.white),
    pathNode('p-joint', 'square', L.joint, C.squareFill, SQUARE_STROKE(C.squareStroke), {
      opacity: 0.5,
    }),
    // The persistent churn path starts as the star, so cycle 1 (odd: circle) changes it.
    pathNode('ch-persist', 'star', L.persist, C.persist, null),
  ];
}

// ---------------------------------------------------------------------------------------------
// The script: a plain model of the scene that every step edits and snapshots.
// ---------------------------------------------------------------------------------------------

export type VizV3StepKind = 'order' | 'recovery' | 'churn';
export type VizV3ChurnStep = 'add' | 'replace' | 'remove';

export type VizV3Step = Readonly<{
  id: string;
  kind: VizV3StepKind;
  cycle: number | null;
  churnStep: VizV3ChurnStep | null;
  changes: RenderChangeSet;
  /** The whole scene after this step, as plain data. */
  scene: RenderSceneSnapshot;
}>;

export type VizV3Script = Readonly<{
  initial: RenderSceneSnapshot;
  steps: readonly VizV3Step[];
}>;

type Ops = Readonly<{
  inserted?: readonly RenderNodeSnapshot[];
  updated?: readonly RenderNodeSnapshot[];
  removed?: readonly string[];
  orders?: readonly RenderChildOrder[];
}>;

class SceneModel {
  readonly nodes = new Map<string, RenderNodeSnapshot>();
  root: string[] = [];
  revision = 0;

  snapshot(): RenderSceneSnapshot {
    return clone({
      identity: VIZ_V3_IDENTITY,
      revision: this.revision,
      nodes: [...this.nodes.values()],
      rootOrder: this.root,
    });
  }

  get(id: string): RenderNodeSnapshot {
    const node = this.nodes.get(id);
    if (node === undefined) throw new Error(`unknown node ${id}`);
    return node;
  }

  apply(ops: Ops): RenderChangeSet {
    const changes: RenderChangeSet = clone({
      identity: VIZ_V3_IDENTITY,
      revision: this.revision + 1,
      baseRevision: this.revision,
      inserted: ops.inserted ?? [],
      updated: ops.updated ?? [],
      removed: ops.removed ?? [],
      orders: ops.orders ?? [],
    });
    for (const id of changes.removed) this.nodes.delete(id);
    for (const node of [...changes.inserted, ...changes.updated]) this.nodes.set(node.id, node);
    for (const order of changes.orders) {
      if (order.parentId === null) {
        this.root = [...order.children];
        continue;
      }
      const parent = this.get(order.parentId);
      if (parent.kind !== 'container') throw new Error(`${order.parentId} is not a container`);
      this.nodes.set(parent.id, { ...parent, children: [...order.children] });
    }
    this.revision = changes.revision;
    return changes;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Moves `id` in `order` to just after `after` (or to the start when `after` is null). */
function moveAfter(order: readonly string[], id: string, after: string | null): string[] {
  const rest = order.filter((entry) => entry !== id);
  const index = after === null ? 0 : rest.indexOf(after) + 1;
  return [...rest.slice(0, index), id, ...rest.slice(index)];
}

function swap(order: readonly string[], a: string, b: string): string[] {
  return order.map((entry) => (entry === a ? b : entry === b ? a : entry));
}

const withGeometry = (node: RenderNodeSnapshot, geometry: Geometry): RenderNodeSnapshot => {
  if (node.kind !== 'path') throw new Error(`${node.id} is not a path`);
  const data = GEOMETRY[geometry];
  return {
    ...node,
    geometry: { ...node.geometry, verbs: [...data.verbs], points: [...data.points] },
  };
};

const withFill = (node: RenderNodeSnapshot, fill: SceneColor): RenderNodeSnapshot => {
  if (node.kind !== 'path') throw new Error(`${node.id} is not a path`);
  return { ...node, style: { ...node.style, fill } };
};

/** The churn path and ellipse of cycle c (section 3.4): A when c is even, B when c is odd. */
export function churnPair(c: number): readonly [RenderNodeSnapshot, RenderNodeSnapshot] {
  const odd = c % 2 === 1;
  const center = odd ? L.churnOdd : L.churnEven;
  const path = odd
    ? pathNode(`ch-p-${c}`, 'star', center, C.churnStar, null)
    : pathNode(`ch-p-${c}`, 'square', center, C.squareFill, SQUARE_STROKE(C.squareStroke));
  const ellipse = ellipseNode(
    `ch-e-${c}`,
    center[0],
    center[1],
    L.churnEllipse.width,
    L.churnEllipse.height,
    C.churnEllipse,
  );
  return [path, ellipse];
}

/** Builds the deterministic V-3 script: S0, S1 to S5, R2's edits and N churn cycles. */
export function buildVizV3Script(): VizV3Script {
  const model = new SceneModel();
  for (const node of initialNodes()) model.nodes.set(node.id, node);
  model.root = [...ORDER_ZONE_ROOT, 'ch-persist'];
  model.revision = 1;
  const initial = model.snapshot();
  const steps: VizV3Step[] = [];
  const push = (
    id: string,
    kind: VizV3StepKind,
    ops: Ops,
    cycle: number | null = null,
    churnStep: VizV3ChurnStep | null = null,
  ) => {
    const changes = model.apply(ops);
    steps.push({ id, kind, cycle, churnStep, changes, scene: model.snapshot() });
  };
  const node = (id: string) => model.get(id);

  // Section 3.3: the ordered integration states.
  push('s1', 'order', { updated: [{ ...node('p-circle'), visible: false }] });
  {
    const square = node('p-square');
    if (square.kind !== 'path') throw new Error('p-square');
    push('s2', 'order', {
      updated: [
        { ...node('p-circle'), visible: true },
        {
          ...square,
          style: { fill: C.squareFillS2, stroke: SQUARE_STROKE(C.squareStrokeS2) },
        },
      ],
    });
  }
  {
    let root = moveAfter(model.root, 'r-band', 'bg');
    root = moveAfter(root, 'l-line', 'g-group');
    push('s3', 'order', { orders: [{ parentId: null, children: root }] });
  }
  {
    const group = node('g-group');
    if (group.kind !== 'container') throw new Error('g-group');
    const root = [...model.root.filter((id) => id !== 'g-group'), 'g-group'];
    push('s4', 'order', {
      orders: [
        { parentId: 'g-group', children: [...group.children].reverse() },
        { parentId: null, children: root },
      ],
    });
  }
  {
    let root = swap(model.root, 'p-half', 'r-under');
    root = swap(root, 'r-half', 'p-solid');
    push('s5', 'order', { orders: [{ parentId: null, children: root }] });
  }

  // Section 3.5, R2: X, its inverse before the loss, X inside the loss window, and the inverse
  // once more after recovery so the churn starts from S5's content.
  const s5Root = [...model.root];
  const xRect = rectNode('x-rect', L.xRect.x, L.xRect.y, L.xRect.width, L.xRect.height, C.xRect);
  const edit = (): Ops => {
    const root = [...s5Root.filter((id) => id !== 'r-band'), 'x-rect', 'r-band'];
    return {
      inserted: [xRect],
      updated: [
        withFill(node('p-circle'), C.circleX),
        { ...node('p-star'), visible: false },
        withGeometry(node('p-solid'), 'star'),
      ],
      orders: [{ parentId: null, children: root }],
    };
  };
  const inverse = (): Ops => ({
    removed: ['x-rect'],
    updated: [
      withFill(node('p-circle'), C.circle),
      { ...node('p-star'), visible: true },
      withGeometry(node('p-solid'), 'circle'),
    ],
    orders: [{ parentId: null, children: s5Root }],
  });
  push('r2-x', 'recovery', edit());
  push('r2-x-inverse', 'recovery', inverse());
  push('r2-x-window', 'recovery', edit());
  push('r2-restore', 'recovery', inverse());

  // Section 3.4: the churn script.
  for (let c = 1; c <= VIZ_V3_CHURN.cycles; c += 1) {
    const odd = c % 2 === 1;
    const [path, ellipse] = churnPair(c);
    const pair = odd ? [ellipse.id, path.id] : [path.id, ellipse.id];
    push(
      `churn-${c}-add`,
      'churn',
      {
        inserted: [path, ellipse],
        orders: [{ parentId: null, children: [...model.root, ...pair] }],
      },
      c,
      'add',
    );
    push(
      `churn-${c}-replace`,
      'churn',
      { updated: [withGeometry(node('ch-persist'), odd ? 'circle' : 'star')] },
      c,
      'replace',
    );
    const gone = c === 1 ? [] : [`ch-p-${c - 1}`, `ch-e-${c - 1}`];
    push(
      `churn-${c}-remove`,
      'churn',
      gone.length === 0
        ? {}
        : {
            removed: gone,
            orders: [{ parentId: null, children: model.root.filter((id) => !gone.includes(id)) }],
          },
      c,
      'remove',
    );
  }
  return Object.freeze({ initial, steps: Object.freeze(steps) });
}

export const VIZ_V3_ORDER_STATES = ['s0', 's1', 's2', 's3', 's4', 's5'] as const;
export type VizV3OrderState = (typeof VIZ_V3_ORDER_STATES)[number];

/** The scene of an order state, or of R2's edited state E ('e'). */
export function stateScene(script: VizV3Script, state: VizV3OrderState | 'e'): RenderSceneSnapshot {
  if (state === 's0') return script.initial;
  const id = state === 'e' ? 'r2-x' : state;
  return script.steps.find((step) => step.id === id)!.scene;
}

/** The step id of churn cycle c, step s. */
export const churnStepId = (c: number, step: VizV3ChurnStep) => `churn-${c}-${step}`;

// ---------------------------------------------------------------------------------------------
// Probes, fixed by the probe rule of contract section 4 (at least 2 CSS px + 0.05 from every
// boundary across which the oracle's color changes, band probes at band centres), not by pixels.
// ---------------------------------------------------------------------------------------------

export type VizV3Probe = Readonly<{ name: string; x: number; y: number }>;

export const VIZ_V3_ORDER_PROBES: readonly VizV3Probe[] = [
  { name: 'square fill only', x: 80, y: 80 },
  { name: 'band over square fill', x: 107.5, y: 100 },
  { name: 'band over square stroke', x: 120, y: 100 },
  { name: 'square stroke (top band)', x: 90, y: 70 },
  { name: 'band only', x: 155, y: 100 },
  { name: 'circle over band', x: 200, y: 100 },
  { name: 'circle above band', x: 200, y: 78 },
  { name: 'star centre over dot', x: 380, y: 110 },
  { name: 'dot only', x: 345, y: 110 },
  { name: 'line in right arm', x: 392.5, y: 130 },
  { name: 'line in left arm', x: 367.5, y: 130 },
  { name: 'line only', x: 320, y: 130 },
  { name: 'star top arm', x: 380, y: 80 },
  { name: 'under only', x: 60, y: 260 },
  { name: 'half over under', x: 110, y: 260 },
  { name: 'half only', x: 145, y: 260 },
  { name: 'solid only', x: 265, y: 260 },
  { name: 'half rectangle over solid', x: 298, y: 260 },
  { name: 'half rectangle only', x: 350, y: 260 },
  { name: 'joint fill only', x: 100, y: 400 },
  { name: 'joint stroke over fill', x: 127.5, y: 400 },
  { name: 'joint stroke only', x: 132.5, y: 400 },
  { name: 'joint base only', x: 150, y: 400 },
  { name: 'x-rect site', x: 230, y: 400 },
  { name: 'order background', x: 420, y: 400 },
];

/** Probes whose S4 to S5 colors must separate (VZ3-A5). */
export const VIZ_V3_SWAPPED_PROBES = ['half over under', 'half rectangle over solid'] as const;
/** p-joint's stroke-over-fill band (VZ3-A3's double-opacity separation). */
export const VIZ_V3_JOINT_BAND_PROBE = 'joint stroke over fill';

export const VIZ_V3_CHURN_PROBES: readonly VizV3Probe[] = [
  { name: 'persist centre', x: 600, y: 80 },
  { name: 'persist lower', x: 600, y: 104 },
  { name: 'odd centre', x: 600, y: 240 },
  { name: 'odd ellipse only', x: 560, y: 240 },
  { name: 'odd star arm', x: 600, y: 210 },
  { name: 'even centre', x: 600, y: 390 },
  { name: 'even ellipse only', x: 555, y: 390 },
  { name: 'even fill', x: 600, y: 372 },
  { name: 'even stroke', x: 600, y: 360 },
  { name: 'churn background', x: 700, y: 300 },
];

/** The ids of the order-zone layers (section 3.2), bg included. */
export const VIZ_V3_ORDER_ZONE_IDS: readonly string[] = [
  ...ORDER_ZONE_ROOT,
  'e-dot',
  'p-star',
  'x-rect',
];
