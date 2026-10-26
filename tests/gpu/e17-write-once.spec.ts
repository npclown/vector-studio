import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import type {
  E10Polygon,
  E10RenderResult,
  E10TestHooksApi,
} from '../../apps/playground/src/e10-test-hooks.js';
import type {
  VizV4CorpusApi,
  VizV4RenderResult,
} from '../../apps/playground/src/viz-v4-a08-corpus.js';
import { caseInput, variantQuery } from '../visual/viz-v4/cases.js';
import { a08Subset } from '../visual/viz-v4/subset.js';

declare global {
  interface Window {
    __vectorStudioE10: E10TestHooksApi;
    __vectorStudioVizV4: VizV4CorpusApi;
  }
}

// E17 contract, unit E17-U2, criterion E17-A5 (docs/plans/d9-e17-mesh-write-once-coverage-
// contract.md, section 5): the headed checks of the write-once stencil, in Chrome and Edge.
// Manual, never CI; it needs `pnpm build` and the release WASM:
//
//   pnpm exec playwright test -c playwright.gpu.config.ts tests/gpu/e17-write-once.spec.ts
//
// 1. The section 1 fixtures on the V-4 page at fringe-1x and fringe-4x: every sample count is at
//    most 1, every pixel with nonzero red has all its counts equal to 1, and wherever both
//    variants cover a pixel once per sample their red values agree within 2/255 (the fringe
//    shades each covered sample with the pixel-centre value, so 4x equals 1x without double
//    coverage; before E17, C4/n06/T2 dpr1.5 pixel (491,268) differed by 22). A fixture with no
//    visible pixel in either variant has nothing to compare.
// 2. The reset path on the E10 page, at 1x and 4x: 511 mesh draws (two stencil resets) with one
//    rectangle drawn at ordinals 0, 255 and 510, which share reference 1, counts exactly 3 inside,
//    so a reset separates draws that share a reference, and the frame has no page or console
//    error.
// Each test writes .tools/e17-write-once/<stamp>/<project>/<name>.json. Functional evidence only.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.E17_OUTPUT_DIR ?? '.tools/e17-write-once',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

/** The section 1 fixture keys (V-4 subset keys, with their DPR). */
const FIXTURES = [
  'C4/n06/T0/z1-d1/center/k0@dpr1.5',
  'C4/n06/T2/z1-d1/center/k0@dpr1.5',
  'C4/n07/T2/z1-d1/center/k0@dpr1.5',
  'C4/n11/T2/z1-d1/center/k0@dpr1.5',
  'C4/n12/T2/z1-d1/center/k0@dpr1',
  'C4/n12/T2/z1-d2/center/k0@dpr2',
  'C4/n13/T2/z1-d1/center/k0@dpr1',
  'C4/n13/T2/z1-d2/center/k0@dpr2',
  'C3/c11/T2/z1-d1/center/k0@dpr1',
  'C1/s04-I/T7/z1-d2/center/k0@dpr2',
  'C3/c01/T7/z1-d2/center/k0@dpr2',
  'C3/c02/T7/z1-d2/center/k0@dpr2',
  'C3/c03/T7/z1-d2/center/k0@dpr2',
  'C3/c04/T7/z1-d2/center/k0@dpr2',
  'C3/c05/T7/z1-d2/center/k0@dpr2',
  'C3/c13/T7/z1-d2/center/k0@dpr2',
  'C3/c14/T7/z1-d1/center/k0@dpr1.5',
  'C3/c14/T7/z1-d2/center/k0@dpr2',
  'C3/c17/T7/z1-d1/center/k0@dpr1.5',
  'C3/c17/T7/z1-d2/center/k0@dpr2',
  'C3/c24/T7/z1-d2/center/k0@dpr2',
  'C3/c26/T7/z1-d2/center/k0@dpr2',
  'C3/c28/T7/z1-d2/center/k0@dpr2',
  'C3/c29/T7/z1-d2/center/k0@dpr2',
] as const;

/** Product-side pixels named by E17-A5: (key, x, y). */
const NAMED_PIXELS = [
  ['C4/n06/T2/z1-d1/center/k0@dpr1.5', 491, 268],
  ['C4/n06/T0/z1-d1/center/k0@dpr1.5', 492, 257],
] as const;

type Capture = Readonly<{ red: Uint8Array; counts: Uint16Array; samples: number; width: number }>;

function decode(result: VizV4RenderResult | E10RenderResult): Capture {
  const rgba = new Uint8Array(Buffer.from(result.rgbaBase64, 'base64'));
  const red = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < red.length; i += 1) red[i] = rgba[i * 4]!;
  const bytes = Buffer.from(result.counts.base64, 'base64');
  const counts = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  return { red, counts, samples: result.counts.samples, width: result.width };
}

const countsAt = (c: Capture, pixel: number) =>
  Array.from(c.counts.subarray(pixel * c.samples, (pixel + 1) * c.samples));

function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // A headed browser requests /favicon.ico, which the playground does not serve; that 404 is
    // not an error of the frame.
    if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico'))
      errors.push(message.text());
  });
  return errors;
}

function write(info: { project: { name: string } }, name: string, body: unknown): void {
  const directory = path.join(runRoot, info.project.name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

test('E17-A5 fixtures: count at most 1, covered pixels counted once, 4x equals 1x', async ({
  browser,
  page,
}, info) => {
  test.setTimeout(1_800_000);
  const subset = new Map(a08Subset().map((c) => [c.key, c]));
  const errors = errorsOf(page);
  const failures: Record<string, string[]> = {};
  const fail = (key: string, message: string) => {
    const list = (failures[key] ??= []);
    if (list.length < 8) list.push(message);
  };
  const captures = new Map<string, Capture>();
  const dprs = [...new Set(FIXTURES.map((key) => subset.get(key)!.dpr))];
  for (const variant of ['fringe-1x', 'fringe-4x'] as const) {
    for (const dpr of dprs) {
      const { samples, fringe } = variantQuery(variant);
      await page.goto(
        `/viz-v4-a08-corpus.html?samples=${String(samples)}&fringe=${fringe}&dpr=${String(dpr)}`,
      );
      await page.waitForFunction(() => window.__vectorStudioVizV4 !== undefined, undefined, {
        timeout: 60_000,
      });
      const ready = await page.evaluate(() => window.__vectorStudioVizV4.ready);
      expect(ready.supported, String(ready.reason)).toBe(true);
      for (const key of FIXTURES.filter((k) => subset.get(k)!.dpr === dpr)) {
        const result = await page.evaluate(
          (input) => window.__vectorStudioVizV4.render(input),
          caseInput(subset.get(key)!),
        );
        expect(result.sampleCount, key).toBe(samples);
        const capture = decode(result);
        captures.set(`${variant} ${key}`, capture);
        for (let pixel = 0; pixel < capture.red.length; pixel += 1) {
          const counts = countsAt(capture, pixel);
          const x = pixel % capture.width;
          const y = Math.floor(pixel / capture.width);
          if (counts.some((count) => count > 1))
            fail(`${variant} ${key}`, `(${x},${y}) counts ${counts.join(',')}`);
          else if (capture.red[pixel]! > 0 && counts.some((count) => count !== 1))
            fail(
              `${variant} ${key}`,
              `(${x},${y}) red ${capture.red[pixel]} counts ${counts.join(',')}`,
            );
        }
      }
    }
  }
  const named: Record<string, unknown> = {};
  const compared: Record<string, number> = {};
  for (const key of FIXTURES) {
    const one = captures.get(`fringe-1x ${key}`)!;
    const four = captures.get(`fringe-4x ${key}`)!;
    let pixels = 0;
    for (let pixel = 0; pixel < one.red.length; pixel += 1) {
      if (one.red[pixel] === 0 && four.red[pixel] === 0) continue;
      const once = (c: Capture) => countsAt(c, pixel).every((count) => count === 1);
      if (!once(one) || !once(four)) continue;
      pixels += 1;
      const difference = Math.abs(one.red[pixel]! - four.red[pixel]!);
      if (difference > 2)
        fail(
          `1x-4x ${key}`,
          `(${pixel % one.width},${Math.floor(pixel / one.width)}) 1x ${one.red[pixel]} 4x ${four.red[pixel]}`,
        );
    }
    compared[key] = pixels;
    // A fixture with no visible pixel in either variant (C3/c02/T7 dpr2 draws none) has nothing
    // to compare; one with visible pixels but none counted once in both is a failure.
    const visible = (c: Capture) => c.red.some((red) => red > 0);
    if (pixels === 0 && (visible(one) || visible(four)))
      fail(`1x-4x ${key}`, 'visible pixels, none compared');
  }
  for (const [key, x, y] of NAMED_PIXELS) {
    const one = captures.get(`fringe-1x ${key}`)!;
    const four = captures.get(`fringe-4x ${key}`)!;
    const pixel = y * one.width + x;
    named[`${key} (${x},${y})`] = {
      red1x: one.red[pixel],
      red4x: four.red[pixel],
      counts1x: countsAt(one, pixel),
      counts4x: countsAt(four, pixel),
    };
  }
  write(info, 'fixtures', {
    schema: 'e17-write-once/v1',
    browser: { name: info.project.name, version: browser.version() },
    fixtures: FIXTURES.length,
    compared,
    named,
    failures,
    errors,
  });
  expect(errors).toEqual([]);
  expect(failures, JSON.stringify(failures, null, 2)).toEqual({});
});

for (const samples of [1, 4] as const) {
  test(`E17-A5 reset path: 511 mesh draws, rectangle A at ordinals 0, 255 and 510, at ${String(samples)}x`, async ({
    browser,
    page,
  }, info) => {
    test.setTimeout(300_000);
    const errors = errorsOf(page);
    await page.goto(`/e10-test-hooks.html?samples=${String(samples)}&fringe=on&dpr=1`);
    const ready = await page.evaluate(() => window.__vectorStudioE10.ready);
    expect(ready.supported, JSON.stringify(ready)).toBe(true);
    // Ordinals 0, 255 and 510 share reference 1. Without a working reset, the draw at 255 would
    // meet reference 1 left by ordinal 0 on A and be rejected, so A would count 1, not 3.
    const a = [12, 6, 60, 6, 60, 42, 12, 42];
    const filler = [70, 10, 86, 10, 86, 26, 70, 26];
    const polygons: E10Polygon[] = Array.from({ length: 511 }, (_, i) => ({
      id: `r${String(i)}`,
      points: i % 255 === 0 ? a : filler,
    }));
    const result = await page.evaluate((input) => window.__vectorStudioE10.render(input), polygons);
    const capture = decode(result);
    const failures: string[] = [];
    for (let pixel = 0; pixel < capture.red.length; pixel += 1) {
      const x = pixel % capture.width;
      const y = Math.floor(pixel / capture.width);
      // A's interior, away from its fringe and from the filler's frame.
      if (!(x >= 15 && x < 57 && y >= 9 && y < 39)) continue;
      const counts = countsAt(capture, pixel);
      if (counts.some((count) => count !== 3) || capture.red[pixel] !== 255) {
        if (failures.length < 8)
          failures.push(`(${x},${y}) red ${capture.red[pixel]} counts ${counts.join(',')}`);
      }
    }
    const draws = result.record?.draws.length ?? 0;
    write(info, `reset-${String(samples)}x`, {
      schema: 'e17-write-once/v1',
      browser: { name: info.project.name, version: browser.version() },
      samples,
      draws,
      failures,
      errors,
    });
    expect(draws).toBe(511);
    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  });
}
