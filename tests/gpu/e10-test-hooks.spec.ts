import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type {
  E10Polygon,
  E10RenderResult,
  E10TestHooksApi,
} from '../../apps/playground/src/e10-test-hooks.js';

declare global {
  interface Window {
    __vectorStudioE10: E10TestHooksApi;
  }
}

// E10 contract, unit E10-U3, criterion E10-A7 (docs/plans/d9-e10-renderer-test-hooks-contract.md,
// section 6): the headed controls of the renderer test hooks, in Chrome and Edge, at forced 1x
// and 4x, DPR 1, 1.5 and 2, with the fringe on and off. Manual, never CI:
//
//   pnpm exec playwright test -c playwright.gpu.config.ts tests/gpu/e10-test-hooks.spec.ts
//
// Each test writes .tools/e10-test-hooks/<stamp>/<project>/samples<N>-dpr<D>.json with the
// adapter, the browser version and every control's outcome. DPR is the backend's input (the
// canvas is sized in physical pixels from it), not the browser's deviceScaleFactor. Functional evidence only: precision is
// UNVERIFIED against the 0.25 physical-pixel target and no Q4 threshold is claimed.

test.use({ trace: 'off' });

const runRoot = path.resolve(
  process.env.E10_TEST_HOOKS_OUTPUT_DIR ?? '.tools/e10-test-hooks',
  `${new Date().toISOString().replaceAll(/[:.]/gu, '-')}-${process.pid}`,
);

/** Physical bounds that are multiples of 6, so document = physical / DPR is exact. */
const RECT = Object.freeze({ x0: 12, y0: 6, x1: 60, y1: 42 });
const TRIANGLE = Object.freeze([66, 6, 90, 20, 70, 44]);
const MSAA_STEPS = [0, 64, 128, 191, 255];

function rectangle(id: string, dpr: number): E10Polygon {
  const { x0, y0, x1, y1 } = RECT;
  return { id, points: [x0, y0, x1, y0, x1, y1, x0, y1].map((value) => value / dpr) };
}

function triangle(id: string, dpr: number): E10Polygon {
  return { id, points: TRIANGLE.map((value) => value / dpr) };
}

type Decoded = Readonly<{
  result: E10RenderResult;
  rgba: Uint8Array;
  counts: Uint16Array;
}>;

async function render(page: Page, polygons: readonly E10Polygon[]): Promise<Decoded> {
  const result = await page.evaluate(
    (input) => window.__vectorStudioE10.render(input),
    polygons as E10Polygon[],
  );
  const rgba = new Uint8Array(Buffer.from(result.rgbaBase64, 'base64'));
  const bytes = Buffer.from(result.counts.base64, 'base64');
  const counts = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  return { result, rgba, counts };
}

/** Failures of one decoded capture against the pixel predicate, at most a few listed. */
function check(
  frame: Decoded,
  predicate: (x: number, y: number, r: number, counts: readonly number[]) => string | null,
): string[] {
  const { width, height } = frame.result;
  const samples = frame.result.counts.samples;
  const failures: string[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const counts = Array.from(frame.counts.subarray(pixel * samples, (pixel + 1) * samples));
      const failure = predicate(x, y, frame.rgba[pixel * 4]!, counts);
      if (failure !== null && failures.length < 8) failures.push(`(${x}, ${y}) ${failure}`);
    }
  }
  return failures;
}

const inside = (x: number, y: number) => x >= RECT.x0 && x < RECT.x1 && y >= RECT.y0 && y < RECT.y1;

/** E10-A7 (c), on every capture: all counts 0 means a black RGB pixel. */
function zeroCountsAreBlack(frame: Decoded): string[] {
  const { width, height } = frame.result;
  const samples = frame.result.counts.samples;
  const failures: string[] = [];
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const counts = frame.counts.subarray(pixel * samples, (pixel + 1) * samples);
    if (counts.some((count) => count !== 0)) continue;
    const rgb = frame.rgba.subarray(pixel * 4, pixel * 4 + 3);
    if (rgb.some((value) => value !== 0) && failures.length < 8) {
      failures.push(`pixel ${pixel} rgb ${Array.from(rgb).join(',')} with zero counts`);
    }
  }
  return failures;
}

for (const samples of [1, 4] as const) {
  for (const dpr of [1, 1.5, 2]) {
    test(`E10-A7 controls at ${samples}x, DPR ${dpr}`, async ({ browser, page }, info) => {
      test.setTimeout(120_000);
      const outcomes: Record<string, string[]> = {};
      const record = (name: string, failures: string[]) => {
        outcomes[name] = failures;
      };
      let pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      for (const fringe of ['on', 'off'] as const) {
        pageErrors = [];
        await page.goto(`/e10-test-hooks.html?samples=${samples}&fringe=${fringe}&dpr=${dpr}`);
        const ready = await page.evaluate(() => window.__vectorStudioE10.ready);
        expect(ready.supported, JSON.stringify(ready)).toBe(true);
        const label = `${fringe}`;
        // (h) For every capture: one frame, one prepare, and the record's triangles match.
        const matching = (name: string, frame: Decoded) => {
          const { result } = frame;
          const totals = (result.record?.draws ?? []).reduce(
            (sum, draw) => sum + draw.triangleCount,
            0,
          );
          record(
            `${label}/h-matching-${name}`,
            result.framesSubmittedDelta === 1 &&
              // A scene with no path keeps no draw record (the empty scene, loaded first).
              (result.prepareSerialDelta === 1 ||
                (result.record === null && result.meshTriangles === 0)) &&
              totals === result.meshTriangles
              ? []
              : [
                  `frames ${result.framesSubmittedDelta}, prepares ${result.prepareSerialDelta}, triangles ${totals} vs ${result.meshTriangles}`,
                ],
          );
        };

        // (e) An empty scene captures opaque black everywhere.
        const empty = await render(page, []);
        matching('empty', empty);
        record(
          `${label}/e-empty`,
          check(empty, (_x, _y, r) => (r === 0 ? null : `R ${r}`)).concat(
            empty.rgba.every((value, index) => value === (index % 4 === 3 ? 255 : 0))
              ? []
              : ['not all (0, 0, 0, 255)'],
          ),
        );

        // (a) An axis-aligned rectangle on integer physical bounds.
        const rect = await render(page, [rectangle('rect', dpr)]);
        // (f) The capture reports the forced sample count.
        record(
          `${label}/f-sample-count`,
          rect.result.sampleCount === samples ? [] : ['sampleCount'],
        );
        matching('rect', rect);
        record(
          `${label}/a-rect`,
          check(rect, (x, y, r, counts) => {
            const expected = inside(x, y) ? 255 : 0;
            if (r !== expected) return `R ${r}, expected ${expected}`;
            if (counts.some((count) => count > 1)) return `counts ${counts.join(',')}`;
            if (inside(x, y) && counts.some((count) => count !== 1)) {
              return `inside counts ${counts.join(',')}`;
            }
            return null;
          }),
        );
        record(`${label}/c-rect`, zeroCountsAreBlack(rect));
        if (fringe === 'off') {
          record(
            `${label}/b-no-exterior`,
            rect.result.record?.draws.every((draw) => draw.exteriorTriangles === 0) === true
              ? []
              : ['exterior triangles drawn with the fringe off'],
          );
        }

        // (b), (g) A rotated triangle: MSAA steps with the fringe off, analytic values with it on.
        const tri = await render(page, [triangle('tri', dpr)]);
        matching('triangle', tri);
        record(`${label}/c-triangle`, zeroCountsAreBlack(tri));
        const off = MSAA_STEPS.slice(0, samples === 4 ? 5 : 1).concat(samples === 1 ? [255] : []);
        const onStep = (r: number) => off.some((step) => Math.abs(step - r) <= 1);
        if (fringe === 'off') {
          record(
            `${label}/b-msaa-steps`,
            check(tri, (_x, _y, r) => (onStep(r) ? null : `R ${r} is not an MSAA step`)),
          );
          if (samples === 4) {
            record(
              `${label}/g-sample-match`,
              check(tri, (_x, _y, r, counts) => {
                const covered = counts.filter((count) => count >= 1).length;
                return Math.round((r * 4) / 255) === covered
                  ? null
                  : `R ${r} with ${covered} covered samples`;
              }),
            );
          }
        } else {
          let between = 0;
          check(tri, (_x, _y, r) => {
            if (!onStep(r)) between += 1;
            return null;
          });
          record(`${label}/b-analytic`, between > 0 ? [] : ['no value outside the MSAA steps']);
        }

        // (d) Negative control: two identical rectangles give a count of 2 inside.
        const doubled = await render(page, [rectangle('a', dpr), rectangle('b', dpr)]);
        matching('doubled', doubled);
        record(`${label}/c-doubled`, zeroCountsAreBlack(doubled));
        record(
          `${label}/d-doubled`,
          check(doubled, (x, y, _r, counts) =>
            inside(x, y) && counts.some((count) => count !== 2)
              ? `counts ${counts.join(',')}`
              : null,
          ),
        );
        record(`${label}/page-errors`, [...pageErrors]);
      }

      const directory = path.join(runRoot, info.project.name);
      mkdirSync(directory, { recursive: true });
      const adapter = await page.evaluate(() =>
        window.__vectorStudioE10.ready.then((ready) => ready.adapter),
      );
      writeFileSync(
        path.join(directory, `samples${samples}-dpr${dpr}.json`),
        `${JSON.stringify(
          {
            schema: 'e10-test-hooks/v1',
            browser: { name: info.project.name, version: browser.version() },
            adapter,
            samples,
            dpr,
            dprSource: 'backend-input',
            outcomes,
          },
          null,
          2,
        )}\n`,
      );
      const failed = Object.entries(outcomes).filter(([, failures]) => failures.length > 0);
      expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    });
  }
}
