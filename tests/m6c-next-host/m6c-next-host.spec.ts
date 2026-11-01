import type { Editor, EditorEvent } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';
import type {
  ClusterRead,
  ClusterRect,
  DeviceBox,
  TextScene,
} from '../../apps/next-host/src/m6c-text-probe';

// M6c-U2 (MVP M6c contract, section 5; M6c-A04): next-host draws its projected text with
// `text: 'atlas'` and the canvas glyph raster port, in headed Chrome and Edge.
// - Ink. On `?fixture=text` (both pages), `?fixture=text-edit` and `?fixture=text-gpu` (pages
//   `agreement` and `scene`), once the raster counters settle, the frame is captured with the
//   text shown and again with every text node of the page hidden (`setNodeProps`, undone after):
//   every shown leaf with a non-space cluster on the canvas has changed pixels inside its
//   clusters' E28-K9 device bounds (`scene()`'s `inkBounds`), and no pixel changes outside the
//   union of every leaf's bounds; on `agreement` also every non-space cluster changes pixels
//   inside its port bitmap rectangle (`clusterRects`). The undos must restore the document
//   exactly. The host canvas clears to opaque black and the M6a and M6b
//   fixtures' text is mostly black, so on those two the text is first recoloured magenta with one
//   `setTextStyle` per node (as the M1-A12 spec recolours its black paints); `?fixture=text-gpu`
//   draws on its own white backdrop and is checked as committed.
// - Diagnostics. `window.__p5Host.events` holds no diagnostic, and the renderer hook's
//   diagnostics none with a severity other than `info` (so no `render.text-unavailable`,
//   `render.text-resource-limit` or `render.glyph-raster-failure`).
// - The probe. `scene()` lists the leaves the renderer accepted at the host's camera and DPR;
//   `readCluster(id, index)` draws one cluster black on white through the probe's own service
//   with its E28-K3 placement and bitmap rectangle, inked inside that rectangle, and leaves the
//   host's scene revision unchanged; over that rectangle the host frame is nowhere lighter than
//   the probe's ink (by more than one level); the hook's `glyphRasterCalls` and `glyphUploads` count.
// The settle loop's frame count is attached per fixture (E28: blank text past the 64-call raster
// budget for up to 16 frames on 1,000 clusters).
//
// The `chromium-smoke` project (M6C_NEXT_HOST_CHROMIUM, playwright.m6c-next-host.config.ts)
// runs headless where the renderer may fail to start (in the cloud container the geometry WASM
// is not built); it then checks that each fixture loads with the test font and skips the rest.
// It is not M6c-A04 evidence.

declare global {
  interface Window {
    /** The next-host page's test hook, present with `?test=1` (apps/next-host/app/page.tsx). */
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
    /** The renderer's test hook, present with `?test=1` (apps/next-host/src/webgpu-renderer.ts). */
    __nextHostRenderer?: Readonly<{
      capture: () => Promise<
        Readonly<{ width: number; height: number; devicePixelRatio: number; rgba: Uint8Array }>
      >;
      diagnostics: readonly Readonly<{ code: string; severity: string; message: string }>[];
    }>;
  }
}

/** The hook members M6c-U2 adds, declared apart as the M5 and M7 specs declare theirs. */
type ProbeHook = Readonly<{
  text: Readonly<{
    scene(): Promise<TextScene | null>;
    readCluster(id: string, index: number): Promise<ClusterRead>;
    clusterRects(id: string): Promise<readonly ClusterRect[]>;
  }>;
}>;
type CounterHook = Readonly<{ glyphRasterCalls: number; glyphUploads: number }>;

const FIXTURES = [
  { name: 'text', pages: ['page-1', 'page-2'], recolour: true, perCluster: [] },
  { name: 'text-edit', pages: ['page-1'], recolour: true, perCluster: [] },
  { name: 'text-gpu', pages: ['agreement', 'scene'], recolour: false, perCluster: ['agreement'] },
] as const;
/** Magenta: unlike the black clear colour, the white backdrops and every fixture paint. */
const MAGENTA = { r: 1, g: 0, b: 1, a: 1 };

const smoke = () => test.info().project.name === 'chromium-smoke';

async function open(page: Page, fixture: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?test=1&fixture=${fixture}`);
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
  return { errors, ready };
}

/**
 * Captures until the raster counters stop changing between two captures (the raster budget has
 * converged), and returns how many captures that took.
 */
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

/** Recolours every non-empty text node of the active page, one `setTextStyle` each. */
async function recolour(page: Page) {
  const steps = await page.evaluate((color) => {
    const { editor } = window.__p5Host!;
    const snapshot = editor.getSnapshot();
    const document = snapshot.document;
    let count = 0;
    const visit = (id: string) => {
      const node = document.nodes[id]!;
      if (node.type === 'text') {
        const length = node.runs.reduce((sum, run) => sum + run.text.length, 0);
        if (length === 0) return;
        const result = editor.execute({
          type: 'setTextStyle',
          id,
          start: 0,
          end: length,
          style: { color },
        });
        if (!result.ok) throw new Error(`setTextStyle ${id}: ${result.code}`);
        count += 1;
      } else if ('children' in node) {
        for (const child of node.children) visit(child);
      }
    };
    for (const id of document.pages.find((value) => value.id === snapshot.activePage)!.children) {
      visit(id);
    }
    return count;
  }, MAGENTA);
  expect(steps).toBeGreaterThan(0);
}

type InkReport = Readonly<{
  size: Readonly<{ width: number; height: number }>;
  leaves: readonly Readonly<{ id: string; onCanvas: boolean; changedInside: number }>[];
  /** Per-cluster rows, for the leaves given rectangles (review S2). */
  clusters: readonly Readonly<{
    id: string;
    index: number;
    text: string;
    rect: Readonly<{ x: number; y: number; width: number; height: number }>;
    changedInside: number;
  }>[];
  changedOutside: number;
  outsideSample: readonly (readonly [number, number])[];
}>;

/** Each leaf's clusters with their port bitmap rectangles (`clusterRects`), by leaf ID. */
async function clusterRects(
  page: Page,
  ids: readonly string[],
): Promise<Record<string, readonly ClusterRect[]>> {
  return page.evaluate(async (leaves) => {
    const hook = (window.__p5Host as unknown as ProbeHook).text;
    const out: Record<string, readonly ClusterRect[]> = {};
    for (const id of leaves) out[id] = await hook.clusterRects(id);
    return out;
  }, ids);
}

/**
 * Captures with the text shown and with every text node of the active page hidden, then undoes
 * the hides (each undo must succeed, every hidden node must be visible again and the document
 * must equal the one before the hides), and counts the changed pixels per leaf inside its
 * `inkBounds`, per non-space cluster of `rects` inside its port bitmap rectangle, and outside
 * every leaf's `bounds` (padded by 1 device px). A leaf is on the canvas when its unpadded
 * `inkBounds` meet the frame.
 */
async function inkReport(
  page: Page,
  scene: TextScene,
  rects: Record<string, readonly ClusterRect[]> = {},
): Promise<InkReport> {
  return page.evaluate(
    async ({ leaves, rects }) => {
      const { editor } = window.__p5Host!;
      const hook = window.__nextHostRenderer!;
      const shown = await hook.capture();
      const before = JSON.stringify(editor.query({ type: 'document' }));
      const snapshot = editor.getSnapshot();
      const document = snapshot.document;
      const hidden: string[] = [];
      const visit = (id: string) => {
        const node = document.nodes[id]!;
        if (node.type === 'text' && node.visible) hidden.push(id);
        if ('children' in node) for (const child of node.children) visit(child);
      };
      for (const id of document.pages.find((value) => value.id === snapshot.activePage)!.children) {
        visit(id);
      }
      for (const id of hidden) {
        const result = editor.execute({ type: 'setNodeProps', id, props: { visible: false } });
        if (!result.ok) throw new Error(`hide ${id}: ${result.code}`);
      }
      const without = await hook.capture();
      for (let step = 0; step < hidden.length; step += 1) {
        const result = editor.execute({ type: 'undo' });
        if (!result.ok) throw new Error(`undo ${step}: ${result.code}`);
      }
      const restored = editor.query({ type: 'document' });
      const invisible = hidden.filter((id) => restored.nodes[id]?.visible !== true);
      if (invisible.length > 0) throw new Error(`still hidden after undo: ${invisible.join(', ')}`);
      if (JSON.stringify(restored) !== before) throw new Error('undo did not restore the document');
      const { width, height } = shown;
      const changed = (x: number, y: number) => {
        const i = (y * width + x) * 4;
        return (
          shown.rgba[i] !== without.rgba[i] ||
          shown.rgba[i + 1] !== without.rgba[i + 1] ||
          shown.rgba[i + 2] !== without.rgba[i + 2]
        );
      };
      const meets = (box: DeviceBox) =>
        box.x1 > 0 && box.y1 > 0 && box.x0 < width && box.y0 < height;
      const clamp = (box: DeviceBox, pad: number) => ({
        x0: Math.max(0, Math.floor(box.x0) - pad),
        y0: Math.max(0, Math.floor(box.y0) - pad),
        x1: Math.min(width, Math.ceil(box.x1) + pad),
        y1: Math.min(height, Math.ceil(box.y1) + pad),
      });
      const count = (box: Readonly<{ x0: number; y0: number; x1: number; y1: number }>) => {
        let total = 0;
        for (let y = box.y0; y < box.y1; y += 1) {
          for (let x = box.x0; x < box.x1; x += 1) if (changed(x, y)) total += 1;
        }
        return total;
      };
      const inside = new Uint8Array(width * height);
      for (const leaf of leaves) {
        if (leaf.bounds === null) continue;
        const box = clamp(leaf.bounds, 1);
        for (let y = box.y0; y < box.y1; y += 1)
          inside.fill(1, y * width + box.x0, y * width + box.x1);
      }
      let changedOutside = 0;
      const outsideSample: [number, number][] = [];
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (inside[y * width + x] === 0 && changed(x, y)) {
            changedOutside += 1;
            if (outsideSample.length < 8) outsideSample.push([x, y]);
          }
        }
      }
      const report = leaves
        .filter((leaf) => leaf.shown && leaf.inkBounds !== null)
        .map((leaf) => ({
          id: leaf.id,
          onCanvas: meets(leaf.inkBounds!),
          changedInside: count(clamp(leaf.inkBounds!, 1)),
        }));
      const clusters: InkReport['clusters'][number][] = [];
      for (const leaf of leaves) {
        if (!leaf.shown) continue;
        for (const cluster of rects[leaf.id] ?? []) {
          const rect = cluster.rect;
          if (rect === null || cluster.text.trim().length === 0) continue;
          const box = { x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + rect.height };
          if (!meets(box)) continue;
          clusters.push({
            id: leaf.id,
            index: cluster.index,
            text: cluster.text,
            rect,
            changedInside: count(clamp(box, 0)),
          });
        }
      }
      return { size: { width, height }, leaves: report, clusters, changedOutside, outsideSample };
    },
    {
      leaves: scene.leaves.map(({ id, shown, bounds, inkBounds }) => ({
        id,
        shown,
        bounds,
        inkBounds,
      })),
      rects,
    },
  );
}

async function editorDiagnostics(page: Page) {
  return page.evaluate(() =>
    window.__p5Host!.events.filter((event) => event.type === 'diagnostic'),
  );
}

async function rendererDiagnostics(page: Page) {
  return page.evaluate(() =>
    window.__nextHostRenderer!.diagnostics.filter((entry) => entry.severity !== 'info'),
  );
}

async function textScene(page: Page): Promise<TextScene | null> {
  return page.evaluate(() => (window.__p5Host as unknown as ProbeHook).text.scene());
}

for (const fixture of FIXTURES) {
  test(`M6c-A04: ?fixture=${fixture.name} draws ink inside each text leaf's cluster bounds`, async ({
    page,
  }, info) => {
    const { errors, ready } = await open(page, fixture.name);
    test.skip(!ready, 'The renderer did not start (smoke run): nothing is drawn.');
    const rows: unknown[] = [];
    for (const pageId of fixture.pages) {
      const switched = await page.evaluate(
        (id) => window.__p5Host!.editor.execute({ type: 'setActivePage', id }).ok,
        pageId,
      );
      expect(switched).toBe(true);
      if (fixture.recolour) await recolour(page);
      const frames = await settle(page);
      const scene = await textScene(page);
      expect(scene?.identity.pageId).toBe(pageId);
      expect(scene!.camera).not.toBeNull();
      expect(scene!.devicePixelRatio).toBe(await page.evaluate(() => window.devicePixelRatio));
      // Review S2: on the agreement page ink is judged per non-space cluster, inside the port's
      // bitmap rectangle (a neighbour's overlapping ink can still pass a blank cluster).
      const perCluster = (fixture.perCluster as readonly string[]).includes(pageId);
      const rects = perCluster
        ? await clusterRects(
            page,
            scene!.leaves.map((leaf) => leaf.id),
          )
        : {};
      const report = await inkReport(page, scene!, rects);
      const blank = report.leaves.filter((leaf) => leaf.onCanvas && leaf.changedInside === 0);
      if (perCluster) {
        expect(report.clusters.length).toBeGreaterThan(100);
        const blankClusters = report.clusters.filter((cluster) => cluster.changedInside === 0);
        expect(blankClusters, `${pageId}: clusters with no ink in their bitmap rectangle`).toEqual(
          [],
        );
      }
      rows.push({
        page: pageId,
        frames,
        leaves: report.leaves,
        clusters: report.clusters.length,
        changedOutside: report.changedOutside,
      });
      expect(blank, `${pageId}: leaves with no ink inside their cluster bounds`).toEqual([]);
      expect(report.leaves.filter((leaf) => leaf.onCanvas).length).toBeGreaterThan(0);
      expect(
        report.changedOutside,
        `${pageId}: pixels changed outside every leaf's bounds, e.g. ${JSON.stringify(report.outsideSample)}`,
      ).toBe(0);
    }
    info.annotations.push({ type: 'm6c-a04', description: JSON.stringify(rows) });
    expect(await editorDiagnostics(page)).toEqual([]);
    expect(await rendererDiagnostics(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('M6c-A04: the cluster probe draws a projected cluster through the host options', async ({
  page,
}, info) => {
  const { errors, ready } = await open(page, 'text-gpu');
  test.skip(!ready, 'The renderer did not start (smoke run): there is no probe host.');
  await settle(page);
  const counters = await page.evaluate(() => {
    const hook = window.__nextHostRenderer as unknown as CounterHook;
    return { calls: hook.glyphRasterCalls, uploads: hook.glyphUploads };
  });
  expect(counters.calls).toBeGreaterThan(0);
  expect(counters.uploads).toBeGreaterThan(0);
  const scene = (await textScene(page))!;
  expect(scene.leaves.map((leaf) => leaf.id)).toContain('kerning');
  const reads: unknown[] = [];
  for (const [id, index] of [
    ['kerning', 0],
    ['hangul', 0],
    ['mixed-sizes', 2],
    ['small-9', 0],
  ] as const) {
    const read = await page.evaluate(
      ([leaf, at]) => (window.__p5Host as unknown as ProbeHook).text.readCluster(leaf, at),
      [id, index] as const,
    );
    expect(read.status).toBe('applied');
    expect(read.placement).toMatchObject({ nodeId: id, index, mode: 'snapped' });
    expect(read.frame.devicePixelRatio).toBe(scene.devicePixelRatio);
    // The placement term (section 6.1): `P` and `phaseX` are K3 of `o`.
    const [ox, oy] = read.placement.origin;
    expect(Math.abs(read.placement.corner![0] + read.placement.phaseX - ox)).toBeLessThanOrEqual(
      1 / 8,
    );
    expect(Math.abs(read.placement.corner![1] - oy)).toBeLessThanOrEqual(0.5);
    expect(read.rect).not.toBeNull();
    // Ink (dark on the white backdrop) inside the bitmap rectangle, none outside the crop's K9 box.
    const ink = await page.evaluate((value) => {
      const bytes = Uint8Array.from(atob(value.crop.rgbaBase64), (char) => char.charCodeAt(0));
      let inside = 0;
      let outside = 0;
      for (let y = 0; y < value.crop.height; y += 1) {
        for (let x = 0; x < value.crop.width; x += 1) {
          const i = (y * value.crop.width + x) * 4;
          if (Math.min(bytes[i]!, bytes[i + 1]!, bytes[i + 2]!) > 250) continue;
          const dx = value.crop.x + x;
          const dy = value.crop.y + y;
          const rect = value.rect!;
          if (
            dx >= rect.x &&
            dx < rect.x + rect.width &&
            dy >= rect.y &&
            dy < rect.y + rect.height
          ) {
            inside += 1;
          } else {
            outside += 1;
          }
        }
      }
      return { inside, outside };
    }, read);
    // Review S3: the host draws this cluster as the probe does. Over the bitmap rectangle, where
    // the probe has ink the host frame is not lighter (a neighbour's overlap may darken it).
    const host = await page.evaluate(async (value) => {
      const frame = await window.__nextHostRenderer!.capture();
      const bytes = Uint8Array.from(atob(value.crop.rgbaBase64), (char) => char.charCodeAt(0));
      const rect = value.rect!;
      let compared = 0;
      let worst = 0;
      for (let dy = rect.y; dy < rect.y + rect.height; dy += 1) {
        for (let dx = rect.x; dx < rect.x + rect.width; dx += 1) {
          const cx = dx - value.crop.x;
          const cy = dy - value.crop.y;
          if (cx < 0 || cy < 0 || cx >= value.crop.width || cy >= value.crop.height) continue;
          if (dx < 0 || dy < 0 || dx >= frame.width || dy >= frame.height) continue;
          const p = (cy * value.crop.width + cx) * 4;
          const h = (dy * frame.width + dx) * 4;
          const probeInk = 255 - Math.min(bytes[p]!, bytes[p + 1]!, bytes[p + 2]!);
          if (probeInk <= 2) continue;
          const hostInk = 255 - Math.min(frame.rgba[h]!, frame.rgba[h + 1]!, frame.rgba[h + 2]!);
          compared += 1;
          worst = Math.max(worst, probeInk - hostInk);
        }
      }
      return { compared, worst };
    }, read);
    reads.push({
      id,
      index,
      placement: read.placement,
      rect: read.rect,
      ink,
      host,
      counters: read.counters,
    });
    expect(ink.inside).toBeGreaterThan(0);
    expect(ink.outside).toBe(0);
    expect(host.compared).toBeGreaterThan(0);
    // One level of rounding between the two frames; never lighter beyond it.
    expect(host.worst).toBeLessThanOrEqual(1);
  }
  info.annotations.push({ type: 'm6c-probe', description: JSON.stringify(reads) });
  // The host's scene is untouched by the probe.
  expect((await textScene(page))!.revision).toBe(scene.revision);
  expect(await editorDiagnostics(page)).toEqual([]);
  expect(await rendererDiagnostics(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('M6c-A04 (smoke half): each text fixture loads with the test font and lays out', async ({
  page,
}) => {
  for (const fixture of FIXTURES) {
    const { errors } = await open(page, fixture.name);
    const units = await page.evaluate(() => {
      const document = window.__p5Host!.editor.query({ type: 'document' });
      return Object.values(document.nodes).filter((node) => node.type === 'text').length;
    });
    expect(units).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  }
});
