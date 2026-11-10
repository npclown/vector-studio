import type { Command, Editor, NodeV7 } from '@vector-studio/editor-core';
import { expect, test, type Page } from '@playwright/test';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), E41-A12, the effects half (U7):
// on the next-host studio page (`?test=1&layout=studio`), add, edit, hide and remove a drop
// shadow and a layer blur from the property panel's Effects section, each edit one undo step,
// the limit notice, and an off-screen caster whose shadow is on screen draws (K3). The pixel
// probes read the presented frame through the page's E10 capture hook; the headless smoke
// project skips them (its renderer may not start). Runs in playwright.e41-studio.config.ts.

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

async function node(page: Page, id: string): Promise<NodeV7> {
  return page.evaluate(
    (key) =>
      (window as unknown as { __p5Host: Hook }).__p5Host.editor.getSnapshot().document.nodes[key]!,
    id,
  );
}

async function effects(page: Page, id: string) {
  return (await node(page, id)).effects;
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

test('E41-A12 effects: add, edit, hide and remove a shadow and a blur from the panel', async ({
  page,
}) => {
  const errors = await open(page);
  // The headed projects need the renderer; the headless smoke project (SwiftShader) checks the
  // pixels when its renderer starts and records that it did not otherwise.
  const smoke = test.info().project.name === 'smoke';
  const rendering = await page
    .waitForFunction(
      () =>
        (window as unknown as { __nextHostRenderer?: CaptureHook }).__nextHostRenderer !==
        undefined,
      undefined,
      {
        timeout: smoke ? 15_000 : 60_000,
      },
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
  const [a] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 100, height: 100 },
    fill: RED,
    stroke: null,
  });
  await ok(page, { type: 'setSelection', ids: [a!] });
  await ok(page, { type: 'setViewport', camera: { position: { x: -100, y: -100 }, zoom: 1 } });
  // Probes: inside the square, in the shadow's reach only, and empty canvas far away.
  const inside = { x: 50, y: 50 };
  const shadowed = { x: 130, y: 130 };
  const empty = { x: 400, y: 400 };
  const [, before] = rendering ? await pixels(page, [inside, shadowed]) : [];

  // Add a shadow: the contract's default.
  await page.getByTestId('effects-add-shadow').click();
  expect(await effects(page, a!)).toEqual([
    {
      kind: 'dropShadow',
      visible: true,
      color: { r: 0, g: 0, b: 0, a: 0.25 },
      offsetX: 0,
      offsetY: 4,
      radius: 8,
    },
  ]);
  await expect(page.getByTestId('effect-0')).toHaveAttribute('data-kind', 'dropShadow');

  // Edit each field: one command each.
  await commitField(page, 'Effect 1 X', '60');
  await commitField(page, 'Effect 1 Y', '60');
  await commitField(page, 'Effect 1 Blur', '0');
  await commitField(page, 'Effect 1 colour', '#0000ff');
  await commitField(page, 'Effect 1 opacity', '100');
  expect(await effects(page, a!)).toEqual([
    {
      kind: 'dropShadow',
      visible: true,
      color: { r: 0, g: 0, b: 1, a: 1 },
      offsetX: 60,
      offsetY: 60,
      radius: 0,
    },
  ]);
  if (rendering) {
    const [red, blue, canvas] = await pixels(page, [inside, shadowed, empty]);
    expect(distance(red!, [255, 0, 0]), `square ${JSON.stringify(red)}`).toBeLessThan(8);
    expect(distance(blue!, [0, 0, 255]), `shadow ${JSON.stringify(blue)}`).toBeLessThan(8);
    expect(distance(canvas!, before!), `empty canvas ${JSON.stringify(canvas)}`).toBeLessThan(8);
  }

  // Hide it: the shadow stops drawing; show it again.
  await page.getByTestId('effect-0-visible').click();
  expect((await effects(page, a!))[0]!.visible).toBe(false);
  if (rendering) {
    const [hidden] = await pixels(page, [shadowed]);
    expect(distance(hidden!, before!), `hidden shadow ${JSON.stringify(hidden)}`).toBeLessThan(8);
  }
  await page.getByTestId('effect-0-visible').click();
  expect((await effects(page, a!))[0]!.visible).toBe(true);

  // Add a layer blur and widen it: the square's edge spreads past its frame.
  await page.getByTestId('effects-add-blur').click();
  await expect(page.getByTestId('effect-1')).toHaveAttribute('data-kind', 'layerBlur');
  await commitField(page, 'Effect 2 Blur', '20');
  expect((await effects(page, a!))[1]).toEqual({ kind: 'layerBlur', visible: true, radius: 20 });
  if (rendering) {
    const [edge] = await pixels(page, [{ x: 104, y: 50 }]);
    expect(distance(edge!, before!), `blurred edge ${JSON.stringify(edge)}`).toBeGreaterThan(20);
  }

  // A second blur is refused with the notice and no change.
  await page.getByTestId('effects-add-blur').click();
  await expect(page.getByTestId('property-refusal')).toHaveText(
    'A layer takes at most 8 effects and one layer blur',
  );
  expect(await effects(page, a!)).toHaveLength(2);

  // Remove the blur, then the shadow; undo brings them back one step at a time.
  await page.getByTestId('effect-1-remove').click();
  await page.getByTestId('effect-0-remove').click();
  expect(await effects(page, a!)).toEqual([]);
  await expect(page.getByTestId('effect-0')).toHaveCount(0);
  await undo(page);
  expect(await effects(page, a!)).toHaveLength(1);
  await undo(page);
  expect(await effects(page, a!)).toHaveLength(2);
  await undo(page);
  expect((await effects(page, a!))[1]).toEqual({ kind: 'layerBlur', visible: true, radius: 4 });

  // K3: a caster left of the view whose shadow falls inside it still draws.
  await ok(page, { type: 'deleteNodes', ids: [a!] });
  const [b] = await ok(page, {
    type: 'createRectangle',
    frame: { x: -400, y: 0, width: 100, height: 100 },
    fill: RED,
    stroke: null,
  });
  await ok(page, { type: 'setSelection', ids: [b!] });
  await page.getByTestId('effects-add-shadow').click();
  await commitField(page, 'Effect 1 X', '450');
  await commitField(page, 'Effect 1 Blur', '0');
  await commitField(page, 'Effect 1 colour', '#0000ff');
  await commitField(page, 'Effect 1 opacity', '100');
  await ok(page, { type: 'setViewport', camera: { position: { x: -100, y: -100 }, zoom: 1 } });
  if (rendering) {
    const [cast] = await pixels(page, [{ x: 100, y: 50 }]);
    expect(
      distance(cast!, [0, 0, 255]),
      `off-screen caster's shadow ${JSON.stringify(cast)}`,
    ).toBeLessThan(8);
    const diagnostics = await page.evaluate(() =>
      (window as unknown as { __nextHostRenderer: CaptureHook }).__nextHostRenderer.diagnostics.map(
        (entry) => entry.code,
      ),
    );
    expect(diagnostics).not.toContain('render.effect-resource-limit');
  }
  expect(errors).toEqual([]);
});
