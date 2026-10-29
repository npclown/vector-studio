import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  PathStroke,
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  RendererDiagnostic,
  RendererStatistics,
  SceneClip,
  SceneColor,
  SceneDash,
  SceneGradient,
  ScenePaint,
  ScenePathVerb,
} from '@vector-studio/contracts';
import { RESOURCE_CATEGORIES } from '@vector-studio/contracts';
import type {
  E23GradientPaintApi,
  E23PacketSummary,
} from '../../apps/playground/src/e23-gradient-paint.js';
import {
  elementSource,
  flattenPath,
  type OracleElement,
  type OracleRegion,
  type OracleShape,
  type Premultiplied,
} from '../support/e23-gradient-oracle.js';
import { dashElementSource, dashPath, type OracleDash } from '../support/e24-dash-oracle.js';
import {
  expectedLayeredAt,
  isolationDepth,
  type LayerTree,
  type LeafSource,
} from '../support/e25-layer-oracle.js';
import {
  IDENTITY,
  decodeFrame,
  multiply,
  rotate,
  scale,
  transformPoint,
  translate,
  type Affine,
} from '../support/p4-clip-oracle.js';

declare global {
  interface Window {
    __vectorStudioE23: E23GradientPaintApi;
  }
}

// E25 contract (docs/plans/d9-e25-isolated-opacity-contract.md), unit U4: the headed GPU spec of
// isolated container opacity on the E23 check page with `groups=isolated` (the page's E25 query
// options). Fixtures O1 to O9 (section 6) are composed by the CPU oracle of
// tests/support/e25-layer-oracle.ts from the E23 and E24 element oracles. Interior probes are
// compared within 2/255 plus 1/255 per isolation level, edge probes (pixel centres on an
// axis-aligned rect clip edge, coverage 0.5) within 4/255 plus the same allowance (E25-A03).
// O1's named probes must also differ by more than 24/255 from the descendant-multiplied oracle.
// The criteria tests read the packet summary's layers part, the path port and preparation
// counters, the backend's layer pass count and resource accounting (A04, A06, A07), and O8's
// 2100 × 1300 surface checks the tile seams on hardware (A05). The shared-edge test measures the
// section 8 risk (a layer edge on the same pixel as content under or over it) and reports it
// without failing. Each test writes its report under artifacts/e25-isolated-opacity (or
// E25_OUTPUT_DIR).

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.E25_OUTPUT_DIR ?? 'artifacts/e25-isolated-opacity',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

const INTERIOR_TOLERANCE = 2;
const EDGE_TOLERANCE = 4;
/** E25-A03: O1's named probes must differ from the multiplied oracle by more than this. */
const COUNTER_ORACLE_MARGIN = 24;
const STRIDE = 3;
const CSS = Object.freeze({ width: 512, height: 320 });
const HOME: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };

const RED: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const GREEN: SceneColor = { r: 0, g: 1, b: 0, a: 1 };
const BLUE: SceneColor = { r: 0, g: 0, b: 1, a: 1 };
const WHITE: SceneColor = { r: 1, g: 1, b: 1, a: 1 };
const YELLOW: SceneColor = { r: 1, g: 1, b: 0, a: 1 };
const MAGENTA: SceneColor = { r: 1, g: 0, b: 1, a: 1 };

const gradient = (
  transform: Affine,
  from: SceneColor,
  to: SceneColor,
  kind: SceneGradient['kind'] = 'linear',
): SceneGradient => ({
  kind,
  transform,
  stops: [
    { offset: 0, color: from },
    { offset: 1, color: to },
  ],
  spread: 'pad',
});

/** Offset that puts a world coordinate on a physical pixel centre at zoom 1. */
const half = (dpr: number) => 0.5 / dpr;

// --- Scene builder: render nodes and their oracle tree side by side. ---

/**
 * An oracle leaf. `drop` names one region (an axis-aligned rect clip whose edge an edge probe
 * sits on): a leaf under it is evaluated without it and scaled by `factor`, the clip's coverage
 * on its edge (E25-K2: per leaf, inside the layer).
 */
type BuiltNode =
  | Readonly<{
      kind: 'leaf';
      under: readonly OracleRegion[];
      source: (under: readonly OracleRegion[]) => LeafSource;
    }>
  | Readonly<{ kind: 'group'; opacity: number; children: BuiltNode[] }>;

type Ctx = Readonly<{
  parent: string | null;
  world: Affine;
  under: readonly OracleRegion[];
  out: BuiltNode[];
  ids: string[];
}>;

type PathSpec = Readonly<{
  verbs: readonly ScenePathVerb[];
  points: readonly number[];
  fill: ScenePaint | null;
  stroke: Readonly<{ paint: ScenePaint; width: number; dash?: SceneDash }> | null;
  opacity?: number;
}>;

const scaled = (value: Premultiplied, factor: number): Premultiplied =>
  value.map((lane) => lane * factor) as unknown as Premultiplied;

/** The product of `regions`' coverages at a point: 1, 'none' (0), or null near a boundary. */
function gate(regions: readonly OracleRegion[], wx: number, wy: number, pixelSize: number) {
  if (regions.length === 0) return 1;
  const [first, ...rest] = regions;
  const probe: OracleElement = {
    world: first!.world,
    shape: first!.shape,
    fill: WHITE,
    stroke: null,
    opacity: 1,
    under: rest,
  };
  const value = elementSource(probe, wx, wy, pixelSize);
  return value === null ? null : value === 'none' ? 0 : 1;
}

class Scene {
  readonly nodes: RenderNodeSnapshot[] = [];
  readonly roots: string[] = [];
  readonly built: BuiltNode[] = [];

  root(): Ctx {
    return { parent: null, world: IDENTITY, under: [], out: this.built, ids: this.roots };
  }

  #leaf(ctx: Ctx, node: RenderNodeSnapshot, source: BuiltNode) {
    this.nodes.push(node);
    ctx.ids.push(node.id);
    ctx.out.push(source);
  }

  /** A rectangle or ellipse primitive with a fill. */
  shape(
    ctx: Ctx,
    id: string,
    transform: Affine,
    geometry:
      | Readonly<{ kind: 'rectangle'; width: number; height: number }>
      | Readonly<{ kind: 'ellipse'; width: number; height: number }>,
    fill: ScenePaint,
    opacity = 1,
  ) {
    const world = multiply(ctx.world, transform);
    const element = (under: readonly OracleRegion[]): OracleElement => ({
      world,
      shape: geometry,
      fill,
      stroke: null,
      opacity,
      under,
    });
    this.#leaf(
      ctx,
      {
        id,
        parentId: ctx.parent,
        transform,
        visible: true,
        opacity,
        kind: 'primitive',
        geometry:
          geometry.kind === 'rectangle'
            ? { ...geometry, cornerRadii: [0, 0, 0, 0] as const }
            : { kind: 'ellipse' as const, width: geometry.width, height: geometry.height },
        style: { fill, stroke: null },
      },
      {
        kind: 'leaf',
        under: ctx.under,
        source: (under) => (wx, wy, size) => elementSource(element(under), wx, wy, size),
      },
    );
  }

  /** A path; closed solid strokes use the E23 oracle (round joins), dashed ones E24's. */
  path(ctx: Ctx, id: string, transform: Affine, spec: PathSpec) {
    const world = multiply(ctx.world, transform);
    const opacity = spec.opacity ?? 1;
    const stroke: PathStroke | null =
      spec.stroke === null
        ? null
        : {
            color: spec.stroke.paint,
            width: spec.stroke.width,
            cap: 'butt',
            join: 'round',
            miterLimit: 4,
            dash: spec.stroke.dash ?? null,
          };
    const polygons = flattenPath(spec.verbs, spec.points, 256).filter(
      (polygon) => polygon.length >= 6,
    );
    let source: (under: readonly OracleRegion[]) => LeafSource;
    if (spec.stroke?.dash !== undefined) {
      const dashes: OracleDash[] = dashPath(spec.verbs, spec.points, spec.stroke.dash);
      const element = {
        world,
        fill: spec.fill === null ? null : { paint: spec.fill, polygons },
        stroke: {
          paint: spec.stroke.paint,
          width: spec.stroke.width,
          cap: 'butt' as const,
          dashes,
        },
        opacity,
      };
      source = (under) => (wx, wy, size) => {
        const coverage = gate(under, wx, wy, size);
        if (coverage === null) return null;
        if (coverage === 0) return 'none';
        return dashElementSource(element, wx, wy, size);
      };
    } else {
      const shape: OracleShape = { kind: 'path', polygons };
      source = (under) => (wx, wy, size) =>
        elementSource(
          {
            world,
            shape,
            fill: spec.fill,
            stroke:
              spec.stroke === null ? null : { paint: spec.stroke.paint, width: spec.stroke.width },
            opacity,
            under,
          },
          wx,
          wy,
          size,
        );
    }
    this.#leaf(
      ctx,
      {
        id,
        parentId: ctx.parent,
        transform,
        visible: true,
        opacity,
        kind: 'path',
        geometry: { kind: 'path', verbs: spec.verbs, points: spec.points, fillRule: 'evenodd' },
        style: { fill: spec.fill, stroke },
      },
      { kind: 'leaf', under: ctx.under, source },
    );
  }

  /**
   * A container. A rect clip adds its region to the children's `under`; for a mask, `build`
   * calls `maskSource` first. Returns the clip region, if any.
   */
  group(
    ctx: Ctx,
    id: string,
    transform: Affine,
    opacity: number,
    clip: SceneClip | null,
    build: (inner: Ctx) => void,
    visible = true,
  ): OracleRegion | null {
    const world = multiply(ctx.world, transform);
    const region: OracleRegion | null =
      clip?.kind === 'rect'
        ? {
            world: multiply(world, translate(clip.x, clip.y)),
            shape: { kind: 'rectangle', width: clip.width, height: clip.height },
          }
        : null;
    const children: string[] = [];
    const node = {
      id,
      parentId: ctx.parent,
      transform,
      visible,
      opacity,
      kind: 'container' as const,
      clip,
      children,
    };
    this.nodes.push(node);
    ctx.ids.push(id);
    const built: BuiltNode = { kind: 'group', opacity: visible ? opacity : 0, children: [] };
    ctx.out.push(built);
    build({
      parent: id,
      world,
      under: region === null ? ctx.under : [...ctx.under, region],
      out: built.children,
      ids: children,
    });
    return region;
  }

  /** A mask container's first child: drawn as the mask only. Returns the children's context. */
  maskSource(ctx: Ctx, id: string, transform: Affine, spec: PathSpec): Ctx {
    const polygons = flattenPath(spec.verbs, spec.points, 256).filter(
      (polygon) => polygon.length >= 6,
    );
    this.nodes.push({
      id,
      parentId: ctx.parent,
      transform,
      visible: true,
      opacity: 1,
      kind: 'path',
      geometry: { kind: 'path', verbs: spec.verbs, points: spec.points, fillRule: 'evenodd' },
      style: { fill: WHITE, stroke: null },
    });
    ctx.ids.push(id);
    const region: OracleRegion = {
      world: multiply(ctx.world, transform),
      shape: { kind: 'path', polygons },
    };
    return { ...ctx, under: [...ctx.under, region] };
  }

  snapshot(): RenderSceneSnapshot {
    return {
      identity: { documentId: 'e25-u4', pageId: 'page' },
      revision: 1,
      nodes: this.nodes,
      rootOrder: this.roots,
    };
  }

  /** The oracle tree; with `drop`, leaves under it ignore it and are scaled by `factor`. */
  tree(drop: OracleRegion | null = null, factor = 0.5): LayerTree[] {
    const convert = (nodes: readonly BuiltNode[]): LayerTree[] =>
      nodes.map((node): LayerTree => {
        if (node.kind === 'group')
          return { kind: 'group', opacity: node.opacity, children: convert(node.children) };
        if (drop === null || !node.under.includes(drop))
          return { kind: 'leaf', source: node.source(node.under) };
        const inner = node.source(node.under.filter((region) => region !== drop));
        return {
          kind: 'leaf',
          source: (wx, wy, size) => {
            const value = inner(wx, wy, size);
            return value === null || value === 'none' ? value : scaled(value, factor);
          },
        };
      });
    return convert(this.built);
  }
}

const rect = (width: number, height: number) => ({ kind: 'rectangle' as const, width, height });
const ellipse = (width: number, height: number) => ({ kind: 'ellipse' as const, width, height });

/** A closed polygon path (`move`, `line`s, `close`) for each ring. */
function rings(...polygons: readonly (readonly number[])[]) {
  const verbs: ScenePathVerb[] = [];
  const points: number[] = [];
  for (const polygon of polygons) {
    verbs.push('move');
    for (let index = 2; index < polygon.length; index += 2) verbs.push('line');
    verbs.push('close');
    points.push(...polygon);
  }
  return { verbs, points };
}

const square = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1];

// --- Fixtures. ---

type Edge = Readonly<{ x: number; y: number; rgb: readonly number[]; svg?: readonly number[] }>;
type Named = Readonly<{ name: string; wx: number; wy: number }>;

type Fixture = Readonly<{
  name: string;
  scene: Scene;
  camera: RenderCamera;
  /** Layers each frame must draw. */
  layers: number;
  edges?: readonly Edge[];
  named?: readonly Named[];
  /** Points inside a child but outside an enclosing mask: decided and black. */
  masked?: readonly Named[];
  /** The expected layer bound origin, when the fixture pins it (O8 (b)). */
  origin?: Readonly<{ x: number; y: number }>;
}>;

/** O1; the red rectangle's left edge lies on pixel centres. */
function o1(dpr: number): Scene {
  const scene = new Scene();
  scene.group(scene.root(), 'o1', IDENTITY, 0.5, null, (inner) => {
    scene.shape(inner, 'o1-red', translate(40 + half(dpr), 40), rect(200, 120), RED);
    scene.shape(inner, 'o1-blue', translate(160, 80), ellipse(200, 140), BLUE);
  });
  return scene;
}

function o2(): Scene {
  const scene = new Scene();
  scene.group(scene.root(), 'o2', IDENTITY, 0.6, null, (inner) => {
    scene.path(inner, 'o2-joint', translate(20, 20), {
      ...rings(square(10, 10, 150, 150), square(50, 50, 110, 110)),
      fill: RED,
      stroke: { paint: BLUE, width: 8 },
      opacity: 0.8,
    });
    scene.shape(
      inner,
      'o2-gradient',
      translate(120, 100),
      rect(220, 120),
      gradient([220, 0, 0, 220, 0, 0], GREEN, WHITE),
    );
    scene.path(inner, 'o2-gradient-path', IDENTITY, {
      ...rings([250, 20, 480, 60, 300, 200]),
      fill: gradient([0, 180, -180, 0, 300, 20], YELLOW, MAGENTA),
      stroke: null,
    });
    scene.path(inner, 'o2-dash', IDENTITY, {
      verbs: ['move', 'line', 'line'],
      points: [20, 250, 300, 120, 490, 290],
      fill: null,
      stroke: { paint: WHITE, width: 10, dash: { pattern: [24, 12], phase: 0 } },
    });
  });
  return scene;
}

function o3(): Scene {
  const scene = new Scene();
  scene.group(scene.root(), 'o3-a', IDENTITY, 0.8, null, (a) => {
    scene.shape(a, 'o3-a-red', translate(20, 20), rect(240, 160), RED);
    scene.group(a, 'o3-b', IDENTITY, 0.5, null, (b) => {
      scene.shape(b, 'o3-b-blue', translate(120, 60), ellipse(220, 160), BLUE);
      scene.shape(b, 'o3-b-green', translate(200, 100), rect(160, 120), GREEN);
      scene.group(b, 'o3-c', IDENTITY, 0.5, null, (c) => {
        scene.shape(c, 'o3-c-white', translate(150, 120), rect(200, 100), WHITE);
        scene.shape(c, 'o3-c-yellow', translate(260, 90), ellipse(200, 180), YELLOW);
      });
    });
    scene.shape(a, 'o3-a-magenta', translate(300, 200), rect(180, 100), MAGENTA);
  });
  return scene;
}

function o4(): { scene: Scene; clip: OracleRegion } {
  const scene = new Scene();
  const clip = scene.group(
    scene.root(),
    'o4',
    multiply(translate(256, 160), rotate(30)),
    0.5,
    { kind: 'rect', x: -120, y: -60, width: 240, height: 120 },
    (inner) => {
      scene.shape(inner, 'o4-red', translate(-300, -30), rect(600, 60), RED);
      scene.shape(inner, 'o4-blue', translate(-50, -200), ellipse(100, 400), BLUE);
    },
  )!;
  return { scene, clip };
}

function o5(): Scene {
  const scene = new Scene();
  scene.group(scene.root(), 'o5', IDENTITY, 0.5, { kind: 'mask' }, (inner) => {
    const masked = scene.maskSource(inner, 'o5-source', IDENTITY, {
      ...rings(square(60, 40, 360, 280), square(160, 110, 260, 210)),
      fill: WHITE,
      stroke: null,
    });
    scene.shape(masked, 'o5-red', translate(30, 60), rect(260, 160), RED);
    scene.shape(masked, 'o5-blue', translate(180, 30), ellipse(220, 240), BLUE);
  });
  return scene;
}

/**
 * O6: a layer inside a rect clip and a mask; the clip's left edge is on pixel centres. The mask
 * ellipse cuts both children inside the clip.
 */
function o6(dpr: number): { scene: Scene; clip: OracleRegion; edgeX: number } {
  const scene = new Scene();
  const edgeX = 100 + half(dpr);
  const clip = scene.group(
    scene.root(),
    'o6-clip',
    IDENTITY,
    1,
    { kind: 'rect', x: edgeX, y: 40, width: 300, height: 240 },
    (clipped) => {
      scene.group(clipped, 'o6-mask', IDENTITY, 1, { kind: 'mask' }, (mask) => {
        const masked = scene.maskSource(mask, 'o6-source', IDENTITY, {
          ...rings(
            Array.from({ length: 64 }, (_, index) => {
              const angle = (index / 64) * 2 * Math.PI;
              return [260 + 180 * Math.cos(angle), 160 + 100 * Math.sin(angle)];
            }).flat(),
          ),
          fill: WHITE,
          stroke: null,
        });
        scene.group(masked, 'o6-group', IDENTITY, 0.5, null, (inner) => {
          scene.shape(inner, 'o6-red', translate(60, 60), rect(220, 160), RED);
          scene.shape(inner, 'o6-blue', translate(40, 90), ellipse(200, 140), BLUE);
        });
      });
    },
  )!;
  return { scene, clip, edgeX };
}

/** O8 (a) and (b): a two-shape layer; (a) moves the camera, (b) moves the group. */
function o8(transform: Affine = IDENTITY): Scene {
  const scene = new Scene();
  scene.group(scene.root(), 'o8', transform, 0.5, null, (inner) => {
    scene.shape(inner, 'o8-red', IDENTITY, rect(200, 120), RED);
    scene.shape(inner, 'o8-blue', translate(100, 40), ellipse(200, 120), BLUE);
  });
  return scene;
}

/**
 * Edge probes on a shape's vertical edge `wx` (on pixel centres) inside a layer over black: where
 * the left side is black, the composite is linear in the leaf, so the edge pixel is half the
 * right side's value.
 */
function shapeEdgeProbes(scene: Scene, wx: number, y0: number, y1: number, dpr: number) {
  const tree = scene.tree();
  const edges: Edge[] = [];
  const column = Math.round(wx * dpr - 0.5);
  for (let row = Math.ceil(y0 * dpr); row < y1 * dpr; row += 5) {
    const wy = (row + 0.5) / dpr;
    const left = expectedLayeredAt(tree, wx - 3 / dpr, wy, 1 / dpr);
    const right = expectedLayeredAt(tree, wx + 3 / dpr, wy, 1 / dpr);
    if (left !== null && right !== null && left.every((value) => value === 0))
      edges.push({ x: column, y: row, rgb: right.map((value) => value / 2) });
  }
  return edges;
}

/** Device-space edge probes on a rect clip's vertical edge `wx`, which lies on pixel centres. */
function edgeProbes(
  scene: Scene,
  drop: OracleRegion,
  wx: number,
  y0: number,
  y1: number,
  dpr: number,
) {
  const tree = scene.tree(drop, 0.5);
  const unclipped = scene.tree(drop, 1);
  const edges: Edge[] = [];
  const column = Math.round(wx * dpr - 0.5);
  for (let row = Math.ceil(y0 * dpr); row < y1 * dpr; row += 5) {
    const wy = (row + 0.5) / dpr;
    const expected = expectedLayeredAt(tree, wx, wy, 1 / dpr);
    const whole = expectedLayeredAt(unclipped, wx, wy, 1 / dpr);
    // SVG's model clips the group result instead: k · (the unclipped result) over black.
    if (expected !== null && whole !== null)
      edges.push({ x: column, y: row, rgb: expected, svg: whole.map((value) => value * 0.5) });
  }
  return edges;
}

function fixtures(dpr: number): Fixture[] {
  const list: Fixture[] = [
    {
      name: 'O1',
      scene: o1(dpr),
      camera: HOME,
      layers: 1,
      edges: shapeEdgeProbes(o1(dpr), 40 + half(dpr), 44, 156, dpr),
      named: [
        { name: 'overlap-a', wx: 200, wy: 130 },
        { name: 'overlap-b', wx: 220, wy: 120 },
        { name: 'overlap-c', wx: 230, wy: 150 },
      ],
    },
    { name: 'O2', scene: o2(), camera: HOME, layers: 1 },
    { name: 'O3', scene: o3(), camera: HOME, layers: 3 },
    { name: 'O4', scene: o4().scene, camera: HOME, layers: 1 },
    { name: 'O5', scene: o5(), camera: HOME, layers: 1 },
  ];
  const six = o6(dpr);
  list.push({
    name: 'O6',
    scene: six.scene,
    camera: HOME,
    layers: 1,
    edges: edgeProbes(six.scene, six.clip, six.edgeX, 44, 276, dpr),
    masked: [
      { name: 'red-outside-mask-a', wx: 110, wy: 70 },
      { name: 'red-outside-mask-b', wx: 115, wy: 75 },
    ],
  });
  // O8 (a): half off the target's left edge at zoom 0.25 and 8; at zoom 8 the group is scaled
  // by 1/8 so that it still straddles the edge (its centre is the world point (150, 80) · s).
  for (const [zoom, factor] of [
    [0.25, 1],
    [8, 0.125],
  ] as const) {
    list.push({
      name: `O8 half off zoom ${zoom}`,
      scene: o8(scale(factor)),
      camera: {
        position: { x: 150 * factor, y: 80 * factor - CSS.height / (2 * zoom) },
        zoom,
      },
      layers: 1,
    });
  }
  // O8 (b): an odd device offset. The widened bound's origin is odd, (38, 22) · dpr − 1, so
  // E25-K5 step 4 moves it down to (38, 22) · dpr − 2. The red left edge lies on pixel centres.
  const odd = o8(translate(38 + half(dpr), 22 + half(dpr)));
  list.push({
    name: 'O8 odd offset',
    scene: odd,
    camera: HOME,
    layers: 1,
    origin: { x: 38 * dpr - 2, y: 22 * dpr - 2 },
    edges: shapeEdgeProbes(odd, 38 + half(dpr), 26, 138, dpr),
  });
  return list;
}

// --- Page and comparison. ---

function reporter(name: string, info: { project: { name: string } }) {
  const directory = path.join(runRoot, info.project.name, name);
  mkdirSync(directory, { recursive: true });
  return (file: string, data: string) =>
    writeFileSync(path.join(directory, file), data, { flag: 'wx' });
}

type PageOptions = Readonly<{ dpr: number; samples?: 1 | 4; isolate?: boolean; tile?: number }>;

async function open(page: Page, options: PageOptions) {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 800 });
  const query = new URLSearchParams({
    samples: String(options.samples ?? 4),
    dpr: String(options.dpr),
    groups: 'isolated',
  });
  if (options.isolate === true) query.set('isolate', '1');
  if (options.tile !== undefined) query.set('tile', String(options.tile));
  await page.goto(`/e23-gradient-paint.html?${query.toString()}`);
  const ready = await page.evaluate(() => window.__vectorStudioE23.ready);
  expect(ready.supported, JSON.stringify(ready)).toBe(true);
  return { ready, pageErrors };
}

async function render(page: Page, snapshot: RenderSceneSnapshot, camera: RenderCamera) {
  const result = await page.evaluate(
    ([scene, view]) => window.__vectorStudioE23.render(scene, view),
    [snapshot, camera] as const,
  );
  return { result, rgba: decodeFrame(result.frame.rgbaBase64) };
}

type Rendered = Awaited<ReturnType<typeof render>>;

const pixelAt = (rendered: Rendered, x: number, y: number) => {
  const at = (y * rendered.result.frame.width + x) * 4;
  return [rendered.rgba[at]!, rendered.rgba[at + 1]!, rendered.rgba[at + 2]!];
};

const worstLane = (a: readonly number[], b: readonly number[]) =>
  Math.max(...[0, 1, 2].map((lane) => Math.abs(a[lane]! - b[lane]!)));

type Probe = Readonly<{ x: number; y: number }>;

/** Compares probes with the oracle tree; probes default to every STRIDE-th pixel. */
function compare(
  rendered: Rendered,
  name: string,
  tree: readonly LayerTree[],
  camera: RenderCamera,
  dpr: number,
  probes?: Iterable<Probe>,
) {
  const { width, height } = rendered.result.frame;
  const scaleFactor = camera.zoom * dpr;
  const tolerance = INTERIOR_TOLERANCE + isolationDepth(tree);
  const failures: string[] = [];
  let count = 0;
  let worst = 0;
  const grid = function* (): Iterable<Probe> {
    for (let y = 2; y < height - 2; y += STRIDE)
      for (let x = 2; x < width - 2; x += STRIDE) yield { x, y };
  };
  for (const { x, y } of probes ?? grid()) {
    const wx = camera.position.x + (x + 0.5) / scaleFactor;
    const wy = camera.position.y + (y + 0.5) / scaleFactor;
    const expected = expectedLayeredAt(tree, wx, wy, 1 / scaleFactor);
    if (expected === null) continue;
    count += 1;
    const got = pixelAt(rendered, x, y);
    const difference = worstLane(got, expected);
    worst = Math.max(worst, difference);
    if (difference > tolerance && failures.length < 12)
      failures.push(
        `${name} interior (${x}, ${y}): ${got.join(',')} vs ${expected.map((v) => v.toFixed(2)).join(',')}`,
      );
  }
  return { probes: count, worst, tolerance, failures };
}

type Allowance = (diagnostic: RendererDiagnostic) => boolean;

/**
 * P3's fringe work cap on O2's strokes draws them without their fringe; interior probes hold.
 * Only those two strokes may raise it.
 */
const fringeCap: Allowance = (diagnostic) => {
  const context = diagnostic.context as Record<string, unknown> | undefined;
  return (
    diagnostic.code === 'render.path-mesh-failure' &&
    context?.failureCode === 'fringe-work-cap' &&
    context.paint === 'stroke' &&
    (context.nodeId === 'o2-joint' || context.nodeId === 'o2-dash')
  );
};

function unexpected(diagnostics: readonly RendererDiagnostic[], ...allowed: Allowance[]) {
  return diagnostics
    .filter((diagnostic) => !allowed.some((allow) => allow(diagnostic)))
    .map((diagnostic) => `diagnostic ${diagnostic.code} ${JSON.stringify(diagnostic.context)}`);
}

function layerCheck(packet: E23PacketSummary | null, name: string, expected: number) {
  const drawn = packet?.layers?.layers.length ?? 0;
  return drawn === expected ? [] : [`${name}: ${drawn} layers, expected ${expected}`];
}

function resources(statistics: RendererStatistics) {
  return Object.fromEntries(
    RESOURCE_CATEGORIES.map((category) => {
      const entry = statistics.resources.byCategory[category];
      return [category, { live: entry.live, bytes: entry.liveBytes }];
    }),
  );
}

// --- E25-A03: O1 to O6 and O8 (a), (b) against the oracle. ---

for (const samples of [4, 1] as const) {
  for (const dpr of [1, 2]) {
    test(`E25-A03 O1 to O8 against the oracle at ${samples}x, DPR ${dpr}`, async ({
      page,
    }, info) => {
      test.setTimeout(600_000);
      const report = reporter(`a03-${samples}x-dpr-${dpr}`, info);
      const { ready, pageErrors } = await open(page, { dpr, samples });
      const rows: unknown[] = [];
      const failures: string[] = [];
      for (const fixture of fixtures(dpr)) {
        const tree = fixture.scene.tree();
        const rendered = await render(page, fixture.scene.snapshot(), fixture.camera);
        const packet = rendered.result.frame.packet;
        if (rendered.result.status !== 'applied')
          failures.push(`${fixture.name}: ${rendered.result.status}`);
        const outcome = compare(rendered, fixture.name, tree, fixture.camera, dpr);
        if (outcome.probes < 50) failures.push(`${fixture.name}: only ${outcome.probes} probes`);
        failures.push(...outcome.failures, ...layerCheck(packet, fixture.name, fixture.layers));
        const edgeTolerance = EDGE_TOLERANCE + isolationDepth(tree);
        const edgeRows = (fixture.edges ?? []).map((edge) => {
          const got = pixelAt(rendered, edge.x, edge.y);
          const difference = worstLane(got, edge.rgb);
          if (difference > edgeTolerance)
            failures.push(
              `${fixture.name} edge (${edge.x}, ${edge.y}): ${got.join(',')} vs ${edge.rgb.map((v) => v.toFixed(2)).join(',')}`,
            );
          return {
            x: edge.x,
            y: edge.y,
            got,
            expected: edge.rgb,
            difference,
            svgDifference: edge.svg === undefined ? null : worstLane(got, edge.svg),
          };
        });
        if (fixture.edges !== undefined && edgeRows.length < 10)
          failures.push(`${fixture.name}: only ${edgeRows.length} edge probes`);
        const namedRows = (fixture.named ?? []).map((probe) => {
          const scaleFactor = fixture.camera.zoom * dpr;
          const x = Math.floor((probe.wx - fixture.camera.position.x) * scaleFactor);
          const y = Math.floor((probe.wy - fixture.camera.position.y) * scaleFactor);
          const wx = fixture.camera.position.x + (x + 0.5) / scaleFactor;
          const wy = fixture.camera.position.y + (y + 0.5) / scaleFactor;
          const isolated = expectedLayeredAt(tree, wx, wy, 1 / scaleFactor);
          const multiplied = expectedLayeredAt(tree, wx, wy, 1 / scaleFactor, 'multiplied');
          const got = pixelAt(rendered, x, y);
          if (isolated === null || multiplied === null) {
            failures.push(`${fixture.name} ${probe.name}: undecided`);
            return { name: probe.name, got };
          }
          const apart = worstLane(got, multiplied);
          if (worstLane(got, isolated) > outcome.tolerance)
            failures.push(
              `${fixture.name} ${probe.name}: ${got.join(',')} vs ${isolated.join(',')}`,
            );
          if (!(apart > COUNTER_ORACLE_MARGIN))
            failures.push(
              `${fixture.name} ${probe.name}: only ${apart} from the multiplied oracle`,
            );
          return { name: probe.name, x, y, got, isolated, multiplied, apart };
        });
        if (fixture.name === 'O4') {
          // B_g is bounded by the rotated clip's device AABB (widened 1 px, rounded out, even).
          const { clip } = o4();
          const corners = [
            [0, 0],
            [240, 0],
            [240, 120],
            [0, 120],
          ].map(([x, y]) => transformPoint(clip.world, x!, y!));
          const xs = corners.map(([x]) => x * dpr);
          const ys = corners.map(([, y]) => y * dpr);
          const bound = packet?.layers?.layers[0]?.bound;
          if (
            bound === undefined ||
            bound.x < Math.min(...xs) - 4 ||
            bound.y < Math.min(...ys) - 4 ||
            bound.x + bound.width > Math.max(...xs) + 4 ||
            bound.y + bound.height > Math.max(...ys) + 4
          )
            failures.push(
              `O4 bound ${JSON.stringify(bound)} beyond the clip ${JSON.stringify({ xs, ys })}`,
            );
        }
        if (fixture.name.startsWith('O8')) {
          const bound = packet?.layers?.layers[0]?.bound;
          if (
            bound === undefined ||
            [bound.x, bound.y, bound.width, bound.height].some((value) => value % 2 !== 0)
          )
            failures.push(`${fixture.name} bound not even ${JSON.stringify(bound)}`);
          if (
            fixture.origin !== undefined &&
            (bound?.x !== fixture.origin.x || bound.y !== fixture.origin.y)
          )
            failures.push(
              `${fixture.name} bound origin ${JSON.stringify(bound)}, expected ${JSON.stringify(fixture.origin)}`,
            );
        }
        const maskedRows = (fixture.masked ?? []).map((probe) => {
          const x = Math.floor(probe.wx * dpr);
          const y = Math.floor(probe.wy * dpr);
          const expected = expectedLayeredAt(tree, (x + 0.5) / dpr, (y + 0.5) / dpr, 1 / dpr);
          const got = pixelAt(rendered, x, y);
          if (expected === null || worstLane(expected, [0, 0, 0]) !== 0)
            failures.push(`${fixture.name} ${probe.name}: oracle ${JSON.stringify(expected)}`);
          else if (worstLane(got, expected) > outcome.tolerance)
            failures.push(`${fixture.name} ${probe.name}: ${got.join(',')} is not masked out`);
          return { name: probe.name, x, y, got };
        });
        rows.push({
          fixture: fixture.name,
          probes: outcome.probes,
          worst: outcome.worst,
          tolerance: outcome.tolerance,
          edges: edgeRows,
          named: namedRows,
          masked: maskedRows,
          packet,
        });
      }
      const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
      failures.push(...unexpected(diagnostics, fringeCap));
      report(
        'report.json',
        JSON.stringify({ ready, samples, dpr, rows, diagnostics, pageErrors, failures }, null, 2),
      );
      expect(pageErrors).toEqual([]);
      expect(failures).toEqual([]);
    });
  }
}

// --- E25-A05 on hardware: O8 (c), a layer of 2 × 2 tiles on a 2100 × 1300 surface at DPR 2. ---

for (const samples of [4, 1] as const) {
  test(`E25-A05 O8 tile seams on a 2100 x 1300 surface at ${samples}x`, async ({ page }, info) => {
    test.setTimeout(600_000);
    const report = reporter(`a05-seams-${samples}x`, info);
    const { pageErrors } = await open(page, { dpr: 1, samples });
    const scene = new Scene();
    scene.group(scene.root(), 'o8-wide', translate(100.25, 100.75), 0.5, null, (inner) => {
      scene.shape(inner, 'o8-wide-red', IDENTITY, rect(900, 700), RED);
      scene.shape(inner, 'o8-wide-blue', translate(300, 200), ellipse(600, 500), BLUE);
      scene.shape(
        inner,
        'o8-wide-gradient',
        translate(450, 300),
        rect(400, 300),
        gradient([400, 0, 0, 400, 0, 0], GREEN, WHITE),
      );
    });
    const tree = scene.tree();
    await page.evaluate(([snapshot, camera]) => window.__vectorStudioE23.show(snapshot, camera), [
      scene.snapshot(),
      HOME,
    ] as const);
    const resized = await page.evaluate(() => window.__vectorStudioE23.resize(2100, 1300, 2));
    const rendered: Rendered = {
      result: { ...resized, status: 'applied' } as unknown as Rendered['result'],
      rgba: decodeFrame(resized.frame.rgbaBase64),
    };
    const failures: string[] = [];
    const bound = resized.frame.packet?.layers?.layers[0]?.bound;
    if (bound === undefined || bound.width <= 1024 || bound.height <= 1024)
      failures.push(`layer does not span 2 x 2 tiles: ${JSON.stringify(bound)}`);
    // Seam bands: 4 px either side of every tile seam inside the bound, plus a coarse grid.
    const probes: Probe[] = [];
    if (bound !== undefined) {
      for (let seam = bound.x + 1024; seam < bound.x + bound.width; seam += 1024)
        for (let x = seam - 4; x < seam + 4; x += 1)
          for (let y = bound.y; y < bound.y + bound.height; y += 2) probes.push({ x, y });
      for (let seam = bound.y + 1024; seam < bound.y + bound.height; seam += 1024)
        for (let y = seam - 4; y < seam + 4; y += 1)
          for (let x = bound.x; x < bound.x + bound.width; x += 2) probes.push({ x, y });
    }
    const seams = compare(rendered, 'O8 seams', tree, HOME, 2, probes);
    const coarse: Probe[] = [];
    for (let y = 1; y < resized.frame.height; y += 11)
      for (let x = 1; x < resized.frame.width; x += 11) coarse.push({ x, y });
    const grid = compare(rendered, 'O8 wide', tree, HOME, 2, coarse);
    if (seams.probes < 1000) failures.push(`only ${seams.probes} seam probes`);
    failures.push(...seams.failures, ...grid.failures);
    const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
    failures.push(...unexpected(diagnostics));
    const layerPasses = resized.counters.layerPasses;
    report(
      'report.json',
      JSON.stringify(
        {
          samples,
          frame: { width: resized.frame.width, height: resized.frame.height },
          bound,
          seams: { probes: seams.probes, worst: seams.worst, tolerance: seams.tolerance },
          grid: { probes: grid.probes, worst: grid.worst },
          layerPasses,
          diagnostics,
          pageErrors,
          failures,
        },
        null,
        2,
      ),
    );
    expect(pageErrors).toEqual([]);
    expect(failures).toEqual([]);
  });
}

// --- O7 extremes. ---

test('E25-A03 O7 opacity 0 and opacity 1', async ({ page }, info) => {
  const report = reporter('o7', info);
  const { pageErrors } = await open(page, { dpr: 1 });
  const failures: string[] = [];
  const children = (scene: Scene, ctx: Ctx, prefix: string) => {
    scene.shape(ctx, `${prefix}-red`, translate(40, 40), rect(200, 120), RED);
    scene.path(ctx, `${prefix}-path`, IDENTITY, {
      ...rings(square(150, 60, 330, 220)),
      fill: BLUE,
      stroke: null,
    });
  };
  // Opacity 0: no layer pass and no path request; the sibling still draws.
  const hidden = new Scene();
  hidden.group(hidden.root(), 'o7-zero', IDENTITY, 0, null, (inner) =>
    children(hidden, inner, 'o7-zero'),
  );
  hidden.shape(hidden.root(), 'o7-sibling', translate(300, 200), rect(150, 80), GREEN);
  const before = await page.evaluate(() => window.__vectorStudioE23.counters());
  const zero = await render(page, hidden.snapshot(), HOME);
  const after = zero.result.counters;
  const passes = after.layerPasses - before.layerPasses;
  const portCalls = (after.pathMesh?.portCalls ?? 0) - (before.pathMesh?.portCalls ?? 0);
  if (passes !== 0 || portCalls !== 0)
    failures.push(`opacity 0: ${passes} layer passes, ${portCalls} port calls`);
  if (zero.result.frame.packet?.layers !== null)
    failures.push(`opacity 0 layers part ${JSON.stringify(zero.result.frame.packet?.layers)}`);
  const zeroOutcome = compare(zero, 'O7 zero', hidden.tree(), HOME, 1);
  failures.push(...zeroOutcome.failures);
  // Opacity 1 and the identity transform: no layer, byte-identical to the children at the root.
  const unit = new Scene();
  unit.group(unit.root(), 'o7-one', IDENTITY, 1, null, (inner) => children(unit, inner, 'o7-one'));
  const flat = new Scene();
  children(flat, flat.root(), 'o7-flat');
  const grouped = await render(page, unit.snapshot(), HOME);
  const direct = await render(page, flat.snapshot(), HOME);
  if (grouped.result.frame.packet?.layers !== null)
    failures.push(`opacity 1 layers part ${JSON.stringify(grouped.result.frame.packet?.layers)}`);
  const identical = Buffer.compare(Buffer.from(grouped.rgba), Buffer.from(direct.rgba)) === 0;
  if (!identical) failures.push('opacity 1 differs from the children at the root');
  const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
  failures.push(...unexpected(diagnostics));
  report(
    'report.json',
    JSON.stringify(
      { passes, portCalls, zero: zeroOutcome.probes, identical, diagnostics, pageErrors, failures },
      null,
      2,
    ),
  );
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

// --- E25-A07: O9 budget at 3840 × 2160 and 4x. ---

test('E25-A07 O9 layer budget on a 3840 x 2160 surface at 4x', async ({ page }, info) => {
  test.setTimeout(600_000);
  const report = reporter('a07-o9', info);
  const { pageErrors } = await open(page, { dpr: 1, samples: 4 });
  const failures: string[] = [];
  const full = rect(3840, 2160);
  /**
   * Tree A (three nested containers at 0.5, red; its root at `aRoot`), a green leaf, then, with
   * `withB`, tree B (two nested containers at 0.5, blue). The unit test of U2 has the same parts.
   */
  const budgetScene = (aRoot: number, withB: boolean) => {
    const scene = new Scene();
    const nest = (
      ctx: Ctx,
      prefix: string,
      level: number,
      opacities: readonly number[],
      paint: SceneColor,
    ) => {
      scene.group(ctx, `${prefix}-${level}`, IDENTITY, opacities[level]!, null, (inner) => {
        if (level + 1 < opacities.length) nest(inner, prefix, level + 1, opacities, paint);
        else scene.shape(inner, `${prefix}-leaf`, IDENTITY, full, paint);
      });
    };
    nest(scene.root(), 'a', 0, [aRoot, 0.5, 0.5], RED);
    scene.shape(scene.root(), 'leaf', translate(100, 100), rect(400, 300), GREEN);
    if (withB) nest(scene.root(), 'b', 0, [0.5, 0.5], BLUE);
    return scene;
  };
  const limits = (diagnostics: readonly RendererDiagnostic[]) =>
    diagnostics.filter((diagnostic) => diagnostic.code === 'render.layer-resource-limit');
  /** The expected image: the trees listed in `drawn` with the leaf, over black. */
  const sparse: Probe[] = [];
  const parts: unknown[] = [];
  const check = async (
    name: string,
    scene: Scene,
    drawn: readonly string[],
    notices: readonly string[],
  ) => {
    const before = limits(await page.evaluate(() => window.__vectorStudioE23.diagnostics())).length;
    const rendered = await render(page, scene.snapshot(), HOME);
    if (rendered.result.status !== 'applied') failures.push(`${name}: ${rendered.result.status}`);
    const after = limits(await page.evaluate(() => window.__vectorStudioE23.diagnostics()));
    const fresh = after
      .slice(before)
      .map((diagnostic) => (diagnostic.context as { nodeId: string }).nodeId);
    if (JSON.stringify(fresh) !== JSON.stringify(notices))
      failures.push(
        `${name}: notices ${JSON.stringify(fresh)}, expected ${JSON.stringify(notices)}`,
      );
    const packet = rendered.result.frame.packet;
    const layered = (packet?.layers?.layers ?? []).map((layer) => layer.nodeId);
    const roots = [...new Set(layered.map((id) => id.split('-')[0]!))].sort();
    if (JSON.stringify(roots) !== JSON.stringify([...drawn].sort()))
      failures.push(
        `${name}: layers ${JSON.stringify(layered)}, expected trees ${drawn.join(',')}`,
      );
    // The oracle without the trees the budget left out.
    const kept = scene.tree().filter((_, index) => {
      const id = scene.roots[index]!;
      return id === 'leaf' || drawn.includes(id.split('-')[0]!);
    });
    const outcome = compare(rendered, name, kept, HOME, 1, sparse);
    failures.push(...outcome.failures);
    const statistics = rendered.result.counters.statistics;
    parts.push({
      name,
      fresh,
      layered,
      packetNotices: packet?.layers?.notices ?? null,
      probes: outcome.probes,
      worst: outcome.worst,
      peakLiveBytes: Object.fromEntries(
        RESOURCE_CATEGORIES.map((category) => [
          category,
          statistics.resources.byCategory[category].peakLiveBytes,
        ]),
      ),
      totalPeakLiveBytes: statistics.resources.peakLiveBytes,
    });
  };
  // A resize captures a frame, which needs a scene: a lone leaf first.
  const lone = new Scene();
  lone.shape(lone.root(), 'leaf', translate(100, 100), rect(400, 300), GREEN);
  await page.evaluate(([snapshot, camera]) => window.__vectorStudioE23.show(snapshot, camera), [
    lone.snapshot(),
    HOME,
  ] as const);
  await page.evaluate(() => window.__vectorStudioE23.resize(3840, 2160, 1));
  for (let y = 7; y < 2160; y += 53) for (let x = 7; x < 3840; x += 53) sparse.push({ x, y });
  // Part 1: tree A of three layers is not drawn and reports once; the leaf and tree B draw.
  await check('part 1', budgetScene(0.5, true), ['b'], ['a-0']);
  await check('part 1 again', budgetScene(0.5, true), ['b'], []);
  // Part 2: A's root at opacity 1 leaves two layers, which fit; B no longer fits and reports.
  await check('part 2', budgetScene(1, true), ['a'], ['b-0']);
  // A alone: over the budget again, a new transition and a new notice; then none once A's root
  // returns to opacity 1.
  await check('part 3', budgetScene(0.5, false), [], ['a-0']);
  await check('part 4', budgetScene(1, false), ['a'], []);
  const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
  failures.push(
    ...unexpected(diagnostics, (diagnostic) => diagnostic.code === 'render.layer-resource-limit'),
  );
  report('report.json', JSON.stringify({ parts, diagnostics, pageErrors, failures }, null, 2));
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

// --- E25-A04: invalidation and pass counters. ---

test('E25-A04 opacity edits, visibility, pan and layer passes', async ({ page }, info) => {
  const report = reporter('a04', info);
  const { pageErrors } = await open(page, { dpr: 1 });
  const failures: string[] = [];
  const counters = () => page.evaluate(() => window.__vectorStudioE23.counters());
  const show = (scene: Scene, camera: RenderCamera = HOME) =>
    page.evaluate(([snapshot, view]) => window.__vectorStudioE23.show(snapshot, view), [
      scene.snapshot(),
      camera,
    ] as const);
  /** A change set that updates only the scene's container (its first node). */
  const edit = async (scene: Scene) => {
    const edited = await page.evaluate(
      ([identity, node]) => window.__vectorStudioE23.edit(identity, [node]),
      [scene.snapshot().identity, scene.nodes[0]!] as const,
    );
    if (edited.status !== 'applied') failures.push(`edit ${scene.nodes[0]!.id}: ${edited.status}`);
    return edited;
  };
  type Counters = Awaited<ReturnType<typeof counters>>;
  const cost = (before: Counters, after: Counters) => ({
    portCalls: (after.pathMesh?.portCalls ?? 0) - (before.pathMesh?.portCalls ?? 0),
    strokePortCalls:
      (after.pathMesh?.strokePortCalls ?? 0) - (before.pathMesh?.strokePortCalls ?? 0),
    geometryBuilds: after.preparation.geometryBuilds - before.preparation.geometryBuilds,
  });
  const free = (value: ReturnType<typeof cost>) =>
    value.portCalls === 0 && value.strokePortCalls === 0 && value.geometryBuilds === 0;
  const edited = (prefix: string, opacity: number, visible = true) => {
    const scene = new Scene();
    scene.group(
      scene.root(),
      `${prefix}-group`,
      IDENTITY,
      opacity,
      null,
      (inner) => {
        scene.shape(inner, `${prefix}-red`, translate(40, 40), rect(200, 120), RED);
        scene.path(inner, `${prefix}-path`, IDENTITY, {
          ...rings(square(150, 60, 330, 220)),
          fill: BLUE,
          stroke: { paint: WHITE, width: 4 },
        });
      },
      visible,
    );
    return scene;
  };
  const rows: Record<string, unknown> = {};
  // Opacity edits on an isolated container, as change sets: 0.5 → 0.7, 1 → 0.5 and 0.5 → 1.
  // These are change sets, as in U2's unit test: a replaced snapshot rebuilds primitive records.
  for (const [from, to] of [
    [0.5, 0.7],
    [1, 0.5],
    [0.5, 1],
  ] as const) {
    const prefix = `edit-${from}-${to}`;
    await show(edited(prefix, from));
    const before = await counters();
    const shown = await edit(edited(prefix, to));
    const value = cost(before, shown.counters);
    const opacity = shown.packet?.layers?.layers[0]?.opacity ?? null;
    rows[prefix] = { ...value, opacity };
    if (!free(value)) failures.push(`${prefix}: ${JSON.stringify(value)}`);
    if (opacity !== (to === 1 ? null : to)) failures.push(`${prefix}: layer opacity ${opacity}`);
  }
  // 0 → 0.5 costs what visible false → true costs, on fresh ids each.
  await show(edited('from-zero', 0));
  const zeroBefore = await counters();
  const fromZero = cost(zeroBefore, (await edit(edited('from-zero', 0.5))).counters);
  await show(edited('from-hidden', 0.5, false));
  const hiddenBefore = await counters();
  const fromHidden = cost(hiddenBefore, (await edit(edited('from-hidden', 0.5))).counters);
  rows.fromZero = fromZero;
  rows.fromHidden = fromHidden;
  if (JSON.stringify(fromZero) !== JSON.stringify(fromHidden) || fromZero.portCalls === 0)
    failures.push(`0 → 0.5 ${JSON.stringify(fromZero)} vs visible ${JSON.stringify(fromHidden)}`);
  // Pan and zoom cost the same with the container at 0.5 as at 1.
  const panCost = async (opacity: number) => {
    await show(edited(`pan-${opacity}`, opacity));
    const before = await counters();
    await page.evaluate(() =>
      window.__vectorStudioE23.pan({ position: { x: 13, y: -7 }, zoom: 1 }),
    );
    await page.evaluate(() =>
      window.__vectorStudioE23.pan({ position: { x: 13, y: -7 }, zoom: 1.5 }),
    );
    return cost(before, await counters());
  };
  const panLayer = await panCost(0.5);
  const panPlain = await panCost(1);
  rows.pan = { layer: panLayer, plain: panPlain };
  if (JSON.stringify(panLayer) !== JSON.stringify(panPlain))
    failures.push(`pan ${JSON.stringify(panLayer)} vs ${JSON.stringify(panPlain)}`);
  // layerPasses: one per drawn layer per submitted frame (O3: three layers).
  await show(o3());
  const passBefore = await counters();
  for (const x of [5, 10, 15])
    await page.evaluate(
      (position) => window.__vectorStudioE23.pan({ position: { x: position, y: 0 }, zoom: 1 }),
      x,
    );
  const passAfter = await counters();
  const frames = passAfter.statistics.framesSubmitted - passBefore.statistics.framesSubmitted;
  const passes = passAfter.layerPasses - passBefore.layerPasses;
  rows.passes = { frames, passes };
  if (frames < 3 || passes !== 3 * frames)
    failures.push(`layer passes ${passes} over ${frames} frames, expected 3 per frame`);
  const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
  failures.push(...unexpected(diagnostics));
  report('report.json', JSON.stringify({ rows, diagnostics, pageErrors, failures }, null, 2));
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

// --- E25-A06: resources. ---

test('E25-A06 layer resources in accounting, after removal, device loss and disposal', async ({
  page,
}, info) => {
  const report = reporter('a06', info);
  const { pageErrors } = await open(page, { dpr: 1 });
  const failures: string[] = [];
  const plain = new Scene();
  plain.shape(plain.root(), 'a06-solid', translate(10, 10), rect(100, 60), GREEN);
  const baselineFrame = await render(page, plain.snapshot(), HOME);
  const baseline = resources(baselineFrame.result.counters.statistics);
  const createdBefore =
    baselineFrame.result.counters.statistics.resources.byCategory.texture.created;
  const baselineTextures = baselineFrame.result.counters.statistics.resources.byCategory.texture;
  const layered = await render(page, o3().snapshot(), HOME);
  const textures = layered.result.counters.statistics.resources.byCategory.texture;
  // The three layer textures and the tile set (colour, resolve and stencil at 4x) are accounted:
  // the peak holds all of them at once, at section 4's sizes.
  const bounds = layered.result.frame.packet?.layers?.layers.map((layer) => layer.bound) ?? [];
  // Section 4: the tile set is min(T, widest layer) × min(T, tallest layer) × 24 bytes at 4x.
  const tile = {
    width: Math.min(1024, Math.max(0, ...bounds.map((bound) => bound.width))),
    height: Math.min(1024, Math.max(0, ...bounds.map((bound) => bound.height))),
  };
  const layerBytes =
    bounds.reduce((sum, bound) => sum + bound.width * bound.height * 4, 0) +
    tile.width * tile.height * 24;
  if (bounds.length !== 3) failures.push(`O3 drew ${bounds.length} layers`);
  if (textures.created < createdBefore + 6)
    failures.push(`layer textures not in accounting: ${createdBefore} → ${textures.created}`);
  if (textures.peakLiveBytes < baselineTextures.liveBytes + layerBytes)
    failures.push(
      `texture peak ${textures.peakLiveBytes} below ${baselineTextures.liveBytes} + ${layerBytes}`,
    );
  // Released after submission: the layered frame's own accounting is back at the baseline.
  if (textures.live !== baselineTextures.live || textures.liveBytes !== baselineTextures.liveBytes)
    failures.push(`layered frame live textures ${JSON.stringify({ textures, baselineTextures })}`);
  const afterRemoval = resources(
    (await render(page, plain.snapshot(), HOME)).result.counters.statistics,
  );
  if (JSON.stringify(afterRemoval) !== JSON.stringify(baseline))
    failures.push(`after removal ${JSON.stringify({ baseline, afterRemoval })}`);
  const preLoss = await render(page, o3().snapshot(), HOME);
  const recovered = await page.evaluate(() => window.__vectorStudioE23.recover());
  const sameFrame =
    Buffer.compare(
      Buffer.from(decodeFrame(recovered.frame.rgbaBase64)),
      Buffer.from(preLoss.rgba),
    ) === 0;
  if (!sameFrame)
    failures.push('device loss: the recovered frame differs from the pre-loss capture');
  const afterRecovery = resources(
    (await render(page, plain.snapshot(), HOME)).result.counters.statistics,
  );
  if (JSON.stringify(afterRecovery) !== JSON.stringify(baseline))
    failures.push(`after recovery ${JSON.stringify({ baseline, afterRecovery })}`);
  const disposed = await page.evaluate(() => window.__vectorStudioE23.dispose());
  if (disposed.resources.live !== 0) failures.push(`live after dispose ${disposed.resources.live}`);
  report(
    'report.json',
    JSON.stringify(
      {
        baseline,
        textures,
        createdBefore,
        layerBytes,
        tile,
        afterRemoval,
        sameFrame,
        afterRecovery,
        disposedLive: disposed.resources.live,
        pageErrors,
        failures,
      },
      null,
      2,
    ),
  );
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

// --- Section 8 risk: shared edges at 4x, measured and reported. ---

for (const dpr of [1, 2]) {
  test(`E25 shared-edge observation at DPR ${dpr}`, async ({ page, context }, info) => {
    const report = reporter(`shared-edge-dpr-${dpr}`, info);
    type Kind = 'rectangles' | 'paths';
    /**
     * White under the layer up to E; the layer's red from E to F; green over it from F. As
     * analytic rectangles, or as path fills (P3 meshes).
     */
    const shared = (opacity: number, kind: Kind) => {
      const e = 120 + half(dpr);
      const f = e + 150;
      const scene = new Scene();
      const box = (ctx: Ctx, id: string, x0: number, x1: number, paint: SceneColor) => {
        if (kind === 'rectangles')
          scene.shape(ctx, id, translate(x0, 40), rect(x1 - x0, 200), paint);
        else
          scene.path(ctx, id, IDENTITY, {
            ...rings(square(x0, 40, x1, 240)),
            fill: paint,
            stroke: null,
          });
      };
      box(scene.root(), 'under', 20, e, WHITE);
      scene.group(scene.root(), 'layer', IDENTITY, opacity, null, (inner) =>
        box(inner, 'layer-red', e, f, RED),
      );
      box(scene.root(), 'over', f, f + 100, GREEN);
      return { scene, columns: [e, f].map((x) => Math.round(x * dpr - 0.5)) };
    };
    const rows = (rendered: Rendered, columns: readonly number[]) =>
      columns.flatMap((x) =>
        Array.from({ length: 20 }, (_, index) => {
          const y = Math.round((60 + index * 8) * dpr);
          return { x, y, got: pixelAt(rendered, x, y) };
        }),
      );
    const { pageErrors } = await open(page, { dpr, samples: 4 });
    const isolatedPage = await context.newPage();
    const isolated = await open(isolatedPage, { dpr, samples: 4, isolate: true });
    const results: Record<string, unknown> = {};
    const failures: string[] = [];
    const layersOf = (rendered: Rendered) =>
      rendered.result.frame.packet?.layers?.layers.length ?? 0;
    for (const kind of ['rectangles', 'paths'] as const) {
      // At opacity 0.5 against the oracle's per-pixel model (coverages multiplied, as P1
      // composes) and the disjoint-samples model (the average of the two sides).
      const half5 = shared(0.5, kind);
      const rendered = await render(page, half5.scene.snapshot(), HOME);
      if (layersOf(rendered) !== 1) failures.push(`${kind} at 0.5: ${layersOf(rendered)} layers`);
      const left = { perPixel: [159.375, 95.625, 95.625], disjoint: [191.25, 127.5, 127.5] };
      const right = { perPixel: [31.875, 127.5, 0], disjoint: [63.75, 127.5, 0] };
      const measured = rows(rendered, half5.columns).map((row) => {
        const models = row.x === half5.columns[0] ? left : right;
        return {
          ...row,
          perPixel: worstLane(row.got, models.perPixel),
          disjoint: worstLane(row.got, models.disjoint),
        };
      });
      // At opacity 1: the layer path (isolate=1) against the main pass on the first page.
      const unitScene = shared(1, kind);
      const mainPass = await render(page, unitScene.scene.snapshot(), HOME);
      const throughLayer = await render(isolatedPage, unitScene.scene.snapshot(), HOME);
      // The comparison means something only if the main pass drew no layer and isolate=1 did.
      if (layersOf(mainPass) !== 0 || layersOf(throughLayer) !== 1)
        failures.push(`${kind} at 1: ${layersOf(mainPass)} / ${layersOf(throughLayer)} layers`);
      const layerVsMain = rows(throughLayer, unitScene.columns).map((row) => ({
        ...row,
        main: pixelAt(mainPass, row.x, row.y),
        difference: worstLane(row.got, pixelAt(mainPass, row.x, row.y)),
      }));
      results[kind] = {
        summary: {
          tolerance: EDGE_TOLERANCE + 1,
          worstPerPixel: Math.max(...measured.map((row) => row.perPixel)),
          worstDisjoint: Math.max(...measured.map((row) => row.disjoint)),
          worstLayerVsMain: Math.max(...layerVsMain.map((row) => row.difference)),
        },
        measured,
        layerVsMain,
      };
    }
    for (const target of [page, isolatedPage])
      failures.push(
        ...unexpected(await target.evaluate(() => window.__vectorStudioE23.diagnostics())),
      );
    report(
      'report.json',
      JSON.stringify(
        { dpr, results, pageErrors, isolatedPageErrors: isolated.pageErrors, failures },
        null,
        2,
      ),
    );
    expect(pageErrors).toEqual([]);
    expect(isolated.pageErrors).toEqual([]);
    // The measured differences are observations; only the setup checks above fail the test.
    expect(failures).toEqual([]);
  });
}
