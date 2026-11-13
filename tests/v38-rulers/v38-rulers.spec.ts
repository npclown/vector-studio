import type { Command, Editor } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';

// V-38 contract (docs/plans/viz-v38-rulers-guides-grids-contract.md), V38-A07: in the studio
// (`?test=1&layout=studio`), a guide dragged from the top ruler is one undo step and a moved
// rectangle snaps to it; dragging it back onto the ruler removes it; Escape cancels a drag without
// leaving the scope; a frame with columns draws them; Shift+R hides the rulers. Runs in
// playwright.v38-rulers.config.ts (headed Chrome and Edge, or the headless smoke project).

type Hook = Readonly<{ editor: Editor }>;

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&layout=studio');
  await page.waitForFunction(
    () => (window as unknown as { __p5Host?: Hook }).__p5Host !== undefined,
  );
  await expect(page.getByTestId('ruler-top')).toBeVisible();
  return errors;
}

async function run(page: Page, command: Command): Promise<readonly string[]> {
  const result = await page.evaluate((text: string) => {
    const hook = (window as unknown as { __p5Host: Hook }).__p5Host;
    const value = hook.editor.execute(JSON.parse(text) as Command);
    return value.ok ? { ids: [...value.ids], code: '' } : { ids: [], code: value.code };
  }, JSON.stringify(command));
  expect(result.code, command.type).toBe('');
  return result.ids;
}

async function state(page: Page) {
  return page.evaluate(() => {
    const { editor } = (window as unknown as { __p5Host: Hook }).__p5Host;
    const snapshot = editor.getSnapshot();
    const active = snapshot.document.pages.find((entry) => entry.id === snapshot.activePage)!;
    return {
      page: snapshot.activePage,
      guides: active.guides ?? [],
      undo: snapshot.history.undoDepth,
      scope: snapshot.scope,
      rulers: snapshot.rulersVisible,
      camera: snapshot.viewport,
    };
  });
}

/** The canvas's top-left corner in client px. */
async function origin(page: Page) {
  const box = await page.locator('[data-testid="canvas-host"] canvas').boundingBox();
  if (box === null) throw new Error('no canvas');
  return box;
}

test('a guide from the top ruler: one step, snaps a move, removed on the ruler', async ({
  page,
}) => {
  const errors = await open(page);
  const start = await state(page);
  await run(page, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 1 } });
  const canvas = await origin(page);
  // Drag from the top ruler down to page y = 200.
  await page.mouse.move(canvas.x + 300, canvas.y + 10);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 300, canvas.y + 120, { steps: 4 });
  await expect(page.getByTestId('guide-label')).toBeVisible();
  await page.mouse.move(canvas.x + 300, canvas.y + 200, { steps: 4 });
  await page.mouse.up();
  let now = await state(page);
  expect(now.guides).toEqual([{ axis: 'y', value: 200 }]);
  expect(now.undo).toBe(start.undo + 1);
  await expect(page.locator('[data-testid="guide"][data-axis="y"]')).toHaveCount(1);

  // A rectangle at y = 100 moved down by 97 snaps its top onto the guide at 200.
  const [id] = await run(page, {
    type: 'createRectangle',
    frame: { x: 400, y: 100, width: 50, height: 40 },
  });
  await run(page, { type: 'setSelection', ids: [id!] });
  await page.mouse.move(canvas.x + 425, canvas.y + 120);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 425, canvas.y + 170, { steps: 4 });
  await page.mouse.move(canvas.x + 425, canvas.y + 217, { steps: 4 });
  await page.mouse.up();
  const frame = await page.evaluate(
    (node) =>
      (window as unknown as { __p5Host: Hook }).__p5Host.editor.query({ type: 'node', id: node })!
        .frame,
    id!,
  );
  expect(frame.y).toBe(200);

  // Pick the guide up away from the selection and drop it on its ruler: removed, one step.
  await run(page, { type: 'setSelection', ids: [] });
  const before = (await state(page)).undo;
  await page.mouse.move(canvas.x + 700, canvas.y + 200);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 700, canvas.y + 100, { steps: 4 });
  await page.mouse.move(canvas.x + 700, canvas.y + 8, { steps: 4 });
  await page.mouse.up();
  now = await state(page);
  expect(now.guides).toEqual([]);
  expect(now.undo).toBe(before + 1);
  expect(errors).toEqual([]);
});

test('Escape cancels a guide drag and does not reach the editor', async ({ page }) => {
  await open(page);
  await run(page, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 1 } });
  const [frame] = await run(page, {
    type: 'createFrame',
    frame: { x: 100, y: 100, width: 300, height: 300 },
  });
  await run(page, { type: 'setScope', id: frame! });
  const canvas = await origin(page);
  await page.mouse.move(canvas.x + 10, canvas.y + 300);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 150, canvas.y + 300, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  const now = await state(page);
  expect(now.guides).toEqual([]);
  expect(now.scope).toBe(frame);
});

test('a frame with columns draws them, and Shift+R hides the rulers', async ({ page }) => {
  await open(page);
  const [frame] = await run(page, {
    type: 'createFrame',
    frame: { x: 100, y: 100, width: 400, height: 300 },
  });
  await run(page, {
    type: 'setNodeProps',
    id: frame!,
    props: {
      layoutGrids: [
        {
          type: 'columns',
          count: 4,
          align: 'stretch',
          size: 100,
          gutter: 20,
          offset: 20,
          color: { r: 1, g: 0, b: 0, a: 0.1 },
          visible: true,
        },
      ],
    },
  });
  const grid = page.locator(`[data-testid="layout-grid"][data-frame="${frame}"]`);
  const canvasGrid = page.getByTestId('canvas-grid');
  // V-41 contract, V41-H2: the studio starts with grids hidden; Grids shows the canvas grid
  // (V41-H1) and the layout grids, and hides both again.
  await expect(grid).toHaveCount(0);
  await expect(canvasGrid).toHaveCount(0);
  await page.getByTestId('toggle-layout-grids').click();
  await expect(grid).toHaveAttribute('data-bands', '4');
  await expect(canvasGrid).toHaveAttribute('data-step', '10');
  await page.getByTestId('toggle-layout-grids').click();
  await expect(grid).toHaveCount(0);
  await expect(canvasGrid).toHaveCount(0);
  await page.getByTestId('toggle-layout-grids').click();
  await expect(grid).toHaveCount(1);

  await page.locator('[data-testid="canvas-host"] canvas').focus();
  await page.keyboard.press('Shift+R');
  await expect(page.getByTestId('ruler-top')).toHaveCount(0);
  expect((await state(page)).rulers).toBe(false);
  await page.getByTestId('toggle-rulers').click();
  await expect(page.getByTestId('ruler-top')).toBeVisible();

  // The wheel over a ruler shown again still pans the canvas.
  const before = (await state(page)).camera;
  const ruler = await page.getByTestId('ruler-top').boundingBox();
  await page.mouse.move(ruler!.x + 200, ruler!.y + 10);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await state(page)).camera).not.toEqual(before);
});

test('a double-click on a guide over a group does not enter the group', async ({ page }) => {
  await open(page);
  await run(page, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 1 } });
  const [a] = await run(page, {
    type: 'createRectangle',
    frame: { x: 150, y: 150, width: 200, height: 200 },
  });
  const [b] = await run(page, {
    type: 'createRectangle',
    frame: { x: 400, y: 150, width: 50, height: 50 },
  });
  await run(page, { type: 'groupNodes', ids: [a!, b!], kind: 'group' });
  const { page: id } = await state(page);
  await run(page, { type: 'setGuides', page: id, guides: [{ axis: 'x', value: 250 }] });
  await run(page, { type: 'setSelection', ids: [] });
  const canvas = await origin(page);
  const scope = (await state(page)).scope;
  await page.mouse.dblclick(canvas.x + 250, canvas.y + 250);
  const now = await state(page);
  expect(now.scope).toBe(scope);
  expect(now.guides).toEqual([{ axis: 'x', value: 250 }]);
});

test('a held Space picks up no guide, and a window blur ends a drag unwritten', async ({
  page,
}) => {
  await open(page);
  await run(page, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 1 } });
  const { page: id } = await state(page);
  await run(page, { type: 'setGuides', page: id, guides: [{ axis: 'x', value: 300 }] });
  const canvas = await origin(page);
  await page.locator('[data-testid="canvas-host"] canvas').focus();
  await page.keyboard.down('Space');
  await page.mouse.move(canvas.x + 300, canvas.y + 300);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 400, canvas.y + 300, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect((await state(page)).guides).toEqual([{ axis: 'x', value: 300 }]);

  // Picked up without Space, then the window loses focus mid-drag: nothing is written.
  await run(page, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 1 } });
  const undo = (await state(page)).undo;
  const at = 300;
  await page.mouse.move(canvas.x + at, canvas.y + 300);
  await page.mouse.down();
  await page.mouse.move(canvas.x + at + 100, canvas.y + 300, { steps: 4 });
  await expect(page.getByTestId('guide-label')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByTestId('guide-label')).toHaveCount(0);
  await page.mouse.up();
  const now = await state(page);
  expect(now.guides).toEqual([{ axis: 'x', value: 300 }]);
  expect(now.undo).toBe(undo);
});

// V-41 contract, V41-U1 and V41-A8: with nothing selected the Canvas section sets the page's
// background and grid colour (one undo step each); with a renderer (headed), the captured frame
// shows the background where nothing is drawn.
test('the Canvas section sets the background and grid colour; the frame clears to it', async ({
  page,
}) => {
  const errors = await open(page);
  await run(page, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 1 } });
  const panel = page.getByTestId('canvas-panel');
  await expect(panel).toBeVisible();
  const background = panel.getByLabel('Canvas background', { exact: true });
  await background.fill('#ffffff');
  await background.press('Enter');
  const gridColour = panel.getByLabel('Canvas grid colour', { exact: true });
  await gridColour.fill('#ff0000');
  await gridColour.press('Enter');
  const page0 = await page.evaluate(() => {
    const { editor } = (window as unknown as { __p5Host: Hook }).__p5Host;
    const snapshot = editor.getSnapshot();
    return snapshot.document.pages.find((entry) => entry.id === snapshot.activePage)!;
  });
  expect(page0.background).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  expect(page0.grid).toEqual({ size: 10, color: { r: 1, g: 0, b: 0, a: 0.35 } });
  await page.getByTestId('toggle-layout-grids').click();
  await expect(page.getByTestId('canvas-grid')).toHaveAttribute('stroke', 'rgba(255, 0, 0, 0.35)');

  type Capture = Readonly<{
    capture: () => Promise<{ width: number; devicePixelRatio: number; rgba: Uint8Array }>;
  }>;
  const hasRenderer = await page.evaluate(
    () => (window as unknown as { __nextHostRenderer?: Capture }).__nextHostRenderer !== undefined,
  );
  if (hasRenderer) {
    // A page point the empty document draws nothing at, away from the rulers.
    const pixel = await page.evaluate(async () => {
      const hook = (window as unknown as { __nextHostRenderer: Capture }).__nextHostRenderer;
      let frame: Awaited<ReturnType<Capture['capture']>> | null = null;
      for (let attempt = 0; frame === null; attempt += 1) {
        try {
          frame = await hook.capture();
        } catch (error) {
          if (attempt >= 60 || !String(error).includes('not-ready')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      const at = Math.floor(200 * frame.devicePixelRatio);
      const offset = (at * frame.width + at) * 4;
      return [frame.rgba[offset], frame.rgba[offset + 1], frame.rgba[offset + 2]];
    });
    expect(pixel).toEqual([255, 255, 255]);
  }
  expect(errors).toEqual([]);
});
