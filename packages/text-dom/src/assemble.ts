import type {
  TextLayoutCluster,
  TextLayoutLine,
  TextLayoutRequest,
  TextLayoutResult,
} from '@vector-studio/contracts';
import { SCENE_TEXT_MAX_CLUSTER_UNITS } from '@vector-studio/contracts';

// The pure half of text-dom's measurement (docs/plans/mvp-m6a-text-model-contract.md, section 4,
// M6a-L1): it turns the rects and probe positions the measurement element reports into a
// `TextLayoutResult`. It holds no DOM object, so its rules are unit-tested in Node.

/** A client rect relative to the measurement block's top-left corner, in CSS px (page units). */
export type Rect = Readonly<{ left: number; top: number; width: number; height: number }>;

/** One grapheme of the node text or one LF, in text order; UTF-16 offsets into the node text. */
export type Grapheme = Readonly<{
  start: number;
  end: number;
  run: number;
  /** An LF, which ends a paragraph and is never a cluster. */
  lf: boolean;
  /** A space that hangs at a soft wrap (`isHangingSpace`); it adds nothing to a line's width. */
  space: boolean;
  /** The first rect of the grapheme's range; null for an LF or a grapheme with no rect. */
  rect: Rect | null;
  /**
   * The pen origin measured at a run's first grapheme inside a line: the left of its span's
   * fragment there (Chromium clamps an inline box's width at 0, see `measurePens`).
   */
  anchor?: number;
}>;

/** One line of pass 1: its text offsets and the indices of its graphemes (never an LF). */
export type LineSlot = Readonly<{ start: number; end: number; graphemes: readonly number[] }>;

/** Pass-2 probe positions of one line: the line box top and the baseline. */
export type LineMetrics = Readonly<{ top: number; baseline: number }>;

/** Pen origin and advance of one grapheme on its line, before alignment. */
export type Pen = Readonly<{ x: number; advance: number }>;

/** Rect comparisons tolerate less than Chrome's 1/64 px layout unit. */
export const EPSILON = 0.01;

/**
 * The characters Chrome hangs at a soft wrap under `white-space: pre-wrap`: U+0020 and U+3000
 * (observed in Chromium; NBSP, U+1680 and U+2000 to U+200A wrap instead). M6a-L1's line width
 * ends after the last cluster that is not one of them. Section 5's U+0020-only rule is the
 * fake's; text-dom follows the browser.
 */
export function isHangingSpace(segment: string): boolean {
  return segment === ' ' || segment === '　';
}

/**
 * Pass-1 line rule: a grapheme starts a new line when its rect's top is at or below the previous
 * rect's bottom, or when it starts left of the previous rect while also lower than it. Requiring
 * "lower" for the leftward case keeps clusters that negative letter spacing moves left on their
 * line (section 16, M6a-U4 notes).
 */
export function startsNewLine(previous: Rect, rect: Rect): boolean {
  if (previous.height > EPSILON && rect.top >= previous.top + previous.height - EPSILON) {
    return true;
  }
  return rect.top > previous.top + EPSILON && rect.left < previous.left - EPSILON;
}

/**
 * Lines of pass 1. An LF ends its line and starts the next; within a paragraph, the first
 * grapheme starts a line and every later one starts a new line when `startsNewLine` says so.
 * Lines tile the text, an LF excluded from both its neighbours; an empty paragraph is one empty
 * line, so an empty text or a text ending in LF ends with an empty line.
 */
export function assignLines(graphemes: readonly Grapheme[], textLength: number): LineSlot[] {
  const lines: LineSlot[] = [];
  let start = 0;
  let members: number[] = [];
  let previous: Rect | null = null;
  graphemes.forEach((grapheme, index) => {
    if (grapheme.lf) {
      lines.push({ start, end: grapheme.start, graphemes: members });
      start = grapheme.end;
      members = [];
      previous = null;
      return;
    }
    const rect = grapheme.rect;
    if (previous !== null && rect !== null && startsNewLine(previous, rect)) {
      lines.push({ start, end: grapheme.start, graphemes: members });
      start = grapheme.start;
      members = [];
    }
    members.push(index);
    if (rect !== null) previous = rect;
  });
  lines.push({ start, end: textLength, graphemes: members });
  return lines;
}

/**
 * Pen origins and advances, before alignment. The block is laid out start-aligned, so each line's
 * pen starts at 0. Inside a line, a grapheme with an `anchor` (a run's first) restarts the pen
 * there: Chromium gives each run's inline box a width of at least 0, so after a run whose
 * advances sum below 0 the next run starts at that run's start, not at its pen end. A rect is `[min, max]` of the pen before and after the grapheme, so a negative
 * advance (negative letter spacing) shows as a rect ending where the pen was: of the two
 * readings, the one whose origin is nearer the pen wins, the forward reading on a tie.
 */
export function measurePens(graphemes: readonly Grapheme[], lines: readonly LineSlot[]): Pen[] {
  const pens: Pen[] = graphemes.map(() => ({ x: 0, advance: 0 }));
  for (const line of lines) {
    let pen = 0;
    line.graphemes.forEach((index, position) => {
      const grapheme = graphemes[index]!;
      if (position > 0 && grapheme.anchor !== undefined) pen = grapheme.anchor;
      const rect = grapheme.rect;
      let reading: Pen;
      if (rect === null) {
        reading = { x: pen, advance: 0 };
      } else {
        const backward = { x: rect.left + rect.width, advance: -rect.width };
        const forward = { x: rect.left, advance: rect.width };
        reading =
          rect.width > 0 && Math.abs(backward.x - pen) < Math.abs(forward.x - pen) - EPSILON
            ? backward
            : forward;
      }
      pens[index] = reading;
      pen = reading.x + reading.advance;
    });
  }
  return pens;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * M6a-L1 long clusters: pieces of at most 32 units from the grapheme's start, a cut moved one
 * unit earlier when it would fall between a high and a low surrogate.
 */
export function clusterPieces(text: string, start: number, end: number): [number, number][] {
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

function runAt(request: TextLayoutRequest, offset: number): number {
  let end = 0;
  for (let index = 0; index < request.runs.length; index += 1) {
    end += request.runs[index]!.text.length;
    if (offset < end) return index;
  }
  return request.runs.length - 1;
}

const ALIGN_FACTOR = { left: 0, center: 0.5, right: 1 } as const;

export type AssembleInput = Readonly<{
  request: TextLayoutRequest;
  generation: number;
  lang: string;
  fontLists: readonly string[];
  graphemes: readonly Grapheme[];
  lines: readonly LineSlot[];
  /**
   * Pass-2 probe positions, one per line, or null when text-dom fell back (a probe moved a
   * cluster to another line).
   */
  metrics: readonly LineMetrics[] | null;
  /** The block's height, which ends the last line in probe mode. */
  blockHeight: number;
}>;

/**
 * M6a-L1 result. Line width: `max(0, e)`, `e` the pen after the last non-space cluster. Box
 * width: the request width, or the widest line for `width: null`. `left`: `max(0, (W − width) ×
 * k)`, applied to every cluster `x`. Line boxes: from the probes, a line's height reaching the next
 * line's top (the last the block's bottom); in the fallback, a line starts at the previous line's
 * bottom, is as tall as its tallest cluster rect (an empty line `lineHeight × size` of its run)
 * and has its baseline at `top + 0.8 × height`.
 */
export function assembleLayout(input: AssembleInput): TextLayoutResult {
  const { request, graphemes, lines: slots, metrics } = input;
  const text = request.runs.map((run) => run.text).join('');
  const pens = measurePens(graphemes, slots);
  const widths = slots.map((slot) => {
    let extent = 0;
    for (const index of slot.graphemes) {
      if (graphemes[index]!.space) continue;
      const pen = pens[index]!;
      extent = pen.x + pen.advance;
    }
    return Math.max(0, extent);
  });
  const boxWidth = request.width ?? Math.max(0, ...widths);
  const factor = ALIGN_FACTOR[request.align];
  const lines: TextLayoutLine[] = [];
  const clusters: TextLayoutCluster[] = [];
  let previousBottom = 0;
  slots.forEach((slot, lineIndex) => {
    let top: number;
    let height: number;
    let baseline: number;
    if (metrics !== null) {
      const own = metrics[lineIndex]!;
      top = own.top;
      const next = metrics[lineIndex + 1];
      height = (next === undefined ? input.blockHeight : next.top) - top;
      baseline = own.baseline;
    } else {
      top = previousBottom;
      let tallest = 0;
      for (const index of slot.graphemes) {
        tallest = Math.max(tallest, graphemes[index]!.rect?.height ?? 0);
      }
      height =
        slot.graphemes.length > 0
          ? tallest
          : request.lineHeight * request.runs[runAt(request, slot.start)]!.size;
      baseline = top + 0.8 * height;
    }
    previousBottom = top + height;
    const width = widths[lineIndex]!;
    const left = Math.max(0, (boxWidth - width) * factor);
    lines.push({ start: slot.start, end: slot.end, top, height, baseline, left, width });
    for (const index of slot.graphemes) {
      const grapheme = graphemes[index]!;
      const pen = pens[index]!;
      clusterPieces(text, grapheme.start, grapheme.end).forEach(([start, end], piece) => {
        clusters.push({
          start,
          end,
          line: lineIndex,
          run: grapheme.run,
          x: left + pen.x,
          y: baseline,
          advance: piece === 0 ? pen.advance : 0,
        });
      });
    }
  });
  const height = lines.reduce((sum, line) => sum + line.height, 0);
  return {
    generation: input.generation,
    lang: input.lang,
    width: boxWidth,
    height,
    fontLists: input.fontLists,
    lines,
    clusters,
  };
}
