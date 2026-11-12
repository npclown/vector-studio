import type { Command, Editor } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';

// V-34 contract (docs/plans/viz-v34-auto-layout-contract.md), V34-A06: on the next-host studio
// page (`?test=1&layout=studio`), Shift+A on three rectangles, a gap edit in the property panel
// that reflows the row, a width edit that turns Hug into Fixed, Fill on one child, a drag reorder
// past a neighbour's centre, and undo. Runs in playwright.v34-studio.config.ts (headed Chrome and
// Edge, or the headless smoke project with M8_NEXT_HOST_CHROMIUM).

type Hook = Readonly<{ editor: Editor }>;
type Box = Readonly<{ x: number; y: number; width: number; height: number }>;
type Layout = Readonly<{ direction: string; gap: number; padding: readonly number[] }>;

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

/** The selection, and the selected frame's children, their boxes and its auto layout. */
async function read(page: Page, id?: string) {
  return page.evaluate((frameId) => {
    const snapshot = (window as unknown as { __p5Host: Hook }).__p5Host.editor.getSnapshot();
    const { document } = snapshot;
    const node = (frameId === null ? undefined : document.nodes[frameId]) as
      (Record<string, unknown> & { children?: string[]; frame: Box }) | undefined;
    const children = node?.children ?? [];
    return {
      selection: [...snapshot.selection],
      type: node?.type as string | undefined,
      frame: node?.frame,
      autoLayout: (node?.autoLayout ?? null) as Layout | null,
      layoutSizing: (node?.layoutSizing ?? null) as Record<string, string> | null,
      children: [...children],
      boxes: children.map((child) => document.nodes[child]!.frame as Box),
    };
  }, id ?? null);
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

async function commitField(page: Page, label: string, value: string) {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(value);
  await field.press('Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'false');
}

async function undo(page: Page) {
  await page.locator('[data-testid="studio-canvas"] canvas').focus();
  await page.keyboard.press('ControlOrMeta+Z');
}

/** Each child starts `gap` after the previous one ends (a horizontal row). */
function expectRow(boxes: readonly Box[], gap: number) {
  for (let i = 1; i < boxes.length; i += 1) {
    expect(boxes[i]!.x - (boxes[i - 1]!.x + boxes[i - 1]!.width)).toBeCloseTo(gap, 6);
    expect(boxes[i]!.y).toBeCloseTo(boxes[0]!.y, 6);
  }
}

test('V34-A06 auto layout: Shift+A, gap, Hug to Fixed, Fill, drag reorder and undo', async ({
  page,
}) => {
  const errors = await open(page);

  // Three 40 × 40 squares in a row, 20 apart, selected and framed in the view.
  const ids: string[] = [];
  for (const x of [0, 60, 120]) {
    const [id] = await ok(page, {
      type: 'createRectangle',
      frame: { x, y: 0, width: 40, height: 40 },
      fill: { r: 0.2, g: 0.4, b: 0.9, a: 1 },
      stroke: null,
    });
    ids.push(id!);
  }
  await ok(page, { type: 'setSelection', ids });
  await ok(page, { type: 'zoomTo', target: 'selection' });

  // Shift+A wraps them in a new hug frame with the inferred layout, which is then selected.
  await page.locator('[data-testid="studio-canvas"] canvas').focus();
  await page.keyboard.press('Shift+A');
  const wrapped = await read(page, (await read(page)).selection[0]);
  expect(wrapped.selection).toHaveLength(1);
  expect(wrapped.type).toBe('frame');
  expect(wrapped.autoLayout).toMatchObject({ direction: 'horizontal', gap: 20 });
  expect(wrapped.children).toEqual(ids);
  expect(wrapped.layoutSizing).toEqual({ horizontal: 'hug', vertical: 'hug' });
  expectRow(wrapped.boxes, 20);
  const frameId = wrapped.selection[0]!;
  await expect(page.getByTestId('auto-layout-remove')).toBeVisible();
  await expect(page.getByTestId('resizing-horizontal')).toHaveValue('hug');

  // A gap edit in the panel reflows the row and the hug frame shrinks with it.
  await commitField(page, 'Gap', '8');
  const gapped = await read(page, frameId);
  expectRow(gapped.boxes, 8);
  expect(gapped.frame!.width).toBeCloseTo(wrapped.frame!.width - 24, 6);

  // Typing a width makes the hug axis fixed (contract section 4.3, the resized set).
  await commitField(page, 'W', '300');
  await expect(page.getByTestId('resizing-horizontal')).toHaveValue('fixed');
  expect((await read(page, frameId)).frame!.width).toBeCloseTo(300, 6);

  // Fill on the middle child takes the free width; the row stays 8 apart and ends at the padding.
  await ok(page, { type: 'setSelection', ids: [ids[1]!] });
  await expect(page.getByTestId('resizing-horizontal')).toHaveValue('fixed');
  await page.getByTestId('resizing-horizontal').selectOption('fill');
  const filled = await read(page, frameId);
  const right = filled.autoLayout!.padding[1]!;
  expect(filled.boxes[1]!.width).toBeGreaterThan(40);
  expectRow(filled.boxes, 8);
  expect(filled.boxes[2]!.x + filled.boxes[2]!.width).toBeCloseTo(
    filled.frame!.x + filled.frame!.width - right,
    6,
  );

  // Dragging the first child past the last one's centre moves it to the end of `children`.
  const first = filled.boxes[0]!;
  const last = filled.boxes[2]!;
  const from = await client(page, { x: first.x + first.width / 2, y: first.y + first.height / 2 });
  const to = await client(page, { x: last.x + last.width / 2 + 10, y: last.y + last.height / 2 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, from.y, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  const dropped = await read(page, frameId);
  expect(dropped.children).toEqual([ids[1], ids[2], ids[0]]);
  expectRow(dropped.boxes, 8);

  // Undo restores the order and the positions.
  await undo(page);
  const restored = await read(page, frameId);
  expect(restored.children).toEqual(ids);
  expect(restored.boxes).toEqual(filled.boxes);
  expect(errors).toEqual([]);
});
