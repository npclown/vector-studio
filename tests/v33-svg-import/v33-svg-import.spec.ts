import type { Command, Editor } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';

// V-33 SVG import contract (docs/plans/viz-v33-svg-import-contract.md), V33-A06: the studio's
// Import section (a real file chooser), an SVG file dropped on the canvas and SVG markup pasted
// on the focused canvas (DOM events carrying a real DataTransfer), on the next-host page
// (`?test=1&layout=studio`). The document is read through the test hook. Runs in
// playwright.v33-svg-import.config.ts (headed Chrome and Edge, or the headless smoke project with
// M8_NEXT_HOST_CHROMIUM).

type Hook = Readonly<{ editor: Editor }>;

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20">' +
  '<title>Badge</title><rect width="20" height="20" fill="#ff0000"/>' +
  '<circle cx="30" cy="10" r="10" fill="#0000ff"/><image href="x.png"/></svg>';

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&layout=studio');
  await page.waitForFunction(
    () => (window as unknown as { __p5Host?: Hook }).__p5Host !== undefined,
  );
  await expect(page.getByTestId('import-panel')).toBeVisible();
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

/** The selected nodes' type, name and children's types. */
async function selected(page: Page) {
  return page.evaluate(() => {
    const { editor } = (window as unknown as { __p5Host: Hook }).__p5Host;
    const document = editor.query({ type: 'document' });
    return editor.query({ type: 'selection' }).map((id) => {
      const node = document.nodes[id]!;
      const children = 'children' in node ? node.children : [];
      return {
        type: node.type,
        name: node.name,
        children: children.map((child) => document.nodes[child]!.type),
        frame: node.frame,
      };
    });
  });
}

/** The canvas element's page point of a client point, by the editor's camera. */
async function canvasCentre(page: Page) {
  const box = (await page.getByTestId('studio-canvas').locator('canvas').first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('V33-A06 the Import button imports a chosen file as editable nodes', async ({ page }) => {
  const errors = await open(page);
  await page.getByTestId('import-file').setInputFiles({
    name: 'badge.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(ICON),
  });
  await expect(page.getByTestId('import-message').first()).toHaveText('Imported badge.svg');
  await expect(page.getByTestId('import-message').nth(1)).toHaveText('Skipped: image');
  const nodes = await selected(page);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]).toMatchObject({
    type: 'group',
    name: 'Badge',
    children: ['rectangle', 'ellipse'],
  });
  expect(nodes[0]!.frame.width).toBeCloseTo(40);
  // One undo step removes it.
  await ok(page, { type: 'undo' });
  expect(await selected(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('V33-A06 SVG files dropped on the canvas import at the drop point', async ({ page }) => {
  const errors = await open(page);
  const point = await canvasCentre(page);
  await page.evaluate(
    ({ svg, x, y }) => {
      const canvas = document.querySelector('[data-testid="studio-canvas"] canvas')!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([svg], 'a.svg', { type: 'image/svg+xml' }));
      transfer.items.add(new File(['x'], 'notes.txt', { type: 'text/plain' }));
      transfer.items.add(new File([svg], 'b.svg', { type: 'image/svg+xml' }));
      const over = new DragEvent('dragover', {
        dataTransfer: transfer,
        clientX: x,
        clientY: y,
        cancelable: true,
        bubbles: true,
      });
      canvas.dispatchEvent(over);
      (window as unknown as { __dragOverPrevented: boolean }).__dragOverPrevented =
        over.defaultPrevented;
      canvas.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: transfer,
          clientX: x,
          clientY: y,
          cancelable: true,
          bubbles: true,
        }),
      );
    },
    { svg: ICON, ...point },
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { __dragOverPrevented: boolean }).__dragOverPrevented,
    ),
  ).toBe(true);
  await expect.poll(async () => (await selected(page)).length).toBe(1);
  const pages = await page.evaluate(() => {
    const { editor } = (window as unknown as { __p5Host: Hook }).__p5Host;
    const document = editor.query({ type: 'document' });
    const active = editor.query({ type: 'activePage' });
    const pageNode = document.pages.find((each) => each.id === active)!;
    return pageNode.children
      .map((id) => document.nodes[id]!)
      .filter((node) => node.name === 'Badge')
      .map((node) => node.frame);
  });
  expect(pages).toHaveLength(2);
  expect(pages[1]!.x - pages[0]!.x).toBeCloseTo(16 / 1, 0);
  expect(errors).toEqual([]);
});

test('V33-A06 SVG markup pasted on the focused canvas imports; an exported SVG comes back', async ({
  page,
}) => {
  const errors = await open(page);
  const canvas = page.getByTestId('studio-canvas').locator('canvas').first();
  await canvas.focus();
  const paste = (text: string) =>
    page.evaluate((value) => {
      const target = document.querySelector('[data-testid="studio-canvas"] canvas')!;
      const transfer = new DataTransfer();
      transfer.setData('text/plain', value);
      target.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, cancelable: true, bubbles: true }),
      );
    }, text);
  await paste(ICON);
  const first = await selected(page);
  expect(first[0]).toMatchObject({ type: 'group', name: 'Badge' });
  // Export the selection as SVG through the query, paste it back: the same structure of shapes.
  const svg = await page.evaluate(() => {
    const { editor } = (window as unknown as { __p5Host: Hook }).__p5Host;
    return editor.query({ type: 'exportSvg', ids: editor.query({ type: 'selection' }) });
  });
  expect(svg).not.toBeNull();
  await paste(svg!);
  const second = await selected(page);
  expect(second).toHaveLength(1);
  expect(second[0]!.children).toEqual(['path', 'path']);
  expect(second[0]!.frame.width).toBeCloseTo(first[0]!.frame.width, 1);
  expect(errors).toEqual([]);
});
