import type {
  TextLayoutCluster,
  TextLayoutLine,
  TextLayoutPort,
  TextLayoutRequest,
  TextLayoutResult,
} from '@vector-studio/contracts';
import { SCENE_TEXT_MAX_CLUSTER_UNITS } from '@vector-studio/contracts';

// Fake text layout port of the M6a contract (docs/plans/mvp-m6a-text-model-contract.md,
// section 5, M6-L2). Test-only and deterministic: fixed advances per code point instead of fonts,
// greedy breaks after spaces, the M6a-L1 line, cluster and long-cluster rules. Its own tests
// (tests/unit/m6a-u2-fake-text-layout.test.ts) pin these rules; later units rely on them.

export const FAKE_TEXT_LAYOUT_LANG = 'ko';

export interface FakeTextLayout extends TextLayoutPort {
  /** Increases the generation by one, then runs the listeners in registration order. */
  bump(): void;
  /** How many times `layout` ran, so cache tests can count calls. */
  readonly layoutCalls: number;
}

export type FakeTextLayoutOptions = Readonly<{ generation?: number }>;

const MARK = /^\p{M}$/u;

// U+200D, U+00AD and the variation selectors, by code point (a character class holding them
// trips no-misleading-character-class).
function isZeroWidthFormat(value: number): boolean {
  return (
    value === 0x200d ||
    value === 0x00ad ||
    (value >= 0xfe00 && value <= 0xfe0f) ||
    (value >= 0xe0100 && value <= 0xe01ef)
  );
}
const FULL_WIDTH =
  /^[\p{Script=Hangul}\p{Script=Han}\u3000-\u303f\uff00-\uffef\p{Extended_Pictographic}]$/u;

/** Advance of one code point, in em of the run size (M6a section 5). */
export function fakeCodePointAdvance(codePoint: string): number {
  if (codePoint === ' ') return 0.25;
  if (MARK.test(codePoint) || isZeroWidthFormat(codePoint.codePointAt(0)!)) return 0;
  if (FULL_WIDTH.test(codePoint)) return 1;
  return 0.5;
}

/** `"<family>", sans-serif`, the family a CSS string with `"` and `\` escaped. */
export function fakeFontList(family: string): string {
  return `"${family.replace(/["\\]/g, (character) => `\\${character}`)}", sans-serif`;
}

type Grapheme = Readonly<{ start: number; end: number; run: number; advance: number }>;
type Item = Grapheme & Readonly<{ space: boolean }>;
type Paragraph = Readonly<{ start: number; end: number; items: readonly Item[] }>;
type PlacedLine = Readonly<{
  start: number;
  end: number;
  items: readonly Readonly<{ item: Item; pen: number }>[];
  width: number;
}>;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

function runAt(runEnds: readonly number[], offset: number): number {
  const index = runEnds.findIndex((end) => offset < end);
  return index === -1 ? runEnds.length - 1 : index;
}

function check(request: TextLayoutRequest): void {
  if (request.runs.length === 0) throw new TypeError('fake text layout: no runs');
  for (const run of request.runs) {
    if (!(Number.isFinite(run.size) && run.size > 0)) {
      throw new TypeError('fake text layout: invalid size');
    }
  }
  if (request.width !== null && !(Number.isFinite(request.width) && request.width >= 0)) {
    throw new TypeError('fake text layout: invalid width');
  }
  if (!Number.isFinite(request.letterSpacing) || !Number.isFinite(request.lineHeight)) {
    throw new TypeError('fake text layout: invalid spacing');
  }
}

// Graphemes per run (run boundaries are cluster boundaries), LF split off as paragraph ends.
function paragraphs(request: TextLayoutRequest): Paragraph[] {
  const result: Paragraph[] = [];
  let items: Item[] = [];
  let paragraphStart = 0;
  let offset = 0;
  request.runs.forEach((run, runIndex) => {
    for (const { segment, index } of segmenter.segment(run.text)) {
      const start = offset + index;
      const end = start + segment.length;
      if (segment === '\n') {
        result.push({ start: paragraphStart, end: start, items });
        items = [];
        paragraphStart = end;
        continue;
      }
      let em = 0;
      for (const codePoint of segment) em += fakeCodePointAdvance(codePoint);
      const advance = em * run.size + request.letterSpacing * run.size;
      items.push({ start, end, run: runIndex, advance, space: segment === ' ' });
    }
    offset += run.text.length;
  });
  result.push({ start: paragraphStart, end: offset, items });
  return result;
}

// Greedy breaks: after a sequence of spaces when the next word does not fit; inside a word only
// when the word alone overflows, before its first overflowing grapheme, at least one per line.
// Trailing spaces hang: they keep their pen positions but add nothing to the line width.
function breakParagraph(paragraph: Paragraph, width: number | null): PlacedLine[] {
  const lines: PlacedLine[] = [];
  let lineStart = paragraph.start;
  let placed: { item: Item; pen: number }[] = [];
  let pen = 0;
  let contentWidth = 0;
  const flush = (end: number): void => {
    // A line's width is never negative, even when negative letter spacing pulls the pen back.
    lines.push({ start: lineStart, end, items: placed, width: Math.max(0, contentWidth) });
    lineStart = end;
    placed = [];
    pen = 0;
    contentWidth = 0;
  };
  const place = (item: Item): void => {
    placed.push({ item, pen });
    pen += item.advance;
    if (!item.space) contentWidth = pen;
  };
  const items = paragraph.items;
  let index = 0;
  while (index < items.length) {
    const first = items[index]!;
    if (first.space) {
      place(first);
      index += 1;
      continue;
    }
    let wordEnd = index;
    let wordWidth = 0;
    while (wordEnd < items.length && !items[wordEnd]!.space) {
      wordWidth += items[wordEnd]!.advance;
      wordEnd += 1;
    }
    // A word that does not fit after what the line holds (leading spaces included) moves to the
    // next line, and the spaces before it hang on this one.
    if (width !== null && placed.length > 0 && pen + wordWidth > width) flush(first.start);
    for (let k = index; k < wordEnd; k += 1) {
      const item = items[k]!;
      if (width !== null && placed.length > 0 && pen + item.advance > width) flush(item.start);
      place(item);
    }
    index = wordEnd;
  }
  flush(paragraph.end);
  return lines;
}

// M6a-L1 long clusters: pieces of at most 32 units, a cut moved one unit earlier when it would
// fall between a high and a low surrogate.
function pieces(text: string, start: number, end: number): [number, number][] {
  const result: [number, number][] = [];
  let from = start;
  while (end - from > SCENE_TEXT_MAX_CLUSTER_UNITS) {
    let cut = from + SCENE_TEXT_MAX_CLUSTER_UNITS;
    if (isHighSurrogate(text.charCodeAt(cut - 1)) && isLowSurrogate(text.charCodeAt(cut))) {
      cut -= 1;
    }
    result.push([from, cut]);
    from = cut;
  }
  result.push([from, end]);
  return result;
}

const ALIGN_FACTOR = { left: 0, center: 0.5, right: 1 } as const;

export function fakeLayout(request: TextLayoutRequest, generation: number): TextLayoutResult {
  check(request);
  const text = request.runs.map((run) => run.text).join('');
  const runEnds: number[] = [];
  let total = 0;
  for (const run of request.runs) {
    total += run.text.length;
    runEnds.push(total);
  }
  const placedLines = paragraphs(request).flatMap((paragraph) =>
    breakParagraph(paragraph, request.width),
  );
  const boxWidth = request.width ?? Math.max(...placedLines.map((line) => line.width));
  const factor = ALIGN_FACTOR[request.align];
  const lines: TextLayoutLine[] = [];
  const clusters: TextLayoutCluster[] = [];
  let top = 0;
  placedLines.forEach((placed, lineIndex) => {
    const m =
      placed.items.length > 0
        ? Math.max(...placed.items.map(({ item }) => request.runs[item.run]!.size))
        : request.runs[runAt(runEnds, placed.start)]!.size;
    const height = request.lineHeight * m;
    const baseline = top + (height - m) / 2 + 0.8 * m;
    // A line wider than the box starts at 0, as CSS start-aligns overflowing lines.
    const left = Math.max(0, (boxWidth - placed.width) * factor);
    lines.push({
      start: placed.start,
      end: placed.end,
      top,
      height,
      baseline,
      left,
      width: placed.width,
    });
    for (const { item, pen } of placed.items) {
      pieces(text, item.start, item.end).forEach(([start, end], piece) => {
        clusters.push({
          start,
          end,
          line: lineIndex,
          run: item.run,
          x: left + pen,
          y: baseline,
          advance: piece === 0 ? item.advance : 0,
        });
      });
    }
    top += height;
  });
  return {
    generation,
    lang: FAKE_TEXT_LAYOUT_LANG,
    width: boxWidth,
    height: top,
    fontLists: request.runs.map((run) => fakeFontList(run.family)),
    lines,
    clusters,
  };
}

export function createFakeTextLayout(options: FakeTextLayoutOptions = {}): FakeTextLayout {
  let generation = options.generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError('fake text layout: invalid generation');
  }
  let layoutCalls = 0;
  const listeners: (() => void)[] = [];
  return {
    portVersion: 0,
    get generation() {
      return generation;
    },
    get layoutCalls() {
      return layoutCalls;
    },
    layout(request) {
      layoutCalls += 1;
      return fakeLayout(request, generation);
    },
    subscribe(listener) {
      // Each subscription is its own entry, so one listener subscribed twice runs twice.
      const entry = (): void => listener();
      listeners.push(entry);
      return () => {
        const index = listeners.indexOf(entry);
        if (index !== -1) listeners.splice(index, 1);
      };
    },
    bump() {
      generation += 1;
      // As EventTarget: a listener removed during dispatch is skipped, one added is not run.
      for (const listener of [...listeners]) {
        if (listeners.includes(listener)) listener();
      }
    },
  };
}
