import type { Editor } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';

// V-37 contract (docs/plans/viz-v37-variants-overrides-contract.md), V37-A13: on the next-host
// studio page loaded with the committed fixture (`?fixture=v37-variants`: the symbols `sA`, `sB`
// and `sC` of one coloured rectangle each, and `inst`, an instance of `sA`), combine the three
// symbols as variants from the property panel, switch the instance's variant from its dropdown,
// focus a layer by a double-click on the canvas, override its fill from the panel, and reset it.
// Runs in playwright.v37-studio.config.ts (headed Chrome and Edge, or one headless smoke project
// with M8_NEXT_HOST_CHROMIUM). The spec reads the document through the page's `?test=1` hook;
// it has no pixel probes, so the renderer need not start.

type Hook = Readonly<{ editor: Editor }>;
type Point = Readonly<{ x: number; y: number }>;

const MAGENTA = { r: 1, g: 0, b: 1, a: 1 };
/** Inside `inst` (page frame 0, 100, 100 x 40) and its rectangle, which fills it. */
const INSIDE_INSTANCE: Point = { x: 50, y: 120 };

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&layout=studio&fixture=v37-variants');
  await page.waitForFunction(
    () =>
      (window as unknown as { __p5Host?: Hook }).__p5Host?.editor.getSnapshot().document.nodes
        .inst !== undefined,
  );
  await expect(page.getByTestId('studio')).toBeVisible();
  return errors;
}

/** The parts of the editor state the checks read, as plain data. */
async function state(page: Page) {
  return page.evaluate(() => {
    const { editor } = (window as unknown as { __p5Host: Hook }).__p5Host;
    const snapshot = editor.getSnapshot();
    const nodes = snapshot.document.nodes as unknown as Record<string, Record<string, unknown>>;
    return {
      selection: [...snapshot.selection],
      undoDepth: snapshot.history.undoDepth,
      inst: nodes.inst as { symbol: string; overrides?: Record<string, unknown> },
      nodes,
    };
  });
}

async function select(page: Page, ids: readonly string[]) {
  const ok = await page.evaluate(
    (list: string[]) =>
      (window as unknown as { __p5Host: Hook }).__p5Host.editor.execute({
        type: 'setSelection',
        ids: list,
      }).ok,
    [...ids],
  );
  expect(ok).toBe(true);
}

/** The client point of page point `p` on the studio canvas. */
async function client(page: Page, p: Point): Promise<Point> {
  return page.evaluate((point) => {
    const { editor } = (window as unknown as { __p5Host: Hook }).__p5Host;
    const { position, zoom } = editor.getSnapshot().viewport;
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="studio-canvas"] canvas',
    )!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + canvas.clientLeft + (point.x - position.x) * zoom,
      y: rect.top + canvas.clientTop + (point.y - position.y) * zoom,
    };
  }, p);
}

test('V37-A13 combine, switch a variant, focus a layer, override its fill, reset', async ({
  page,
}) => {
  const errors = await open(page);

  // Combine the three symbols from the property panel's Component section.
  await select(page, ['sA', 'sB', 'sC']);
  const before = (await state(page)).undoDepth;
  await page.getByRole('button', { name: 'Combine as variants' }).click();
  const combined = await state(page);
  expect(combined.undoDepth).toBe(before + 1);
  const set = combined.selection[0]!;
  expect(combined.nodes[set]!.type).toBe('symbolSet');
  expect(combined.nodes[set]!.children).toEqual(['sA', 'sB', 'sC']);
  expect(['sA', 'sB', 'sC'].map((id) => combined.nodes[id]!.variant)).toEqual([
    { 'Property 1': 'Default' },
    { 'Property 1': 'Hover' },
    { 'Property 1': 'Pressed' },
  ]);
  // The set's own panel lists the property.
  await expect(page.getByRole('group', { name: 'Properties' })).toBeVisible();
  await expect(page.getByLabel('Property 1 name')).toHaveValue('Property 1');

  // Switch the instance's variant from its dropdown: it now refers to `sB`.
  await select(page, ['inst']);
  const dropdown = page.getByLabel('Variant Property 1');
  await expect(dropdown).toHaveValue('Default');
  await dropdown.selectOption('Hover');
  expect((await state(page)).inst.symbol).toBe('sB');
  await expect(dropdown).toHaveValue('Hover');

  // A double-click on the instance focuses the layer under the pointer: `sB`'s rectangle `rB`,
  // outlined in the selection overlay, with its controls in the panel.
  await expect(page.getByTestId('instance-focus')).toHaveCount(0);
  const at = await client(page, INSIDE_INSTANCE);
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.getByTestId('instance-focus')).toHaveCount(1);
  await expect(page.getByTestId('instance-layer-rB')).toHaveAttribute('aria-pressed', 'true');
  // The first Escape, with the canvas focused, clears only the focus: the selection stays and
  // the scope is not left. A second double-click focuses the layer again.
  await page.locator('[data-testid="studio-canvas"] canvas').focus();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('instance-focus')).toHaveCount(0);
  expect((await state(page)).selection).toEqual(['inst']);
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.getByTestId('instance-focus')).toHaveCount(1);
  const steps = (await state(page)).undoDepth;
  expect((await state(page)).selection).toEqual(['inst']);

  // Override its fill from the panel: one `setInstanceOverride`, one undo step.
  const fill = page.getByLabel('Layer fill colour', { exact: true });
  await fill.fill('#ff00ff');
  await fill.press('Enter');
  const overridden = await state(page);
  expect(overridden.inst.overrides).toEqual({ rB: { fill: MAGENTA } });
  expect(overridden.undoDepth).toBe(steps + 1);
  await expect(page.getByTestId('instance-layer-rB')).toHaveAttribute('data-overridden', 'true');
  // The source rectangle itself is unchanged.
  expect(overridden.nodes.rB!.fill).toEqual({ r: 0, g: 1, b: 0, a: 1 });

  // Reset the layer: the override is gone and the row is no longer marked.
  await page
    .getByRole('group', { name: 'Layer Box' })
    .getByRole('button', { name: 'Reset', exact: true })
    .click();
  const reset = await state(page);
  expect(reset.inst.overrides).toBeUndefined();
  expect(reset.undoDepth).toBe(steps + 2);
  await expect(page.getByTestId('instance-layer-rB')).not.toHaveAttribute(
    'data-overridden',
    'true',
  );

  // Escape clears the focus; the selection stays.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('instance-focus')).toHaveCount(0);
  expect((await state(page)).selection).toEqual(['inst']);
  expect(errors).toEqual([]);
});
