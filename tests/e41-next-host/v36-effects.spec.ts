import type { Command, Editor, NodeV8 } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';

// V-36 contract (docs/plans/viz-v36-inner-shadow-background-blur-contract.md), V36-A09: on the
// next-host studio page (`?test=1&layout=studio`), add, edit, hide and remove an inner shadow and
// a background blur from the property panel's Effects section, with pixel probes of the presented
// frame for each step, and the nested note (section 5.3) on a background blur inside a group at
// 50 % opacity. The shapes are set up with editor commands, as in e41-effects.spec.ts; every
// effect step goes through the panel. The probes read the presented frame through the page's
// E10 capture hook; the headless smoke project checks them when its renderer starts and records
// that it did not otherwise (e41-effects.spec.ts's rule). Runs in playwright.e41-studio.config.ts
// (headed Chrome and Edge).

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
const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const WHITE = { r: 1, g: 1, b: 1, a: 1 };
/** The glass: white at alpha 0.2, so the backdrop shows through at 80 %. */
const GLASS = { r: 1, g: 1, b: 1, a: 0.2 };

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

/**
 * Whether the renderer started. The headed projects need it; the headless smoke project
 * (SwiftShader) checks the pixels when it starts and records that it did not otherwise, and only
 * a missing geometry WASM excuses it (e41-effects.spec.ts).
 */
async function renderer(page: Page): Promise<boolean> {
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

async function effects(page: Page, id: string): Promise<NodeV8['effects']> {
  return page.evaluate(
    (key) =>
      (window as unknown as { __p5Host: Hook }).__p5Host.editor.getSnapshot().document.nodes[key]!
        .effects,
    id,
  );
}

/** Canvas pixels at page points, from the next presented frame (E10 capture hook). */
async function pixels(page: Page, points: readonly Point[]): Promise<Rgb[]> {
  return page.evaluate(async (at) => {
    const host = (window as unknown as { __p5Host: Hook }).__p5Host;
    const { position, zoom } = host.editor.getSnapshot().viewport;
    const hook = (window as unknown as { __nextHostRenderer: CaptureHook }).__nextHostRenderer;
    // The backend may still be initializing just after the hook appears.
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

const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const show = (value: unknown) => JSON.stringify(value);

async function commitField(page: Page, label: string, value: string) {
  const field = page.getByLabel(label, { exact: true });
  await field.fill(value);
  await field.press('Enter');
  await expect(field).toHaveAttribute('aria-invalid', 'false');
}

async function diagnostics(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __nextHostRenderer: CaptureHook }).__nextHostRenderer.diagnostics.map(
      (entry) => entry.code,
    ),
  );
}

test('V36-A09 inner shadow: add, edit, hide and remove from the panel', async ({ page }) => {
  const errors = await open(page);
  const rendering = await renderer(page);
  const [a] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 100, height: 100 },
    fill: RED,
    stroke: null,
  });
  await ok(page, { type: 'setSelection', ids: [a!] });
  await ok(page, { type: 'setViewport', camera: { position: { x: -100, y: -100 }, zoom: 1 } });
  // Probes inside the square: near its top edge (in the shadow's band once it is offset 20 px
  // down) and at its centre (past the band).
  const edge = { x: 50, y: 8 };
  const centre = { x: 50, y: 60 };
  if (rendering) {
    const [top, middle] = await pixels(page, [edge, centre]);
    expect(distance(top!, [255, 0, 0]), `plain edge ${show(top)}`).toBeLessThan(8);
    expect(distance(middle!, [255, 0, 0]), `plain centre ${show(middle)}`).toBeLessThan(8);
  }

  // Add an inner shadow: the contract's default (section 6).
  await page.getByTestId('effects-add-inner-shadow').click();
  expect(await effects(page, a!)).toEqual([
    {
      kind: 'innerShadow',
      visible: true,
      color: { r: 0, g: 0, b: 0, a: 0.25 },
      offsetX: 0,
      offsetY: 4,
      radius: 4,
    },
  ]);
  await expect(page.getByTestId('effect-0')).toHaveAttribute('data-kind', 'innerShadow');
  await expect(page.getByTestId('effect-0-kind')).toHaveValue('innerShadow');

  // Edit it: opaque blue, 20 px down, no blur. The band from the top edge to y 20 is blue (the
  // shape's top edge casts the full colour inward, section 4.1); the centre stays red.
  await commitField(page, 'Effect 1 colour', '#0000ff');
  await commitField(page, 'Effect 1 opacity', '100');
  await commitField(page, 'Effect 1 Y', '20');
  await commitField(page, 'Effect 1 Blur', '0');
  expect(await effects(page, a!)).toEqual([
    {
      kind: 'innerShadow',
      visible: true,
      color: { r: 0, g: 0, b: 1, a: 1 },
      offsetX: 0,
      offsetY: 20,
      radius: 0,
    },
  ]);
  if (rendering) {
    const [top, middle] = await pixels(page, [edge, centre]);
    expect(distance(top!, [0, 0, 255]), `inner tint ${show(top)}`).toBeLessThan(8);
    expect(distance(middle!, [255, 0, 0]), `centre ${show(middle)}`).toBeLessThan(8);
  }

  // Hide it: the tint stops drawing; show it again: it is back.
  await page.getByTestId('effect-0-visible').click();
  expect((await effects(page, a!))[0]!.visible).toBe(false);
  if (rendering) {
    const [top] = await pixels(page, [edge]);
    expect(distance(top!, [255, 0, 0]), `hidden inner shadow ${show(top)}`).toBeLessThan(8);
  }
  await page.getByTestId('effect-0-visible').click();
  expect((await effects(page, a!))[0]!.visible).toBe(true);
  if (rendering) {
    const [top] = await pixels(page, [edge]);
    expect(distance(top!, [0, 0, 255]), `shown again ${show(top)}`).toBeLessThan(8);
  }

  // Remove it: the square is plain red again.
  await page.getByTestId('effect-0-remove').click();
  expect(await effects(page, a!)).toEqual([]);
  await expect(page.getByTestId('effect-0')).toHaveCount(0);
  if (rendering) {
    const [top] = await pixels(page, [edge]);
    expect(distance(top!, [255, 0, 0]), `removed ${show(top)}`).toBeLessThan(8);
    expect(await diagnostics(page)).not.toContain('render.effect-resource-limit');
  }
  expect(errors).toEqual([]);
});

test('V36-A09 background blur: add, edit, hide and remove from the panel', async ({ page }) => {
  const errors = await open(page);
  const rendering = await renderer(page);
  // A sharp pattern: 10 px black and white stripes from x -100 to 200, y -50 to 150, wider than
  // the glass and its blur's reach, so the blurred backdrop under the glass is the stripes' mean.
  for (let k = 0; k < 30; k += 1)
    await ok(page, {
      type: 'createRectangle',
      frame: { x: -100 + 10 * k, y: -50, width: 10, height: 200 },
      fill: k % 2 === 0 ? BLACK : WHITE,
      stroke: null,
    });
  // The glass on top: white at alpha 0.2.
  const [glass] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 100, height: 100 },
    fill: GLASS,
    stroke: null,
  });
  await ok(page, { type: 'setSelection', ids: [glass!] });
  await ok(page, { type: 'setViewport', camera: { position: { x: -100, y: -100 }, zoom: 1 } });
  // Probes under the glass at the centres of a black stripe (x 40 to 50) and a white one.
  const black = { x: 45, y: 50 };
  const white = { x: 55, y: 50 };
  // Sharp: 0.2 × 255 over black is 51; over white 255.
  let sharp: Rgb[] = [];
  if (rendering) {
    sharp = await pixels(page, [black, white]);
    expect(distance(sharp[0]!, [51, 51, 51]), `sharp black ${show(sharp[0])}`).toBeLessThan(8);
    expect(distance(sharp[1]!, [255, 255, 255]), `sharp white ${show(sharp[1])}`).toBeLessThan(8);
  }

  // Add a background blur: the contract's default (radius 4), at the top level, so no note.
  await page.getByTestId('effects-add-background-blur').click();
  expect(await effects(page, glass!)).toEqual([
    { kind: 'backgroundBlur', visible: true, radius: 4 },
  ]);
  await expect(page.getByTestId('effect-0')).toHaveAttribute('data-kind', 'backgroundBlur');
  await expect(page.getByTestId('effect-0-kind')).toHaveValue('backgroundBlur');
  await expect(page.getByTestId('effect-0-nested-note')).toHaveCount(0);

  // Widen it to radius 20 (σ 10): the period-20 stripes blur to their mean (127.5) behind the
  // glass, so both probes read about 0.2 × 255 + 0.8 × 127.5 = 153, between the sharp values.
  await commitField(page, 'Effect 1 Blur', '20');
  expect(await effects(page, glass!)).toEqual([
    { kind: 'backgroundBlur', visible: true, radius: 20 },
  ]);
  const blurred = (values: Rgb[], label: string) => {
    for (const value of values) {
      expect(distance(value, [153, 153, 153]), `${label} ${show(value)}`).toBeLessThan(24);
      expect(distance(value, sharp[0]!), `${label}: not the sharp black`).toBeGreaterThan(60);
      expect(distance(value, sharp[1]!), `${label}: not the sharp white`).toBeGreaterThan(60);
    }
  };
  if (rendering) blurred(await pixels(page, [black, white]), 'blurred');

  // Hide it: the sharp stripes are back; show it again: blurred again.
  await page.getByTestId('effect-0-visible').click();
  expect((await effects(page, glass!))[0]!.visible).toBe(false);
  if (rendering) {
    const hidden = await pixels(page, [black, white]);
    expect(distance(hidden[0]!, sharp[0]!), `hidden black ${show(hidden[0])}`).toBeLessThan(8);
    expect(distance(hidden[1]!, sharp[1]!), `hidden white ${show(hidden[1])}`).toBeLessThan(8);
  }
  await page.getByTestId('effect-0-visible').click();
  expect((await effects(page, glass!))[0]!.visible).toBe(true);
  if (rendering) blurred(await pixels(page, [black, white]), 'shown again');

  // Remove it: sharp again.
  await page.getByTestId('effect-0-remove').click();
  expect(await effects(page, glass!)).toEqual([]);
  await expect(page.getByTestId('effect-0')).toHaveCount(0);
  if (rendering) {
    const removed = await pixels(page, [black, white]);
    expect(distance(removed[0]!, sharp[0]!), `removed black ${show(removed[0])}`).toBeLessThan(8);
    expect(distance(removed[1]!, sharp[1]!), `removed white ${show(removed[1])}`).toBeLessThan(8);
    expect(await diagnostics(page)).not.toContain('render.effect-resource-limit');
  }
  expect(errors).toEqual([]);
});

test('V36-A09 background blur inside a 50 % group shows the nested note', async ({ page }) => {
  const errors = await open(page);
  await renderer(page);
  const [glass] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 100, height: 100 },
    fill: GLASS,
    stroke: null,
  });
  const [other] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 120, y: 0, width: 100, height: 100 },
    fill: RED,
    stroke: null,
  });
  const [group] = await ok(page, { type: 'groupNodes', ids: [glass!, other!], kind: 'group' });
  await ok(page, { type: 'setStyle', ids: [group!], style: { opacity: 0.5 } });
  await ok(page, { type: 'setSelection', ids: [glass!] });
  await page.getByTestId('effects-add-background-blur').click();
  expect(await effects(page, glass!)).toEqual([
    { kind: 'backgroundBlur', visible: true, radius: 4 },
  ]);
  await expect(page.getByTestId('effect-0-nested-note')).toBeVisible();
  await expect(page.getByTestId('effect-0-nested-note')).toHaveText(
    'Background blur shows only outside groups with opacity or effects',
  );
  // At full opacity the group is no layer, so the note goes.
  await ok(page, { type: 'setStyle', ids: [group!], style: { opacity: 1 } });
  await expect(page.getByTestId('effect-0-nested-note')).toHaveCount(0);
  expect(errors).toEqual([]);
});
