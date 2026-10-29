import { SCENE_TEXT_MAX_FONT_LIST, type TextLayoutRequest } from '@vector-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  assembleLayout,
  assignLines,
  clusterPieces,
  isHangingSpace,
  measurePens,
  startsNewLine,
  type Grapheme,
  type Rect,
} from '../../packages/text-dom/src/assemble.js';
import {
  buildFontList,
  fallbackPart,
  FONT_LIST_TAIL,
  fontUrlSource,
  MAX_FALLBACK_PART,
  quoteCssString,
} from '../../packages/text-dom/src/css.js';
import { nextGeneration } from '../../packages/text-dom/src/generation.js';
import { createListeners } from '../../packages/text-dom/src/listeners.js';
import { createTextDom } from '../../packages/text-dom/src/index.js';
import { checkRequest, isValidFamily, isValidLang } from '../../packages/text-dom/src/validate.js';

// MVP M6a-U4 (docs/plans/mvp-m6a-text-model-contract.md, section 4, M6a-A04): the parts of
// `@vector-studio/text-dom` that need no layout engine, in Node: escaping and font lists, input
// checks, the realm generation counter, listener dispatch, the assembly of a result from
// measured rects, and the port's lifecycle over a minimal document shim. The DOM measurement
// itself is checked in a browser (M6a-U6 headed spec; the U4 notes name the smoke run).

const request = (overrides: Partial<TextLayoutRequest> = {}): TextLayoutRequest => ({
  runs: [{ text: 'ab', family: 'Inter', size: 10 }],
  width: null,
  align: 'left',
  letterSpacing: 0,
  lineHeight: 1.2,
  ...overrides,
});

describe('M6a-U4 CSS strings and font lists', () => {
  it('escapes quotes, backslashes, LF, CR and FF only', () => {
    expect(quoteCssString('Inter')).toBe('"Inter"');
    expect(quoteCssString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(quoteCssString('a\nb\rc\fd\u0000e\u007f\u0009')).toBe(
      '"a\\a b\\d c\\c d\u0000e\u007f\u0009"',
    );
    // U+2028, U+2029, bidi controls, Hangul and DEL-free C1-free text stay as they are.
    expect(quoteCssString('  ‮⁧한글 , serif')).toBe('"  ‮⁧한글 , serif"');
  });

  it('builds the M6-F2 list with a 52-character fixed tail', () => {
    expect(FONT_LIST_TAIL).toHaveLength(52);
    expect(buildFontList('Inter', '')).toBe(
      '"Inter", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
    );
    expect(buildFontList('Inter', fallbackPart(['Noto Sans KR', 'a"b']))).toBe(
      '"Inter", "Noto Sans KR", "a\\"b", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
    );
    // A family naming a CSS generic is still a quoted name.
    expect(buildFontList('serif', '')).toMatch(/^"serif", /u);
  });

  it('keeps the worst case within E28-S2 (258 + 200 + 52 = 510 UTF-16 units)', () => {
    const family = '"'.repeat(128);
    expect(quoteCssString(family)).toHaveLength(258);
    // DEL is allowed in a family (M6a-S3) and stays literal (review r1 B2).
    const del = '\u007f'.repeat(128);
    expect(isValidFamily(del)).toBe(true);
    expect(quoteCssString(del)).toHaveLength(130);
    expect(buildFontList(del, '').length).toBeLessThanOrEqual(SCENE_TEXT_MAX_FONT_LIST);
    const fallback = `, ${quoteCssString('x'.repeat(MAX_FALLBACK_PART - 4))}`;
    expect(fallback).toHaveLength(MAX_FALLBACK_PART);
    const list = buildFontList(family, fallback);
    expect(list).toHaveLength(510);
    expect(list.length).toBeLessThanOrEqual(SCENE_TEXT_MAX_FONT_LIST);
  });

  it('writes a URL source as one CSS string, so no src syntax can be injected', () => {
    expect(fontUrlSource('/fonts/a.woff2')).toBe('url("/fonts/a.woff2")');
    expect(fontUrlSource('x"), local("Arial')).toBe('url("x\\"), local(\\"Arial")');
    expect(fontUrlSource('a\\b\nc')).toBe('url("a\\\\b\\a c")');
  });
});

describe('M6a-U4 input checks', () => {
  it('checks lang by E28-S1 syntax only', () => {
    for (const lang of ['ko', 'en-US', 'zh-Hant-TW', 'x', 'a'.repeat(35), '123', '-']) {
      expect(isValidLang(lang), lang).toBe(true);
    }
    for (const lang of ['', 'a'.repeat(36), 'en_US', 'ko KR', 'ko\n', '한국', 7, null]) {
      expect(isValidLang(lang), String(lang)).toBe(false);
    }
  });

  it('checks a family by M6a-S3', () => {
    for (const family of ['a', 'x'.repeat(128), 'A, B', ' ', '‮', '\u007f', '😀']) {
      expect(isValidFamily(family), family).toBe(true);
    }
    for (const family of [
      '',
      'x'.repeat(129),
      'a\u0000',
      'a\n',
      'a\u001f',
      'a\u0080',
      'a\u009f',
      'a\ud800',
      '\udc00a',
      '\ud83d',
      42,
    ]) {
      expect(isValidFamily(family), JSON.stringify(family)).toBe(false);
    }
  });

  it('rejects requests no valid node builds with TypeError', () => {
    expect(() => checkRequest(request())).not.toThrow();
    expect(() => checkRequest(request({ width: 0 }))).not.toThrow();
    expect(() =>
      checkRequest(request({ runs: [{ text: '', family: 'a', size: 4096 }] })),
    ).not.toThrow();
    const bad: unknown[] = [
      null,
      request({ runs: [] }),
      request({ runs: [{ text: 'a', family: '', size: 10 }] }),
      request({ runs: [{ text: 'a', family: 'a', size: 0 }] }),
      request({ runs: [{ text: 'a', family: 'a', size: 4096.01 }] }),
      request({ runs: [{ text: 'a', family: 'a', size: Number.NaN }] }),
      request({ runs: [{ text: 1 as unknown as string, family: 'a', size: 1 }] }),
      request({ width: -1 }),
      request({ width: Number.POSITIVE_INFINITY }),
      request({ align: 'justify' as 'left' }),
      request({ letterSpacing: Number.NaN }),
      request({ lineHeight: 0 }),
    ];
    for (const value of bad) {
      expect(() => checkRequest(value as TextLayoutRequest), JSON.stringify(value)).toThrow(
        TypeError,
      );
    }
  });
});

describe('M6a-U4 realm generation counter (M6a-L3, M6a-Q21)', () => {
  it('increases on every call and survives a fresh module evaluation', async () => {
    const first = nextGeneration();
    expect(nextGeneration()).toBe(first + 1);
    vi.resetModules();
    const again = await import('../../packages/text-dom/src/generation.js');
    expect(again.nextGeneration).not.toBe(nextGeneration);
    expect(again.nextGeneration()).toBe(first + 2);
    expect(nextGeneration()).toBe(first + 3);
  });
});

describe('M6a-U4 realm counter saturation (review r1 N1)', () => {
  const key = Symbol.for('@vector-studio/text-dom/generation');
  const holder = globalThis as unknown as Record<symbol, unknown>;

  it('saturates at MAX_SAFE_INTEGER and on a foreign holder value, never restarting at 0', () => {
    const saved = holder[key];
    try {
      holder[key] = Number.MAX_SAFE_INTEGER - 1;
      expect(nextGeneration()).toBe(Number.MAX_SAFE_INTEGER);
      expect(nextGeneration()).toBe(Number.MAX_SAFE_INTEGER);
      for (const foreign of [-1, 1.5, Number.NaN, '7', null]) {
        holder[key] = foreign;
        expect(nextGeneration(), String(foreign)).toBe(Number.MAX_SAFE_INTEGER);
      }
    } finally {
      holder[key] = saved;
    }
  });
});

describe('M6a-U4 listener dispatch (M6a-L3, EventTarget order)', () => {
  it('runs listeners in order; one function subscribed twice runs twice', () => {
    const listeners = createListeners();
    const calls: string[] = [];
    const a = (): void => void calls.push('a');
    listeners.add(a);
    listeners.add(() => calls.push('b'));
    const offA = listeners.add(a);
    listeners.dispatch();
    expect(calls).toEqual(['a', 'b', 'a']);
    offA();
    offA();
    listeners.dispatch();
    expect(calls).toEqual(['a', 'b', 'a', 'a', 'b']);
  });

  it('skips one unsubscribed during a dispatch and defers one subscribed during it', () => {
    const listeners = createListeners();
    const calls: string[] = [];
    let offC = (): void => {};
    listeners.add(() => {
      calls.push('a');
      offC();
      listeners.add(() => calls.push('d'));
    });
    listeners.add(() => calls.push('b'));
    offC = listeners.add(() => calls.push('c'));
    listeners.dispatch();
    expect(calls).toEqual(['a', 'b']);
    listeners.dispatch();
    expect(calls).toEqual(['a', 'b', 'a', 'b', 'd']);
  });

  it('reports a throwing listener and runs the rest; clear stops a running dispatch', () => {
    const reported: unknown[] = [];
    const listeners = createListeners((error) => reported.push(error));
    const calls: string[] = [];
    const failure = new Error('boom');
    listeners.add(() => {
      throw failure;
    });
    listeners.add(() => {
      calls.push('b');
      listeners.clear();
    });
    listeners.add(() => calls.push('c'));
    listeners.dispatch();
    expect(reported).toEqual([failure]);
    expect(calls).toEqual(['b']);
  });
});

// --- assembly from measured rects ---------------------------------------------------------------

function grapheme(start: number, text: string, rect: Rect | null, run = 0): Grapheme {
  return {
    start,
    end: start + text.length,
    run,
    lf: text === '\n',
    space: isHangingSpace(text),
    rect: text === '\n' ? null : rect,
  };
}

/** Graphemes of `text`, each `advance` wide, wrapped onto rows at `breaks` (row height 12). */
function row(text: string, advance: number, breaks: readonly number[] = []): Grapheme[] {
  const result: Grapheme[] = [];
  let line = 0;
  let pen = 0;
  [...text].forEach((character, index) => {
    if (breaks.includes(index)) {
      line += 1;
      pen = 0;
    }
    if (character === '\n') {
      result.push(grapheme(index, character, null));
      line += 1;
      pen = 0;
      return;
    }
    result.push(
      grapheme(index, character, { left: pen, top: line * 12, width: advance, height: 10 }),
    );
    pen += advance;
  });
  return result;
}

describe('M6a-U4 pass-1 lines', () => {
  it('starts a line below the previous rect, or left of and lower than it', () => {
    const previous = { left: 10, top: 0, width: 5, height: 10 };
    expect(startsNewLine(previous, { left: 15, top: 10, width: 5, height: 10 })).toBe(true);
    expect(startsNewLine(previous, { left: 15, top: 9.995, width: 5, height: 10 })).toBe(true);
    expect(startsNewLine(previous, { left: 15, top: 2, width: 5, height: 6 })).toBe(false);
    // Overlapping line boxes (lineHeight below 1): left and lower.
    expect(startsNewLine(previous, { left: 0, top: 5, width: 5, height: 10 })).toBe(true);
    // Negative letter spacing moves left on the same line.
    expect(startsNewLine(previous, { left: 8, top: 0, width: 2, height: 10 })).toBe(false);
  });

  it('tiles the text, LF excluded, with a last empty line after a final LF', () => {
    expect(assignLines(row('ab cd', 5, [3]), 5)).toEqual([
      { start: 0, end: 3, graphemes: [0, 1, 2] },
      { start: 3, end: 5, graphemes: [3, 4] },
    ]);
    expect(assignLines(row('a\n\nb\n', 5), 5)).toEqual([
      { start: 0, end: 1, graphemes: [0] },
      { start: 2, end: 2, graphemes: [] },
      { start: 3, end: 4, graphemes: [3] },
      { start: 5, end: 5, graphemes: [] },
    ]);
    expect(assignLines([], 0)).toEqual([{ start: 0, end: 0, graphemes: [] }]);
  });
});

describe('M6a-U4 pens', () => {
  it('reads a rect forward unless its far edge continues the pen (negative advance)', () => {
    // Chrome's rects for "abc" at advance −2 each: [-2, 0], [-4, -2], [-6, -4].
    const graphemes = [
      grapheme(0, 'a', { left: -2, top: 0, width: 2, height: 10 }),
      grapheme(1, 'b', { left: -4, top: 0, width: 2, height: 10 }),
      grapheme(2, 'c', { left: -6, top: 0, width: 2, height: 10 }),
    ];
    const lines = assignLines(graphemes, 3);
    expect(lines).toHaveLength(1);
    expect(measurePens(graphemes, lines)).toEqual([
      { x: 0, advance: -2 },
      { x: -2, advance: -2 },
      { x: -4, advance: -2 },
    ]);
    const forward = row('ab', 6);
    expect(measurePens(forward, assignLines(forward, 2))).toEqual([
      { x: 0, advance: 6 },
      { x: 6, advance: 6 },
    ]);
  });

  it('restarts the pen at a run anchor inside a line (review r1 S1)', () => {
    // Review repro: "ii" (DejaVu Sans 40) then "ii" (DejaVu Serif 40) at −0.5 em. Chromium
    // clamps run 0's box to width 0, so run 1 starts at 0; its first rect is [−7.22, 0].
    const graphemes: Grapheme[] = [
      grapheme(0, 'i', { left: -8.89, top: 0, width: 8.89, height: 46 }),
      grapheme(1, 'i', { left: -17.78, top: 0, width: 8.91, height: 46 }),
      { ...grapheme(2, 'i', { left: -7.22, top: 0, width: 7.22, height: 46 }, 1), anchor: 0 },
      grapheme(3, 'i', { left: -14.44, top: 0, width: 7.22, height: 46 }, 1),
    ];
    const pens = measurePens(graphemes, assignLines(graphemes, 4));
    expect(pens[2]).toEqual({ x: 0, advance: -7.22 });
    expect(pens[3]!.advance).toBe(-7.22);
    // Without the anchor the pen continues from −17.78 and reads the rect forward.
    const unanchored = graphemes.map((entry): Grapheme => {
      const copy = { ...entry };
      delete copy.anchor;
      return copy;
    });
    expect(measurePens(unanchored, assignLines(unanchored, 4))[2]).toEqual({
      x: -7.22,
      advance: 7.22,
    });
    // An anchor on a line's first grapheme is ignored: lines start at 0.
    const first: Grapheme[] = [{ ...graphemes[0]!, anchor: 5 }];
    expect(measurePens(first, assignLines(first, 1))[0]).toEqual({ x: 0, advance: -8.89 });
  });

  it('gives a grapheme without a rect the pen and advance 0', () => {
    const graphemes = [
      grapheme(0, 'a', { left: 0, top: 0, width: 5, height: 10 }),
      grapheme(1, 'b', null),
    ];
    expect(measurePens(graphemes, assignLines(graphemes, 2))).toEqual([
      { x: 0, advance: 5 },
      { x: 5, advance: 0 },
    ]);
  });
});

describe('M6a-U4 long clusters', () => {
  it('cuts into 32-unit pieces without splitting a surrogate pair', () => {
    expect(clusterPieces('x'.repeat(40), 0, 40)).toEqual([
      [0, 32],
      [32, 40],
    ]);
    const paired = `${'x'.repeat(31)}𝅥${'x'.repeat(7)}`;
    expect(clusterPieces(paired, 0, 40)).toEqual([
      [0, 31],
      [31, 40],
    ]);
    expect(clusterPieces('ab', 0, 2)).toEqual([[0, 2]]);
  });
});

describe('M6a-U4 result assembly (M6a-L1)', () => {
  const base = { generation: 7, lang: 'ko', fontLists: ['"Inter"'] };

  it('aligns by the M6a-L1 formula and hangs trailing spaces', () => {
    const text = 'ab  cd';
    const graphemes = row(text, 5, [4]);
    const lines = assignLines(graphemes, text.length);
    const result = assembleLayout({
      ...base,
      request: request({ runs: [{ text, family: 'Inter', size: 10 }], width: 30, align: 'right' }),
      graphemes,
      lines,
      metrics: [
        { top: 0, baseline: 9 },
        { top: 12, baseline: 21 },
      ],
      blockHeight: 24,
    });
    expect(result.width).toBe(30);
    expect(result.height).toBe(24);
    expect(result.lines).toEqual([
      { start: 0, end: 4, top: 0, height: 12, baseline: 9, left: 20, width: 10 },
      { start: 4, end: 6, top: 12, height: 12, baseline: 21, left: 20, width: 10 },
    ]);
    expect(result.clusters.map((cluster) => [cluster.start, cluster.x, cluster.y])).toEqual([
      [0, 20, 9],
      [1, 25, 9],
      [2, 30, 9],
      [3, 35, 9],
      [4, 20, 21],
      [5, 25, 21],
    ]);
    expect(result.generation).toBe(7);
    expect(result.fontLists).toEqual(['"Inter"']);
  });

  it('takes the widest line for width null, clamps left at 0 and keeps empty lines at the point', () => {
    const text = 'abcd\n\nab';
    const graphemes = row(text, 5);
    const lines = assignLines(graphemes, text.length);
    const metrics = [0, 12, 24].map((top) => ({ top, baseline: top + 9 }));
    const center = assembleLayout({
      ...base,
      request: request({ runs: [{ text, family: 'Inter', size: 10 }], align: 'center' }),
      graphemes,
      lines,
      metrics,
      blockHeight: 36,
    });
    expect(center.width).toBe(20);
    expect(center.lines.map((line) => [line.left, line.width])).toEqual([
      [0, 20],
      [10, 0],
      [5, 10],
    ]);
    const narrow = assembleLayout({
      ...base,
      request: request({ runs: [{ text, family: 'Inter', size: 10 }], width: 8, align: 'right' }),
      graphemes,
      lines,
      metrics,
      blockHeight: 36,
    });
    expect(narrow.lines.map((line) => line.left)).toEqual([0, 8, 0]);
  });

  it('keeps line widths non-negative under negative advances', () => {
    const graphemes = [
      grapheme(0, '가', { left: 0, top: 0, width: 4, height: 10 }),
      grapheme(1, 'a', { left: 3, top: 0, width: 1, height: 10 }),
    ];
    const lines = assignLines(graphemes, 2);
    const result = assembleLayout({
      ...base,
      request: request({ runs: [{ text: '가a', family: 'Inter', size: 10 }], letterSpacing: -0.6 }),
      graphemes,
      lines,
      metrics: [{ top: 0, baseline: 9 }],
      blockHeight: 12,
    });
    // The M6a-L1 example: advances 4 and −1, width 3 though the furthest reach is 4.
    expect(result.clusters.map((cluster) => [cluster.x, cluster.advance])).toEqual([
      [0, 4],
      [4, -1],
    ]);
    expect(result.lines[0]!.width).toBe(3);
    const negative = assembleLayout({
      ...base,
      request: request({ runs: [{ text: 'a', family: 'Inter', size: 10 }], letterSpacing: -1 }),
      graphemes: [grapheme(0, 'a', { left: -5, top: 0, width: 5, height: 10 })],
      lines: [{ start: 0, end: 1, graphemes: [0] }],
      metrics: [{ top: 0, baseline: 9 }],
      blockHeight: 12,
    });
    expect(negative.lines[0]!.width).toBe(0);
    expect(negative.width).toBe(0);
    expect(negative.clusters[0]).toMatchObject({ x: 0, advance: -5 });
  });

  it('falls back to rect heights, the previous bottom and 0.8 × height', () => {
    const text = 'ab\n';
    const graphemes = [
      grapheme(0, 'a', { left: 0, top: 1, width: 5, height: 10 }),
      grapheme(1, 'b', { left: 5, top: 0, width: 5, height: 14 }, 1),
      grapheme(2, '\n', null, 1),
    ];
    const lines = assignLines(graphemes, text.length);
    const result = assembleLayout({
      ...base,
      fontLists: ['"Inter"', '"Inter"'],
      request: request({
        runs: [
          { text: 'a', family: 'Inter', size: 10 },
          { text: 'b\n', family: 'Inter', size: 20 },
        ],
        lineHeight: 1.5,
      }),
      graphemes,
      lines,
      metrics: null,
      blockHeight: 99,
    });
    expect(result.lines).toEqual([
      { start: 0, end: 2, top: 0, height: 14, baseline: 0.8 * 14, left: 0, width: 10 },
      // The empty last line: lineHeight × the size of the run at its offset (the last run).
      { start: 3, end: 3, top: 14, height: 30, baseline: 14 + 0.8 * 30, left: 0, width: 0 },
    ]);
    expect(result.height).toBe(44);
    expect(result.clusters.map((cluster) => cluster.run)).toEqual([0, 1]);
  });

  it('cuts a 40-unit grapheme: the first piece has the advance, later ones 0', () => {
    const text = `a${'́'.repeat(39)}`;
    const graphemes = [grapheme(0, text, { left: 0, top: 0, width: 6, height: 10 })];
    const result = assembleLayout({
      ...base,
      request: request({ runs: [{ text, family: 'Inter', size: 10 }] }),
      graphemes,
      lines: assignLines(graphemes, 40),
      metrics: [{ top: 0, baseline: 9 }],
      blockHeight: 12,
    });
    expect(result.clusters.map(({ start, end, x, advance }) => [start, end, x, advance])).toEqual([
      [0, 32, 0, 6],
      [32, 40, 0, 0],
    ]);
  });

  it('hangs U+0020 and U+3000, not NBSP', () => {
    expect([' ', '　', ' ', ' ', 'a'].map(isHangingSpace)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

// --- the port over a document shim --------------------------------------------------------------

type Outcome = 'loaded' | 'error';

class ShimFontFace {
  static created: ShimFontFace[] = [];
  static throwOnCreate = false;
  readonly settle: (outcome: Outcome) => void;
  private readonly settled: Promise<void>;
  constructor(
    readonly family: string,
    readonly source: string | ArrayBuffer,
  ) {
    if (ShimFontFace.throwOnCreate) throw new SyntaxError('bad source');
    let settle: (outcome: Outcome) => void = () => {};
    this.settled = new Promise((resolve, reject) => {
      settle = (outcome) => (outcome === 'loaded' ? resolve() : reject(new Error('load')));
    });
    this.settle = settle;
    ShimFontFace.created.push(this);
  }
  load(): Promise<void> {
    return this.settled;
  }
}

class ShimFontSet extends EventTarget {
  readonly faces = new Set<unknown>();
  add(face: unknown): void {
    this.faces.add(face);
  }
  delete(face: unknown): void {
    this.faces.delete(face);
  }
}

class ShimMediaQueryList extends EventTarget {
  constructor(readonly media: string) {
    super();
  }
}

function shim() {
  const fonts = new ShimFontSet();
  const queries: ShimMediaQueryList[] = [];
  const view = {
    devicePixelRatio: 1,
    FontFace: ShimFontFace,
    matchMedia(media: string) {
      const query = new ShimMediaQueryList(media);
      queries.push(query);
      return query;
    },
  };
  const document = { nodeType: 9, defaultView: view, fonts } as unknown as Document;
  return { document, fonts, view, queries };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('M6a-U4 createTextDom options', () => {
  it('rejects a non-Document, a bad lang and bad fallback families with TypeError', () => {
    const { document } = shim();
    const invalid: unknown[] = [
      undefined,
      {},
      { document: {} },
      { document: { nodeType: 9, defaultView: null } },
      { document, lang: '' },
      { document, lang: 'ko_KR' },
      { document, fallbackFamilies: 'Inter' },
      { document, fallbackFamilies: [''] },
      { document, fallbackFamilies: ['a\n'] },
      // 4 × (2 + 2 + 46) = 200 is the limit; one more character exceeds it.
      {
        document,
        fallbackFamilies: ['x'.repeat(46), 'x'.repeat(46), 'x'.repeat(46), 'x'.repeat(47)],
      },
    ];
    for (const options of invalid) {
      expect(() => createTextDom(options as Parameters<typeof createTextDom>[0])).toThrow(
        TypeError,
      );
    }
    const atLimit = createTextDom({ document, fallbackFamilies: Array(4).fill('x'.repeat(46)) });
    expect(atLimit.portVersion).toBe(0);
    expect(atLimit.fallbacks).toBe(0);
    atLimit.dispose();
  });
});

describe('M6a-U4 generation sources (M6a-L3)', () => {
  it('increases across instances and on font-set and resolution events', () => {
    const { document, fonts, view, queries } = shim();
    const first = createTextDom({ document });
    const second = createTextDom({ document });
    expect(second.generation).toBeGreaterThan(first.generation);
    const calls: number[] = [];
    first.subscribe(() => calls.push(first.generation));
    const before = first.generation;
    fonts.dispatchEvent(new Event('loadingdone'));
    fonts.dispatchEvent(new Event('loadingerror'));
    expect(calls).toHaveLength(2);
    expect(calls[0]!).toBeGreaterThan(before);
    expect(calls[1]!).toBeGreaterThan(calls[0]!);
    // Both instances listen; the realm counter keeps every value distinct.
    expect(second.generation).not.toBe(first.generation);
    // A resolution change, re-armed for the new ratio.
    expect(queries.map((query) => query.media)).toEqual([
      '(resolution: 1dppx)',
      '(resolution: 1dppx)',
    ]);
    view.devicePixelRatio = 1.25;
    queries[0]!.dispatchEvent(new Event('change'));
    expect(calls).toHaveLength(3);
    expect(queries[2]!.media).toBe('(resolution: 1.25dppx)');
    queries[0]!.dispatchEvent(new Event('change'));
    expect(calls).toHaveLength(3);
    queries[2]!.dispatchEvent(new Event('change'));
    expect(calls).toHaveLength(4);
    first.dispose();
    second.dispose();
  });

  it('registers a font: a registry bump, then a settle bump, resolving the status', async () => {
    const { document, fonts } = shim();
    const dom = createTextDom({ document });
    let bumps = 0;
    dom.subscribe(() => (bumps += 1));
    ShimFontFace.created = [];
    const loaded = dom.registerFont({ family: 'My "Face"', source: { url: 'a b".woff2' } });
    const face = ShimFontFace.created[0]!;
    // The family goes to FontFace as the raw name; the URL as one escaped CSS string.
    expect(face.family).toBe('My "Face"');
    expect(face.source).toBe('url("a b\\".woff2")');
    expect(fonts.faces.has(face)).toBe(true);
    expect(bumps).toBe(1);
    face.settle('loaded');
    await expect(loaded).resolves.toBe('loaded');
    expect(bumps).toBe(2);

    const bytes = new ArrayBuffer(4);
    const failed = dom.registerFont({ family: 'Bytes', source: { bytes } });
    expect(ShimFontFace.created[1]!.source).toBe(bytes);
    ShimFontFace.created[1]!.settle('error');
    await expect(failed).resolves.toBe('error');
    expect(bumps).toBe(4);

    ShimFontFace.throwOnCreate = true;
    await expect(dom.registerFont({ family: 'Bad', source: { url: 'x' } })).resolves.toBe('error');
    ShimFontFace.throwOnCreate = false;
    expect(bumps).toBe(4);

    expect(() => dom.registerFont({ family: '', source: { url: 'x' } })).toThrow(TypeError);
    for (const source of [
      null,
      {},
      { url: '' },
      { url: 1 },
      { bytes: new Uint8Array(4) },
      { url: 'x', bytes: new ArrayBuffer(1) },
    ]) {
      expect(() => dom.registerFont({ family: 'F', source: source as { url: string } })).toThrow(
        TypeError,
      );
    }
    dom.dispose();
  });
});

describe('M6a-U4 dispose (section 4)', () => {
  it('removes listeners and faces; generation stays; layout throws Error', async () => {
    const { document, fonts, queries } = shim();
    const dom = createTextDom({ document });
    let bumps = 0;
    dom.subscribe(() => (bumps += 1));
    ShimFontFace.created = [];
    const pending = dom.registerFont({ family: 'Late', source: { url: 'late.woff2' } });
    const pendingError = dom.registerFont({ family: 'Late2', source: { url: 'late2.woff2' } });
    expect(bumps).toBe(2);
    const generation = dom.generation;
    dom.dispose();
    dom.dispose();
    expect(fonts.faces.size).toBe(0);
    fonts.dispatchEvent(new Event('loadingdone'));
    queries[0]!.dispatchEvent(new Event('change'));
    ShimFontFace.created[0]!.settle('loaded');
    // In flight at dispose: 'error', whatever the load did (review r1 N2).
    await expect(pending).resolves.toBe('error');
    ShimFontFace.created[1]!.settle('error');
    await expect(pendingError).resolves.toBe('error');
    await flush();
    expect(bumps).toBe(2);
    expect(dom.generation).toBe(generation);
    let thrown: unknown = null;
    try {
      dom.layout(request());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
    const off = dom.subscribe(() => (bumps += 1));
    expect(off).toBeTypeOf('function');
    off();
    await expect(dom.registerFont({ family: 'After', source: { url: 'x' } })).resolves.toBe(
      'error',
    );
    expect(ShimFontFace.created).toHaveLength(2);
    // Another instance keeps counting above the disposed one.
    const next = createTextDom({ document });
    expect(next.generation).toBeGreaterThan(generation);
    next.dispose();
  });
});
