import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { m1A13MoveSelection } from '../m1-a13/document';
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
    for (const id of configuration.m9.expanded) {
      const toggle = page.getByTestId(`layer-toggle-${id}`);
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
    const ready = await step(page, []);

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
  });
}
