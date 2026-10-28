import type { Editor, EditorEvent, PathEditOverlay } from '@vector-studio/editor-core';
import { validateDocument, type DocumentV2, type NodeV2 } from '@vector-studio/model';
import { expect, test, type Page } from '@playwright/test';

// M3-U4 (MVP M3 contract, section 6): M3-A12, the next-host page's path edit mode on the
// `?fixture=path-edit` document through EditorCanvas with real input in headed Chrome and Edge.
// The closed cubic path `closed` is entered by double-click, then an anchor is dragged, a handle
// dragged mirrored and with Alt, an anchor inserted by double-click on a segment and one deleted
// with Delete, the path opened with the toggle-closed button and edit mode left with Escape. The
// open path `open` inside the rotated group `g1` is entered with Enter (into the group, then into
// the path), an anchor nudged with an arrow key, an anchor inserted by double-click on a line, an
// end removed, the path closed with the button and edit mode left by a click outside. After each
// step and after its undo (and redo) the serialized document is checked, as is the absence of an
// `editor.scene-rejected` diagnostic and the overlay markers against the `pathOverlay` query.
// Snapping is turned off so the dragged anchor lands where the pointer does (it is M3-A10's,
// unit tested). Results are read through the page's `?test=1` hook, as in M1-A12 and M2-A13.
//
// The `chromium-smoke` project (M3_NEXT_HOST_CHROMIUM, playwright.m3-next-host.config.ts) runs
// headless where the renderer may fail to start: a kernel rejection cannot show there, and input
// does not depend on it. It is a functional smoke run of the spec, not M3-A12 evidence.

declare global {
  interface Window {
    /** The next-host page's test hook, present with `?test=1` (apps/next-host/app/page.tsx). */
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
  }
}

type Point = Readonly<{ x: number; y: number }>;
type PathNode = Extract<NodeV2, { type: 'path' }>;

/** Page coordinates within the M1-A05 placement bound for this fixture's range (< 10^3). */
const NEAR = 1e-6;
/** The empty canvas, outside both paths and the group. */
const EMPTY = { x: 880, y: 560 };
/** Inside `closed`'s fill, away from its outline. */
const CLOSED_FILL = { x: 208, y: 248 };

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&fixture=path-edit');
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  await expect(status).toHaveAttribute('data-fixture', 'loaded', { timeout: 30_000 });
  if (test.info().project.name === 'chromium-smoke') {
    await expect(status).not.toHaveAttribute('data-renderer', 'pending', { timeout: 30_000 });
  } else {
    await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 30_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
  }
  // The editor's own state at load: the fixture camera, no history and no edit mode.
  expect(await page.evaluate(() => window.__p5Host!.editor.getSnapshot().viewport)).toEqual({
    position: { x: 0, y: 0 },
    zoom: 1,
  });
  await page.evaluate(() =>
    window.__p5Host!.editor.execute({ type: 'setSnapping', enabled: false }),
  );
  /** A page point on screen with the current camera and canvas content box, read at call time. */
  const screen = async (p: Point): Promise<Point> => {
    const { origin, position, zoom } = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      const rect = canvas.getBoundingClientRect();
      return {
        origin: { x: rect.left + canvas.clientLeft, y: rect.top + canvas.clientTop },
        ...window.__p5Host!.editor.query({ type: 'viewport' }),
      };
    });
    return { x: origin.x + (p.x - position.x) * zoom, y: origin.y + (p.y - position.y) * zoom };
  };
  return { errors, screen };
}

async function documentText(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify(window.__p5Host!.editor.query({ type: 'document' })));
}

async function overlayOf(page: Page): Promise<PathEditOverlay | null> {
  return page.evaluate(() => window.__p5Host!.editor.query({ type: 'pathOverlay' }));
}

async function anchorsOf(page: Page): Promise<PathEditOverlay['subpaths'][number]['anchors']> {
  const overlay = await overlayOf(page);
  expect(overlay).not.toBeNull();
  return overlay!.subpaths[0]!.anchors;
}

async function session(page: Page) {
  return page.evaluate(() => {
    const value = window.__p5Host!.editor.getSnapshot();
    return {
      selection: [...value.selection],
      scope: value.scope,
      pathEdit: value.pathEdit,
      undoDepth: value.history.undoDepth,
    };
  });
}

function pathNode(text: string, id: string): PathNode {
  const node = (JSON.parse(text) as DocumentV2).nodes[id];
  expect(node?.type).toBe('path');
  return node as PathNode;
}

function expectNear(actual: Point, expected: Point, label: string) {
  expect(Math.abs(actual.x - expected.x), `${label} x`).toBeLessThanOrEqual(NEAR);
  expect(Math.abs(actual.y - expected.y), `${label} y`).toBeLessThanOrEqual(NEAR);
}

/**
 * The overlay markers drawn on the page against `pathOverlay` at the current camera: one anchor
 * marker per overlay anchor and one handle marker per visible handle, at css = (page − position)
 * · zoom exactly, with the overlay's `selected` and `mirrored` flags. Polled, since React draws
 * after the input that changed the editor.
 */
async function expectMarkers(page: Page) {
  const read = () =>
    page.evaluate(() => {
      const { editor } = window.__p5Host!;
      const overlay = editor.query({ type: 'pathOverlay' });
      const { position, zoom } = editor.getSnapshot().viewport;
      const css = (p: { x: number; y: number }) => ({
        x: (p.x - position.x) * zoom,
        y: (p.y - position.y) * zoom,
      });
      const expected = {
        path: overlay?.id ?? null,
        anchors: [] as unknown[],
        handles: [] as unknown[],
      };
      overlay?.subpaths.forEach((subpath, s) =>
        subpath.anchors.forEach((anchor, a) => {
          expected.anchors.push({
            subpath: s,
            anchor: a,
            ...css(anchor.point),
            selected: anchor.selected,
            mirrored: anchor.mirrored,
          });
          for (const side of ['in', 'out'] as const) {
            const handle = anchor[side];
            if (handle !== null)
              expected.handles.push({ subpath: s, anchor: a, side, ...css(handle) });
          }
        }),
      );
      const all = (selector: string) => [...document.querySelectorAll<SVGElement>(selector)];
      const group = all('[data-testid="path-edit"]');
      const drawn = {
        path: group.length === 1 ? (group[0]!.dataset.path ?? '') : group.length === 0 ? null : '*',
        anchors: all('[data-testid="path-anchor"]').map((element) => ({
          subpath: Number(element.dataset.subpath),
          anchor: Number(element.dataset.anchor),
          x: Number(element.dataset.x),
          y: Number(element.dataset.y),
          selected: element.dataset.selected === 'true',
          mirrored: element.dataset.mirrored === 'true',
        })),
        handles: all('[data-testid="path-handle"]').map((element) => ({
          subpath: Number(element.dataset.subpath),
          anchor: Number(element.dataset.anchor),
          side: element.dataset.side,
          x: Number(element.dataset.x),
          y: Number(element.dataset.y),
        })),
      };
      return { expected, drawn };
    });
  await expect
    .poll(async () => {
      const { expected, drawn } = await read();
      return JSON.stringify(drawn) === JSON.stringify(expected);
    })
    .toBe(true);
}

/** No `editor.scene-rejected` diagnostic so far, and no page error. */
async function expectClean(page: Page, errors: readonly string[], label: string) {
  const rejected = await page.evaluate(() =>
    window.__p5Host!.events.filter(
      (event) => event.type === 'diagnostic' && event.code === 'editor.scene-rejected',
    ),
  );
  expect(rejected, label).toEqual([]);
  expect(errors, label).toEqual([]);
}

/** Presses a chord on the canvas (Mod is Ctrl, or Meta on macOS). */
async function press(page: Page, chord: string) {
  await page.locator('canvas').focus();
  await page.keyboard.press(chord.replace('Mod', 'ControlOrMeta'));
}

async function click(page: Page, at: Point, modifiers: ('Shift' | 'Alt')[] = []) {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click(at.x, at.y);
  for (const key of modifiers) await page.keyboard.up(key);
}

async function drag(page: Page, from: Point, to: Point, modifiers: 'Alt'[] = []) {
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  for (const key of modifiers) await page.keyboard.up(key);
}

/** Moves the pointer away so the next click is not taken as part of a double-click. */
async function settle(page: Page) {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(600);
}

/**
 * One undoable step: runs it, expects one new undo step and a valid serialized document that
 * `verify` accepts, then undoes it (Mod+Z) to the exact text before and redoes it (Mod+Shift+Z)
 * to the exact text after, checking the markers and diagnostics after each.
 */
async function step(
  page: Page,
  errors: readonly string[],
  label: string,
  run: () => Promise<void>,
  verify: (before: string, after: string) => void | Promise<void>,
) {
  const before = await documentText(page);
  const depth = (await session(page)).undoDepth;
  await run();
  const after = await documentText(page);
  expect(after, `${label}: the document changed`).not.toBe(before);
  expect((await session(page)).undoDepth, `${label}: one undo step`).toBe(depth + 1);
  const parsed = validateDocument(JSON.parse(after));
  expect(parsed.ok, `${label}: valid document`).toBe(true);
  await verify(before, after);
  await expectMarkers(page);
  await expectClean(page, errors, label);
  await press(page, 'Mod+Z');
  expect(await documentText(page), `${label}: undo`).toBe(before);
  await expectMarkers(page);
  await expectClean(page, errors, `${label} undo`);
  await press(page, 'Mod+Shift+Z');
  expect(await documentText(page), `${label}: redo`).toBe(after);
  await expectMarkers(page);
  await expectClean(page, errors, `${label} redo`);
  await settle(page);
}

/** A session-only change: the document text and history stay as they were. */
async function unchanged(page: Page, run: () => Promise<void>) {
  const before = await documentText(page);
  const depth = (await session(page)).undoDepth;
  await run();
  expect(await documentText(page)).toBe(before);
  expect((await session(page)).undoDepth).toBe(depth);
}

/** Every node except `id` is byte-identical between the two texts. */
function othersKept(before: string, after: string, id: string) {
  const a = JSON.parse(before) as DocumentV2;
  const b = JSON.parse(after) as DocumentV2;
  const rest = (document: DocumentV2, skip: readonly string[]) =>
    Object.fromEntries(Object.entries(document.nodes).filter(([key]) => !skip.includes(key)));
  // A path inside a group refits the group (M1 section 4.2), so the group may change with it.
  const skip = b.nodes[id]?.parent === 'g1' ? [id, 'g1'] : [id];
  expect(rest(b, skip)).toEqual(rest(a, skip));
  expect(b.pages).toEqual(a.pages);
}

type Matrix = readonly [number, number, number, number, number, number];

/** A node's node-local to page transform of schema v2: rotation about each frame centre. */
function nodeToPage(document: DocumentV2, id: string): Matrix {
  const local = (node: NodeV2): Matrix => {
    const { x, y, width, height } = node.frame;
    const cos = Math.cos(node.rotation);
    const sin = Math.sin(node.rotation);
    const hw = width / 2;
    const hh = height / 2;
    return [cos, sin, -sin, cos, x + hw - (hw * cos - hh * sin), y + hh - (hw * sin + hh * cos)];
  };
  const multiply = (m: Matrix, n: Matrix): Matrix => [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  let node = document.nodes[id]!;
  let matrix = local(node);
  while (document.nodes[node.parent] !== undefined) {
    node = document.nodes[node.parent]!;
    matrix = multiply(local(node), matrix);
  }
  return matrix;
}

test('M3-A12: edits a closed cubic path and an open path in a rotated group', async ({ page }) => {
  const { errors, screen } = await open(page);
  const toggle = page.getByTestId('toggle-closed');
  await expectMarkers(page);
  await expect(toggle).toBeDisabled();

  // --- The closed cubic path `closed` (page root, explicit closing form, all anchors mirrored).

  // Enter by double-click on its fill.
  await unchanged(page, async () => {
    const at = await screen(CLOSED_FILL);
    await page.mouse.dblclick(at.x, at.y);
  });
  expect(await session(page)).toMatchObject({
    selection: ['closed'],
    pathEdit: { id: 'closed', anchors: [] },
  });
  await expectMarkers(page);
  await expect(page.getByTestId('path-anchor')).toHaveCount(4);
  await expectClean(page, errors, 'enter by double-click');
  await settle(page);

  // Drag anchor 0 from (208, 120) by (16, −16); its handles follow, the others stay.
  const start = (await anchorsOf(page)).map((anchor) => anchor.point);
  await step(
    page,
    errors,
    'anchor drag',
    async () => drag(page, await screen({ x: 208, y: 120 }), await screen({ x: 224, y: 104 })),
    async (before, after) => {
      othersKept(before, after, 'closed');
      expect(pathNode(after, 'closed').path.verbs).toEqual(pathNode(before, 'closed').path.verbs);
      const anchors = await anchorsOf(page);
      expectNear(anchors[0]!.point, { x: 224, y: 104 }, 'anchor 0');
      expectNear(anchors[0]!.in!, { x: 160, y: 104 }, 'anchor 0 in');
      expectNear(anchors[0]!.out!, { x: 288, y: 104 }, 'anchor 0 out');
      for (const index of [1, 2, 3]) expectNear(anchors[index]!.point, start[index]!, `${index}`);
      expect((await session(page)).pathEdit!.anchors).toEqual([{ subpath: 0, anchor: 0 }]);
    },
  );

  // Drag anchor 0's out handle by (0, 32): it was mirrored, so its in handle moves opposite.
  expect((await session(page)).pathEdit!.anchors).toEqual([{ subpath: 0, anchor: 0 }]);
  await step(
    page,
    errors,
    'mirrored handle drag',
    async () => drag(page, await screen({ x: 288, y: 104 }), await screen({ x: 288, y: 136 })),
    async (before, after) => {
      othersKept(before, after, 'closed');
      const [anchor] = await anchorsOf(page);
      expectNear(anchor!.point, { x: 224, y: 104 }, 'anchor 0');
      expectNear(anchor!.out!, { x: 288, y: 136 }, 'out');
      expectNear(anchor!.in!, { x: 160, y: 72 }, 'in');
      expect(anchor!.mirrored).toBe(true);
    },
  );

  // Alt-drag the in handle by (−16, 0): only it moves, and the anchor is no longer mirrored.
  await step(
    page,
    errors,
    'Alt handle drag',
    async () =>
      drag(page, await screen({ x: 160, y: 72 }), await screen({ x: 144, y: 72 }), ['Alt']),
    async (before, after) => {
      othersKept(before, after, 'closed');
      const [anchor] = await anchorsOf(page);
      expectNear(anchor!.in!, { x: 144, y: 72 }, 'in');
      expectNear(anchor!.out!, { x: 288, y: 136 }, 'out');
      expect(anchor!.mirrored).toBe(false);
    },
  );

  // Insert by double-click on segment 1, the cubic from anchor 1 to anchor 2, at its t = 0.5
  // point (296, 336): five anchors, the new one is anchor 2 there and is selected.
  await step(
    page,
    errors,
    'segment double-click',
    async () => {
      const at = await screen({ x: 296, y: 336 });
      await page.mouse.dblclick(at.x, at.y);
    },
    async (before, after) => {
      othersKept(before, after, 'closed');
      expect(pathNode(after, 'closed').path.verbs).toEqual([
        'move',
        'cubic',
        'cubic',
        'cubic',
        'cubic',
        'cubic',
        'close',
      ]);
      const anchors = await anchorsOf(page);
      expect(anchors).toHaveLength(5);
      // Within the 0.25 px flattening bound of the pointer's t (M3-Q12).
      expect(Math.hypot(anchors[2]!.point.x - 296, anchors[2]!.point.y - 336)).toBeLessThan(0.5);
      expect((await session(page)).pathEdit!.anchors).toEqual([{ subpath: 0, anchor: 2 }]);
    },
  );

  // Delete anchor 3 (the former anchor 2 at (208, 376)): four anchors remain.
  await step(
    page,
    errors,
    'Delete',
    async () => {
      const anchors = await anchorsOf(page);
      await click(page, await screen(anchors[3]!.point));
      expect((await session(page)).pathEdit!.anchors).toEqual([{ subpath: 0, anchor: 3 }]);
      await press(page, 'Delete');
    },
    async (before, after) => {
      othersKept(before, after, 'closed');
      const anchors = await anchorsOf(page);
      expect(anchors).toHaveLength(4);
      expect(anchors.some((a) => Math.hypot(a.point.x - 208, a.point.y - 376) < 1)).toBe(false);
      expect(pathNode(after, 'closed').path.verbs.at(-1)).toBe('close');
    },
  );

  // Open it with the toggle-closed button at segment 1, whose two ends are selected: the open
  // path starts at anchor 2 and keeps the other segments.
  await expect(toggle).toBeDisabled();
  const closedAnchors = (await anchorsOf(page)).map((anchor) => anchor.point);
  await click(page, await screen(closedAnchors[1]!));
  await click(page, await screen(closedAnchors[2]!), ['Shift']);
  expect((await session(page)).pathEdit!.anchors).toEqual([
    { subpath: 0, anchor: 1 },
    { subpath: 0, anchor: 2 },
  ]);
  await expect(toggle).toBeEnabled();
  await step(
    page,
    errors,
    'toggle closed (open)',
    async () => toggle.click(),
    async (before, after) => {
      othersKept(before, after, 'closed');
      expect(pathNode(after, 'closed').path.verbs).not.toContain('close');
      const overlay = (await overlayOf(page))!;
      expect(overlay.subpaths.map((subpath) => subpath.closed)).toEqual([false]);
      const order = [2, 3, 0, 1].map((index) => closedAnchors[index]!);
      overlay.subpaths[0]!.anchors.forEach((anchor, index) =>
        expectNear(anchor.point, order[index]!, `opened anchor ${index}`),
      );
    },
  );

  // Exit by Escape: the path stays selected and no markers remain.
  await unchanged(page, () => press(page, 'Escape'));
  expect(await session(page)).toMatchObject({ selection: ['closed'], pathEdit: null });
  await expectMarkers(page);
  await expect(page.getByTestId('path-anchor')).toHaveCount(0);
  await expect(toggle).toBeDisabled();
  await expectClean(page, errors, 'exit by Escape');
  await settle(page);

  // --- The open path `open` inside the rotated group `g1`.

  // Its anchor 1 on the page, from the stored document (no edit mode yet).
  const document = JSON.parse(await documentText(page)) as DocumentV2;
  const openNode = pathNode(JSON.stringify(document), 'open');
  const m = nodeToPage(document, 'open');
  const unit = (index: number): Point => {
    const x = openNode.path.points[2 * index]! * openNode.frame.width;
    const y = openNode.path.points[2 * index + 1]! * openNode.frame.height;
    return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
  };

  // Enter by Enter: a click selects the group, Enter enters it and selects the path, and Enter
  // on the single selected path enters edit mode.
  await unchanged(page, async () => {
    await click(page, await screen(unit(1)));
    expect((await session(page)).selection).toEqual(['g1']);
    await press(page, 'Enter');
    expect(await session(page)).toMatchObject({ scope: 'g1', selection: ['open'] });
    await press(page, 'Enter');
  });
  expect(await session(page)).toMatchObject({
    scope: 'g1',
    selection: ['open'],
    pathEdit: { id: 'open', anchors: [] },
  });
  await expectMarkers(page);
  await expect(page.getByTestId('path-anchor')).toHaveCount(4);
  const openStart = (await anchorsOf(page)).map((anchor) => anchor.point);
  for (const [index, point] of openStart.entries()) expectNear(point, unit(index), `${index}`);
  await expectClean(page, errors, 'enter by Enter');
  await settle(page);

  // Nudge anchor 1 by one page unit right: the page vector maps into the rotated frame.
  await click(page, await screen(openStart[1]!));
  expect((await session(page)).pathEdit!.anchors).toEqual([{ subpath: 0, anchor: 1 }]);
  await step(
    page,
    errors,
    'nudge',
    async () => press(page, 'ArrowRight'),
    async (before, after) => {
      othersKept(before, after, 'open');
      expect(pathNode(after, 'open').path.verbs).toEqual(['move', 'line', 'line', 'line']);
      const anchors = await anchorsOf(page);
      expectNear(anchors[1]!.point, { x: openStart[1]!.x + 1, y: openStart[1]!.y }, 'anchor 1');
      for (const index of [0, 2, 3]) {
        expectNear(anchors[index]!.point, openStart[index]!, `anchor ${index}`);
      }
    },
  );

  // Insert on the line from anchor 1 to anchor 2 by double-click at its middle.
  const nudged = (await anchorsOf(page)).map((anchor) => anchor.point);
  const middle = { x: (nudged[1]!.x + nudged[2]!.x) / 2, y: (nudged[1]!.y + nudged[2]!.y) / 2 };
  await step(
    page,
    errors,
    'line double-click',
    async () => {
      const at = await screen(middle);
      await page.mouse.dblclick(at.x, at.y);
    },
    async (before, after) => {
      othersKept(before, after, 'open');
      expect(pathNode(after, 'open').path.verbs).toEqual(['move', 'line', 'line', 'line', 'line']);
      const anchors = await anchorsOf(page);
      expect(anchors).toHaveLength(5);
      // On a line t = σ exactly, so the new anchor lies on the old line; the browser delivers
      // the pointer in whole CSS pixels, so it is within a pixel diagonal of the middle.
      const [p, q, r] = [nudged[1]!, anchors[2]!.point, nudged[2]!];
      const cross = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
      expect(Math.abs(cross) / Math.hypot(r.x - p.x, r.y - p.y)).toBeLessThanOrEqual(NEAR);
      expect(Math.hypot(q.x - middle.x, q.y - middle.y)).toBeLessThan(Math.SQRT2);
      // The old anchors keep their places, after the new anchor 2.
      [0, 1, 3, 4].forEach((index, old) =>
        expectNear(anchors[index]!.point, nudged[old]!, `anchor ${index}`),
      );
      expect((await session(page)).pathEdit!.anchors).toEqual([{ subpath: 0, anchor: 2 }]);
    },
  );

  // Remove an end: anchor 0, by Delete; the former anchor 1 is the new start.
  const inserted = (await anchorsOf(page)).map((anchor) => anchor.point);
  await step(
    page,
    errors,
    'remove an end',
    async () => {
      await click(page, await screen(inserted[0]!));
      expect((await session(page)).pathEdit!.anchors).toEqual([{ subpath: 0, anchor: 0 }]);
      await press(page, 'Delete');
    },
    async (before, after) => {
      othersKept(before, after, 'open');
      expect(pathNode(after, 'open').path.verbs).toEqual(['move', 'line', 'line', 'line']);
      const anchors = await anchorsOf(page);
      expect(anchors).toHaveLength(4);
      anchors.forEach((anchor, index) =>
        expectNear(anchor.point, inserted[index + 1]!, `anchor ${index}`),
      );
    },
  );

  // Close it with the toggle-closed button.
  await expect(toggle).toBeDisabled();
  const ends = (await anchorsOf(page)).map((anchor) => anchor.point);
  await click(page, await screen(ends[0]!));
  await expect(toggle).toBeEnabled();
  await step(
    page,
    errors,
    'toggle closed (close)',
    async () => toggle.click(),
    async (before, after) => {
      othersKept(before, after, 'open');
      expect(pathNode(after, 'open').path.verbs).toEqual(['move', 'line', 'line', 'line', 'close']);
      const overlay = (await overlayOf(page))!;
      expect(overlay.subpaths.map((subpath) => subpath.closed)).toEqual([true]);
      overlay.subpaths[0]!.anchors.forEach((anchor, index) =>
        expectNear(anchor.point, ends[index]!, `anchor ${index}`),
      );
    },
  );

  // Exit by a click outside, on the empty canvas: edit mode ends, the selection clears and the
  // group scope is left (M3-U2 note 5).
  await unchanged(page, async () => click(page, await screen(EMPTY)));
  expect(await session(page)).toMatchObject({ selection: [], scope: null, pathEdit: null });
  await expectMarkers(page);
  await expect(page.getByTestId('path-anchor')).toHaveCount(0);
  await expectClean(page, errors, 'exit by a click outside');
  await page.locator('canvas').screenshot({ path: test.info().outputPath('m3-next-host.png') });
});
