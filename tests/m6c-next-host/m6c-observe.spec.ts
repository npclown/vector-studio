import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { TextScene } from '../../apps/next-host/src/m6c-text-probe';
import type { TextEditTestHook } from '../../apps/next-host/src/m6b-text-edit';
import {
  fillerText,
  keystrokeRow,
  OBSERVE_KEYS,
  OBSERVE_TEXT_LENGTH,
  QUIET_FRAMES,
  typingSummary,
  type KeystrokeLog,
  type TypingReport,
} from './m6c-observe';
import { expectLayoutBudget } from '../support/m8-n3-budget.js';

// M6c-U5 (MVP M6c contract, section 9 and M6c-A10): the typing observation (M6b-Q15 (a)),
// recorded, not judged. Run by playwright.m6c-observe.config.ts (`pnpm test:m6c-observe`), not by
// `pnpm test:m6c-next-host`. On `?fixture=text-edit` at camera zoom 1, over a white backdrop (U4
// note 2), the spec creates an `autoHeight` text node of 16,354 units in the committed test font
// (Latin and Hangul words), enters edit mode at offset 0 and types the 30 keys of `OBSERVE_KEYS`
// through Playwright's keyboard, one key at a time, so the node ends at 16,384 units, the M6b
// maximum. Typing at offset 0 reflows the whole visible text, so each keystroke lays the node
// out again and re-rasterizes the visible clusters whose phase moved (section 9: "now including
// rasters"). In the page: every `requestAnimationFrame` time, each keydown's `timeStamp`, every
// port `layout` call timed by a wrapper on the hook's text-dom port (the object the editor calls),
// the host service's raster calls with their times (`glyphRasterLog`, M6c-U5 adds the times), and
// `long-animation-frame` entries where the browser has them. A keystroke ends at the first of
// `QUIET_FRAMES` frames with no new layout or raster call and unchanged raster counters, after
// the document holds the key; the probe's `scene()` (read after that window, so its cost is not
// in it) must show the typed text in the leaf. Nothing is asserted on a time: the only failures
// are a run that did not type or draw what it should. The report is written under
// `M6C_OBSERVE_DIR` (the config sets it) as `typing/<project>.json` and as an annotation, and the
// config's teardown prints the summary. Without a renderer (the smoke project), raster figures
// are empty and the report says so; it is not M6c-A10 evidence.

/** The hook members this spec uses beyond the global `__p5Host` type (U4 does the same). */
type Hook = Readonly<{
  text: Readonly<{ scene(): Promise<TextScene | null> }>;
  textEdit: TextEditTestHook;
}>;

type Recorder = {
  frames: number[];
  keydowns: number[];
  layouts: { startMs: number; durationMs: number }[];
  longFrames: { startTime: number; duration: number; blockingDuration: number }[];
  longFramesSupported: boolean;
};

declare global {
  interface Window {
    /** The observation's in-page recorder. */
    __m6cU5?: Recorder;
  }
}

const BACKDROP = { x: -2000, y: -2000, width: 6000, height: 6000 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const FRAME = { x: 20, y: 20, width: 1200, height: 40 };
const SIZE = 14;
const START_LENGTH = OBSERVE_TEXT_LENGTH - OBSERVE_KEYS.length;

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
  if (test.info().project.name !== 'typing-smoke') {
    expect(ready).toBe(true);
    await expect(page.getByTestId('error')).toHaveCount(0);
  }
  // M8-N3 (M8-U6): the layout budget against the 17a2b0a measurement of this project.
  await expectLayoutBudget(page);
  return { errors, ready };
}

/** Animation frames until the raster counters hold for `QUIET_FRAMES` frames; returns the count. */
function quietFrames(page: Page): Promise<number> {
  return page.evaluate(async (quiet) => {
    const hook = window.__nextHostRenderer as unknown as
      { glyphRasterCalls: number; glyphUploads: number } | undefined;
    const read = () => (hook === undefined ? '' : `${hook.glyphRasterCalls} ${hook.glyphUploads}`);
    let last = read();
    let still = 0;
    for (let frames = 1; frames <= 2000; frames += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = read();
      still = now === last ? still + 1 : 0;
      last = now;
      if (still >= quiet) return frames;
    }
    throw new Error('The raster counters did not settle in 2000 frames.');
  }, QUIET_FRAMES);
}

test('M6c-A10 typing observation: 30 keystrokes into a 16,384-unit node (recorded, not judged)', async ({
  page,
  browser,
}, info) => {
  test.setTimeout(600_000);
  const { errors, ready } = await open(page);
  const setup = await page.evaluate(
    ({ backdrop, white, black, frame, size, text }) => {
      const editor = window.__p5Host!.editor;
      editor.execute({ type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 1 } });
      const pageId = editor.getSnapshot().activePage;
      const under = editor.execute({
        type: 'createRectangle',
        frame: backdrop,
        fill: white,
        stroke: null,
        name: 'm6c-u5-backdrop',
        parent: pageId,
        index: 0,
      });
      const start = performance.now();
      const created = editor.execute({
        type: 'createText',
        frame,
        runs: [{ text, family: 'Noto Sans KR', size, color: black }],
        sizing: 'autoHeight',
        parent: pageId,
      });
      const createMs = performance.now() - start;
      return {
        backdrop: under.ok,
        id: created.ok ? created.ids[0]! : null,
        code: created.ok ? null : created.code,
        createMs,
      };
    },
    {
      backdrop: BACKDROP,
      white: WHITE,
      black: BLACK,
      frame: FRAME,
      size: SIZE,
      text: fillerText(START_LENGTH),
    },
  );
  expect(setup.backdrop).toBe(true);
  expect(setup.code).toBeNull();
  const id = setup.id!;
  const settleFrames = await quietFrames(page);
  const entered = await page.evaluate(
    (node) =>
      window.__p5Host!.editor.execute({ type: 'enterTextEdit', id: node, anchor: 0, focus: 0 }).ok,
    id,
  );
  expect(entered).toBe(true);
  await page.evaluate(() => new Promise((resolve) => setTimeout(() => setTimeout(resolve, 0), 20)));
  expect(await page.evaluate(() => (window.__p5Host as unknown as Hook).textEdit.focused())).toBe(
    'textarea',
  );

  // The in-page recorder: frames, keydowns, timed layout calls and long animation frames.
  await page.evaluate(() => {
    const recorder: Recorder = {
      frames: [],
      keydowns: [],
      layouts: [],
      longFrames: [],
      longFramesSupported: PerformanceObserver.supportedEntryTypes.includes('long-animation-frame'),
    };
    window.__m6cU5 = recorder;
    const tick = (time: number) => {
      recorder.frames.push(time);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.addEventListener(
      'keydown',
      (event) => {
        recorder.keydowns.push(event.timeStamp);
      },
      { capture: true },
    );
    const port = (
      window.__p5Host as unknown as { text: { port: { layout: (request: unknown) => unknown } } }
    ).text.port;
    const layout = port.layout;
    port.layout = function timedLayout(request: unknown) {
      const startMs = performance.now();
      try {
        return layout.call(port, request);
      } finally {
        recorder.layouts.push({ startMs, durationMs: performance.now() - startMs });
      }
    };
    if (recorder.longFramesSupported) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const frame = entry as PerformanceEntry & { blockingDuration?: number };
          recorder.longFrames.push({
            startTime: frame.startTime,
            duration: frame.duration,
            blockingDuration: frame.blockingDuration ?? 0,
          });
        }
      }).observe({ type: 'long-animation-frame' });
    }
    (
      window.__nextHostRenderer as unknown as { glyphRasterLog?: { clear(): void } } | undefined
    )?.glyphRasterLog?.clear();
  });

  const logs: KeystrokeLog[] = [];
  const failures: string[] = [];
  for (let index = 0; index < OBSERVE_KEYS.length; index += 1) {
    const key = OBSERVE_KEYS[index]!;
    const typed = OBSERVE_KEYS.slice(0, index + 1);
    await page.keyboard.press(key === ' ' ? 'Space' : key);
    // In the page: the document holds the key, then `QUIET_FRAMES` frames with no new call.
    const window_ = await page.evaluate(
      async ({ node, prefix, quiet, at }) => {
        const recorder = window.__m6cU5!;
        const editor = window.__p5Host!.editor;
        const counters = window.__nextHostRenderer as unknown as
          | {
              glyphRasterCalls: number;
              glyphUploads: number;
              glyphRasterLog: { entries: unknown[] };
            }
          | undefined;
        const text = () =>
          (
            editor.getSnapshot().document.nodes[node] as unknown as { runs: { text: string }[] }
          ).runs
            .map((run) => run.text)
            .join('');
        const work = () =>
          `${recorder.layouts.length} ${counters?.glyphRasterLog.entries.length ?? 0} ${counters?.glyphRasterCalls ?? 0} ${counters?.glyphUploads ?? 0}`;
        const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
        let last = work();
        let still = 0;
        let quietFrom = 0;
        for (let frames = 1; frames <= 2000; frames += 1) {
          const time = await frame();
          const now = work();
          const holds = text().startsWith(prefix) && recorder.keydowns.length > at;
          if (now === last && holds) {
            if (still === 0) quietFrom = time;
            still += 1;
          } else {
            still = 0;
          }
          last = now;
          if (still >= quiet) {
            return { keydownMs: recorder.keydowns[at]!, quietMs: quietFrom, length: text().length };
          }
        }
        return null;
      },
      { node: id, prefix: typed, quiet: QUIET_FRAMES, at: index },
    );
    if (window_ === null) {
      failures.push(`${key} (${index}): did not settle in 2000 frames`);
      break;
    }
    // After the window: the renderer accepted the typed text.
    const leafPrefix = await page.evaluate(
      async ({ node, length }) => {
        const scene = await (window.__p5Host as unknown as Hook).text.scene();
        const leaf = scene?.leaves.find((value) => value.id === node);
        if (leaf === undefined) return null;
        let text = '';
        for (const run of leaf.leaf.runs) {
          for (const cluster of run.clusters) {
            if (text.length >= length) return text;
            text += cluster.text;
          }
        }
        return text;
      },
      { node: id, length: typed.length },
    );
    if (ready && leafPrefix?.slice(0, typed.length) !== typed) {
      failures.push(`${key} (${index}): leaf starts ${JSON.stringify(leafPrefix)}`);
    }
    if (window_.length !== START_LENGTH + index + 1) {
      failures.push(`${key} (${index}): length ${window_.length}`);
    }
    logs.push({
      key,
      keydownMs: window_.keydownMs,
      quietMs: window_.quietMs,
      frames: [],
      layouts: [],
      rasters: [],
      longFrames: [],
    });
  }

  // The recorded calls, then one row per keystroke.
  const recorded = await page.evaluate(() => {
    const recorder = window.__m6cU5!;
    const log = (
      window.__nextHostRenderer as unknown as
        { glyphRasterLog: { entries: { startMs: number; durationMs: number }[] } } | undefined
    )?.glyphRasterLog.entries;
    return {
      frames: recorder.frames,
      layouts: recorder.layouts,
      longFrames: recorder.longFrames,
      longFramesSupported: recorder.longFramesSupported,
      rasters: (log ?? []).map(({ startMs, durationMs }) => ({ startMs, durationMs })),
    };
  });
  const rows = logs.map((log) =>
    keystrokeRow({
      ...log,
      frames: recorded.frames,
      layouts: recorded.layouts,
      rasters: recorded.rasters,
      longFrames: recorded.longFrames,
    }),
  );
  const end = await page.evaluate((node) => {
    const editor = window.__p5Host!.editor;
    const runs = (
      editor.getSnapshot().document.nodes[node] as unknown as { runs: { text: string }[] }
    ).runs;
    const layout = editor.query({ type: 'textLayout', id: node });
    return {
      text: runs.map((run) => run.text).join(''),
      lines: layout?.lines.length ?? 0,
      devicePixelRatio: window.devicePixelRatio,
      userAgent: navigator.userAgent,
      keydowns: window.__m6cU5!.keydowns.length,
    };
  }, id);
  const report: TypingReport = {
    project: info.project.name,
    browser: browser.version(),
    userAgent: end.userAgent,
    devicePixelRatio: end.devicePixelRatio,
    renderer: ready,
    startLength: START_LENGTH,
    endLength: end.text.length,
    lines: end.lines,
    setup: { createMs: setup.createMs, settleFrames },
    summary: typingSummary(rows),
    rows,
  };
  const directory = path.resolve(
    process.env.M6C_OBSERVE_DIR ?? path.join('artifacts', 'm6c-u5-observe', 'unnamed'),
    'typing',
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, `${info.project.name}.json`),
    JSON.stringify(
      { ...report, longFramesSupported: recorded.longFramesSupported, failures },
      null,
      2,
    ),
  );
  info.annotations.push({ type: 'm6c-a10-typing', description: JSON.stringify(report.summary) });
  console.log(
    `[m6c-u5] ${info.project.name}: ${rows.length} keystrokes, frame ms mean ${report.summary.frameMs.mean} max ${report.summary.frameMs.max}, layout ms per key mean ${report.summary.layoutMs.mean}, raster calls per key mean ${report.summary.rasterCalls.mean}`,
  );
  expect(end.text).toBe(OBSERVE_KEYS + fillerText(START_LENGTH));
  expect(end.text.length).toBe(OBSERVE_TEXT_LENGTH);
  // Review N4: one keydown per key, so each window starts at its own key.
  expect(end.keydowns).toBe(OBSERVE_KEYS.length);
  expect(failures).toEqual([]);
  expect(errors).toEqual([]);
});
