import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { ClusterRead, FrameCrop, TextScene } from '../../apps/next-host/src/m6c-text-probe';
import type { TextEditTestHook } from '../../apps/next-host/src/m6b-text-edit';
import { decodeCrop, expectedPlacement, placementFailures, type Pixels } from './m6c-agreement';
import {
  extraInk,
  inkMask,
  inkOutside,
  judgeCluster,
  localInkShare,
  deviceMap,
  OPEN_RULE,
  uniformPixels,
} from './m6c-scene';

// M6c-U4 (MVP M6c contract, section 10, M6c-A08): typing and composition are visible. On
// `?fixture=text-edit` (tests/fixtures/m6-text/edit-host.v6.json, zoom 2), in headed Chrome and
// Edge at DPR 1 and 2, a word and a composing syllable are typed into node `t` through the
// editor's real input path, as the M6b spec drives it (tests/m6b-next-host/m6b-next-host.spec.ts):
// Playwright's keyboard for the word, then a CDP `Process` keydown with `Input.imeSetComposition`
// for the syllable `하`, its update to `한` and `Input.insertText` for the commit. After each input
// settles (the M6b-H4 reset, then the raster counters):
// - the document text, and the projected leaf's clusters, are the typed text; the leaf draws the
//   port's layout (every cluster's `x`, `y` and `advance` and the generation equal the
//   `textLayout` query) and every cluster's E28-K3 placement through the probe equals K1 to K3
//   recomputed apart from the renderer (the placement term, exact);
// - each non-space cluster drawn alone by the probe has ink, inside its local box and its port
//   bitmap rectangle, and the host frame is at least that dark over every probe ink pixel (black
//   on the white backdrop), so the typed cluster is drawn with ink; inside the leaf's E28-K9
//   bounds no pixel but the probe's ink grown by 1 px leaves the backdrop's white (review S3).
// The fixture's text is black and next-host clears to opaque black (M6c-U2 note on the M6a and
// M6b fixtures), and the fixture is pinned by the M6b spec, so the spec adds a white rectangle
// under the page's nodes at run time (U4 note 2) rather than recolouring the text: the typed
// text keeps the committed black style and draws exactly as the probe's black on white.
// Figures are an annotation (`m6c-a08`). The `chromium-smoke` project skips it when the renderer
// does not start; it is not M6c-A08 evidence.

declare global {
  interface Window {
    /** The host frame this spec keeps after each input settles. */
    __m6cU4Typed?: Readonly<{ width: number; height: number; rgba: Uint8Array }>;
  }
}

/** The hook members this spec uses (page.tsx), declared apart as the U2 and U3 specs do. */
type Hook = Readonly<{
  text: Readonly<{
    scene(): Promise<TextScene | null>;
    readCluster(id: string, index: number): Promise<ClusterRead>;
  }>;
  textEdit: TextEditTestHook;
}>;
type CounterHook = Readonly<{ glyphRasterCalls: number; glyphUploads: number }>;

const NODE = 't';
const BACKDROP = { x: -2000, y: -2000, width: 6000, height: 6000 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const LOCAL_SHARE = 0.98;

const smoke = () => test.info().project.name === 'chromium-smoke';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&fixture=text-edit');
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

/** Two macrotasks, so the M6b-H4 `MessageChannel` reset and React's commit have run. */
function editorSettle(page: Page) {
  return page.evaluate(
    () => new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 20)),
  );
}

/** Captures until the raster counters and the port's generation hold; returns the captures. */
async function settle(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const hook = window.__nextHostRenderer!;
    const counters = hook as unknown as CounterHook;
    let last = '';
    for (let frames = 1; frames <= 64; frames += 1) {
      await hook.capture();
      const generation = (window.__p5Host as unknown as { text: { port: { generation: number } } })
        .text.port.generation;
      const now = `${counters.glyphRasterCalls} ${counters.glyphUploads} ${generation}`;
      if (now === last) return frames;
      last = now;
    }
    throw new Error('The raster counters did not settle in 64 captures.');
  });
}

/** The M6b spec's rule 1 key: a `Process` keydown with key code 229 through CDP. */
function processKey(cdp: CDPSession, code: string) {
  return cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Process',
    code,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229,
  });
}

/** The node's text, its edit state and the projected leaf's text, for the settle poll. */
function state(page: Page) {
  return page.evaluate(async (id) => {
    const host = window.__p5Host!;
    const snapshot = host.editor.getSnapshot();
    const node = snapshot.document.nodes[id] as unknown as { runs: { text: string }[] };
    const scene = await (host as unknown as Hook).text.scene();
    const leaf = scene?.leaves.find((value) => value.id === id);
    return {
      text: node.runs.map((run) => run.text).join(''),
      leafText:
        leaf?.leaf.runs.flatMap((run) => run.clusters.map((cluster) => cluster.text)).join('') ??
        null,
      composing: snapshot.textEdit !== null && snapshot.textEdit.composition !== null,
      focus: snapshot.textEdit?.focus ?? null,
      focused: (host as unknown as Hook).textEdit.focused(),
    };
  }, NODE);
}

/** Captures the host frame once and keeps it in the page (review N2). */
async function keepFrame(page: Page): Promise<Readonly<{ width: number; height: number }>> {
  return page.evaluate(async () => {
    const frame = await window.__nextHostRenderer!.capture();
    window.__m6cU4Typed = frame;
    return { width: frame.width, height: frame.height };
  });
}

/** A crop of the kept host frame over one device rectangle. */
async function hostCrop(
  page: Page,
  rect: Readonly<{ x: number; y: number; width: number; height: number }>,
): Promise<FrameCrop> {
  return page.evaluate((box) => {
    const frame = window.__m6cU4Typed!;
    const bytes = new Uint8Array(box.width * box.height * 4);
    for (let row = 0; row < box.height; row += 1) {
      const start = ((box.y + row) * frame.width + box.x) * 4;
      bytes.set(frame.rgba.subarray(start, start + box.width * 4), row * box.width * 4);
    }
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return { ...box, rgbaBase64: btoa(binary) };
  }, rect);
}

/**
 * Review S3: one bit per pixel of the kept frame, row major: inside `box` (device px) and not
 * the backdrop's white (a channel below 254).
 */
async function inkedBits(
  page: Page,
  box: Readonly<{ x0: number; y0: number; x1: number; y1: number }>,
): Promise<Uint8Array> {
  const packed = await page.evaluate((bounds) => {
    const frame = window.__m6cU4Typed!;
    const bits = new Uint8Array(Math.ceil((frame.width * frame.height) / 8));
    const x0 = Math.max(0, Math.floor(bounds.x0));
    const y0 = Math.max(0, Math.floor(bounds.y0));
    const x1 = Math.min(frame.width, Math.ceil(bounds.x1));
    const y1 = Math.min(frame.height, Math.ceil(bounds.y1));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const index = y * frame.width + x;
        const i = index * 4;
        if (Math.min(frame.rgba[i]!, frame.rgba[i + 1]!, frame.rgba[i + 2]!) < 254) {
          bits[index >> 3]! |= 1 << (index & 7);
        }
      }
    }
    let binary = '';
    for (let offset = 0; offset < bits.length; offset += 8192) {
      binary += String.fromCharCode(...bits.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }, box);
  return Uint8Array.from(Buffer.from(packed, 'base64'));
}

type Step = Readonly<{
  name: string;
  input: (page: Page, cdp: CDPSession) => Promise<void>;
  text: string;
  composing: boolean;
}>;

const key = (name: string) => async (page: Page) => page.keyboard.press(name);
const compose = (code: string, text: string) => async (_page: Page, cdp: CDPSession) => {
  await processKey(cdp, code);
  await cdp.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  });
};

/** A word typed after the committed `ab cd`, then a composing syllable and its commit. */
const STEPS: readonly Step[] = [
  { name: 'Space', input: key('Space'), text: 'ab cd ', composing: false },
  { name: 'v', input: key('v'), text: 'ab cd v', composing: false },
  { name: 'e', input: key('e'), text: 'ab cd ve', composing: false },
  { name: 'x', input: key('x'), text: 'ab cd vex', composing: false },
  { name: 'compose 하', input: compose('KeyG', '하'), text: 'ab cd vex하', composing: true },
  { name: 'compose 한', input: compose('KeyS', '한'), text: 'ab cd vex한', composing: true },
  {
    name: 'commit 한',
    input: async (_page, cdp) => {
      await cdp.send('Input.insertText', { text: '한' });
    },
    text: 'ab cd vex한',
    composing: false,
  },
];

test('M6c-A08: a typed word and a composing syllable draw at the port positions with ink', async ({
  page,
  context,
}, info) => {
  test.setTimeout(600_000);
  const { errors, ready } = await open(page);
  test.skip(!ready, 'The renderer did not start (smoke run): nothing is drawn.');
  // The white backdrop under every node of the page (U4 note 2).
  const backdrop = await page.evaluate(
    ({ frame, fill }) => {
      const editor = window.__p5Host!.editor;
      const result = editor.execute({
        type: 'createRectangle',
        frame,
        fill,
        stroke: null,
        name: 'm6c-u4-backdrop',
        parent: editor.getSnapshot().activePage,
        index: 0,
      });
      return result.ok ? result.ids : result.code;
    },
    { frame: BACKDROP, fill: WHITE },
  );
  expect(Array.isArray(backdrop)).toBe(true);
  await settle(page);
  const entered = await page.evaluate(
    (id) => window.__p5Host!.editor.execute({ type: 'enterTextEdit', id, anchor: 5, focus: 5 }).ok,
    NODE,
  );
  expect(entered).toBe(true);
  await editorSettle(page);
  expect((await state(page)).focused).toBe('textarea');
  const cdp = await context.newCDPSession(page);
  const rows: unknown[] = [];
  const failures: string[] = [];
  for (const step of STEPS) {
    await step.input(page, cdp);
    await editorSettle(page);
    // The renderer has accepted the typed text (the probe's record of the host's scene).
    await expect
      .poll(async () => (await state(page)).leafText, { timeout: 30_000 })
      .toBe(step.text);
    const frames = await settle(page);
    const now = await state(page);
    expect(now.text, step.name).toBe(step.text);
    expect(now.composing, `${step.name}: composing`).toBe(step.composing);
    expect(now.focused, `${step.name}: focus`).toBe('textarea');
    const scene = (await page.evaluate(() => (window.__p5Host as unknown as Hook).text.scene()))!;
    const leaf = scene.leaves.find((value) => value.id === NODE)!;
    expect(leaf.shown).toBe(true);
    const camera = scene.camera!;
    const dpr = scene.devicePixelRatio;
    // M6-G1: the leaf draws the port's layout, no second layout.
    const layout = await page.evaluate(
      (id) => window.__p5Host!.editor.query({ type: 'textLayout', id })!,
      NODE,
    );
    const clusters = leaf.leaf.runs.flatMap((run) =>
      run.clusters.map((cluster) => ({ cluster, size: run.size })),
    );
    expect(clusters.map(({ cluster }) => [cluster.x, cluster.y, cluster.advance])).toEqual(
      layout.clusters.map((cluster) => [cluster.x, cluster.y, cluster.advance]),
    );
    expect(leaf.leaf.generation).toBe(layout.generation);
    // The cluster that ends at the caret is the one just typed (or composed).
    const typed = layout.clusters.findIndex((cluster) => cluster.end === now.focus);
    expect(typed, `${step.name}: a cluster ends at the caret`).toBeGreaterThanOrEqual(0);
    const map = deviceMap(leaf.world, camera, dpr);
    const reads: Record<string, unknown>[] = [];
    const size = await keepFrame(page);
    const crops: Pixels[] = [];
    for (let index = 0; index < clusters.length; index += 1) {
      const { cluster, size: runSize } = clusters[index]!;
      const read = await page.evaluate(
        ([id, at]) => (window.__p5Host as unknown as Hook).text.readCluster(id, at),
        [NODE, index] as const,
      );
      const problems: string[] = [];
      if (read.status !== 'applied') problems.push(`probe status ${read.status}`);
      const expected = expectedPlacement(leaf.world, camera, dpr, cluster, runSize);
      for (const failure of placementFailures(read.placement, expected)) {
        problems.push(`placement ${failure}`);
      }
      const row: Record<string, unknown> = {
        index,
        text: cluster.text,
        P: read.placement.corner,
        phaseX: read.placement.phaseX,
        bucket: read.placement.bucket,
      };
      if (cluster.text.trim().length > 0) {
        const probe = decodeCrop(read.crop);
        crops.push(probe);
        const shown = decodeCrop(await hostCrop(page, read.crop));
        const judgement = judgeCluster({
          probe,
          shown,
          background: uniformPixels(read.crop, [255, 255, 255]),
          rule: OPEN_RULE,
          opacity: 1,
        });
        const share = localInkShare(probe, map, cluster, runSize);
        const outside = read.rect === null ? null : inkOutside(probe, read.rect);
        if (judgement.strong === 0) problems.push('no strong probe ink');
        if (judgement.strongChanged !== judgement.strong) {
          problems.push(
            `${judgement.strong - judgement.strongChanged} strong ink pixels unchanged`,
          );
        }
        if (judgement.tooLight > 0) {
          problems.push(`${judgement.tooLight} channels lighter than the probe's ink`);
        }
        if (share === null || share < LOCAL_SHARE) problems.push(`local ink share ${share}`);
        if (outside !== 0) problems.push(`ink outside the bitmap rectangle: ${outside}`);
        Object.assign(row, {
          strong: judgement.strong,
          strongChanged: judgement.strongChanged,
          tooLight: judgement.tooLight,
          worstLight: judgement.worstLight,
          share,
        });
      }
      row.problems = problems;
      for (const problem of problems)
        failures.push(`${step.name} ${index} ${cluster.text}: ${problem}`);
      reads.push(row);
    }
    // Review S3: inside the leaf's bounds, nothing but the probe's ink (grown by 1 px) is drawn.
    const extra = extraInk(
      await inkedBits(page, leaf.bounds!),
      inkMask(size.width, size.height, crops),
      size.width,
    );
    if (extra.count > 0) {
      failures.push(
        `${step.name}: ${extra.count} inked pixels no cluster accounts for, e.g. ${JSON.stringify(extra.sample)}`,
      );
    }
    rows.push({
      extraInk: extra,
      step: step.name,
      text: step.text,
      composing: step.composing,
      settleFrames: frames,
      typed,
      typedText: clusters[typed]?.cluster.text ?? null,
      generation: layout.generation,
      reads,
    });
    // The typed cluster is not white space after the first step: it has ink (checked above).
    if (step.name !== 'Space') {
      expect(clusters[typed]!.cluster.text.trim().length, step.name).toBeGreaterThan(0);
    }
  }
  info.annotations.push({
    type: 'm6c-a08',
    description: JSON.stringify({
      project: info.project.name,
      devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
      rows,
    }),
  });
  expect(failures).toEqual([]);
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

test('M6c-A08 (input half): the word and the syllable reach the document through real input', async ({
  page,
  context,
}) => {
  // No renderer needed: the same steps as above, judged on the document and the edit state only,
  // so the smoke project checks the input path the drawing test relies on.
  const { errors } = await open(page);
  const entered = await page.evaluate(
    (id) => window.__p5Host!.editor.execute({ type: 'enterTextEdit', id, anchor: 5, focus: 5 }).ok,
    NODE,
  );
  expect(entered).toBe(true);
  await editorSettle(page);
  const cdp = await context.newCDPSession(page);
  for (const step of STEPS) {
    await step.input(page, cdp);
    await editorSettle(page);
    const now = await page.evaluate((id) => {
      const host = window.__p5Host!;
      const snapshot = host.editor.getSnapshot();
      const node = snapshot.document.nodes[id] as unknown as { runs: { text: string }[] };
      const layout = host.editor.query({ type: 'textLayout', id });
      return {
        text: node.runs.map((run) => run.text).join(''),
        composing: snapshot.textEdit !== null && snapshot.textEdit.composition !== null,
        endsAtCaret:
          layout?.clusters.some((cluster) => cluster.end === snapshot.textEdit?.focus) ?? false,
        focused: (host as unknown as Hook).textEdit.focused(),
      };
    }, NODE);
    expect(now, step.name).toEqual({
      text: step.text,
      composing: step.composing,
      endsAtCaret: true,
      focused: 'textarea',
    });
  }
  expect(errors).toEqual([]);
});
