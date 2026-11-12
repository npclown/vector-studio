import type { Command, DocumentV8, Editor, NodeV8 } from '@vector-studio/editor-core';
import { expect, test, type Locator, type Page } from '@playwright/test';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), V39-A07: the Local styles
// panel (U4), the style menus (U2) and the number bind buttons (U3) in the studio on the
// next-host page (`?test=1&layout=studio`), with real clicks. The canvas colour is read from a
// PNG export of the bound rectangle (Canvas 2D). Runs in playwright.v39-styles.config.ts.

type Hook = Readonly<{ editor: Editor }>;

const RED = { r: 1, g: 0, b: 0, a: 1 };

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Branded Chrome and Edge have the EyeDropper API, whose screen-pick buttons widen the colour
  // rows; a headless Chromium may not, so a stub gives the smoke run the same rows.
  await page.addInitScript(() => {
    const scope = window as unknown as { EyeDropper?: unknown };
    scope.EyeDropper ??= class {
      open() {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }
    };
  });
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

async function docOf(page: Page): Promise<DocumentV8> {
  // `evaluate` returns the document as JSON-cloned data.
  return page.evaluate(() =>
    (window as unknown as { __p5Host: Hook }).__p5Host.editor.query({
      type: 'document',
    }),
  );
}

async function node(page: Page, id: string): Promise<NodeV8> {
  return (await docOf(page)).nodes[id]!;
}

/**
 * The element at `locator`'s centre is the locator's element or inside it: nothing (the scrolling
 * right column on a headed run) covers a menu item before the click.
 */
async function expectOnTop(locator: Locator) {
  await expect(locator).toBeVisible();
  // '' when the item is on top, else what covers it and where, for a headed failure's report.
  const cover = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit !== null && element.contains(hit)) return '';
    const name = hit === null ? 'nothing' : `${hit.tagName} ${hit.className} ${hit.id}`;
    return `${name} at (${x}, ${y}); item ${JSON.stringify(rect)}`;
  });
  expect(cover).toBe('');
}

/** The centre pixel of a 1x PNG export of the selection. */
async function exportedCentre(page: Page): Promise<readonly number[]> {
  await page.getByLabel('Export format').selectOption('png');
  await page.getByLabel('Export scale').selectOption('1');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-button').click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return page.evaluate(async (base64: string) => {
    const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const x = Math.floor(bitmap.width / 2);
    const y = Math.floor(bitmap.height / 2);
    return [...context.getImageData(x, y, 1, 1).data];
  }, Buffer.concat(chunks).toString('base64'));
}

test('V39-A07 styles and variables: panel, style menu, bind buttons, modes', async ({ page }) => {
  const errors = await open(page);
  const panel = page.getByTestId('styles-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Local styles' })).toBeVisible();

  // U4: a new style `Color 1` (#D9D9D9), renamed and recoloured.
  await panel.getByTestId('add-style').click();
  const styleName = panel.getByLabel('Style 1 name');
  await expect(styleName).toHaveValue('Color 1');
  await styleName.fill('Brand');
  await styleName.press('Enter');
  await panel.getByTestId('style-1-colour').fill('#00ff00');
  let doc = await docOf(page);
  expect(doc.colorStyles).toEqual([
    { id: expect.any(String), name: 'Brand', paint: { r: 0, g: 1, b: 0, a: 1 } },
  ]);

  // U4: a colour variable and a number variable, a second mode with its own values.
  await panel.getByTestId('add-colour-variable').click();
  await panel.getByTestId('add-number-variable').click();
  await panel.getByLabel('Add mode').click();
  doc = await docOf(page);
  const [m1, m2] = doc.variables!.modes.map((mode) => mode.id);
  expect(doc.variables!.modes.map((mode) => mode.name)).toEqual(['Mode 1', 'Mode 2']);
  await panel.getByTestId(`variable-1-value-${m2}`).fill('#0000ff');
  const half = panel.getByLabel('Variable 2 mode 2 value');
  await half.fill('0.5');
  await half.press('Enter');
  doc = await docOf(page);
  expect(doc.variables!.items[0]!.values[m2!]).toEqual({ r: 0, g: 0, b: 1, a: 1 });
  expect(doc.variables!.items[1]!.values).toEqual({ [m1!]: 1, [m2!]: 0.5 });

  // U2: the fill's Style menu binds the rectangle to the style; the chip names it.
  const [rect] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 40, height: 40 },
    fill: RED,
    stroke: null,
  });
  await ok(page, { type: 'setSelection', ids: [rect!] });
  await expect(panel).toBeHidden();
  await page.getByTestId('fill-bind').click();
  await expect(page.getByTestId('fill-menu')).toBeVisible();
  await expectOnTop(page.getByTestId('fill-option-1'));
  await page.getByTestId('fill-option-1').click();
  await expect(page.getByTestId('fill-binding')).toHaveText('Brand');
  await expect(page.getByLabel('Fill colour', { exact: true })).toHaveCount(0);
  expect((await node(page, rect!)).bindings).toEqual({ fill: { style: doc.colorStyles![0]!.id } });

  // Then to the colour variable, and U3: opacity to the number variable.
  await page.getByTestId('fill-bind').click();
  await page.getByTestId('fill-option-2').click();
  await expect(page.getByTestId('fill-binding')).toHaveText('Color 1');
  await page.getByTestId('opacity-bind').click();
  await page.getByTestId('opacity-option-1').click();
  await expect(page.getByTestId('opacity-binding')).toHaveText('Number 1 = 1');
  expect(await exportedCentre(page)).toEqual([217, 217, 217, 255]);

  // Switching the mode recolours the rectangle on the canvas (U4 with E1).
  await ok(page, { type: 'setSelection', ids: [] });
  await panel.getByLabel('Active mode').selectOption(m2!);
  await ok(page, { type: 'setSelection', ids: [rect!] });
  expect(await node(page, rect!)).toMatchObject({ fill: { r: 0, g: 0, b: 1, a: 1 }, opacity: 0.5 });
  await expect(page.getByTestId('opacity-binding')).toHaveText('Number 1 = 0.5');
  const pixel = await exportedCentre(page);
  expect(pixel[2]).toBe(255);
  expect(pixel[3]).toBeGreaterThan(100);
  expect(pixel[3]).toBeLessThan(160);

  // Create style from the row's paint, then Detach keeps the value.
  await page.getByTestId('fill-bind').click();
  await page.getByTestId('fill-create').click();
  await expect(page.getByTestId('fill-binding')).toHaveText('Color 2');
  await page.getByTestId('fill-bind').click();
  await page.getByTestId('fill-detach').click();
  await expect(page.getByTestId('fill-binding')).toHaveCount(0);
  expect((await node(page, rect!)).bindings).toEqual({ opacity: { variable: expect.any(String) } });

  // Editing a bound value detaches it (E4): a swatch click on the fill.
  await page.getByTestId('fill-bind').click();
  await page.getByTestId('fill-option-1').click();
  await page.getByTestId('fill-swatch-ff8a00').click();
  await expect(page.getByTestId('fill-binding')).toHaveCount(0);

  // U2 on text: the text colour's Style menu.
  const [text] = await ok(page, {
    type: 'createText',
    frame: { x: 100, y: 0, width: 80, height: 20 },
    runs: [{ text: 'Styled', family: 'Inter', size: 16, color: RED }],
    sizing: 'fixed',
  });
  await ok(page, { type: 'setSelection', ids: [text!] });
  await page.getByTestId('text-colour-bind').click();
  await expectOnTop(page.getByTestId('text-colour-option-1'));
  await page.getByTestId('text-colour-option-1').click();
  await expect(page.getByTestId('text-colour-binding')).toHaveText('Brand');
  expect((await node(page, text!)).bindings).toEqual({ text: { style: expect.any(String) } });

  // Deleting the style detaches its users; the panel removes the row.
  await ok(page, { type: 'setSelection', ids: [] });
  await panel.getByLabel('Delete style 1').click();
  expect((await node(page, text!)).bindings).toBeUndefined();
  await expect(panel.getByLabel('Style 1 name')).toHaveValue('Color 2');

  // Undo restores the style and the binding.
  await ok(page, { type: 'undo' });
  expect((await node(page, text!)).bindings).toEqual({ text: { style: expect.any(String) } });

  // U3 on stroke width and corner radius: Number 1 is 0.5 in the active mode.
  const [box] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 100, width: 40, height: 40 },
    fill: RED,
    stroke: { color: RED, width: 3, cap: 'butt', join: 'miter', miterLimit: 4, dash: null },
  });
  await ok(page, { type: 'setSelection', ids: [box!] });
  await page.getByTestId('stroke-width-bind').click();
  await page.getByTestId('stroke-width-option-1').click();
  await page.getByTestId('corner-radius-bind').click();
  await expectOnTop(page.getByTestId('corner-radius-option-1'));
  await page.getByTestId('corner-radius-option-1').click();
  expect(await node(page, box!)).toMatchObject({
    stroke: { width: 0.5 },
    cornerRadii: [0.5, 0.5, 0.5, 0.5],
  });
  await expect(page.getByTestId('stroke-width-binding')).toHaveText('Number 1 = 0.5');
  // Escape closes a menu and gives focus back to its button.
  await page.getByTestId('fill-bind').click();
  await expect(page.getByTestId('fill-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('fill-menu')).toBeHidden();
  await expect(page.getByTestId('fill-bind')).toBeFocused();
  // Two rectangles bound to different targets show Mixed.
  await ok(page, { type: 'setSelection', ids: [rect!, box!] });
  await expect(page.getByTestId('opacity-binding')).toHaveText('Mixed');

  // U4: rename and delete a variable, rename and remove a mode.
  await ok(page, { type: 'setSelection', ids: [] });
  const variableName = panel.getByLabel('Variable 1 name');
  await variableName.fill('Accent');
  await variableName.press('Enter');
  const modeName = panel.getByLabel('Mode name');
  await modeName.fill('Dark');
  await modeName.press('Enter');
  doc = await docOf(page);
  expect(doc.variables!.items[0]!.name).toBe('Accent');
  expect(doc.variables!.modes.find((mode) => mode.id === m2)!.name).toBe('Dark');
  await panel.getByLabel('Remove mode').click();
  doc = await docOf(page);
  expect(doc.variables!.modes.map((mode) => mode.id)).toEqual([m1]);
  await expect(panel.getByLabel('Remove mode')).toBeDisabled();
  await panel.getByLabel('Delete variable 2').click();
  doc = await docOf(page);
  expect(doc.variables!.items.map((item) => item.name)).toEqual(['Accent']);
  expect((await node(page, box!)).bindings).toBeUndefined();
  expect(errors).toEqual([]);
});
