import type { TextLayoutPort, TextLayoutRequest, TextLayoutResult } from '@vector-studio/contracts';
import type { Frame, TextNodeV8, TextRun } from '@vector-studio/model';
import { deepFreeze } from './freeze.js';
import { rotate } from './geometry.js';
import { probeNow, type RelayoutSplit } from './text-probe.js';

// Text layout in the editor (MVP M6a contract, sections 5 and 6.2): the request built from a
// text node, the request-keyed cache in front of the injected `TextLayoutPort`, the auto sizing
// of each mode and the growth anchor, and the run helpers the text commands share. Pure: no
// layout is stored in the document (M6a-S6), and nothing here holds a DOM type.

/**
 * Lays out a text node through the editor's cache; absent when the editor has no port, so every
 * edit that needs a layout fails with `editor.no-text-layout` (section 5, M6a-Q8).
 */
export type TextLayouter = (node: TextNodeV8) => TextLayoutResult;

/** The LRU size of the request-keyed cache, per generation (section 5). */
export const TEXT_LAYOUT_CACHE_SIZE = 10_000;

/** The size a command may author (M6a-Q19); derived sizes may go below it. */
export const MIN_AUTHORED_TEXT_SIZE = 0.5;

/**
 * The request of a node (section 5): its runs without colour, `width` null for `autoWidth`, else
 * the stored frame width, and its alignment, letter spacing and line height.
 */
export function layoutRequest(node: TextNodeV8): TextLayoutRequest {
  return {
    runs: node.runs.map((run) => ({ text: run.text, family: run.family, size: run.size })),
    width: node.sizing === 'autoWidth' ? null : node.frame.width,
    align: node.align,
    letterSpacing: node.letterSpacing,
    lineHeight: node.lineHeight,
  };
}

/**
 * V-21 (contract, section 4.2): a family name as CSS matches it, unquoted (undoing the string
 * escapes text-dom's `quoteCssString` writes: `\"`, `\\` and hex escapes) and ASCII
 * case-folded. An unquoted entry of a list (a generic family) is trimmed only. For the port's raw
 * names, see `foldFamily`.
 */
export function normalizeFamily(name: string): string {
  let value = name.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    value = '';
    for (let index = 0; index < inner.length; index += 1) {
      const character = inner[index]!;
      if (character !== '\\' || index + 1 >= inner.length) {
        value += character;
        continue;
      }
      const hex = /^[0-9a-fA-F]{1,6} ?/.exec(inner.slice(index + 1));
      if (hex === null) {
        value += inner[index + 1]!;
        index += 1;
      } else {
        value += String.fromCodePoint(Number.parseInt(hex[0].trim(), 16));
        index += hex[0].length;
      }
    }
  }
  return foldFamily(value);
}

/**
 * V-21: a raw family name as the port gives it (`FontFace.family`, a registered family), ASCII
 * case-folded only. text-dom's font list quotes the raw name exactly, so unquoting it there
 * (`normalizeFamily`) gives the same string; a raw name is never trimmed or unquoted.
 */
export function foldFamily(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** The families of a CSS font-family list, normalized: commas outside double quotes split it. */
export function fontListFamilies(list: string): string[] {
  const families: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index]!;
    if (quoted && character === '\\') index += 1;
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) {
      families.push(normalizeFamily(list.slice(start, index)));
      start = index + 1;
    }
  }
  families.push(normalizeFamily(list.slice(start)));
  return families.filter((family) => family.length > 0);
}

/** Whether a result's font lists name one of `changed` (normalized families). */
function affected(result: TextLayoutResult, changed: ReadonlySet<string>): boolean {
  return result.fontLists.some((list) =>
    fontListFamilies(list).some((family) => changed.has(family)),
  );
}

/**
 * The editor's layout cache (section 5): a node object maps to its request key in a `WeakMap`,
 * and request keys map to results in a least-recently-used map of `TEXT_LAYOUT_CACHE_SIZE`
 * entries, so nodes with equal requests share one layout. A generation change drops the
 * results it can affect (V-21, section 4.2: those whose font lists name a family the port's
 * `changedSince` returns, or all of them); a kept result keeps its older generation.
 */
export class TextLayoutCache {
  private readonly keys = new WeakMap<TextNodeV8, string>();
  private results = new Map<string, TextLayoutResult>();
  /** The generation the cache last synced to (kept results may be older). */
  private generation: number;
  /**
   * V-21: the request keys dropped since the editor last took them (`takeDropped`), or null
   * when everything was dropped; the relayout re-projects only those units.
   */
  private dropped: Set<string> | null = new Set();
  /**
   * V-21 review: whether the generation changed since the last `takeDropped`. While it has, a
   * result stored at the new generation also marks its key, so a unit whose result was not
   * held at the sync and is laid out again before the relayout is still re-projected.
   */
  private changedSinceTake = false;
  /**
   * The last generation `notify` reported, kept apart from the results' generation so that a
   * layout call between a bump and the editor's listener (another listener laying out) cannot
   * swallow the editor's event.
   */
  private notified: number;
  /**
   * V21-U1: while the bench's text probe times a relayout, the split it fills (layout calls,
   * their time, and how many new layouts equal the previous generation's). Null otherwise.
   */
  split: RelayoutSplit | null = null;
  /** V21-U1: the dropped generation's results, kept only while `split` is set. */
  private previous: Map<string, TextLayoutResult> | null = null;

  constructor(readonly port: TextLayoutPort) {
    this.generation = port.generation;
    this.notified = this.generation;
  }

  /** V21-U1: starts (`split`) or ends (null) a probed relayout; ending drops the kept results. */
  probe(split: RelayoutSplit | null): void {
    this.split = split;
    if (split === null) this.previous = null;
  }

  /** Drops the results an older generation's increments can affect (V-21, section 4.2). */
  private sync(generation: number): void {
    if (generation === this.generation) return;
    const changed = this.port.changedSince?.(this.generation) ?? null;
    this.generation = generation;
    this.changedSinceTake = true;
    this.previous = this.split === null ? null : new Map(this.results);
    if (changed === null) {
      this.results = new Map();
      this.dropped = null;
      return;
    }
    const families = new Set(changed.map(foldFamily));
    if (families.size === 0) return;
    for (const [key, result] of this.results) {
      if (!affected(result, families)) continue;
      this.results.delete(key);
      this.dropped?.add(key);
    }
  }

  /**
   * V-21: for the relayout, whether `node`'s projected layout may be stale: its result was
   * dropped or stored again since the generation changed after the last `takeDropped`, or is
   * not held. Null from `takeDropped` means all.
   */
  takeDropped(): ((node: TextNodeV8) => boolean) | null {
    const dropped = this.dropped;
    this.dropped = new Set();
    this.changedSinceTake = false;
    if (dropped === null) return null;
    return (node) => {
      const key = this.keys.get(node) ?? JSON.stringify(layoutRequest(node));
      return dropped.has(key) || !this.results.has(key);
    };
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

  layout(node: TextNodeV8): TextLayoutResult {
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
    const split = this.split;
    const started = split === null ? 0 : probeNow();
    const result = frozenCopy(this.port.layout(request()));
    if (split !== null) {
      split.layoutCalls += 1;
      split.layoutMs += probeNow() - started;
      const before = this.previous?.get(key);
      if (before !== undefined) {
        split.comparedLayouts += 1;
        if (sameLayout(before, result)) split.equalLayouts += 1;
      }
    }
    // A port that bumped during the call gave a result of a generation the cache no longer
    // holds; it is returned but not stored.
    if (this.port.generation !== generation) return result;
    this.results.set(key, result);
    if (this.changedSinceTake) this.dropped?.add(key);
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

/** V21-U1: whether two results lay out alike (the generation aside). */
function sameLayout(left: TextLayoutResult, right: TextLayoutResult): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    JSON.stringify(left.lines) === JSON.stringify(right.lines) &&
    JSON.stringify(left.clusters) === JSON.stringify(right.clusters)
  );
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
export function isAuto(node: TextNodeV8): boolean {
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
  align: TextNodeV8['align'],
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
export function refitFrame(node: TextNodeV8, layout: TextLayoutResult): Frame {
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
  before: TextNodeV8,
  frame: Frame,
): Readonly<{ sizing: TextNodeV8['sizing']; refit: boolean }> {
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
