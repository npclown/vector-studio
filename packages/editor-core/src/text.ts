import type { TextLayoutPort, TextLayoutRequest, TextLayoutResult } from '@vector-studio/contracts';
import type { Frame, TextNode, TextRun } from '@vector-studio/model';
import { deepFreeze } from './freeze.js';
import { rotate } from './geometry.js';

// Text layout in the editor (MVP M6a contract, sections 5 and 6.2): the request built from a
// text node, the request-keyed cache in front of the injected `TextLayoutPort`, the auto sizing
// of each mode and the growth anchor, and the run helpers the text commands share. Pure: no
// layout is stored in the document (M6a-S6), and nothing here holds a DOM type.

/**
 * Lays out a text node through the editor's cache; absent when the editor has no port, so every
 * edit that needs a layout fails with `editor.no-text-layout` (section 5, M6a-Q8).
 */
export type TextLayouter = (node: TextNode) => TextLayoutResult;

/** The LRU size of the request-keyed cache, per generation (section 5). */
export const TEXT_LAYOUT_CACHE_SIZE = 10_000;

/** The size a command may author (M6a-Q19); derived sizes may go below it. */
export const MIN_AUTHORED_TEXT_SIZE = 0.5;

/**
 * The request of a node (section 5): its runs without colour, `width` null for `autoWidth`, else
 * the stored frame width, and its alignment, letter spacing and line height.
 */
export function layoutRequest(node: TextNode): TextLayoutRequest {
  return {
    runs: node.runs.map((run) => ({ text: run.text, family: run.family, size: run.size })),
    width: node.sizing === 'autoWidth' ? null : node.frame.width,
    align: node.align,
    letterSpacing: node.letterSpacing,
    lineHeight: node.lineHeight,
  };
}

/**
 * The editor's layout cache (section 5): a node object maps to its request key in a `WeakMap`,
 * and request keys map to results in a least-recently-used map of `TEXT_LAYOUT_CACHE_SIZE`
 * entries, so nodes with equal requests share one layout. The map holds one generation: a
 * generation change drops it.
 */
export class TextLayoutCache {
  private readonly keys = new WeakMap<TextNode, string>();
  private results = new Map<string, TextLayoutResult>();
  /** The generation the results belong to. */
  private generation: number;
  /**
   * The last generation `notify` reported, kept apart from the results' generation so that a
   * layout call between a bump and the editor's listener (another listener laying out) cannot
   * swallow the editor's event.
   */
  private notified: number;

  constructor(readonly port: TextLayoutPort) {
    this.generation = port.generation;
    this.notified = this.generation;
  }

  /** Drops the results of an older generation. */
  private sync(generation: number): void {
    if (generation === this.generation) return;
    this.generation = generation;
    this.results = new Map();
  }

  /**
   * For the port listener: drops older results and tells whether the generation differs from
   * the one last reported, which then becomes the reported one.
   */
  notify(): boolean {
    const generation = this.port.generation;
    this.sync(generation);
    if (generation === this.notified) return false;
    this.notified = generation;
    return true;
  }

  layout(node: TextNode): TextLayoutResult {
    let key = this.keys.get(node);
    if (key === undefined) {
      key = JSON.stringify(layoutRequest(node));
      this.keys.set(node, key);
    }
    return this.lookup(key, () => layoutRequest(node));
  }

  /**
   * A request that names no node (a pending node's empty layout, MVP M6b contract, section
   * 4.3), through the same cache.
   */
  layoutRequest(request: TextLayoutRequest): TextLayoutResult {
    return this.lookup(JSON.stringify(request), () => request);
  }

  private lookup(key: string, request: () => TextLayoutRequest): TextLayoutResult {
    const generation = this.port.generation;
    this.sync(generation);
    const cached = this.results.get(key);
    if (cached !== undefined) {
      // Most recently used last.
      this.results.delete(key);
      this.results.set(key, cached);
      return cached;
    }
    const result = frozenCopy(this.port.layout(request()));
    // A port that bumped during the call gave a result of a generation the cache no longer
    // holds; it is returned but not stored.
    if (this.port.generation !== generation) return result;
    this.results.set(key, result);
    if (this.results.size > TEXT_LAYOUT_CACHE_SIZE) {
      this.results.delete(this.results.keys().next().value!);
    }
    return result;
  }

  /** The number of cached results, for tests. */
  get size(): number {
    return this.results.size;
  }
}

/** A frozen copy of a port's result, so the port's own objects are never frozen or kept. */
function frozenCopy(result: TextLayoutResult): TextLayoutResult {
  return deepFreeze({
    generation: result.generation,
    lang: result.lang,
    width: result.width,
    height: result.height,
    fontLists: [...result.fontLists],
    lines: result.lines.map((line) => ({ ...line })),
    clusters: result.clusters.map((cluster) => ({ ...cluster })),
  });
}

/** Whether a mode takes any dimension from the layout (section 6.2). */
export function isAuto(node: TextNode): boolean {
  return node.sizing !== 'fixed';
}

const ANCHOR = { left: 0, center: 0.5, right: 1 } as const;

/**
 * The frame of a box resized from `frame` to `width` by `height` with the growth anchor of
 * section 6.2 kept on the page: the point `(a·w, 0)` of the box in its own axes, `a` by `align`.
 * An unchanged size returns `frame` itself.
 */
export function anchoredFrame(
  frame: Frame,
  rotation: number,
  align: TextNode['align'],
  width: number,
  height: number,
): Frame {
  const { x, y, width: w, height: h } = frame;
  if (width === w && height === h) return frame;
  const a = ANCHOR[align];
  // At rotation 0 exactly `x' = x + a·(w − w')`, `y' = y`.
  if (rotation === 0) return { x: x + a * (w - width), y, width, height };
  const before = rotate(rotation, a * w - w / 2, -h / 2);
  const after = rotate(rotation, a * width - width / 2, -height / 2);
  const cx = x + w / 2 + before.x - after.x;
  const cy = y + h / 2 + before.y - after.y;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/**
 * The frame of an auto node refit to `layout` (section 6.2): `autoWidth` takes the layout's
 * width and height, `autoHeight` its height with the stored width; `fixed` keeps its frame.
 */
export function refitFrame(node: TextNode, layout: TextLayoutResult): Frame {
  if (node.sizing === 'fixed') return node.frame;
  const width = node.sizing === 'autoWidth' ? layout.width : node.frame.width;
  return anchoredFrame(node.frame, node.rotation, node.align, width, layout.height);
}

/**
 * The sizing mode after a frame change from `before` to `frame` with sizes unchanged (the
 * `setFrames` row of section 6.3): a height change makes an auto mode `fixed`; a width change
 * alone makes `autoWidth` `autoHeight` and refits the height; position and rotation alone keep
 * the mode. `refit` tells whether the node needs a refit.
 */
export function frameRule(
  before: TextNode,
  frame: Frame,
): Readonly<{ sizing: TextNode['sizing']; refit: boolean }> {
  if (before.sizing === 'fixed') return { sizing: 'fixed', refit: false };
  if (frame.height !== before.frame.height) return { sizing: 'fixed', refit: false };
  if (frame.width !== before.frame.width) return { sizing: 'autoHeight', refit: true };
  return { sizing: before.sizing, refit: false };
}

/** Every run's size times `s` (group and constraint scale, section 6.3). */
export function scaledRuns(runs: readonly TextRun[], s: number): TextRun[] {
  return runs.map((run) => ({ ...run, size: run.size * s }));
}

// Run helpers of the text commands (section 6.1). Offsets are UTF-16 units into the node text.

type Style = Pick<TextRun, 'family' | 'size' | 'color'>;

export function textLength(runs: readonly TextRun[]): number {
  return runs.reduce((total, run) => total + run.text.length, 0);
}

export function nodeText(runs: readonly TextRun[]): string {
  return runs.map((run) => run.text).join('');
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    a.family === b.family &&
    a.size === b.size &&
    a.color.r === b.color.r &&
    a.color.g === b.color.g &&
    a.color.b === b.color.b &&
    a.color.a === b.color.a
  );
}

function styleOf(run: TextRun): Style {
  return { family: run.family, size: run.size, color: run.color };
}

/** Whether offset `o` falls between the high and the low surrogate of a pair. */
export function splitsPair(text: string, o: number): boolean {
  if (o <= 0 || o >= text.length) return false;
  const high = text.charCodeAt(o - 1);
  const low = text.charCodeAt(o);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/** The style of the character before `offset`, the first run's at 0 (section 6.1). */
export function styleBefore(runs: readonly TextRun[], offset: number): Style {
  let end = 0;
  for (const run of runs) {
    end += run.text.length;
    if (offset - 1 < end) return styleOf(run);
  }
  return styleOf(runs[runs.length - 1]!);
}

/** The runs cut to `[start, end)`, empty pieces dropped. */
function sliceRuns(runs: readonly TextRun[], start: number, end: number): TextRun[] {
  const out: TextRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + run.text.length);
    if (from < to) out.push({ ...run, text: run.text.slice(from - offset, to - offset) });
    offset += run.text.length;
  }
  return out;
}

/**
 * Canonical runs (M6a-S2): empty runs dropped and adjacent runs of equal style merged; with no
 * text left, one empty run in `fallback`.
 */
export function canonicalRuns(runs: readonly TextRun[], fallback: Style): TextRun[] {
  const out: TextRun[] = [];
  for (const run of runs) {
    if (run.text.length === 0) continue;
    const last = out[out.length - 1];
    if (last !== undefined && sameStyle(last, run)) {
      out[out.length - 1] = { ...last, text: last.text + run.text };
    } else {
      out.push(run);
    }
  }
  return out.length === 0 ? [{ text: '', ...fallback }] : out;
}

/** `setText`: `[start, end)` replaced with `text` in the style of the character before `start`. */
export function replaceText(
  runs: readonly TextRun[],
  start: number,
  end: number,
  text: string,
): TextRun[] {
  const style = styleBefore(runs, start);
  const length = textLength(runs);
  return canonicalRuns(
    [...sliceRuns(runs, 0, start), { text, ...style }, ...sliceRuns(runs, end, length)],
    style,
  );
}

/** `setTextStyle`: `style` over `[start, end)`; on an empty node (0, 0) it restyles its run. */
export function restyleText(
  runs: readonly TextRun[],
  start: number,
  end: number,
  style: Partial<Style>,
): TextRun[] {
  if (textLength(runs) === 0) {
    const run = { ...runs[0]!, ...style };
    return [run];
  }
  const length = textLength(runs);
  const middle = sliceRuns(runs, start, end).map((run) => ({ ...run, ...style }));
  return canonicalRuns(
    [...sliceRuns(runs, 0, start), ...middle, ...sliceRuns(runs, end, length)],
    styleOf(runs[0]!),
  );
}
