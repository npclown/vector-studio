import type { Command, Editor, NodeV8 } from '@vector-studio/editor-core';
import { expect, test, type Download, type Page } from '@playwright/test';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-A08 and V35-A09 on the
// next-host studio page (`?test=1&layout=studio`): A08 adds three fills from the property panel,
// reorders, hides, sets opacity and blend modes, then the node's mode, checking the presented
// canvas after each change and that undo restores each step; A09 exports a page with a multiply
// fill as PNG and SVG and compares the PNG with the canvas (within 2/255). The pixel probes read
// the presented frame through the page's E10 capture hook; the headless smoke project (SwiftShader)
// checks them when its renderer starts. Runs in playwright.v35-studio.config.ts.

type Hook = Readonly<{ editor: Editor }>;
type Rgb = readonly [number, number, number];
type Point = Readonly<{ x: number; y: number }>;

type CaptureHook = Readonly<{
  capture: () => Promise<{
    width: number;
    height: number;
    devicePixelRatio: number;
    rgba: ArrayLike<number>;
  }>;
  diagnostics: readonly Readonly<{ code: string }>[];
}>;

const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };
const ORANGE = { r: 1, g: 0.5, b: 0, a: 1 };
const GREY = { r: 0.5, g: 0.5, b: 0.5, a: 1 };

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

/** Whether the renderer started; the headless smoke project may not have one (no WASM, no GPU). */
async function rendererStarted(page: Page): Promise<boolean> {
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
    const wasm = await page.request.get('/geometry-kernel.wasm');
    expect(wasm.status(), 'the WASM is served, so the renderer should start').not.toBe(200);
    test.info().annotations.push({
      type: 'not checked',
      description: 'presented pixels (the smoke run had no renderer)',
    });
  }
  return rendering;
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

async function node(page: Page, id: string): Promise<NodeV8> {
  return page.evaluate(
    (key) =>
      (window as unknown as { __p5Host: Hook }).__p5Host.editor.getSnapshot().document.nodes[key]!,
    id,
  );
}

async function undoDepth(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __p5Host: Hook }).__p5Host.editor.query({ type: 'history' })
        .undoDepth,
  );
}

/** The node's fills and mode as one comparable value. */
async function appearance(page: Page, id: string) {
  const { fills, blendMode } = (await node(page, id)) as Extract<NodeV8, { fills: unknown }>;
  return JSON.stringify({ fills, blendMode });
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

const channelGap = (a: Rgb, b: Rgb) => Math.max(...a.map((value, i) => Math.abs(value - b[i]!)));

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

test('V35-A08: three fills, reorder, hide, opacity, fill and node modes, undo', async ({
  page,
}) => {
  const errors = await open(page);
  const rendering = await rendererStarted(page);
  // B: a blue backdrop; A: a rectangle over it with one red fill.
  await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 200, height: 200 },
    fill: BLUE,
    stroke: null,
  });
  const [a] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 50, y: 50, width: 100, height: 100 },
    fill: RED,
    stroke: null,
  });
  await ok(page, { type: 'setSelection', ids: [a!] });
  await ok(page, { type: 'setViewport', camera: { position: { x: -100, y: -100 }, zoom: 1 } });
  const inside = { x: 100, y: 100 };
  const backdrop = { x: 20, y: 20 };

  const history: string[] = [await appearance(page, a!)];
  const expectations: (Rgb | null)[] = [[255, 0, 0]];
  const depth0 = await undoDepth(page);
  /** One panel edit: one more undo step, then the pixel (when rendering). */
  const step = async (label: string, action: () => Promise<void>, expected: Rgb) => {
    const before = await undoDepth(page);
    await action();
    await expect.poll(() => undoDepth(page), { message: label }).toBe(before + 1);
    history.push(await appearance(page, a!));
    expectations.push(expected);
    if (rendering) {
      const [at, behind] = await pixels(page, [inside, backdrop]);
      expect(channelGap(at!, expected), `${label}: ${JSON.stringify(at)}`).toBeLessThanOrEqual(6);
      expect(channelGap(behind!, [0, 0, 255]), `${label} backdrop`).toBeLessThanOrEqual(2);
    }
  };
  if (rendering) {
    const [first] = await pixels(page, [inside]);
    expect(channelGap(first!, [255, 0, 0]), 'one red fill').toBeLessThanOrEqual(2);
  }
  const fills = async () =>
    ((await node(page, a!)) as unknown as { fills: unknown[] }).fills.length;

  // Add: the default grey, normal, on top of the red.
  await step('add fill', () => page.getByTestId('fill-add').click(), [204, 204, 204]);
  expect(await fills()).toBe(2);
  // The top row is the new fill (display position 0): multiply over the red.
  await step(
    'multiply',
    async () => {
      await page.getByLabel('Fill blend mode', { exact: true }).selectOption('multiply');
    },
    [204, 0, 0],
  );
  // Hide it: the red shows. Show it again.
  await step('hide', () => page.getByTestId('fill-0-visible').click(), [255, 0, 0]);
  await step('show', () => page.getByTestId('fill-0-visible').click(), [204, 0, 0]);
  // A third fill on top, normal: it covers the others.
  await step('add third fill', () => page.getByTestId('fill-add').click(), [204, 204, 204]);
  expect(await fills()).toBe(3);
  await expect(page.getByTestId('fill-row-2')).toBeVisible();
  // Reorder: the multiply fill moves to the top, over the grey: 0.8 · 0.8.
  await step('move down', () => page.getByTestId('fill-0-down').click(), [163, 163, 163]);
  // Opacity 50 % on the top (multiply) fill: 0.8 · (0.5 + 0.5 · 0.8).
  await step(
    'opacity',
    async () => {
      await commitField(page, 'Fill opacity', '50');
    },
    [184, 184, 184],
  );
  // The node's own mode, multiply: the result over the blue backdrop keeps its blue channel only.
  await step(
    'node multiply',
    async () => {
      await page.getByLabel('Blend mode', { exact: true }).selectOption('multiply');
    },
    [0, 0, 184],
  );
  expect(((await node(page, a!)) as { blendMode: string }).blendMode).toBe('multiply');

  // Undo walks every step back: the document, then the pixels.
  for (let index = history.length - 1; index > 0; index -= 1) {
    await undo(page);
    await expect.poll(() => appearance(page, a!)).toBe(history[index - 1]);
    if (rendering) {
      const [at] = await pixels(page, [inside]);
      expect(
        channelGap(at!, expectations[index - 1]!),
        `undo to step ${index - 1}: ${JSON.stringify(at)}`,
      ).toBeLessThanOrEqual(6);
    }
  }
  expect(await undoDepth(page)).toBe(depth0);
  expect(errors).toEqual([]);
});

async function exportFile(page: Page, format: 'png' | 'svg'): Promise<Download> {
  await page.getByLabel('Export format').selectOption(format);
  if (format === 'png') await page.getByLabel('Export scale').selectOption('1');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-button').click(),
  ]);
  return download;
}

async function bytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Decodes a PNG in the page and returns the RGB at each image pixel. */
async function decode(page: Page, png: Buffer, probes: readonly (readonly [number, number])[]) {
  return page.evaluate(
    async ({ base64, points }) => {
      const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([data], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return {
        size: [bitmap.width, bitmap.height] as const,
        probes: points.map(([x, y]) => {
          const pixel = context.getImageData(x, y, 1, 1).data;
          return [pixel[0]!, pixel[1]!, pixel[2]!] as const;
        }),
      };
    },
    { base64: png.toString('base64'), points: probes as [number, number][] },
  );
}

test('V35-A09: a multiply fill over a backdrop exports as PNG and SVG like the canvas', async ({
  page,
}) => {
  const errors = await open(page);
  const rendering = await rendererStarted(page);
  await expect(page.getByTestId('export-panel')).toBeVisible();
  // An orange backdrop and a rectangle whose one fill is grey, multiply.
  await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 200, height: 200 },
    fill: ORANGE,
    stroke: null,
  });
  const [a] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 50, y: 50, width: 100, height: 100 },
    fill: GREY,
    stroke: null,
  });
  await ok(page, { type: 'setSelection', ids: [a!] });
  await page.getByLabel('Fill blend mode', { exact: true }).selectOption('multiply');
  await ok(page, { type: 'setSelection', ids: [] });
  await ok(page, { type: 'setViewport', camera: { position: { x: -100, y: -100 }, zoom: 1 } });

  // The page at 1x is 200 × 200 from (0, 0), so an image pixel is a page point.
  const inside = [100, 100] as const;
  const outside = [20, 20] as const;
  const png = await decode(page, await bytes(await exportFile(page, 'png')), [inside, outside]);
  expect(png.size).toEqual([200, 200]);
  // Multiply: grey · orange = (128, 64, 0); the backdrop alone is (255, 128, 0).
  expect(
    channelGap(png.probes[0]!, [128, 64, 0]),
    `PNG ${JSON.stringify(png.probes[0])}`,
  ).toBeLessThanOrEqual(2);
  expect(
    channelGap(png.probes[1]!, [255, 128, 0]),
    `PNG ${JSON.stringify(png.probes[1])}`,
  ).toBeLessThanOrEqual(2);
  if (rendering) {
    const canvas = await pixels(page, [
      { x: inside[0], y: inside[1] },
      { x: outside[0], y: outside[1] },
    ]);
    expect(
      channelGap(canvas[0]!, png.probes[0]!),
      `canvas ${JSON.stringify(canvas[0])}`,
    ).toBeLessThanOrEqual(2);
    expect(
      channelGap(canvas[1]!, png.probes[1]!),
      `canvas ${JSON.stringify(canvas[1])}`,
    ).toBeLessThanOrEqual(2);
  }

  // SVG: the blended fill carries `mix-blend-mode`.
  const svg = (await bytes(await exportFile(page, 'svg'))).toString('utf8');
  expect(svg).toContain('mix-blend-mode: multiply');
  expect(errors).toEqual([]);
});
