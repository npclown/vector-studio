import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  configurationHash,
  E26_DRIVERS,
  E26_SCENARIOS,
  e26Configuration,
  editDragOffset,
  loadScenarioDocument,
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
const commit = (() => {
  try {
    return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();

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
    getStatistics(): { framesSubmitted: number; lifecycle: string; recoveryAttempts: number };
  } | null;
  setDriver(driver: unknown): void;
  driverSteps(): number;
  armReject(): void;
  rejections(): number;
  latencies: readonly { inputMs: number; revision: number; doneMs: number | null; failed?: true }[];
  noChangeMoves: readonly number[];
  writes: readonly { startMs: number; endMs: number | null; ok: boolean | null }[];
  longTasks: readonly { startMs: number; durationMs: number }[];
  longTasksAvailable: boolean;
  isolations(): readonly { startMs: number; durationMs: number }[];
};
declare global {
  interface Window {
    __e26Bench?: PageHook;
  }
}

async function open(page: Page, query: string): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`/?bench=1&${query}`);
  const status = page.getByTestId('status');
  await expect(status).toHaveAttribute('data-fixture', 'bench-loaded', { timeout: 90_000 });
  await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 90_000 });
  expect(errors).toEqual([]);
  // The load's scene reached the renderer: two frames after a submission.
  await page.waitForFunction(
    () => (window.__e26Bench?.backend()?.getStatistics().framesSubmitted ?? 0) > 0,
  );
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

/**
 * A run on a lost or recovering device is not a measurement: it is kept (section 3.5: never
 * replaced silently) and fails the test, so the record shows why.
 */
function expectValidRun(run: { lifecycle: string; recoveryAttempts: number }): void {
  expect(run.recoveryAttempts, 'device recoveries during the run').toBe(0);
  expect(run.lifecycle).toBe('ready');
}

function record(name: string, value: unknown): void {
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(path.join(resultsDirectory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

for (const { scenario, variant } of runs) {
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const title = `${scenario.id}${variant === 'plain' ? ' (plain)' : ''} r${repetition}`;
    test(title, async ({ page, browser }, testInfo) => {
      const dpr = testInfo.project.use.deviceScaleFactor ?? 1;
      const document = loaded(scenario.document);
      const configuration = e26Configuration(scenario, dpr, repetitions, document);
      const camera = configuration.camera;
      const base = {
        scenario: scenario.id,
        variant,
        repetition,
        project: testInfo.project.name,
        browser: `${browser.browserType().name()} ${browser.version()}`,
        devicePixelRatio: dpr,
        commit,
        configurationHash: configurationHash(configuration),
        configuration,
        visibility: visibility(document.bounds, camera, dpr),
      };
      const slug = `${testInfo.project.name}--${scenario.id.replace(/[^a-z0-9-]+/gi, '_')}${
        variant === 'plain' ? '-plain' : ''
      }--r${repetition}`;

      if (variant === 'frame') {
        await open(page, `doc=${scenario.document}`);
        await execute(page, [{ type: 'setViewport', camera }]);
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
        const intervals = run.measurements.frameIntervalsMs;
        const rafCallbackIntervalMs = summary(intervals);
        record(slug, {
          ...base,
          rafCallbackIntervalMs,
          encodeAndSubmitMs: summary(run.measurements.encodeAndSubmitMs),
          ceilingMs: scenario.frameCeilingMs,
          run,
        });
        expectValidRun(run);
        expect(run.measurements.droppedSamples.frameIntervalsMs).toBe(0);
        if (!smoke) expect(intervals.length).toBeGreaterThan(0);
        return;
      }

      // The latency scenario (busy or plain).
      const target = moveTarget(document);
      const busy = variant === 'busy';
      await open(
        page,
        `doc=${scenario.document}&persist=1${busy ? `&reject=${target.selection.ids[0]}` : ''}`,
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
      await execute(page, [
        { type: 'setViewport', camera },
        { type: 'setSnapping', enabled: false },
        { type: 'setSelection', ids: target.selection.ids },
      ]);
      const start = await clientPoint(page, camera, target.press);
      await page.mouse.move(start.x, start.y);
      const now = () => page.evaluate(() => performance.now());
      if (busy) {
        await execute(page, [
          { type: 'setStyle', ids: [target.outside], style: { fill: { r: 1, g: 0, b: 0, a: 1 } } },
        ]);
        await page.waitForTimeout(scenario.setFillBeforeDownMs ?? 0);
      }
      // Taken just before the press, so its handling and every later move fall after it and the
      // hover move to the start point falls before it (#403 review N5).
      const downMs = await now();
      await page.mouse.down();
      const started = Date.now();
      let armed = !busy;
      let moves = 0;
      for (;;) {
        const elapsed = Date.now() - started;
        if (elapsed >= E26_DRIVERS.latencyDurationMs) break;
        if (!armed && elapsed >= (scenario.reject?.armedAtMs ?? 0)) {
          await page.evaluate(() => window.__e26Bench!.armReject());
          armed = true;
        }
        const offset = editDragOffset(elapsed);
        await page.mouse.move(start.x + offset.x, start.y + offset.y);
        moves += 1;
        const next = (moves + 1) * E26_DRIVERS.latencyCadenceMs;
        const wait = next - (Date.now() - started);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      }
      const last = editDragOffset(Date.now() - started);
      await page.mouse.up();
      const upMs = await now();
      // The due write after pointer up, the last samples' submitted work and the isolation
      // measure settle; then the run is read.
      await page.waitForTimeout(1_500);
      const state = await page.evaluate(
        ({ downMs, upMs }) => {
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
              (task) => task.startMs >= downMs && task.startMs <= upMs,
            ),
            isolations: hook.isolations(),
            rejections: hook.rejections(),
            undoDepth: history.undoDepth,
            lifecycle: hook.backend()!.getStatistics().lifecycle,
            recoveryAttempts: hook.backend()!.getStatistics().recoveryAttempts,
          };
        },
        { downMs, upMs },
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
        (write) => write.startMs > downMs && write.startMs < upMs,
      );
      const firstAfterUp = state.writes.find((write) => write.startMs >= upMs) ?? null;
      const result = {
        ...base,
        downMs,
        upMs,
        moves,
        lastOffset: last,
        pointerToWorkDoneMs: summary(samples),
        boundMs: scenario.latencyBoundMs,
        unresolved: state.latencies.filter((entry) => entry.doneMs === null).length,
        failed: state.latencies.filter((entry) => entry.failed === true).length,
        noChange: state.noChangeMoves.length,
        longTasksAvailable: state.longTasksAvailable,
        longTasksOver50: longOver50.map((task) => ({ ...task, isolation: overlaps(task) })),
        isolations: state.isolations,
        rejections: state.rejections,
        writesDuringPress,
        firstWriteAfterUpMs: firstAfterUp === null ? null : firstAfterUp.startMs - upMs,
        // setStyle (busy only) and the move, each one undo step: the pointer up was applied.
        undoDepth: state.undoDepth,
        expectedUndoDepth: busy ? 2 : 1,
        state,
      };
      record(slug, result);
      expectValidRun(state);
      expect(moves).toBeGreaterThan(0);
      expect(result.failed).toBe(0);
    });
  }
}
