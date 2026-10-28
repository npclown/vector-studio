import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Editor, EditorEvent, SelectionHandles } from '@vector-studio/editor-core';
import type { DocumentV2, NodeV2 } from '@vector-studio/model';
import { expect, test, type Page } from '@playwright/test';

// M1-U5 (MVP M1 contract, section 8): M1-A12, the next-host page renders the M1 containers
// fixture (two pages, a rotated frame with clipped children and a border, a mask group and an
// arrow line) and edits it through EditorCanvas (create with every drawing tool, group, move,
// resize, undo) in headed Chrome and Edge. Rendering is checked by sampling presented pixels
// well inside regions whose colour the clip, the mask and the line decide, and by the backend
// recording no warning or error; rendering precision stays outside this spec (P3 A04). The
// `chromium-swiftshader` smoke project (playwright.m1-next-host.config.ts) skips both rendering
// checks: SwiftShader in the cloud container loses its device on the first canvas present.

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

type Point = Readonly<{ x: number; y: number }>;
type Rgb = readonly [number, number, number];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = JSON.parse(
  readFileSync(path.join(root, 'tests/fixtures/m1-model/containers.json'), 'utf8'),
) as DocumentV2;
/** The page's fixture camera (apps/next-host/app/page.tsx): css = (page - position) * zoom. */
const CAMERA = { x: -20, y: -20, zoom: 2 };

/** A node's local point in its parent's space (M1 contract, section 5 transform). */
function place(node: NodeV2, x: number, y: number): Point {
  const { frame, rotation } = node;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  const e = frame.x + hw - (hw * cos - hh * sin);
  const f = frame.y + hh - (hw * sin + hh * cos);
  return { x: cos * x - sin * y + e, y: sin * x + cos * y + f };
}

const f1 = FIXTURE.nodes.f1!;
const mg1 = FIXTURE.nodes.mg1!;
const inFrame = (x: number, y: number) => place(f1, x, y);
const inMask = (x: number, y: number) => {
  const local = place(mg1, x, y);
  return inFrame(local.x, local.y);
};

/** Fixture sample points in page space, each well inside one colour region. */
const SAMPLES = {
  // r1 spans x -20..60 in f1; the frame's rect clip keeps only x >= 0.
  visibleChild: inFrame(30, 40),
  clippedChild: inFrame(-10, 40),
  frameBackground: inFrame(180, 20),
  // mg1's red rectangle shows only inside the triangle mask source (0.5,0)-(1,1)-(0,1).
  insideMask: inMask(30, 45),
  outsideMask: inMask(6, 15),
  // l1 runs from (150, 230) to (270, 200) with width 2; its end has a triangle head.
  lineMiddle: { x: 210, y: 215 },
  emptyCanvas: { x: 440, y: 280 },
} as const;

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&fixture=containers');
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  // The renderer attaches in the canvas effect after WebGPU initializes; nothing runs before.
  await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 30_000 });
  await expect(status).toHaveAttribute('data-fixture', 'loaded');
  await expect(page.getByTestId('error')).toHaveCount(0);
  // The canvas content box, inside its border, is where page points are measured.
  const origin = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + canvas.clientLeft, y: rect.top + canvas.clientTop };
  });
  const screen = (p: Point): Point => ({
    x: origin.x + (p.x - CAMERA.x) * CAMERA.zoom,
    y: origin.y + (p.y - CAMERA.y) * CAMERA.zoom,
  });
  return { errors, status, screen };
}

async function readDocument(page: Page): Promise<DocumentV2> {
  const text = await page.evaluate(() =>
    JSON.stringify(window.__p5Host!.editor.query({ type: 'document' })),
  );
  return JSON.parse(text) as DocumentV2;
}

async function readHandles(page: Page): Promise<SelectionHandles | null> {
  const text = await page.evaluate(() =>
    JSON.stringify(window.__p5Host!.editor.query({ type: 'handles' })),
  );
  return JSON.parse(text) as SelectionHandles | null;
}

/**
 * Canvas pixels at page points, read from the next presented frame through the page's E10 frame
 * capture hook (apps/next-host/src/webgpu-renderer.ts), so the check sees what WebGPU drew.
 */
async function pixels(page: Page, points: readonly Point[]): Promise<Rgb[]> {
  const at = points.map((p) => [(p.x - CAMERA.x) * CAMERA.zoom, (p.y - CAMERA.y) * CAMERA.zoom]);
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

/** Each fixture sample's colour is nearest to the paint the clip and the mask leave there. */
async function expectFixturePixels(page: Page) {
  const names = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];
  const values = await pixels(
    page,
    names.map((name) => SAMPLES[name]),
  );
  const sample = Object.fromEntries(names.map((name, index) => [name, values[index]!])) as Record<
    keyof typeof SAMPLES,
    Rgb
  >;
  // The canvas clear colour and the frame's white fill are measured; the rest are the fixture's.
  const references: Record<string, Rgb> = {
    canvas: sample.emptyCanvas,
    white: sample.frameBackground,
    blue: [51, 102, 204],
    red: [255, 0, 0],
    black: [0, 0, 0],
  };
  const classes = Object.fromEntries(
    names.map((name) => [name, nearest(sample[name], references)]),
  );
  expect(classes, JSON.stringify(sample)).toEqual({
    visibleChild: 'blue',
    clippedChild: 'canvas',
    frameBackground: 'white',
    insideMask: 'red',
    outsideMask: 'white',
    lineMiddle: 'black',
    emptyCanvas: 'canvas',
  });
  // The frame's white fill is a paint, not the clear colour.
  expect(distance(sample.frameBackground, sample.emptyCanvas)).toBeGreaterThan(32);
  return sample;
}

async function drag(page: Page, from: Point, to: Point) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function click(page: Page, at: Point, shift = false) {
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(at.x, at.y);
  if (shift) await page.keyboard.up('Shift');
}

/** The IDs `after` adds to page-1's children. */
function added(before: DocumentV2, after: DocumentV2): string[] {
  const old = new Set(before.pages[0]!.children);
  return after.pages[0]!.children.filter((id) => !old.has(id));
}

function expectClose(actual: Point, expected: Point, digits = 6) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

test('M1-A12: the next-host page renders the M1 fixture and edits it', async ({ page }) => {
  const rendering = test.info().project.name !== 'chromium-swiftshader';
  if (!rendering) {
    test.info().annotations.push({
      type: 'not checked',
      description: 'presented pixels and backend diagnostics (SwiftShader smoke run)',
    });
  }
  const { errors, status, screen } = await open(page);
  const fixture = await readDocument(page);
  expect(fixture).toEqual(FIXTURE);
  await expect(status).toHaveAttribute('data-page', 'page-1');
  await expect(status).toHaveAttribute('data-nodes', '4');

  // Rendering: the clip, the mask, the frame background and the arrow line are on the canvas.
  if (rendering) await expectFixturePixels(page);

  // Pages: the switcher lists both pages and switches the projected page, outside history.
  await expect(page.getByTestId('pages').getByRole('button')).toHaveCount(2);
  await page.getByTestId('page-page-2').click();
  await expect(status).toHaveAttribute('data-page', 'page-2');
  await expect(status).toHaveAttribute('data-nodes', '1');
  // Page 2 holds only r2 at the origin, so the fixture's blue child is gone from the canvas.
  if (rendering) {
    const [blank, empty] = await pixels(page, [SAMPLES.visibleChild, SAMPLES.emptyCanvas]);
    expect(nearest(blank!, { blue: [51, 102, 204], canvas: empty! })).toBe('canvas');
  }
  await page.getByTestId('page-page-1').click();
  await expect(status).toHaveAttribute('data-page', 'page-1');
  await expect(page.getByTestId('page-page-1')).toHaveAttribute('aria-pressed', 'true');

  // Create: one node with each drawing tool, at the page root in the empty right-hand column.
  const created: Record<string, string> = {};
  const draw = async (tool: string, from: Point, to: Point) => {
    const before = await readDocument(page);
    await page.getByTestId(`tool-${tool}`).click();
    await drag(page, screen(from), screen(to));
    const after = await readDocument(page);
    const ids = added(before, after);
    expect(ids).toHaveLength(1);
    created[tool] = ids[0]!;
    return after.nodes[ids[0]!]!;
  };
  const rectangle = await draw('rectangle', { x: 360, y: 30 }, { x: 440, y: 70 });
  expect(rectangle).toMatchObject({
    type: 'rectangle',
    parent: 'page-1',
    frame: { x: 360, y: 30, width: 80, height: 40 },
    rotation: 0,
  });
  const ellipse = await draw('ellipse', { x: 360, y: 90 }, { x: 440, y: 130 });
  expect(ellipse).toMatchObject({
    type: 'ellipse',
    parent: 'page-1',
    frame: { x: 360, y: 90, width: 80, height: 40 },
  });
  const line = await draw('line', { x: 360, y: 160 }, { x: 440, y: 180 });
  expect(line).toMatchObject({
    type: 'line',
    parent: 'page-1',
    frame: { x: 360, y: 160, width: 80, height: 20 },
    points: [0, 0, 1, 1],
  });
  const frame = await draw('frame', { x: 360, y: 200 }, { x: 440, y: 250 });
  expect(frame).toMatchObject({
    type: 'frame',
    parent: 'page-1',
    frame: { x: 360, y: 200, width: 80, height: 50 },
    children: [],
  });
  await expect(status).toHaveAttribute('data-nodes', '8');
  // The new rectangle is drawn: its centre is no longer the clear colour.
  if (rendering) {
    const [clear, filled] = await pixels(page, [SAMPLES.emptyCanvas, { x: 400, y: 50 }]);
    expect(filled).not.toEqual(clear);
  }

  // Group: the rectangle and the ellipse, selected by click and shift-click.
  await page.getByTestId('tool-select').click();
  await click(page, screen({ x: 400, y: 50 }));
  await click(page, screen({ x: 400, y: 110 }), true);
  await expect(status).toHaveAttribute('data-selected', '2');
  const beforeGroup = await readDocument(page);
  await page.getByTestId('group').click();
  const grouped = await readDocument(page);
  const [groupId] = added(beforeGroup, grouped);
  const group = grouped.nodes[groupId!]!;
  expect(group).toMatchObject({
    type: 'group',
    parent: 'page-1',
    children: [created.rectangle, created.ellipse],
    frame: { x: 360, y: 30, width: 80, height: 100 },
  });
  expect(grouped.nodes[created.rectangle!]!.frame).toEqual({ x: 0, y: 0, width: 80, height: 40 });
  await expect(status).toHaveAttribute('data-selected', '1');

  // Move: the group by a page-root drag, then r1 inside the rotated frame by a page delta that
  // the select tool turns into f1's space.
  await drag(page, screen({ x: 400, y: 50 }), screen({ x: 390, y: 60 }));
  const moved = await readDocument(page);
  expect(moved.nodes[groupId!]!.frame).toEqual({ x: 350, y: 40, width: 80, height: 100 });
  expect(moved.nodes[created.rectangle!]!.frame).toEqual({ x: 0, y: 0, width: 80, height: 40 });
  const child = SAMPLES.visibleChild;
  await drag(page, screen(child), screen({ x: child.x + 10, y: child.y }));
  const nested = await readDocument(page);
  expect(nested.nodes.r1!.parent).toBe('f1');
  expectClose(nested.nodes.r1!.frame, {
    x: FIXTURE.nodes.r1!.frame.x + 10 * Math.cos(-0.25),
    y: FIXTURE.nodes.r1!.frame.y + 10 * Math.sin(-0.25),
  });
  // The overlay draws the nested node's rotated box in page space, from the handles query.
  const r1Handles = (await readHandles(page))!;
  expect(r1Handles.rotation).toBe(0.25);
  await expectOverlay(page, r1Handles);

  // Resize: the rotated frame from its bottom-right handle along its own x axis, then the group.
  await click(page, screen(SAMPLES.frameBackground));
  const frameHandles = (await readHandles(page))!;
  expect(frameHandles.rotation).toBe(0.25);
  await expectOverlay(page, frameHandles);
  const corner = frameHandles.corners[2];
  const widened = { x: corner.x + 20 * Math.cos(0.25), y: corner.y + 20 * Math.sin(0.25) };
  await drag(page, screen(corner), screen(widened));
  const resized = await readDocument(page);
  expect(resized.nodes.f1!.rotation).toBe(0.25);
  // Pointer events land on whole CSS pixels: half a page unit at zoom 2.
  expect(Math.abs(resized.nodes.f1!.frame.width - 220)).toBeLessThan(1);
  expect(Math.abs(resized.nodes.f1!.frame.height - 150)).toBeLessThan(1);

  await click(page, screen({ x: 390, y: 60 }));
  await expect(status).toHaveAttribute('data-selected', '1');
  const groupHandles = (await readHandles(page))!;
  expect(groupHandles.rotation).toBe(0);
  const groupCorner = groupHandles.corners[2];
  await drag(page, screen(groupCorner), screen({ x: groupCorner.x + 10, y: groupCorner.y + 10 }));
  const scaled = await readDocument(page);
  expect(scaled.nodes[groupId!]!.frame).toEqual({ x: 350, y: 40, width: 90, height: 110 });

  // Undo: every edit since the load, back to the fixture byte for byte.
  const history = await page.evaluate(() => window.__p5Host!.editor.query({ type: 'history' }));
  expect(history.undoDepth).toBe(9);
  for (let i = 0; i < 9; i += 1) await page.getByTestId('undo').click();
  await expect(page.getByTestId('undo')).toBeDisabled();
  expect(await readDocument(page)).toEqual(FIXTURE);
  await expect(status).toHaveAttribute('data-nodes', '4');
  if (rendering) await expectFixturePixels(page);

  const diagnostics = await page.evaluate(() =>
    window.__p5Host!.events.filter((event) => event.type === 'diagnostic'),
  );
  expect(diagnostics).toEqual([]);
  if (rendering) {
    const backend = await page.evaluate(() =>
      window.__nextHostRenderer!.diagnostics.filter((entry) => entry.severity !== 'info'),
    );
    expect(backend).toEqual([]);
  }
  await expect(page.getByTestId('error')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.locator('canvas').screenshot({ path: test.info().outputPath('m1-next-host.png') });
});

/** The overlay polygon sits on the query's corners, with eight handles. */
async function expectOverlay(page: Page, handles: SelectionHandles) {
  const selection = page.getByTestId('selection');
  await expect(selection).toHaveCount(1);
  await expect(page.getByTestId('handle')).toHaveCount(8);
  const drawn = ((await selection.getAttribute('points')) ?? '')
    .split(' ')
    .map((pair) => pair.split(',').map(Number));
  // The overlay is drawn in CSS pixels relative to the canvas: (page - position) * zoom.
  expect(drawn).toHaveLength(4);
  handles.corners.forEach((corner, index) => {
    expectClose(
      { x: drawn[index]![0]!, y: drawn[index]![1]! },
      { x: (corner.x - CAMERA.x) * CAMERA.zoom, y: (corner.y - CAMERA.y) * CAMERA.zoom },
      3,
    );
  });
}
