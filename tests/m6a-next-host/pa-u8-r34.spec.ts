import type { TextLayoutResult } from '@vector-studio/contracts';
import { expect, test, type Page } from '@playwright/test';
import type { TextTestHook } from '../../apps/next-host/src/m6a-text-host';

// Pre-alpha gate, unit PA-U8, criterion PA-A09 (R34 half, "System fonts and host-provided web
// fonts" by name): on the main PC (Windows), in headed Chrome and Edge, text runs naming a
// Windows system font lay out in that font. For each system family the laid-out word boundaries
// and run end match the browser's own canvas measure of the same text in that family, and the
// laid-out advances differ from those of a family no machine has.
//
// `Malgun Gothic` is also the tail of text-dom's font list (packages/text-dom/src/css.ts,
// FONT_LIST_TAIL), so a missing family resolves to it and the two runs' advances are equal by
// design; the "differs from a missing family" half is therefore checked with `Times New Roman`,
// another Windows system font, which is not in the tail (PA-A09 amendment, plan section 10,
// 2026-11-04). The `chromium-smoke` project has no Windows fonts and skips.

type TextHolder = Readonly<{ text: TextTestHook }>;

const MISSING = 'PA-U8 No Such Family';
const SIZE = 20;
/** Agreement with the canvas measure: within Chromium's layout rounding (M6a-A11 uses 0.05). */
const TOLERANCE = 0.05;

const CASES = [
  { family: 'Malgun Gothic', sample: 'Vector 한글 studio', tail: true },
  { family: 'Times New Roman', sample: 'Vector studio and paths', tail: false },
] as const;

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?test=1&fixture=text');
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  await expect(status).toHaveAttribute('data-fixture', 'loaded', { timeout: 30_000 });
  return errors;
}

type Reading = Readonly<{
  installed: boolean;
  named: readonly (readonly [number, number])[];
  missing: readonly (readonly [number, number])[];
  /** Each word boundary's x (a space cluster's start and end), then the last cluster's end. */
  laidOut: readonly number[];
  /** The canvas width of the text before each boundary, then of the whole text, in the family. */
  canvas: readonly number[];
}>;

async function read(page: Page, family: string, sample: string): Promise<Reading> {
  return page.evaluate(
    ({ family, sample, missing, size }) => {
      const text = (window.__p5Host as unknown as TextHolder).text;
      const req = (runFamily: string) => ({
        runs: [{ text: sample, family: runFamily, size }],
        width: null,
        align: 'left' as const,
        letterSpacing: 0,
        lineHeight: 1.2,
      });
      const canvas = new OffscreenCanvas(8, 8).getContext('2d')!;
      // Installed if the family changes the measure against any generic: Times New Roman is
      // Chrome's default serif on Windows, so it equals `serif` but not the other two.
      const installed = ['monospace', 'serif', 'sans-serif'].some((generic) => {
        canvas.font = `40px ${generic}`;
        const plain = canvas.measureText('abcdefghijklmnopqrstuvwxyz').width;
        canvas.font = `40px "${family}", ${generic}`;
        return canvas.measureText('abcdefghijklmnopqrstuvwxyz').width !== plain;
      });
      const pick = (r: TextLayoutResult) => r.clusters.map((c) => [c.x, c.advance] as const);
      const named = text.port.layout(req(family));
      canvas.font = `${size}px "${family}"`;
      const last = named.clusters[named.clusters.length - 1]!;
      const width = (end: number) => canvas.measureText(sample.slice(0, end)).width;
      // Pair kerning moves a glyph by its neighbour, so a prefix's canvas width equals the next
      // cluster's x only where no kerning pair spans the cut: at the spaces between words, with
      // lowercase letters or Hangul beside each space (Times has space pairs only before capitals
      // such as A, T, V, W and Y, so the samples avoid them).
      const spaces = named.clusters.filter((c) => sample.slice(c.start, c.end) === ' ');
      return {
        installed,
        named: pick(named),
        missing: pick(text.port.layout(req(missing))),
        laidOut: [...spaces.flatMap((c) => [c.x, c.x + c.advance]), last.x + last.advance],
        canvas: [...spaces.flatMap((c) => [width(c.start), width(c.end)]), width(sample.length)],
      };
    },
    { family, sample, missing: MISSING, size: SIZE },
  );
}

for (const testCase of CASES) {
  test(`PA-A09 R34: "${testCase.family}" lays out in the named system font`, async ({ page }) => {
    test.skip(
      test.info().project.name === 'chromium-smoke',
      'needs the Windows system fonts of the main PC',
    );
    const errors = await open(page);
    const reading = await read(page, testCase.family, testCase.sample);
    expect(reading.installed, `${testCase.family} is installed`).toBe(true);
    expect(reading.named.length).toBeGreaterThan(0);
    // At each word boundary the laid-out position equals the browser's canvas width of the text
    // before it, in that family (kerning included), and the run ends at the whole text's width.
    const deltas = reading.laidOut.map((x, index) => Math.abs(x - reading.canvas[index]!));
    test.info().annotations.push({
      type: `${testCase.family} max |layout - canvas|`,
      description: String(Math.max(...deltas)),
    });
    expect(Math.max(...deltas)).toBeLessThanOrEqual(TOLERANCE);
    if (testCase.tail) {
      // The font list's tail: a missing family resolves to this face, so the runs are equal.
      expect(reading.missing).toEqual(reading.named);
    } else {
      expect(reading.missing).not.toEqual(reading.named);
    }
    expect(errors).toEqual([]);
  });
}
