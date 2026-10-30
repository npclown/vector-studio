import type { TextLayoutLine, TextLayoutRequest, TextLayoutResult } from '@vector-studio/contracts';
import { eventToken } from './keymap.js';
import type { Modifiers, Platform } from './types.js';

// The caret model of text edit mode (MVP M6b contract, section 4): stops, words, caret
// geometry, point to offset, selection rectangles and the composition underline, and the
// movement and deletion table of section 4.2, all over one `TextLayoutResult` and its request.
// Pure: no DOM, no editor state. Offsets are UTF-16 into the node text and coordinates are
// node-local page units, y down (M6a-L1); mapping to and from the page is the caller's.

export type TextAffinity = 'downstream' | 'upstream';

/** The caret of section 2: `anchor` and `focus` on stops, `affinity` for a soft wrap. */
export type TextCaret = Readonly<{ anchor: number; focus: number; affinity: TextAffinity }>;

/** A node-local point. */
export type CaretPoint = Readonly<{ x: number; y: number }>;

/** A node-local segment from its first point to its second. */
export type CaretSegment = readonly [CaretPoint, CaretPoint];

/** A node-local axis-aligned rectangle, `width` never negative. */
export type CaretRect = Readonly<{ x: number; y: number; width: number; height: number }>;

/** A word segment of section 4.1 (M6b-Q10 (a)): an `Intl.Segmenter` word segment. */
export type WordSegment = Readonly<{ start: number; end: number; wordLike: boolean }>;

/** An offset with the affinity that places it on one line. */
export type CaretPosition = Readonly<{ offset: number; affinity: TextAffinity }>;

/**
 * Caret targets of section 4.2 and M6b-Q12 (a): the previous or next stop, the line above or
 * below at the goal x, the line's start or end, the previous word start, the next word start
 * (Windows) or end (macOS), and the text's start or end.
 */
export type CaretMovement =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'lineStart'
  | 'lineEnd'
  | 'previousWordStart'
  | 'nextWordStart'
  | 'nextWordEnd'
  | 'textStart'
  | 'textEnd';

/** The movements a deletion runs to (section 4.2: a cluster or a word either way). */
export type DeletionMovement = Extract<
  CaretMovement,
  'left' | 'right' | 'previousWordStart' | 'nextWordStart' | 'nextWordEnd' | 'lineStart'
>;

/** A key of the section 4.2 table, as `textEditKeyAction` reads it. */
export type TextEditKeyAction =
  | Readonly<{ type: 'move'; movement: CaretMovement; extend: boolean }>
  | Readonly<{ type: 'selectAll' }>
  | Readonly<{ type: 'delete'; movement: DeletionMovement }>
  | Readonly<{ type: 'lineBreak' }>;

/**
 * A movement's result: the new caret and the goal x (M6b-S3) to pass to the next vertical
 * move; null after any other movement, which clears it.
 */
export type CaretMoveResult = Readonly<{ caret: TextCaret; goalX: number | null }>;

/** Share of the run size a selected LF adds to its line's rectangle (M6b-Q11 (a)). */
export const SELECTED_LF_WIDTH = 0.25;

/** Share of the run size the composition underline sits below the baseline (section 4.3). */
export const COMPOSITION_UNDERLINE_OFFSET = 0.1;

const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter('ko', { granularity: 'word' });

/** A cluster of one line with the long-cluster pieces of M6a-L1 joined into their grapheme. */
type Glyph = Readonly<{ start: number; end: number; x: number; advance: number }>;

/** Index of the last value `<= target` in an ascending array, -1 when none. */
function lastAtOrBelow(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (values[mid]! <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * The caret model of one node's layout (section 4). Build it from the request the layout was
 * computed from and its result; it holds no reference to editor state.
 */
class CaretModel {
  readonly text: string;
  readonly length: number;
  /** Ascending stops (section 4.1), 0 and the length included. */
  readonly stops: readonly number[];
  /** The word segments of the whole text, in order, tiling it. */
  readonly words: readonly WordSegment[];
  readonly lines: readonly TextLayoutLine[];
  private readonly stopSet: ReadonlySet<number>;
  private readonly glyphs: readonly (readonly Glyph[])[];
  /** Per line, the unclamped x of each glyph start and of each glyph end (section 4.3). */
  private readonly startX: readonly ReadonlyMap<number, number>[];
  private readonly endX: readonly ReadonlyMap<number, number>[];
  private readonly runEnds: readonly number[];
  private readonly runSizes: readonly number[];
  /** The box width caret x is clamped to in wrapping modes, else null. */
  private readonly clampWidth: number | null;

  constructor(request: TextLayoutRequest, layout: TextLayoutResult) {
    this.text = request.runs.map((run) => run.text).join('');
    this.length = this.text.length;
    // Stops: grapheme boundaries of each run, so run boundaries are stops and a stop never
    // falls inside a cluster the layout reports (M6a-L1 segments per run as well).
    const stops = new Set<number>([0, this.length]);
    const runEnds: number[] = [];
    let offset = 0;
    for (const run of request.runs) {
      for (const { index } of graphemes.segment(run.text)) stops.add(offset + index);
      offset += run.text.length;
      stops.add(offset);
      runEnds.push(offset);
    }
    this.stopSet = stops;
    this.stops = [...stops].sort((a, b) => a - b);
    this.runEnds = runEnds;
    this.runSizes = request.runs.map((run) => run.size);
    this.words = [...wordSegmenter.segment(this.text)].map((segment) => ({
      start: segment.index,
      end: segment.index + segment.segment.length,
      wordLike: segment.isWordLike === true,
    }));
    this.lines = layout.lines;
    this.clampWidth = request.width === null ? null : layout.width;
    // Glyphs per line: a cluster whose start is not a stop is a later piece of a long grapheme
    // (M6a-L1: same x, advance 0) and extends the glyph before it, so only the grapheme's start
    // and end are caret positions and its end takes the whole advance.
    const glyphs: Glyph[][] = layout.lines.map(() => []);
    for (const cluster of layout.clusters) {
      const line = glyphs[cluster.line];
      if (line === undefined) continue;
      const last = line[line.length - 1];
      if (last !== undefined && last.end === cluster.start && !stops.has(cluster.start)) {
        line[line.length - 1] = { ...last, end: cluster.end };
      } else {
        line.push({
          start: cluster.start,
          end: cluster.end,
          x: cluster.x,
          advance: cluster.advance,
        });
      }
    }
    this.glyphs = glyphs;
    this.startX = glyphs.map((line) => new Map(line.map((glyph) => [glyph.start, glyph.x])));
    this.endX = glyphs.map(
      (line) => new Map(line.map((glyph) => [glyph.end, glyph.x + glyph.advance])),
    );
  }

  private clamp(x: number): number {
    return this.clampWidth === null ? x : Math.min(x, this.clampWidth);
  }

  /** Whether `offset` is an integer stop in `[0, length]`. */
  isStop(offset: number): boolean {
    return this.stopSet.has(offset);
  }

  /** The largest stop `<= offset` (clamped to the text), the "down" rule of section 4.1. */
  stopAtOrBefore(offset: number): number {
    const index = lastAtOrBelow(this.stops, offset);
    return index === -1 ? 0 : this.stops[index]!;
  }

  /** The smallest stop `>= offset` (clamped to the text), the "up" rule of section 4.1. */
  stopAtOrAfter(offset: number): number {
    if (offset <= 0) return 0;
    const index = lastAtOrBelow(this.stops, offset - 1);
    return index + 1 < this.stops.length ? this.stops[index + 1]! : this.length;
  }

  /** The previous stop, 0 at 0. */
  previousStop(offset: number): number {
    return this.stopAtOrBefore(offset - 1);
  }

  /** The next stop, the length at the length. */
  nextStop(offset: number): number {
    return this.stopAtOrAfter(offset + 1);
  }

  /** The start of the last word-like segment before `offset`, else 0. */
  previousWordStart(offset: number): number {
    let target = 0;
    for (const word of this.words) {
      if (word.start >= offset) break;
      if (word.wordLike) target = word.start;
    }
    return this.stopAtOrBefore(target);
  }

  /** The start of the first word-like segment after `offset`, else the length. */
  nextWordStart(offset: number): number {
    const word = this.words.find((segment) => segment.wordLike && segment.start > offset);
    return this.stopAtOrBefore(word?.start ?? this.length);
  }

  /** The end of the first word-like segment ending after `offset`, else the length. */
  nextWordEnd(offset: number): number {
    const word = this.words.find((segment) => segment.wordLike && segment.end > offset);
    return this.stopAtOrBefore(word?.end ?? this.length);
  }

  /**
   * The word segment a double-click at `offset` selects (M6-E6): the segment holding it, or the
   * word-like segment ending at it when the one starting there is not word-like, the last
   * segment at the length; `[0, 0]` for empty text.
   */
  wordAt(offset: number): Readonly<{ start: number; end: number }> {
    const words = this.words;
    if (words.length === 0) return { start: 0, end: 0 };
    let index = words.findIndex((word) => word.start <= offset && offset < word.end);
    if (index === -1) index = words.length - 1;
    const previous = words[index - 1];
    if (
      !words[index]!.wordLike &&
      previous !== undefined &&
      previous.wordLike &&
      previous.end === offset
    ) {
      index -= 1;
    }
    const word = words[index]!;
    return { start: this.stopAtOrBefore(word.start), end: this.stopAtOrBefore(word.end) };
  }

  /** The size of the run holding the unit at `offset`, the last run's at the length. */
  sizeAt(offset: number): number {
    const index = this.runEnds.findIndex((end) => offset < end);
    return this.runSizes[index === -1 ? this.runSizes.length - 1 : index]!;
  }

  /** Whether line `index` ends at a soft wrap (its end is the next line's start). */
  softWrapAfter(index: number): boolean {
    const next = this.lines[index + 1];
    return next !== undefined && next.start === this.lines[index]!.end;
  }

  /**
   * The line of `offset` (section 4.3): the line with `start <= offset <= end`; at a soft wrap
   * the affinity picks, downstream the next line and upstream this one.
   */
  lineOf(offset: number, affinity: TextAffinity): number {
    const index = this.lines.findIndex((line) => line.start <= offset && offset <= line.end);
    if (index === -1) return offset <= 0 ? 0 : this.lines.length - 1;
    if (
      affinity === 'downstream' &&
      offset === this.lines[index]!.end &&
      this.softWrapAfter(index)
    ) {
      return index + 1;
    }
    return index;
  }

  /**
   * Caret x of `offset` on line `index` (section 4.3): the x of the cluster starting there, else
   * the end of the cluster ending there, else the line's `left`; clamped to the box width in
   * the wrapping modes (M6b-Q11 (a)).
   */
  caretX(offset: number, index: number): number {
    const x =
      this.startX[index]?.get(offset) ??
      this.endX[index]?.get(offset) ??
      this.lines[index]?.left ??
      0;
    return this.clamp(x);
  }

  /** The caret segment of a position: from `(x, top)` to `(x, top + height)` of its line. */
  caretSegment(position: CaretPosition): CaretSegment {
    const index = this.lineOf(position.offset, position.affinity);
    const line = this.lines[index]!;
    const x = this.caretX(position.offset, index);
    return [
      { x, y: line.top },
      { x, y: line.top + line.height },
    ];
  }

  /**
   * The stop on line `index` whose caret x is nearest `x` (section 4.3): the line's cluster
   * starts and its end, ties to the earlier stop; the end of a soft-wrapped line is upstream.
   */
  nearestOnLine(index: number, x: number): CaretPosition {
    const line = this.lines[index]!;
    let best = line.end;
    let distance = Math.abs(this.caretX(line.end, index) - x);
    // One pass in text order: a glyph's start x is its own `x`, and `<` keeps the earlier stop
    // on a tie; the line end, compared first, wins a tie only when no start ties.
    for (const glyph of this.glyphs[index] ?? []) {
      if (!this.stopSet.has(glyph.start)) continue;
      const d = Math.abs(this.clamp(glyph.x) - x);
      if (d < distance || (d === distance && glyph.start < best)) {
        best = glyph.start;
        distance = d;
      }
    }
    const upstream = best === line.end && this.softWrapAfter(index);
    return { offset: best, affinity: upstream ? 'upstream' : 'downstream' };
  }

  /**
   * Point to offset (section 4.3) for a node-local point: the first line whose bottom is below
   * the point's y, clamped to the first and last lines, then its nearest stop.
   */
  pointToOffset(point: CaretPoint): CaretPosition {
    let index = this.lines.findIndex((line) => line.top + line.height > point.y);
    if (index === -1) index = this.lines.length - 1;
    return this.nearestOnLine(index, point.x);
  }

  /** Per line, the rectangle and the size its LF or start run gives, for `[min, max)`. */
  private rangeRects(
    from: number,
    to: number,
  ): { index: number; rect: CaretRect; start: number }[] {
    const min = Math.min(from, to);
    const max = Math.max(from, to);
    if (min === max) return [];
    const out: { index: number; rect: CaretRect; start: number }[] = [];
    this.lines.forEach((line, index) => {
      const a = Math.max(min, line.start);
      const b = Math.min(max, line.end);
      const hasLf = this.text.charCodeAt(line.end) === 10;
      const lfSelected = hasLf && min <= line.end && line.end < max;
      if (!(a < b) && !lfSelected) return;
      // Both end carets and every selected glyph's [x, x + advance], so a selection over
      // negative advances still covers its glyphs.
      let left = Math.min(this.caretX(a, index), this.caretX(b, index));
      let right = Math.max(this.caretX(a, index), this.caretX(b, index));
      for (const glyph of this.glyphs[index] ?? []) {
        if (glyph.start < a || glyph.end > b) continue;
        const g0 = this.clamp(glyph.x);
        const g1 = this.clamp(glyph.x + glyph.advance);
        left = Math.min(left, g0, g1);
        right = Math.max(right, g0, g1);
      }
      if (lfSelected) right += SELECTED_LF_WIDTH * this.sizeAt(line.end);
      out.push({
        index,
        start: a,
        rect: { x: left, y: line.top, width: right - left, height: line.height },
      });
    });
    return out;
  }

  /**
   * Selection rectangles of `[min, max)` (section 4.3): per line meeting it, from the caret x of
   * its first to that of its last offset on the line, over the line's top and height; a line
   * whose LF is selected extends by 0.25 times the size of the LF's run (M6b-Q11 (a)).
   */
  selectionRects(from: number, to: number): CaretRect[] {
    return this.rangeRects(from, to).map(({ rect }) => rect);
  }

  /**
   * The composition underline (section 4.3): the range's selection rectangles as segments at
   * `baseline + 0.1 × size`, the size of the run at the segment's first offset.
   */
  compositionSegments(from: number, to: number): CaretSegment[] {
    return this.rangeRects(from, to).map(({ index, rect, start }) => {
      const y = this.lines[index]!.baseline + COMPOSITION_UNDERLINE_OFFSET * this.sizeAt(start);
      return [
        { x: rect.x, y },
        { x: rect.x + rect.width, y },
      ] as const;
    });
  }
}

export type { CaretModel };

export function createCaretModel(request: TextLayoutRequest, layout: TextLayoutResult): CaretModel {
  return new CaretModel(request, layout);
}

/** The caret after the editor's own insertion ending at `end`: moved up to a stop (4.1). */
export function caretAfterInsertion(model: CaretModel, end: number): TextCaret {
  const offset = model.stopAtOrAfter(end);
  return { anchor: offset, focus: offset, affinity: 'downstream' };
}

/**
 * The caret after any other document change (section 4.1): each offset clamped to the new
 * length and moved down to a stop. The affinity is kept when nothing moved.
 */
export function clampCaret(model: CaretModel, caret: TextCaret): TextCaret {
  const anchor = model.stopAtOrBefore(Math.min(caret.anchor, model.length));
  const focus = model.stopAtOrBefore(Math.min(caret.focus, model.length));
  if (anchor === caret.anchor && focus === caret.focus) return caret;
  return { anchor, focus, affinity: 'downstream' };
}

/** Mod+A: 0 to the length. */
export function selectAll(model: CaretModel): TextCaret {
  return { anchor: 0, focus: model.length, affinity: 'downstream' };
}

/** The target of a movement from one position (the collapsed column of section 4.2). */
function target(
  model: CaretModel,
  from: CaretPosition,
  movement: CaretMovement,
  goalX: number | null,
): Readonly<{ position: CaretPosition; goalX: number | null }> {
  const downstream = (offset: number): CaretPosition => ({ offset, affinity: 'downstream' });
  switch (movement) {
    case 'left':
      return { position: downstream(model.previousStop(from.offset)), goalX: null };
    case 'right':
      return { position: downstream(model.nextStop(from.offset)), goalX: null };
    case 'up':
    case 'down': {
      const index = model.lineOf(from.offset, from.affinity);
      const x = goalX ?? model.caretX(from.offset, index);
      const next = movement === 'up' ? index - 1 : index + 1;
      if (next < 0) return { position: downstream(0), goalX: x };
      if (next >= model.lines.length) return { position: downstream(model.length), goalX: x };
      return { position: model.nearestOnLine(next, x), goalX: x };
    }
    case 'lineStart': {
      const line = model.lines[model.lineOf(from.offset, from.affinity)]!;
      return { position: downstream(line.start), goalX: null };
    }
    case 'lineEnd': {
      const index = model.lineOf(from.offset, from.affinity);
      const line = model.lines[index]!;
      const affinity = model.softWrapAfter(index) ? 'upstream' : 'downstream';
      return { position: { offset: line.end, affinity }, goalX: null };
    }
    case 'previousWordStart':
      return { position: downstream(model.previousWordStart(from.offset)), goalX: null };
    case 'nextWordStart':
      return { position: downstream(model.nextWordStart(from.offset)), goalX: null };
    case 'nextWordEnd':
      return { position: downstream(model.nextWordEnd(from.offset)), goalX: null };
    case 'textStart':
      return { position: downstream(0), goalX: null };
    case 'textEnd':
      return { position: downstream(model.length), goalX: null };
  }
}

/**
 * A movement of section 4.2. `extend` (Shift) moves `focus` only. Without it, a non-empty
 * selection collapses: Left and Right to its start or end, Up and Down to its start or end and
 * then move, every other movement from the focus. `goalX` is the goal x a previous vertical
 * move returned (M6b-S3), null when the caret changed otherwise since.
 */
export function moveCaret(
  model: CaretModel,
  caret: TextCaret,
  movement: CaretMovement,
  extend: boolean,
  goalX: number | null,
): CaretMoveResult {
  const collapsed = caret.anchor === caret.focus;
  const start = Math.min(caret.anchor, caret.focus);
  const end = Math.max(caret.anchor, caret.focus);
  const focus: CaretPosition = { offset: caret.focus, affinity: caret.affinity };
  if (!extend && !collapsed && (movement === 'left' || movement === 'right')) {
    const offset = movement === 'left' ? start : end;
    return { caret: { anchor: offset, focus: offset, affinity: 'downstream' }, goalX: null };
  }
  let from = focus;
  if (!extend && !collapsed && (movement === 'up' || movement === 'down')) {
    const offset = movement === 'up' ? start : end;
    from = offset === caret.focus ? focus : { offset, affinity: 'downstream' };
  }
  const result = target(model, from, movement, goalX);
  const { offset, affinity } = result.position;
  const anchor = extend ? caret.anchor : offset;
  return { caret: { anchor, focus: offset, affinity }, goalX: result.goalX };
}

/**
 * The range a deletion of section 4.2 removes: a non-empty selection; else from the caret to
 * the movement's target (Backspace `left`, Delete `right`, the word deletions to a word
 * start or, on macOS forward, a word end, macOS Meta+Backspace to the line start); null when that range is empty (Backspace at 0,
 * Delete at the length: a consumed no-op).
 */
export function deletionRange(
  model: CaretModel,
  caret: TextCaret,
  movement: DeletionMovement,
): Readonly<{ start: number; end: number }> | null {
  if (caret.anchor !== caret.focus) {
    return { start: Math.min(caret.anchor, caret.focus), end: Math.max(caret.anchor, caret.focus) };
  }
  const to = target(model, { offset: caret.focus, affinity: caret.affinity }, movement, null)
    .position.offset;
  if (to === caret.focus) return null;
  return { start: Math.min(to, caret.focus), end: Math.max(to, caret.focus) };
}

type ModifierSet = 'none' | 'ctrl' | 'alt' | 'meta' | 'other';

function modifierSet(modifiers: Modifiers): ModifierSet {
  const { alt, meta, ctrl } = modifiers;
  const count = Number(alt) + Number(meta) + Number(ctrl);
  if (count === 0) return 'none';
  if (count > 1) return 'other';
  return ctrl ? 'ctrl' : alt ? 'alt' : 'meta';
}

const PLAIN_MOVES: Readonly<Record<string, CaretMovement>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'lineStart',
  End: 'lineEnd',
};

/** `other`: Ctrl is `Mod` (Windows convention). */
const OTHER_MOD_MOVES: Readonly<Record<string, CaretMovement>> = {
  ArrowLeft: 'previousWordStart',
  ArrowRight: 'nextWordStart',
  Home: 'textStart',
  End: 'textEnd',
};

/** `mac`, M6b-Q12 (a): Alt moves by word, to the previous start and the next end. */
const MAC_ALT_MOVES: Readonly<Record<string, CaretMovement>> = {
  ArrowLeft: 'previousWordStart',
  ArrowRight: 'nextWordEnd',
};

/** `mac`, M6b-Q12 (a): Meta+Left and Right line ends, Meta+Up and Down (and Home, End) text ends. */
const MAC_META_MOVES: Readonly<Record<string, CaretMovement>> = {
  ArrowLeft: 'lineStart',
  ArrowRight: 'lineEnd',
  ArrowUp: 'textStart',
  ArrowDown: 'textEnd',
  Home: 'textStart',
  End: 'textEnd',
};

/**
 * The section 4.2 action of a keydown (`key`, as `KeyboardEvent.key`), or null when the key is
 * not in the table. Shift extends every movement and is ignored on Backspace; Delete, the word
 * deletions and Mod+A take no Shift. Mod+A matches the keymap token `KeyA`. Which keys
 * reach this is the key routing of section 5 (M6b-U4).
 */
export function textEditKeyAction(
  event: Readonly<{ key: string; code?: string; composing?: boolean; modifiers: Modifiers }>,
  platform: Platform,
): TextEditKeyAction | null {
  const { key, modifiers } = event;
  const set = modifierSet(modifiers);
  const extend = modifiers.shift;
  const move = (table: Readonly<Record<string, CaretMovement>>): TextEditKeyAction | null => {
    const movement = Object.hasOwn(table, key) ? table[key] : undefined;
    return movement === undefined ? null : { type: 'move', movement, extend };
  };
  const mod = platform === 'mac' ? 'meta' : 'ctrl';
  if (set === 'none') {
    if (key === 'Enter') return { type: 'lineBreak' };
    // Shift+Backspace deletes as Backspace; Shift+Delete stays out (cut on Windows).
    if (key === 'Backspace') return { type: 'delete', movement: 'left' };
    if (!extend && key === 'Delete') return { type: 'delete', movement: 'right' };
    return move(PLAIN_MOVES);
  }
  // Mod+A by the keymap's canonical token, so `code` KeyA counts on a non-Latin layout.
  if (set === mod && !extend && eventToken({ kind: 'keydown', ...event }) === 'KeyA') {
    return { type: 'selectAll' };
  }
  if (platform === 'other' && set === 'ctrl') {
    if (!extend && key === 'Backspace') return { type: 'delete', movement: 'previousWordStart' };
    if (!extend && key === 'Delete') return { type: 'delete', movement: 'nextWordStart' };
    return move(OTHER_MOD_MOVES);
  }
  if (platform === 'mac' && set === 'alt') {
    if (!extend && key === 'Backspace') return { type: 'delete', movement: 'previousWordStart' };
    if (!extend && key === 'Delete') return { type: 'delete', movement: 'nextWordEnd' };
    return move(MAC_ALT_MOVES);
  }
  if (platform === 'mac' && set === 'meta') {
    if (!extend && key === 'Backspace') return { type: 'delete', movement: 'lineStart' };
    return move(MAC_META_MOVES);
  }
  return null;
}
