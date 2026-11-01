import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Editor, EditorEvent } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';
import type { ClusterRead, FrameCrop, TextScene } from '../../apps/next-host/src/m6c-text-probe';
import type {
  FlowedReference,
  MinimumFontSize,
  PlacedReference,
  PlacedReferenceOptions,
} from '../../apps/next-host/src/m6c-text-reference';
import {
  ACHROMATIC_LIMIT,
  decodeCrop,
  expectedPlacement,
  layoutTerm,
  lineStarts,
  maxChroma,
  measureInk,
  placementFailures,
  RASTER_BOUNDS,
  rasterFailures,
  rasterTerm,
  type Ink,
  type RasterBounds,
  type RasterTerm,
} from './m6c-agreement';

// M6c-U3 (MVP M6c contract, sections 6 and 7; M6c-A06, M6c-A07): the DOM and GPU agreement and
// the font-load case through next-host, in headed Chrome and Edge at DPR 1 (`chrome`, `edge`) and
// 2 (`chrome-dpr2`, `edge-dpr2`), on `?fixture=text-gpu`'s `agreement` page at camera zoom 1.
// Per fixture and cluster, the split of section 6.1:
// - Layout term (recorded, not gated): the flowed DOM block (`reference(id)`) against the port
//   origin, per cluster, in CSS and device px; expected cause U4c's line-metric rounding at the
//   displayed size (section 1.2), and at a layout zoom other than 1 the M6c-U0 residual.
// - Placement term (gated, exact): the probe's `o`, bucket, `P` and `phaseX` equal E28-K1 to K3
//   recomputed here from the leaf, camera and DPR (m6c-agreement.ts, apart from renderer-core);
//   the leaf's cluster positions equal the port's layout exactly (M6-G1, no second layout).
// - Raster term (gated, section 6.3): the GPU cluster (`readCluster`) against the placed DOM
//   cluster (`reference(id, index)`, screenshot at device scale, `readReference`), both pen
//   origins at `(o.x, P.y)`: from the coverage `255 − min(R, G, B)` of each crop, the
//   coverage-weighted left and top edge shifts (horizontal |GPU − DOM| ≤ 0.5 CSS px, vertical
//   GPU − DOM within ±0.25) and the size difference (≤ 1). The placed DOM cluster is painted on a
//   composited layer (grayscale antialiasing, as the atlas); a second placed read without it (LCD
//   antialiasing where the OS uses it) is recorded only, as are the centroid shift, the mass ratio
//   and the integer box forms. White-space clusters must be blank on both sides.
// A named limit (section 6.3) is added to NAMED_LIMITS only by a dated amendment of the contract.
// Committed expectations are structural (each fixture's line starts); every figure is an
// annotation (`m6c-a06` per fixture, `m6c-a07` for the font-load case).
//
// The `chromium-smoke` project (M6C_NEXT_HOST_CHROMIUM) runs the structural test headless and
// skips the drawing tests when the renderer does not start; it is not M6c-A06 or A07 evidence.

declare global {
  interface Window {
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
    __m6cFontLoad?: Promise<'loaded' | 'error'>;
  }
}

/** The hook members this spec uses (page.tsx), declared apart as the U2 spec does. */
type Hook = Readonly<{
  text: Readonly<{
    port: Readonly<{
      generation: number;
      registerFont(font: { family: string; source: { url: string } }): Promise<'loaded' | 'error'>;
      layout(request: unknown): Readonly<{ width: number }>;
    }>;
    scene(): Promise<TextScene | null>;
    readCluster(id: string, index: number): Promise<ClusterRead>;
    reference: {
      (id: string): Promise<FlowedReference>;
      (id: string, index: number, options?: PlacedReferenceOptions): Promise<PlacedReference>;
    };
    readReference(png: string): Promise<FrameCrop>;
    clearReference(): Promise<void>;
    minimumFontSize(fontList: string, lang: string): Promise<MinimumFontSize>;
  }>;
}>;
type CounterHook = Readonly<{ glyphRasterCalls: number; glyphUploads: number }>;

/** Section 6.2's fixtures on the `agreement` page (U2 note 4), font-load apart. */
const AGREEMENT = [
  'kerning',
  'hangul',
  'mixed-sizes',
  'hangul-in-latin',
  'two-families',
  'spacing-tight',
  'spacing-wide',
  'small-12',
  'small-9',
  'wrapped',
  'align-center',
  'align-right',
] as const;

/**
 * Committed structure (section 6.2): each fixture's line starts, in UTF-16 offsets, on the test
 * font. `hangul-in-latin` and `two-families` use `Arial` (machine fonts) but are auto-width, one
 * line on every machine.
 */
const EXPECTED_LINES: Readonly<Record<(typeof AGREEMENT)[number], readonly number[]>> = {
  kerning: [0],
  hangul: [0],
  'mixed-sizes': [0],
  'hangul-in-latin': [0],
  'two-families': [0],
  'spacing-tight': [0],
  'spacing-wide': [0],
  'small-12': [0],
  'small-9': [0],
  wrapped: [0, 10, 30],
  'align-center': [0],
  'align-right': [0],
};

/** Section 6.3 named limits, by dated amendment only. None so far. */
const NAMED_LIMITS: Readonly<Record<string, RasterBounds>> = {};

/** The placed DOM cluster's pen and baseline read back within this of the target (CSS px). */
const PLACEMENT_RESIDUAL = 1 / 32;

const FONT_LOAD_FAMILY = 'M6c Font Load';
const FONT_LOAD_URL = '/m6c-font-load.otf';
/** The committed test font (M6a-Q13 (a)), served under another family for section 7. */
const FONT_BYTES = readFileSync(
  path.resolve(import.meta.dirname, '../fixtures/m6-text/fonts/NotoSansKR-Regular-subset.otf'),
);

const smoke = () => test.info().project.name === 'chromium-smoke';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&fixture=text-gpu');
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  await expect(status).toHaveAttribute('data-fixture', 'loaded', { timeout: 30_000 });
  await expect(status).toHaveAttribute('data-text-font', 'loaded');
  await expect(status).not.toHaveAttribute('data-renderer', 'pending', { timeout: 30_000 });
  const ready = (await status.getAttribute('data-renderer')) === 'ready';
  if (!smoke()) {
    expect(ready).toBe(true);
    await expect(page.getByTestId('error')).toHaveCount(0);
  }
  const switched = await page.evaluate(
    () => window.__p5Host!.editor.execute({ type: 'setActivePage', id: 'agreement' }).ok,
  );
  expect(switched).toBe(true);
  return { errors, ready };
}

/** Captures until the raster counters stop changing; returns the captures taken. */
async function settle(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const hook = window.__nextHostRenderer!;
    const counters = hook as unknown as CounterHook;
    let last = '';
    for (let frames = 1; frames <= 64; frames += 1) {
      await hook.capture();
      const now = `${counters.glyphRasterCalls} ${counters.glyphUploads}`;
      if (now === last) return frames;
      last = now;
    }
    throw new Error('The raster counters did not settle in 64 captures.');
  });
}

async function textScene(page: Page): Promise<TextScene> {
  const scene = await page.evaluate(() => (window.__p5Host as unknown as Hook).text.scene());
  expect(scene).not.toBeNull();
  return scene!;
}

async function readCluster(page: Page, id: string, index: number): Promise<ClusterRead> {
  return page.evaluate(
    ([leaf, at]) => (window.__p5Host as unknown as Hook).text.readCluster(leaf, at),
    [id, index] as const,
  );
}

/** The placed DOM cluster: placed by the hook, screenshot at device scale, read back. */
async function placedCluster(
  page: Page,
  id: string,
  index: number,
  options: PlacedReferenceOptions,
) {
  const placed = await page.evaluate(
    ([leaf, at, value]) => (window.__p5Host as unknown as Hook).text.reference(leaf, at, value),
    [id, index, options] as const,
  );
  try {
    const png = await page.screenshot({
      clip: placed.clip,
      scale: 'device',
      animations: 'disabled',
      caret: 'hide',
    });
    const crop = await page.evaluate(
      (value) => (window.__p5Host as unknown as Hook).text.readReference(value),
      png.toString('base64'),
    );
    return { placed, crop };
  } finally {
    await page.evaluate(() => (window.__p5Host as unknown as Hook).text.clearReference());
  }
}

const round = (value: number) => Math.round(value * 1e4) / 1e4;
const rounded = (term: RasterTerm) =>
  Object.fromEntries(
    Object.entries(term).map(([key, value]) => [
      key,
      typeof value === 'number' ? round(value) : value,
    ]),
  );
const inkSummary = (ink: Ink | null) =>
  ink === null
    ? null
    : {
        left: round(ink.left),
        top: round(ink.top),
        right: round(ink.right),
        bottom: round(ink.bottom),
        cx: round(ink.cx),
        cy: round(ink.cy),
        mass: round(ink.mass),
      };

type ClusterRow = Record<string, unknown> & { index: number; text: string; failures: string[] };

/**
 * One cluster's placement and raster terms. `failures` holds every gated check that failed,
 * prefixed by the term.
 */
async function clusterTerms(
  page: Page,
  scene: TextScene,
  id: string,
  index: number,
  bounds: RasterBounds,
): Promise<ClusterRow> {
  const leaf = scene.leaves.find((value) => value.id === id)!;
  const read = await readCluster(page, id, index);
  const failures: string[] = [];
  const { placement } = read;
  const run = leaf.leaf.runs[placement.run]!;
  const cluster = run.clusters[placement.cluster]!;
  const expected = expectedPlacement(
    leaf.world,
    scene.camera!,
    scene.devicePixelRatio,
    cluster,
    run.size,
  );
  for (const failure of placementFailures(placement, expected)) {
    failures.push(`placement ${failure}`);
  }
  if (read.status !== 'applied') failures.push(`probe status ${read.status}`);
  const row: ClusterRow = {
    index,
    text: placement.text,
    run: placement.run,
    o: placement.origin.map(round),
    P: placement.corner,
    phaseX: placement.phaseX,
    bucket: placement.bucket,
    quantX:
      placement.corner === null
        ? null
        : round(placement.corner[0] + placement.phaseX - placement.origin[0]),
    snapY: placement.corner === null ? null : round(placement.corner[1] - placement.origin[1]),
    failures,
  };
  if (placement.mode !== 'snapped') return row;
  const gpu = measureInk(decodeCrop(read.crop));
  const dom = await placedCluster(page, id, index, {});
  const domInk = measureInk(decodeCrop(dom.crop));
  // Recorded only: LCD antialiasing where the OS uses it, and the pen at o.x itself.
  const lcd = await placedCluster(page, id, index, { lcd: true });
  const lcdInk = measureInk(decodeCrop(lcd.crop));
  const origin = await placedCluster(page, id, index, { pen: 'origin' });
  const originInk = measureInk(decodeCrop(origin.crop));
  row.residual = {
    x: round(dom.placed.residual.x),
    y: round(dom.placed.residual.y),
    passes: dom.placed.passes,
  };
  for (const [axis, value] of Object.entries(dom.placed.residual)) {
    if (Math.abs(value) > PLACEMENT_RESIDUAL) {
      failures.push(`reference residual ${axis} ${value} > ${PLACEMENT_RESIDUAL}`);
    }
  }
  row.gpu = inkSummary(gpu);
  row.dom = inkSummary(domInk);
  // The gated DOM read must be grayscale (composited layer), so ClearType cannot reach the gate.
  const chroma = maxChroma(decodeCrop(dom.crop));
  row.domChroma = chroma;
  if (chroma > ACHROMATIC_LIMIT) {
    failures.push(`dom chroma ${chroma} > ${ACHROMATIC_LIMIT}: the gated read is not grayscale`);
  }
  const blank = placement.text.trim().length === 0;
  if (blank || gpu === null || domInk === null) {
    // White space draws nothing on either side; ink on only one side is a failure.
    if (!blank || gpu !== null || domInk !== null) {
      failures.push(`raster blank mismatch: gpu ${gpu !== null}, dom ${domInk !== null}`);
    }
    return row;
  }
  const term = rasterTerm(gpu, domInk, scene.devicePixelRatio);
  row.raster = rounded(term);
  for (const failure of rasterFailures(term, bounds)) failures.push(`raster ${failure}`);
  row.lcd = lcdInk === null ? null : rounded(rasterTerm(gpu, lcdInk, scene.devicePixelRatio));
  row.originPen =
    originInk === null ? null : rounded(rasterTerm(gpu, originInk, scene.devicePixelRatio));
  return row;
}

test('M6c-A06 (structure): each agreement fixture keeps its committed line starts', async ({
  page,
}) => {
  const { errors } = await open(page);
  const actual = await page.evaluate((ids) => {
    const editor = window.__p5Host!.editor;
    return Object.fromEntries(
      ids.map((id) => {
        const layout = editor.query({ type: 'textLayout', id })!;
        return [
          id,
          {
            starts: layout.lines.map((line) => line.start),
            clusters: layout.clusters.map((cluster) => [cluster.start, cluster.line]),
          },
        ];
      }),
    );
  }, AGREEMENT);
  for (const id of AGREEMENT) {
    const { starts, clusters } = actual[id]!;
    expect(lineStarts({ lines: starts.map((start) => ({ start })) }), id).toEqual(
      EXPECTED_LINES[id],
    );
    // Each cluster's line follows from the starts.
    for (const [start, line] of clusters) {
      const expectedLine = EXPECTED_LINES[id].filter((value) => value <= start!).length - 1;
      expect(line, `${id} cluster at ${start}`).toBe(expectedLine);
    }
  }
  expect(errors).toEqual([]);
});

for (const id of AGREEMENT) {
  test(`M6c-A06: ${id} agrees with the port and the browser's paint (section 6.1 split)`, async ({
    page,
  }, info) => {
    test.setTimeout(600_000);
    const { errors, ready } = await open(page);
    test.skip(!ready, 'The renderer did not start (smoke run): there is no GPU cluster.');
    const frames = await settle(page);
    const scene = await textScene(page);
    const dpr = scene.devicePixelRatio;
    expect(dpr).toBe(await page.evaluate(() => window.devicePixelRatio));
    // Section 6.2's gated rows are at camera zoom 1.
    expect(scene.camera!.zoom).toBe(1);
    const leaf = scene.leaves.find((value) => value.id === id);
    expect(leaf, `${id} is projected`).toBeDefined();
    // M6-G1: the leaf draws the port's positions, no second layout.
    const layout = await page.evaluate(
      (nodeId) => window.__p5Host!.editor.query({ type: 'textLayout', id: nodeId })!,
      id,
    );
    const leafClusters = leaf!.leaf.runs.flatMap((run) => run.clusters);
    expect(leafClusters.map((cluster) => [cluster.x, cluster.y, cluster.advance])).toEqual(
      layout.clusters.map((cluster) => [cluster.x, cluster.y, cluster.advance]),
    );
    expect(leaf!.leaf.generation).toBe(layout.generation);
    const bounds = NAMED_LIMITS[id] ?? RASTER_BOUNDS;
    const rows: ClusterRow[] = [];
    for (let index = 0; index < leafClusters.length; index += 1) {
      rows.push(await clusterTerms(page, scene, id, index, bounds));
    }
    const flowed = layoutTerm(
      await page.evaluate(
        (nodeId) => (window.__p5Host as unknown as Hook).text.reference(nodeId),
        id,
      ),
      dpr,
    );
    const extra: Record<string, unknown> = {};
    if (id === 'small-9') {
      // Section 6.2 and M6-S0's open small-9 question: the browser's minimum font size (M6-S0's
      // probe in the fixture's font list) and the port's clamp check as the M6a-A11 spec makes it.
      extra.minimumFontSize = await page.evaluate(
        ([fontList, lang]) =>
          (window.__p5Host as unknown as Hook).text.minimumFontSize(fontList, lang),
        [leaf!.leaf.runs[0]!.fontList, leaf!.leaf.lang] as const,
      );
      extra.portClamp = await page.evaluate(() => {
        const port = (window.__p5Host as unknown as Hook).text.port;
        const request = (size: number) => ({
          runs: [{ text: 'Vector 한글 Studio', family: 'Noto Sans KR', size }],
          width: null,
          align: 'left',
          letterSpacing: 0,
          lineHeight: 1.2,
        });
        const width9 = port.layout(request(9)).width;
        const width18 = port.layout(request(18)).width;
        const ratio = width9 / (width18 / 2);
        return { width9, width18, ratio, clampSuspected: ratio > 1.02 };
      });
    }
    const raster = rows.flatMap((row) =>
      row.raster === undefined ? [] : [row.raster as RasterTerm],
    );
    const max = (pick: (term: RasterTerm) => number) =>
      round(Math.max(0, ...raster.map((term) => Math.abs(pick(term)))));
    // The browser and whether its 2D context has `lang`, which the raster port sets (the
    // locale's `locl` forms depend on it, U3 follow-up notes).
    const environment = {
      browserVersion: page.context().browser()?.version() ?? null,
      userAgent: await page.evaluate(() => navigator.userAgent),
      contextLang: await page.evaluate(() => 'lang' in OffscreenCanvasRenderingContext2D.prototype),
    };
    const summary = {
      fixture: id,
      project: info.project.name,
      environment,
      devicePixelRatio: dpr,
      frames,
      bounds,
      clusters: rows.length,
      compared: raster.length,
      maxima: {
        subOffsetX: max((term) => term.subOffsetX),
        subOffsetY: max((term) => term.subOffsetY),
        subSizeDiff: max((term) => term.subSizeDiff),
        centroidX: max((term) => term.centroidX),
        centroidY: max((term) => term.centroidY),
        layoutDx: round(flowed.maxAbsDx),
        layoutDBaseline: round(flowed.maxAbsDBaseline),
      },
      layout: {
        sameLines: flowed.sameLines,
        lineMismatches: flowed.lineMismatches,
        clusters: flowed.clusters.map((row) => ({
          index: row.index,
          text: row.text,
          run: row.run,
          dx: round(row.dx),
          dBaseline: round(row.dBaseline),
          dxDevice: round(row.dxDevice),
          dBaselineDevice: round(row.dBaselineDevice),
        })),
      },
      ...extra,
      rows,
    };
    info.annotations.push({ type: 'm6c-a06', description: JSON.stringify(summary) });
    const failures = rows.flatMap((row) =>
      row.failures.map((failure) => `${row.index} ${JSON.stringify(row.text)}: ${failure}`),
    );
    expect(raster.length, `${id}: clusters compared`).toBeGreaterThan(0);
    expect(failures, `${id}: placement and raster terms`).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('M6c-A07: a web font that loads after the first draw re-projects and draws its face', async ({
  page,
}, info) => {
  test.setTimeout(600_000);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let requests = 0;
  await page.route(`**${FONT_LOAD_URL}`, async (route) => {
    requests += 1;
    await held;
    await route.fulfill({
      status: 200,
      body: FONT_BYTES,
      headers: { 'content-type': 'font/otf', 'cache-control': 'no-store' },
    });
  });
  const { errors, ready } = await open(page);
  test.skip(!ready, 'The renderer did not start (smoke run): there is no GPU cluster.');
  const id = 'font-load';
  /** The caret is put after "Font": an interior offset, so its x is cluster 4's pen origin. */
  const caretOffset = 4;
  await settle(page);
  const state = () =>
    page.evaluate(
      async ({ nodeId }) => {
        const host = window.__p5Host!;
        const text = (host as unknown as Hook).text;
        const scene = await text.scene();
        return {
          generation: text.port.generation,
          leafGeneration: scene?.leaves.find((leaf) => leaf.id === nodeId)?.leaf.generation ?? null,
          events: host.events.length,
          history: host.editor.query({ type: 'history' }),
          frame: host.editor.getSnapshot().document.nodes[nodeId]!.frame,
          layout: host.editor.query({ type: 'textLayout', id: nodeId })!,
          caret: host.editor.query({ type: 'textEditOverlay' })?.caret ?? null,
        };
      },
      { nodeId: id },
    );
  const entered = await page.evaluate(
    ({ nodeId, offset }) =>
      window.__p5Host!.editor.execute({
        type: 'enterTextEdit',
        id: nodeId,
        anchor: offset,
        focus: offset,
      }).ok,
    { nodeId: id, offset: caretOffset },
  );
  expect(entered).toBe(true);
  const before = await state();
  expect(before.leafGeneration).toBe(before.layout.generation);
  const textOf = await page.evaluate(
    (nodeId) =>
      (
        window.__p5Host!.editor.getSnapshot().document.nodes[nodeId] as unknown as {
          runs: { text: string }[];
        }
      ).runs
        .map((run) => run.text)
        .join(''),
    id,
  );
  const inked = before.layout.clusters.flatMap((cluster, index) =>
    textOf.slice(cluster.start, cluster.end).trim().length > 0 ? [index] : [],
  );
  await page.evaluate(
    ({ family, url }) => {
      const port = (window.__p5Host as unknown as Hook).text.port;
      window.__m6cFontLoad = port.registerFont({ family, source: { url } });
    },
    { family: FONT_LOAD_FAMILY, url: FONT_LOAD_URL },
  );
  await expect.poll(() => requests, { timeout: 30_000 }).toBeGreaterThan(0);
  // Held: adding the face bumps the generation (M6a-U4 note 6), and the node is laid out and
  // drawn again with the fallback while the face loads.
  await expect
    .poll(
      async () => {
        const now = await state();
        return now.leafGeneration === now.generation;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await settle(page);
  const holding = await state();
  const fallback = new Map<number, string>();
  const heldBlank: number[] = [];
  for (const index of inked) {
    const crop = (await readCluster(page, id, index)).crop;
    // Every held fallback cluster has ink, so a changed crop below is a change of face.
    if (measureInk(decodeCrop(crop)) === null) heldBlank.push(index);
    fallback.set(index, crop.rgbaBase64);
  }
  expect(heldBlank, 'held fallback clusters without ink').toEqual([]);
  release();
  expect(await page.evaluate(() => window.__m6cFontLoad!)).toBe('loaded');
  await expect
    .poll(
      async () => {
        const now = await state();
        return (
          now.leafGeneration !== null &&
          now.leafGeneration === now.generation &&
          now.generation > holding.generation
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const frames = await settle(page);
  const after = await state();
  const events = await page.evaluate((from) => window.__p5Host!.events.slice(from), before.events);
  // The generation rose and the leaf has it, with no document event and no history step.
  expect(after.generation).toBeGreaterThan(holding.generation);
  expect(after.leafGeneration).toBe(after.generation);
  expect(events.filter((event) => event.type === 'document')).toEqual([]);
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((event) => event.type === 'session' && event.field === 'textLayout')).toBe(
    true,
  );
  expect(after.history).toEqual(before.history);
  // The stored frame is unchanged until refitText; the face changed the layout.
  expect(after.frame).toEqual(before.frame);
  expect(after.layout.width).not.toBe(before.layout.width);
  // The caret overlay (`textEditOverlay`, the editor's caret geometry the host draws) follows the
  // new layout.
  const caretX = (value: typeof after) => value.caret![0].x - value.frame.x;
  expect(caretX(before)).toBeCloseTo(before.layout.clusters[caretOffset]!.x, 9);
  expect(caretX(after)).toBeCloseTo(after.layout.clusters[caretOffset]!.x, 9);
  expect(caretX(after)).not.toBeCloseTo(caretX(before), 3);

  // The GPU draws the new face: placement exact and raster within section 6.3 against the placed
  // DOM cluster of the new face, and no fallback bitmap reused (E28-K10).
  const scene = await textScene(page);
  const rows: ClusterRow[] = [];
  let changed = 0;
  const unchanged: number[] = [];
  for (const index of inked) {
    const row = await clusterTerms(page, scene, id, index, NAMED_LIMITS[id] ?? RASTER_BOUNDS);
    rows.push(row);
    const read = await readCluster(page, id, index);
    if (read.crop.rgbaBase64 !== fallback.get(index)) changed += 1;
    else unchanged.push(index);
  }
  // Every inked cluster's GPU raster changed with the face (E28-K10: no fallback bitmap reused).
  expect(unchanged, 'clusters whose GPU raster did not change with the face').toEqual([]);
  expect(changed).toBe(inked.length);

  // refitText refits the frame as one step.
  const refit = await page.evaluate((nodeId) => {
    const host = window.__p5Host!;
    const exited = host.editor.execute({ type: 'exitTextEdit' }).ok;
    const depth = host.editor.query({ type: 'history' }).undoDepth;
    const from = host.events.length;
    const result = host.editor.execute({ type: 'refitText', ids: [nodeId] });
    return {
      exited,
      ok: result.ok,
      steps: host.editor.query({ type: 'history' }).undoDepth - depth,
      documentEvents: host.events.slice(from).filter((event) => event.type === 'document').length,
      frame: host.editor.getSnapshot().document.nodes[nodeId]!.frame,
    };
  }, id);
  info.annotations.push({
    type: 'm6c-a07',
    description: JSON.stringify({
      project: info.project.name,
      devicePixelRatio: scene.devicePixelRatio,
      generations: [before.generation, holding.generation, after.generation],
      settleFrames: frames,
      widths: [before.layout.width, holding.layout.width, after.layout.width],
      caretX: [caretX(before), caretX(after)],
      changed,
      inked: inked.length,
      unchanged,
      refit,
      rows,
    }),
  });
  const failures = rows.flatMap((row) => row.failures.map((failure) => `${row.index}: ${failure}`));
  expect(failures).toEqual([]);
  expect(refit.exited).toBe(true);
  expect(refit.ok).toBe(true);
  expect(refit.steps).toBe(1);
  expect(refit.documentEvents).toBe(1);
  expect(refit.frame.width).toBe(after.layout.width);
  expect(refit.frame.height).toBe(after.layout.height);
  expect(errors).toEqual([]);
});
