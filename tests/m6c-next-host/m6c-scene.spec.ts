import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { ClusterRead, FrameCrop, TextScene } from '../../apps/next-host/src/m6c-text-probe';
import { decodeCrop, expectedPlacement, placementFailures } from './m6c-agreement';
import {
  clusterKeys,
  deviceMap,
  devicePolygon,
  deviceRect,
  inkOutside,
  judgeCluster,
  localInkShare,
  OPEN_RULE,
  rasterKeySets,
  type Camera,
  type ClusterJudgement,
  type CoverRule,
} from './m6c-scene';

// M6c-U4 (MVP M6c contract, section 10, M6c-A05): M6-A10 through the editor. On
// `?fixture=text-gpu`'s `scene` page (tests/fixtures/m6-text/gpu/text-gpu.v6.json, U2 note 4),
// in headed Chrome and Edge at DPR 1 and 2 (the projects of playwright.m6c-next-host.config.ts):
// - Paint order, clip, mask, opacity, rotation, instances, at camera zoom 1, 0.5, 2 and 8. Once the
//   raster counters settle, the host frame is captured with the text shown and with every text
//   node of the page hidden (undone after, the document must be restored). Each non-space
//   cluster on the canvas is drawn alone by the probe (`readCluster`, black on white, opacity 1)
//   and judged per pixel of its ink (m6c-scene.ts): under `order-over` (painted above the text),
//   outside `clip-frame` and outside the mask source the shown frame equals the hidden one;
//   elsewhere it is the background darkened by the black text at the leaf's group opacity
//   (`fade-group`'s 0.5 included), over `order-under` too (painted below). The probe's ink lies
//   inside the cluster's local box mapped back through the leaf's device map (so the rotated node
//   draws rotated), and inside the port's bitmap rectangle when snapped; the snapped placement is
//   exact (E28-K1 to K3). No pixel changes outside every leaf's E28-K9 bounds. Each zoom names
//   the features it must see (counts > 0), so no check passes on an empty set.
// - Instances: the override's text and the non-overridden instance's source text are projected
//   and drawn (they are judged as every other leaf).
// - A generation change: every text node of the page is restyled to a family registered later
//   with the test font's bytes, held, then released. Across each bump the host's raster calls and
//   uploads lie between the non-space keys required on the target and the keys it may draw
//   (recomputed apart from the renderer), so every drawn key is rasterized again (E28-K10; bump 1
//   changes no face, so a reused older bitmap would make no call); every leaf ends at the port's
//   generation; the converged frame after the load equals the frame before the restyle, since the
//   face is the same font, and differs from the fallback's frame. Frames while a generation
//   converges are not judged: a deferred cluster may legally draw a same-generation bitmap of
//   another bucket or phase (E28 fallback), which no per-pixel rule tells from an older one.
// Figures are annotations (`m6c-a05` per zoom, `m6c-a05-generation`). The `chromium-smoke`
// project runs the structural test and skips the rest when the renderer does not start; it is
// not M6c-A05 evidence.

declare global {
  interface Window {
    /** Frames this spec keeps in the page, by name. */
    __m6cU4Frames?: Record<string, Readonly<{ width: number; height: number; rgba: Uint8Array }>>;
    __m6cU4Font?: Promise<'loaded' | 'error'>;
  }
}

/** The hook members this spec uses (page.tsx), declared apart as the U2 and U3 specs do. */
type Hook = Readonly<{
  text: Readonly<{
    port: Readonly<{
      generation: number;
      registerFont(font: { family: string; source: { url: string } }): Promise<'loaded' | 'error'>;
    }>;
    scene(): Promise<TextScene | null>;
    readCluster(id: string, index: number): Promise<ClusterRead>;
  }>;
}>;
type CounterHook = Readonly<{ glyphRasterCalls: number; glyphUploads: number }>;

/** The scene ID of an instance's expanded copy of a source node (editor-core `expandedId`). */
const expandedId = (instance: string, node: string) => `${instance}\u0000@${node}`;
const OVERRIDE_LEAF = expandedId('instance-override', 'symbol-text');
const SOURCE_LEAF = expandedId('instance-source', 'symbol-text');
/** Leaves under a clip chain: their keys may be culled by the clip, so they are not required. */
const CLIPPED = new Set(['clip-text', 'mask-text']);

type Feature = 'order' | 'clip' | 'mask' | 'fade' | 'rotated' | 'instances';
const ALL: readonly Feature[] = ['order', 'clip', 'mask', 'fade', 'rotated', 'instances'];
/**
 * The criterion's zooms. Zoom 2 shows the page's top-left 480 × 320 units, zoom 8 the 120 × 80
 * units around `Order` and `order-over` (32 px text at 256 device px at DPR 1, the raster cap,
 * and 512 at DPR 2, past it: the general mode).
 */
const ZOOMS: readonly Readonly<{ name: string; camera: Camera; features: readonly Feature[] }>[] = [
  { name: 'zoom 1', camera: { position: { x: 0, y: 0 }, zoom: 1 }, features: ALL },
  { name: 'zoom 0.5', camera: { position: { x: 0, y: 0 }, zoom: 0.5 }, features: ALL },
  {
    name: 'zoom 2',
    camera: { position: { x: 0, y: 0 }, zoom: 2 },
    features: ['order', 'clip', 'mask', 'rotated'],
  },
  { name: 'zoom 8', camera: { position: { x: 20, y: 15 }, zoom: 8 }, features: ['order'] },
];

/** Leaves whose probe ink must lie this much inside its local box (by coverage mass). */
const LOCAL_SHARE = 0.98;

const GEN_FAMILY = 'M6c Gen Bump';
const GEN_URL = '/m6c-gen-bump.otf';
/** The committed test font (M6a-Q13 (a)), served under another family for the bump. */
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
    () => window.__p5Host!.editor.execute({ type: 'setActivePage', id: 'scene' }).ok,
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

async function counters(page: Page) {
  return page.evaluate(() => {
    const hook = window.__nextHostRenderer as unknown as CounterHook;
    const text = (window.__p5Host as unknown as Hook).text;
    return {
      calls: hook.glyphRasterCalls,
      uploads: hook.glyphUploads,
      generation: text.port.generation,
    };
  });
}

/** The document geometry the cover rules and opacities read (the fixture is unrotated there). */
type Geometry = Record<
  string,
  Readonly<{
    parent: string;
    type: string;
    opacity: number;
    rotation: number;
    frame: Readonly<{ x: number; y: number; width: number; height: number }>;
    points: readonly number[] | null;
    text: string | null;
  }>
>;

async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const document = window.__p5Host!.editor.query({ type: 'document' });
    const out: Record<string, unknown> = {};
    for (const node of Object.values(document.nodes)) {
      const value = node as unknown as {
        id: string;
        parent: string;
        type: string;
        opacity: number;
        rotation: number;
        frame: { x: number; y: number; width: number; height: number };
        path?: { points: number[] };
        runs?: { text: string }[];
      };
      out[value.id] = {
        parent: value.parent,
        type: value.type,
        opacity: value.opacity,
        rotation: value.rotation,
        frame: value.frame,
        points: value.path?.points ?? null,
        text: value.runs?.map((run) => run.text).join('') ?? null,
      };
    }
    return out as Geometry;
  });
}

/** The fixture's cover rules in device px: `order-over` above, `clip-frame`, the mask source. */
function coverRules(geo: Geometry, camera: Camera, dpr: number): Record<string, CoverRule> {
  for (const id of ['order-over', 'clip-frame', 'mask-group', 'mask-shape']) {
    expect(geo[id]?.rotation, `${id} is unrotated`).toBe(0);
  }
  const group = geo['mask-group']!.frame;
  const shape = geo['mask-shape']!.frame;
  return {
    'order-text': {
      within: [],
      occluders: [deviceRect(geo['order-over']!.frame, camera, dpr)],
    },
    'clip-text': { within: [deviceRect(geo['clip-frame']!.frame, camera, dpr)], occluders: [] },
    'mask-text': {
      within: [
        devicePolygon(
          geo['mask-shape']!.points!,
          { ...shape, x: group.x + shape.x, y: group.y + shape.y },
          camera,
          dpr,
        ),
      ],
      occluders: [],
    },
  };
}

/**
 * A leaf's group opacity: its own times its document ancestors' (for an expanded leaf, the
 * instance's and its ancestors'; the fixture's symbol and its text are opaque).
 */
function groupOpacity(geo: Geometry, sceneId: string, own: number): number {
  const cut = sceneId.indexOf('\u0000');
  let id: string | undefined = cut < 0 ? geo[sceneId]?.parent : sceneId.slice(0, cut);
  let opacity = own;
  while (id !== undefined && geo[id] !== undefined) {
    opacity *= geo[id]!.opacity;
    id = geo[id]!.parent;
  }
  return opacity;
}

/**
 * Captures the frame with the text shown (`shown`) and with every text node of the active page
 * hidden (`hidden`), keeps both in the page, and undoes the hides. Returns the frame size, the
 * leaves still shown while hidden (must be none) and whether the document was restored.
 */
async function shownAndHidden(page: Page) {
  return page.evaluate(async () => {
    const { editor } = window.__p5Host!;
    const hook = window.__nextHostRenderer!;
    const text = (window.__p5Host as unknown as Hook).text;
    window.__m6cU4Frames ??= {};
    const shown = await hook.capture();
    window.__m6cU4Frames.shown = shown;
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
    const scene = await text.scene();
    const stillShown = (scene?.leaves ?? []).filter((leaf) => leaf.shown).map((leaf) => leaf.id);
    window.__m6cU4Frames.hidden = await hook.capture();
    for (let step = 0; step < hidden.length; step += 1) {
      const result = editor.execute({ type: 'undo' });
      if (!result.ok) throw new Error(`undo ${step}: ${result.code}`);
    }
    const restored = JSON.stringify(editor.query({ type: 'document' })) === before;
    return {
      width: shown.width,
      height: shown.height,
      hidden: hidden.length,
      stillShown,
      restored,
    };
  });
}

/** Crops of kept frames over one device rectangle, as `FrameCrop`s. */
async function keptCrops(
  page: Page,
  names: readonly string[],
  rect: Readonly<{ x: number; y: number; width: number; height: number }>,
): Promise<FrameCrop[]> {
  return page.evaluate(
    ({ names, rect }) =>
      names.map((name) => {
        const frame = window.__m6cU4Frames![name]!;
        const bytes = new Uint8Array(rect.width * rect.height * 4);
        for (let row = 0; row < rect.height; row += 1) {
          const start = ((rect.y + row) * frame.width + rect.x) * 4;
          bytes.set(frame.rgba.subarray(start, start + rect.width * 4), row * rect.width * 4);
        }
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        }
        return { ...rect, rgbaBase64: btoa(binary) };
      }),
    { names, rect },
  );
}

/** Pixels that differ between the kept `shown` and `hidden` frames outside every leaf's bounds. */
async function changedOutside(page: Page, scene: TextScene) {
  return page.evaluate(
    (boxes) => {
      const shown = window.__m6cU4Frames!.shown!;
      const hidden = window.__m6cU4Frames!.hidden!;
      const { width, height } = shown;
      const inside = new Uint8Array(width * height);
      for (const box of boxes) {
        const x0 = Math.max(0, Math.floor(box.x0) - 1);
        const y0 = Math.max(0, Math.floor(box.y0) - 1);
        const x1 = Math.min(width, Math.ceil(box.x1) + 1);
        const y1 = Math.min(height, Math.ceil(box.y1) + 1);
        for (let y = y0; y < y1; y += 1) inside.fill(1, y * width + x0, y * width + x1);
      }
      let count = 0;
      const sample: [number, number][] = [];
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (inside[y * width + x] === 1) continue;
          const i = (y * width + x) * 4;
          if (
            shown.rgba[i] !== hidden.rgba[i] ||
            shown.rgba[i + 1] !== hidden.rgba[i + 1] ||
            shown.rgba[i + 2] !== hidden.rgba[i + 2]
          ) {
            count += 1;
            if (sample.length < 8) sample.push([x, y]);
          }
        }
      }
      return { count, sample };
    },
    scene.leaves.flatMap((leaf) => (leaf.bounds === null ? [] : [leaf.bounds])),
  );
}

type Row = Readonly<
  {
    id: string;
    index: number;
    text: string;
    mode: string;
    share: number | null;
    outsideRect: number | null;
    failures: readonly string[];
  } & ClusterJudgement
>;

const round = (value: number) => Math.round(value * 1e4) / 1e4;

/** Judges every non-space cluster of every shown leaf on the canvas at the current camera. */
async function judgeScene(page: Page, camera: Camera) {
  const scene = await textScene(page);
  expect(scene.camera).toEqual(camera);
  const dpr = scene.devicePixelRatio;
  expect(dpr).toBe(await page.evaluate(() => window.devicePixelRatio));
  const geo = await geometry(page);
  const rules = coverRules(geo, camera, dpr);
  const frames = await shownAndHidden(page);
  expect(frames.hidden).toBeGreaterThan(0);
  expect(frames.stillShown, 'leaves still shown with every text node hidden').toEqual([]);
  expect(frames.restored, 'the undos restore the document').toBe(true);
  const outside = await changedOutside(page, scene);
  const canvas = { width: frames.width, height: frames.height };
  const rows: Row[] = [];
  for (const leaf of scene.leaves) {
    if (!leaf.shown) continue;
    const opacity = groupOpacity(geo, leaf.id, leaf.leaf.opacity);
    const rule = rules[leaf.id] ?? OPEN_RULE;
    const map = deviceMap(leaf.world, camera, dpr);
    const keys = clusterKeys(leaf, camera, dpr);
    const clusters = leaf.leaf.runs.flatMap((run) =>
      run.clusters.map((cluster) => ({ cluster, size: run.size })),
    );
    for (let index = 0; index < clusters.length; index += 1) {
      const { cluster, size } = clusters[index]!;
      const key = keys[index]!;
      if (cluster.text.trim().length === 0 || key.mode === 'omitted') continue;
      const { bound } = key;
      if (bound.x1 <= 0 || bound.y1 <= 0 || bound.x0 >= canvas.width || bound.y0 >= canvas.height) {
        continue;
      }
      const read = await page.evaluate(
        ([id, at]) => (window.__p5Host as unknown as Hook).text.readCluster(id, at),
        [leaf.id, index] as const,
      );
      const failures: string[] = [];
      if (read.status !== 'applied') failures.push(`probe status ${read.status}`);
      if (read.placement.mode !== key.mode) {
        failures.push(`mode ${read.placement.mode}, recomputed ${key.mode}`);
      }
      if (read.placement.mode === 'snapped') {
        const expected = expectedPlacement(leaf.world, camera, dpr, cluster, size);
        for (const failure of placementFailures(read.placement, expected)) {
          failures.push(`placement ${failure}`);
        }
      }
      if (read.crop.width === 0 || read.crop.height === 0) continue;
      const probe = decodeCrop(read.crop);
      const [shown, background] = (await keptCrops(page, ['shown', 'hidden'], read.crop)).map(
        decodeCrop,
      );
      const judgement = judgeCluster({
        probe,
        shown: shown!,
        background: background!,
        rule,
        opacity,
      });
      const share = localInkShare(probe, map, cluster, size);
      const outsideRect = read.rect === null ? null : inkOutside(probe, read.rect);
      const whole =
        bound.x0 >= 0 && bound.y0 >= 0 && bound.x1 <= canvas.width && bound.y1 <= canvas.height;
      if (share === null && whole) failures.push('the probe drew no ink');
      if (share !== null && share < LOCAL_SHARE) failures.push(`local ink share ${share}`);
      if (outsideRect !== null && outsideRect > 0) {
        failures.push(`${outsideRect} ink pixels outside the bitmap rectangle`);
      }
      if (judgement.hiddenChanged > 0) {
        failures.push(`${judgement.hiddenChanged} hidden pixels changed (clip, mask or order)`);
      }
      if (judgement.tooLight > 0) {
        failures.push(
          `${judgement.tooLight} channels lighter than the composite, by ${judgement.worstLight}`,
        );
      }
      if (judgement.tooDark > 0) {
        failures.push(
          `${judgement.tooDark} channels darker than the opacity allows, by ${judgement.worstDark}`,
        );
      }
      if (judgement.strongChanged !== judgement.strong) {
        failures.push(`${judgement.strong - judgement.strongChanged} strong ink pixels unchanged`);
      }
      rows.push({
        id: leaf.id,
        index,
        text: cluster.text,
        mode: read.placement.mode,
        share: share === null ? null : round(share),
        outsideRect,
        failures,
        ...judgement,
        worstLight: round(judgement.worstLight),
        worstDark: round(judgement.worstDark),
      });
    }
  }
  return { scene, rows, outside, frames };
}

/** Sums of a judgement field over the rows of one leaf. */
const total = (rows: readonly Row[], id: string, field: keyof ClusterJudgement) =>
  rows.filter((row) => row.id === id).reduce((sum, row) => sum + row[field], 0);

/** The features a zoom must see, each with its own count above zero. */
function featureCounts(rows: readonly Row[]): Record<Feature, Record<string, number>> {
  const rotated = rows.filter((row) => row.id === 'rotated-text');
  return {
    order: {
      hiddenUnderOrderOver: total(rows, 'order-text', 'hidden'),
      strongOverOrderUnder: total(rows, 'order-text', 'strongOnColour'),
    },
    clip: {
      hiddenOutsideClip: total(rows, 'clip-text', 'hidden'),
      strongInsideClip: total(rows, 'clip-text', 'strong'),
    },
    mask: {
      hiddenOutsideMask: total(rows, 'mask-text', 'hidden'),
      strongInsideMask: total(rows, 'mask-text', 'strong'),
    },
    fade: { denseAtGroupOpacity: total(rows, 'fade-text', 'solid') },
    rotated: {
      generalClusters: rotated.filter((row) => row.mode === 'general').length,
      strong: total(rows, 'rotated-text', 'strong'),
    },
    instances: {
      overrideStrong: total(rows, OVERRIDE_LEAF, 'strong'),
      sourceStrong: total(rows, SOURCE_LEAF, 'strong'),
    },
  };
}

test('M6c-A05 (structure): the scene page overlaps, clips, masks and instances its text', async ({
  page,
}) => {
  const { errors } = await open(page);
  const geo = await geometry(page);
  const box = (id: string) => geo[id]!.frame;
  // `order-over` is painted after `order-text` and covers part of it; `order-under` before it.
  const children = await page.evaluate(
    () =>
      window
        .__p5Host!.editor.query({ type: 'document' })
        .pages.find((value) => value.id === 'scene')!.children,
  );
  expect(children.indexOf('order-under')).toBeLessThan(children.indexOf('order-text'));
  expect(children.indexOf('order-text')).toBeLessThan(children.indexOf('order-over'));
  const text = box('order-text');
  const over = box('order-over');
  expect(over.x).toBeGreaterThan(text.x);
  expect(over.x + over.width).toBeLessThan(text.x + text.width);
  // The clipped text is wider than its frame; the masked text wider than the diamond's tip rows.
  expect(geo['clip-text']!.parent).toBe('clip-frame');
  expect(box('clip-text').x + box('clip-text').width).toBeGreaterThan(box('clip-frame').width);
  expect(geo['mask-group']!.type).toBe('maskGroup');
  expect(geo['mask-shape']!.type).toBe('path');
  expect(geo['fade-group']!.opacity).toBeLessThan(1);
  expect(geo['fade-text']!.parent).toBe('fade-group');
  expect(geo['rotated-text']!.rotation).not.toBe(0);
  expect(geo['instance-source']!.type).toBe('instance');
  // The cover rules and group opacities the drawing tests use, read from this document.
  const rules = coverRules(geo, { position: { x: 0, y: 0 }, zoom: 1 }, 1);
  expect(rules['order-text']!.occluders).toEqual([
    { kind: 'rect', x0: over.x, y0: over.y, x1: over.x + over.width, y1: over.y + over.height },
  ]);
  expect(rules['mask-text']!.within[0]).toMatchObject({ kind: 'polygon' });
  expect(groupOpacity(geo, 'fade-text', 1)).toBe(geo['fade-group']!.opacity);
  expect(groupOpacity(geo, 'order-text', 1)).toBe(1);
  expect(groupOpacity(geo, OVERRIDE_LEAF, 1)).toBe(1);
  // Laid out by the port: each text node has clusters.
  const clusters = await page.evaluate(() => {
    const editor = window.__p5Host!.editor;
    return ['order-text', 'clip-text', 'mask-text', 'fade-text', 'rotated-text', 'symbol-text'].map(
      (id) => editor.query({ type: 'textLayout', id })?.clusters.length ?? 0,
    );
  });
  expect(clusters.every((count) => count > 0)).toBe(true);
  expect(errors).toEqual([]);
});

for (const zoom of ZOOMS) {
  test(`M6c-A05: text in paint order, clipped, masked, faded, rotated and instanced at ${zoom.name}`, async ({
    page,
  }, info) => {
    test.setTimeout(900_000);
    const { errors, ready } = await open(page);
    test.skip(!ready, 'The renderer did not start (smoke run): nothing is drawn.');
    const moved = await page.evaluate(
      (camera) => window.__p5Host!.editor.execute({ type: 'setViewport', camera }).ok,
      zoom.camera,
    );
    expect(moved).toBe(true);
    const frames = await settle(page);
    const { scene, rows, outside } = await judgeScene(page, zoom.camera);
    const texts = Object.fromEntries(
      scene.leaves.map((leaf) => [
        leaf.id,
        leaf.leaf.runs.flatMap((run) => run.clusters.map((cluster) => cluster.text)).join(''),
      ]),
    );
    // The instances: the override's text and the source's text, each projected.
    expect(texts[OVERRIDE_LEAF]).toBe('Override 한글');
    expect(texts[SOURCE_LEAF]).toBe('Source 한글');
    expect(texts['symbol-text']).toBe('Source 한글');
    const counts = featureCounts(rows);
    info.annotations.push({
      type: 'm6c-a05',
      description: JSON.stringify({
        project: info.project.name,
        zoom: zoom.name,
        camera: zoom.camera,
        devicePixelRatio: scene.devicePixelRatio,
        settleFrames: frames,
        judged: rows.length,
        counts,
        changedOutside: outside,
        rows,
      }),
    });
    expect(rows.length).toBeGreaterThan(0);
    const failures = rows.flatMap((row) =>
      row.failures.map(
        (failure) => `${row.id} ${row.index} ${JSON.stringify(row.text)}: ${failure}`,
      ),
    );
    expect(failures).toEqual([]);
    for (const feature of zoom.features) {
      for (const [name, count] of Object.entries(counts[feature])) {
        expect(count, `${zoom.name}: ${feature} ${name}`).toBeGreaterThan(0);
      }
    }
    if (zoom.features.includes('rotated')) {
      // Every judged cluster of the rotated node is in E28's general mode.
      const rotated = rows.filter((row) => row.id === 'rotated-text');
      expect(rotated.every((row) => row.mode === 'general')).toBe(true);
    }
    expect(
      outside.count,
      `pixels changed outside every leaf's bounds, e.g. ${JSON.stringify(outside.sample)}`,
    ).toBe(0);
    expect(
      await page.evaluate(() => window.__p5Host!.events.filter((e) => e.type === 'diagnostic')),
    ).toEqual([]);
    expect(
      await page.evaluate(() =>
        window.__nextHostRenderer!.diagnostics.filter((entry) => entry.severity !== 'info'),
      ),
    ).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('M6c-A05: a generation change rasterizes every drawn key again and never draws an older bitmap', async ({
  page,
}, info) => {
  test.setTimeout(600_000);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let requests = 0;
  await page.route(`**${GEN_URL}`, async (route) => {
    requests += 1;
    await held;
    await route.fulfill({
      status: 200,
      body: FONT_BYTES,
      headers: { 'content-type': 'font/otf', 'cache-control': 'no-store' },
    });
  });
  const { errors, ready } = await open(page);
  test.skip(!ready, 'The renderer did not start (smoke run): nothing is drawn.');
  await settle(page);
  // A: the page as committed, and H: with every text node hidden (both kept in the page).
  const first = await shownAndHidden(page);
  expect(first.restored).toBe(true);
  expect(first.stillShown).toEqual([]);
  await page.evaluate(() => {
    const frames = window.__m6cU4Frames!;
    frames.A = frames.shown!;
    frames.H = frames.hidden!;
  });
  // Restyle every text node of the page to the family that is not registered yet (the fallback).
  const restyled = await page.evaluate((family) => {
    const { editor } = window.__p5Host!;
    const document = editor.query({ type: 'document' });
    const ids: string[] = [];
    const visit = (id: string) => {
      const node = document.nodes[id]!;
      if (node.type === 'text') {
        const length = node.runs.reduce((sum, run) => sum + run.text.length, 0);
        const result = editor.execute({
          type: 'setTextStyle',
          id,
          start: 0,
          end: length,
          style: { family },
        });
        if (!result.ok) throw new Error(`setTextStyle ${id}: ${result.code}`);
        ids.push(id);
      } else if ('children' in node) {
        for (const child of node.children) visit(child);
      }
    };
    for (const id of document.pages.find((value) => value.id === 'scene')!.children) visit(id);
    return ids;
  }, GEN_FAMILY);
  expect(restyled.length).toBeGreaterThan(5);
  await settle(page);
  const c0 = await counters(page);
  const fromEvents = await page.evaluate(() => window.__p5Host!.events.length);
  const history = await page.evaluate(() => window.__p5Host!.editor.query({ type: 'history' }));

  /** Pixels differing by more than one level between two kept frames, and the largest step. */
  const diff = (a: string, b: string) =>
    page.evaluate(
      ([left, right]) => {
        const x = window.__m6cU4Frames![left]!;
        const y = window.__m6cU4Frames![right]!;
        let count = 0;
        let max = 0;
        for (let i = 0; i < x.rgba.length; i += 4) {
          let step = 0;
          for (let c = 0; c < 3; c += 1)
            step = Math.max(step, Math.abs(x.rgba[i + c]! - y.rgba[i + c]!));
          max = Math.max(max, step);
          if (step > 1) count += 1;
        }
        return { count, max };
      },
      [a, b] as const,
    );
  const leafGenerations = async () =>
    (await textScene(page)).leaves.map((leaf) => leaf.leaf.generation);
  const keySets = (scene: TextScene) => {
    const frame = { width: first.width, height: first.height };
    const sets = rasterKeySets(
      scene.leaves.map((leaf) => ({ ...leaf, clipped: CLIPPED.has(leaf.id) })),
      scene.camera!,
      scene.devicePixelRatio,
      frame,
    );
    return {
      expected: sets.expected.size,
      expectedInk: sets.expectedInk.size,
      required: sets.required.size,
    };
  };

  // Bump 1: registering the face while its bytes are held (the fallback is laid out again).
  await page.evaluate(
    ({ family, url }) => {
      const port = (window.__p5Host as unknown as Hook).text.port;
      window.__m6cU4Font = port.registerFont({ family, source: { url } });
    },
    { family: GEN_FAMILY, url: GEN_URL },
  );
  await expect.poll(() => requests, { timeout: 30_000 }).toBeGreaterThan(0);
  await settle(page);
  const c1 = await counters(page);
  expect(c1.generation).toBeGreaterThan(c0.generation);
  expect(new Set(await leafGenerations())).toEqual(new Set([c1.generation]));
  const scene1 = await textScene(page);
  const keys1 = keySets(scene1);
  await page.evaluate(async () => {
    window.__m6cU4Frames!.B = await window.__nextHostRenderer!.capture();
  });

  // Bump 2: the face loads; it is the test font's, so the page draws as it did before restyling.
  release();
  expect(await page.evaluate(() => window.__m6cU4Font!)).toBe('loaded');
  await settle(page);
  const c2 = await counters(page);
  expect(c2.generation).toBeGreaterThan(c1.generation);
  expect(new Set(await leafGenerations())).toEqual(new Set([c2.generation]));
  const scene2 = await textScene(page);
  const keys2 = keySets(scene2);
  await page.evaluate(async () => {
    window.__m6cU4Frames!.C = await window.__nextHostRenderer!.capture();
  });
  const fallbackVsCommitted = await diff('B', 'A');
  const loadedVsFallback = await diff('C', 'B');
  const loadedVsCommitted = await diff('C', 'A');
  const events = await page.evaluate((from) => window.__p5Host!.events.slice(from), fromEvents);
  const steps = [
    { bump: 1, generations: [c0.generation, c1.generation], counters: [c0, c1], keys: keys1 },
    { bump: 2, generations: [c1.generation, c2.generation], counters: [c1, c2], keys: keys2 },
  ].map((step) => {
    const generations = step.generations[1]! - step.generations[0]!;
    return {
      ...step,
      calls: step.counters[1]!.calls - step.counters[0]!.calls,
      uploads: step.counters[1]!.uploads - step.counters[0]!.uploads,
      steps: generations,
    };
  });
  info.annotations.push({
    type: 'm6c-a05-generation',
    description: JSON.stringify({
      project: info.project.name,
      devicePixelRatio: scene2.devicePixelRatio,
      restyled,
      steps,
      fallbackVsCommitted,
      loadedVsFallback,
      loadedVsCommitted,
    }),
  });
  for (const step of steps) {
    expect(step.keys.required, `bump ${step.bump}: required keys`).toBeGreaterThan(20);
    // Every non-space key on the target is rasterized and uploaded again, and nothing else.
    expect(step.calls, `bump ${step.bump}: raster calls`).toBeGreaterThanOrEqual(
      step.keys.required,
    );
    expect(step.calls, `bump ${step.bump}: raster calls`).toBeLessThanOrEqual(
      step.keys.expected * step.steps,
    );
    expect(step.uploads, `bump ${step.bump}: uploads`).toBeGreaterThanOrEqual(step.keys.required);
    expect(step.uploads, `bump ${step.bump}: uploads`).toBeLessThanOrEqual(
      step.keys.expectedInk * step.steps,
    );
  }
  // The fallback face drew differently; the loaded face draws the committed frame again.
  expect(fallbackVsCommitted.count).toBeGreaterThan(0);
  expect(loadedVsFallback.count).toBeGreaterThan(0);
  expect(loadedVsCommitted.count).toBe(0);
  // A generation change is no document change and no history step.
  expect(events.filter((event) => event.type === 'document')).toEqual([]);
  expect(await page.evaluate(() => window.__p5Host!.editor.query({ type: 'history' }))).toEqual(
    history,
  );
  expect(
    await page.evaluate(() => window.__p5Host!.events.filter((e) => e.type === 'diagnostic')),
  ).toEqual([]);
  expect(errors).toEqual([]);
});
