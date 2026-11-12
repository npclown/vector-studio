import { deflateSync } from 'node:zlib';
import type { Command, Editor, NodeV8 } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';

// V-32 contract (docs/plans/viz-v32-image-contract.md), U4: V32-A08, the editor flow on the
// next-host studio page (`?test=1&layout=studio&persist=1`): paste from a synthetic clipboard
// event, a drop of two files, Place image through the toolbar and the shortcut's file chooser,
// an image fill on an ellipse and a change of its mode, each drawing (a probe of the presented
// frame) and each one undo step; then a reload after the autosave keeps the image. And V32-A07's
// PNG half: a 2x PNG export of a placed image probed at the quadrant centres within 3. Runs in
// playwright.e41-studio.config.ts (headed Chrome and Edge, or the headless smoke project with
// M8_NEXT_HOST_CHROMIUM, which runs the renderer on SwiftShader). The presented-frame probes
// need the renderer; the smoke project records when it did not start.

type Hook = Readonly<{
  editor: Editor;
  persistence: Readonly<{ flush(): Promise<void> }>;
}>;
type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];
type Point = Readonly<{ x: number; y: number }>;
type CaptureHook = Readonly<{
  capture: () => Promise<{
    width: number;
    height: number;
    devicePixelRatio: number;
    rgba: ArrayLike<number>;
  }>;
  diagnostics: readonly Readonly<{ code: string; severity: string; message: string }>[];
}>;

// ---------------------------------------------------------------------------------------------
// Test images: PNGs built here, so the spec needs no fixture file.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** An RGBA PNG of `width × height` whose pixel (x, y) is `pixel(x, y)`. */
function png(width: number, height: number, pixel: (x: number, y: number) => Rgba): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(height * (1 + 4 * width));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rows.set(pixel(x, y), y * (1 + 4 * width) + 1 + 4 * x);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const YELLOW: Rgba = [255, 255, 0, 255];
const MAGENTA: Rgba = [255, 0, 255, 255];

/** 64 × 32, four flat quadrants: red, green over blue, yellow (V32-A06's test image). */
const QUADRANTS = png(64, 32, (x, y) => (y < 16 ? (x < 32 ? RED : GREEN) : x < 32 ? BLUE : YELLOW));
const FLAT = png(20, 20, () => MAGENTA);
/** The probe point of each quadrant, in image pixels and its colour. */
const QUADRANT_PROBES: readonly (readonly [number, number, Rgba])[] = [
  [16, 8, RED],
  [48, 8, GREEN],
  [16, 24, BLUE],
  [48, 24, YELLOW],
];

// ---------------------------------------------------------------------------------------------
// Page helpers

const CANVAS = '[data-testid="studio-canvas"] canvas';

async function open(page: Page, query = '') {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?test=1&layout=studio${query}`);
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

type Snapshot = Readonly<{
  nodes: Readonly<Record<string, NodeV8>>;
  images: readonly string[];
  selection: readonly string[];
  undoDepth: number;
  center: Point;
}>;

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const s = (window as unknown as { __p5Host: Hook }).__p5Host.editor.getSnapshot();
    const size = s.viewportSize!;
    return {
      nodes: JSON.parse(JSON.stringify(s.document.nodes)) as Record<string, NodeV8>,
      images: Object.keys(s.document.images ?? {}),
      selection: [...s.selection],
      undoDepth: s.history.undoDepth,
      center: {
        x: s.viewport.position.x + size.width / (2 * s.viewport.zoom),
        y: s.viewport.position.y + size.height / (2 * s.viewport.zoom),
      },
    };
  });
}

/** The topmost fill's paint of a node of the snapshot. */
const paintOf = (s: Snapshot, id: string) =>
  (s.nodes[id] as unknown as { fills: { paint: Record<string, unknown> }[] }).fills.at(-1)!.paint;

const rectangles = (s: Snapshot) => Object.values(s.nodes).filter((n) => n.type === 'rectangle');

/** The client point of page point `p` on the studio canvas. */
async function client(page: Page, p: Point): Promise<Point> {
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

/** Whether the renderer started: required in the headed projects, recorded in the smoke one. */
async function rendererReady(page: Page): Promise<boolean> {
  const smoke = test.info().project.name === 'smoke';
  const rendering = await page
    .waitForFunction(
      () =>
        (window as unknown as { __nextHostRenderer?: CaptureHook }).__nextHostRenderer !==
        undefined,
      undefined,
      { timeout: smoke ? 15_000 : 60_000 },
    )
    .then(
      () => true,
      () => false,
    );
  if (!rendering) {
    expect(smoke, 'the renderer started').toBe(true);
    test.info().annotations.push({
      type: 'not checked',
      description: 'presented pixels (the smoke run had no renderer)',
    });
  }
  return rendering;
}

/** Canvas pixels at page points, from the next presented frame (E10 capture hook). */
async function pixels(page: Page, points: readonly Point[]): Promise<Rgb[]> {
  return page.evaluate(async (at) => {
    const host = (window as unknown as { __p5Host: Hook }).__p5Host;
    const { position, zoom } = host.editor.getSnapshot().viewport;
    const hook = (window as unknown as { __nextHostRenderer: CaptureHook }).__nextHostRenderer;
    let frame: Awaited<ReturnType<CaptureHook['capture']>> | null = null;
    for (let attempt = 0; frame === null; attempt += 1) {
      try {
        frame = await hook.capture();
      } catch (error) {
        if (attempt >= 60 || !String(error).includes('not-ready')) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return at.map((p) => {
      const px = Math.floor((p.x - position.x) * zoom * frame.devicePixelRatio);
      const py = Math.floor((p.y - position.y) * zoom * frame.devicePixelRatio);
      const offset = (py * frame.width + px) * 4;
      return [frame.rgba[offset]!, frame.rgba[offset + 1]!, frame.rgba[offset + 2]!] as const;
    });
  }, points);
}

const close = (a: Rgb, b: Rgba, tolerance = 3) =>
  a.every((value, index) => Math.abs(value - b[index]!) <= tolerance);

/**
 * Polls the presented frame until every probe is within 3 per channel of its colour (the image
 * arrives asynchronously: pending, then ready after the port's notification), then asserts it.
 */
async function expectDrawn(page: Page, probes: readonly (readonly [Point, Rgba])[], label: string) {
  await expect
    .poll(
      async () => {
        const read = await pixels(
          page,
          probes.map(([point]) => point),
        );
        return read.every((value, index) => close(value, probes[index]![1]));
      },
      { message: label, timeout: 30_000, intervals: [250, 500, 1000] },
    )
    .toBe(true);
}

/** The four quadrant probes of a 64 × 32 image whose node frame starts at `(x, y)`. */
const quadrantsAt = (x: number, y: number): (readonly [Point, Rgba])[] =>
  QUADRANT_PROBES.map(([u, v, colour]) => [{ x: x + u, y: y + v }, colour] as const);

async function undo(page: Page) {
  await page.locator(CANVAS).focus();
  await page.keyboard.press('ControlOrMeta+Z');
}

/** Dispatches a DOM event carrying `files` on the canvas, as the browser does. */
async function transfer(
  page: Page,
  kind: 'paste' | 'drop',
  files: readonly { name: string; type: string; data: Buffer }[],
  at?: Point,
) {
  await page.evaluate(
    ({ kind: eventKind, items, point }) => {
      const data = new DataTransfer();
      for (const item of items) {
        const bytes = Uint8Array.from(atob(item.base64), (char) => char.charCodeAt(0));
        data.items.add(new File([bytes], item.name, { type: item.type }));
      }
      const canvas = document.querySelector<HTMLCanvasElement>(
        '[data-testid="studio-canvas"] canvas',
      )!;
      if (eventKind === 'paste') {
        canvas.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
        return;
      }
      const init = {
        dataTransfer: data,
        clientX: point!.x,
        clientY: point!.y,
        bubbles: true,
        cancelable: true,
      };
      canvas.dispatchEvent(new DragEvent('dragover', init));
      canvas.dispatchEvent(new DragEvent('drop', init));
    },
    {
      kind,
      point: at,
      items: files.map((file) => ({
        name: file.name,
        type: file.type,
        base64: file.data.toString('base64'),
      })),
    },
  );
}

// ---------------------------------------------------------------------------------------------

test('V32-A08 paste, drop, Place image, image fill and mode, undo, reload', async ({ page }) => {
  const errors = await open(page, '&persist=1');
  await expect(page.locator('[data-persist]')).toHaveAttribute('data-persist', /empty|restored/u, {
    timeout: 30_000,
  });
  const rendering = await rendererReady(page);
  const probe = async (probes: readonly (readonly [Point, Rgba])[], label: string) => {
    if (rendering) await expectDrawn(page, probes, label);
  };
  await ok(page, { type: 'setViewport', camera: { position: { x: -50, y: -50 }, zoom: 1 } });
  const base = await snapshot(page);
  expect(rectangles(base)).toHaveLength(0);

  // Paste: an image file on a synthetic paste event, no pointer over the canvas, so the view
  // centre. A rectangle at the image's size with the image as its fill, selected.
  await page.locator(CANVAS).focus();
  await transfer(page, 'paste', [{ name: 'quadrants.png', type: 'image/png', data: QUADRANTS }]);
  await expect.poll(async () => rectangles(await snapshot(page)).length).toBe(1);
  let now = await snapshot(page);
  const pasted = rectangles(now)[0]!;
  expect(pasted.name).toBe('quadrants');
  expect(pasted.frame).toMatchObject({ width: 64, height: 32 });
  expect(pasted.frame.x).toBeCloseTo(now.center.x - 32, 5);
  expect(pasted.frame.y).toBeCloseTo(now.center.y - 16, 5);
  expect(now.selection).toEqual([pasted.id]);
  expect(now.images).toHaveLength(1);
  expect(now.undoDepth).toBe(base.undoDepth + 1);
  await probe(quadrantsAt(pasted.frame.x, pasted.frame.y), 'pasted image');
  await undo(page);
  now = await snapshot(page);
  expect(rectangles(now)).toHaveLength(0);
  expect(now.images).toEqual([]);

  // Drop of two files: the first centred on the drop point, the next 20 units down and right.
  const target = { x: now.center.x - 120, y: now.center.y - 60 };
  await transfer(
    page,
    'drop',
    [
      { name: 'one.png', type: 'image/png', data: QUADRANTS },
      { name: 'two.png', type: 'image/png', data: FLAT },
    ],
    await client(page, target),
  );
  await expect.poll(async () => rectangles(await snapshot(page)).length).toBe(2);
  now = await snapshot(page);
  const [one, two] = rectangles(now);
  expect(one!.frame.x).toBeCloseTo(target.x - 32, 3);
  expect(one!.frame.y).toBeCloseTo(target.y - 16, 3);
  expect(two!.frame.x).toBeCloseTo(target.x + 20 - 10, 3);
  expect(two!.frame.y).toBeCloseTo(target.y + 20 - 10, 3);
  expect(now.selection).toEqual([one!.id, two!.id]);
  expect(now.images).toHaveLength(2);
  expect(now.undoDepth).toBe(base.undoDepth + 1);
  await probe(
    [
      ...quadrantsAt(one!.frame.x, one!.frame.y),
      [{ x: two!.frame.x + 10, y: two!.frame.y + 10 }, MAGENTA] as const,
    ],
    'dropped images',
  );
  await undo(page);
  expect(rectangles(await snapshot(page))).toHaveLength(0);

  // A dropped file that is not an image is skipped with the notice, and places nothing.
  await transfer(
    page,
    'drop',
    [{ name: 'notes.txt', type: 'text/plain', data: Buffer.from('hello') }],
    await client(page, target),
  );
  await expect(page.getByText('editor.image-unsupported-file')).toBeVisible();
  expect(rectangles(await snapshot(page))).toHaveLength(0);

  // Place image from the toolbar: the file chooser opens from the click.
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('place-image').click(),
  ]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles({ name: 'placed.png', mimeType: 'image/png', buffer: QUADRANTS });
  await expect.poll(async () => rectangles(await snapshot(page)).length).toBe(1);
  now = await snapshot(page);
  const placed = rectangles(now)[0]!;
  expect(placed.name).toBe('placed');
  expect(placed.frame.x).toBeCloseTo(now.center.x - 32, 5);
  await probe(quadrantsAt(placed.frame.x, placed.frame.y), 'placed image');
  await undo(page);
  expect(rectangles(await snapshot(page))).toHaveLength(0);

  // Ctrl or Cmd+Shift+K on the canvas opens the same chooser, from the keydown.
  await page.locator(CANVAS).focus();
  const [byKey] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.keyboard.press('ControlOrMeta+Shift+K'),
  ]);
  await byKey.setFiles({ name: 'key.png', mimeType: 'image/png', buffer: FLAT });
  await expect.poll(async () => rectangles(await snapshot(page)).length).toBe(1);
  await undo(page);
  expect(rectangles(await snapshot(page))).toHaveLength(0);

  // Image fill on an ellipse, then a change of its scale mode.
  const [ellipse] = await ok(page, {
    type: 'createEllipse',
    frame: { x: 200, y: 100, width: 100, height: 100 },
    fill: { r: 1, g: 0, b: 1, a: 1 },
    stroke: null,
  });
  await ok(page, { type: 'setSelection', ids: [ellipse!] });
  const depth = (await snapshot(page)).undoDepth;
  const type = page.getByLabel('Fill type', { exact: true });
  // A real key press changes the select, so the chooser opens inside a user activation.
  await type.focus();
  const [filled] = await Promise.all([page.waitForEvent('filechooser'), page.keyboard.press('I')]);
  await filled.setFiles({ name: 'fill.png', mimeType: 'image/png', buffer: QUADRANTS });
  await expect(page.getByLabel('Fill scale mode', { exact: true })).toHaveValue('fill');
  now = await snapshot(page);
  expect(now.undoDepth).toBe(depth + 1);
  expect(now.images).toHaveLength(1);
  await expect(page.getByTestId('fill-image-thumbnail')).toBeVisible();
  await expect(page.getByTestId(`layer-image-${ellipse}`)).toBeVisible();
  // `fill`: the 64 × 32 image covers the 100 × 100 box (scale 3.125, centred), cropping its left
  // and right quarters; the box's quadrants still show one image quadrant each.
  const inside = (u: number, v: number): Point => ({ x: 200 + u, y: 100 + v });
  await probe(
    [
      [inside(30, 30), RED],
      [inside(70, 30), GREEN],
      [inside(30, 70), BLUE],
      [inside(70, 70), YELLOW],
    ],
    'ellipse, fill',
  );
  await page.getByLabel('Fill scale mode', { exact: true }).selectOption('stretch');
  now = await snapshot(page);
  expect(now.undoDepth).toBe(depth + 2);
  expect(paintOf(now, ellipse!).scaleMode).toBe('stretch');
  await probe(
    [
      [inside(30, 30), RED],
      [inside(70, 30), GREEN],
      [inside(30, 70), BLUE],
      [inside(70, 70), YELLOW],
    ],
    'ellipse, stretch',
  );
  // Tile takes a scale field in percent.
  await page.getByLabel('Fill scale mode', { exact: true }).selectOption('tile');
  const scale = page.getByLabel('Tile scale', { exact: true });
  await scale.fill('50');
  await scale.press('Enter');
  await expect(scale).toHaveAttribute('aria-invalid', 'false');
  now = await snapshot(page);
  expect(paintOf(now, ellipse!).scale).toBe(0.5);
  // Undo steps back through the scale, the two mode changes and the image fill.
  expect(now.undoDepth).toBe(depth + 4);
  await undo(page);
  await undo(page);
  await undo(page);
  await undo(page);
  now = await snapshot(page);
  expect(now.undoDepth).toBe(depth);
  expect(now.images).toEqual([]);
  expect(paintOf(now, ellipse!)).toEqual({ r: 1, g: 0, b: 1, a: 1 });
  // Redo the four steps for the reload below.
  for (let step = 0; step < 4; step += 1) await page.keyboard.press('ControlOrMeta+Shift+Z');
  now = await snapshot(page);
  expect(now.images).toHaveLength(1);

  // Reload after the autosave: the image, its fill and its mode come back, and draw.
  await page.evaluate(() => (window as unknown as { __p5Host: Hook }).__p5Host.persistence.flush());
  const before = (await snapshot(page)).nodes[ellipse!];
  await page.reload();
  await page.waitForFunction(
    () => (window as unknown as { __p5Host?: Hook }).__p5Host !== undefined,
  );
  await expect(page.locator('[data-persist]')).toHaveAttribute('data-persist', 'restored', {
    timeout: 30_000,
  });
  const restored = await snapshot(page);
  expect(restored.images).toEqual(now.images);
  expect(restored.nodes[ellipse!]).toEqual(before);
  if (await rendererReady(page)) {
    await ok(page, { type: 'setViewport', camera: { position: { x: -50, y: -50 }, zoom: 1 } });
    // Tile at 50%: a 32 × 16 repeat from the box's top-left, red in its first 16 × 8; the point
    // (40, 52) of the box is 8 right and 4 down in a repeat, and inside the ellipse.
    await expectDrawn(page, [[{ x: 240, y: 152 }, RED]], 'ellipse after the reload');
  }
  expect(errors).toEqual([]);
});

// ---------------------------------------------------------------------------------------------

/** Decodes a PNG in the page: its size and the RGBA of each probe point (image pixels). */
async function decode(page: Page, bytes: Buffer, points: readonly (readonly [number, number])[]) {
  return page.evaluate(
    async ({ base64, at }) => {
      const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const read = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      return {
        width: bitmap.width,
        height: bitmap.height,
        probes: at.map(([x, y]) => {
          const offset = (y * bitmap.width + x) * 4;
          return [read[offset]!, read[offset + 1]!, read[offset + 2]!, read[offset + 3]!] as const;
        }),
      };
    },
    { base64: bytes.toString('base64'), at: points as [number, number][] },
  );
}

test('V32-A07 PNG: a 2x export of a placed image, probed at the quadrant centres', async ({
  page,
}) => {
  const errors = await open(page);
  await ok(page, { type: 'setViewport', camera: { position: { x: -50, y: -50 }, zoom: 1 } });
  await page.locator(CANVAS).focus();
  await transfer(page, 'paste', [{ name: 'quadrants.png', type: 'image/png', data: QUADRANTS }]);
  await expect.poll(async () => rectangles(await snapshot(page)).length).toBe(1);
  const [id] = (await snapshot(page)).selection;
  await ok(page, { type: 'setSelection', ids: [id!] });
  await page.getByLabel('Export format').selectOption('png');
  await page.getByLabel('Export scale').selectOption('2');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-button').click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const part of stream) chunks.push(part as Buffer);
  // The rectangle is 64 × 32 units: 128 × 64 pixels at 2x; each quadrant centre doubles.
  const out = await decode(
    page,
    Buffer.concat(chunks),
    QUADRANT_PROBES.map(([x, y]) => [2 * x, 2 * y] as const),
  );
  expect([out.width, out.height]).toEqual([128, 64]);
  out.probes.forEach((value, index) => {
    const expected = QUADRANT_PROBES[index]![2];
    value.forEach((channel, at) =>
      expect(
        Math.abs(channel - expected[at]!),
        `quadrant ${index}: ${value.join(',')}`,
      ).toBeLessThanOrEqual(3),
    );
  });
  // An SVG export carries the same image once.
  await page.getByLabel('Export format').selectOption('svg');
  const [svgFile] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-button').click(),
  ]);
  const svgStream = await svgFile.createReadStream();
  const svgChunks: Buffer[] = [];
  for await (const part of svgStream) svgChunks.push(part as Buffer);
  const svg = Buffer.concat(svgChunks).toString('utf8');
  expect(svg.match(/<image /gu)).toHaveLength(1);
  expect(svg).toContain('data:image/png;base64,');
  expect(errors).toEqual([]);
});
