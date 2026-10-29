import type {
  TextLayoutPort,
  TextLayoutRequest,
  TextLayoutResult,
  TextLayoutRun,
} from '@vector-studio/contracts';
import { SCENE_TEXT_MAX_CLUSTER_UNITS } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  createFakeTextLayout,
  fakeCodePointAdvance,
  fakeFontList,
  fakeLayout,
} from '../support/fake-text-layout.js';

// M6a contract (docs/plans/mvp-m6a-text-model-contract.md), M6a-A05: the fake port's section 5
// rules (advances, breaks, hanging spaces, line metrics, alignment, M6a-L1 lines, clusters and the
// long-cluster rule) on literal requests with literal results, determinism, and its generation.

const FONT = '"Fake", sans-serif';

function run(text: string, size = 10, family = 'Fake'): TextLayoutRun {
  return { text, family, size };
}

function request(
  runs: readonly TextLayoutRun[],
  options: Partial<Omit<TextLayoutRequest, 'runs'>> = {},
): TextLayoutRequest {
  return {
    runs,
    width: options.width ?? null,
    align: options.align ?? 'left',
    letterSpacing: options.letterSpacing ?? 0,
    lineHeight: options.lineHeight ?? 1,
  };
}

function layout(value: TextLayoutRequest): TextLayoutResult {
  return createFakeTextLayout().layout(value);
}

// Size 10, line height 1: every line is 10 high with its baseline 8 below its top.
function line(start: number, end: number, index: number, left: number, width: number) {
  return { start, end, top: 10 * index, height: 10, baseline: 10 * index + 8, left, width };
}

describe('M6a-A05 fake text layout: advances and font lists', () => {
  it('gives each code point class its em advance', () => {
    const table: [string, number][] = [
      [' ', 0.25],
      ['\u0301', 0],
      ['\u200d', 0],
      ['\u00ad', 0],
      ['\ufe0f', 0],
      ['\u{e0100}', 0],
      ['가', 1],
      ['漢', 1],
      ['\u3000', 1],
      ['\u3002', 1],
      ['\uff01', 1],
      ['\u{1f469}', 1],
      ['a', 0.5],
      ['\u{1f3fd}', 0.5],
      ['\u{1f1f0}', 0.5],
    ];
    for (const [codePoint, em] of table) expect(fakeCodePointAdvance(codePoint)).toBe(em);
  });

  it('quotes the family and escapes quotes and backslashes', () => {
    expect(fakeFontList('Noto Sans KR')).toBe('"Noto Sans KR", sans-serif');
    expect(fakeFontList('a"b\\c')).toBe('"a\\"b\\\\c", sans-serif');
    expect(layout(request([run('a'), run('b', 12, 'Other')])).fontLists).toStrictEqual([
      FONT,
      '"Other", sans-serif',
    ]);
  });
});

describe('M6a-A05 fake text layout: committed results', () => {
  it('lays out Hangul at 1 em per syllable', () => {
    expect(layout(request([run('가나')], { lineHeight: 1.2 }))).toStrictEqual({
      generation: 0,
      lang: 'ko',
      width: 20,
      height: 12,
      fontLists: [FONT],
      lines: [{ start: 0, end: 2, top: 0, height: 12, baseline: 9, left: 0, width: 20 }],
      clusters: [
        { start: 0, end: 1, line: 0, run: 0, x: 0, y: 9, advance: 10 },
        { start: 1, end: 2, line: 0, run: 0, x: 10, y: 9, advance: 10 },
      ],
    });
  });

  it('lays out Latin and spaces', () => {
    expect(layout(request([run('ab c')]))).toStrictEqual({
      generation: 0,
      lang: 'ko',
      width: 17.5,
      height: 10,
      fontLists: [FONT],
      lines: [line(0, 4, 0, 0, 17.5)],
      clusters: [
        { start: 0, end: 1, line: 0, run: 0, x: 0, y: 8, advance: 5 },
        { start: 1, end: 2, line: 0, run: 0, x: 5, y: 8, advance: 5 },
        { start: 2, end: 3, line: 0, run: 0, x: 10, y: 8, advance: 2.5 },
        { start: 3, end: 4, line: 0, run: 0, x: 12.5, y: 8, advance: 5 },
      ],
    });
  });

  it('takes the largest run size on a line for its metrics', () => {
    const result = layout(request([run('a', 10), run('B\nc', 20)], { lineHeight: 1.5 }));
    // m = 20: height 30, baseline (30 - 20) / 2 + 16.
    expect(result.lines).toStrictEqual([
      { start: 0, end: 2, top: 0, height: 30, baseline: 21, left: 0, width: 15 },
      { start: 3, end: 4, top: 30, height: 30, baseline: 51, left: 0, width: 10 },
    ]);
    expect(result.clusters).toStrictEqual([
      { start: 0, end: 1, line: 0, run: 0, x: 0, y: 21, advance: 5 },
      { start: 1, end: 2, line: 0, run: 1, x: 5, y: 21, advance: 10 },
      { start: 3, end: 4, line: 1, run: 1, x: 0, y: 51, advance: 10 },
    ]);
    expect(result.width).toBe(15);
    expect(result.height).toBe(60);
  });

  it('adds letter spacing to every advance, spaces included', () => {
    const result = layout(request([run('a b')], { letterSpacing: 0.1 }));
    expect(result.clusters.map((cluster) => [cluster.x, cluster.advance])).toStrictEqual([
      [0, 6],
      [6, 3.5],
      [9.5, 6],
    ]);
    expect(result.width).toBe(15.5);
    const negative = layout(request([run('ab')], { letterSpacing: -0.5 }));
    expect(negative.clusters.map((cluster) => cluster.advance)).toStrictEqual([0, 0]);
    expect(negative.width).toBe(0);
  });

  it('breaks after spaces when the next word does not fit', () => {
    expect(layout(request([run('ab cd')], { width: 12, align: 'right' }))).toStrictEqual({
      generation: 0,
      lang: 'ko',
      width: 12,
      height: 20,
      fontLists: [FONT],
      lines: [line(0, 3, 0, 2, 10), line(3, 5, 1, 2, 10)],
      clusters: [
        { start: 0, end: 1, line: 0, run: 0, x: 2, y: 8, advance: 5 },
        { start: 1, end: 2, line: 0, run: 0, x: 7, y: 8, advance: 5 },
        { start: 2, end: 3, line: 0, run: 0, x: 12, y: 8, advance: 2.5 },
        { start: 3, end: 4, line: 1, run: 0, x: 2, y: 18, advance: 5 },
        { start: 4, end: 5, line: 1, run: 0, x: 7, y: 18, advance: 5 },
      ],
    });
  });

  it('keeps a word on its line when it fits exactly', () => {
    const result = layout(request([run('ab cd')], { width: 22.5 }));
    expect(result.lines).toStrictEqual([line(0, 5, 0, 0, 22.5)]);
  });

  it('breaks inside a word only when the word alone overflows', () => {
    // "xy" fits on its own line, so it moves whole; "abcdef" (30) overflows 12, so it breaks
    // before its first overflowing grapheme, after "xy " first.
    const result = layout(request([run('xy abcdef')], { width: 12 }));
    expect(result.lines).toStrictEqual([
      line(0, 3, 0, 0, 10),
      line(3, 5, 1, 0, 10),
      line(5, 7, 2, 0, 10),
      line(7, 9, 3, 0, 10),
    ]);
    expect(
      result.clusters.map((cluster) => [cluster.start, cluster.line, cluster.x]),
    ).toStrictEqual([
      [0, 0, 0],
      [1, 0, 5],
      [2, 0, 10],
      [3, 1, 0],
      [4, 1, 5],
      [5, 2, 0],
      [6, 2, 5],
      [7, 3, 0],
      [8, 3, 5],
    ]);
  });

  it('keeps at least one grapheme per line when one alone overflows', () => {
    const result = layout(request([run('가나')], { width: 4, align: 'center' }));
    // Each line overflows the box, so it starts at 0 (CSS start-aligns overflowing lines).
    expect(result.lines).toStrictEqual([line(0, 1, 0, 0, 10), line(1, 2, 1, 0, 10)]);
    expect(result.clusters.map((cluster) => cluster.x)).toStrictEqual([0, 0]);
  });

  it('moves a word that fits alone past leading spaces, which hang', () => {
    const result = layout(request([run('  ab')], { width: 10 }));
    expect(result.lines).toStrictEqual([line(0, 2, 0, 0, 0), line(2, 4, 1, 0, 10)]);
    expect(result.clusters.map((cluster) => [cluster.line, cluster.x])).toStrictEqual([
      [0, 0],
      [0, 2.5],
      [1, 0],
      [1, 5],
    ]);
    const right = layout(request([run('  ab')], { width: 10, align: 'right' }));
    expect(right.lines.map((each) => each.left)).toStrictEqual([10, 0]);
  });

  it('wraps every grapheme at width 0, spaces hanging', () => {
    const result = layout(request([run('ab')], { width: 0, align: 'center' }));
    expect(result.width).toBe(0);
    expect(result.lines).toStrictEqual([line(0, 1, 0, 0, 5), line(1, 2, 1, 0, 5)]);
    const spaced = layout(request([run('a b')], { width: 0 }));
    expect(spaced.lines).toStrictEqual([line(0, 2, 0, 0, 5), line(2, 3, 1, 0, 5)]);
    expect(spaced.height).toBe(20);
  });

  it('never gives a negative line or box width under negative letter spacing', () => {
    // "aaa" at -1: each advance is 5 - 10 = -5, so the pen ends at -15.
    const aaa = layout(request([run('aaa')], { letterSpacing: -1 }));
    expect(aaa.width).toBe(0);
    expect(aaa.lines).toStrictEqual([line(0, 3, 0, 0, 0)]);
    expect(aaa.clusters.map((cluster) => [cluster.x, cluster.advance])).toStrictEqual([
      [0, -5],
      [-5, -5],
      [-10, -5],
    ]);
    const centred = layout(
      request([run('aaa')], { letterSpacing: -1, width: 20, align: 'center' }),
    );
    expect(centred.lines).toStrictEqual([line(0, 3, 0, 10, 0)]);
    // " a" at -0.5: the space advances -2.5, "a" 0, so the content ends at -2.5.
    const spaceA = layout(request([run(' a')], { letterSpacing: -0.5 }));
    expect(spaceA.width).toBe(0);
    expect(spaceA.lines).toStrictEqual([line(0, 2, 0, 0, 0)]);
    expect(spaceA.clusters.map((cluster) => [cluster.x, cluster.advance])).toStrictEqual([
      [0, -2.5],
      [-2.5, 0],
    ]);
    // The pen extent is the pen after the last non-space cluster, not the furthest reach.
    const reach = layout(request([run('가a')], { letterSpacing: -0.6 }));
    expect(reach.clusters.map((cluster) => cluster.advance)).toStrictEqual([4, -1]);
    expect(reach.width).toBe(3);
    // A lone U+00AD has advance 0 - 10.
    const shy = layout(request([run('\u00ad')], { letterSpacing: -1 }));
    expect(shy.width).toBe(0);
    expect(shy.lines).toStrictEqual([line(0, 1, 0, 0, 0)]);
    expect(shy.clusters).toStrictEqual([
      { start: 0, end: 1, line: 0, run: 0, x: 0, y: 8, advance: -10 },
    ]);
  });

  it('hangs trailing spaces', () => {
    const unwrapped = layout(request([run('ab   ')]));
    expect(unwrapped.width).toBe(10);
    expect(unwrapped.lines).toStrictEqual([line(0, 5, 0, 0, 10)]);
    const wrapped = layout(request([run('ab   cd')], { width: 12, align: 'right' }));
    expect(wrapped.lines).toStrictEqual([line(0, 5, 0, 2, 10), line(5, 7, 1, 2, 10)]);
    // The hanging spaces keep their pen positions past the box edge.
    expect(wrapped.clusters.slice(2, 5).map((cluster) => cluster.x)).toStrictEqual([12, 14.5, 17]);
    const spaces = layout(request([run('   ')], { align: 'center', width: 20 }));
    expect(spaces.lines).toStrictEqual([line(0, 3, 0, 10, 0)]);
  });

  it('keeps leading spaces as content offsets', () => {
    const result = layout(request([run('  a')]));
    expect(result.width).toBe(10);
    expect(result.clusters.map((cluster) => cluster.x)).toStrictEqual([0, 2.5, 5]);
  });

  it('splits paragraphs at LF and excludes LF from lines and clusters', () => {
    const result = layout(request([run('ab\nabcd')], { align: 'center' }));
    expect(result.width).toBe(20);
    expect(result.lines).toStrictEqual([line(0, 2, 0, 5, 10), line(3, 7, 1, 0, 20)]);
    expect(result.clusters.map((cluster) => cluster.start)).toStrictEqual([0, 1, 3, 4, 5, 6]);
    expect(result.clusters[0]!.x).toBe(5);
  });

  it('gives a text ending in LF an empty last line in the last run style', () => {
    const result = layout(request([run('a\nb', 10), run('\n', 20)], { lineHeight: 1.2 }));
    expect(result.lines).toStrictEqual([
      { start: 0, end: 1, top: 0, height: 12, baseline: 9, left: 0, width: 5 },
      { start: 2, end: 3, top: 12, height: 12, baseline: 21, left: 0, width: 5 },
      { start: 4, end: 4, top: 24, height: 24, baseline: 42, left: 0, width: 0 },
    ]);
    expect(result.clusters.map((cluster) => [cluster.start, cluster.line])).toStrictEqual([
      [0, 0],
      [2, 1],
    ]);
    expect(result.height).toBe(48);
  });

  it('sizes an empty line inside the text by the run holding its LF', () => {
    const result = layout(request([run('a', 10), run('\n\nb', 20)]));
    expect(result.lines.map((each) => [each.start, each.end, each.height])).toStrictEqual([
      [0, 1, 10],
      [2, 2, 20],
      [3, 4, 20],
    ]);
  });

  it('lays out an empty node with its alignment point', () => {
    const empty = (align: TextLayoutRequest['align']) =>
      layout(request([run('')], { align, width: 20, lineHeight: 1.2 }));
    expect(empty('left')).toStrictEqual({
      generation: 0,
      lang: 'ko',
      width: 20,
      height: 12,
      fontLists: [FONT],
      lines: [{ start: 0, end: 0, top: 0, height: 12, baseline: 9, left: 0, width: 0 }],
      clusters: [],
    });
    expect(empty('center').lines[0]!.left).toBe(10);
    expect(empty('right').lines[0]!.left).toBe(20);
    const auto = layout(request([run('')], { align: 'right' }));
    expect([auto.width, auto.lines[0]!.left]).toStrictEqual([0, 0]);
  });

  it('places empty centred and right-aligned lines at their alignment point', () => {
    const centred = layout(request([run('abcd\n\nab')], { align: 'center' }));
    expect(centred.lines).toStrictEqual([
      line(0, 4, 0, 0, 20),
      line(5, 5, 1, 10, 0),
      line(6, 8, 2, 5, 10),
    ]);
    const right = layout(request([run('abcd\n\nab')], { align: 'right', width: 30 }));
    expect(right.lines.map((each) => each.left)).toStrictEqual([10, 30, 20]);
  });

  it('makes run boundaries cluster boundaries', () => {
    const result = layout(request([run('e'), run('\u0301', 20)], { letterSpacing: 0.5 }));
    expect(result.clusters).toStrictEqual([
      { start: 0, end: 1, line: 0, run: 0, x: 0, y: 16, advance: 10 },
      { start: 1, end: 2, line: 0, run: 1, x: 10, y: 16, advance: 10 },
    ]);
  });

  it('cuts a 40-unit grapheme before the surrogate pair across unit 32', () => {
    const grapheme = `a${'\u0301'.repeat(30)}\u{1d167}${'\u0301'.repeat(7)}`;
    expect(grapheme).toHaveLength(40);
    expect(grapheme.charCodeAt(31)).toBe(0xd834);
    expect(grapheme.charCodeAt(32)).toBe(0xdd67);
    const result = layout(request([run(`${grapheme}b`)]));
    expect(result.clusters).toStrictEqual([
      { start: 0, end: 31, line: 0, run: 0, x: 0, y: 8, advance: 5 },
      { start: 31, end: 40, line: 0, run: 0, x: 0, y: 8, advance: 0 },
      { start: 40, end: 41, line: 0, run: 0, x: 5, y: 8, advance: 5 },
    ]);
  });

  it('cuts a long grapheme into pieces of 32 units', () => {
    const grapheme = `a${'\u0301'.repeat(69)}`;
    const result = layout(request([run(grapheme)]));
    expect(
      result.clusters.map((cluster) => [cluster.start, cluster.end, cluster.advance]),
    ).toStrictEqual([
      [0, 32, 5],
      [32, 64, 0],
      [64, 70, 0],
    ]);
    for (const cluster of result.clusters) {
      expect(cluster.end - cluster.start).toBeLessThanOrEqual(SCENE_TEXT_MAX_CLUSTER_UNITS);
    }
  });

  it('keeps emoji ZWJ sequences, modifiers, flags and presentation forms as one cluster', () => {
    const text =
      '\u{1f469}\u200d\u{1f469}\u200d\u{1f467}\u{1f44d}\u{1f3fd}\u{1f1f0}\u{1f1f7}\u2764\ufe0f';
    const result = layout(request([run(text)]));
    expect(
      result.clusters.map((cluster) => [cluster.start, cluster.end, cluster.advance]),
    ).toStrictEqual([
      [0, 8, 30],
      [8, 12, 15],
      [12, 16, 10],
      [16, 18, 10],
    ]);
  });
});

describe('M6a-A05 fake text layout: determinism and generation', () => {
  it('gives deep-equal results for deep-equal requests', () => {
    const port = createFakeTextLayout();
    const value = () => request([run('가 ab\n'), run('cd', 14)], { width: 15, align: 'center' });
    const first = port.layout(value());
    expect(port.layout(value())).toStrictEqual(first);
    expect(fakeLayout(value(), 0)).toStrictEqual(first);
    expect(port.layoutCalls).toBe(2);
  });

  it('implements the port shape at version 0', () => {
    const port: TextLayoutPort = createFakeTextLayout({ generation: 7 });
    expect(port.portVersion).toBe(0);
    expect(port.generation).toBe(7);
    expect(port.layout(request([run('a')])).generation).toBe(7);
  });

  it('bumps the generation and runs listeners in registration order', () => {
    const port = createFakeTextLayout();
    const calls: string[] = [];
    port.subscribe(() => calls.push(`first ${port.layout(request([run('a')])).generation}`));
    const unsubscribe = port.subscribe(() => calls.push('second'));
    port.subscribe(() => calls.push('third'));
    port.bump();
    expect(port.generation).toBe(1);
    expect(calls).toStrictEqual(['first 1', 'second', 'third']);
    unsubscribe();
    unsubscribe();
    port.bump();
    expect(calls).toStrictEqual(['first 1', 'second', 'third', 'first 2', 'third']);
  });

  it('rejects requests no valid node builds', () => {
    expect(() => layout(request([]))).toThrow(TypeError);
    expect(() => layout(request([run('a', 0)]))).toThrow(TypeError);
    expect(() => layout(request([run('a')], { width: Number.NaN }))).toThrow(TypeError);
    expect(() => layout(request([run('a')], { width: Number.POSITIVE_INFINITY }))).toThrow(
      TypeError,
    );
    expect(() => layout(request([run('a')], { width: -1 }))).toThrow(TypeError);
  });

  it('rejects a start generation that is not a non-negative safe integer', () => {
    for (const generation of [-1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => createFakeTextLayout({ generation })).toThrow(TypeError);
    }
  });

  it('skips a listener unsubscribed during dispatch and runs one added only later', () => {
    const port = createFakeTextLayout();
    const calls: string[] = [];
    let unsubscribeSecond = (): void => undefined;
    let added = false;
    port.subscribe(() => {
      calls.push('first');
      unsubscribeSecond();
      if (!added) {
        added = true;
        port.subscribe(() => calls.push('added'));
      }
    });
    unsubscribeSecond = port.subscribe(() => calls.push('second'));
    port.bump();
    expect(calls).toStrictEqual(['first']);
    port.bump();
    expect(calls).toStrictEqual(['first', 'first', 'added']);
  });
});
