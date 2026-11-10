import type { Command, Editor } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), E41-A12, the boolean half
// (E41-U3b): on the next-host studio page (`?test=1&layout=studio`), the four booleans from the
// canvas context menu, the keys (Ctrl+Alt+U, S, I, X) and the property panel's Boolean section,
// undo, and a refusal's notice. Runs in playwright.e41-next-host.config.ts (headed Chrome and
// Edge, or the headless smoke project with M8_NEXT_HOST_CHROMIUM).

type Hook = Readonly<{ editor: Editor }>;
type State = Readonly<{
  children: readonly string[];
  types: readonly string[];
  selection: readonly string[];
}>;

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&layout=studio');
  await page.waitForFunction(
    () => (window as unknown as { __p5Host?: Hook }).__p5Host !== undefined,
  );
  await expect(page.getByTestId('studio')).toBeVisible();
  return errors;
}

async function ok(page: Page, command: Command): Promise<readonly string[]> {
  const result = await page.evaluate((text: string) => {
    const hook = (window as unknown as { __p5Host: Hook }).__p5Host;
    const value = hook.editor.execute(JSON.parse(text) as Command);
    return value.ok ? { ids: [...value.ids], code: '' } : { ids: [], code: value.code };
  }, JSON.stringify(command));
  expect(result.code, command.type).toBe('');
  return result.ids;
}

/** The active page's children, their types and the selection. */
async function state(page: Page): Promise<State> {
  return page.evaluate(() => {
    const snapshot = (window as unknown as { __p5Host: Hook }).__p5Host.editor.getSnapshot();
    const { document } = snapshot;
    const children = document.pages.find((entry) => entry.id === snapshot.activePage)!.children;
    return {
      children: [...children],
      types: children.map((id) => document.nodes[id]!.type),
      selection: [...snapshot.selection],
    };
  });
}

/** Two overlapping squares, both selected, framed in the view. */
async function pair(page: Page, far = false): Promise<readonly [string, string]> {
  const [a] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 100, height: 100 },
    fill: RED,
    stroke: null,
  });
  const [b] = await ok(page, {
    type: 'createRectangle',
    frame: far
      ? { x: 300, y: 0, width: 100, height: 100 }
      : { x: 50, y: 50, width: 100, height: 100 },
    fill: BLUE,
    stroke: null,
  });
  await ok(page, { type: 'setSelection', ids: [a!, b!] });
  await ok(page, { type: 'zoomTo', target: 'selection' });
  return [a!, b!];
}

/** The client point of page point `p` on the studio canvas. */
async function client(page: Page, p: { x: number; y: number }) {
  return page.evaluate((point) => {
    const editor = (window as unknown as { __p5Host: Hook }).__p5Host.editor;
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

async function contextMenu(page: Page, item: string) {
  const at = await client(page, { x: 75, y: 75 });
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await page.getByTestId(`context-${item}`).click();
  await expect(page.getByTestId('context-menu')).toBeHidden();
}

/** One path, selected. */
async function expectResult(page: Page) {
  const after = await state(page);
  expect(after.types).toEqual(['path']);
  expect(after.selection).toEqual(after.children);
}

test('E41-A12 booleans: context menu, keys, panel, undo and a refusal notice', async ({ page }) => {
  const errors = await open(page);

  // Each boolean from the context menu, then from its key on the focused canvas; undo
  // (ControlOrMeta, Mod on either platform) restores both inputs, their order and the selection.
  const [a, b] = await pair(page);
  const inputs = { children: [a, b], types: ['rectangle', 'rectangle'], selection: [a, b] };
  for (const [op, key] of [
    ['union', 'U'],
    ['subtract', 'S'],
    ['intersect', 'I'],
    ['exclude', 'X'],
  ] as const) {
    await contextMenu(page, `boolean-${op}`);
    await expectResult(page);
    await page.keyboard.press('ControlOrMeta+Z');
    expect(await state(page), `${op} menu undo`).toEqual(inputs);
    await page.locator('[data-testid="studio-canvas"] canvas').focus();
    await page.keyboard.press(`ControlOrMeta+Alt+${key}`);
    await expectResult(page);
    await page.keyboard.press('ControlOrMeta+Z');
    expect(await state(page), `${op} key undo`).toEqual(inputs);
  }

  // The property panel's Boolean section.
  await page.getByTestId('property-boolean-intersect').click();
  await expectResult(page);
  // A single selected path does not qualify: no Boolean section (the menu's rule is unit-tested).
  await expect(page.getByTestId('property-boolean-union')).toHaveCount(0);
  await ok(page, { type: 'deleteNodes', ids: (await state(page)).children });

  // A refusal: disjoint squares intersect to nothing; the notice shows and nothing changes.
  const [c, d] = await pair(page, true);
  const at = await client(page, { x: 50, y: 50 });
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.getByTestId('context-boolean-intersect').click();
  await expect(page.getByTestId('context-refusal')).toHaveText(
    'The boolean result is empty, so nothing changed',
  );
  expect(await state(page)).toEqual({
    children: [c, d],
    types: ['rectangle', 'rectangle'],
    selection: [c, d],
  });
  expect(errors).toEqual([]);
});
