import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  RendererStatistics,
  SceneClip,
  SceneColor,
  SceneGradient,
  ScenePaint,
} from '@vector-studio/contracts';
import type { E23GradientPaintApi } from '../../apps/playground/src/e23-gradient-paint.js';
import {
  expectedAt,
  flattenPath,
  paintAt,
  type OracleElement,
  type OracleRegion,
} from '../support/e23-gradient-oracle.js';
import {
  IDENTITY,
  decodeFrame,
  multiply,
  rotate,
  scale,
  translate,
  type Affine,
} from '../support/p4-clip-oracle.js';

declare global {
  interface Window {
    __vectorStudioE23: E23GradientPaintApi;
  }
}

// E23 contract (docs/plans/d9-e23-gradient-paint-contract.md), unit U4: the headed GPU spec of
// gradient paints on the E23 check page, which injects the real geometry-wasm ports. Fixtures
// G1 to G8 (section 6) are drawn at DPR 1 and 2 with 4x samples on a 512 × 320 CSS surface.
// Interior probes (at least 2 physical px from every edge, clip and mask boundary) are compared
// with the section 3 CPU oracle within 2/255 (E23-A03); edge probes sit where P1's analytic
// coverage is exactly 0.5 and are compared within 4/255. E23-A04 checks G5's premultiplied
// ramp and hard stop; A05 and A06 read the packet summary's paint part and runs and the path
// port counters; A09 reads resource accounting across removal, device loss and disposal. Each
// test writes its report under artifacts/e23-gradient-paint (or E23_OUTPUT_DIR).

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.E23_OUTPUT_DIR ?? 'artifacts/e23-gradient-paint',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

const INTERIOR_TOLERANCE = 2;
const EDGE_TOLERANCE = 4;
/** E23-A04: the product must differ from straight-alpha interpolation by more than this. */
const COUNTER_ORACLE_MARGIN = 24;
const STRIDE = 3;
const CSS = Object.freeze({ width: 512, height: 320 });

const RED: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const BLUE: SceneColor = { r: 0, g: 0, b: 1, a: 1 };
const WHITE: SceneColor = { r: 1, g: 1, b: 1, a: 1 };
const BLACK: SceneColor = { r: 0, g: 0, b: 0, a: 1 };

function linear(
  transform: Affine,
  stops: readonly (readonly [number, SceneColor])[],
  spread: SceneGradient['spread'] = 'pad',
  kind: SceneGradient['kind'] = 'linear',
): SceneGradient {
  return {
    kind,
    transform,
    stops: stops.map(([offset, color]) => ({ offset, color })),
    spread,
  };
}

const G1_PAINT = linear(
  [200, 0, 0, 200, 50, 0],
  [
    [0, RED],
    [1, BLUE],
  ],
);
const G2_PAINT = linear(
  [100, 0, 0, 50, 100, 50],
  [
    [0, WHITE],
    [0.5, { r: 0, g: 1, b: 0, a: 1 }],
    [1, BLACK],
  ],
  'pad',
  'radial',
);
const G3_FILL = linear(
  [173.205, 100, -100, 173.205, 0, 0],
  [
    [0, { r: 1, g: 1, b: 0, a: 1 }],
    [1, { r: 1, g: 0, b: 1, a: 1 }],
  ],
);
const G3_STROKE = linear(
  [200, 0, 0, 200, 0, 0],
  [
    [0, { r: 0, g: 1, b: 1, a: 1 }],
    [1, { r: 0, g: 0, b: 0, a: 0.6 }],
  ],
);
const G3_VERBS = [
  'move',
  'cubic',
  'line',
  'line',
  'close',
  'move',
  'line',
  'line',
  'line',
  'close',
];
const G3_POINTS = [
  0, 0, 80, -40, 120, -40, 200, 0, 200, 120, 0, 120, 60, 40, 140, 40, 140, 80, 60, 80,
];
const G4_PAINT = (spread: SceneGradient['spread']) =>
  linear(
    [100, 0, 0, 100, 100, 0],
    [
      [0, BLACK],
      [1, WHITE],
    ],
    spread,
  );
const G5_RAMP = linear(
  [200, 0, 0, 200, 0, 0],
  [
    [0, RED],
    [1, { r: 0, g: 1, b: 0, a: 0 }],
  ],
);
const G5_HARD = linear(
  [200, 0, 0, 200, 0, 0],
  [
    [0, RED],
    [0.5, RED],
    [0.5, BLUE],
    [1, BLUE],
  ],
);
const G8_PAINT = linear(
  [200, 0, 0, 200, 0, 0],
  [
    [0, RED],
    [1, BLUE],
  ],
);

/** A node and its oracle element; containers carry no element. */
type Item = Readonly<{ node: RenderNodeSnapshot; element: OracleElement | null }>;

type Placement = Readonly<{
  id: string;
  transform: Affine;
  parent?: string;
  /** The parent's world affine, when there is a parent. */
  parentWorld?: Affine;
  under?: readonly OracleRegion[];
  opacity?: number;
}>;

function primitive(
  at: Placement,
  geometry:
    | Readonly<{ kind: 'rectangle'; width: number; height: number }>
    | Readonly<{ kind: 'ellipse'; width: number; height: number }>
    | Readonly<{ kind: 'line'; x1: number; y1: number; x2: number; y2: number }>,
  fill: ScenePaint | null,
  stroke: Readonly<{ paint: ScenePaint; width: number }> | null = null,
): Item {
  const world = multiply(at.parentWorld ?? IDENTITY, at.transform);
  const nodeGeometry =
    geometry.kind === 'line'
      ? {
          kind: 'line' as const,
          start: { x: geometry.x1, y: geometry.y1 },
          end: { x: geometry.x2, y: geometry.y2 },
        }
      : geometry.kind === 'rectangle'
        ? { ...geometry, cornerRadii: [0, 0, 0, 0] as const }
        : geometry;
  return {
    node: {
      id: at.id,
      parentId: at.parent ?? null,
      transform: at.transform,
      visible: true,
      opacity: at.opacity ?? 1,
      kind: 'primitive',
      geometry: nodeGeometry,
      style: {
        fill,
        stroke: stroke === null ? null : { color: stroke.paint, width: stroke.width },
      },
    },
    element: {
      world,
      shape: geometry,
      fill,
      stroke,
      opacity: at.opacity ?? 1,
      ...(at.under === undefined ? {} : { under: at.under }),
    },
  };
}

function g3Path(at: Placement): Item {
  const world = multiply(at.parentWorld ?? IDENTITY, at.transform);
  return {
    node: {
      id: at.id,
      parentId: at.parent ?? null,
      transform: at.transform,
      visible: true,
      opacity: 0.5,
      kind: 'path',
      geometry: { kind: 'path', verbs: G3_VERBS, points: G3_POINTS, fillRule: 'evenodd' },
      style: {
        fill: G3_FILL,
        stroke: { color: G3_STROKE, width: 12, cap: 'butt', join: 'round', miterLimit: 4 },
      },
    } as RenderNodeSnapshot,
    element: {
      world,
      shape: { kind: 'path', polygons: flattenPath(G3_VERBS, G3_POINTS) },
      fill: G3_FILL,
      stroke: { paint: G3_STROKE, width: 12 },
      opacity: 0.5,
      ...(at.under === undefined ? {} : { under: at.under }),
    },
  };
}

function container(
  id: string,
  transform: Affine,
  clip: SceneClip,
  children: readonly string[],
): Item {
  return {
    node: {
      id,
      parentId: null,
      transform,
      visible: true,
      opacity: 1,
      kind: 'container',
      clip,
      children,
    },
    element: null,
  };
}

function snapshotOf(items: readonly Item[]): RenderSceneSnapshot {
  return {
    identity: { documentId: 'e23-u4', pageId: 'page' },
    revision: 1,
    nodes: items.map((item) => item.node),
    rootOrder: items.filter((item) => item.node.parentId === null).map((item) => item.node.id),
  };
}

type Fixture = Readonly<{
  name: string;
  items: readonly Item[];
  camera: RenderCamera;
  /** Pixels where P1's analytic coverage is exactly 0.5, with the expected premultiplied paint. */
  edges?: readonly Readonly<{ x: number; y: number; rgb: readonly number[] }>[];
}>;

const HOME: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };

/** Offset that puts a world coordinate on a physical pixel centre at zoom 1. */
const half = (dpr: number) => 0.5 / dpr;

function fixtures(dpr: number): Fixture[] {
  const list: Fixture[] = [];
  // G1, with edge probes on its left and top edges (pixel centres on the edge: coverage 0.5).
  {
    const x = 10 + half(dpr);
    const y = 10 + half(dpr);
    const g1 = primitive(
      { id: 'g1', transform: translate(x, y) },
      { kind: 'rectangle', width: 300, height: 100 },
      G1_PAINT,
    );
    const edges: { x: number; y: number; rgb: number[] }[] = [];
    const scaleFactor = dpr;
    for (let row = Math.ceil((y + 4) * scaleFactor); row < (y + 96) * scaleFactor; row += 7) {
      const paint = paintAt(G1_PAINT, 0, (row + 0.5) / scaleFactor - y);
      edges.push({
        x: Math.round(x * scaleFactor - 0.5),
        y: row,
        rgb: paint.slice(0, 3).map((v) => v * 127.5),
      });
    }
    for (
      let column = Math.ceil((x + 4) * scaleFactor);
      column < (x + 296) * scaleFactor;
      column += 7
    ) {
      const paint = paintAt(G1_PAINT, (column + 0.5) / scaleFactor - x, 0);
      edges.push({
        x: column,
        y: Math.round(y * scaleFactor - 0.5),
        rgb: paint.slice(0, 3).map((v) => v * 127.5),
      });
    }
    list.push({ name: 'G1', items: [g1], camera: HOME, edges });
  }
  list.push({
    name: 'G2',
    items: [
      primitive(
        { id: 'g2', transform: translate(50, 40) },
        { kind: 'ellipse', width: 200, height: 100 },
        G2_PAINT,
      ),
    ],
    camera: HOME,
  });
  list.push({
    name: 'G3',
    items: [g3Path({ id: 'g3', transform: translate(100, 70) })],
    camera: HOME,
  });
  list.push({
    name: 'G4',
    items: (['pad', 'repeat', 'reflect'] as const).map((spread, index) =>
      primitive(
        { id: `g4-${spread}`, transform: translate(20, 20 + index * 90) },
        { kind: 'rectangle', width: 300, height: 60 },
        G4_PAINT(spread),
      ),
    ),
    camera: HOME,
  });
  list.push({
    name: 'G5',
    items: [
      primitive(
        { id: 'g5-ramp', transform: translate(10 + half(dpr), 20) },
        { kind: 'rectangle', width: 200, height: 60 },
        G5_RAMP,
      ),
      primitive(
        { id: 'g5-hard', transform: translate(10 + half(dpr), 120) },
        { kind: 'rectangle', width: 200, height: 60 },
        G5_HARD,
      ),
    ],
    camera: HOME,
  });
  // G6: G1 and G3 in a container rotated 20° with a rect clip; G1 in a mask container whose
  // source is the G2 ellipse with G2's gradient fill (E23-K5: the source draws as its area).
  {
    const world = multiply(translate(140, 10), rotate(20));
    const clip: OracleRegion = {
      world: multiply(world, translate(20, 10)),
      shape: { kind: 'rectangle', width: 240, height: 80 },
    };
    const clipped = container(
      'g6-clip',
      world,
      { kind: 'rect', x: 20, y: 10, width: 240, height: 80 },
      ['g6-g1', 'g6-g3'],
    );
    const a = primitive(
      { id: 'g6-g1', transform: IDENTITY, parent: 'g6-clip', parentWorld: world, under: [clip] },
      { kind: 'rectangle', width: 300, height: 100 },
      G1_PAINT,
    );
    const b = g3Path({
      id: 'g6-g3',
      transform: translate(40, -10),
      parent: 'g6-clip',
      parentWorld: world,
      under: [clip],
    });
    const sourceWorld = translate(20, 170);
    const mask: OracleRegion = {
      world: sourceWorld,
      shape: { kind: 'ellipse', width: 200, height: 100 },
    };
    const masked = container('g6-mask', IDENTITY, { kind: 'mask' }, ['g6-source', 'g6-content']);
    const source = primitive(
      { id: 'g6-source', transform: sourceWorld, parent: 'g6-mask' },
      { kind: 'ellipse', width: 200, height: 100 },
      G2_PAINT,
    );
    const content = primitive(
      { id: 'g6-content', transform: translate(0, 180), parent: 'g6-mask', under: [mask] },
      { kind: 'rectangle', width: 300, height: 100 },
      G1_PAINT,
    );
    list.push({
      name: 'G6',
      items: [clipped, a, b, masked, { ...source, element: null }, content],
      camera: HOME,
    });
  }
  // G7: G1 under rotation, shear and scale, each at zoom 0.25, 1 and 8 and two camera positions.
  const transforms: readonly (readonly [string, Affine])[] = [
    ['rotate-15', rotate(15)],
    ['shear-x-0.25', [1, 0, 0.25, 1, 0, 0]],
    ['scale-2-0.5', scale(2, 0.5)],
  ];
  for (const [label, linearPart] of transforms) {
    const world = multiply(translate(40, 30), linearPart);
    const item = primitive(
      { id: `g7-${label}`, transform: world },
      { kind: 'rectangle', width: 300, height: 100 },
      G1_PAINT,
    );
    const centre = [
      world[0] * 150 + world[2] * 50 + world[4],
      world[1] * 150 + world[3] * 50 + world[5],
    ];
    for (const zoom of [0.25, 1, 8]) {
      for (const [index, shift] of [
        [0, 0],
        [7.3, -4.1],
      ].entries()) {
        const camera: RenderCamera = {
          position: {
            x: centre[0]! - CSS.width / (2 * zoom) + shift[0]! / zoom,
            y: centre[1]! - CSS.height / (2 * zoom) + shift[1]! / zoom,
          },
          zoom,
        };
        list.push({ name: `G7 ${label} zoom ${zoom} camera ${index}`, items: [item], camera });
      }
    }
  }
  list.push({
    name: 'G8',
    items: [
      primitive(
        { id: 'g8-line', transform: translate(20, 40) },
        { kind: 'line', x1: 0, y1: 0, x2: 200, y2: 0 },
        null,
        { paint: G8_PAINT, width: 16 },
      ),
      primitive(
        { id: 'g8-box', transform: translate(20, 100) },
        { kind: 'rectangle', width: 200, height: 100 },
        WHITE,
        { paint: G8_PAINT, width: 10 },
      ),
    ],
    camera: HOME,
  });
  return list;
}

function reporter(name: string, info: { project: { name: string } }) {
  const directory = path.join(runRoot, info.project.name, name);
  mkdirSync(directory, { recursive: true });
  return (file: string, data: string) =>
    writeFileSync(path.join(directory, file), data, { flag: 'wx' });
}

async function open(page: Page, dpr: number) {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`/e23-gradient-paint.html?samples=4&dpr=${dpr}`);
  const ready = await page.evaluate(() => window.__vectorStudioE23.ready);
  expect(ready.supported, JSON.stringify(ready)).toBe(true);
  return { ready, pageErrors };
}

async function render(page: Page, items: readonly Item[], camera: RenderCamera) {
  const result = await page.evaluate(
    ([snapshot, view]) => window.__vectorStudioE23.render(snapshot, view),
    [snapshotOf(items), camera] as const,
  );
  return { result, rgba: decodeFrame(result.frame.rgbaBase64) };
}

type Rendered = Awaited<ReturnType<typeof render>>;

/** Compares every STRIDE-th pixel with the oracle; returns probe counts and failures. */
function compare(rendered: Rendered, fixture: Fixture, dpr: number) {
  const { width, height } = rendered.result.frame;
  const elements = fixture.items.flatMap((item) => (item.element === null ? [] : [item.element]));
  const scaleFactor = fixture.camera.zoom * dpr;
  const failures: string[] = [];
  let probes = 0;
  let worst = 0;
  const check = (
    x: number,
    y: number,
    expected: readonly number[],
    tolerance: number,
    kind: string,
  ) => {
    const at = (y * width + x) * 4;
    probes += 1;
    for (let lane = 0; lane < 3; lane += 1) {
      const difference = Math.abs(rendered.rgba[at + lane]! - expected[lane]!);
      worst = Math.max(worst, difference);
      if (difference > tolerance && failures.length < 12) {
        failures.push(
          `${fixture.name} ${kind} (${x}, ${y}) lane ${lane}: ${rendered.rgba[at + lane]} vs ${expected[lane]!.toFixed(2)}`,
        );
      }
    }
  };
  for (let y = 1; y < height; y += STRIDE) {
    for (let x = 1; x < width; x += STRIDE) {
      const wx = fixture.camera.position.x + (x + 0.5) / scaleFactor;
      const wy = fixture.camera.position.y + (y + 0.5) / scaleFactor;
      const expected = expectedAt(elements, wx, wy, 1 / scaleFactor);
      if (expected !== null) check(x, y, expected, INTERIOR_TOLERANCE, 'interior');
    }
  }
  for (const edge of fixture.edges ?? []) check(edge.x, edge.y, edge.rgb, EDGE_TOLERANCE, 'edge');
  return { probes, worst, failures };
}

function resources(statistics: RendererStatistics) {
  const by = statistics.resources.byCategory;
  return {
    buffers: { live: by.buffer.live, bytes: by.buffer.liveBytes },
    bindGroups: by['bind-group'].live,
  };
}

for (const dpr of [1, 2]) {
  test(`E23-A03 G1 to G8 against the oracle at DPR ${dpr}`, async ({ page }, info) => {
    test.setTimeout(600_000);
    const report = reporter(`a03-dpr-${dpr}`, info);
    const { ready, pageErrors } = await open(page, dpr);
    const rows: unknown[] = [];
    const failures: string[] = [];
    for (const fixture of fixtures(dpr)) {
      const rendered = await render(page, fixture.items, fixture.camera);
      const outcome = compare(rendered, fixture, dpr);
      if (rendered.result.status !== 'applied')
        failures.push(`${fixture.name}: ${rendered.result.status}`);
      if (outcome.probes < 50) failures.push(`${fixture.name}: only ${outcome.probes} probes`);
      failures.push(...outcome.failures);
      rows.push({
        fixture: fixture.name,
        probes: outcome.probes,
        worst: outcome.worst,
        packet: rendered.result.frame.packet,
      });
    }
    const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
    if (diagnostics.some((diagnostic) => diagnostic.code === 'render.paint-unavailable'))
      failures.push('render.paint-unavailable');
    report(
      'report.json',
      JSON.stringify({ ready, dpr, rows, diagnostics, pageErrors, failures }, null, 2),
    );
    expect(pageErrors).toEqual([]);
    expect(failures).toEqual([]);
  });

  test(`E23-A04 premultiplied ramp and hard stop at DPR ${dpr}`, async ({ page }, info) => {
    const report = reporter(`a04-dpr-${dpr}`, info);
    await open(page, dpr);
    const g5 = fixtures(dpr).find((fixture) => fixture.name === 'G5')!;
    const rendered = await render(page, g5.items, HOME);
    const width = rendered.result.frame.width;
    const pixel = (x: number, y: number) =>
      Array.from(rendered.rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 3));
    // Local x = 100 (t = 0.5) lies on the pixel centre (10 + 0.5/dpr + 100) · dpr − 0.5.
    const column = Math.round((10 + half(dpr) + 100) * dpr - 0.5);
    const ramp = pixel(column, 50 * dpr);
    const below = pixel(column - 1, 150 * dpr);
    const above = pixel(column + 1, 150 * dpr);
    const straight = [0.25 * 255, 0.25 * 255, 0];
    const failures: string[] = [];
    const within = (got: number[], expected: number[], tolerance: number) =>
      got.every((value, lane) => Math.abs(value - expected[lane]!) <= tolerance);
    if (!within(ramp, [127.5, 0, 0], INTERIOR_TOLERANCE))
      failures.push(`ramp t=0.5 ${ramp.join(',')}`);
    if (!(
      Math.abs(ramp[0]! - straight[0]!) > COUNTER_ORACLE_MARGIN &&
      Math.abs(ramp[1]! - straight[1]!) > COUNTER_ORACLE_MARGIN
    ))
      failures.push(`ramp not apart from straight alpha ${ramp.join(',')}`);
    if (!within(below, [255, 0, 0], INTERIOR_TOLERANCE))
      failures.push(`hard stop below ${below.join(',')}`);
    if (!within(above, [0, 0, 255], INTERIOR_TOLERANCE))
      failures.push(`hard stop above ${above.join(',')}`);
    report('report.json', JSON.stringify({ dpr, column, ramp, below, above, failures }, null, 2));
    expect(failures).toEqual([]);
  });
}

test('E23-A05 and A06: invalidation and batching counters', async ({ page }, info) => {
  const report = reporter('a05-a06', info);
  await open(page, 1);
  const failures: string[] = [];
  const g4 = fixtures(1).find((fixture) => fixture.name === 'G4')!;
  // A06: three consecutive gradient primitives are one paint run; paint order is kept.
  const first = await render(page, g4.items, HOME);
  const runs = first.result.frame.packet!.analytic;
  if (JSON.stringify(runs) !== JSON.stringify([{ count: 3, clipState: 0, paint: true }]))
    failures.push(`G4 runs ${JSON.stringify(runs)}`);
  const mixed = [
    primitive(
      { id: 'solid-a', transform: translate(10, 10) },
      { kind: 'rectangle', width: 40, height: 40 },
      RED,
    ),
    ...g4.items,
    primitive(
      { id: 'solid-b', transform: translate(10, 300) },
      { kind: 'rectangle', width: 40, height: 10 },
      BLUE,
    ),
  ];
  const mixedRuns = (await render(page, mixed, HOME)).result.frame.packet!.analytic;
  if (
    JSON.stringify(mixedRuns.map((run) => [run.count, run.paint])) !==
    JSON.stringify([
      [1, false],
      [3, true],
      [1, false],
    ])
  )
    failures.push(`mixed runs ${JSON.stringify(mixedRuns)}`);
  // A05: a camera pan builds no record; a stop edit builds one.
  await render(page, g4.items, HOME);
  const panned = await page.evaluate(() =>
    window.__vectorStudioE23.pan({ position: { x: 13, y: -7 }, zoom: 1 }),
  );
  if (panned.packet?.paint?.builds !== 0)
    failures.push(`pan builds ${JSON.stringify(panned.packet?.paint)}`);
  const edited = g4.items.map((item, index) =>
    index === 1
      ? primitive(
          { id: item.node.id, transform: (item.node as { transform: Affine }).transform },
          { kind: 'rectangle', width: 300, height: 60 },
          linear(
            [100, 0, 0, 100, 100, 0],
            [
              [0, BLACK],
              [0.7, WHITE],
            ],
            'repeat',
          ),
        )
      : item,
  );
  // A replaced snapshot re-anchors the primitive origin at the camera, and every record is
  // origin-relative, so the edit returns to HOME, the origin the unedited records were built at.
  const edit = await page.evaluate(
    ([snapshot, camera]) => window.__vectorStudioE23.show(snapshot, camera),
    [snapshotOf(edited), HOME] as const,
  );
  if (edit.packet?.paint?.builds !== 1)
    failures.push(`stop edit builds ${JSON.stringify(edit.packet?.paint)}`);
  // A05 (E23-K6): solid ↔ gradient on a path calls no fill or stroke port and builds no geometry.
  const g3 = g3Path({ id: 'g3', transform: translate(100, 70) });
  const solid = {
    ...g3,
    node: {
      ...g3.node,
      style: {
        fill: RED,
        stroke: { color: BLUE, width: 12, cap: 'butt', join: 'round', miterLimit: 4 },
      },
    } as RenderNodeSnapshot,
  };
  await render(page, [solid], HOME);
  const before = await page.evaluate(() => window.__vectorStudioE23.counters());
  await render(page, [g3], HOME);
  await render(page, [solid], HOME);
  const after = await page.evaluate(() => window.__vectorStudioE23.counters());
  const portCalls = (after.pathMesh?.portCalls ?? 0) - (before.pathMesh?.portCalls ?? 0);
  const strokeCalls =
    (after.pathMesh?.strokePortCalls ?? 0) - (before.pathMesh?.strokePortCalls ?? 0);
  if (portCalls !== 0 || strokeCalls !== 0)
    failures.push(`paint toggle port calls ${portCalls}/${strokeCalls}`);
  report(
    'report.json',
    JSON.stringify(
      {
        runs,
        mixedRuns,
        panned: panned.packet?.paint,
        edit: edit.packet?.paint,
        portCalls,
        strokeCalls,
        failures,
      },
      null,
      2,
    ),
  );
  expect(failures).toEqual([]);
});

test('E23-A09 paint resources in accounting, after removal, device loss and disposal', async ({
  page,
}, info) => {
  const report = reporter('a09', info);
  await open(page, 1);
  const failures: string[] = [];
  const g1 = fixtures(1).find((fixture) => fixture.name === 'G1')!;
  const solidItems = [
    primitive(
      { id: 'g1', transform: translate(10.5, 10.5) },
      { kind: 'rectangle', width: 300, height: 100 },
      RED,
    ),
  ];
  const baseline = resources((await render(page, solidItems, HOME)).result.counters.statistics);
  const withGradient = await render(page, g1.items, HOME);
  const painted = resources(withGradient.result.counters.statistics);
  if (
    painted.buffers.live < baseline.buffers.live + 3 ||
    painted.buffers.bytes <= baseline.buffers.bytes
  )
    failures.push(`paint buffers not in accounting: ${JSON.stringify({ baseline, painted })}`);
  const afterRemoval = resources((await render(page, solidItems, HOME)).result.counters.statistics);
  if (JSON.stringify(afterRemoval) !== JSON.stringify(baseline))
    failures.push(`after removal ${JSON.stringify({ baseline, afterRemoval })}`);
  const preLoss = await render(page, g1.items, HOME);
  const recovered = await page.evaluate(() => window.__vectorStudioE23.recover());
  if (
    Buffer.compare(
      Buffer.from(decodeFrame(recovered.frame.rgbaBase64)),
      Buffer.from(preLoss.rgba),
    ) !== 0
  )
    failures.push('device loss: the recovered frame differs from the pre-loss capture');
  const afterRecovery = resources(
    (await render(page, solidItems, HOME)).result.counters.statistics,
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
        painted,
        afterRemoval,
        afterRecovery,
        disposedLive: disposed.resources.live,
        failures,
      },
      null,
      2,
    ),
  );
  expect(failures).toEqual([]);
});
