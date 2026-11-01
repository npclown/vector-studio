import type { Command, Editor, EditorEvent } from '@vector-studio/editor-core';
import { serializeDocument, type DocumentV6, type NodeV6 } from '@vector-studio/model';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectLayoutBudget } from '../support/m8-n3-budget.js';

// M8-U7 (MVP M8 contract, section 10): M8-A14, the next-host page composed from
// `@vector-studio/ui` (M8-N1) with real input, in headed Chrome and Edge at 1280 × 720 and
// 1280 × 900 (playwright.m8-next-host.config.ts). Every test opens the page through `open`, which
// asserts the M8-N3 layout budget against the 17a2b0a rows its config maps to; one test also
// holds a page rename open while it measures row 2. Then: focusing an Appearance field scrolls
// only the right column; the layer panel (M8-L3, L4: select, Shift and Mod toggle, expand and
// collapse, rename by Enter and by blur, hide, the four reorder buttons of M8-Q7 (a)); the page
// list (M8-L2: add, rename, switch, remove); the property panel (M8-R2 to R5: X, W and rotation,
// a line arrow, a child constraint, one invalid field, a text style over a text edit selection,
// "Create instance", "Detach instance" and "Reset text" in its group); the `ext.star` sample
// panel (M8-N2: "Create star", then its points); and under `?test=1&faults=1` the `test.ui`
// fault panels (M8-P2, P3). Every edit is checked against the document through the page's
// `?test=1` hook, each document edit as exactly one undo step.
//
// The `smoke-720` and `smoke-900` projects (M8_NEXT_HOST_CHROMIUM) run headless where the
// renderer may fail to start; they skip the renderer state and the `error` count (the panels and
// commands do not depend on the renderer). They are functional smoke runs of the spec, not
// M8-A14 evidence.

declare global {
  interface Window {
    /** The next-host page's test hook, present with `?test=1` (apps/next-host/app/page.tsx). */
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
  }
}

type Result = Readonly<{ ok: boolean; ids: readonly string[]; code: string }>;

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
const smoke = () => test.info().project.name.startsWith('smoke-');

async function open(page: Page, query = '') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?test=1${query}`);
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  if (smoke()) {
    await expect(status).not.toHaveAttribute('data-renderer', 'pending', { timeout: 30_000 });
  } else {
    await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 30_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
  }
  // M8-N3 (M8-U6): the layout budget against the 17a2b0a measurement of this project. Under
  // `?test=1&faults=1` (this spec only) M8-N2 puts each panel error on its own status line under
  // the canvas row, so those lines' height may add to the document height (the page already
  // reaches below the viewport at 1280 x 720); every other rule holds as for plain `?test=1`.
  if (query.includes('faults=1')) {
    await expect(page.getByTestId('panel-error')).not.toHaveCount(0);
    const statusLines = await page
      .getByTestId('panel-error')
      .evaluateAll((lines) =>
        lines.reduce((sum, line) => sum + line.getBoundingClientRect().height, 0),
      );
    await expectLayoutBudget(page, { statusLines });
  } else {
    await expectLayoutBudget(page);
  }
  return { errors, status };
}

/** Runs one command through the hook; it crosses the page boundary as JSON text. */
async function exec(page: Page, command: Command): Promise<Result> {
  return page.evaluate((text: string) => {
    const result = window.__p5Host!.editor.execute(JSON.parse(text) as Command);
    return result.ok
      ? { ok: true, ids: [...result.ids], code: '' }
      : { ok: false, ids: [], code: `${result.code} ${result.path ?? ''}`.trimEnd() };
  }, JSON.stringify(command));
}

/** Runs a command that must succeed and returns the IDs it created. */
async function ok(page: Page, command: Command): Promise<readonly string[]> {
  const result = await exec(page, command);
  expect(result.code, command.type).toBe('');
  return result.ids;
}

async function readDocument(page: Page): Promise<DocumentV6> {
  const text = await page.evaluate(() =>
    JSON.stringify(window.__p5Host!.editor.query({ type: 'document' })),
  );
  return JSON.parse(text) as DocumentV6;
}

async function nodeOf(page: Page, id: string): Promise<NodeV6> {
  return (await readDocument(page)).nodes[id]!;
}

async function session(page: Page) {
  return page.evaluate(() => {
    const value = window.__p5Host!.editor.getSnapshot();
    return {
      selection: [...value.selection],
      activePage: value.activePage,
      undoDepth: value.history.undoDepth,
    };
  });
}

const undoDepth = async (page: Page) => (await session(page)).undoDepth;
const selection = async (page: Page) => (await session(page)).selection;

/**
 * One UI action that commits one document edit: exactly one more undo step, after which `check`
 * runs on the document.
 */
async function step(
  page: Page,
  label: string,
  action: () => Promise<void>,
  check: (document: DocumentV6) => void,
) {
  const before = await undoDepth(page);
  await action();
  await expect.poll(() => undoDepth(page), { message: label }).toBe(before + 1);
  check(await readDocument(page));
}

/** The test IDs of the layer tree's rows, top to bottom. */
async function layerOrder(page: Page): Promise<string[]> {
  return page
    .getByTestId('layers')
    .locator('li')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid') ?? ''));
}

const activeChildren = (document: DocumentV6, page: string) =>
  document.pages.find((entry) => entry.id === page)!.children;

const textbox = (scope: Locator, name: string) => scope.getByRole('textbox', { name, exact: true });

test('M8-A14: the M8-N3 budget holds on open and with a page rename open', async ({ page }) => {
  const { errors } = await open(page);
  // Row 2's height and width while the rename textbox is open in `pages`.
  await expectLayoutBudget(page, { rename: true });
  const scroll = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth);
  expect(errors).toEqual([]);
});

test('M8-A14: focusing an Appearance field scrolls the right column, never the window', async ({
  page,
}) => {
  const { errors } = await open(page);
  const [id] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 40, y: 40, width: 200, height: 120 },
    name: 'Box',
    // A four-stop gradient fill and a stroke make the Appearance section long enough that its
    // last field starts below the column's visible box.
    fill: {
      kind: 'linear',
      transform: [1, 0, 0, 1, 0, 0],
      stops: [
        { offset: 0, color: BLACK },
        { offset: 0.25, color: WHITE },
        { offset: 0.75, color: BLACK },
        { offset: 1, color: WHITE },
      ],
      spread: 'pad',
    },
    stroke: { color: BLACK, width: 2, cap: 'butt', join: 'miter', miterLimit: 4, dash: null },
  });
  await ok(page, { type: 'setSelection', ids: [id!] });
  const column = page.getByTestId('right-column');
  const panel = page.getByRole('complementary', { name: 'Appearance' });
  // The last corner radius field starts below the column's visible box, so focusing it must
  // scroll something.
  const field = textbox(panel, 'Corner radius bottom left');
  await expect(field).toBeVisible();
  const before = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="right-column"]')!;
    const input = document.querySelector('[aria-label="Corner radius bottom left"]')!;
    return {
      scrollY: window.scrollY,
      scrollTop: element.scrollTop,
      columnBottom: element.getBoundingClientRect().bottom,
      fieldTop: input.getBoundingClientRect().top,
    };
  });
  expect(before.scrollY).toBe(0);
  expect(before.scrollTop).toBe(0);
  expect(before.fieldTop).toBeGreaterThan(before.columnBottom);
  await field.focus();
  await expect(field).toBeFocused();
  const after = await page.evaluate(() => {
    const element = document.querySelector('[data-testid="right-column"]')!;
    const input = document.querySelector('[aria-label="Corner radius bottom left"]')!;
    const box = element.getBoundingClientRect();
    const rect = input.getBoundingClientRect();
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      scrollTop: element.scrollTop,
      inside: rect.top >= box.top && rect.bottom <= box.bottom,
    };
  });
  expect(after.scrollX).toBe(0);
  expect(after.scrollY).toBe(0);
  expect(after.scrollTop).toBeGreaterThan(0);
  expect(after.inside).toBe(true);
  await expect(column).toBeVisible();
  // Focus alone sent nothing.
  expect(await undoDepth(page)).toBe(1);
  expect(errors).toEqual([]);
});

test('M8-A14: layer panel select, toggle, expand, rename, hide and reorder', async ({ page }) => {
  const { errors } = await open(page);
  const { activePage } = await session(page);
  const [a] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 20, y: 20, width: 60, height: 40 },
    name: 'A',
  });
  const [b] = await ok(page, {
    type: 'createEllipse',
    frame: { x: 120, y: 20, width: 60, height: 40 },
    name: 'B',
  });
  const [f] = await ok(page, {
    type: 'createFrame',
    frame: { x: 220, y: 20, width: 200, height: 160 },
    name: 'F',
  });
  const [c] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 10, y: 10, width: 40, height: 30 },
    name: 'C',
    parent: f!,
  });
  await ok(page, { type: 'setSelection', ids: [] });
  // Front first; the frame is collapsed by default.
  expect(await layerOrder(page)).toEqual([`layer-${f}`, `layer-${b}`, `layer-${a}`]);
  const name = (id: string) => page.getByTestId(`layer-name-${id}`);
  const row = (id: string) => page.getByTestId(`layer-${id}`);

  // Select, then Shift and Mod toggle (session commands: no undo step).
  const depth = await undoDepth(page);
  await name(a!).click();
  expect(await selection(page)).toEqual([a]);
  await expect(row(a!)).toHaveAttribute('data-selected', 'true');
  await expect(name(a!)).toHaveAttribute('aria-pressed', 'true');
  await name(b!).click({ modifiers: ['Shift'] });
  expect(await selection(page)).toEqual([a, b]);
  await name(f!).click({ modifiers: ['ControlOrMeta'] });
  expect(await selection(page)).toEqual([a, b, f]);
  await name(a!).click({ modifiers: ['ControlOrMeta'] });
  expect(await selection(page)).toEqual([b, f]);
  await expect(row(a!)).toHaveAttribute('data-selected', 'false');
  await name(b!).click({ modifiers: ['Shift'] });
  expect(await selection(page)).toEqual([f]);
  expect(await undoDepth(page)).toBe(depth);

  // Expand and collapse the frame (React state only).
  const toggle = page.getByTestId(`layer-toggle-${f}`);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(await layerOrder(page)).toEqual([`layer-${f}`, `layer-${c}`, `layer-${b}`, `layer-${a}`]);
  await expect(row(c!)).toHaveAttribute('data-depth', '1');
  await expect(row(f!)).toHaveAttribute('data-depth', '0');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(row(c!)).toHaveCount(0);
  expect(await undoDepth(page)).toBe(depth);

  // Rename by Enter, then by blur: one `setNodeProps name` each.
  const layerName = page.getByTestId('layers').getByRole('textbox', { name: 'layer name' });
  await step(
    page,
    'rename by Enter',
    async () => {
      await name(a!).dblclick();
      await expect(layerName).toBeFocused();
      await layerName.fill('Alpha');
      await layerName.press('Enter');
    },
    (document) => expect(document.nodes[a!]!.name).toBe('Alpha'),
  );
  await expect(layerName).toHaveCount(0);
  await expect(name(a!)).toHaveText('Alpha');
  await step(
    page,
    'rename by blur',
    async () => {
      await name(b!).dblclick();
      await expect(layerName).toBeFocused();
      await layerName.fill('Beta');
      await layerName.blur();
    },
    (document) => expect(document.nodes[b!]!.name).toBe('Beta'),
  );
  await expect(layerName).toHaveCount(0);
  await expect(name(b!)).toHaveText('Beta');

  // Hide and show.
  const visible = page.getByTestId(`layer-visible-${a}`);
  await expect(visible).toHaveText('hide');
  await step(
    page,
    'hide',
    () => visible.click(),
    (document) => expect(document.nodes[a!]!.visible).toBe(false),
  );
  await expect(visible).toHaveText('show');
  await step(
    page,
    'show',
    () => visible.click(),
    (document) => expect(document.nodes[a!]!.visible).toBe(true),
  );

  // Reorder the selection with the four buttons (M8-Q7 (a)); page children are back to front.
  await name(a!).click();
  expect(await selection(page)).toEqual([a]);
  const reorder = async (op: string, expected: readonly string[]) => {
    await step(
      page,
      `reorder ${op}`,
      () => page.getByTestId(`reorder-${op}`).click(),
      (document) => expect(activeChildren(document, activePage)).toEqual(expected),
    );
    expect(await layerOrder(page)).toEqual([...expected].reverse().map((id) => `layer-${id}`));
  };
  await reorder('forward', [b!, a!, f!]);
  await reorder('front', [b!, f!, a!]);
  await reorder('backward', [b!, a!, f!]);
  await reorder('back', [a!, b!, f!]);
  expect(errors).toEqual([]);
});

test('M8-A14: add, rename, switch and remove pages', async ({ page }) => {
  const { errors, status } = await open(page);
  const start = await readDocument(page);
  expect(start.pages).toHaveLength(1);
  const first = start.pages[0]!;
  const pages = page.getByTestId('pages');
  await expect(pages.getByRole('button')).toHaveCount(1);
  await expect(page.getByTestId('remove-page')).toBeDisabled();

  // Add: one `addPage` step, then the new page is active.
  await step(
    page,
    'add page',
    () => page.getByTestId('add-page').click(),
    (document) => expect(document.pages.map((entry) => entry.name)).toEqual([first.name, 'Page 2']),
  );
  const second = (await readDocument(page)).pages[1]!.id;
  expect((await session(page)).activePage).toBe(second);
  await expect(status).toHaveAttribute('data-page', second);
  await expect(pages.getByRole('button')).toHaveCount(2);
  await expect(page.getByTestId(`page-${second}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId(`page-${first.id}`)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('remove-page')).toBeEnabled();

  // Rename on Enter: one `renamePage` step.
  const pageName = pages.getByRole('textbox', { name: 'page name' });
  await step(
    page,
    'rename page',
    async () => {
      await page.getByTestId(`page-${second}`).dblclick();
      await expect(pageName).toBeFocused();
      await pageName.fill('Second');
      await pageName.press('Enter');
    },
    (document) =>
      expect(document.pages.map((entry) => [entry.id, entry.name])).toEqual([
        [first.id, first.name],
        [second, 'Second'],
      ]),
  );
  await expect(page.getByTestId(`page-${second}`)).toHaveText('Second');

  // Switch: a session command, no step.
  const depth = await undoDepth(page);
  await page.getByTestId(`page-${first.id}`).click();
  expect((await session(page)).activePage).toBe(first.id);
  await expect(page.getByTestId(`page-${first.id}`)).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId(`page-${second}`).click();
  expect((await session(page)).activePage).toBe(second);
  expect(await undoDepth(page)).toBe(depth);

  // Remove the active page: one `removePage` step.
  await step(
    page,
    'remove page',
    () => page.getByTestId('remove-page').click(),
    (document) => expect(document.pages.map((entry) => entry.id)).toEqual([first.id]),
  );
  expect((await session(page)).activePage).toBe(first.id);
  await expect(pages.getByRole('button')).toHaveCount(1);
  await expect(page.getByTestId('remove-page')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('M8-A14: transform, line arrow, child constraint and an invalid field', async ({ page }) => {
  const { errors } = await open(page);
  const panel = page.getByTestId('property-panel');
  const [r] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 40, y: 40, width: 200, height: 120 },
    name: 'R',
  });
  await ok(page, { type: 'setSelection', ids: [r!] });
  const enter = (label: string, value: string) => async () => {
    await textbox(panel, label).fill(value);
    await textbox(panel, label).press('Enter');
  };
  await step(page, 'X', enter('X', '50'), (document) => {
    expect(document.nodes[r!]!.frame).toEqual({ x: 50, y: 40, width: 200, height: 120 });
  });
  await step(page, 'W', enter('W', '180'), (document) => {
    expect(document.nodes[r!]!.frame).toEqual({ x: 50, y: 40, width: 180, height: 120 });
  });
  await step(page, 'rotation', enter('Rotation', '30'), (document) => {
    expect(document.nodes[r!]!.frame).toEqual({ x: 50, y: 40, width: 180, height: 120 });
    expect(document.nodes[r!]!.rotation).toBe((30 * Math.PI) / 180);
  });
  await expect(textbox(panel, 'X')).toHaveValue('50');
  await expect(textbox(panel, 'W')).toHaveValue('180');
  await expect(textbox(panel, 'Rotation')).toHaveValue('30');

  // One invalid field: `aria-invalid`, nothing sent (document and history unchanged).
  const before = serializeDocument(await readDocument(page));
  const depth = await undoDepth(page);
  const events = await page.evaluate(() => window.__p5Host!.events.length);
  await textbox(panel, 'W').fill('-5');
  await textbox(panel, 'W').press('Enter');
  await expect(textbox(panel, 'W')).toHaveAttribute('aria-invalid', 'true');
  expect(serializeDocument(await readDocument(page))).toBe(before);
  expect(await undoDepth(page)).toBe(depth);
  expect(await page.evaluate(() => window.__p5Host!.events.length)).toBe(events);
  await expect(page.getByTestId('property-refusal')).toHaveCount(0);

  // A line's end arrow: one `setNodeProps endArrow`.
  const [line] = await ok(page, {
    type: 'createLine',
    start: { x: 300, y: 300 },
    end: { x: 420, y: 300 },
    name: 'L',
  });
  await ok(page, { type: 'setSelection', ids: [line!] });
  const endArrow = panel.getByRole('combobox', { name: 'End arrow', exact: true });
  await expect(endArrow).toHaveValue('none');
  await step(
    page,
    'end arrow',
    async () => {
      await endArrow.selectOption('triangle');
    },
    (document) => {
      const node = document.nodes[line!] as Extract<NodeV6, { type: 'line' }>;
      expect([node.startArrow, node.endArrow]).toEqual(['none', 'triangle']);
    },
  );

  // A child of a frame: its horizontal constraint, one `setNodeProps constraints`.
  const [frame] = await ok(page, {
    type: 'createFrame',
    frame: { x: 500, y: 40, width: 200, height: 160 },
    name: 'Holder',
  });
  const [child] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 10, y: 10, width: 40, height: 30 },
    name: 'Child',
    parent: frame!,
  });
  await ok(page, { type: 'setSelection', ids: [child!] });
  const original = (await nodeOf(page, child!)).constraints;
  expect(original).toEqual({ horizontal: 'start', vertical: 'start' });
  const horizontal = panel.getByRole('combobox', { name: 'Horizontal constraint', exact: true });
  await expect(horizontal).toHaveValue('start');
  await step(
    page,
    'constraint',
    async () => {
      await horizontal.selectOption('center');
    },
    (document) =>
      expect(document.nodes[child!]!.constraints).toEqual({
        horizontal: 'center',
        vertical: 'start',
      }),
  );
  // A child of the page has no constraint section.
  await ok(page, { type: 'setSelection', ids: [r!] });
  await expect(horizontal).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('M8-A14: a text style over a text edit selection', async ({ page }) => {
  // M8-R4 with M6b-H2: the run fields belong to the canvas's text edit focus target, so focusing
  // one keeps the text edit selection; leaving it for another control exits edit mode.
  const { errors } = await open(page);
  const panel = page.getByTestId('property-panel');
  const [t] = await ok(page, {
    type: 'createText',
    frame: { x: 40, y: 40, width: 200, height: 40 },
    runs: [{ text: 'Hello', family: 'sans-serif', size: 16, color: BLACK }],
  });
  await ok(page, { type: 'setSelection', ids: [t!] });
  // Offsets 1 to 3 ("el") selected in text edit mode.
  await ok(page, { type: 'enterTextEdit', id: t!, anchor: 1, focus: 3 });
  const size = textbox(panel, 'Font size');
  await expect(size).toBeEnabled();
  await expect(size).toHaveValue('16');
  await step(
    page,
    'font size over the selection',
    async () => {
      await size.focus();
      // The selection must survive the focus move for the style to cover it alone.
      const textEdit = await page.evaluate(() =>
        JSON.stringify(window.__p5Host!.editor.getSnapshot().textEdit),
      );
      expect(textEdit, 'text edit state after focusing the field').not.toBe('null');
      await size.fill('24');
      await size.press('Enter');
    },
    (document) => {
      const node = document.nodes[t!] as Extract<NodeV6, { type: 'text' }>;
      expect(node.runs).toEqual([
        { text: 'H', family: 'sans-serif', size: 16, color: BLACK },
        { text: 'el', family: 'sans-serif', size: 24, color: BLACK },
        { text: 'lo', family: 'sans-serif', size: 16, color: BLACK },
      ]);
    },
  );
  const textEditOf = () =>
    page.evaluate(() => JSON.stringify(window.__p5Host!.editor.getSnapshot().textEdit));
  expect(await textEditOf(), 'text edit state after the commit').not.toBe('null');
  // Leaving the run field for a field outside the text edit focus target exits edit mode.
  await textbox(panel, 'Letter spacing').focus();
  expect(await textEditOf(), 'text edit state after leaving the run fields').toBe('null');
  expect(errors).toEqual([]);
});

test('M8-A14: Create instance, Reset text in its group and Detach instance', async ({ page }) => {
  const { errors } = await open(page);
  const panel = page.getByTestId('property-panel');
  const run = (text: string) => ({ text, family: 'sans-serif', size: 16, color: BLACK });
  // A source with two text nodes, an instance, and an override on each text node.
  const [title] = await ok(page, {
    type: 'createText',
    frame: { x: 40, y: 40, width: 120, height: 30 },
    runs: [run('Title')],
  });
  const [body] = await ok(page, {
    type: 'createText',
    frame: { x: 40, y: 80, width: 120, height: 30 },
    runs: [run('Body')],
  });
  await ok(page, { type: 'setNodeProps', id: title!, props: { name: 'Title text' } });
  await ok(page, { type: 'setNodeProps', id: body!, props: { name: 'Body text' } });
  const [symbol] = await ok(page, { type: 'createSymbol', ids: [title!, body!] });
  expect((await nodeOf(page, symbol!)).type).toBe('symbol');
  await ok(page, { type: 'setSelection', ids: [symbol!] });

  // "Create instance": one `createInstance`, the new instance then selected.
  const create = panel.getByRole('button', { name: 'Create instance', exact: true });
  await expect(create).toHaveCount(1);
  const before = Object.keys((await readDocument(page)).nodes);
  await step(
    page,
    'create instance',
    () => create.click(),
    (document) => {
      const added = Object.keys(document.nodes).filter((id) => !before.includes(id));
      expect(added).toHaveLength(1);
      const node = document.nodes[added[0]!]!;
      expect(node.type).toBe('instance');
      expect((node as Extract<NodeV6, { type: 'instance' }>).symbol).toBe(symbol);
    },
  );
  const [instance] = await selection(page);
  expect((await nodeOf(page, instance!)).type).toBe('instance');
  await ok(page, { type: 'setInstanceText', id: instance!, node: title!, runs: [run('T2')] });
  await ok(page, { type: 'setInstanceText', id: instance!, node: body!, runs: [run('B2')] });
  const overrides = async () =>
    Object.keys(
      ((await nodeOf(page, instance!)) as Extract<NodeV6, { type: 'instance' }>).textOverrides,
    ).sort();
  expect(await overrides()).toEqual([title!, body!].sort());

  // "Reset text", grouped by the source text node's name: narrow to one group.
  const resets = panel.getByRole('button', { name: 'Reset text', exact: true });
  await expect(resets).toHaveCount(2);
  const bodyGroup = panel.getByRole('group', { name: 'Body text', exact: true });
  await expect(bodyGroup.getByRole('button', { name: 'Reset text', exact: true })).toHaveCount(1);
  await step(
    page,
    'reset text',
    () => bodyGroup.getByRole('button', { name: 'Reset text', exact: true }).click(),
    (document) =>
      expect(
        (document.nodes[instance!] as Extract<NodeV6, { type: 'instance' }>).textOverrides,
      ).toEqual({ [title!]: { runs: [run('T2')] } }),
  );
  await expect(resets).toHaveCount(1);
  await expect(bodyGroup).toHaveCount(0);
  await expect(panel.getByRole('group', { name: 'Title text', exact: true })).toHaveCount(1);

  // "Detach instance": one `detachInstances`, the node becomes a frame.
  const detach = panel.getByRole('button', { name: 'Detach instance', exact: true });
  await expect(detach).toHaveCount(1);
  await step(
    page,
    'detach instance',
    () => detach.click(),
    (document) => {
      // M7: the instance becomes a frame holding a copy of the source's content, with the kept
      // override applied to its copy of `Title text`.
      const node = document.nodes[instance!] as Extract<NodeV6, { type: 'frame' }>;
      expect(node.type).toBe('frame');
      const copies = node.children.map(
        (id) => document.nodes[id] as Extract<NodeV6, { type: 'text' }>,
      );
      expect(
        copies.map((copy) => [copy.type, copy.name, copy.runs.map((r) => r.text).join('')]),
      ).toEqual([
        ['text', 'Title text', 'T2'],
        ['text', 'Body text', 'Body'],
      ]);
    },
  );
  await expect(detach).toHaveCount(0);
  // The section's buttons carry no test ID; the toolbar's stay unique (M8-R5).
  await expect(page.getByTestId('create-instance')).toHaveCount(1);
  await expect(page.getByTestId('detach')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('M8-A14: Create star and its points from the ext.star panel', async ({ page }) => {
  const { errors } = await open(page);
  const panel = page.locator('section[data-panel="ext.star"]');
  await expect(panel).toHaveCount(1);
  await expect(panel.getByText('select one star')).toBeVisible();
  const before = Object.keys((await readDocument(page)).nodes);
  await step(
    page,
    'create star',
    () => panel.getByRole('button', { name: 'Create star', exact: true }).click(),
    (document) => {
      const added = Object.keys(document.nodes).filter((id) => !before.includes(id));
      expect(added).toHaveLength(1);
      const node = document.nodes[added[0]!]! as Extract<NodeV6, { type: 'custom' }>;
      expect([node.type, node.customType, node.name, node.data]).toEqual([
        'custom',
        'ext.star',
        'Star',
        { points: 5, innerRatio: 0.5 },
      ]);
      expect(node.frame).toEqual({ x: 120, y: 120, width: 120, height: 120 });
    },
  );
  const [star] = await selection(page);
  const points = panel.getByRole('textbox', { name: 'Points', exact: true });
  await expect(points).toHaveValue('5');
  await step(
    page,
    'points',
    async () => {
      await points.fill('8');
      await points.press('Enter');
    },
    (document) =>
      expect((document.nodes[star!] as Extract<NodeV6, { type: 'custom' }>).data).toEqual({
        points: 8,
        innerRatio: 0.5,
      }),
  );
  await expect(points).toHaveValue('8');
  // Points the extension would refuse: marked, nothing sent.
  const depth = await undoDepth(page);
  await points.fill('2');
  await points.press('Enter');
  await expect(points).toHaveAttribute('aria-invalid', 'true');
  expect(await undoDepth(page)).toBe(depth);
  expect((await nodeOf(page, star!)).type === 'custom').toBe(true);
  expect(((await nodeOf(page, star!)) as Extract<NodeV6, { type: 'custom' }>).data).toEqual({
    points: 8,
    innerRatio: 0.5,
  });
  expect(errors).toEqual([]);
});

test('M8-A14: under ?test=1&faults=1 a throwing panel fails alone and the unowned panel is reported', async ({
  page,
}) => {
  const { errors } = await open(page, '&faults=1');
  // The unowned panel is rejected: not rendered, its code in the status's `panel-error`.
  await expect(page.locator('section[data-panel="other.unowned"]')).toHaveCount(0);
  const panelErrors = page.getByTestId('panel-error');
  await expect(panelErrors).toHaveCount(1);
  await expect(panelErrors).toHaveAttribute('data-code', 'ui.unowned-panel');
  await expect(panelErrors).toHaveAttribute('data-panel', 'other.unowned');
  await expect(panelErrors).toHaveText('ui.unowned-panel other.unowned');
  // A smoke run may show a renderer error (no kernel or adapter); `open` checks the headed ones.
  if (!smoke()) await expect(page.getByTestId('error')).toHaveCount(0);

  // The throwing panel fails after its button press; its boundary shows `ui.panel-failed`.
  const throwing = page.locator('section[data-panel="test.ui.throws"]');
  await expect(throwing).toHaveCount(1);
  await throwing.getByRole('button', { name: 'Throw', exact: true }).click();
  await expect(throwing.getByRole('alert')).toHaveText('ui.panel-failed');
  await expect(throwing.getByRole('button', { name: 'Throw', exact: true })).toHaveCount(0);
  await expect(panelErrors).toHaveCount(2);
  // The failed panel keeps the layout budget, with the second status line allowed.
  await expectLayoutBudget(page, {
    statusLines: await panelErrors.evaluateAll((lines) =>
      lines.reduce((sum, line) => sum + line.getBoundingClientRect().height, 0),
    ),
  });
  await expect(panelErrors.nth(0)).toHaveAttribute('data-code', 'ui.unowned-panel');
  await expect(panelErrors.nth(1)).toHaveAttribute('data-code', 'ui.panel-failed');
  await expect(panelErrors.nth(1)).toHaveAttribute('data-panel', 'test.ui.throws');
  // A smoke run may show a renderer error (no kernel or adapter); `open` checks the headed ones.
  if (!smoke()) await expect(page.getByTestId('error')).toHaveCount(0);

  // The other panels and the editor keep working: the star panel creates a star.
  const star = page.locator('section[data-panel="ext.star"]');
  const before = await undoDepth(page);
  await star.getByRole('button', { name: 'Create star', exact: true }).click();
  await expect.poll(() => undoDepth(page)).toBe(before + 1);
  const [id] = await selection(page);
  await expect(star.getByRole('textbox', { name: 'Points', exact: true })).toHaveValue('5');
  // The layer panel and the property panel too.
  await expect(page.getByTestId(`layer-${id}`)).toHaveCount(1);
  const panel = page.getByTestId('property-panel');
  await step(
    page,
    'X after the failure',
    async () => {
      await textbox(panel, 'X').fill('130');
      await textbox(panel, 'X').press('Enter');
    },
    (document) =>
      expect(document.nodes[id!]!.frame).toEqual({ x: 130, y: 120, width: 120, height: 120 }),
  );
  // React reports the caught render error to the console, not as a page error.
  expect(errors).toEqual([]);
});
