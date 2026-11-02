import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { layerRows } from '../../packages/ui/src/layer-model.js';
import { m1A13MoveSelection } from '../m1-a13/document';
import { expandLayerRows, layerRowCount } from '../support/layer-list.js';
import {
  M9_SCENARIOS,
  editDragOffset,
  loadScenarioDocument,
  m9Configuration,
  panZoomCamera,
  type E26Camera,
  type M9ScenarioId,
} from '../e26/scenarios';

// V20-U1 (V-20 contract, section 5): how often the right column renders per step, before any
// V-20 lever. For each v2 scenario the spec loads the document through the bench page
// (`?bench=1&ui=1&doc=`), sets the scenario's camera and layer toggles as the E26/M9 harness
// does, then steps the interaction itself from the page: the camera with `setViewport` along
// the pan formula, or the edit drag as `input` pointer events through `__e26Bench.editor()`.
// After each step it waits two animation frames, so React has committed, and reads the bench's
// render counters and the mounted rows. It never waits for the renderer. Counts only.
//
// V20-U2 adds the assertions of V20-A01 and A02 to those runs, and the browser half of V20-A03
// and A04 on the stress document: the windowed list against `layerRows`, the stable row
// handlers, the rename and focus pins, and Tab through the rows.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultsDirectory = path.resolve(
  root,
  process.env.V20_RESULTS_DIR ?? 'test-results/v20-count',
);
/** Steps per run: 16.7 ms apart on the scenario clock (the harness's driver time). */
const STEPS = 30;
const STEP_MS = 1000 / 60;

const COUNTED: readonly { id: M9ScenarioId; steps: 'camera' | 'drag' }[] = [
  { id: 'e26-simple-stress-10k/v2', steps: 'camera' },
  { id: 'e26-mixed-all-pan-10k/v2', steps: 'camera' },
  { id: 'e26-mixed-view-edit-10k/v2', steps: 'drag' },
];

type Step = Readonly<{ renders: Record<string, number>; mountedRows: number }>;

function commit(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function dirty(): boolean {
  try {
    return execSync('git status --porcelain', { cwd: root }).toString().trim() !== '';
  } catch {
    return true;
  }
}

/** Renders per id between two counter snapshots. */
function delta(after: Record<string, number>, before: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const id of new Set([...Object.keys(after), ...Object.keys(before)])) {
    out[id] = (after[id] ?? 0) - (before[id] ?? 0);
  }
  return out;
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

/** One step in the page, then two frames, then the counters and the mounted rows. */
async function step(page: Page, commands: readonly unknown[]): Promise<Step> {
  return page.evaluate(async (list) => {
    const hook = window.__e26Bench!;
    const editor = hook.editor()!;
    for (const command of list) {
      const result = editor.execute(command);
      if (!result.ok) throw new Error(`step command: ${result.code ?? 'failed'}`);
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      renders: { ...hook.renders() },
      mountedRows: document.querySelectorAll('[data-testid="layers"] li').length,
    };
  }, commands as unknown[]);
}

const NO_MODIFIERS = { shift: false, alt: false, meta: false, ctrl: false };

for (const counted of COUNTED) {
  test(`V20-U1 counts ${counted.id}`, async ({ page }) => {
    const scenario = M9_SCENARIOS.find((entry) => entry.id === counted.id);
    if (scenario === undefined) throw new Error(`unknown scenario ${counted.id}`);
    const loaded = loadScenarioDocument(scenario.document);
    const configuration = m9Configuration(scenario, 1, 1, loaded);
    const camera: E26Camera = configuration.camera;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`/?bench=1&ui=1&doc=${scenario.document}`);
    const status = page.getByTestId('status');
    await expect(status).toHaveAttribute('data-fixture', 'bench-loaded', { timeout: 120_000 });
    const renderer = await status.getAttribute('data-renderer');
    // Snapping off for every scenario (the harness turns it off for the drag only); it runs before
    // the first counted step, so it changes no count.
    await execute(page, [
      { type: 'setViewport', camera },
      { type: 'setSnapping', enabled: false },
    ]);
    // The scenario's layer toggles, as the harness clicks them (M9 contract, section 4).
    await expandLayerRows(page, configuration.m9.expanded);
    const ready = await step(page, []);
    const rowCount = await layerRowCount(page);
    // Rows that intersect the list's viewport at most: its height over the row height, plus one
    // for a partly scrolled row.
    const rowsInView = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('[data-testid="layer-list-viewport"]');
      const row = document.querySelector<HTMLElement>('[data-testid="layers"] li');
      if (viewport === null || row === null) return null;
      return Math.ceil(viewport.clientHeight / row.getBoundingClientRect().height) + 1;
    });

    const steps: (Step & { delta: Record<string, number> })[] = [];
    /** The pressed node before and after the drag, so a missed press cannot pass as no renders. */
    const dragged: { before: string | null; after: string | null } = { before: null, after: null };
    let previous = ready.renders;
    const record = (result: Step) => {
      steps.push({ ...result, delta: delta(result.renders, previous) });
      previous = result.renders;
    };

    if (counted.steps === 'camera') {
      for (let k = 0; k < STEPS; k += 1) {
        const at = panZoomCamera(camera, k * STEP_MS);
        record(await step(page, [{ type: 'setViewport', camera: at }]));
      }
    } else {
      const target = m1A13MoveSelection(
        loaded.generated as Parameters<typeof m1A13MoveSelection>[0],
      );
      const box = loaded.bounds.get(target.ids[0]);
      if (box === null || box === undefined) throw new Error('the pressed leaf has no bounds');
      const press = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      const at = (tMs: number) => {
        const offset = editDragOffset(tMs);
        return { x: press.x + offset.x / camera.zoom, y: press.y + offset.y / camera.zoom };
      };
      await execute(page, [{ type: 'setSelection', ids: target.ids }]);
      const pressed = target.ids[0];
      const nodeJson = () =>
        page.evaluate(
          (id) => JSON.stringify(window.__e26Bench!.editor()!.query({ type: 'node', id })),
          pressed,
        );
      dragged.before = await nodeJson();
      record(
        await step(page, [
          {
            type: 'input',
            event: { kind: 'pointerdown', point: press, button: 0, modifiers: NO_MODIFIERS },
          },
        ]),
      );
      for (let k = 1; k <= STEPS; k += 1) {
        record(
          await step(page, [
            {
              type: 'input',
              event: { kind: 'pointermove', point: at(k * STEP_MS), modifiers: NO_MODIFIERS },
            },
          ]),
        );
      }
      record(
        await step(page, [
          {
            type: 'input',
            event: { kind: 'pointerup', point: at(STEPS * STEP_MS), modifiers: NO_MODIFIERS },
          },
        ]),
      );
      dragged.after = await nodeJson();
    }

    const ids = [...new Set(steps.flatMap((entry) => Object.keys(entry.delta)))].sort();
    // Per id: renders on the first step, and the most and fewest on any later step.
    const perStep = Object.fromEntries(
      ids.map((id) => {
        const later = steps.slice(1).map((entry) => entry.delta[id] ?? 0);
        return [
          id,
          {
            first: steps[0]?.delta[id] ?? 0,
            laterMax: Math.max(...later),
            laterMin: Math.min(...later),
            total: steps.reduce((sum, entry) => sum + (entry.delta[id] ?? 0), 0),
          },
        ];
      }),
    );
    const result = {
      unit: 'V20-U1',
      scenario: scenario.id,
      document: scenario.document,
      steps: counted.steps,
      stepCount: steps.length,
      commit: commit(),
      dirty: dirty(),
      browser: `${page.context().browser()?.browserType().name()} ${page
        .context()
        .browser()
        ?.version()}`,
      renderer,
      expanded: configuration.m9.expanded,
      layerRows: configuration.m9.layerRows,
      rowCount,
      rowsInView,
      mountedRows: { ready: ready.mountedRows, max: Math.max(...steps.map((s) => s.mountedRows)) },
      perStep,
      dragMoved: counted.steps === 'drag' ? dragged.before !== dragged.after : null,
      pageErrors: errors,
      rawSteps: steps.map(({ delta: d, mountedRows }) => ({ delta: d, mountedRows })),
    };
    mkdirSync(resultsDirectory, { recursive: true });
    writeFileSync(
      path.join(resultsDirectory, `${scenario.id.replace(/[^a-z0-9-]+/gi, '_')}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    expect(errors, 'page errors').toEqual([]);
    if (counted.steps === 'drag')
      expect(result.dragMoved, 'the drag moved the pressed node').toBe(true);
    expect(ready.mountedRows, 'rows mounted after the toggles').toBeGreaterThan(0);
    expect(rowCount, 'the rows the tree lists').toBe(configuration.m9.layerRows);
    // V20-A01 (the camera path) and V20-A02 (both paths): no column render on a camera-only
    // step after the first; at most the rows in view + 16 (+ pinned, none here) mounted and
    // rendered per step.
    const bound = (rowsInView ?? 0) + 16;
    if (counted.steps === 'camera') {
      for (const id of ['layers', 'properties', 'panels']) {
        expect(perStep[id]?.laterMax ?? 0, `${id} renders per camera step`).toBe(0);
      }
    }
    expect(result.mountedRows.max, 'rows mounted').toBeLessThanOrEqual(bound);
    expect(perStep['layer-row']?.laterMax ?? 0, 'rows rendered per step').toBeLessThanOrEqual(
      bound,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// V20-A03 and A04 on the stress document (10,000 rows, no containers).

type EditorView = {
  getSnapshot(): { history: { undoDepth: number }; selection: readonly string[] };
  execute(command: unknown): { ok: boolean; code?: string };
  query(query: unknown): unknown;
};

const stress = () => loadScenarioDocument('stress');

async function openStress(page: Page): Promise<void> {
  await page.goto('/?bench=1&ui=1&doc=stress');
  await expect(page.getByTestId('status')).toHaveAttribute('data-fixture', 'bench-loaded', {
    timeout: 120_000,
  });
  await expect(page.locator('[data-testid="layers"] li[style*="absolute"]').first()).toBeVisible();
}

/** Scrolls the list to `top` (clamped by the browser) and waits two frames. */
async function scrollList(page: Page, top: number | 'end'): Promise<void> {
  await page.evaluate(async (offset) => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="layer-list-viewport"]')!;
    viewport.scrollTop = offset === 'end' ? viewport.scrollHeight : offset;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }, top);
}

/** The mounted rows as the list shows them, and the list's geometry. */
function mountedRows(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-testid="layer-list-viewport"]')!;
    const items = [...document.querySelectorAll<HTMLElement>('[data-testid="layers"] li')];
    return {
      scrollTop: viewport.scrollTop,
      clientHeight: viewport.clientHeight,
      rowHeight: items[0]?.getBoundingClientRect().height ?? 0,
      rows: items.map((item) => ({
        id: item.dataset.testid!.slice('layer-'.length),
        posinset: Number(item.getAttribute('aria-posinset')),
        setsize: Number(item.getAttribute('aria-setsize')),
        depth: Number(item.dataset.depth),
        selected: item.dataset.selected,
        name: item.querySelector('[data-testid^="layer-name-"]')?.textContent ?? null,
        visible: item.querySelector('[data-testid^="layer-visible-"]')?.textContent ?? null,
      })),
    };
  });
}

const rowRenders = (page: Page) =>
  page.evaluate(() => window.__e26Bench!.renders()['layer-row'] ?? 0);
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const view = (window.__e26Bench!.editor() as unknown as EditorView).getSnapshot();
    return { undoDepth: view.history.undoDepth, selection: [...view.selection] };
  });
const nodeName = (page: Page, id: string) =>
  page.evaluate(
    (nodeId) =>
      (window.__e26Bench!.editor()!.query({ type: 'node', id: nodeId }) as { name: string }).name,
    id,
  );

test('V20-A03 the windowed list equals the unwindowed one', async ({ page }) => {
  const loaded = stress();
  const expected = layerRows(loaded.document, loaded.pageId, new Set(), []);
  await openStress(page);
  const first = await mountedRows(page);
  const h = first.rowHeight;
  expect(h).toBeGreaterThan(0);
  const end = expected.length * h - first.clientHeight;
  for (const offset of [0, Math.round(end / 2), end, end - h]) {
    await scrollList(page, offset);
    const view = await mountedRows(page);
    expect(view.scrollTop, `scrolled to ${offset}`).toBeCloseTo(offset, 0);
    // The mounted rows are one contiguous slice of `layerRows`, in order.
    const positions = view.rows.map((row) => row.posinset);
    expect(positions).toEqual(positions.map((_, index) => positions[0]! + index));
    for (const row of view.rows) {
      const want = expected[row.posinset - 1]!;
      expect(row).toEqual({
        id: want.id,
        posinset: row.posinset,
        setsize: expected.length,
        depth: want.depth,
        selected: String(want.selected),
        name: want.name,
        visible: want.visible ? 'hide' : 'show',
      });
    }
    // Every row that intersects the viewport is mounted.
    const top = Math.floor(view.scrollTop / h) + 1;
    const bottom = Math.min(expected.length, Math.ceil((view.scrollTop + view.clientHeight) / h));
    expect(positions[0]).toBeLessThanOrEqual(top);
    expect(positions[positions.length - 1]).toBeGreaterThanOrEqual(bottom);
  }

  // Stable handlers: an unrelated selection change re-renders no mounted row, and a Shift-click
  // on a row that did not re-render sends the command built from the current selection.
  await scrollList(page, 0);
  const far = expected[expected.length - 1]!.id;
  const near = (await mountedRows(page)).rows[3]!.id;
  const before = await rowRenders(page);
  await page.evaluate(
    (id) => window.__e26Bench!.editor()!.execute({ type: 'setSelection', ids: [id] }),
    far,
  );
  await scrollList(page, 0);
  expect(await rowRenders(page), 'rows rendered by an unrelated selection').toBe(before);
  await page.getByTestId(`layer-name-${near}`).click({ modifiers: ['Shift'] });
  expect((await snapshot(page)).selection).toEqual([far, near]);
});

test('V20-A04 rename and focus pins, and Tab through the rows', async ({ page }) => {
  const loaded = stress();
  const expected = layerRows(loaded.document, loaded.pageId, new Set(), []);
  await openStress(page);
  const [a, b, c] = [expected[1]!.id, expected[2]!.id, expected[3]!.id];

  // Typing updates the textbox on every key and renders only its own row.
  await page.getByTestId(`layer-name-${a}`).dblclick();
  const input = page.getByRole('textbox', { name: 'layer name' });
  await expect(input).toBeFocused();
  await input.fill('');
  let typed = '';
  for (const key of 'Moved') {
    const renders = await rowRenders(page);
    await page.keyboard.type(key);
    typed += key;
    await expect(input).toHaveValue(typed);
    expect((await rowRenders(page)) - renders, `rows rendered by "${key}"`).toBe(1);
  }
  // Scrolled out of view, the open textbox stays mounted and focused; Enter commits once.
  const depth = (await snapshot(page)).undoDepth;
  await scrollList(page, 'end');
  await expect(input).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(input).toHaveCount(0);
  expect(await nodeName(page, a)).toBe('Moved');
  expect((await snapshot(page)).undoDepth).toBe(depth + 1);

  // Escape sends nothing, also after a scroll.
  await scrollList(page, 0);
  await page.getByTestId(`layer-name-${b}`).dblclick();
  await input.fill('Never');
  await scrollList(page, 'end');
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  expect(await nodeName(page, b)).toBe(expected[2]!.name);
  expect((await snapshot(page)).undoDepth).toBe(depth + 1);

  // A blur while scrolled away commits once.
  await scrollList(page, 0);
  await page.getByTestId(`layer-name-${c}`).dblclick();
  await input.fill('Blurred');
  await scrollList(page, 'end');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(input).toHaveCount(0);
  expect(await nodeName(page, c)).toBe('Blurred');
  expect((await snapshot(page)).undoDepth).toBe(depth + 2);

  // A focused row button scrolled out of view keeps focus.
  await scrollList(page, 0);
  const visible = page.getByTestId(`layer-visible-${expected[5]!.id}`);
  await visible.focus();
  await scrollList(page, 'end');
  await expect(visible).toBeFocused();

  // Tab from the first row reaches at least three viewports of rows in order; Shift+Tab returns.
  await scrollList(page, 0);
  const view = await mountedRows(page);
  const perView = Math.floor(view.clientHeight / view.rowHeight);
  await page.getByTestId(`layer-name-${expected[0]!.id}`).focus();
  const position = () =>
    page.evaluate(() =>
      Number(document.activeElement?.closest('li')?.getAttribute('aria-posinset') ?? 0),
    );
  const forward: number[] = [await position()];
  // Two controls per row (name, visibility): two Tabs per row.
  const tabs = 2 * 3 * perView + 2;
  for (let index = 0; index < tabs; index += 1) {
    await page.keyboard.press('Tab');
    forward.push(await position());
  }
  expect(forward.every((value, index) => index === 0 || value >= forward[index - 1]!)).toBe(true);
  expect(forward.every((value, index) => index === 0 || value - forward[index - 1]! <= 1)).toBe(
    true,
  );
  expect(forward[forward.length - 1]!).toBeGreaterThanOrEqual(3 * perView + 1);
  for (let index = 0; index < tabs; index += 1) await page.keyboard.press('Shift+Tab');
  expect(await position()).toBe(1);
});
