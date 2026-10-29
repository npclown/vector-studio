import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  GlyphRasterRequest,
  RenderCamera,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  RendererDiagnostic,
  SceneColor,
  SceneTextRun,
} from '@vector-studio/contracts';
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';
import type { E23GradientPaintApi } from '../../apps/playground/src/e23-gradient-paint.js';
import type { OracleRegion } from '../support/e23-gradient-oracle.js';
import {
  expectedLayeredAt,
  isolationDepth,
  type LayerTree,
  type LeafSource,
} from '../support/e25-layer-oracle.js';
import { Scene, gate, rect, rings, square, type Ctx } from '../support/e25-scene.js';
import {
  requestKey,
  textLeafSource,
  uniqueRequests,
  type TextBitmap,
  type TextStatistics,
} from '../support/e28-text-oracle.js';
import {
  IDENTITY,
  decodeFrame,
  multiply,
  rotate,
  translate,
  type Affine,
} from '../support/p4-clip-oracle.js';

declare global {
  interface Window {
    __vectorStudioE23: E23GradientPaintApi;
  }
}

// E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md), unit U4: the headed GPU spec of
// text through the glyph atlas, on the E23 check page with `text=atlas` (and `groups=isolated`).
// Fixtures T1 to T9 (section 6). The oracle (tests/support/e28-text-oracle.ts) places the page's
// own canvas-port bitmaps by E28-K1 to K3 from the page's placements, and the E25 layer oracle
// composes them with shapes, clips, masks and isolated containers (E28-A03). Snapped text is
// compared within 2/255, general (bilinear) text within 3/255, plus 1/255 per isolation level.
// Other tests read the page's counters (A04), resource accounting and device loss (A05), the
// atlas test options (T8, A06), a text=none page against a text=atlas page (A07), the port
// itself (A08), a fake port (T9), and record the M6c hand-off and the raster cost. Each test
// writes its report under artifacts/e28-text-atlas (or E28_OUTPUT_DIR).

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.E28_OUTPUT_DIR ?? 'artifacts/e28-text-atlas',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

const SNAPPED_TOLERANCE = 2;
/**
 * Section 6: 3/255. `E28_GENERAL_TOLERANCE` may raise it for a software-adapter pre-run only
 * (SwiftShader's bilinear filtering is coarser); the reference-PC run never sets it.
 */
const GENERAL_TOLERANCE = Number(process.env.E28_GENERAL_TOLERANCE ?? '3');
const HOME: RenderCamera = { position: { x: 0, y: 0 }, zoom: 1 };

const WHITE: SceneColor = { r: 1, g: 1, b: 1, a: 1 };
const RED: SceneColor = { r: 1, g: 0, b: 0, a: 1 };
const BLUE: SceneColor = { r: 0, g: 0, b: 1, a: 0.6 };
const GREEN: SceneColor = { r: 0, g: 0.7, b: 0.2, a: 1 };
const AMBER: SceneColor = { r: 1, g: 0.8, b: 0.2, a: 0.8 };
const SKY: SceneColor = { r: 0.2, g: 0.6, b: 1, a: 1 };

/** The test-system fonts of T1 (Windows), with fallbacks for other systems. */
const ARIAL = '"Arial", "Liberation Sans", sans-serif';
const MALGUN = '"Malgun Gothic", "Noto Sans CJK KR", "NanumGothic", sans-serif';

// --- Text nodes. ---

type ClusterSpec = Readonly<{ text: string; x: number; y: number }>;

/** A line of clusters, one per code point, `step` apart; spaces leave a gap. */
function line(text: string, x0: number, y: number, step: number): ClusterSpec[] {
  return [...text].flatMap((character, index) =>
    character === ' ' ? [] : [{ text: character, x: x0 + index * step, y }],
  );
}

function run(
  fontList: string,
  size: number,
  color: SceneColor,
  clusters: readonly ClusterSpec[],
): SceneTextRun {
  return {
    fontList,
    size,
    color,
    clusters: clusters.map((cluster) => ({ ...cluster, advance: size * 0.6 })),
  };
}

/** T1: Latin and Hangul in two families and two sizes. */
const T1_RUNS: readonly SceneTextRun[] = [
  run(ARIAL, 16, WHITE, line('Vector Studio', 20.3, 40, 9.1)),
  run(MALGUN, 16, AMBER, line('벡터 스튜디오', 20.6, 72, 16.2)),
  run(ARIAL, 24, WHITE, line('Ag jWf', 20.1, 116, 14.3)),
  run(MALGUN, 24, SKY, line('한글 텍스트', 20.45, 160, 24.4)),
];

/**
 * Text leaves are added through `Scene.custom`; their sources are filled per view by `prepare`,
 * after the page has placed the clusters and rasterized their bitmaps.
 */
class TextScene extends Scene {
  readonly #sources = new Map<string, LeafSource>();
  readonly statistics: TextStatistics = { inked: 0, undecided: 0 };

  text(
    ctx: Ctx,
    id: string,
    transform: Affine,
    runs: readonly SceneTextRun[],
    options: Readonly<{ opacity?: number; generation?: number; lang?: string }> = {},
  ) {
    const node: RenderNodeSnapshot = {
      id,
      parentId: ctx.parent,
      transform,
      visible: true,
      opacity: options.opacity ?? 1,
      kind: 'text',
      generation: options.generation ?? 1,
      lang: options.lang ?? 'ko',
      runs,
    };
    this.custom(ctx, node, (under: readonly OracleRegion[]) => (wx, wy, size) => {
      const coverage = gate(under, wx, wy, size);
      if (coverage === null) return null;
      if (coverage === 0) return 'none';
      const source = this.#sources.get(id);
      if (source === undefined) throw new Error(`text ${id} is not prepared`);
      return source(wx, wy, size);
    });
  }

  /** Places the clusters on the page and fetches their bitmaps; returns the placements. */
  async prepare(page: Page, camera: RenderCamera, dpr: number) {
    const placements = await page.evaluate(
      ([snapshot, view]) => window.__vectorStudioE23.placements(snapshot, view),
      [this.snapshot(), camera] as const,
    );
    const bitmaps = await rasterize(page, uniqueRequests(placements));
    for (const node of this.nodes) {
      if (node.kind !== 'text') continue;
      const own = placements.filter((placement) => placement.nodeId === node.id);
      this.#sources.set(node.id, textLeafSource(own, bitmaps, { camera, dpr }, this.statistics));
    }
    return { placements, bitmaps };
  }
}

async function rasterize(page: Page, requests: readonly GlyphRasterRequest[]) {
  const results = await page.evaluate(
    (list) => list.map((request) => window.__vectorStudioE23.rasterize(request)),
    requests,
  );
  const bitmaps = new Map<string, TextBitmap | null>();
  requests.forEach((request, index) => {
    const result = results[index]!;
    if (result.status === 'failed') throw new Error(`raster ${request.text}: ${result.reason}`);
    bitmaps.set(
      requestKey(request),
      result.status === 'empty'
        ? null
        : {
            width: result.width,
            height: result.height,
            left: result.left,
            top: result.top,
            coverage: new Uint8Array(Buffer.from(result.coverage, 'base64')),
          },
    );
  });
  return bitmaps;
}

// --- Fixtures. ---

type Fixture = Readonly<{
  name: string;
  scene: TextScene;
  camera: RenderCamera;
  /** Snapped fixtures use the snapped tolerance; any general cluster uses the general one. */
  general: boolean;
  /** Layers each frame must draw. */
  layers: number;
}>;

function t1(): TextScene {
  const scene = new TextScene('e28-u4');
  scene.text(scene.root(), 't1', IDENTITY, T1_RUNS);
  return scene;
}

/** T2: one cluster at x offsets of 0, 0.25, 0.5 and 0.75 device px, one row each. */
function t2(dpr: number): TextScene {
  const scene = new TextScene('e28-u4');
  for (let index = 0; index < 4; index += 1) {
    scene.text(scene.root(), `t2-${index}`, IDENTITY, [
      run(ARIAL, 24, WHITE, [{ text: 'g', x: 40 + (index * 0.25) / dpr, y: 50 + index * 60 }]),
    ]);
  }
  return scene;
}

/** T3: T1 rotated by 30°, skewed, or mirrored. */
function t3(kind: 'rotated' | 'skewed' | 'mirrored'): TextScene {
  const scene = new TextScene('e28-u4');
  const transform: Affine =
    kind === 'rotated'
      ? rotate(30, 140, -40)
      : kind === 'skewed'
        ? [1, 0, 0.35, 1, 10, 0]
        : [-1, 0, 0, 1, 470, 0];
  scene.text(scene.root(), 't3', transform, T1_RUNS);
  return scene;
}

/** T4: text between two overlapping shapes; text over a mesh path and under an analytic rect. */
function t4(): TextScene {
  const scene = new TextScene('e28-u4');
  const root = scene.root();
  scene.shape(root, 't4-under', translate(30, 20), rect(220, 70), RED);
  scene.text(root, 't4-a', IDENTITY, [run(ARIAL, 32, WHITE, line('Order', 40.5, 70, 22))]);
  scene.shape(root, 't4-over', translate(120, 50), rect(200, 60), BLUE);
  scene.path(root, 't4-mesh', IDENTITY, {
    ...rings(square(260, 150, 480, 290)),
    fill: GREEN,
    stroke: null,
  });
  scene.text(root, 't4-b', IDENTITY, [run(MALGUN, 32, WHITE, line('메시 위', 280.25, 230, 36))]);
  scene.shape(root, 't4-top', translate(330, 200), rect(80, 70), BLUE);
  return scene;
}

/** T5: a rotated rect clip crossed by clusters, a mask, an isolated container, nested layers. */
function t5(kind: 'clip' | 'mask' | 'layer' | 'nested'): TextScene {
  const scene = new TextScene('e28-u4');
  const root = scene.root();
  if (kind === 'clip') {
    scene.group(
      root,
      't5-clip',
      rotate(12, 60, 20),
      1,
      { kind: 'rect', x: 0, y: 0, width: 300, height: 150 },
      (inner) => {
        // The text undoes the clip's rotation, so it stays snapped; clusters start left of the
        // clip and end past its right edge.
        const upright = multiply(rotate(-12), translate(-60, 0));
        scene.text(inner, 't5-text', upright, T1_RUNS.slice(0, 2));
        scene.text(inner, 't5-big', rotate(-12), [
          run(ARIAL, 40, WHITE, line('EdgeEdgeEdge', -10.3, 140, 28)),
        ]);
      },
    );
  } else if (kind === 'mask') {
    scene.group(root, 't5-mask', IDENTITY, 1, { kind: 'mask' }, (mask) => {
      const masked = scene.maskSource(mask, 't5-source', IDENTITY, {
        ...rings(
          Array.from({ length: 64 }, (_, index) => {
            const angle = (index / 64) * 2 * Math.PI;
            return [200 + 170 * Math.cos(angle), 110 + 80 * Math.sin(angle)];
          }).flat(),
        ),
        fill: WHITE,
        stroke: null,
      });
      scene.text(masked, 't5-text', IDENTITY, T1_RUNS);
    });
  } else if (kind === 'layer') {
    scene.group(root, 't5-layer', IDENTITY, 0.5, null, (inner) => {
      scene.shape(inner, 't5-red', translate(60, 20), rect(200, 120), RED);
      scene.text(inner, 't5-text', IDENTITY, T1_RUNS);
    });
  } else {
    scene.group(root, 't5-outer', IDENTITY, 0.8, null, (outer) => {
      scene.shape(outer, 't5-red', translate(60, 20), rect(200, 120), RED);
      scene.group(outer, 't5-inner', translate(10, 10), 0.5, null, (inner) => {
        scene.shape(inner, 't5-blue', translate(120, 60), rect(180, 100), BLUE);
        scene.text(inner, 't5-text', IDENTITY, T1_RUNS);
      });
    });
  }
  return scene;
}

/** T7: colour glyphs draw their silhouette in the run colour. */
function t7(): TextScene {
  const scene = new TextScene('e28-u4');
  scene.text(scene.root(), 't7', IDENTITY, [
    run('"Segoe UI Emoji", "Noto Color Emoji", sans-serif', 40, SKY, line('😀👍', 40.25, 80, 70)),
    run('"Segoe UI Emoji", "Noto Color Emoji", sans-serif', 64, AMBER, line('🎨', 220.5, 200, 0)),
  ]);
  return scene;
}

function fixtures(dpr: number): Fixture[] {
  const list: Fixture[] = [
    { name: 'T1', scene: t1(), camera: HOME, general: false, layers: 0 },
    { name: 'T2', scene: t2(dpr), camera: HOME, general: false, layers: 0 },
  ];
  for (const kind of ['rotated', 'skewed', 'mirrored'] as const)
    list.push({ name: `T3 ${kind}`, scene: t3(kind), camera: HOME, general: true, layers: 0 });
  list.push({ name: 'T4', scene: t4(), camera: HOME, general: false, layers: 0 });
  list.push({ name: 'T5 clip', scene: t5('clip'), camera: HOME, general: false, layers: 0 });
  list.push({ name: 'T5 mask', scene: t5('mask'), camera: HOME, general: false, layers: 0 });
  list.push({ name: 'T5 layer', scene: t5('layer'), camera: HOME, general: false, layers: 1 });
  list.push({ name: 'T5 nested', scene: t5('nested'), camera: HOME, general: false, layers: 2 });
  // T6: T1 at zoom 0.25, 4 and 16. At 16 the 24 px runs exceed the raster cap and magnify.
  list.push({
    name: 'T6 zoom 0.25',
    scene: t1(),
    camera: { position: { x: -200, y: -150 }, zoom: 0.25 },
    general: false,
    layers: 0,
  });
  list.push({
    name: 'T6 zoom 4',
    scene: t1(),
    camera: { position: { x: 18, y: 26 }, zoom: 4 },
    general: dpr * 4 * 24 > 256,
    layers: 0,
  });
  list.push({
    name: 'T6 zoom 16',
    scene: t1(),
    camera: { position: { x: 19, y: 96 }, zoom: 16 },
    general: true,
    layers: 0,
  });
  list.push({ name: 'T7', scene: t7(), camera: HOME, general: false, layers: 0 });
  return list;
}

// --- Page and comparison. ---

function reporter(name: string, info: { project: { name: string } }) {
  const directory = path.join(runRoot, info.project.name, name);
  mkdirSync(directory, { recursive: true });
  return (file: string, data: string) =>
    writeFileSync(path.join(directory, file), data, { flag: 'wx' });
}

type PageOptions = Readonly<{
  dpr: number;
  samples?: 1 | 4;
  text?: 'atlas' | 'none';
  raster?: 'fake';
  pages?: number;
  pageSize?: number;
}>;

async function open(page: Page, options: PageOptions) {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1200, height: 800 });
  const query = new URLSearchParams({
    samples: String(options.samples ?? 4),
    dpr: String(options.dpr),
    groups: 'isolated',
    text: options.text ?? 'atlas',
  });
  if (options.raster !== undefined) query.set('raster', options.raster);
  if (options.pages !== undefined) query.set('pages', String(options.pages));
  if (options.pageSize !== undefined) query.set('pagesize', String(options.pageSize));
  await page.goto(`/e23-gradient-paint.html?${query.toString()}`);
  const ready = await page.evaluate(() => window.__vectorStudioE23.ready);
  expect(ready.supported, JSON.stringify(ready)).toBe(true);
  return { ready, pageErrors };
}

const counters = (page: Page) => page.evaluate(() => window.__vectorStudioE23.counters());

/**
 * Shows a scene until no frame rasterizes any more (the raster budget has converged), then
 * captures a frame. Returns the frame, the frames it took and the counters.
 */
async function converge(
  page: Page,
  snapshot: RenderSceneSnapshot,
  camera: RenderCamera,
  maxFrames = 40,
) {
  let frames = 0;
  let calls = (await counters(page)).glyphRasterCalls;
  const first = calls;
  for (; frames < maxFrames; frames += 1) {
    await page.evaluate(([scene, view]) => window.__vectorStudioE23.show(scene, view), [
      snapshot,
      camera,
    ] as const);
    const next = (await counters(page)).glyphRasterCalls;
    if (next === calls && frames > 0) break;
    calls = next;
  }
  const result = await page.evaluate(
    ([scene, view]) => window.__vectorStudioE23.render(scene, view),
    [snapshot, camera] as const,
  );
  return { result, rgba: decodeFrame(result.frame.rgbaBase64), frames, calls: calls - first };
}

type Rendered = Awaited<ReturnType<typeof converge>>;

const pixelAt = (rendered: Rendered, x: number, y: number) => {
  const at = (y * rendered.result.frame.width + x) * 4;
  return [rendered.rgba[at]!, rendered.rgba[at + 1]!, rendered.rgba[at + 2]!];
};

const worstLane = (a: readonly number[], b: readonly number[]) =>
  Math.max(...[0, 1, 2].map((lane) => Math.abs(a[lane]! - b[lane]!)));

/** Compares every pixel (2 px in from the edges) with the oracle tree. */
function compare(
  rendered: Rendered,
  name: string,
  tree: readonly LayerTree[],
  camera: RenderCamera,
  dpr: number,
  base: number,
) {
  const { width, height } = rendered.result.frame;
  const scaleFactor = camera.zoom * dpr;
  const tolerance = base + isolationDepth(tree);
  const failures: string[] = [];
  let count = 0;
  let worst = 0;
  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
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
          `${name} (${x}, ${y}): ${got.join(',')} vs ${expected.map((v) => v.toFixed(2)).join(',')}`,
        );
    }
  }
  return { probes: count, worst, tolerance, failures };
}

type Allowance = (diagnostic: RendererDiagnostic) => boolean;

/** Warnings and errors not allowed; lifecycle (info) diagnostics such as recovery pass. */
function unexpected(diagnostics: readonly RendererDiagnostic[], ...allowed: Allowance[]) {
  return diagnostics
    .filter((diagnostic) => diagnostic.severity !== 'info')
    .filter((diagnostic) => !allowed.some((allow) => allow(diagnostic)))
    .map((diagnostic) => `diagnostic ${diagnostic.code} ${JSON.stringify(diagnostic.context)}`);
}

const diagnosticsOf = (page: Page) => page.evaluate(() => window.__vectorStudioE23.diagnostics());

// --- E28-A03: T1 to T7 against the oracle. ---

for (const samples of [4, 1] as const) {
  for (const dpr of [1, 2]) {
    test(`E28-A03 T1 to T7 against the oracle at ${samples}x, DPR ${dpr}`, async ({
      page,
    }, info) => {
      test.setTimeout(900_000);
      const report = reporter(`a03-${samples}x-dpr-${dpr}`, info);
      const { ready, pageErrors } = await open(page, { dpr, samples });
      const rows: unknown[] = [];
      const failures: string[] = [];
      for (const fixture of fixtures(dpr)) {
        const { placements } = await fixture.scene.prepare(page, fixture.camera, dpr);
        const general = placements.filter((placement) => placement.mode === 'general').length;
        if (!fixture.general && general > 0)
          failures.push(`${fixture.name}: ${general} general clusters in a snapped fixture`);
        if (fixture.name.startsWith('T3') && general !== placements.length)
          failures.push(`${fixture.name}: snapped clusters under a general transform`);
        const rendered = await converge(page, fixture.scene.snapshot(), fixture.camera);
        if (rendered.result.status !== 'applied')
          failures.push(`${fixture.name}: ${rendered.result.status}`);
        const packet = rendered.result.frame.packet;
        const layers = packet?.layers?.layers.length ?? 0;
        if (layers !== fixture.layers)
          failures.push(`${fixture.name}: ${layers} layers, expected ${fixture.layers}`);
        if ((packet?.text?.instances ?? 0) === 0) failures.push(`${fixture.name}: no text drawn`);
        const statistics = fixture.scene.statistics;
        statistics.inked = 0;
        statistics.undecided = 0;
        const outcome = compare(
          rendered,
          fixture.name,
          fixture.scene.tree(),
          fixture.camera,
          dpr,
          fixture.general ? GENERAL_TOLERANCE : SNAPPED_TOLERANCE,
        );
        if (statistics.inked < 200)
          failures.push(`${fixture.name}: only ${statistics.inked} inked probes`);
        failures.push(...outcome.failures);
        const extra: Record<string, unknown> = {};
        if (fixture.name === 'T2') {
          // The four rows select the four phases.
          const phases = placements.map((placement) => placement.phaseX);
          extra.phases = phases;
          if (JSON.stringify(phases) !== JSON.stringify([0, 0.25, 0.5, 0.75]))
            failures.push(`T2 phases ${JSON.stringify(phases)}`);
        }
        if (fixture.name === 'T6 zoom 16') {
          // The 24 px runs are drawn magnified from the capped 256 px bitmap.
          const capped = placements.filter((placement) => placement.size === 24);
          extra.capped = capped.map((placement) => [placement.deviceSize, placement.bucket]);
          if (capped.length === 0 || capped.some((placement) => placement.bucket !== 256))
            failures.push(`T6 zoom 16: buckets ${JSON.stringify(extra.capped)}`);
        }
        rows.push({
          fixture: fixture.name,
          probes: outcome.probes,
          inked: statistics.inked,
          undecided: statistics.undecided,
          worst: outcome.worst,
          tolerance: outcome.tolerance,
          frames: rendered.frames,
          rasterCalls: rendered.calls,
          clusters: placements.length,
          general,
          packet: { text: packet?.text, layers },
          ...extra,
        });
      }
      const diagnostics = await diagnosticsOf(page);
      failures.push(...unexpected(diagnostics));
      report(
        'report.json',
        JSON.stringify({ ready, samples, dpr, rows, diagnostics, pageErrors, failures }, null, 2),
      );
      expect(pageErrors).toEqual([]);
      expect(failures).toEqual([]);
    });
  }
}

// --- E28-A04: invalidation on the GPU counters. ---

test('E28-A04 edits, pans, zoom and generation on the raster counters', async ({ page }, info) => {
  test.setTimeout(300_000);
  const report = reporter('a04', info);
  const { pageErrors } = await open(page, { dpr: 1 });
  const failures: string[] = [];
  const rows: Record<string, unknown> = {};
  const node = (runs: readonly SceneTextRun[], opacity = 1, generation = 1) =>
    ({
      id: 'a04',
      parentId: null,
      transform: IDENTITY,
      visible: true,
      opacity,
      kind: 'text',
      generation,
      lang: 'ko',
      runs,
    }) as RenderNodeSnapshot;
  const snapshot: RenderSceneSnapshot = {
    identity: { documentId: 'e28-u4-a04', pageId: 'page' },
    revision: 1,
    nodes: [node(T1_RUNS)],
    rootOrder: ['a04'],
  };
  const keysAt = async (camera: RenderCamera) =>
    new Set(
      uniqueRequests(
        await page.evaluate(([scene, view]) => window.__vectorStudioE23.placements(scene, view), [
          snapshot,
          camera,
        ] as const),
      ).map(requestKey),
    );
  const seen = await keysAt(HOME);
  const base = await converge(page, snapshot, HOME);
  rows.base = { calls: base.calls, keys: seen.size, frames: base.frames };
  if (base.calls !== seen.size) failures.push(`base: ${base.calls} calls for ${seen.size} keys`);
  const pathBefore = base.result.counters.pathMesh;
  type Counters = Awaited<ReturnType<typeof counters>>;
  const cost = (before: Counters, after: Counters) => ({
    calls: after.glyphRasterCalls - before.glyphRasterCalls,
    uploads: after.glyphUploads - before.glyphUploads,
  });
  const edit = async (updated: RenderNodeSnapshot, camera: RenderCamera = HOME) => {
    const before = await counters(page);
    const edited = await page.evaluate(
      ([identity, item]) => window.__vectorStudioE23.edit(identity, [item]),
      [snapshot.identity, updated] as const,
    );
    if (edited.status !== 'applied') failures.push(`edit: ${edited.status}`);
    // A second frame: anything the first frame deferred is drawn by now.
    await page.evaluate((view) => window.__vectorStudioE23.pan(view), camera);
    return cost(before, await counters(page));
  };
  const pan = async (camera: RenderCamera) => {
    const before = await counters(page);
    await page.evaluate((view) => window.__vectorStudioE23.pan(view), camera);
    // A second frame: anything the first frame deferred is drawn by now.
    await page.evaluate((view) => window.__vectorStudioE23.pan(view), camera);
    return cost(before, await counters(page));
  };
  const recolored = T1_RUNS.map((item) => ({ ...item, color: RED }));
  rows.colour = await edit(node(recolored));
  rows.opacity = await edit(node(recolored, 0.5));
  for (const name of ['colour', 'opacity'] as const) {
    const value = rows[name] as ReturnType<typeof cost>;
    if (value.calls !== 0 || value.uploads !== 0)
      failures.push(`${name}: ${JSON.stringify(value)}`);
  }
  rows.wholePixelPan = await pan({ position: { x: 3, y: -2 }, zoom: 1 });
  // A sub-pixel pan: at most one raster per key with a phase not seen before.
  const subPixel: RenderCamera = { position: { x: 3.25, y: -2 }, zoom: 1 };
  const subKeys = [...(await keysAt(subPixel))].filter((key) => !seen.has(key));
  rows.subPixelPan = { ...(await pan(subPixel)), newKeys: subKeys.length };
  subKeys.forEach((key) => seen.add(key));
  rows.outAndBack = {
    out: await pan({ position: { x: 4000, y: 0 }, zoom: 1 }),
    back: await pan(subPixel),
  };
  const zoomed: RenderCamera = { position: { x: 3.25, y: -2 }, zoom: 1.5 };
  const zoomKeys = [...(await keysAt(zoomed))].filter((key) => !seen.has(key));
  rows.zoom = { ...(await pan(zoomed)), newKeys: zoomKeys.length };
  const whole = rows.wholePixelPan as ReturnType<typeof cost>;
  if (whole.calls !== 0 || whole.uploads !== 0)
    failures.push(`whole-px pan: ${JSON.stringify(whole)}`);
  const sub = rows.subPixelPan as ReturnType<typeof cost> & { newKeys: number };
  if (sub.calls > sub.newKeys) failures.push(`sub-px pan: ${JSON.stringify(sub)}`);
  const outBack = rows.outAndBack as Record<string, ReturnType<typeof cost>>;
  if (outBack.out!.calls !== 0 || outBack.back!.calls !== 0)
    failures.push(`out and back: ${JSON.stringify(outBack)}`);
  const zoom = rows.zoom as ReturnType<typeof cost> & { newKeys: number };
  if (zoom.calls > zoom.newKeys || zoom.calls === 0) failures.push(`zoom: ${JSON.stringify(zoom)}`);
  // A generation change re-rasterizes every visible cluster's key.
  const generationKeys = (await keysAt(zoomed)).size;
  const regenerated = await edit(node(recolored, 0.5, 2), zoomed);
  rows.generation = { ...regenerated, keys: generationKeys };
  if (regenerated.calls !== generationKeys)
    failures.push(`generation: ${regenerated.calls} calls for ${generationKeys} keys`);
  const pathAfter = (await counters(page)).pathMesh;
  rows.pathPort = { before: pathBefore, after: pathAfter };
  if ((pathAfter?.portCalls ?? 0) !== (pathBefore?.portCalls ?? 0))
    failures.push(`path port calls for text: ${JSON.stringify(rows.pathPort)}`);
  const diagnostics = await diagnosticsOf(page);
  failures.push(...unexpected(diagnostics));
  report('report.json', JSON.stringify({ rows, diagnostics, pageErrors, failures }, null, 2));
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

// --- E28-A05: resources, resize, removal, device loss and dispose. ---

test('E28-A05 atlas pages and sampler in accounting, resize, removal, device loss', async ({
  page,
}, info) => {
  test.setTimeout(300_000);
  const report = reporter('a05', info);
  const { pageErrors } = await open(page, { dpr: 1 });
  const failures: string[] = [];
  const plain = new TextScene('e28-u4-a05');
  plain.shape(plain.root(), 'a05-solid', translate(10, 10), rect(100, 60), GREEN);
  const withText = t1();
  const textures = (statistics: Rendered['result']['counters']['statistics']) =>
    statistics.resources.byCategory.texture;
  const baseline = await converge(page, plain.snapshot(), HOME);
  const baseTextures = textures(baseline.result.counters.statistics);
  const baseSamplers = baseline.result.counters.statistics.resources.byCategory.sampler;
  const shown = await converge(page, withText.snapshot(), HOME);
  const shownTextures = textures(shown.result.counters.statistics);
  const samplers = shown.result.counters.statistics.resources.byCategory.sampler;
  const pageCount = shown.result.frame.packet?.text?.pageCount ?? 0;
  const rows: Record<string, unknown> = {
    baseTextures,
    shownTextures,
    samplers,
    baseSamplers,
    pageCount,
  };
  if (pageCount !== 1) failures.push(`T1 uses ${pageCount} pages`);
  if (shownTextures.liveBytes - baseTextures.liveBytes !== pageCount * 2048 * 2048)
    failures.push(`page bytes ${shownTextures.liveBytes - baseTextures.liveBytes}`);
  if (samplers.live < 1) failures.push('no sampler in accounting');
  // A resize keeps the pages: no raster call when the frame returns to the same size.
  const before = await counters(page);
  await page.evaluate(() => window.__vectorStudioE23.resize(600, 360, 1));
  const back = await page.evaluate(() => window.__vectorStudioE23.resize(512, 320, 1));
  rows.resize = {
    calls: back.counters.glyphRasterCalls - before.glyphRasterCalls,
    uploads: back.counters.glyphUploads - before.glyphUploads,
  };
  if (back.counters.glyphRasterCalls !== before.glyphRasterCalls)
    failures.push(`resize: ${JSON.stringify(rows.resize)}`);
  // Removing the last text node releases the pages.
  const removed = await converge(page, plain.snapshot(), HOME);
  rows.removed = textures(removed.result.counters.statistics);
  if (textures(removed.result.counters.statistics).liveBytes !== baseTextures.liveBytes)
    failures.push(
      `after removal ${JSON.stringify(rows.removed)} vs ${JSON.stringify(baseTextures)}`,
    );
  // Device loss: the recovered generation converges to the pre-loss frame.
  const preLoss = await converge(page, withText.snapshot(), HOME);
  const recovered = await page.evaluate(() => window.__vectorStudioE23.recover());
  const after = await converge(page, withText.snapshot(), HOME);
  rows.recovery = {
    firstFrameEqual:
      Buffer.compare(
        Buffer.from(decodeFrame(recovered.frame.rgbaBase64)),
        Buffer.from(preLoss.rgba),
      ) === 0,
    generation: after.result.counters.statistics.generation,
    calls: after.calls,
  };
  if (Buffer.compare(Buffer.from(after.rgba), Buffer.from(preLoss.rgba)) !== 0)
    failures.push('device loss: the converged frame differs from the pre-loss capture');
  const disposed = await page.evaluate(() => window.__vectorStudioE23.dispose());
  if (disposed.resources.live !== 0) failures.push(`live after dispose ${disposed.resources.live}`);
  // A device error (a real out-of-memory included) would surface as a diagnostic here.
  const diagnostics = await diagnosticsOf(page);
  failures.push(
    ...unexpected(diagnostics, (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.DEVICE_LOST),
  );
  report('report.json', JSON.stringify({ rows, diagnostics, pageErrors, failures }, null, 2));
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

// --- T8 and E28-A06: atlas pressure. ---

type Grid = Readonly<{ columns: number; dx: number; dy: number }>;
/** 24 columns of 12 px syllables, 18 of 20 px ones; all rows stay inside 512 × 320. */
const GRID_12: Grid = { columns: 24, dx: 20.25, dy: 22 };
const GRID_20: Grid = { columns: 18, dx: 27.25, dy: 26 };

/** `count` distinct Hangul syllables from `start`, laid in a grid or overlapped at one point. */
function syllables(start: number, count: number, grid: Grid | null): ClusterSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    text: String.fromCodePoint(0xac00 + start + index),
    x: grid === null ? 120 : 12 + (index % grid.columns) * grid.dx,
    y: grid === null ? 260 : 30 + Math.floor(index / grid.columns) * grid.dy,
  }));
}

function pressure(id: string, clusters: readonly ClusterSpec[], size: number, generation = 1) {
  const scene = new TextScene('e28-u4-t8');
  scene.text(scene.root(), id, IDENTITY, [run(MALGUN, size, WHITE, clusters)], { generation });
  return scene;
}

test('T8 atlas pressure: eviction, over-limit notice and convergence (E28-A06)', async ({
  page,
}, info) => {
  test.setTimeout(600_000);
  const report = reporter('t8', info);
  const { pageErrors } = await open(page, { dpr: 1, pages: 1, pageSize: 256 });
  const failures: string[] = [];
  const rows: Record<string, unknown> = {};
  const limits = (diagnostics: readonly RendererDiagnostic[]) =>
    diagnostics.filter((diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.TEXT_RESOURCE_LIMIT)
      .length;
  const check = async (name: string, scene: TextScene) => {
    await scene.prepare(page, HOME, 1);
    const rendered = await converge(page, scene.snapshot(), HOME);
    scene.statistics.inked = 0;
    const outcome = compare(rendered, name, scene.tree(), HOME, 1, SNAPPED_TOLERANCE);
    failures.push(...outcome.failures);
    const value = {
      frames: rendered.frames,
      calls: rendered.calls,
      evictions: rendered.result.counters.atlasEvictions,
      text: rendered.result.frame.packet?.text,
      worst: outcome.worst,
      inked: scene.statistics.inked,
    };
    rows[name] = value;
    return value;
  };
  // One 256 px page; two sets of 60 syllables at 20 px, each filling most of it.
  const a = await check('A', pressure('t8', syllables(0, 60, GRID_20), 20));
  const b = await check('B', pressure('t8', syllables(400, 60, GRID_20), 20));
  if (b.evictions <= a.evictions) failures.push('B evicted no page');
  // A generation change of A: the page's generation 1 entries go (by compaction, since the
  // frame's first entries land in the page's free space), and the frame converges.
  const regenerated = await check('A gen 2', pressure('t8', syllables(0, 60, GRID_20), 20, 2));
  if (regenerated.evictions <= b.evictions) failures.push('generation 2 evicted no page');
  // Every syllable but the first moves by a quarter pixel: the first one's hit keeps the page
  // used, the new phases do not fit its free space, and the moved clusters draw their old
  // entries only as fallbacks, which stay stale (#369 review R2). The frame compacts instead of
  // omitting, raises no E28-D2 and converges to the oracle.
  const quiet = limits(await diagnosticsOf(page));
  const shifted = syllables(0, 60, GRID_20).map((cluster, index) =>
    index === 0 ? cluster : { ...cluster, x: cluster.x + 0.25 },
  );
  const moved = await check('A gen 2 shifted', pressure('t8', shifted, 20, 2));
  if (moved.evictions <= regenerated.evictions)
    failures.push('the subpixel move compacted nothing');
  if (limits(await diagnosticsOf(page)) !== quiet) failures.push('the subpixel move raised E28-D2');
  // 200 syllables cannot fit the page: E28-D2 once on entering the over-limit state.
  const before = limits(await diagnosticsOf(page));
  const over = pressure('t8', syllables(800, 200, GRID_20), 20);
  for (let frame = 0; frame < 4; frame += 1)
    await page.evaluate(([scene, view]) => window.__vectorStudioE23.show(scene, view), [
      over.snapshot(),
      HOME,
    ] as const);
  const entered = limits(await diagnosticsOf(page)) - before;
  rows.overLimit = { notices: entered };
  if (entered !== 1) failures.push(`over-limit: ${entered} notices`);
  // Back within the atlas: the state clears and the frame converges to the oracle again.
  await check('A again', pressure('t8', syllables(0, 60, GRID_20), 20));
  for (let frame = 0; frame < 2; frame += 1)
    await page.evaluate(([scene, view]) => window.__vectorStudioE23.show(scene, view), [
      over.snapshot(),
      HOME,
    ] as const);
  const reentered = limits(await diagnosticsOf(page)) - before;
  if (reentered !== 2) failures.push(`re-entering over-limit: ${reentered} notices in all`);
  const diagnostics = await diagnosticsOf(page);
  failures.push(
    ...unexpected(
      diagnostics,
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.TEXT_RESOURCE_LIMIT,
    ),
  );
  report('report.json', JSON.stringify({ rows, diagnostics, pageErrors, failures }, null, 2));
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

test('T8 raster budget convergence and the 32 MiB atlas bound (E28-A06)', async ({
  page,
}, info) => {
  test.setTimeout(600_000);
  const report = reporter('t8-budget', info);
  const { pageErrors } = await open(page, { dpr: 1 });
  const failures: string[] = [];
  const rows: Record<string, unknown> = {};
  // 300 distinct clusters: 256 rasters in the first frame, the rest in the next.
  const budget = pressure('t8-budget', syllables(0, 300, GRID_12), 12);
  await budget.prepare(page, HOME, 1);
  const callsBefore = (await counters(page)).glyphRasterCalls;
  const shown = await page.evaluate(([scene, view]) => window.__vectorStudioE23.show(scene, view), [
    budget.snapshot(),
    HOME,
  ] as const);
  const firstCalls = shown.counters.glyphRasterCalls - callsBefore;
  const converged = await converge(page, budget.snapshot(), HOME);
  const totalCalls = converged.result.counters.glyphRasterCalls - callsBefore;
  const outcome = compare(converged, 'budget', budget.tree(), HOME, 1, SNAPPED_TOLERANCE);
  failures.push(...outcome.failures);
  rows.budget = { firstFrameCalls: firstCalls, totalCalls, worst: outcome.worst };
  if (firstCalls !== 256) failures.push(`first frame: ${firstCalls} raster calls`);
  if (totalCalls !== 300) failures.push(`budget: ${totalCalls} calls for 300 keys`);
  // 600 distinct 256 px clusters on one spot exceed eight pages: never more than 32 MiB.
  const baseline = (await counters(page)).statistics.resources.byCategory.texture.liveBytes;
  const pagesBefore = converged.result.frame.packet?.text?.pageCount ?? 0;
  const huge = pressure('t8-huge', syllables(2000, 600, null), 256);
  let peakPages = 0;
  let peakBytes = 0;
  for (let frame = 0; frame < 6; frame += 1) {
    const step = await page.evaluate(
      ([scene, view]) => window.__vectorStudioE23.show(scene, view),
      [huge.snapshot(), HOME] as const,
    );
    peakPages = Math.max(peakPages, step.packet?.text?.pageCount ?? 0);
    peakBytes = Math.max(
      peakBytes,
      step.counters.statistics.resources.byCategory.texture.liveBytes -
        baseline +
        pagesBefore * 2048 * 2048,
    );
  }
  rows.bound = { peakPages, peakBytes };
  if (peakPages > 8 || peakBytes > 32 * 1024 * 1024)
    failures.push(`atlas bound: ${JSON.stringify(rows.bound)}`);
  if (peakPages < 8) failures.push(`600 clusters used only ${peakPages} pages`);
  const diagnostics = await diagnosticsOf(page);
  failures.push(
    ...unexpected(
      diagnostics,
      (diagnostic) => diagnostic.code === DIAGNOSTIC_CODES.TEXT_RESOURCE_LIMIT,
    ),
  );
  report('report.json', JSON.stringify({ rows, diagnostics, pageErrors, failures }, null, 2));
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

// --- T9: generations with a fake port. ---

test('T9 generation 2 never draws generation 1 bitmaps (E28-A08)', async ({ page }, info) => {
  const report = reporter('t9', info);
  const { pageErrors } = await open(page, { dpr: 1, raster: 'fake' });
  const failures: string[] = [];
  const rows: Record<string, unknown> = {};
  const scene = (generation: number) => {
    const built = new TextScene('e28-u4-t9');
    built.text(
      built.root(),
      't9',
      IDENTITY,
      [
        run(ARIAL, 16, WHITE, line('ABCDEF', 30, 60, 30)),
        run(ARIAL, 24, AMBER, line('XYZ', 40, 140, 50)),
      ],
      { generation },
    );
    return built;
  };
  const step = async (name: string, generation: number) => {
    const built = scene(generation);
    // The oracle asks the fake port for the pattern it draws now.
    await built.prepare(page, HOME, 1);
    const rendered = await converge(page, built.snapshot(), HOME);
    built.statistics.inked = 0;
    const outcome = compare(rendered, name, built.tree(), HOME, 1, SNAPPED_TOLERANCE);
    rows[name] = { calls: rendered.calls, worst: outcome.worst, inked: built.statistics.inked };
    return { outcome, rendered };
  };
  const first = await step('generation 1, pattern 1', 1);
  failures.push(...first.outcome.failures);
  await page.evaluate(() => window.__vectorStudioE23.setFakePattern(2));
  // The same generation keeps its entries: the frame still shows pattern 1.
  const kept = await converge(page, scene(1).snapshot(), HOME);
  rows.kept = {
    calls: kept.calls,
    equal: Buffer.compare(Buffer.from(kept.rgba), Buffer.from(first.rendered.rgba)) === 0,
  };
  if (
    kept.calls !== 0 ||
    Buffer.compare(Buffer.from(kept.rgba), Buffer.from(first.rendered.rgba)) !== 0
  )
    failures.push(`generation 1 after the pattern change: ${JSON.stringify(rows.kept)}`);
  // Generation 2 re-rasterizes: every pixel follows pattern 2.
  const second = await step('generation 2, pattern 2', 2);
  failures.push(...second.outcome.failures);
  const secondRow = rows['generation 2, pattern 2'] as { calls: number };
  if (secondRow.calls === 0) failures.push('generation 2 made no raster call');
  const diagnostics = await diagnosticsOf(page);
  failures.push(...unexpected(diagnostics));
  report('report.json', JSON.stringify({ rows, diagnostics, pageErrors, failures }, null, 2));
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

// --- E28-A07 on hardware: scenes without text, text=none against text=atlas. ---

test('E28-A07 scenes without text are identical with text=none and text=atlas', async ({
  page,
  context,
}, info) => {
  test.setTimeout(300_000);
  const report = reporter('a07', info);
  const failures: string[] = [];
  const rows: unknown[] = [];
  const scene = new TextScene('e28-u4-a07');
  const root = scene.root();
  scene.shape(root, 'a07-red', translate(21, 17), rect(160, 90), RED);
  scene.group(root, 'a07-group', IDENTITY, 0.5, null, (inner) => {
    scene.shape(inner, 'a07-blue', translate(90, 40), rect(150, 100), BLUE);
    scene.path(inner, 'a07-path', IDENTITY, {
      ...rings(square(250, 60, 450, 180)),
      fill: GREEN,
      stroke: null,
    });
  });
  for (const samples of [4, 1] as const) {
    for (const dpr of [1, 2]) {
      const hashes: string[] = [];
      for (const text of ['none', 'atlas'] as const) {
        const target = await context.newPage();
        const { pageErrors } = await open(target, { dpr, samples, text });
        const rendered = await converge(target, scene.snapshot(), HOME);
        hashes.push(createHash('sha256').update(rendered.rgba).digest('hex'));
        failures.push(...pageErrors, ...unexpected(await diagnosticsOf(target)));
        if ((rendered.result.frame.packet?.text ?? null) !== null)
          failures.push(`${samples}x DPR ${dpr} ${text}: a text part without text`);
        await target.close();
      }
      rows.push({ samples, dpr, hashes });
      if (hashes[0] !== hashes[1]) failures.push(`${samples}x DPR ${dpr}: frames differ`);
    }
  }
  await page.close();
  report('report.json', JSON.stringify({ rows, failures }, null, 2));
  expect(failures).toEqual([]);
});

// --- E28-A08: the canvas raster port in the browser. ---

test('E28-A08 the canvas port: identity, empty, too-large, unavailable, bearings, two pages', async ({
  page,
  context,
}, info) => {
  const report = reporter('a08', info);
  const { pageErrors } = await open(page, { dpr: 1 });
  const failures: string[] = [];
  const rows: Record<string, unknown> = {};
  const raster = (target: Page, request: GlyphRasterRequest) =>
    target.evaluate((value) => window.__vectorStudioE23.rasterize(value), request);
  const request = (
    text: string,
    fontList = ARIAL,
    pixelSize = 24,
    phaseX: GlyphRasterRequest['phaseX'] = 0.25,
  ) => ({
    text,
    fontList,
    lang: 'ko',
    pixelSize,
    phaseX,
  });
  const first = await raster(page, request('g'));
  const again = await raster(page, request('g'));
  if (JSON.stringify(first) !== JSON.stringify(again)) failures.push('identical requests differ');
  rows.empty = await raster(page, request(' 　'));
  if (JSON.stringify(rows.empty) !== JSON.stringify({ status: 'empty' }))
    failures.push(`whitespace: ${JSON.stringify(rows.empty)}`);
  rows.tooLarge = await raster(page, request('WWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', ARIAL, 256, 0));
  if (JSON.stringify(rows.tooLarge) !== JSON.stringify({ status: 'failed', reason: 'too-large' }))
    failures.push(`too-large: ${JSON.stringify(rows.tooLarge)}`);
  rows.unavailable = await raster(page, request('g', 'serif; color: red'));
  if (
    JSON.stringify(rows.unavailable) !== JSON.stringify({ status: 'failed', reason: 'unavailable' })
  )
    failures.push(`unparsable font list: ${JSON.stringify(rows.unavailable)}`);
  // Negative left bearings (a descender hook, a combining mark, a slanted form) keep their ink
  // inside the bitmap: the 2 px border stays empty.
  const bearings: Record<string, unknown> = {};
  for (const [text, fontList] of [
    ['j', '"Times New Roman", serif'],
    ['́', ARIAL],
    ['ƒ', '"Times New Roman", serif'],
    ['𝑓', '"Cambria Math", "STIX Two Math", serif'],
  ] as const) {
    const result = await raster(page, request(text, fontList, 48, 0));
    if (result.status !== 'ok') {
      bearings[text] = result;
      continue;
    }
    const coverage = Buffer.from(result.coverage, 'base64');
    let edgeInk = 0;
    for (let y = 0; y < result.height; y += 1) {
      for (let x = 0; x < result.width; x += 1) {
        const border = x < 2 || y < 2 || x >= result.width - 2 || y >= result.height - 2;
        if (border && coverage[y * result.width + x]! > 0) edgeInk += 1;
      }
    }
    bearings[text] = { left: result.left, width: result.width, edgeInk };
    if (edgeInk > 0) failures.push(`${text}: ${edgeInk} border pixels with ink`);
  }
  rows.bearings = bearings;
  // T1's bitmaps are byte-identical across two pages of one browser.
  const placements = await page.evaluate(
    ([scene, view]) => window.__vectorStudioE23.placements(scene, view),
    [t1().snapshot(), HOME] as const,
  );
  const requests = uniqueRequests(placements);
  const digest = async (target: Page) =>
    createHash('sha256')
      .update(
        JSON.stringify(
          await target.evaluate(
            (list) => list.map((item) => window.__vectorStudioE23.rasterize(item)),
            requests,
          ),
        ),
      )
      .digest('hex');
  const second = await context.newPage();
  await open(second, { dpr: 1 });
  rows.twoPages = {
    requests: requests.length,
    first: await digest(page),
    second: await digest(second),
  };
  const twoPages = rows.twoPages as { first: string; second: string };
  if (twoPages.first !== twoPages.second) failures.push('T1 bitmaps differ between two pages');
  await second.close();
  report('report.json', JSON.stringify({ rows, pageErrors, failures }, null, 2));
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

// --- The M6c hand-off and the raster cost (observations). ---

for (const dpr of [1, 2]) {
  test(`E28 M6c per-cluster readback and raster cost at DPR ${dpr}`, async ({ page }, info) => {
    test.setTimeout(300_000);
    const report = reporter(`handoff-dpr-${dpr}`, info);
    const { pageErrors } = await open(page, { dpr });
    const failures: string[] = [];
    const clusters = [
      { text: 'g', fontList: ARIAL, lang: 'en', size: 16, x: 40.3, y: 60.6 },
      { text: 'W', fontList: ARIAL, lang: 'en', size: 24, x: 120.55, y: 80 },
      { text: '한', fontList: MALGUN, lang: 'ko', size: 16, x: 200.7, y: 100.2 },
      { text: '글', fontList: MALGUN, lang: 'ko', size: 24, x: 300.15, y: 120.5 },
    ];
    const rows: unknown[] = [];
    for (const cluster of clusters) {
      const read = await page.evaluate(
        ([value, view]) => window.__vectorStudioE23.readCluster(value, view),
        [cluster, HOME] as const,
      );
      const rgba = decodeFrame(read.frame.rgbaBase64);
      const bitmap = await page.evaluate((value) => window.__vectorStudioE23.rasterize(value), {
        text: cluster.text,
        fontList: cluster.fontList,
        lang: cluster.lang,
        pixelSize: read.placement!.bucket,
        phaseX: read.placement!.phaseX as GlyphRasterRequest['phaseX'],
      });
      let worst = 0;
      let stray = 0;
      if (read.rect === null || bitmap.status !== 'ok') {
        failures.push(`${cluster.text}: no rectangle`);
      } else {
        const coverage = Buffer.from(bitmap.coverage, 'base64');
        const { width, height } = read.frame;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const bx = x - read.rect.x;
            const by = y - read.rect.y;
            const inside = bx >= 0 && by >= 0 && bx < read.rect.width && by < read.rect.height;
            const got = rgba[(y * width + x) * 4]!;
            if (inside)
              worst = Math.max(worst, Math.abs(got - coverage[by * read.rect.width + bx]!));
            else if (got !== 0) stray += 1;
          }
        }
        if (worst > SNAPPED_TOLERANCE || stray > 0)
          failures.push(`${cluster.text}: worst ${worst}, stray ${stray}`);
      }
      rows.push({ cluster, placement: read.placement, rect: read.rect, worst, stray });
    }
    // Raster cost at T1's sizes: per call, and one frame of 256 distinct calls (60 Hz is 16.7 ms).
    const t1Requests = uniqueRequests(
      await page.evaluate(([scene, view]) => window.__vectorStudioE23.placements(scene, view), [
        t1().snapshot(),
        HOME,
      ] as const),
    );
    const cost = await page.evaluate(
      (requests) => window.__vectorStudioE23.rasterCost(requests, 5),
      t1Requests,
    );
    const diagnostics = await diagnosticsOf(page);
    failures.push(...unexpected(diagnostics));
    report(
      'report.json',
      JSON.stringify(
        {
          dpr,
          rows,
          cost,
          fitsFrame: cost.frame256Ms <= 1000 / 60,
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
