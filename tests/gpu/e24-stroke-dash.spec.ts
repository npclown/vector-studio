import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  PathStroke,
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneColor,
  SceneDash,
  ScenePaint,
  ScenePathVerb,
} from '@vector-studio/contracts';
import type { E23GradientPaintApi } from '../../apps/playground/src/e23-gradient-paint.js';
import { flattenPath } from '../support/e23-gradient-oracle.js';
import {
  dashPath,
  expectedDashAt,
  type DashElement,
  type OracleDash,
} from '../support/e24-dash-oracle.js';
import {
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

// E24 contract (docs/plans/d9-e24-dash-contract.md), unit U3: the headed GPU spec of dashed
// strokes. It drives the E23 check page, whose service hosts the real geometry-wasm fill and
// stroke ports with clips 'all' and paints 'gradient' (and, since E24 U2, dashes 'supported').
// Fixtures D1 to D9 (section 6) are drawn at DPR 1 and 2 with 4x samples on a 512 × 320 CSS
// surface. Interior probes (at least 2 physical px from every edge of the dashed region and of
// any fill) are compared with the independent CPU oracle of tests/support/e24-dash-oracle.ts
// within 2/255; edge probes sit on D1's straight butt dash ends, where the coverage is 0.5, and
// are compared within 4/255 (E24-A05). D7's dash ends are measured at zoom 0.25, 1 and 8 and
// must agree within 0.5 physical px at the coarsest zoom. E24-A04's GPU part reads the port,
// geometry-build and dash-expansion counters; the A03 note records whether the real kernel
// reaches its own work-limit at 4,096 dashes. Reports go under artifacts/e24-stroke-dash (or
// E24_OUTPUT_DIR).

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.E24_OUTPUT_DIR ?? 'artifacts/e24-stroke-dash',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

const INTERIOR_TOLERANCE = 2;
const EDGE_TOLERANCE = 4;
const STRIDE = 3;
const CSS = Object.freeze({ width: 512, height: 320 });
const HOME: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };

const BLUE: SceneColor = { r: 0, g: 0, b: 1, a: 1 };
const RED: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const YELLOW: SceneColor = { r: 1, g: 1, b: 0, a: 1 };
const CYAN: SceneColor = { r: 0, g: 1, b: 1, a: 1 };
/** E23 G1's gradient. */
const G1_PAINT: ScenePaint = {
  kind: 'linear',
  transform: [200, 0, 0, 200, 50, 0],
  stops: [
    { offset: 0, color: RED },
    { offset: 1, color: BLUE },
  ],
  spread: 'pad',
};

const D1_DASH: SceneDash = { pattern: [30, 20], phase: 0 };
const D4_DASH: SceneDash = { pattern: [24, 12, 6], phase: -10 };
const LINE = { verbs: ['move', 'line'] as ScenePathVerb[], points: [0, 0, 300, 0] };
const CUBIC = {
  verbs: ['move', 'cubic'] as ScenePathVerb[],
  points: [0, 0, 100, -120, 200, 120, 300, 0],
};

type Item = Readonly<{ node: RenderNodeSnapshot; element: DashElement | null }>;

type PathSpec = Readonly<{
  id: string;
  world: Affine;
  verbs: readonly ScenePathVerb[];
  points: readonly number[];
  fill?: ScenePaint | null;
  stroke: Omit<PathStroke, 'dash'> & { dash: SceneDash | null };
  opacity?: number;
  /** False: the path is expected not to draw (O1), so it has no oracle element. */
  drawn?: boolean;
}>;

function pathItem(spec: PathSpec): Item {
  const fill = spec.fill ?? null;
  const stroke = spec.stroke;
  return {
    node: {
      id: spec.id,
      parentId: null,
      transform: spec.world,
      visible: true,
      opacity: spec.opacity ?? 1,
      kind: 'path',
      geometry: { kind: 'path', verbs: spec.verbs, points: spec.points, fillRule: 'nonzero' },
      style: { fill, stroke },
    },
    element:
      spec.drawn === false
        ? null
        : {
            world: spec.world,
            fill:
              fill === null
                ? null
                : {
                    paint: fill,
                    polygons: flattenPath(spec.verbs, spec.points, 256).filter(
                      (polygon) => polygon.length >= 6,
                    ),
                  },
            stroke: {
              paint: stroke.color,
              width: stroke.width,
              cap: stroke.cap,
              dashes:
                stroke.dash === null
                  ? [solidPolyline(spec.verbs, spec.points)]
                  : dashPath(spec.verbs, spec.points, stroke.dash),
            },
            opacity: spec.opacity ?? 1,
          },
  };
}

/** A one-subpath path's flattened centre line, for the fixtures' solid strokes. */
function solidPolyline(verbs: readonly ScenePathVerb[], points: readonly number[]): OracleDash {
  const [polygon] = flattenPath(verbs, points, 256);
  const out: [number, number][] = [];
  for (let index = 0; index < polygon!.length; index += 2)
    out.push([polygon![index]!, polygon![index + 1]!]);
  const closed = verbs.at(-1) === 'close';
  if (closed) out.push(out[0]!);
  return { points: out, closed };
}

function snapshotOf(items: readonly Item[]): RenderSceneSnapshot {
  return {
    identity: { documentId: 'e24-u3', pageId: 'page' },
    revision: 1,
    nodes: items.map((item) => item.node),
    rootOrder: items.map((item) => item.node.id),
  };
}

const half = (dpr: number) => 0.5 / dpr;

function stroke(
  color: ScenePaint,
  width: number,
  cap: PathStroke['cap'],
  join: PathStroke['join'],
  dash: SceneDash | null,
): PathSpec['stroke'] {
  return { color, width, cap, join, miterLimit: 4, dash };
}

type Edge = Readonly<{ x: number; y: number; rgb: readonly number[] }>;
type Fixture = Readonly<{
  name: string;
  items: readonly Item[];
  camera: RenderCamera;
  edges?: readonly Edge[];
}>;

/** D1 at the given placement; its dash ends lie on physical pixel centres at zoom 1. */
function d1(id: string, dpr: number, paint: ScenePaint = BLUE): PathSpec {
  return {
    id,
    world: translate(10 + half(dpr), 40.25),
    ...LINE,
    stroke: stroke(paint, 10, 'butt', 'miter', D1_DASH),
  };
}

/** D1's edge probes: pixel centres on each butt dash end, inside the dash's width. */
function d1Edges(dpr: number): Edge[] {
  const edges: Edge[] = [];
  const x0 = 10 + half(dpr);
  for (const end of [30, 50, 80, 100, 130, 150, 180, 200, 230, 250, 280]) {
    const column = Math.round((x0 + end) * dpr - 0.5);
    for (let row = Math.ceil((40.25 - 3) * dpr); row < (40.25 + 3) * dpr; row += 2)
      edges.push({ x: column, y: row, rgb: [0, 0, 127.5] });
  }
  return edges;
}

/** D4's camera at a zoom, centred on the cubic's middle at (150, 0) local. */
function d4Camera(zoom: number): RenderCamera {
  const centre = transformPoint(D4_WORLD, 150, 0);
  return {
    position: { x: centre[0] - CSS.width / (2 * zoom), y: centre[1] - CSS.height / (2 * zoom) },
    zoom,
  };
}
const D4_WORLD = translate(100, 160);
const d4 = (id = 'd4', dash: SceneDash | null = D4_DASH, color: ScenePaint = BLUE): PathSpec => ({
  id,
  world: D4_WORLD,
  ...CUBIC,
  stroke: stroke(color, 6, 'butt', 'round', dash),
});

function fixtures(dpr: number): Fixture[] {
  const rotated = (() => {
    const [c, s] = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    return [0, 0, 300 * c, 300 * s];
  })();
  const d8Verbs: ScenePathVerb[] = ['move', 'line', 'move', 'line', 'line', 'line', 'close'];
  return [
    { name: 'D1', items: [pathItem(d1('d1', dpr))], camera: HOME, edges: d1Edges(dpr) },
    {
      name: 'D2',
      items: [
        pathItem({
          id: 'd2-round',
          world: translate(20, 30),
          ...LINE,
          stroke: stroke(BLUE, 10, 'round', 'miter', { pattern: [0, 20], phase: 0 }),
        }),
        // The geometry itself is rotated 30°: the square dots stay local-axis-aligned (E24-K5).
        pathItem({
          id: 'd2-square',
          world: translate(20, 80),
          verbs: LINE.verbs,
          points: rotated,
          stroke: stroke(BLUE, 10, 'square', 'miter', { pattern: [0, 20], phase: 0 }),
        }),
      ],
      camera: HOME,
    },
    {
      name: 'D3',
      items: [
        pathItem({
          id: 'd3',
          world: translate(60, 60),
          verbs: ['move', 'line', 'line', 'line', 'close'],
          points: [0, 0, 200, 0, 200, 120, 0, 120],
          stroke: stroke(BLUE, 8, 'butt', 'miter', { pattern: [40, 20], phase: 25 }),
        }),
      ],
      camera: HOME,
    },
    { name: 'D4', items: [pathItem(d4())], camera: HOME },
    {
      name: 'D5',
      items: [
        pathItem({
          ...d1('d5', dpr),
          world: multiply(translate(20, 20), multiply(rotate(30), scale(2, 0.5))),
        }),
      ],
      camera: HOME,
    },
    {
      name: 'D6',
      items: [
        pathItem({
          id: 'd6',
          world: translate(100, 140),
          verbs: ['move', 'cubic', 'line', 'line', 'close'],
          points: [...CUBIC.points, 300, 80, 0, 80],
          fill: YELLOW,
          stroke: stroke(CYAN, 6, 'butt', 'round', D4_DASH),
          opacity: 0.5,
        }),
      ],
      camera: HOME,
    },
    // Not a section 6 fixture: D6 with a solid stroke, recording whether the joint overlay's
    // O3 outcome at this DPR comes from the existing overlay builder rather than from the dash.
    {
      name: 'D6 solid reference',
      items: [
        pathItem({
          id: 'd6-solid',
          world: translate(100, 140),
          verbs: ['move', 'cubic', 'line', 'line', 'close'],
          points: [...CUBIC.points, 300, 80, 0, 80],
          fill: YELLOW,
          stroke: stroke(CYAN, 6, 'butt', 'round', null),
          opacity: 0.5,
        }),
      ],
      camera: HOME,
    },
    ...[0.25, 1, 8].map((zoom) => ({
      name: `D7 zoom ${zoom}`,
      items: [pathItem(d4('d7'))],
      camera: d4Camera(zoom),
    })),
    {
      name: 'D8',
      items: [
        pathItem({
          id: 'd8-a',
          world: translate(10, 100),
          verbs: d8Verbs,
          points: [0, 0, 10000, 0, 0, 20, 100, 20, 100, 60, 0, 60],
          fill: RED,
          stroke: stroke(BLUE, 2, 'butt', 'miter', { pattern: [1, 1], phase: 0 }),
          drawn: false,
        }),
        pathItem(d1('d8-b', dpr)),
      ],
      camera: HOME,
    },
    { name: 'D9', items: [pathItem(d1('d9', dpr, G1_PAINT))], camera: HOME },
  ];
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

function compare(rendered: Rendered, fixture: Fixture, dpr: number) {
  const { width, height } = rendered.result.frame;
  const elements = fixture.items.flatMap((item) => (item.element === null ? [] : [item.element]));
  const scaleFactor = fixture.camera.zoom * dpr;
  const failures: string[] = [];
  let probes = 0;
  /** Probes whose expected colour is not the black background: stroke on dash, fill in gap. */
  let content = 0;
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
      const expected = expectedDashAt(elements, wx, wy, 1 / scaleFactor);
      if (expected === null) continue;
      if (expected.some((lane) => lane > 0)) content += 1;
      check(x, y, expected, INTERIOR_TOLERANCE, 'interior');
    }
  }
  for (const edge of fixture.edges ?? []) check(edge.x, edge.y, edge.rgb, EDGE_TOLERANCE, 'edge');
  return { probes, content, worst, failures };
}

/**
 * The fringe caps observed per DPR, by node and paint (E24-Q6 (a), O2: region-only). They are
 * deterministic: the kernel's meshes and the tolerance buckets do not depend on the adapter.
 * D1 is not among them, so its edge probes run on a fringed mesh (section 8).
 */
const FRINGE_CAPS: Readonly<Record<number, ReadonlySet<string>>> = {
  1: new Set(['d2-round:stroke', 'd6:stroke', 'd6-solid:stroke', 'd7:stroke']),
  2: new Set([
    'd2-round:stroke',
    'd4:stroke',
    'd6:fill',
    'd6:stroke',
    'd6-solid:fill',
    'd6-solid:stroke',
    'd7:stroke',
  ]),
};

/** Diagnostics other than the pinned fringe caps, D6's known O3 at DPR 2, and D8's dash-limit. */
function unexpected(diagnostics: readonly { code: string; context?: unknown }[], dpr: number) {
  const failures: string[] = [];
  let dashLimits = 0;
  for (const diagnostic of diagnostics) {
    const context = diagnostic.context as Record<string, unknown> | undefined;
    const node = String(context?.nodeId).replace(/^.*:/u, '');
    if (diagnostic.code !== 'render.path-mesh-failure') {
      failures.push(`diagnostic ${diagnostic.code} ${JSON.stringify(context)}`);
      continue;
    }
    if (
      context?.failureCode === 'fringe-work-cap' &&
      FRINGE_CAPS[dpr]!.has(`${node}:${String(context.paint)}`)
    )
      continue;
    // The known failure of U3: D6's joint overlay refuses at DPR 2 (`sloped-outer-edge`, see
    // the A05 loop). Its solid reference must not take O3.
    if (context?.failureCode === 'overlay-unsupported' && dpr === 2 && node === 'd6') continue;
    if (
      context?.failureCode === 'dash-limit' &&
      context.paint === 'stroke' &&
      context.failureScope === 'renderer' &&
      context.toleranceExponent === null &&
      node === 'd8-a'
    ) {
      dashLimits += 1;
      continue;
    }
    failures.push(`diagnostic ${diagnostic.code} ${JSON.stringify(context)}`);
  }
  if (dashLimits !== 1) failures.push(`dash-limit notices for D8 A: ${dashLimits}`);
  return failures;
}

for (const dpr of [1, 2]) {
  test(`E24-A05 D1 to D9 against the oracle at DPR ${dpr}`, async ({ page }, info) => {
    test.setTimeout(900_000);
    const report = reporter(`a05-dpr-${dpr}`, info);
    const { ready, pageErrors } = await open(page, dpr);
    const rows: unknown[] = [];
    const failures: string[] = [];
    const outcomes: Record<string, string> = {};
    for (const fixture of fixtures(dpr)) {
      const seen = (await page.evaluate(() => window.__vectorStudioE23.diagnostics())).length;
      const rendered = await render(page, fixture.items, fixture.camera);
      const fresh = (await page.evaluate(() => window.__vectorStudioE23.diagnostics())).slice(seen);
      // D6 needs the ST-U7 joint overlay. At DPR 2 its fill draws region-only (fringe cap), and
      // the overlay builder then refuses the butt dash ends that cross the fill's sloped outer
      // edges (ST7-Q8, `sloped-outer-edge`): D6 takes E11-U4 O3 and is not drawn. This is U3's
      // known failure, recorded in the evidence; the frame must show exactly that, and only
      // there (the diagnostics check rejects O3 anywhere else, including D6's solid reference).
      const hidden = new Set(
        fresh.flatMap((diagnostic) => {
          const context = diagnostic.context as Record<string, unknown> | undefined;
          return context?.failureCode === 'overlay-unsupported' ? [String(context.nodeId)] : [];
        }),
      );
      const expected: Fixture =
        hidden.size === 0
          ? fixture
          : {
              ...fixture,
              items: fixture.items.map((item) =>
                [...hidden].some((id) => id.endsWith(item.node.id))
                  ? { ...item, element: null }
                  : item,
              ),
            };
      if (hidden.size > 0) outcomes[fixture.name] = `O3: ${[...hidden].join(', ')}`;
      const outcome = compare(rendered, expected, dpr);
      if (rendered.result.status !== 'applied')
        failures.push(`${fixture.name}: ${rendered.result.status}`);
      // Every drawn fixture must be tested where it paints, not only on the background. Probes
      // within 2 physical px of an edge are left out, so thin strokes keep few interior probes;
      // D7 at zoom 0.25 keeps none (its ends are measured by the D7 test instead).
      const floor = hidden.size > 0 || fixture.name === 'D7 zoom 0.25' ? 0 : 1;
      if (outcome.content < floor)
        failures.push(`${fixture.name}: only ${outcome.content} content probes`);
      failures.push(...outcome.failures);
      rows.push({
        fixture: fixture.name,
        probes: outcome.probes,
        content: outcome.content,
        worst: outcome.worst,
        packet: rendered.result.frame.packet,
      });
    }
    const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
    failures.push(...unexpected(diagnostics, dpr));
    if (dpr === 1 && Object.keys(outcomes).length > 0)
      failures.push(`O3 at DPR 1: ${JSON.stringify(outcomes)}`);
    report(
      'report.json',
      JSON.stringify({ ready, dpr, rows, outcomes, diagnostics, pageErrors, failures }, null, 2),
    );
    expect(pageErrors).toEqual([]);
    expect(failures).toEqual([]);
  });

  test(`E24-A05 D7 dash ends agree across zooms at DPR ${dpr}`, async ({ page }, info) => {
    test.setTimeout(300_000);
    const report = reporter(`a05-d7-dpr-${dpr}`, info);
    const { pageErrors } = await open(page, dpr);
    const dashes = dashPath(CUBIC.verbs, CUBIC.points, D4_DASH);
    const ends = dashEnds(dashes);
    const measured: Record<string, (number | null)[]> = {};
    for (const zoom of [0.25, 1]) {
      const camera = d4Camera(zoom);
      const rendered = await render(page, [pathItem(d4('d7'))], camera);
      measured[zoom] = ends.map((end) => measureEnd(rendered, camera, dpr, end));
    }
    // At zoom 8 the view holds 64 × 40 units, so each end gets a camera centred on it.
    measured[8] = [];
    for (const end of ends) {
      const centre = transformPoint(D4_WORLD, end.at[0], end.at[1]);
      const camera: RenderCamera = {
        position: { x: centre[0] - CSS.width / 16, y: centre[1] - CSS.height / 16 },
        zoom: 8,
      };
      const rendered = await render(page, [pathItem(d4('d7'))], camera);
      measured[8].push(measureEnd(rendered, camera, dpr, end));
    }
    const limit = 0.5 / (0.25 * dpr);
    const failures: string[] = [];
    let compared = 0;
    let worst = 0;
    ends.forEach((end, index) => {
      const coarse = measured[0.25]![index];
      for (const zoom of [1, 8]) {
        const fine = measured[zoom]![index];
        if (coarse === null || coarse === undefined || fine === null || fine === undefined)
          continue;
        compared += 1;
        const difference = Math.abs(fine - coarse);
        worst = Math.max(worst, difference);
        if (difference > limit)
          failures.push(`end ${index} (${end.at.join(', ')}) zoom ${zoom}: ${fine} vs ${coarse}`);
      }
    });
    if (compared < 40) failures.push(`only ${compared} comparisons`);
    // Absolute: at zoom 8 each end's half-coverage crossing lies within 0.5 physical px of the
    // oracle's end (offset 0).
    const fineLimit = 0.5 / (8 * dpr);
    let absolute = 0;
    let worstAbsolute = 0;
    measured[8].forEach((offset, index) => {
      if (offset === null || offset === undefined) return;
      absolute += 1;
      worstAbsolute = Math.max(worstAbsolute, Math.abs(offset));
      if (Math.abs(offset) > fineLimit) failures.push(`end ${index} zoom 8 offset ${offset}`);
    });
    if (absolute < 20) failures.push(`only ${absolute} zoom-8 ends measured`);
    report(
      'report.json',
      JSON.stringify(
        {
          dpr,
          limit,
          compared,
          worst,
          fineLimit,
          absolute,
          worstAbsolute,
          ends,
          measured,
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

type DashEnd = Readonly<{
  at: readonly [number, number];
  /** Outward unit tangent in D4's local space. */
  out: readonly [number, number];
  /** How far outward and inward the search may go without meeting another dash (local units). */
  room: number;
  inward: number;
}>;

/** The butt ends of D4's dashes that are at least 2 units long, with their free room. */
function dashEnds(dashes: readonly OracleDash[]): DashEnd[] {
  const ends: DashEnd[] = [];
  const lengths = dashes.map((dash) => {
    let length = 0;
    for (let index = 1; index < dash.points.length; index += 1)
      length += Math.hypot(
        dash.points[index]![0] - dash.points[index - 1]![0],
        dash.points[index]![1] - dash.points[index - 1]![1],
      );
    return length;
  });
  dashes.forEach((dash, index) => {
    if (lengths[index]! < 4) return;
    const points = dash.points;
    const gapTo = (other: OracleDash | undefined, from: readonly [number, number]) =>
      other === undefined
        ? 12
        : Math.min(
            ...[other.points[0]!, other.points.at(-1)!].map((p) =>
              Math.hypot(p[0] - from[0], p[1] - from[1]),
            ),
          );
    const unit = (a: readonly [number, number], b: readonly [number, number]) => {
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return [(b[0] - a[0]) / length, (b[1] - a[1]) / length] as const;
    };
    const start = points[0]!;
    const end = points.at(-1)!;
    // Skip the path's own ends: there is no cap boundary question across zooms beyond them.
    if (Math.hypot(start[0], start[1]) > 1e-9)
      ends.push({
        at: start,
        out: unit(points[1]!, start),
        room: gapTo(dashes[index - 1], start) / 2,
        inward: lengths[index]! / 2,
      });
    if (Math.hypot(end[0] - 300, end[1]) > 1e-9)
      ends.push({
        at: end,
        out: unit(points.at(-2)!, end),
        room: gapTo(dashes[index + 1], end) / 2,
        inward: lengths[index]! / 2,
      });
  });
  return ends;
}

/**
 * The outward offset (local units) where the blue coverage along the end's tangent crosses half
 * of its in-dash maximum, by bilinear reads of the frame; null when the end is off screen or
 * the search room (half the neighbouring gap, half the dash) is under 0.5 physical px.
 */
function measureEnd(rendered: Rendered, camera: RenderCamera, dpr: number, end: DashEnd) {
  const { width, height } = rendered.result.frame;
  const scaleFactor = camera.zoom * dpr;
  const pixel = 1 / scaleFactor;
  const reach = Math.min(end.room, 3 * pixel);
  const back = Math.min(end.inward, 3 * pixel);
  if (reach < 0.5 * pixel || back < 0.5 * pixel) return null;
  const read = (x: number, y: number) => {
    const fx = (x - camera.position.x) * scaleFactor - 0.5;
    const fy = (y - camera.position.y) * scaleFactor - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    if (x0 < 2 || y0 < 2 || x0 + 3 > width || y0 + 3 > height) return null;
    const tx = fx - x0;
    const ty = fy - y0;
    const at = (px: number, py: number) => rendered.rgba[(py * width + px) * 4 + 2]!;
    return (
      (1 - tx) * (1 - ty) * at(x0, y0) +
      tx * (1 - ty) * at(x0 + 1, y0) +
      (1 - tx) * ty * at(x0, y0 + 1) +
      tx * ty * at(x0 + 1, y0 + 1)
    );
  };
  const samples: [number, number][] = [];
  const step = pixel / 8;
  for (let t = -back; t <= reach; t += step) {
    const local = [end.at[0] + end.out[0] * t, end.at[1] + end.out[1] * t] as const;
    const world = transformPoint(D4_WORLD, local[0], local[1]);
    const value = read(world[0], world[1]);
    if (value === null) return null;
    samples.push([t, value]);
  }
  const peak = Math.max(...samples.filter(([t]) => t <= 0).map(([, value]) => value));
  if (peak < 64) return null;
  for (let index = 1; index < samples.length; index += 1) {
    const [t0, v0] = samples[index - 1]!;
    const [t1, v1] = samples[index]!;
    if (v0 >= peak / 2 && v1 < peak / 2) return t0 + ((v0 - peak / 2) / (v0 - v1)) * (t1 - t0);
  }
  return null;
}

test('E24-A04 GPU part: invalidation counters', async ({ page }, info) => {
  const report = reporter('a04', info);
  const { pageErrors } = await open(page, 1);
  const failures: string[] = [];
  const counters = () => page.evaluate(() => window.__vectorStudioE23.counters());
  const show = (items: readonly Item[], camera: RenderCamera) =>
    page.evaluate(([snapshot, view]) => window.__vectorStudioE23.show(snapshot, view), [
      snapshotOf(items),
      camera,
    ] as const);
  const read = async () => {
    const value = await counters();
    return {
      fill: value.pathMesh?.portCalls ?? 0,
      stroke: value.pathMesh?.strokePortCalls ?? 0,
      builds: value.preparation.geometryBuilds,
      expansions: value.dashExpansions,
    };
  };
  const delta = (
    before: Awaited<ReturnType<typeof read>>,
    after: Awaited<ReturnType<typeof read>>,
  ) => ({
    fill: after.fill - before.fill,
    stroke: after.stroke - before.stroke,
    builds: after.builds - before.builds,
    expansions: after.expansions - before.expansions,
  });
  const steps: Record<string, unknown> = {};
  const expectStep = async (
    name: string,
    action: () => Promise<unknown>,
    expected: Partial<ReturnType<typeof delta>>,
  ) => {
    const before = await read();
    await action();
    const change = delta(before, await read());
    steps[name] = change;
    for (const [key, value] of Object.entries(expected)) {
      if (change[key as keyof typeof change] !== value)
        failures.push(`${name}: ${key} ${change[key as keyof typeof change]} (expected ${value})`);
    }
  };
  // A filled D6 node, so the fill port's counter is live.
  const d6 = (dash: SceneDash | null, color: ScenePaint = CYAN) =>
    pathItem({
      id: 'd6',
      world: translate(100, 140),
      verbs: ['move', 'cubic', 'line', 'line', 'close'],
      points: [...CUBIC.points, 300, 80, 0, 80],
      fill: YELLOW,
      stroke: stroke(color, 6, 'butt', 'round', dash),
    });
  await show([d6(D4_DASH)], HOME);
  await expectStep('dash edit', () => show([d6({ pattern: [24, 12], phase: -10 })], HOME), {
    fill: 0,
    stroke: 1,
    builds: 0,
    expansions: 1,
  });
  await expectStep('phase edit', () => show([d6({ pattern: [24, 12], phase: 3 })], HOME), {
    fill: 0,
    stroke: 1,
    builds: 0,
    expansions: 1,
  });
  await expectStep('dashed to solid', () => show([d6(null)], HOME), {
    fill: 0,
    stroke: 1,
    builds: 0,
    expansions: 0,
  });
  await expectStep('solid to dashed', () => show([d6(D4_DASH)], HOME), {
    fill: 0,
    stroke: 1,
    builds: 0,
    expansions: 1,
  });
  await expectStep('colour edit', () => show([d6(D4_DASH, RED)], HOME), {
    fill: 0,
    stroke: 0,
    builds: 0,
    expansions: 0,
  });
  await expectStep(
    'pan',
    () =>
      page.evaluate(() => window.__vectorStudioE23.pan({ position: { x: 13, y: -7 }, zoom: 1 })),
    { fill: 0, stroke: 0, builds: 0, expansions: 0 },
  );
  await expectStep(
    'zoom',
    () =>
      page.evaluate(() => window.__vectorStudioE23.pan({ position: { x: 200, y: 120 }, zoom: 8 })),
    // The zoom crosses tolerance buckets, so both paints re-request once (existing rules).
    { fill: 1, stroke: 1, builds: 0, expansions: 0 },
  );
  report('report.json', JSON.stringify({ steps, failures, pageErrors }, null, 2));
  expect(failures).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('E24-A03 note: the real kernel at 4,096 dashes on D8 geometry', async ({ page }, info) => {
  const report = reporter('a03-note', info);
  const { pageErrors } = await open(page, 1);
  // [1, 1] on M 0 0 L 8190 0 is exactly 4,096 dashes: the most the renderer requests.
  const item = pathItem({
    id: 'limit',
    world: translate(10, 100),
    verbs: ['move', 'line'],
    points: [0, 0, 8190, 0],
    stroke: stroke(BLUE, 2, 'butt', 'miter', { pattern: [1, 1], phase: 0 }),
  });
  const rendered = await render(page, [item], HOME);
  const diagnostics = await page.evaluate(() => window.__vectorStudioE23.diagnostics());
  const meshDraws = rendered.result.frame.packet?.mesh.length ?? 0;
  // Informational, not a gate: record whether the kernel built it or reported work-limit.
  report(
    'report.json',
    JSON.stringify(
      {
        status: rendered.result.status,
        meshDraws,
        diagnostics,
        pathMesh: rendered.result.counters.pathMesh,
        pageErrors,
      },
      null,
      2,
    ),
  );
  expect(rendered.result.status).toBe('applied');
  expect(pageErrors).toEqual([]);
});
