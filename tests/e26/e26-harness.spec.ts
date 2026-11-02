import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installMemoryLedger, type MemoryLedger } from '../support/memory-ledger.js';
import {
  MEMORY_TRACE_CATEGORIES,
  memoryBlock,
  summarizeMemoryTrace,
  type HeapUsage,
} from '../support/memory-trace.js';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  canonicalJson,
  configurationHash,
  E26_DRIVERS,
  E26_ISOLATION,
  E26_SCENARIOS,
  E26_TYPICAL_VISIBLE,
  e26Configuration,
  editDragOffset,
  isolationBoundsMs,
  isolationTargets,
  loadScenarioDocument,
  M9_SCENARIOS,
  V20_UI0_SCENARIOS,
  M9_WINDOW,
  m9CameraClaims,
  m9Cameras,
  m9Configuration,
  m9LayoutTableSha256,
  sha256,
  visibility,
  type E26Camera,
  type E26Loaded,
  type E26Scenario,
} from './scenarios';
import { m1A13MoveSelection } from '../m1-a13/document';
import { generateM9V2Document } from '../m9/document';
import {
  compactLayout,
  M9_LAYOUT_TABLE,
  m9LayoutDiff,
  m9LayoutRequests,
  requestKey,
  type M9LayoutTable,
} from '../m9/layouts';
import { parseDocument } from '@vector-studio/model';
import type { TextLayoutRequest, TextLayoutResult } from '@vector-studio/contracts';
import { expandLayerRows, layerRowCount } from '../support/layer-list.js';
import { expectLayoutBudget } from '../support/m8-n3-budget.js';
import { installPageProbe, type Probe } from './probe';

// E26-U1c (E26 contract, sections 3 and 6): the headed harness. Each test is one repetition of
// one scenario on `apps/next-host?bench=1` (apps/next-host/src/e26-bench.ts) in a fresh context,
// and writes one run record: the configuration and its hash, the commit, the browser, and the
// metrics of section 3.2 with the raw samples.
//
//   - Frame scenarios: the camera is set, the edit drag's real pointer down lands on the M1-A13
//     move selection, then the bench driver runs in every render callback in continuous mode;
//     `rafCallbackIntervalMs` comes from the backend's frame measurements over [5000, 15000) ms
//     of the driver's clock, and the all-visible scenarios record U1a's draw-bound visibility at
//     the run's DPR (A01's "culls nothing", section 3.3 as amended by U1b).
//   - `e26-pointer-busy-10k/v1`: `persist=1`, the load's own write awaited, a `setStyle` fill on
//     a node outside the selection 100 ms before pointer down, the one-time rejection of the
//     pressed leaf armed 1.0 s after pointer down, and real `page.mouse` moves every 8 ms for 4 s
//     along the edit drag's path, on demand. The `plain` variant drops the fill and the
//     rejection (A04's second measure).
//
//   - `e26-isolation-m1-a13/v1` (E26-U6b, A06): `isolation=1`; R is the median of five
//     `replaceSnapshot` times of the M1-A13 page (five `loadDocument` commands), then one
//     `loadDocument` with one persistent rejection (the middle drawn leaf) and one with 16
//     scattered persistent rejections, each timed by its `e26-isolation` measure.
//
// Each record also holds the environment (the page's DPR, canvas size, screen, refresh estimate,
// GPU adapter, visibility and focus) and the page errors, with their stacks and page times
// (`pageErrors`; in the latency run also relative to the press and the font-load change). The
// probe (tests/e26/probe.ts) counts only canvas presses: an M9 run's layer-toggle clicks are
// listed apart. A run is invalid, kept and failed, when the device was lost or recovered, the
// page was hidden or lost focus, its DPR differs from the project's, a page error was thrown, or
// the interaction did not happen (section 3.5). Non-smoke
// runs refuse modified tracked files, so the recorded commit is what ran (untracked files
// are not checked: the reference PC keeps standing untracked entries). Do not touch the mouse
// during a run: the real pointer is captured on the canvas.
//
// The harness checks that each run completed and recorded its metrics; it does not assert the
// targets, because a baseline records misses. U6b's exit record reads the targets from the run
// records (maximum per-run p95, no rounding allowance).
//
// M9-U1 (M9 contract, sections 3.2 and 4): the M9 scenarios (`M9_SCENARIOS`) run only in the
// `-v2` projects (1600 x 1000) and the v1 ones only in the others, so each sitting runs both.
// An M9 run opens with `ui=1` (and `doc=m9-v2` for the v2 document), checks the right column
// beside the unchanged canvas, and before the warm-up clicks `layer-toggle-<id>` down the move
// selection's ancestry, recording the expanded IDs and the row count shown. Its configuration is
// `m9Configuration`'s (the E26 configuration with an `m9` record).
//   - `e26-pointer-busy-10k/v2` (busy): as v1, plus the font-load change 2.0 s after pointer
//     down, the test font registered under the second family through the bench hook, marked
//     `m9-font-load`; the long tasks it overlaps are flagged, not exempt (M9-Q3). The plain
//     variant drops it with the fill and the rejection.
//   - `m9-typing-10k/v1`: `persist=1`, the load's write awaited, the typical view, the bench's
//     typing seam (`enterTextEdit` on the 60-cluster node with the caret at 60), then 40 ASCII
//     characters through `page.keyboard`, each sent on a 120 ms cadence without waiting for the
//     page, as the latency drag's moves are; `keyToWorkDoneMs` per key from the bench hook.
//   - `m9-v2-layouts` (only when `E26_SCENARIOS` names it): lays out every page-1 text request
//     of the v2 document through the page's port (`?test=1`) in each -v2 project, asserts the
//     camera claims over those live layouts (`m9CameraClaims` at the cameras chosen from the
//     committed table tests/m9/m9-v2-layouts.json) and reports, without failing, how they differ
//     from that table; or, with `M9_RECORD_LAYOUTS=1`, writes the table (one project only).
//   - `m9-ui-geometry`: the canvas size and origin are equal with and without `ui=1`, and no
//     bench flag does anything without `?bench=1` (M9-A03).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDirectory = process.env.E26_RESULTS_DIR ?? path.join(root, 'test-results/e26-runs');
const smoke = process.env.E26_CHROMIUM !== undefined;
const repetitions = Number(process.env.E26_REPETITIONS ?? (smoke ? 1 : 5));
// M9-U3a diagnostic (not evidence): with `E26_TRACE=<directory>`, each run records a Chrome
// performance trace (timeline and V8 CPU samples) to `<directory>/<slug>.json`, from the probe's
// install to the end of the test. Tracing slows the page, so a traced run's numbers are not a
// measurement; it only shows where the main thread's time goes.
const traceDirectory = process.env.E26_TRACE;
const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'v8.execute',
  'disabled-by-default-v8.cpu_profiler',
  'blink.user_timing',
];
// PA-U4b (A09 memory method, docs/plans/pa-u4-a09-memory-method.md): with `E26_MEMORY=1`, each
// frame run installs the page ledgers before navigation, records the V8 GC events from before
// navigation to the end of the run and writes a `memory` block. Such a run is never timed
// evidence (A09-A03): its record carries `memoryVariant: true` and the summarizer skips it.
const memoryVariant = process.env.E26_MEMORY === '1';
if (memoryVariant && traceDirectory !== undefined)
  throw new Error('E26_MEMORY and E26_TRACE record different traces: set one');
let tracing: { browser: Browser } | null = null;
test.afterEach(async () => {
  if (tracing === null) return;
  const { browser } = tracing;
  tracing = null;
  await browser.stopTracing();
});
const filter = (process.env.E26_SCENARIOS ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);
const git = (command: string): string | null => {
  try {
    return execSync(command, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const commit = git('git rev-parse HEAD') ?? 'unknown';
const dirty = (git('git status --porcelain --untracked-files=no') ?? 'unknown') !== '';

type Variant = 'frame' | 'busy' | 'plain' | 'typing';
const runs: { scenario: E26Scenario; variant: Variant }[] = [
  ...E26_SCENARIOS,
  ...M9_SCENARIOS,
  ...V20_UI0_SCENARIOS,
]
  .filter(
    (scenario) => filter.length === 0 || filter.some((entry) => scenario.id.startsWith(entry)),
  )
  .flatMap((scenario): { scenario: E26Scenario; variant: Variant }[] =>
    scenario.interaction === 'latency-drag'
      ? [
          { scenario, variant: 'busy' },
          { scenario, variant: 'plain' },
        ]
      : scenario.interaction === 'typing'
        ? [{ scenario, variant: 'typing' }]
        : [{ scenario, variant: 'frame' }],
  );
/** M9-U1: the `-v2` projects run the M9 scenarios, the others the v1 ones. */
const v2Project = (name: string) => name.endsWith('-v2');

const loadedDocuments = new Map<E26Scenario['document'], E26Loaded>();
function loaded(document: E26Scenario['document']): E26Loaded {
  let value = loadedDocuments.get(document);
  if (value === undefined) {
    value = loadScenarioDocument(document);
    loadedDocuments.set(document, value);
  }
  return value;
}

/** Nearest-rank percentile of an ascending list; null when empty. */
function rank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
function summary(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    median: rank(sorted, 0.5),
    p95: rank(sorted, 0.95),
    p99: rank(sorted, 0.99),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1]!,
  };
}

/** The page side of `window.__e26Bench`, as far as the harness uses it (src/e26-bench.ts). */
type PageHook = {
  editor(): {
    execute(command: unknown): { ok: boolean; code?: string };
    query(query: unknown): unknown;
    subscribe(
      listener: (event: { type: string; code?: string; nodeIds?: readonly string[] }) => void,
    ): () => void;
  } | null;
  backend(): {
    setMode(mode: 'continuous' | 'on-demand'): void;
    startFrameMeasurements(capacity?: number): void;
    stopFrameMeasurements(): {
      frameIntervalsMs: readonly number[];
      encodeAndSubmitMs: readonly number[];
      droppedSamples: { frameIntervalsMs: number; encodeAndSubmitMs: number };
      startedAtMs?: number;
      endedAtMs?: number;
    };
    getStatistics(): {
      framesSubmitted: number;
      lifecycle: string;
      recoveryAttempts: number;
      mode: string;
    };
    invalidate(invalidation: { reason: 'scene' }): void;
    waitForSubmittedWork(): Promise<void>;
  } | null;
  setDriver(driver: unknown): void;
  driverSteps(): number;
  armReject(targets?: readonly string[], mode?: 'once' | 'persistent'): void;
  disarmReject(): void;
  rejections(): number;
  replaces: readonly { startMs: number; durationMs: number; nodes: number; status: string }[];
  latencies: readonly { inputMs: number; revision: number; doneMs: number | null; failed?: true }[];
  noChangeMoves: readonly number[];
  writes: readonly { startMs: number; endMs: number | null; ok: boolean | null }[];
  longTasks: readonly { startMs: number; durationMs: number }[];
  longTasksAvailable: boolean;
  isolations(): readonly { startMs: number; durationMs: number }[];
  keyLatencies: readonly {
    inputMs: number;
    revision: number;
    doneMs: number | null;
    failed?: true;
  }[];
  noChangeKeys: readonly number[];
  registerTestFont(family: string): Promise<string>;
  fontLoads: readonly {
    family: string;
    startMs: number;
    settledMs: number | null;
    endMs: number | null;
    status: string | null;
    generationBefore: number;
    generationAfter: number | null;
    bumps: number;
    lastBumpMs: number | null;
    revisionBefore: number;
    revisionAfter: number | null;
  }[];
  enterTextEdit(id: string, offset: number): { ok: boolean; code?: string };
  /** V20-U1: renders per counted component (`tests/v20/v20-render-count.spec.ts`). */
  renders(): Readonly<Record<string, number>>;
};
declare global {
  interface Window {
    __e26Bench?: PageHook;
    __e26Probe?: Probe;
  }
}

/** Page errors fail a run; console errors (a missing favicon, for one) are only recorded. */
async function installProbe(page: Page) {
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.addInitScript(installPageProbe);
  return { errors, consoleErrors };
}

/** The page's environment: DPR, canvas, screen, an idle refresh estimate and the GPU adapter. */
async function environment(page: Page) {
  return page.evaluate(async () => {
    const canvas = document.querySelector('canvas')!;
    const stamps: number[] = [];
    await new Promise<void>((resolve) => {
      const step = (time: number) => {
        stamps.push(time);
        if (stamps.length < 61) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    const intervals = stamps
      .slice(1)
      .map((time, index) => time - stamps[index]!)
      .sort((a, b) => a - b);
    let adapter: Record<string, string> | null = null;
    try {
      const gpu = (navigator as { gpu?: GPU }).gpu;
      const info = (await gpu?.requestAdapter({ powerPreference: 'high-performance' }))?.info;
      if (info !== undefined) {
        adapter = {
          vendor: info.vendor,
          architecture: info.architecture,
          device: info.device,
          description: info.description,
        };
      }
    } catch {
      adapter = null;
    }
    return {
      devicePixelRatio: window.devicePixelRatio,
      canvas: { width: canvas.width, height: canvas.height },
      screen: { width: screen.width, height: screen.height },
      idleRafMedianMs: intervals[Math.floor(intervals.length / 2)] ?? null,
      adapter,
      userAgent: navigator.userAgent,
    };
  });
}

/** Visibility and focus at a point of the run, with the probe's counts so far. */
async function presence(page: Page) {
  return page.evaluate(() => ({
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    visibilityChanges: window.__e26Probe!.visibilityChanges,
    blurs: window.__e26Probe!.blurs,
  }));
}

async function open(
  page: Page,
  query: string,
  errors: readonly string[],
  ui = false,
  budget = !ui,
): Promise<void> {
  await page.goto(`/?bench=1&${query}${ui ? '&ui=1' : ''}`);
  const status = page.getByTestId('status');
  await expect(status).toHaveAttribute('data-fixture', 'bench-loaded', { timeout: 90_000 });
  await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 90_000 });
  expect(errors).toEqual([]);
  // M8-N3 (M8-U6): the layout budget against the 17a2b0a measurement of this project. M9-U1:
  // 17a2b0a had no 1600 x 1000 bench project, so a `ui=1` run checks the column itself.
  // V-20 `ui=0` runs in the v2 projects, which have no 17a2b0a row: no budget check (`budget`).
  if (ui) await expectM9Column(page);
  else if (budget) await expectLayoutBudget(page, { bench: true });
  // M9-U1: the v2 document never runs on system fallback fonts (the page also fails its load).
  if (query.includes('doc=m9-v2')) {
    await expect(status, 'the committed test font').toHaveAttribute('data-text-font', 'loaded');
  }
  // The loaded scene reached the GPU: one more submission after both are set, and its work done.
  await page.evaluate(async () => {
    const backend = window.__e26Bench!.backend()!;
    const before = backend.getStatistics().framesSubmitted;
    backend.invalidate({ reason: 'scene' });
    while (backend.getStatistics().framesSubmitted === before) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    // A lost device rejects here; the run goes on so its record shows it (expectValidRun).
    await backend.waitForSubmittedWork().catch(() => undefined);
  });
}

/** The canvas content box (CSS px) and its backing size, and the side column's box. */
async function canvasGeometry(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const rect = canvas.getBoundingClientRect();
    const box = (testId: string) => {
      const element = document.querySelector(`[data-testid="${testId}"]`);
      if (element === null) return null;
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, width: value.width, height: value.height };
    };
    return {
      origin: { x: rect.left + canvas.clientLeft, y: rect.top + canvas.clientTop },
      size: { width: canvas.clientWidth, height: canvas.clientHeight },
      rightColumn: box('right-column'),
      // The bench's own aside: an Appearance panel outside the right column.
      aside:
        document
          .querySelector('[data-testid="appearance-panel"]')
          ?.closest('[data-testid="right-column"]') === null
          ? box('appearance-panel')
          : null,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bench: window.__e26Bench !== undefined,
    };
  });
}

/** M9-U1 (section 4): with `ui=1`, the right column beside the 1280 x 720 canvas, all in view. */
async function expectM9Column(page: Page): Promise<void> {
  expect(page.viewportSize(), 'the v2 viewport').toEqual(M9_WINDOW);
  const live = await canvasGeometry(page);
  expect(live.size, 'canvas CSS size').toEqual({ width: 1280, height: 720 });
  expect(live.aside, 'no bench aside with ui=1').toBeNull();
  const column = live.rightColumn;
  expect(column, 'the right column').not.toBeNull();
  expect(column!.left + column!.width, 'the column fits the window').toBeLessThanOrEqual(
    live.innerWidth,
  );
  expect(column!.top + column!.height, 'the column fits the window').toBeLessThanOrEqual(
    live.innerHeight,
  );
  expect(live.scrollWidth, 'no horizontal scroll').toBeLessThanOrEqual(live.clientWidth);
}

/**
 * M9-U1 (section 4): clicks `layer-toggle-<id>` for each ID, page down, and returns the rows the
 * layer tree then shows. V-20 (contract, section 4): the list is windowed, so each toggle's row is
 * scrolled into view first, and the count is the rows' `aria-setsize`.
 */
async function expandLayers(page: Page, ids: readonly string[]): Promise<number> {
  await expandLayerRows(page, ids);
  return layerRowCount(page);
}

/** Runs editor commands in the page and checks each result. */
async function execute(page: Page, commands: readonly unknown[]): Promise<void> {
  const results = await page.evaluate((list) => {
    const editor = window.__e26Bench!.editor()!;
    return list.map((command) => editor.execute(command));
  }, commands as unknown[]);
  for (const [index, result] of results.entries()) {
    expect(result.ok, `command ${index}: ${result.code ?? ''}`).toBe(true);
  }
}

/** The client point of a world point at a camera, as CanvasInput inverts it. */
async function clientPoint(
  page: Page,
  camera: E26Camera,
  world: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const origin = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + canvas.clientLeft, y: rect.top + canvas.clientTop };
  });
  return {
    x: origin.x + (world.x - camera.position.x) * camera.zoom,
    y: origin.y + (world.y - camera.position.y) * camera.zoom,
  };
}

/** The M1-A13 move selection, its pressed leaf's draw-bounds centre, and a node outside it. */
function moveTarget(document: E26Loaded) {
  const generated = document.generated as Parameters<typeof m1A13MoveSelection>[0];
  const selection = m1A13MoveSelection(generated);
  const box = document.bounds.get(selection.ids[0]);
  if (box === null || box === undefined) throw new Error('the pressed leaf has no draw bounds');
  const page = generated.pages[0]!.children as readonly string[];
  return {
    selection,
    press: { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 },
    outside: page[page.length - 1]!,
  };
}

type Presence = Awaited<ReturnType<typeof presence>>;

/**
 * An invalid run is not a measurement: it is kept (section 3.5: never replaced silently) and
 * fails the test after its record is written, so the record shows why.
 */
function expectValidRun(
  run: { lifecycle: string; recoveryAttempts: number },
  checks: Readonly<{
    errors: readonly string[];
    expectedDpr: number;
    pageDpr: number;
    start: Presence;
    end: Presence;
  }>,
): void {
  expect(run.recoveryAttempts, 'device recoveries during the run').toBe(0);
  expect(run.lifecycle).toBe('ready');
  expect(checks.errors, 'page errors').toEqual([]);
  expect(checks.pageDpr, 'the page DPR').toBe(checks.expectedDpr);
  for (const point of [checks.start, checks.end]) {
    expect(point.visibilityState, 'page visibility').toBe('visible');
    expect(point.hasFocus, 'page focus').toBe(true);
  }
  expect(checks.end.visibilityChanges, 'visibility changes').toBe(0);
  expect(checks.end.blurs, 'focus losses').toBe(0);
}

function record(name: string, value: unknown): void {
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(path.join(resultsDirectory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

/** The text of a text node in the page's document. */
function nodeText(page: Page, id: string): Promise<string | null> {
  return page.evaluate((nodeId) => {
    const node = window.__e26Bench!.editor()!.query({ type: 'node', id: nodeId }) as {
      runs?: readonly { text: string }[];
    } | null;
    return node?.runs?.map((run) => run.text).join('') ?? null;
  }, id);
}

/**
 * M9-U1: `m9-typing-10k/v1` (M9 contract, section 3.2). `keyToWorkDoneMs` per key: from the
 * `keydown` `timeStamp` to the submitted work of the first submission at or after the revision
 * the key produced (the bench hook's `keyLatencies`); a key that produced none is `no-change`.
 */
async function typingRun(
  page: Page,
  o: Readonly<{
    scenario: E26Scenario;
    base: Record<string, unknown>;
    slug: string;
    errors: string[];
    consoleErrors: string[];
    dpr: number;
    camera: E26Camera;
    expandTree: () => Promise<{
      expanded: readonly string[];
      rows: number;
      expectedRows: number;
    } | null>;
    typingTarget: string;
  }>,
): Promise<void> {
  const { scenario, errors, camera } = o;
  const typing = scenario.m9!.typing!;
  await open(page, `doc=${scenario.document}&persist=1`, errors, true);
  await page.waitForFunction(
    () => {
      const write = window.__e26Bench!.writes[0];
      return write !== undefined && write.endMs !== null;
    },
    undefined,
    { timeout: 30_000 },
  );
  const loadWriteOk = await page.evaluate(() => window.__e26Bench!.writes[0]!.ok);
  await execute(page, [
    { type: 'setViewport', camera },
    { type: 'setSnapping', enabled: false },
  ]);
  const layers = await o.expandTree();
  const env = await environment(page);
  const before = await nodeText(page, o.typingTarget);
  const entered = await page.evaluate(
    ({ id, offset }) => window.__e26Bench!.enterTextEdit(id, offset),
    { id: o.typingTarget, offset: typing.offset },
  );
  // The seam focuses the edit textarea (M6b-H1); then the entry's frame settles.
  await page
    .waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA', undefined, {
      timeout: 10_000,
    })
    .catch(() => undefined);
  const focused = await page.evaluate(() => document.activeElement?.tagName ?? null);
  await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await window
      .__e26Bench!.backend()!
      .waitForSubmittedWork()
      .catch(() => undefined);
  });
  const presenceStart = await presence(page);
  const startMs = await page.evaluate(() => performance.now());
  const started = Date.now();
  const sent: Promise<void>[] = [];
  const sentAtMs: number[] = [];
  // Each key is sent on the cadence without waiting for the page (as the latency drag's moves).
  for (const [index, character] of [...typing.text].entries()) {
    const wait = index * typing.intervalMs - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    sentAtMs.push(Date.now() - started);
    sent.push(page.keyboard.press(character));
  }
  await Promise.all(sent);
  // The last keys' submitted work and the autosave trailing write settle; then the run is read.
  await page.waitForTimeout(1_500);
  const after = await nodeText(page, o.typingTarget);
  const state = await page.evaluate((from) => {
    const hook = window.__e26Bench!;
    const stats = hook.backend()!.getStatistics();
    return {
      keyLatencies: hook.keyLatencies,
      noChangeKeys: hook.noChangeKeys,
      writes: hook.writes,
      longTasksAvailable: hook.longTasksAvailable,
      longTasks: hook.longTasks.filter((task) => task.startMs >= from),
      mode: stats.mode,
      lifecycle: stats.lifecycle,
      recoveryAttempts: stats.recoveryAttempts,
    };
  }, startMs);
  const presenceEnd = await presence(page);
  const pageErrors = await page.evaluate(() => window.__e26Probe!.pageErrors);
  const samples = state.keyLatencies
    .filter((entry) => entry.doneMs !== null && Number.isFinite(entry.doneMs))
    .map((entry) => entry.doneMs! - entry.inputMs);
  const open_ = (entry: (typeof state.keyLatencies)[number]) =>
    entry.failed !== true && (entry.doneMs === null || Number.isNaN(entry.doneMs));
  const result = {
    ...o.base,
    environment: env,
    presence: { start: presenceStart, end: presenceEnd },
    errors,
    pageErrors,
    consoleErrors: o.consoleErrors,
    loadWriteOk,
    layers,
    typingTarget: o.typingTarget,
    entered,
    focused,
    textBefore: before,
    textAfter: after,
    keys: typing.text.length,
    sentAtMs,
    keyToWorkDoneMs: summary(samples),
    keyToWorkDoneSamplesMs: samples,
    unresolved: state.keyLatencies.filter(open_).length,
    failed: state.keyLatencies.filter((entry) => entry.failed === true).length,
    noChange: state.noChangeKeys.length,
    longTasksAvailable: state.longTasksAvailable,
    longTasksOver50: state.longTasks.filter((task) => task.durationMs > 50),
    writes: state.writes,
    state,
  };
  record(o.slug, result);
  expectValidRun(state, {
    errors,
    expectedDpr: o.dpr,
    pageDpr: env.devicePixelRatio,
    start: presenceStart,
    end: presenceEnd,
  });
  expect(loadWriteOk, 'the load write succeeded').toBe(true);
  expect(entered.ok, `enterTextEdit: ${entered.code ?? ''}`).toBe(true);
  expect(focused, 'the edit textarea has focus').toBe('TEXTAREA');
  expect(before?.length, 'the target has 60 offset units').toBe(typing.offset);
  expect(after, 'the typed text, at the caret').toBe(`${before}${typing.text}`);
  if (layers !== null) expect(layers.rows, 'layer rows shown').toBe(layers.expectedRows);
  expect(result.failed).toBe(0);
  expect(result.unresolved).toBe(0);
  // Every key is printable and changes the text, so each produced a revision and a sample.
  expect(result.noChange, 'keys that produced no revision').toBe(0);
  expect(samples.length, 'one sample per key').toBe(typing.text.length);
}

for (const { scenario, variant } of runs) {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const title = `${scenario.id}${variant === 'plain' ? ' (plain)' : ''} r${repetition}`;
    test(title, async ({ page, browser }, testInfo) => {
      const m9 = scenario.m9;
      test.skip(
        v2Project(testInfo.project.name) !== (m9 !== undefined),
        'v1 scenarios run in the v1 projects, M9 scenarios in the -v2 projects',
      );
      if (!smoke)
        expect(dirty, 'a clean working tree, so the recorded commit is what ran').toBe(false);
      const dpr = testInfo.project.use.deviceScaleFactor ?? 1;
      const document = loaded(scenario.document);
      // The plain variant has no fill and no rejection (and no font-load change), so its
      // configuration (and hash) says so.
      const configured =
        variant === 'plain'
          ? {
              ...scenario,
              reject: null,
              setFillBeforeDownMs: null,
              ...(m9 === undefined ? {} : { m9: { ...m9, fontLoad: null } }),
            }
          : scenario;
      const m9Config =
        m9 === undefined ? null : m9Configuration(configured, dpr, repetitions, document);
      const configuration = m9Config ?? e26Configuration(configured, dpr, repetitions, document);
      const ui = m9?.ui === true;
      // The v2 projects' `ui=0` variant (V-20) has no 17a2b0a layout row to check against.
      const budget = m9 === undefined;
      /** M9-U1: the layer toggles before the warm-up, and the rows the tree then shows. */
      const expandTree = async () => {
        if (m9Config === null || !ui) return null;
        const rows = await expandLayers(page, m9Config.m9.expanded);
        return { expanded: m9Config.m9.expanded, rows, expectedRows: m9Config.m9.layerRows };
      };
      const camera = configuration.camera;
      const base = {
        scenario: scenario.id,
        variant,
        repetition,
        project: testInfo.project.name,
        browser: `${browser.browserType().name()} ${browser.version()}`,
        devicePixelRatio: dpr,
        commit,
        dirty,
        configurationHash: configurationHash(configuration),
        configuration,
        visibility: visibility(document.bounds, camera, dpr),
        // A traced run is a diagnostic, never evidence (M9-U3a): its record says so.
        ...(traceDirectory === undefined ? {} : { traced: true }),
        ...(memoryVariant ? { memoryVariant: true } : {}),
      };
      const slug = `${testInfo.project.name}--${scenario.id.replace(/[^a-z0-9-]+/gi, '_')}${
        variant === 'plain' ? '-plain' : ''
      }--r${repetition}${memoryVariant ? '--memory' : ''}`;
      test.skip(
        memoryVariant && variant !== 'frame',
        'the memory variant runs the frame runs only',
      );
      const { errors, consoleErrors } = await installProbe(page);
      if (memoryVariant) {
        await page.addInitScript(installMemoryLedger);
        await browser.startTracing(page, {
          screenshots: false,
          categories: [...MEMORY_TRACE_CATEGORIES],
        });
        tracing = { browser };
      }
      if (traceDirectory !== undefined) {
        mkdirSync(traceDirectory, { recursive: true });
        await browser.startTracing(page, {
          path: path.join(traceDirectory, `${slug}.json`),
          screenshots: false,
          categories: TRACE_CATEGORIES,
        });
        tracing = { browser };
      }

      if (variant === 'typing') {
        await typingRun(page, {
          scenario,
          base,
          slug,
          errors,
          consoleErrors,
          dpr,
          camera,
          expandTree,
          typingTarget: m9Config!.m9.typingTarget!,
        });
        return;
      }

      if (variant === 'frame') {
        await open(page, `doc=${scenario.document}`, errors, ui, budget);
        await execute(page, [{ type: 'setViewport', camera }]);
        const layers = await expandTree();
        const env = await environment(page);
        let driver: unknown;
        if (scenario.interaction === 'edit-drag') {
          const target = moveTarget(document);
          await execute(page, [
            { type: 'setSnapping', enabled: false },
            { type: 'setSelection', ids: target.selection.ids },
          ]);
          const start = await clientPoint(page, camera, target.press);
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          driver = { kind: 'edit-drag', startClient: start };
        } else {
          driver = { kind: 'pan-zoom', fitted: camera };
        }
        const start = await presence(page);
        const run = await page.evaluate(
          async ({ driver, warmUpMs, windowEndMs, mark }) => {
            const hook = window.__e26Bench!;
            const backend = hook.backend()!;
            const until = (time: number) =>
              new Promise<void>((resolve) =>
                setTimeout(resolve, Math.max(0, time - performance.now())),
              );
            backend.setMode('continuous');
            const t0 = performance.now();
            hook.setDriver({ ...(driver as object), t0 });
            await until(t0 + warmUpMs);
            const windowStartMs = performance.now();
            if (mark) performance.mark('e26-window-start');
            const steps = hook.driverSteps();
            const revisions = hook.latencies.length;
            const submitted = backend.getStatistics().framesSubmitted;
            backend.startFrameMeasurements(8192);
            await until(t0 + windowEndMs);
            const measurements = backend.stopFrameMeasurements();
            const windowEndAtMs = performance.now();
            if (mark) performance.mark('e26-window-end');
            hook.setDriver(null);
            backend.setMode('on-demand');
            return {
              t0,
              windowStartMs,
              windowEndMs: windowEndAtMs,
              driverSteps: hook.driverSteps() - steps,
              // Edit drag: moves in the window that produced a scene revision (the drag happened).
              revisedMoves: hook.latencies.length - revisions,
              framesSubmitted: backend.getStatistics().framesSubmitted - submitted,
              lifecycle: backend.getStatistics().lifecycle,
              recoveryAttempts: backend.getStatistics().recoveryAttempts,
              measurements,
              longTasksAvailable: hook.longTasksAvailable,
              longTasks: hook.longTasks.filter(
                (task) => task.startMs >= windowStartMs && task.startMs < windowEndAtMs,
              ),
            };
          },
          {
            driver,
            warmUpMs: E26_DRIVERS.warmUpMs,
            windowEndMs: E26_DRIVERS.windowEndMs,
            mark: traceDirectory !== undefined,
          },
        );
        if (scenario.interaction === 'edit-drag') await page.mouse.up();
        const end = await presence(page);
        const pageErrors = await page.evaluate(() => window.__e26Probe!.pageErrors);
        let memory: unknown;
        if (memoryVariant) {
          // The end of the window (contract section 1): one heap reading, the ledgers, the trace.
          const cdp = await page.context().newCDPSession(page);
          let heap: HeapUsage;
          try {
            heap = await cdp.send('Runtime.getHeapUsage');
          } finally {
            await cdp.detach();
          }
          const installed = await page.evaluate(
            () => (globalThis as { __vsMemory?: MemoryLedger }).__vsMemory !== undefined,
          );
          expect(installed, 'the memory ledger init script ran').toBe(true);
          const ledger = await page.evaluate(() =>
            (globalThis as { __vsMemory?: MemoryLedger }).__vsMemory!.snapshot(),
          );
          tracing = null;
          const raw = (await browser.stopTracing()).toString();
          // The raw trace stays beside the records (not a record: a subdirectory), so PA-U4c can
          // look for the M1 peak counter (memory-infra) and the Oilpan events (M7) in it.
          const traces = path.join(resultsDirectory, 'memory-traces');
          mkdirSync(traces, { recursive: true });
          writeFileSync(path.join(traces, `${slug}.json`), raw);
          const trace = summarizeMemoryTrace(JSON.parse(raw));
          if (trace.gcs === 0 || trace.unpaired > 0)
            testInfo.annotations.push({
              type: 'memory',
              description: `GC trace: ${trace.gcs} GCs, ${trace.unpaired} unpaired`,
            });
          memory = {
            ...memoryBlock(ledger, trace, heap),
            ledger,
            heapUsageAtEnd: heap,
            gc: { ...trace, samples: undefined },
            gcSamples: trace.samples,
          };
        }
        const intervals = run.measurements.frameIntervalsMs;
        record(slug, {
          ...base,
          environment: env,
          presence: { start, end },
          errors,
          pageErrors,
          consoleErrors,
          ...(layers === null ? {} : { layers }),
          rafCallbackIntervalMs: summary(intervals),
          encodeAndSubmitMs: summary(run.measurements.encodeAndSubmitMs),
          ceilingMs: scenario.frameCeilingMs,
          // Each interval should end in a submission: intervals + 1 against submissions.
          intervalsPlusOne: intervals.length + 1,
          run,
          ...(memory === undefined ? {} : { memory }),
        });
        expectValidRun(run, {
          errors,
          expectedDpr: dpr,
          pageDpr: env.devicePixelRatio,
          start,
          end,
        });
        expect(run.measurements.droppedSamples.frameIntervalsMs).toBe(0);
        if (layers !== null) expect(layers.rows, 'layer rows shown').toBe(layers.expectedRows);
        if (!smoke) {
          expect(intervals.length).toBeGreaterThan(0);
          if (scenario.interaction === 'edit-drag') expect(run.revisedMoves).toBeGreaterThan(0);
        }
        return;
      }

      // The latency scenario (busy or plain).
      const target = moveTarget(document);
      const busy = variant === 'busy';
      await open(
        page,
        `doc=${scenario.document}&persist=1${busy ? `&reject=${target.selection.ids[0]}` : ''}`,
        errors,
        ui,
        budget,
      );
      // The load's own autosave write has completed (section 3.1).
      await page.waitForFunction(
        () => {
          const write = window.__e26Bench!.writes[0];
          return write !== undefined && write.endMs !== null;
        },
        undefined,
        { timeout: 30_000 },
      );
      // Checked with the others after the record is written (section 3.5: kept).
      const loadWriteOk = await page.evaluate(() => window.__e26Bench!.writes[0]!.ok);
      await execute(page, [
        { type: 'setViewport', camera },
        { type: 'setSnapping', enabled: false },
        { type: 'setSelection', ids: target.selection.ids },
      ]);
      const layers = await expandTree();
      const fontLoad = busy ? (m9?.fontLoad ?? null) : null;
      const env = await environment(page);
      const start = await clientPoint(page, camera, target.press);
      // Input goes through CDP without awaiting each move, so moves queue behind a busy main
      // thread as a real mouse's do (an awaited move returns only after the page handled it).
      const cdp = await page.context().newCDPSession(page);
      const mouse = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number) =>
        cdp.send('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          buttons: type === 'mouseReleased' ? 0 : 1,
          clickCount: type === 'mouseMoved' ? 0 : 1,
        });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y });
      const presenceStart = await presence(page);
      if (busy) {
        await execute(page, [
          { type: 'setStyle', ids: [target.outside], style: { fill: { r: 1, g: 0, b: 0, a: 1 } } },
        ]);
        await page.waitForTimeout(scenario.setFillBeforeDownMs ?? 0);
      }
      await mouse('mousePressed', start.x, start.y);
      const started = Date.now();
      let armed = !busy;
      const sent: Promise<unknown>[] = [];
      const sentAtMs: number[] = [];
      let arming: Promise<void> | null = null;
      // M9-U1: the font-load change, not awaited, as the arming is not.
      let fontArmed = fontLoad === null;
      let fontLoading: Promise<string> | null = null;
      for (;;) {
        const elapsed = Date.now() - started;
        if (elapsed >= E26_DRIVERS.latencyDurationMs) break;
        if (!armed && elapsed >= (scenario.reject?.armedAtMs ?? 0)) {
          arming = page.evaluate(() => window.__e26Bench!.armReject());
          armed = true;
        }
        if (!fontArmed && elapsed >= fontLoad!.armedAtMs) {
          fontLoading = page.evaluate(
            (family) => window.__e26Bench!.registerTestFont(family),
            fontLoad!.family,
          );
          fontArmed = true;
        }
        const offset = editDragOffset(elapsed);
        sent.push(mouse('mouseMoved', start.x + offset.x, start.y + offset.y));
        sentAtMs.push(elapsed);
        const wait = sentAtMs.length * E26_DRIVERS.latencyCadenceMs - (Date.now() - started);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      const last = editDragOffset(Date.now() - started);
      await mouse('mouseReleased', start.x + last.x, start.y + last.y);
      await Promise.all(sent);
      await arming;
      const fontStatus = fontLoading === null ? null : await fontLoading;
      const moves = sent.length;
      const probe = await page.evaluate(() => window.__e26Probe!);
      // Latency samples are windowed by the events' own timestamps (the clock of `inputMs`): the
      // hover move to the start point falls before the press. Long tasks and writes are windowed
      // until the release was handled, because moves queued behind a busy main thread are still
      // handled, with the press on, after the release's timestamp (U1c review r2 S1).
      const downMs = probe.downs[0] ?? Number.NaN;
      const upMs = probe.ups[0] ?? Number.NaN;
      const upHandledMs = probe.upsHandled[0] ?? Number.NaN;
      // The due write after pointer up, the last samples' submitted work and the isolation
      // measure settle; then the run is read.
      await page.waitForTimeout(1_500);
      const state = await page.evaluate(
        ({ downMs, upMs, upHandledMs }) => {
          const hook = window.__e26Bench!;
          const history = hook.editor()!.query({ type: 'history' }) as { undoDepth: number };
          return {
            latencies: hook.latencies.filter(
              (entry) => entry.inputMs >= downMs && entry.inputMs <= upMs,
            ),
            noChangeMoves: hook.noChangeMoves.filter((time) => time >= downMs && time <= upMs),
            writes: hook.writes,
            longTasksAvailable: hook.longTasksAvailable,
            longTasks: hook.longTasks.filter(
              (task) => task.startMs >= downMs && task.startMs <= upHandledMs,
            ),
            isolations: hook.isolations(),
            rejections: hook.rejections(),
            fontLoads: hook.fontLoads,
            fontLoadMeasures: performance
              .getEntriesByName('m9-font-load', 'measure')
              .map((entry) => ({ startMs: entry.startTime, durationMs: entry.duration })),
            undoDepth: history.undoDepth,
            mode: hook.backend()!.getStatistics().mode,
            lifecycle: hook.backend()!.getStatistics().lifecycle,
            recoveryAttempts: hook.backend()!.getStatistics().recoveryAttempts,
          };
        },
        { downMs, upMs, upHandledMs },
      );
      const samples = state.latencies
        .filter((entry) => entry.doneMs !== null && Number.isFinite(entry.doneMs))
        .map((entry) => entry.doneMs! - entry.inputMs);
      const overlaps = (task: { startMs: number; durationMs: number }) =>
        state.isolations.some(
          (measure) =>
            task.startMs < measure.startMs + measure.durationMs &&
            measure.startMs < task.startMs + task.durationMs,
        );
      // M9-Q3: a long task overlapping the font-load change is flagged, never exempt.
      const overlapsFontLoad = (task: { startMs: number; durationMs: number }) =>
        state.fontLoadMeasures.some(
          (measure) =>
            task.startMs < measure.startMs + measure.durationMs &&
            measure.startMs < task.startMs + task.durationMs,
        );
      const longOver50 = state.longTasks.filter((task) => task.durationMs > 50);
      const writesDuringPress = state.writes.filter(
        (write) => write.startMs > downMs && write.startMs < upHandledMs,
      );
      const firstAfterUp = state.writes.find((write) => write.startMs >= upHandledMs) ?? null;
      const presenceEnd = await presence(page);
      const open_ = (entry: (typeof state.latencies)[number]) =>
        entry.failed !== true && (entry.doneMs === null || Number.isNaN(entry.doneMs));
      // M9-U1: each page error placed against the press and the font-load change (page clock).
      const fontStartMs = state.fontLoads[0]?.startMs ?? null;
      const pageErrors = probe.pageErrors.map((entry) => ({
        ...entry,
        sinceDownMs: entry.atMs - downMs,
        sinceFontLoadMs: fontStartMs === null ? null : entry.atMs - fontStartMs,
      }));
      const result = {
        ...base,
        environment: env,
        presence: { start: presenceStart, end: presenceEnd },
        errors,
        pageErrors,
        consoleErrors,
        downMs,
        upMs,
        upHandledMs,
        probe,
        loadWriteOk,
        moves,
        expectedMoves: E26_DRIVERS.latencyDurationMs / E26_DRIVERS.latencyCadenceMs,
        sentAtMs,
        lastOffset: last,
        pointerToWorkDoneMs: summary(samples),
        boundMs: scenario.latencyBoundMs,
        // Not ended and not failed after the settle, claimed by a submission or not.
        unresolved: state.latencies.filter(open_).length,
        failed: state.latencies.filter((entry) => entry.failed === true).length,
        noChange: state.noChangeMoves.length,
        longTasksAvailable: state.longTasksAvailable,
        longTasksOver50: longOver50.map((task) => ({
          ...task,
          isolation: overlaps(task),
          ...(m9 === undefined ? {} : { fontLoad: overlapsFontLoad(task) }),
        })),
        ...(m9 === undefined
          ? {}
          : { layers, fontLoad: { armed: fontLoad, status: fontStatus, loads: state.fontLoads } }),
        isolations: state.isolations,
        rejections: state.rejections,
        writesDuringPress,
        firstWriteAfterUpMs: firstAfterUp === null ? null : firstAfterUp.startMs - upHandledMs,
        // setStyle (busy only) and the move, each one undo step: the pointer up was applied.
        undoDepth: state.undoDepth,
        expectedUndoDepth: busy ? 2 : 1,
        state,
      };
      record(slug, result);
      expectValidRun(state, {
        errors,
        expectedDpr: dpr,
        pageDpr: env.devicePixelRatio,
        start: presenceStart,
        end: presenceEnd,
      });
      expect(loadWriteOk, 'the load write succeeded').toBe(true);
      // Canvas presses only (tests/e26/probe.ts): the layer toggles are the only other presses.
      expect(probe.downs.length, 'one press').toBe(1);
      expect(probe.ups.length, 'one release').toBe(1);
      expect(probe.otherDowns, 'presses outside the canvas: the layer toggles').toEqual(
        (layers?.expanded ?? []).map((id) => `layer-toggle-${id}`),
      );
      expect(state.mode).toBe('on-demand');
      expect(result.failed).toBe(0);
      expect(result.unresolved).toBe(0);
      expect(samples.length, 'moves that produced a revision').toBeGreaterThan(0);
      expect(result.undoDepth, 'the release was applied').toBe(result.expectedUndoDepth);
      if (busy) expect(result.rejections).toBe(1);
      if (layers !== null) expect(layers.rows, 'layer rows shown').toBe(layers.expectedRows);
      if (fontLoad !== null) {
        expect(state.fontLoads, 'one font-load change').toHaveLength(1);
        expect(fontStatus, 'the font-load change loaded').toBe('loaded');
        // A real change: the port's generation and the scene revision both advanced.
        const [load] = state.fontLoads;
        expect(load!.generationAfter!, 'the text port generation advanced').toBeGreaterThan(
          load!.generationBefore,
        );
        expect(load!.revisionAfter!, 'the scene revision advanced').toBeGreaterThan(
          load!.revisionBefore,
        );
      }
    });
  }
}

// E26-U6b (E26-A06): isolation of the M1-A13 page with one and with 16 persistent rejections.
const isolationRuns =
  filter.length === 0 || filter.some((entry) => E26_ISOLATION.id.startsWith(entry));
for (let repetition = 1; isolationRuns && repetition <= repetitions; repetition += 1) {
  test(`${E26_ISOLATION.id} r${repetition}`, async ({ page, browser }, testInfo) => {
    test.skip(v2Project(testInfo.project.name), 'a v1 scenario: v1 projects only');
    test.skip(memoryVariant, 'the memory variant runs the frame runs only');
    if (!smoke)
      expect(dirty, 'a clean working tree, so the recorded commit is what ran').toBe(false);
    const dpr = testInfo.project.use.deviceScaleFactor ?? 1;
    const document = loaded(E26_ISOLATION.document);
    const targets = isolationTargets(document);
    const configuration = {
      isolation: E26_ISOLATION,
      documentSha256: sha256(canonicalJson(document.generated)),
      schemaVersion: document.document.schemaVersion,
      sceneNodes: document.projection.nodes.size,
      targets,
      devicePixelRatio: dpr,
      repetitions,
    };
    const slug = `${testInfo.project.name}--${E26_ISOLATION.id.replace(/[^a-z0-9-]+/gi, '_')}--r${repetition}`;
    const { errors, consoleErrors } = await installProbe(page);
    await open(page, `doc=${E26_ISOLATION.document}&isolation=1`, errors);
    const env = await environment(page);
    const start = await presence(page);
    const run = await page.evaluate(
      async ({ doc, replaceRuns, one, sixteen }) => {
        const hook = window.__e26Bench!;
        const editor = hook.editor()!;
        const backend = hook.backend()!;
        const response = await fetch(`/e26-bench-doc.json?doc=${doc}`, { cache: 'no-store' });
        const value: unknown = await response.json();
        const runStartMs = performance.now();
        const settleErrors: string[] = [];
        // Each load is one command; the next starts after its frame's work is done.
        const settle = async () => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await backend.waitForSubmittedWork().catch((error: unknown) => {
            settleErrors.push(String(error));
          });
        };
        // The command's own time, and the scene rejections it reported.
        const load = () => {
          const rejected: string[] = [];
          const unsubscribe = editor.subscribe((event) => {
            if (event.type === 'diagnostic' && event.code === 'editor.scene-rejected') {
              rejected.push(...(event.nodeIds ?? []));
            }
          });
          const start = performance.now();
          const result = editor.execute({ type: 'loadDocument', document: value });
          const commandMs = performance.now() - start;
          unsubscribe();
          return {
            error: result.ok ? null : (result.code ?? 'failed'),
            commandMs,
            rejected: [...rejected].sort(),
          };
        };
        const loadErrors: string[] = [];
        const replaces: { durationMs: number; nodes: number; status: string; commandMs: number }[] =
          [];
        for (let i = 0; i < replaceRuns; i += 1) {
          const before = hook.replaces.length;
          const loaded = load();
          if (loaded.error !== null) loadErrors.push(loaded.error);
          if (loaded.rejected.length > 0) loadErrors.push(`rejected ${loaded.rejected.join(',')}`);
          const sent = hook.replaces.slice(before).filter((entry) => entry.nodes > 0);
          replaces.push(
            ...sent.map(({ durationMs, nodes, status }) => ({
              durationMs,
              nodes,
              status,
              commandMs: loaded.commandMs,
            })),
          );
          await settle();
        }
        const isolate = async (ids: readonly string[]) => {
          const rejections = hook.rejections();
          const measures = hook.isolations().length;
          hook.armReject(ids, 'persistent');
          const loaded = load();
          hook.disarmReject();
          // The measure is taken by a microtask queued at the first rejection.
          await Promise.resolve();
          const measure = hook.isolations().slice(measures);
          await settle();
          return {
            error: loaded.error,
            commandMs: loaded.commandMs,
            rejected: loaded.rejected,
            rejections: hook.rejections() - rejections,
            measures: measure,
            durationMs: measure.length === 1 ? measure[0]!.durationMs : null,
          };
        };
        // One discarded isolation first, so neither measured one runs on a cold path.
        const warmUp = await isolate([one]);
        const single = await isolate([one]);
        const scattered = await isolate(sixteen);
        const stats = backend.getStatistics();
        const runEndMs = performance.now();
        return {
          loadErrors,
          settleErrors,
          replaces,
          warmUp,
          single,
          scattered,
          longTasks: hook.longTasks.filter(
            (task) => task.startMs >= runStartMs && task.startMs <= runEndMs,
          ),
          lifecycle: stats.lifecycle,
          recoveryAttempts: stats.recoveryAttempts,
        };
      },
      {
        doc: E26_ISOLATION.document,
        replaceRuns: E26_ISOLATION.replaceRuns,
        one: targets.one,
        sixteen: targets.sixteen,
      },
    );
    const end = await presence(page);
    const sorted = run.replaces.map((entry) => entry.durationMs).sort((a, b) => a - b);
    // R is the median of exactly five times; anything else records no R (and fails below).
    const r = sorted.length === E26_ISOLATION.replaceRuns ? sorted[2]! : null;
    // The rest of a clean load's command (refresh, events, listeners), outside R; the isolation
    // measure runs from the rejection to the end of its command, so it holds this tail too.
    const tails = run.replaces
      .map((entry) => entry.commandMs - entry.durationMs)
      .sort((a, b) => a - b);
    const bounds = r === null ? null : isolationBoundsMs(r);
    record(slug, {
      scenario: E26_ISOLATION.id,
      repetition,
      project: testInfo.project.name,
      browser: `${browser.browserType().name()} ${browser.version()}`,
      devicePixelRatio: dpr,
      commit,
      dirty,
      configurationHash: sha256(canonicalJson(configuration)),
      configuration,
      environment: env,
      presence: { start, end },
      errors,
      consoleErrors,
      replaceSnapshotMs: { samples: sorted, median: r },
      cleanLoadTailMs: { samples: tails, median: tails[Math.floor(tails.length / 2)] ?? null },
      boundsMs: bounds,
      oneMs: run.single.durationMs,
      sixteenMs: run.scattered.durationMs,
      pass:
        bounds === null || run.single.durationMs === null || run.scattered.durationMs === null
          ? null
          : {
              one: run.single.durationMs <= bounds.one,
              sixteen: run.scattered.durationMs <= bounds.sixteen,
            },
      run,
    });
    expectValidRun(run, { errors, expectedDpr: dpr, pageDpr: env.devicePixelRatio, start, end });
    expect(run.loadErrors, 'the loads succeeded').toEqual([]);
    expect(run.replaces.length, 'one replaceSnapshot per load').toBe(E26_ISOLATION.replaceRuns);
    expect(run.replaces.every((entry) => entry.status === 'applied')).toBe(true);
    for (const [isolation, ids] of [
      [run.warmUp, [targets.one]],
      [run.single, [targets.one]],
      [run.scattered, targets.sixteen],
    ] as const) {
      expect(isolation.error, 'the load with rejections still succeeds').toBeNull();
      expect(isolation.measures, 'one isolation measure').toHaveLength(1);
      expect(isolation.rejections, 'every target refused').toBeGreaterThanOrEqual(ids.length);
      // Exactly the targets were left out: no resync fallback, no wider exclusion.
      expect(isolation.rejected, 'the rejected scene nodes').toEqual([...ids].sort());
    }
  });
}

// M9-U1 (M9-A03): the canvas size and origin are equal with and without `ui=1`, `ui=1` mounts the
// right column only under `?bench=1`, and without `?bench=1` no bench flag does anything.
const geometryRuns =
  filter.length === 0 || filter.some((entry) => 'm9-ui-geometry'.startsWith(entry));
if (geometryRuns) {
  test('m9-ui-geometry', async ({ page }, testInfo) => {
    test.skip(!v2Project(testInfo.project.name), 'the 1600 x 1000 projects only');
    test.skip(memoryVariant, 'the memory variant runs the frame runs only');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const read = async (query: string) => {
      await page.goto(`/${query}`);
      await expect(page.getByTestId('status')).toBeVisible({ timeout: 90_000 });
      await expect(page.locator('canvas')).toHaveCount(1);
      return canvasGeometry(page);
    };
    const aside = await read('?bench=1');
    const column = await read('?bench=1&ui=1');
    const plain = await read('');
    const flags = await read('?ui=1&doc=m9-v2&persist=0');
    const testing = await read('?test=1');
    const testingFlags = await read('?test=1&ui=1&doc=m9-v2');
    record(`${testInfo.project.name}--m9-ui-geometry`, {
      scenario: 'm9-ui-geometry',
      variant: 'geometry',
      repetition: 1,
      project: testInfo.project.name,
      commit,
      dirty,
      aside,
      column,
      plain,
      flags,
      testing,
      testingFlags,
      errors,
    });
    expect(errors).toEqual([]);
    expect(column.origin, 'canvas origin with and without ui=1').toEqual(aside.origin);
    expect(column.size, 'canvas size with and without ui=1').toEqual(aside.size);
    expect(aside.size).toEqual({ width: 1280, height: 720 });
    expect(aside.rightColumn, '?bench=1 keeps the aside').toBeNull();
    expect(aside.aside).not.toBeNull();
    expect(column.rightColumn, '?bench=1&ui=1 mounts the right column').not.toBeNull();
    expect(column.aside).toBeNull();
    for (const [name, value] of [
      ['?bench=1', aside],
      ['?bench=1&ui=1', column],
    ] as const) {
      expect(value.bench, `${name}: the bench hook`).toBe(true);
    }
    // Without ?bench=1, ui= and doc= change nothing.
    expect(flags.bench, 'no bench hook without ?bench=1').toBe(false);
    expect(flags.origin).toEqual(plain.origin);
    expect(flags.size).toEqual(plain.size);
    expect(flags.rightColumn).toEqual(plain.rightColumn);
    expect(flags.aside).toEqual(plain.aside);
    // Nor under ?test=1.
    expect(testingFlags.bench, 'no bench hook with ?test=1 alone').toBe(false);
    expect(testingFlags.origin).toEqual(testing.origin);
    expect(testingFlags.size).toEqual(testing.size);
    expect(testingFlags.rightColumn).toEqual(testing.rightColumn);
    expect(testingFlags.aside).toEqual(testing.aside);
  });
}

// M9-U1 (M9-A02): the page-1 text layouts of the v2 document through the page's port, compared
// with the committed table (or written with M9_RECORD_LAYOUTS=1). Run only on request.
if (filter.includes('m9-v2-layouts')) {
  test('m9-v2-layouts', async ({ page, browser }, testInfo) => {
    // One project records the one table; every v2 project (Chrome and Edge headed) checks it.
    const recording = process.env.M9_RECORD_LAYOUTS === '1';
    test.skip(
      recording
        ? testInfo.project.name !== (smoke ? 'chromium-smoke-dpr1-v2' : 'chrome-dpr1-v2')
        : !v2Project(testInfo.project.name),
      recording ? 'the table is recorded in one project only' : 'the -v2 projects only',
    );
    const parsed = parseDocument(JSON.stringify(generateM9V2Document()));
    if (!parsed.ok) throw new Error(`parse: ${parsed.code}`);
    const requests = m9LayoutRequests(parsed.document);
    const url = '/?bench=1&doc=m9-v2&ui=1&test=1';
    await page.goto(url);
    const status = page.getByTestId('status');
    await expect(status).toHaveAttribute('data-fixture', 'bench-loaded', { timeout: 90_000 });
    const answers = await page.evaluate(async (list: readonly TextLayoutRequest[]) => {
      const text = (
        window as unknown as {
          __p5Host: {
            text: {
              port: { generation: number; layout(request: unknown): TextLayoutResult };
              testFont: Promise<string> | null;
            };
          };
        }
      ).__p5Host.text;
      const font = text.testFont === null ? 'none' : await text.testFont;
      return {
        font,
        generation: text.port.generation,
        results: list.map((r) => text.port.layout(r)),
      };
    }, requests);
    expect(answers.font, 'the test font registered').toBe('loaded');
    const table: M9LayoutTable = {
      recordedWith: { url, browser: `${browser.browserType().name()} ${browser.version()}` },
      layouts: Object.fromEntries(
        requests.map((request, index) => [
          requestKey(request),
          compactLayout(answers.results[index]!),
        ]),
      ),
    };
    if (recording) {
      // Formatted as the repository's `format:check` wants it.
      const prettier = await import('prettier');
      const options = (await prettier.resolveConfig(M9_LAYOUT_TABLE)) ?? {};
      writeFileSync(
        M9_LAYOUT_TABLE,
        await prettier.format(JSON.stringify(table), { ...options, filepath: M9_LAYOUT_TABLE }),
      );
      return;
    }
    const committed = JSON.parse(readFileSync(M9_LAYOUT_TABLE, 'utf8')) as M9LayoutTable;
    // M9-U1 pre-run fix: exact layouts move between browser versions (Chrome 156 against the
    // Chromium 153 recording: 170 of 207 layouts, almost all by at most 0.001 px, one with other
    // line breaks), so the diff is reported, not failed. What the runs rely on is asserted: the
    // camera claims, at the cameras chosen from the committed table, over this browser's layouts.
    const diff = m9LayoutDiff(table, committed);
    const claims = m9CameraClaims(loadScenarioDocument('m9-v2', table), m9Cameras(loaded('m9-v2')));
    record(`${testInfo.project.name}--m9-v2-layouts`, {
      scenario: 'm9-v2-layouts',
      variant: 'layouts',
      repetition: 1,
      project: testInfo.project.name,
      browser: table.recordedWith.browser,
      committedBrowser: committed.recordedWith.browser,
      commit,
      dirty,
      liveTableSha256: m9LayoutTableSha256(table),
      committedTableSha256: m9LayoutTableSha256(committed),
      diff,
      claims,
      // The live table itself, so a difference can be studied without rerunning.
      table,
    });
    testInfo.annotations.push({
      type: 'm9-v2-layouts',
      description: `${diff.differing} of ${diff.layouts} layouts differ, max numeric delta ${diff.maxNumericDelta}, ${diff.lineBreaks.length} with other line breaks`,
    });
    expect(diff.missing, 'every request answered and recorded').toEqual([]);
    for (const entry of claims.typical.atDpr) {
      const at = `the typical view at DPR ${entry.dpr}: 900 to 1,100 drawn leaves`;
      expect(entry.visible, at).toBeGreaterThanOrEqual(E26_TYPICAL_VISIBLE.min);
      expect(entry.visible, at).toBeLessThanOrEqual(E26_TYPICAL_VISIBLE.max);
      expect(entry.visible, `${at}, not all`).toBeLessThan(entry.leaves);
    }
    expect(claims.fitted.insideAtF, 'every drawn leaf inside the viewport at F').toBe(
      claims.fitted.leaves,
    );
    expect(claims.fitted.panFirstMissMs, 'every drawn leaf inside along the pan path').toBeNull();
    expect(
      claims.moveSelection.typical.firstMissMs,
      'the move selection inside (typical)',
    ).toBeNull();
    expect(claims.moveSelection.fitted.firstMissMs, 'the move selection inside (F)').toBeNull();
    expect(claims.holds).toBe(true);
  });
}
