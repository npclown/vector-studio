import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, Editor, EditorEvent, SelectionHandles } from '@vector-studio/editor-core';
import {
  parseEnvelope,
  serializeDocument,
  type DocumentV4,
  type NodeV4,
} from '@vector-studio/model';
import { expect, test, type Page } from '@playwright/test';

// M7-U6 (MVP M7 contract, section 10): M7-A11, the next-host page on the `?fixture=symbols`
// document (the committed `tests/fixtures/m7-symbols/symbols.v3.json`: the source `s1` and its
// instance `i1` on page 1, two more instances of it on page 2 and an empty source) through
// EditorCanvas with real input, in headed Chrome and Edge. A source edit (a fill command, then a
// select-tool drag of a group inside the source) shows in the source and its instance on the
// canvas (pixel probes); the instance is resized from its handle and its content scales (M7-X1,
// M7-Q4 (c)); the page row's detach turns it into a frame that no longer follows the source; the
// source's delete detaches every remaining instance in one undo step; each step is undone back to
// the fixture byte for byte. The page row's symbol and instance buttons wrap a drawn rectangle
// and place an instance of it. A second test loads the fixture under `?persist=1`, flushes,
// reloads and checks that the restored instances are still linked: a source edit after the
// reload reaches them. Results are read through the page's `?test=1` hook, as in M1-A12.
//
// The `chromium-smoke` project (M7_NEXT_HOST_CHROMIUM, playwright.m7-next-host.config.ts) runs
// headless where the renderer may fail to start; it skips the pixel probes and the backend
// diagnostics (input, commands and persistence do not depend on the renderer). It does not check
// propagation: an instance's document node never changes when its source does, so only the
// pixel probes show a source edit reaching an instance (and the hit test cannot tell, since an
// instance's background is hit wherever its content is). It is a functional smoke run of the
// spec, not M7-A11 evidence.

declare global {
  interface Window {
    /** The next-host page's test hook, present with `?test=1` (apps/next-host/app/page.tsx). */
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
    /** The renderer's test hook, present with `?test=1` (apps/next-host/src/webgpu-renderer.ts). */
    __nextHostRenderer?: Readonly<{
      capture: () => Promise<
        Readonly<{ width: number; height: number; devicePixelRatio: number; rgba: Uint8Array }>
      >;
      diagnostics: readonly Readonly<{ code: string; severity: string; message: string }>[];
    }>;
  }
}

/** The hook's M5 member (M5 contract, section 5.3), declared apart as in the M5 spec. */
type PersistenceHook = Readonly<{ persistence: Readonly<{ flush(): Promise<void> }> }>;
type Point = Readonly<{ x: number; y: number }>;
type Rgb = readonly [number, number, number];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The page serves the v3 fixture `m7-symbols/symbols.v3.json`; since M6a-U1 the editor holds its
// committed v4 migration, which differs in the version only (M6a contract, section 2.1).
const FIXTURE_TEXT = readFileSync(
  path.join(root, 'tests/fixtures/m6-text/migrated/symbols.v4.json'),
  'utf8',
);
const FIXTURE = JSON.parse(FIXTURE_TEXT) as DocumentV4;
/** The canonical text of the fixture, as the editor's document serializes. */
const FIXTURE_SERIALIZED = serializeDocument(FIXTURE);
/** `s1`'s descendants in its pre-order: the order of a detached copy (section 5.2). */
const SOURCE_TYPES = ['rectangle', 'group', 'ellipse', 'path', 'frame', 'line'];
/** The instances of `s1`: `i1` on page 1, `i2` inside the group `g1` and `i4` inside `f2`. */
const S1_INSTANCES = ['i1', 'i2', 'i4'];

const GREEN = { r: 0, g: 1, b: 0, a: 1 };
const MAGENTA = { r: 1, g: 0, b: 1, a: 1 };
/** Reference colours in bytes; `canvas` and `white` are measured per check. */
const PAINTS: Readonly<Record<string, Rgb>> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  magenta: [255, 0, 255],
  grey: [128, 128, 128],
  fill: [204, 204, 204],
};
/** Outside every node at the fixture camera (page x -20..460, y -20..300 at zoom 2). */
const EMPTY = { x: 440, y: 280 };
/** `s1`'s white background between `s1-r`, `s1-g` and `s1-f`. */
const S1_BACKGROUND = { x: 46, y: 42 };
/** The centre of `s1-r`, the rectangle (rotated 0.5) at {10, 10, 30, 20} in `s1`. */
const S1_RECT = { x: 25, y: 20 };
/** Inside `s1-e` (centre (60, 20), radius 10, in `s1-g` at x 50) at y 15, left of the centre. */
const ELLIPSE_LEFT = { x: 54, y: 15 };
/** Right of `s1-e` at y 15, inside it once `s1-g` has moved 8 to the right. */
const ELLIPSE_RIGHT = { x: 73, y: 15 };
/** `s1-g`'s page drag: 8 page units right (16 CSS px at zoom 2). */
const GROUP_SHIFT = 8;
/** The hands-on line of the wrap check (section 5.1), clear of every fixture node. */
const LINE_START = { x: 300, y: 220 };
const LINE_END = { x: 420, y: 220 };
/** `i1`'s frame in the fixture, and the frame its bottom-right handle drag gives it. */
const I1_FRAME = { x: 140, y: 0, width: 100, height: 80 };
const I1_RESIZED = { x: 140, y: 0, width: 200, height: 160 };

/** A point of `s1`'s content space in `i1` at `frame` (scale only: neither is rotated). */
function inInstance(p: Point, frame = I1_FRAME): Point {
  return {
    x: frame.x + (p.x * frame.width) / FIXTURE.nodes.s1!.frame.width,
    y: frame.y + (p.y * frame.height) / FIXTURE.nodes.s1!.frame.height,
  };
}

async function open(page: Page, query: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?test=1${query}`);
  return { errors, status: await settled(page) };
}

/** Waits for the hook and the renderer state after a navigation or reload. */
async function settled(page: Page) {
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  if (test.info().project.name === 'chromium-smoke') {
    await expect(status).not.toHaveAttribute('data-renderer', 'pending', { timeout: 30_000 });
  } else {
    await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 30_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
  }
  return status;
}

/** Snapping is on by default since M2-U3; the exact drags below assume raw deltas. */
async function snappingOff(page: Page) {
  const ok = await page.evaluate(
    () => window.__p5Host!.editor.execute({ type: 'setSnapping', enabled: false }).ok,
  );
  expect(ok).toBe(true);
}

/** A page point on screen with the current camera and canvas content box, read at call time. */
async function screen(page: Page, p: Point): Promise<Point> {
  const { origin, position, zoom } = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const rect = canvas.getBoundingClientRect();
    return {
      origin: { x: rect.left + canvas.clientLeft, y: rect.top + canvas.clientTop },
      ...window.__p5Host!.editor.query({ type: 'viewport' }),
    };
  });
  return { x: origin.x + (p.x - position.x) * zoom, y: origin.y + (p.y - position.y) * zoom };
}

async function readDocument(page: Page): Promise<DocumentV4> {
  const text = await page.evaluate(() =>
    JSON.stringify(window.__p5Host!.editor.query({ type: 'document' })),
  );
  return JSON.parse(text) as DocumentV4;
}

async function serialized(page: Page): Promise<string> {
  return serializeDocument(await readDocument(page));
}

async function readHandles(page: Page): Promise<SelectionHandles | null> {
  const text = await page.evaluate(() =>
    JSON.stringify(window.__p5Host!.editor.query({ type: 'handles' })),
  );
  return JSON.parse(text) as SelectionHandles | null;
}

async function session(page: Page) {
  return page.evaluate(() => {
    const value = window.__p5Host!.editor.getSnapshot();
    return { selection: [...value.selection], undoDepth: value.history.undoDepth };
  });
}

/** Runs commands through the hook; they cross the page boundary as JSON text, as in M1-A12. */
async function run(page: Page, ...commands: Command[]) {
  const results = await page.evaluate(
    (script: string) =>
      (JSON.parse(script) as Command[]).map((command) => {
        const result = window.__p5Host!.editor.execute(command);
        return result.ok ? 'ok' : `${result.code} ${result.path ?? ''}`.trimEnd();
      }),
    JSON.stringify(commands),
  );
  expect(results).toEqual(commands.map(() => 'ok'));
}

/** `s1-r`'s fill, set through `setNodeProps` (a source edit). */
function rectFill(color: typeof GREEN): Command {
  return { type: 'setNodeProps', id: 's1-r', props: { fill: color } };
}

async function drag(page: Page, from: Point, to: Point) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function click(page: Page, p: Point) {
  const at = await screen(page, p);
  await page.mouse.click(at.x, at.y);
}

/**
 * Canvas pixels at page points, read from the next presented frame through the page's E10 frame
 * capture hook (apps/next-host/src/webgpu-renderer.ts), so the check sees what WebGPU drew.
 */
async function pixels(page: Page, points: readonly Point[]): Promise<Rgb[]> {
  const { position, zoom } = await page.evaluate(() =>
    window.__p5Host!.editor.query({ type: 'viewport' }),
  );
  const at = points.map((p) => [(p.x - position.x) * zoom, (p.y - position.y) * zoom]);
  return page.evaluate(async (at) => {
    const frame = await window.__nextHostRenderer!.capture();
    return at.map(([x, y]) => {
      const px = Math.floor(x! * frame.devicePixelRatio);
      const py = Math.floor(y! * frame.devicePixelRatio);
      const offset = (py * frame.width + px) * 4;
      return [frame.rgba[offset]!, frame.rgba[offset + 1]!, frame.rgba[offset + 2]!] as const;
    });
  }, at);
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function nearest(colour: Rgb, references: Readonly<Record<string, Rgb>>): string {
  let best = '';
  let bestDistance = Infinity;
  for (const [name, reference] of Object.entries(references)) {
    const d = distance(colour, reference);
    if (d < bestDistance) {
      best = name;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Classifies each named page point against the paints, the measured clear colour (`EMPTY`) and
 * the white measured at `white` (by default `s1`'s background; a step without `s1` passes
 * another white point), and expects the given classes. The canvas clears to opaque black, which
 * no probe here expects, so each reference must differ from it.
 */
async function expectPaints(
  page: Page,
  expected: Readonly<Record<string, [Point, string]>>,
  white: Point = S1_BACKGROUND,
) {
  const names = Object.keys(expected);
  const values = await pixels(page, [EMPTY, white, ...names.map((n) => expected[n]![0])]);
  const [canvas, measured, ...samples] = values;
  const references: Record<string, Rgb> = { canvas: canvas!, white: measured!, ...PAINTS };
  for (const [name, colour] of Object.entries(references)) {
    if (name === 'canvas') continue;
    expect(
      distance(colour, canvas!),
      `reference ${name} ${JSON.stringify(colour)} is too close to the canvas ${JSON.stringify(canvas)}`,
    ).toBeGreaterThan(32);
  }
  const classes = Object.fromEntries(
    names.map((name, index) => [name, nearest(samples[index]!, references)]),
  );
  const wanted = Object.fromEntries(names.map((name) => [name, expected[name]![1]]));
  expect(classes, JSON.stringify(Object.fromEntries(names.map((n, i) => [n, samples[i]])))).toEqual(
    wanted,
  );
}

/** A node's descendants in pre-order (the node excluded). */
function descendants(document: DocumentV4, id: string): NodeV4[] {
  const out: NodeV4[] = [];
  const visit = (current: string) => {
    const node = document.nodes[current]!;
    if (current !== id) out.push(node);
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(id);
  return out;
}

/** A detached instance (section 5.2): a frame with the source's fill and stroke and copies. */
function expectDetached(document: DocumentV4, id: string, before: DocumentV4) {
  const node = document.nodes[id]!;
  const original = before.nodes[id]!;
  const source = before.nodes.s1 as Extract<NodeV4, { type: 'symbol' }>;
  expect(node).toMatchObject({
    type: 'frame',
    name: original.name,
    parent: original.parent,
    frame: original.frame,
    rotation: original.rotation,
    constraints: original.constraints,
    fill: source.fill,
    stroke: source.stroke,
  });
  const copies = descendants(document, id);
  expect(copies.map((copy) => copy.type)).toEqual(SOURCE_TYPES);
  for (const copy of copies) expect(Object.hasOwn(before.nodes, copy.id)).toBe(false);
}

test('M7-A11: source edits reach instances; resize, detach, source delete and undo', async ({
  page,
}) => {
  const rendering = test.info().project.name !== 'chromium-smoke';
  if (!rendering) {
    test.info().annotations.push({
      type: 'not checked',
      description: 'presented pixels and backend diagnostics (headless smoke run)',
    });
  }
  const { errors, status } = await open(page, '&fixture=symbols');
  await expect(status).toHaveAttribute('data-fixture', 'loaded', { timeout: 30_000 });
  await snappingOff(page);
  expect(await serialized(page)).toBe(FIXTURE_SERIALIZED);
  await expect(status).toHaveAttribute('data-page', 'page-1');
  // `s1`, `i1` and the hidden instance `i3` of the empty source.
  await expect(status).toHaveAttribute('data-nodes', '3');
  const initial = {
    sourceRect: [S1_RECT, 'red'],
    instanceRect: [inInstance(S1_RECT), 'red'],
    sourceEllipse: [ELLIPSE_LEFT, 'blue'],
    instanceEllipse: [inInstance(ELLIPSE_LEFT), 'blue'],
    sourceRight: [ELLIPSE_RIGHT, 'white'],
    instanceRight: [inInstance(ELLIPSE_RIGHT), 'white'],
    sourceBar: [{ x: 50, y: 52 }, 'grey'],
    instanceBar: [inInstance({ x: 50, y: 52 }), 'grey'],
    between: [{ x: 120, y: 40 }, 'canvas'],
  } as const satisfies Record<string, [Point, string]>;
  if (rendering) await expectPaints(page, initial);

  // Source edit 1, a command: `s1-r` turns green in the source and in `i1`.
  await run(page, rectFill(GREEN));
  const recoloured = await readDocument(page);
  expect(recoloured.nodes.i1).toEqual(FIXTURE.nodes.i1);
  if (rendering) {
    await expectPaints(page, {
      sourceRect: [S1_RECT, 'green'],
      instanceRect: [inInstance(S1_RECT), 'green'],
    });
  }

  // Source edit 2, real input: a click inside the top-level source selects its child `s1-g`
  // (the artboard target, M7 section 1.2), and a drag moves it 8 to the right.
  await page.getByTestId('tool-select').click();
  await click(page, ELLIPSE_LEFT);
  expect((await session(page)).selection).toEqual(['s1-g']);
  await drag(
    page,
    await screen(page, ELLIPSE_LEFT),
    await screen(page, { x: ELLIPSE_LEFT.x + GROUP_SHIFT, y: ELLIPSE_LEFT.y }),
  );
  const moved = await readDocument(page);
  expect(moved.nodes['s1-g']!.frame).toEqual({
    ...FIXTURE.nodes['s1-g']!.frame,
    x: FIXTURE.nodes['s1-g']!.frame.x + GROUP_SHIFT,
  });
  expect(moved.nodes.i1).toEqual(FIXTURE.nodes.i1);
  if (rendering) {
    await expectPaints(page, {
      sourceEllipse: [ELLIPSE_LEFT, 'white'],
      instanceEllipse: [inInstance(ELLIPSE_LEFT), 'white'],
      sourceRight: [ELLIPSE_RIGHT, 'blue'],
      instanceRight: [inInstance(ELLIPSE_RIGHT), 'blue'],
    });
  }

  // Resize `i1` from its bottom-right handle to 200 x 160: its content scales by 2 (M7-X1).
  await click(page, inInstance(S1_BACKGROUND));
  expect((await session(page)).selection).toEqual(['i1']);
  const handles = (await readHandles(page))!;
  expect(handles.rotation).toBe(0);
  const corner = handles.corners[2];
  await drag(
    page,
    await screen(page, corner),
    await screen(page, {
      x: I1_RESIZED.x + I1_RESIZED.width,
      y: I1_RESIZED.y + I1_RESIZED.height,
    }),
  );
  const resized = await readDocument(page);
  expect(resized.nodes.i1!.frame).toEqual(I1_RESIZED);
  expect(resized.nodes.s1).toEqual(moved.nodes.s1);
  if (rendering) {
    await expectPaints(page, {
      sourceRect: [S1_RECT, 'green'],
      instanceRect: [inInstance(S1_RECT, I1_RESIZED), 'green'],
      instanceRight: [inInstance(ELLIPSE_RIGHT, I1_RESIZED), 'blue'],
      instanceLeft: [inInstance(ELLIPSE_LEFT, I1_RESIZED), 'white'],
      instanceBar: [inInstance({ x: 50, y: 52 }, I1_RESIZED), 'grey'],
    });
  }

  // Detach `i1` with the page row's button: a frame with the same ID and copies of its
  // expansion, the selection unchanged; a later source edit reaches `s1` and the linked `i2`
  // and `i4`, not `i1`.
  await expect(page.getByTestId('create-instance')).toBeDisabled();
  await page.getByTestId('detach').click();
  const detached = await readDocument(page);
  expectDetached(detached, 'i1', resized);
  expect((await session(page)).selection).toEqual(['i1']);
  await expect(page.getByTestId('detach')).toBeDisabled();
  await run(page, rectFill(MAGENTA));
  const later = await readDocument(page);
  expect(descendants(later, 'i1')).toEqual(descendants(detached, 'i1'));
  for (const id of ['i2', 'i4']) expect(later.nodes[id]!.type).toBe('instance');
  if (rendering) {
    await expectPaints(page, {
      sourceRect: [S1_RECT, 'magenta'],
      detachedRect: [inInstance(S1_RECT, I1_RESIZED), 'green'],
    });
  }
  await page.getByTestId('undo').click();
  expect(await serialized(page)).toBe(serializeDocument(detached));

  // Delete the source: every remaining instance (`i2`, `i4` on page 2) is detached in the same
  // transaction, one undo step (section 5.4).
  await click(page, S1_BACKGROUND);
  expect((await session(page)).selection).toEqual(['s1']);
  const depth = (await session(page)).undoDepth;
  await page.getByTestId('delete').click();
  const deleted = await readDocument(page);
  expect(Object.hasOwn(deleted.nodes, 's1')).toBe(false);
  expect(deleted.pages[0]!.children).toEqual(['i1', 'i3']);
  for (const id of ['i2', 'i4']) expectDetached(deleted, id, detached);
  expect((await session(page)).undoDepth).toBe(depth + 1);
  if (rendering) {
    // `s1` is gone, so white is measured on the detached `i1`'s background (`s1`'s fill).
    await expectPaints(
      page,
      {
        deletedRect: [S1_RECT, 'canvas'],
        deletedBackground: [S1_BACKGROUND, 'canvas'],
        detachedRect: [inInstance(S1_RECT, I1_RESIZED), 'green'],
      },
      inInstance(S1_BACKGROUND, I1_RESIZED),
    );
  }

  // Undo each step: the delete (byte for byte), the detach, the resize, the drag, the fill.
  await page.getByTestId('undo').click();
  expect(await serialized(page)).toBe(serializeDocument(detached));
  await page.getByTestId('undo').click();
  expect(await serialized(page)).toBe(serializeDocument(resized));
  for (const id of S1_INSTANCES)
    expect((await readDocument(page)).nodes[id]!.type).toBe('instance');
  if (rendering) {
    // Linked again: `i1` shows the source's current content at its resized frame.
    await expectPaints(page, {
      instanceRect: [inInstance(S1_RECT, I1_RESIZED), 'green'],
      instanceRight: [inInstance(ELLIPSE_RIGHT, I1_RESIZED), 'blue'],
    });
  }
  await page.getByTestId('undo').click();
  expect(await serialized(page)).toBe(serializeDocument(moved));
  await page.getByTestId('undo').click();
  expect(await serialized(page)).toBe(serializeDocument(recoloured));
  await page.getByTestId('undo').click();
  expect(await serialized(page)).toBe(FIXTURE_SERIALIZED);
  await expect(page.getByTestId('undo')).toBeDisabled();
  if (rendering) await expectPaints(page, initial);

  // The page row's symbol and instance: a drawn rectangle is wrapped in a new source, and an
  // instance of it is placed 40 to its right (section 5.1); both draw the default grey fill.
  await page.getByTestId('tool-rectangle').click();
  await drag(page, await screen(page, { x: 300, y: 200 }), await screen(page, { x: 360, y: 260 }));
  const drawn = await readDocument(page);
  const added = drawn.pages[0]!.children.filter((id) => !FIXTURE.pages[0]!.children.includes(id));
  expect(added).toHaveLength(1);
  const [rectangle] = added;
  expect(drawn.nodes[rectangle!]).toMatchObject({
    type: 'rectangle',
    frame: { x: 300, y: 200, width: 60, height: 60 },
  });
  await page.getByTestId('tool-select').click();
  await click(page, { x: 330, y: 230 });
  expect((await session(page)).selection).toEqual([rectangle]);
  await page.getByTestId('create-symbol').click();
  const wrapped = await readDocument(page);
  const [symbol] = (await session(page)).selection;
  expect(wrapped.nodes[symbol!]).toMatchObject({
    type: 'symbol',
    name: 'Symbol',
    frame: { x: 300, y: 200, width: 60, height: 60 },
    children: [rectangle],
    fill: null,
    stroke: null,
  });
  expect(wrapped.nodes[rectangle!]!.frame).toEqual({ x: 0, y: 0, width: 60, height: 60 });
  await page.getByTestId('create-instance').click();
  const placed = await readDocument(page);
  const [instance] = (await session(page)).selection;
  expect(placed.nodes[instance!]).toMatchObject({
    type: 'instance',
    symbol,
    name: 'Symbol',
    parent: 'page-1',
    frame: { x: 400, y: 200, width: 60, height: 60 },
    rotation: 0,
  });
  if (rendering) {
    await expectPaints(page, {
      newSource: [{ x: 330, y: 230 }, 'fill'],
      newInstance: [{ x: 430, y: 230 }, 'fill'],
      gap: [{ x: 380, y: 230 }, 'canvas'],
    });
  }
  // The instance's own detach, then undo of all four back to the fixture.
  await page.getByTestId('detach').click();
  expect((await readDocument(page)).nodes[instance!]!.type).toBe('frame');
  for (let i = 0; i < 4; i += 1) await page.getByTestId('undo').click();
  expect(await serialized(page)).toBe(FIXTURE_SERIALIZED);

  // The wrap's visual bounds (section 5.1, the M7-U6 hands-on check): a horizontal line with a
  // white 8-wide stroke wrapped by the symbol button gives a source 8 high whose clip keeps the
  // stroke painted (with geometric bounds it was 0 high and the stroke vanished).
  await page.getByTestId('tool-line').click();
  await drag(page, await screen(page, LINE_START), await screen(page, LINE_END));
  const lined = await readDocument(page);
  const addedLine = lined.pages[0]!.children.filter(
    (id) => !FIXTURE.pages[0]!.children.includes(id),
  );
  expect(addedLine).toHaveLength(1);
  const [line] = addedLine;
  const length = LINE_END.x - LINE_START.x;
  expect(lined.nodes[line!]).toMatchObject({
    type: 'line',
    frame: { x: LINE_START.x, y: LINE_START.y, width: length, height: 0 },
  });
  const lineStroke = (lined.nodes[line!] as Extract<NodeV4, { type: 'line' }>).stroke!;
  await run(page, {
    type: 'setNodeProps',
    id: line!,
    props: { stroke: { ...lineStroke, color: { r: 1, g: 1, b: 1, a: 1 }, width: 8 } },
  });
  await page.getByTestId('tool-select').click();
  await run(page, { type: 'setSelection', ids: [line!] });
  await page.getByTestId('create-symbol').click();
  const lineSymbol = await readDocument(page);
  const [lineSource] = (await session(page)).selection;
  expect(lineSymbol.nodes[lineSource!]).toMatchObject({
    type: 'symbol',
    children: [line],
    frame: { x: LINE_START.x, y: LINE_START.y - 4, width: length, height: 8 },
  });
  expect(lineSymbol.nodes[line!]!.frame).toEqual({ x: 0, y: 4, width: length, height: 0 });
  if (rendering) {
    await expectPaints(page, {
      lineAxis: [{ x: 360, y: LINE_START.y }, 'white'],
      lineEdge: [{ x: 360, y: LINE_START.y + 2.5 }, 'white'],
      aboveLine: [{ x: 360, y: LINE_START.y - 7 }, 'canvas'],
    });
  }
  // The draw, the stroke and the wrap, undone back to the fixture.
  for (let i = 0; i < 3; i += 1) await page.getByTestId('undo').click();
  expect(await serialized(page)).toBe(FIXTURE_SERIALIZED);

  const diagnostics = await page.evaluate(() =>
    window.__p5Host!.events.filter((event) => event.type === 'diagnostic'),
  );
  expect(diagnostics).toEqual([]);
  if (rendering) {
    // The fixture's round-joined stroked paths exceed the renderer's V4 fringe builder cap at
    // zoom 2 and the instance's scale 2, and are drawn region-only with one `fringe-work-cap`
    // warning each (a disclosed P3 renderer class, PATH_MESH_LIMITS.fringeBoundaryVertexCap).
    // Only that warning is tolerated; anything else fails.
    const backend = await page.evaluate(() =>
      window.__nextHostRenderer!.diagnostics.filter((entry) => entry.severity !== 'info'),
    );
    const fringeCap = (entry: (typeof backend)[number]): boolean =>
      entry.code === 'render.path-mesh-failure' &&
      entry.severity === 'warning' &&
      entry.message.endsWith('without its coverage fringe (renderer fringe-work-cap).');
    expect(backend.filter((entry) => !fringeCap(entry))).toEqual([]);
  }
  await expect(page.getByTestId('error')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.locator('canvas').screenshot({ path: test.info().outputPath('m7-next-host.png') });
});

test('M7-A11: a ?persist=1 reload keeps the instances linked', async ({ page }) => {
  const rendering = test.info().project.name !== 'chromium-smoke';
  // A fresh context: the page database starts empty (M5-A10).
  const { errors } = await open(page, '&persist=1');
  await expect(page.getByTestId('persist-status')).toHaveAttribute('data-persist', 'empty', {
    timeout: 30_000,
  });
  // `?persist=1` ignores `?fixture=` (M5 section 5.3), so the fixture is loaded by the command.
  await run(page, { type: 'loadDocument', document: FIXTURE });
  await page.evaluate(() => (window.__p5Host as unknown as PersistenceHook).persistence.flush());
  await expect(page.getByTestId('persist-status')).toHaveAttribute('data-persist', 'saved');
  const stored = await page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open('vector-studio-next-host');
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        request.onsuccess = () => {
          const db = request.result;
          const get = db
            .transaction('envelopes', 'readonly')
            .objectStore('envelopes')
            .get('default');
          get.onsuccess = () => {
            db.close();
            resolve(get.result);
          };
          get.onerror = () => reject(get.error ?? new Error('IndexedDB request failed'));
        };
      }),
  );
  expect(typeof stored).toBe('string');
  const envelope = parseEnvelope(stored as string);
  expect(envelope.ok).toBe(true);
  if (envelope.ok) {
    expect(serializeDocument(envelope.envelope.document)).toBe(FIXTURE_SERIALIZED);
    expect(envelope.envelope.lastOpenPageId).toBe('page-1');
  }
  await page.reload();
  const status = await settled(page);
  await expect(page.getByTestId('persist-status')).toHaveAttribute('data-persist', 'restored', {
    timeout: 30_000,
  });
  expect(await serialized(page)).toBe(FIXTURE_SERIALIZED);
  await expect(status).toHaveAttribute('data-page', 'page-1');
  const restored = await readDocument(page);
  for (const id of S1_INSTANCES) {
    expect(restored.nodes[id]).toMatchObject({ type: 'instance', symbol: 's1' });
  }
  // Linked: a source edit after the reload reaches `i1` on the canvas; the instances' own
  // document nodes do not change.
  await run(page, { type: 'setViewport', camera: { position: { x: -20, y: -20 }, zoom: 2 } });
  await run(page, rectFill(GREEN));
  const edited = await readDocument(page);
  for (const id of S1_INSTANCES) expect(edited.nodes[id]).toEqual(FIXTURE.nodes[id]);
  if (rendering) {
    await expectPaints(page, {
      sourceRect: [S1_RECT, 'green'],
      instanceRect: [inInstance(S1_RECT), 'green'],
    });
  }
  // And the source's delete still detaches them, which only a linked instance can be.
  await run(page, { type: 'deleteNodes', ids: ['s1'] });
  const deleted = await readDocument(page);
  for (const id of S1_INSTANCES) expectDetached(deleted, id, edited);
  const diagnostics = await page.evaluate(() =>
    window.__p5Host!.events.filter((event) => event.type === 'diagnostic'),
  );
  expect(diagnostics).toEqual([]);
  await expect(page.getByTestId('error')).toHaveCount(0);
  expect(errors).toEqual([]);
});
