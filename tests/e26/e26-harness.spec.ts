import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  canonicalJson,
  configurationHash,
  E26_DRIVERS,
  E26_ISOLATION,
  E26_SCENARIOS,
  e26Configuration,
  editDragOffset,
  isolationBoundsMs,
  isolationTargets,
  loadScenarioDocument,
  sha256,
  visibility,
  type E26Camera,
  type E26Loaded,
  type E26Scenario,
} from './scenarios';
import { m1A13MoveSelection } from '../m1-a13/document';

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
// GPU adapter, visibility and focus) and the page errors. A run is invalid, kept and failed, when
// the device was lost or recovered, the page was hidden or lost focus, its DPR differs from the
// project's, a page error was thrown, or the interaction did not happen (section 3.5). Non-smoke
// runs refuse modified tracked files, so the recorded commit is what ran (untracked files
// are not checked: the reference PC keeps standing untracked entries). Do not touch the mouse
// during a run: the real pointer is captured on the canvas.
//
// The harness checks that each run completed and recorded its metrics; it does not assert the
// targets, because a baseline records misses. U6b's exit record reads the targets from the run
// records (maximum per-run p95, no rounding allowance).

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDirectory = process.env.E26_RESULTS_DIR ?? path.join(root, 'test-results/e26-runs');
const smoke = process.env.E26_CHROMIUM !== undefined;
const repetitions = Number(process.env.E26_REPETITIONS ?? (smoke ? 1 : 5));
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

type Variant = 'frame' | 'busy' | 'plain';
const runs: { scenario: E26Scenario; variant: Variant }[] = E26_SCENARIOS.filter(
  (scenario) => filter.length === 0 || filter.some((entry) => scenario.id.startsWith(entry)),
).flatMap((scenario): { scenario: E26Scenario; variant: Variant }[] =>
  scenario.interaction === 'latency-drag'
    ? [
        { scenario, variant: 'busy' },
        { scenario, variant: 'plain' },
      ]
    : [{ scenario, variant: 'frame' }],
);

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
};
/** Installed before the page loads (`installProbe`): press and release times, focus, visibility. */
type Probe = {
  /** Event timestamps (when the browser received the input) and handling times. */
  downs: number[];
  ups: number[];
  downsHandled: number[];
  upsHandled: number[];
  visibilityChanges: number;
  blurs: number;
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
  await page.addInitScript(() => {
    const probe: Probe = {
      downs: [],
      ups: [],
      downsHandled: [],
      upsHandled: [],
      visibilityChanges: 0,
      blurs: 0,
    };
    window.__e26Probe = probe;
    // Capture listeners on the window run before the canvas handles the event, so these are
    // the events' own timestamps, not a later evaluate (U1c review S1).
    window.addEventListener(
      'pointerdown',
      (event) => {
        probe.downs.push(event.timeStamp);
        probe.downsHandled.push(performance.now());
      },
      {
        capture: true,
      },
    );
    window.addEventListener(
      'pointerup',
      (event) => {
        probe.ups.push(event.timeStamp);
        probe.upsHandled.push(performance.now());
      },
      {
        capture: true,
      },
    );
    window.addEventListener('blur', () => (probe.blurs += 1));
    document.addEventListener('visibilitychange', () => (probe.visibilityChanges += 1));
  });
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

async function open(page: Page, query: string, errors: readonly string[]): Promise<void> {
  await page.goto(`/?bench=1&${query}`);
  const status = page.getByTestId('status');
  await expect(status).toHaveAttribute('data-fixture', 'bench-loaded', { timeout: 90_000 });
  await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 90_000 });
  expect(errors).toEqual([]);
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

for (const { scenario, variant } of runs) {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const title = `${scenario.id}${variant === 'plain' ? ' (plain)' : ''} r${repetition}`;
    test(title, async ({ page, browser }, testInfo) => {
      if (!smoke)
        expect(dirty, 'a clean working tree, so the recorded commit is what ran').toBe(false);
      const dpr = testInfo.project.use.deviceScaleFactor ?? 1;
      const document = loaded(scenario.document);
      // The plain variant has no fill and no rejection, so its configuration (and hash) says so.
      const configured =
        variant === 'plain' ? { ...scenario, reject: null, setFillBeforeDownMs: null } : scenario;
      const configuration = e26Configuration(configured, dpr, repetitions, document);
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
      };
      const slug = `${testInfo.project.name}--${scenario.id.replace(/[^a-z0-9-]+/gi, '_')}${
        variant === 'plain' ? '-plain' : ''
      }--r${repetition}`;
      const { errors, consoleErrors } = await installProbe(page);

      if (variant === 'frame') {
        await open(page, `doc=${scenario.document}`, errors);
        await execute(page, [{ type: 'setViewport', camera }]);
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
          async ({ driver, warmUpMs, windowEndMs }) => {
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
            const steps = hook.driverSteps();
            const revisions = hook.latencies.length;
            const submitted = backend.getStatistics().framesSubmitted;
            backend.startFrameMeasurements(8192);
            await until(t0 + windowEndMs);
            const measurements = backend.stopFrameMeasurements();
            const windowEndAtMs = performance.now();
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
          { driver, warmUpMs: E26_DRIVERS.warmUpMs, windowEndMs: E26_DRIVERS.windowEndMs },
        );
        if (scenario.interaction === 'edit-drag') await page.mouse.up();
        const end = await presence(page);
        const intervals = run.measurements.frameIntervalsMs;
        record(slug, {
          ...base,
          environment: env,
          presence: { start, end },
          errors,
          consoleErrors,
          rafCallbackIntervalMs: summary(intervals),
          encodeAndSubmitMs: summary(run.measurements.encodeAndSubmitMs),
          ceilingMs: scenario.frameCeilingMs,
          // Each interval should end in a submission: intervals + 1 against submissions.
          intervalsPlusOne: intervals.length + 1,
          run,
        });
        expectValidRun(run, {
          errors,
          expectedDpr: dpr,
          pageDpr: env.devicePixelRatio,
          start,
          end,
        });
        expect(run.measurements.droppedSamples.frameIntervalsMs).toBe(0);
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
      for (;;) {
        const elapsed = Date.now() - started;
        if (elapsed >= E26_DRIVERS.latencyDurationMs) break;
        if (!armed && elapsed >= (scenario.reject?.armedAtMs ?? 0)) {
          arming = page.evaluate(() => window.__e26Bench!.armReject());
          armed = true;
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
      const longOver50 = state.longTasks.filter((task) => task.durationMs > 50);
      const writesDuringPress = state.writes.filter(
        (write) => write.startMs > downMs && write.startMs < upHandledMs,
      );
      const firstAfterUp = state.writes.find((write) => write.startMs >= upHandledMs) ?? null;
      const presenceEnd = await presence(page);
      const open_ = (entry: (typeof state.latencies)[number]) =>
        entry.failed !== true && (entry.doneMs === null || Number.isNaN(entry.doneMs));
      const result = {
        ...base,
        environment: env,
        presence: { start: presenceStart, end: presenceEnd },
        errors,
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
        longTasksOver50: longOver50.map((task) => ({ ...task, isolation: overlaps(task) })),
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
      expect(probe.downs.length, 'one press').toBe(1);
      expect(probe.ups.length, 'one release').toBe(1);
      expect(state.mode).toBe('on-demand');
      expect(result.failed).toBe(0);
      expect(result.unresolved).toBe(0);
      expect(samples.length, 'moves that produced a revision').toBeGreaterThan(0);
      expect(result.undoDepth, 'the release was applied').toBe(result.expectedUndoDepth);
      if (busy) expect(result.rejections).toBe(1);
    });
  }
}

// E26-U6b (E26-A06): isolation of the M1-A13 page with one and with 16 persistent rejections.
const isolationRuns =
  filter.length === 0 || filter.some((entry) => E26_ISOLATION.id.startsWith(entry));
for (let repetition = 1; isolationRuns && repetition <= repetitions; repetition += 1) {
  test(`${E26_ISOLATION.id} r${repetition}`, async ({ page, browser }, testInfo) => {
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
