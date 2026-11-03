import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { m1A13MoveSelection } from '../m1-a13/document';
import { expandLayerRows } from '../support/layer-list.js';
import { M9_SECOND_FAMILY } from '../m9/document';
import {
  E26_DRIVERS,
  M9_FONT_LOAD,
  M9_SCENARIOS,
  editDragOffset,
  loadScenarioDocument,
  m9Configuration,
} from '../e26/scenarios';

// V21-U1 (V-21 contract, section 4): what one font load costs the editor, before any V-21 lever.
// The spec loads the v2 document through the bench page (`?bench=1&ui=1&doc=m9-v2`) with the
// busy scenario's camera and layer toggles, then registers the test font under the second
// family through `__e26Bench.registerTestFont`, as the M9 harness does. The bench's text probe
// (`textDispatches()`) gives, in order, each text-dom increment and dispatch (since V21-U2a a
// dispatch carries several increments) and the editor's split of the dispatch it handled.
//
//   - `idle`: the font load alone.
//   - `busy`: the pointer-busy path's edit drag as `input` pointer events from the page (moves
//     every 8 ms for 4 s, the latency drag's cadence and path), the font load 2.0 s after pointer
//     down, as `e26-pointer-busy-10k/v2` arms it. Each dispatch is matched with the move it
//     held: the next move to start, with the gap since the move before was handled.
//
// Counts and main-thread times only: headless, on SwiftShader WebGPU (the editor projects only
// with a live renderer), no timing claim for the gate. Records go to `test-results/v21-count/`.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDirectory = path.resolve(
  root,
  process.env.V21_RESULTS_DIR ?? 'test-results/v21-count',
);

const NO_MODIFIERS = { shift: false, alt: false, meta: false, ctrl: false };

function git(command: string, fallback: string): string {
  try {
    return execSync(command, { cwd: root }).toString().trim();
  } catch {
    return fallback;
  }
}

type Record = Readonly<{ [key: string]: unknown; kind: string; atMs: number }>;
type Move = Readonly<{ scheduledMs: number; startMs: number; handledMs: number }>;

async function open(page: Page) {
  const scenario = M9_SCENARIOS.find((entry) => entry.id === 'e26-pointer-busy-10k/v2')!;
  const loaded = loadScenarioDocument(scenario.document);
  const configuration = m9Configuration(scenario, 1, 1, loaded);
  await page.goto(`/?bench=1&ui=1&doc=${scenario.document}`);
  const status = page.getByTestId('status');
  await expect(status).toHaveAttribute('data-fixture', 'bench-loaded', { timeout: 120_000 });
  // The editor projects, and so lays text out again on a bump, only once the renderer is ready.
  await expect(status).not.toHaveAttribute('data-renderer', 'pending', { timeout: 120_000 });
  const renderer = await status.getAttribute('data-renderer');
  await page.evaluate(
    (commands) => {
      const editor = window.__e26Bench!.editor()!;
      for (const command of commands) {
        const result = editor.execute(command);
        if (!result.ok) throw new Error(`setup command: ${result.code ?? 'failed'}`);
      }
    },
    [
      { type: 'setViewport', camera: configuration.camera },
      { type: 'setSnapping', enabled: false },
    ] as unknown[],
  );
  await expandLayerRows(page, configuration.m9.expanded);
  return { scenario, loaded, configuration, renderer };
}

/** The probe's records and the bench's font loads, read after the load settled. */
function readBench(page: Page) {
  return page.evaluate(() => {
    const hook = window.__e26Bench!;
    return {
      records: hook.textDispatches() as Record[],
      fontLoads: JSON.parse(JSON.stringify(hook.fontLoads)) as Record[],
    };
  });
}

/**
 * Per dispatch: text-dom's dispatch record and the editor's record inside it (the editor reports
 * first). Since V21-U2 a dispatch carries the increments made before it (`sources`); before it,
 * each `port-bump` was its own dispatch.
 */
function pairs(records: readonly Record[]) {
  const out: { bump: Record; editor: Record | null }[] = [];
  let pending: Record | null = null;
  for (const record of records) {
    if (record.kind === 'editor-dispatch') pending = record;
    else if (
      record.kind === 'port-dispatch' ||
      (record.kind === 'port-bump' && record.dispatchMs !== undefined)
    ) {
      out.push({ bump: record, editor: pending });
      pending = null;
    }
  }
  return out;
}

function summary(records: readonly Record[]) {
  return pairs(records).map(({ bump, editor }) => ({
    source: bump.kind === 'port-dispatch' ? (bump.sources as string[]).join('+') : bump.source,
    generation: bump.generation,
    atMs: bump.atMs,
    dispatchMs: bump.dispatchMs,
    handled: editor?.handled ?? null,
    deferred: editor?.deferred ?? null,
    path: editor?.path ?? null,
    relayoutMs: editor?.relayoutMs ?? null,
    layoutCalls: editor?.layoutCalls ?? null,
    layoutMs: editor?.layoutMs ?? null,
    equalLayouts: editor?.equalLayouts ?? null,
    comparedLayouts: editor?.comparedLayouts ?? null,
    projectMs: editor?.projectMs ?? null,
    diffMs: editor?.diffMs ?? null,
    applyMs: editor?.applyMs ?? null,
    emitMs: editor?.emitMs ?? null,
    textUnits: editor?.textUnits ?? null,
    nodes:
      editor === null
        ? null
        : { inserted: editor.inserted, updated: editor.updated, removed: editor.removed },
  }));
}

function write(name: string, body: object): void {
  mkdirSync(resultsDirectory, { recursive: true });
  writeFileSync(path.join(resultsDirectory, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

function header(page: Page, renderer: string | null) {
  return {
    unit: 'V21-U1',
    commit: git('git rev-parse HEAD', 'unknown'),
    dirty: git('git status --porcelain', 'unknown') !== '',
    browser: `${page.context().browser()?.browserType().name()} ${page
      .context()
      .browser()
      ?.version()}`,
    renderer,
    family: M9_SECOND_FAMILY,
  };
}

test('V21-U1 counts the font load alone', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { renderer } = await open(page);
  const status = await page.evaluate(
    (family) => window.__e26Bench!.registerTestFont(family),
    M9_SECOND_FAMILY,
  );
  // Anything after the measure's end (a late `loadingdone`) lands within a second.
  await page.waitForTimeout(1_000);
  const { records, fontLoads } = await readBench(page);
  write('idle', {
    ...header(page, renderer),
    run: 'idle',
    status,
    fontLoads,
    dispatches: summary(records),
    pageErrors: errors,
    raw: records,
  });
  expect(renderer, 'the editor projects only with a live renderer').toBe('ready');
  expect(status).toBe('loaded');
  expect(fontLoads).toHaveLength(1);
  expect(records.some((record) => (record.layoutCalls as number) > 0)).toBe(true);
});

test('V21-U1 counts the font load during the edit drag', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { loaded, configuration, renderer } = await open(page);
  const target = m1A13MoveSelection(loaded.generated as Parameters<typeof m1A13MoveSelection>[0]);
  const box = loaded.bounds.get(target.ids[0]);
  if (box === null || box === undefined) throw new Error('the pressed leaf has no bounds');
  const press = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
  const zoom = configuration.camera.zoom;
  // The drag's offsets in canvas pixels, turned into document points as V20-U1 does.
  const cadenceMs = E26_DRIVERS.latencyCadenceMs;
  const durationMs = E26_DRIVERS.latencyDurationMs;
  const points: { x: number; y: number }[] = [];
  for (let k = 1; k * cadenceMs < durationMs; k += 1) {
    const offset = editDragOffset(k * cadenceMs);
    points.push({ x: press.x + offset.x / zoom, y: press.y + offset.y / zoom });
  }
  const run = await page.evaluate(
    async ({ ids, press, points, cadenceMs, fontAtMs, family, modifiers }) => {
      const hook = window.__e26Bench!;
      const editor = hook.editor()!;
      const run = (command: unknown) => {
        const result = editor.execute(command);
        if (!result.ok) throw new Error(`drag command: ${result.code ?? 'failed'}`);
      };
      run({ type: 'setSelection', ids });
      const before = JSON.stringify(editor.query({ type: 'node', id: ids[0] }));
      run({ type: 'input', event: { kind: 'pointerdown', point: press, button: 0, modifiers } });
      const downMs = performance.now();
      const moves: { scheduledMs: number; startMs: number; handledMs: number }[] = [];
      let font: Promise<string> | null = null;
      for (const [index, point] of points.entries()) {
        const scheduledMs = downMs + (index + 1) * cadenceMs;
        const wait = scheduledMs - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        if (font === null && performance.now() - downMs >= fontAtMs) {
          // Not awaited, as the harness does not await it.
          font = hook.registerTestFont(family);
        }
        const startMs = performance.now();
        run({ type: 'input', event: { kind: 'pointermove', point, modifiers } });
        moves.push({ scheduledMs, startMs, handledMs: performance.now() });
      }
      run({
        type: 'input',
        event: { kind: 'pointerup', point: points[points.length - 1], modifiers },
      });
      const status = font === null ? null : await font;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const after = JSON.stringify(editor.query({ type: 'node', id: ids[0] }));
      return { downMs, moves, status, moved: before !== after };
    },
    {
      ids: target.ids,
      press,
      points,
      cadenceMs,
      fontAtMs: M9_FONT_LOAD.armedAtMs,
      family: M9_SECOND_FAMILY,
      modifiers: NO_MODIFIERS,
    },
  );
  const { records, fontLoads } = await readBench(page);
  const dispatches = summary(records);
  // A dispatch holds the move that starts next: it ran in the gap after the previous move was
  // handled. Per dispatch: that move, the gap and how late the move started.
  const held = dispatches.map((entry) => {
    const index = run.moves.findIndex((move: Move) => move.startMs > entry.atMs);
    const move = index < 0 ? null : run.moves[index]!;
    const previous = index <= 0 ? null : run.moves[index - 1]!;
    const inside = previous !== null && previous.handledMs <= entry.atMs;
    return {
      source: entry.source,
      generation: entry.generation,
      move: inside ? index : null,
      gapMs: inside ? move!.startMs - previous.handledMs : null,
      delayMs: inside ? move!.startMs - move!.scheduledMs : null,
    };
  });
  const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
  const quantile = (values: number[], q: number) =>
    sorted(values)[Math.min(values.length - 1, Math.floor(q * values.length))] ?? null;
  const handles = run.moves.map((move: Move) => move.handledMs - move.startMs);
  const delays = run.moves.map((move: Move) => move.startMs - move.scheduledMs);
  write('busy', {
    ...header(page, renderer),
    run: 'busy',
    status: run.status,
    moved: run.moved,
    moves: run.moves.length,
    moveHandleMs: {
      p50: quantile(handles, 0.5),
      p95: quantile(handles, 0.95),
      max: Math.max(...handles),
    },
    moveDelayMs: {
      p50: quantile(delays, 0.5),
      p95: quantile(delays, 0.95),
      max: Math.max(...delays),
    },
    heldMoves: held,
    fontLoads,
    dispatches,
    pageErrors: errors,
    raw: records,
  });
  expect(renderer, 'the editor projects only with a live renderer').toBe('ready');
  expect(run.status).toBe('loaded');
  expect(run.moved, 'the drag moved the pressed node').toBe(true);
  expect(fontLoads).toHaveLength(1);
});
