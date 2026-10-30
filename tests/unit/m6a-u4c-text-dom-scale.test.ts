import type { TextLayoutRequest, TextLayoutResult } from '@vector-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTextDom } from '../../packages/text-dom/src/index.js';
import type { Measurement } from '../../packages/text-dom/src/measure.js';
import {
  extentBound,
  MAX_MEASURED_EXTENT,
  MAX_MEASURED_SIZE,
  measurementScale,
  REFERENCE_SCALE,
  scaleRequest,
  unscaleResult,
} from '../../packages/text-dom/src/scale.js';

// MVP M6a-U4c (docs/plans/mvp-m6a-text-model-contract.md, section 3.2, M6-Q3 (b)): text-dom
// measures every request at a power-of-two scale `s` (the reference scale R = 64, lowered while
// the largest run × s exceeds 2048 px or the extent bound × s exceeds 2^24 px) and divides the
// result by `s`. Here: the scale rule, the
// scaled request, the exact division, and that `layout` hands the measurer the scaled request
// and returns page units. The browser half is M6a-A12's size-linearity test (headed spec).

const measured = vi.hoisted(() => ({ requests: [] as TextLayoutRequest[] }));

// A stand-in measurer: one grapheme per UTF-16 unit, 0.6 em wide, a baseline and block height
// rounded to whole px as Chromium rounds font metrics, all in the measured block's px.
vi.mock('../../packages/text-dom/src/measure.js', () => ({
  createMeasurer: () => ({
    measure(request: TextLayoutRequest): Measurement {
      measured.requests.push(request);
      const size = request.runs[0]!.size;
      const text = request.runs.map((run) => run.text).join('');
      const graphemes = Array.from(text, (_, index) => ({
        start: index,
        end: index + 1,
        run: 0,
        lf: false,
        space: false,
        // 0.6 em advances and a rect from the line top; 0.6 is not a binary fraction.
        rect: { left: index * 0.6 * size, top: 0, width: 0.6 * size, height: 1.2 * size },
        baseline: 0.9 * size,
      }));
      return {
        graphemes,
        lines: [{ start: 0, end: text.length, graphemes: graphemes.map((_, index) => index) }],
        metrics: [{ top: 0, baseline: Math.round(0.9 * size) }],
        blockHeight: Math.round(1.2 * size),
      };
    },
    remove() {},
  }),
}));

const request = (overrides: Partial<TextLayoutRequest> = {}): TextLayoutRequest => ({
  runs: [{ text: 'ab', family: 'Inter', size: 10 }],
  width: null,
  align: 'left',
  letterSpacing: 0,
  lineHeight: 1.2,
  ...overrides,
});

const sizes = (...values: number[]): Partial<TextLayoutRequest> => ({
  runs: values.map((size) => ({ text: 'a', family: 'Inter', size })),
});

function shimDocument(): Document {
  const fonts = Object.assign(new EventTarget(), { add() {}, delete() {} });
  const view = {
    devicePixelRatio: 1,
    matchMedia: (media: string) => Object.assign(new EventTarget(), { media }),
  };
  return { nodeType: 9, defaultView: view, fonts } as unknown as Document;
}

describe('M6a-U4c measurement scale (section 3.2, M6-Q3 (b))', () => {
  it('uses R = 64 up to size 32 and halves while the largest run exceeds 2048 px, never below 1', () => {
    expect(REFERENCE_SCALE).toBe(64);
    expect(MAX_MEASURED_SIZE).toBe(2048);
    expect(measurementScale(request(sizes(0.5)))).toBe(64);
    expect(measurementScale(request(sizes(20)))).toBe(64);
    expect(measurementScale(request(sizes(32)))).toBe(64);
    expect(measurementScale(request(sizes(32.5)))).toBe(32);
    expect(measurementScale(request(sizes(80)))).toBe(16);
    expect(measurementScale(request(sizes(1024)))).toBe(2);
    expect(measurementScale(request(sizes(1025)))).toBe(1);
    expect(measurementScale(request(sizes(4096)))).toBe(1);
    // The largest run decides for the whole request, so all runs share one scale.
    expect(measurementScale(request(sizes(10, 40, 20)))).toBe(32);
    // Sizes a power of two apart land on the same measured size below the cap (A12's s and 4s).
    for (const size of [40, 100, 255]) {
      const one = request(sizes(size));
      const four = request(sizes(4 * size));
      expect(size * measurementScale(one)).toBe(4 * size * measurementScale(four));
    }
  });

  it('halves the scale while a long node would pass the layout unit range (review)', () => {
    expect(MAX_MEASURED_EXTENT).toBe(2 ** 24);
    // 8192 one-character lines at lineHeight 2.5: 32 × 16,384 units × 2.5 em = 1,310,720 px, so
    // 64 (83,886,080 px, past Chromium's 2^25) and 16 give way to 8.
    const lines = request({
      runs: [{ text: `${'a\n'.repeat(8191)}a`, family: 'Inter', size: 32 }],
      lineHeight: 2.5,
    });
    expect(extentBound(lines)).toBe(32 * 16_384 * 2.5);
    expect(measurementScale(lines)).toBe(8);
    expect(extentBound(lines) * measurementScale(lines)).toBeLessThanOrEqual(MAX_MEASURED_EXTENT);
    // 16,384 × "a" at 10 em letter spacing: 32 × 16,385 × 12 em per unit.
    const spaced = request({
      runs: [{ text: 'a'.repeat(16_384), family: 'Inter', size: 32 }],
      letterSpacing: 10,
    });
    expect(extentBound(spaced)).toBe(32 * 16_385 * 12);
    expect(measurementScale(spaced)).toBe(2);
    // Negative letter spacing never lowers the 2 em per unit; never below 1.
    expect(extentBound(request({ letterSpacing: -5 }))).toBe(10 * 3 * 2);
    const huge = request({
      runs: [{ text: 'a'.repeat(16_384), family: 'Inter', size: 4096 }],
      lineHeight: 10,
    });
    expect(measurementScale(huge)).toBe(1);
  });

  it('scales sizes and the width only; letter spacing (em) and line height stay', () => {
    const original = request({
      runs: [
        { text: 'a', family: 'Inter', size: 10 },
        { text: 'b', family: 'Noto', size: 0.75 },
      ],
      width: 33.3,
      align: 'center',
      letterSpacing: -0.1,
      lineHeight: 0.3,
    });
    expect(scaleRequest(original, 64)).toEqual({
      runs: [
        { text: 'a', family: 'Inter', size: 640 },
        { text: 'b', family: 'Noto', size: 48 },
      ],
      width: 33.3 * 64,
      align: 'center',
      letterSpacing: -0.1,
      lineHeight: 0.3,
    });
    expect(scaleRequest(request({ width: null }), 64).width).toBeNull();
    // A width that would overflow stays finite.
    expect(scaleRequest(request({ width: Number.MAX_VALUE }), 2).width).toBe(Number.MAX_VALUE);
    // The request itself is not changed.
    expect(original.runs[0]!.size).toBe(10);
  });

  it('divides every length exactly, keeps the rest and a fixed width as requested', () => {
    const scaled: TextLayoutResult = {
      generation: 3,
      lang: 'ko',
      width: 1000.5,
      height: 1536,
      fontLists: ['"Inter"'],
      lines: [{ start: 0, end: 2, top: 0, height: 1536, baseline: 1300.015625, left: 7, width: 3 }],
      clusters: [
        { start: 0, end: 1, line: 0, run: 0, x: 7, y: 1300.015625, advance: -0.015625 },
        { start: 1, end: 2, line: 0, run: 0, x: 6.984375, y: 1300.015625, advance: 0 },
      ],
    };
    const result = unscaleResult(scaled, request({ width: null }), 64);
    expect(result).toEqual({
      generation: 3,
      lang: 'ko',
      width: 1000.5 / 64,
      height: 24,
      fontLists: ['"Inter"'],
      lines: [
        {
          start: 0,
          end: 2,
          top: 0,
          height: 24,
          baseline: 1300.015625 / 64,
          left: 7 / 64,
          width: 3 / 64,
        },
      ],
      clusters: [
        {
          start: 0,
          end: 1,
          line: 0,
          run: 0,
          x: 7 / 64,
          y: 1300.015625 / 64,
          advance: -0.015625 / 64,
        },
        { start: 1, end: 2, line: 0, run: 0, x: 6.984375 / 64, y: 1300.015625 / 64, advance: 0 },
      ],
    });
    // Dividing by a power of two is exact: multiplying back gives the measured values.
    expect(result.lines[0]!.baseline * 64).toBe(1300.015625);
    expect(result.clusters[0]!.advance * 64).toBe(-0.015625);
    expect(unscaleResult(scaled, request({ width: 15.5 }), 64).width).toBe(15.5);
  });

  it('measures layout requests at the scale and returns page units, deterministically', () => {
    const dom = createTextDom({ document: shimDocument() });
    measured.requests = [];
    const small = request({ runs: [{ text: 'abc', family: 'Inter', size: 10 }], width: 50 });
    const first = dom.layout(small);
    const again = dom.layout(small);
    expect(measured.requests.map((value) => [value.runs[0]!.size, value.width])).toEqual([
      [640, 3200],
      [640, 3200],
    ]);
    expect(again).toEqual(first);
    // The measured block's whole-pixel rounding (0.9 × 640 = 576, 1.2 × 640 = 768) comes back
    // divided by 64; advances are the measured rects / 64.
    expect(first.width).toBe(50);
    expect(first.height).toBe(768 / 64);
    expect(first.lines[0]!.baseline).toBe(576 / 64);
    expect(first.clusters.map((cluster) => cluster.advance)).toEqual(
      Array(3).fill((0.6 * 640) / 64),
    );
    expect(first.clusters.map((cluster) => cluster.x)).toEqual(
      [0, 1, 2].map((index) => (index * 0.6 * 640) / 64),
    );
    // Size 4096 is measured unscaled.
    dom.layout(request({ runs: [{ text: 'A', family: 'Inter', size: 4096 }] }));
    expect(measured.requests.at(-1)!.runs[0]!.size).toBe(4096);
    expect(dom.fallbacks).toBe(0);
    dom.dispose();
  });
});
