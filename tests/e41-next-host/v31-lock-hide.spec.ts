import type { Command, Editor } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';

// V-31 contract (docs/plans/viz-v31-lock-hide-contract.md), V31-A07: on the next-host studio
// page (`?test=1&layout=studio`), lock a shape from its layer-tree button and click it on the
// canvas (the shape under it is selected); the lock button stays shown on the locked row; hide
// one with Ctrl/Cmd+Shift+H and see it leave the export; lock and hide undo in one step each.
// Runs in playwright.e41-studio.config.ts (headed Chrome and Edge, or the headless smoke project
// with M8_NEXT_HOST_CHROMIUM).

type Hook = Readonly<{ editor: Editor }>;

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

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __p5Host: Hook }).__p5Host.editor.getSnapshot();
    return {
      selection: [...s.selection],
      nodes: s.document.nodes as Record<string, { locked?: boolean; visible: boolean }>,
      undoDepth: s.history.undoDepth,
    };
  });
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

test('V31-A07 lock from the layer tree, click through, hide by key, export', async ({ page }) => {
  const errors = await open(page);
  const [under] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 200, height: 200 },
    fill: RED,
    stroke: null,
  });
  const [top] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 50, y: 50, width: 100, height: 100 },
    fill: BLUE,
    stroke: null,
  });
  await ok(page, { type: 'setSelection', ids: [under!, top!] });
  await ok(page, { type: 'zoomTo', target: 'selection' });
  await ok(page, { type: 'setSelection', ids: [] });

  // The lock button of the top shape's row: hover reveals it, a click locks the node.
  const row = page.getByTestId(`layer-${top}`);
  await row.hover();
  const lockButton = page.getByTestId(`layer-lock-${top}`);
  await expect(lockButton).toHaveAttribute('aria-label', 'lock');
  const before = (await snapshot(page)).undoDepth;
  await lockButton.click();
  expect((await snapshot(page)).nodes[top!]!.locked).toBe(true);
  await expect(lockButton).toHaveAttribute('aria-pressed', 'true');
  // Away from the row the active lock button stays shown (opacity 1).
  await page.mouse.move(5, 5);
  await expect(lockButton).toHaveCSS('opacity', '1');

  // A click on the locked shape selects the shape under it; a drag from it moves nothing locked.
  const centre = await client(page, { x: 100, y: 100 });
  await page.mouse.click(centre.x, centre.y);
  expect((await snapshot(page)).selection).toEqual([under]);

  // Hide `under` by its chord on the focused canvas; it leaves the SVG export of the page.
  await page.locator('[data-testid="studio-canvas"] canvas').focus();
  await page.keyboard.press('ControlOrMeta+Shift+H');
  expect((await snapshot(page)).nodes[under!]!.visible).toBe(false);
  const svg = await page.evaluate(() =>
    (window as unknown as { __p5Host: Hook }).__p5Host.editor.query({ type: 'exportSvg' }),
  );
  expect(svg).not.toBeNull();
  expect(svg!).toContain('#0000ff');
  expect(svg!).not.toContain('#ff0000');
  await expect(page.getByTestId(`layer-visible-${under}`)).toHaveCSS('opacity', '1');

  // Each step was one undo step: undo the hide, then the lock.
  expect((await snapshot(page)).undoDepth).toBe(before + 2);
  await page.keyboard.press('ControlOrMeta+Z');
  expect((await snapshot(page)).nodes[under!]!.visible).toBe(true);
  await page.keyboard.press('ControlOrMeta+Z');
  expect((await snapshot(page)).nodes[top!]!.locked).toBeUndefined();
  expect(errors).toEqual([]);
});
