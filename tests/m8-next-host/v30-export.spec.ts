import type { Command, Editor } from '@vector-studio/editor-core';
import { expect, test, type Download, type Page } from '@playwright/test';

// V-30 export contract (docs/plans/viz-v30-export-contract.md), V30-A04 and V30-A05: the
// studio's Export section on the next-host page (`?test=1&layout=studio`), with real clicks.
// Each export is caught as a download; a PNG is decoded in the page and probed, an SVG read as
// text. Runs in the M8 next-host config (headed Chrome and Edge, or the headless smoke projects
// with M8_NEXT_HOST_CHROMIUM: the export paints with Canvas 2D, so it needs no WebGPU).

type Hook = Readonly<{ editor: Editor }>;
type Rgba = readonly [number, number, number, number];

const RED = { r: 1, g: 0, b: 0, a: 1 };
const GREEN = { r: 0, g: 1, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&layout=studio');
  await page.waitForFunction(
    () => (window as unknown as { __p5Host?: Hook }).__p5Host !== undefined,
  );
  await expect(page.getByTestId('studio')).toBeVisible();
  await expect(page.getByTestId('export-panel')).toBeVisible();
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

/** Clicks the Export button and returns the download it starts. */
async function exportFile(page: Page, format: 'png' | 'svg', scale = '1'): Promise<Download> {
  await page.getByLabel('Export format').selectOption(format);
  if (format === 'png') await page.getByLabel('Export scale').selectOption(scale);
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

/** Decodes a PNG in the page: its size and the RGBA of each probe point (image pixels). */
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
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let ink = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 0) ink += 1;
      return {
        width: bitmap.width,
        height: bitmap.height,
        ink,
        probes: points.map(([x, y]) => {
          const at = (y * bitmap.width + x) * 4;
          return [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!, pixels[at + 3]!] as const;
        }),
      };
    },
    { base64: png.toString('base64'), points: probes as [number, number][] },
  );
}

function near(actual: Rgba, expected: Rgba, label: string, tolerance = 2) {
  actual.forEach((value, index) =>
    expect(
      Math.abs(value - expected[index]!),
      `${label} channel ${index}: ${actual.join(',')}`,
    ).toBeLessThanOrEqual(tolerance),
  );
}

test('V30-A04/A05: export the page, an artboard at 2x, SVG and text from the studio', async ({
  page,
}) => {
  const errors = await open(page);
  const button = page.getByTestId('export-button');
  // An empty page has nothing to export.
  await expect(button).toBeDisabled();

  const [red] = await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 40, height: 40 },
    name: 'Red',
    fill: RED,
    stroke: null,
  });
  const [frame] = await ok(page, {
    type: 'createFrame',
    frame: { x: 100, y: 0, width: 60, height: 60 },
    name: 'Card',
    fill: GREEN,
    stroke: null,
  });
  await ok(page, {
    type: 'createRectangle',
    frame: { x: 130, y: 30, width: 60, height: 60 },
    fill: BLUE,
    stroke: null,
    parent: frame!,
  });
  await ok(page, {
    type: 'createRectangle',
    frame: { x: 0, y: 100, width: 100, height: 20 },
    stroke: null,
    fill: {
      kind: 'linear',
      transform: [1, 0, 0, 1, 0, 0],
      stops: [
        { offset: 0, color: RED },
        { offset: 1, color: BLUE },
      ],
      spread: 'pad',
    },
  });
  await ok(page, { type: 'setSelection', ids: [] });

  // The page at 1x: bounds (0, 0) to (160, 120); the frame clips its child.
  await expect(button).toHaveText(/^Export page /);
  const pageFile = await exportFile(page, 'png', '1');
  expect(pageFile.suggestedFilename()).toMatch(/^.+\.png$/);
  expect(pageFile.suggestedFilename()).not.toContain('@');
  const whole = await decode(page, await bytes(pageFile), [
    [20, 20],
    [120, 10],
    [150, 50],
    [170 - 11, 59],
    [2, 110],
    [97, 110],
    [70, 50],
  ]);
  expect([whole.width, whole.height]).toEqual([160, 120]);
  near(whole.probes[0]!, [255, 0, 0, 255], 'red rectangle');
  near(whole.probes[1]!, [0, 255, 0, 255], 'frame background');
  near(whole.probes[2]!, [0, 0, 255, 255], 'frame child');
  near(whole.probes[3]!, [0, 0, 255, 255], 'frame child at the frame edge');
  expect(whole.probes[4]![0]).toBeGreaterThan(200);
  expect(whole.probes[5]![2]).toBeGreaterThan(200);
  near(whole.probes[6]!, [0, 0, 0, 0], 'transparent background');

  // The artboard at 2x: 120 × 120, the child cut at the frame edge.
  await ok(page, { type: 'setSelection', ids: [frame!] });
  await expect(button).toHaveText('Export Card');
  const card = await exportFile(page, 'png', '2');
  expect(card.suggestedFilename()).toBe('Card@2x.png');
  const artboard = await decode(page, await bytes(card), [
    [20, 20],
    [100, 100],
    [119, 119],
  ]);
  expect([artboard.width, artboard.height]).toEqual([120, 120]);
  near(artboard.probes[0]!, [0, 255, 0, 255], 'artboard background');
  near(artboard.probes[1]!, [0, 0, 255, 255], 'artboard child');
  near(artboard.probes[2]!, [0, 0, 255, 255], 'artboard child at the corner');

  // SVG: the scale is disabled and the file is the SVG text.
  await ok(page, { type: 'setSelection', ids: [red!] });
  await page.getByLabel('Export format').selectOption('svg');
  await expect(page.getByLabel('Export scale')).toBeDisabled();
  const svgFile = await exportFile(page, 'svg');
  expect(svgFile.suggestedFilename()).toBe('Red.svg');
  const svg = (await bytes(svgFile)).toString('utf8');
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  expect(svg).toContain('viewBox="0 0 40 40"');
  expect(svg).toContain('fill="#ff0000"');

  // Text: the PNG has ink inside the text node's box.
  const [text] = await ok(page, {
    type: 'createText',
    frame: { x: 0, y: 200, width: 10, height: 10 },
    runs: [{ text: 'Export 내보내기', family: 'Noto Sans KR', size: 32, color: RED }],
  });
  await ok(page, { type: 'setSelection', ids: [text!] });
  const textFile = await exportFile(page, 'png', '1');
  const ink = await decode(page, await bytes(textFile), []);
  expect(ink.width).toBeGreaterThan(100);
  expect(ink.ink).toBeGreaterThan(200);

  // Every target hidden: nothing to export.
  await ok(page, { type: 'setNodeProps', id: text!, props: { visible: false } });
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-message')).toHaveText('Nothing to export');

  expect(errors).toEqual([]);
});
