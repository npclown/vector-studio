import type { TextLayoutRequest } from '@vector-studio/contracts';
import {
  assignLines,
  EPSILON,
  isHangingSpace,
  type Grapheme,
  type LineMetrics,
  type LineSlot,
  type Rect,
} from './assemble.js';
import { buildRunTree, planAscents, planInsertions, runSpan, SENTINEL } from './tree.js';

// The measurement element of the M6a contract (docs/plans/mvp-m6a-text-model-contract.md,
// section 4, M6-L1): a hidden host holding a shadow root with one block, one span per run, read
// with `Range.getClientRects` (pass 1) and with two zero-size probes per line (pass 2). Main
// thread only. The block is laid out start-aligned; `assembleLayout` applies M6a-L1's alignment
// (section 16, M6a-U4 notes).

const HOST_TAG = 'vector-studio-text-measure';

const HOST_STYLE: readonly (readonly [string, string])[] = [
  ['all', 'initial'],
  ['display', 'block'],
  ['position', 'fixed'],
  ['left', '0'],
  ['top', '0'],
  ['width', '0'],
  ['height', '0'],
  ['visibility', 'hidden'],
  ['contain', 'strict'],
  ['pointer-events', 'none'],
];

// `all: initial` first: it resets every inherited property but `direction` and `unicode-bidi`,
// which are set explicitly. `font-size: 0` is the zero-size strut (M6a-Q2): sizes, letter
// spacing and line height are set on the run spans.
const BLOCK_STYLE = [
  'all: initial',
  'display: block',
  'visibility: hidden',
  'direction: ltr',
  'unicode-bidi: isolate',
  'white-space: pre-wrap',
  'word-break: keep-all',
  'overflow-wrap: anywhere',
  'hyphens: none',
  'font-variant-ligatures: none',
  'text-spacing-trim: space-all',
  'text-autospace: no-autospace',
  'text-align: left',
  'font-size: 0',
].join('; ');

const PROBE_STYLE = 'display: inline-block; width: 0; height: 0; margin: 0; padding: 0; border: 0';

export type Measurement = Readonly<{
  graphemes: readonly Grapheme[];
  lines: readonly LineSlot[];
  /** Null when a probe moved a cluster to another line (the fallback). */
  metrics: readonly LineMetrics[] | null;
  blockHeight: number;
}>;

export interface Measurer {
  measure(request: TextLayoutRequest, fontLists: readonly string[]): Measurement;
  remove(): void;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * `rect` relative to `origin`, in the block's own CSS px: times `zoom`, the layout zoom the host
 * cancels (see `layoutZoom`), since the browser reports lengths inside the host divided by it.
 */
function relative(rect: DOMRect, origin: DOMRect, zoom: number): Rect {
  return {
    left: (rect.left - origin.left) * zoom,
    top: (rect.top - origin.top) * zoom,
    width: rect.width * zoom,
    height: rect.height * zoom,
  };
}

/**
 * The page's layout zoom `E`: the factor Chromium lays the document out at, in device px per CSS
 * px, browser zoom times the real device scale factor (M6c-U0, docs/evidence/m6c-u0/README.md).
 * `devicePixelRatio` cannot tell it: under CDP `deviceScaleFactor` emulation it reports the
 * emulated ratio while layout stays at the real one. So it is read from the layout unit, 1/64 of
 * a layout px: a host `width` of `w` CSS px is laid out as `floor(64 E w)` units and reads back as
 * that over `64 E`. The smallest `w = 2^k / 64` that reads back non-zero is one unit, so
 * `E = 1 / (64 × reading)`. A result within 1e-6 of `ratio` or of 1 is taken as that value.
 * Null when no unit reads back: the host has no layout box (it or an ancestor is not rendered)
 * or the zoom is outside [1/64, 32); the caller then measures uncancelled and asks again. Assumes Chromium (its 1/64 px layout unit,
 * floored widths and the font metric rounding this cancels) and no CSS `zoom` on the host's
 * ancestors; `cancelLayoutZoom` checks the result and falls back to 1 when it does not hold.
 */
export function layoutZoom(host: HTMLElement, ratio: number): number | null {
  host.style.setProperty('zoom', '1', 'important');
  if (host.getClientRects().length === 0) return null;
  let unit: number;
  try {
    unit = layoutUnit(host);
  } finally {
    host.style.setProperty('width', '0', 'important');
  }
  const zoom = 1 / (64 * unit);
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  if (Math.abs(zoom - 1) <= 1e-6) return 1;
  if (ratio > 0 && Math.abs(zoom / ratio - 1) <= 1e-6) return ratio;
  return zoom;
}

/**
 * Sets `zoom: 1/E` on `host` for the page's layout zoom `E` (`layoutZoom`) and returns `E`, the
 * factor every length read inside the host is multiplied by. It then checks that the host is laid
 * out at zoom 1: host widths of 1.5 and 1000.5 layout units must floor to 1 and 1000 units of its
 * own (a host still at `E` floors them to `floor(1.5 E)` and `floor(1000.5 E)`). Otherwise
 * (another engine, CSS `zoom` on an ancestor, a zoom the browser rounds) it sets `zoom: 1` and
 * returns 1, which keeps the error M6c-U0 removes rather than adding another. Null, with `zoom: 1`,
 * when `layoutZoom` cannot read the zoom (the host not rendered): the caller must not keep it.
 */
export function cancelLayoutZoom(host: HTMLElement, ratio: number): number | null {
  const zoom = layoutZoom(host, ratio);
  if (zoom === null || zoom === 1) return zoom;
  host.style.setProperty('zoom', String(1 / zoom), 'important');
  const units = (width: number): number => {
    host.style.setProperty('width', `${width / 64}px`, 'important');
    return host.getBoundingClientRect().width * zoom * 64;
  };
  let atOne: boolean;
  try {
    atOne = Math.abs(units(1.5) - 1) <= 1e-3 && Math.abs(units(1000.5) - 1000) <= 1e-3;
  } finally {
    host.style.setProperty('width', '0', 'important');
  }
  if (atOne) return zoom;
  host.style.setProperty('zoom', '1', 'important');
  return 1;
}

/** One layout unit of `host`, in CSS px, or 0 for a zoom outside [1/64, 32) (`layoutZoom`). */
function layoutUnit(host: HTMLElement): number {
  const read = (k: number): number => {
    host.style.setProperty('width', `${2 ** k / 64}px`, 'important');
    return host.getBoundingClientRect().width;
  };
  let reading = read(0);
  if (reading > 0) {
    // E ≥ 1: halve until it reads 0; the last non-zero reading is one unit.
    for (let k = -1; k >= -5; k -= 1) {
      const smaller = read(k);
      if (!(smaller > 0)) return reading;
      reading = smaller;
    }
    return 0;
  }
  // E < 1: double until it reads non-zero, which is then one unit.
  for (let k = 1; k <= 6; k += 1) {
    reading = read(k);
    if (reading > 0) return reading;
  }
  return 0;
}

/** The fragment of `rects` that overlaps `rect` vertically the most, relative to `origin`. */
function overlapping(rects: DOMRectList, origin: DOMRect, rect: Rect, zoom: number): Rect | null {
  let best: Rect | null = null;
  let bestOverlap = 0;
  for (const fragment of Array.from(rects)) {
    const candidate = relative(fragment, origin, zoom);
    const overlap =
      Math.min(candidate.top + candidate.height, rect.top + rect.height) -
      Math.max(candidate.top, rect.top);
    if (best === null || overlap > bestOverlap) {
      best = candidate;
      bestOverlap = overlap;
    }
  }
  return best;
}

export function createMeasurer(document: Document, lang: string): Measurer {
  let host: HTMLElement | null = null;
  let block: HTMLElement | null = null;
  /** The layout zoom the host cancels (`cancelLayoutZoom`). */
  let zoom = 1;
  /** The `devicePixelRatio` `zoom` was detected at; null before the first detection. */
  let detectedAt: number | null = null;

  function ensureBlock(): HTMLElement {
    if (host === null || block === null) {
      host = document.createElement(HOST_TAG);
      for (const [property, value] of HOST_STYLE) {
        host.style.setProperty(property, value, 'important');
      }
      host.setAttribute('aria-hidden', 'true');
      const root = host.attachShadow({ mode: 'open' });
      block = document.createElement('div');
      block.lang = lang;
      root.append(block);
      detectedAt = null;
    }
    if (!host.isConnected) {
      const parent = document.body ?? document.documentElement;
      if (parent === null) throw new Error('text-dom: the document has no element to measure in');
      parent.append(host);
    }
    // Measured at layout zoom 1 whatever the page's (M6c-U0): Chromium rounds a font's metrics to
    // whole device px at the size it lays out, so at another zoom they round elsewhere. Detected
    // again only when `devicePixelRatio` changes, which browser zoom, a real device scale change
    // and CDP emulation all do; a request at a stable ratio pays no extra layout. (A real device
    // scale change under unchanged CDP emulation keeps the ratio and is not seen until the next
    // ratio change: test setups only.)
    // A reading taken while the host is not rendered (`display: none` on it or an ancestor)
    // is not kept, so the next request detects again (M6c-U0 review r2).
    const ratio = document.defaultView?.devicePixelRatio ?? 1;
    if (ratio !== detectedAt) {
      const detected = cancelLayoutZoom(host, ratio);
      zoom = detected ?? 1;
      detectedAt = detected === null ? null : ratio;
    }
    return block;
  }

  function probe(alignment: 'top' | 'baseline'): HTMLElement {
    const element = document.createElement('span');
    element.style.cssText = `${PROBE_STYLE}; vertical-align: ${alignment}`;
    return element;
  }

  /**
   * Each run's ascent: from the top of a text rect in its style to its baseline (M6a-U4b). In
   * Chromium a text rect spans the run's primary font's ascent and descent, the same for every
   * grapheme of the run, a fallback face's glyph included, so one U+200B per distinct font list
   * and size, each on a line of its own with a baseline probe after it, gives it. Measured on
   * every request: a cache would go stale when a face becomes active without a generation bump
   * (section 16, M6a-U4b review r2). Null where the U+200B has no rect.
   */
  function measureAscents(
    target: HTMLElement,
    range: Range,
    request: TextLayoutRequest,
    fontLists: readonly string[],
  ): (number | null)[] {
    const { keys, firsts } = planAscents(request, fontLists);
    target.style.setProperty('white-space', 'pre');
    const samples = firsts.map((index) => {
      const span = runSpan(document, request, fontLists, index);
      const text = document.createTextNode(SENTINEL);
      const marker = probe('baseline');
      span.append(text, marker);
      target.append(span, document.createElement('br'));
      return [keys[index]!, text, marker] as const;
    });
    const ascents = new Map<string, number>();
    for (const [key, text, marker] of samples) {
      range.setStart(text, 0);
      range.setEnd(text, text.data.length);
      const rect = range.getClientRects()[0];
      if (rect !== undefined) {
        ascents.set(key, (marker.getBoundingClientRect().bottom - rect.top) * zoom);
      }
    }
    target.replaceChildren();
    return keys.map((key) => ascents.get(key) ?? null);
  }

  return {
    measure(request, fontLists) {
      const target = ensureBlock();
      const width = request.width === null ? 'max-content' : `${request.width}px`;
      target.style.cssText = `${BLOCK_STYLE}; width: ${width}`;

      try {
        const range = document.createRange();
        const ascents = measureAscents(target, range, request, fontLists);
        // Pass 1 restores the block style that the ascents' `white-space: pre` replaced.
        target.style.cssText = `${BLOCK_STYLE}; width: ${width}`;
        const tree = buildRunTree(document, request, fontLists);
        const { texts, runStarts, textLength } = tree;
        target.replaceChildren(
          ...tree.elements,
          ...(tree.sentinel === null ? [] : [tree.sentinel]),
        );
        const read = (origin: DOMRect): Grapheme[] => {
          const graphemes: Grapheme[] = [];
          request.runs.forEach((run, index) => {
            const runStart = runStarts[index]!;
            for (const { segment, index: local } of segmenter.segment(run.text)) {
              const lf = segment === '\n';
              let rect: Rect | null = null;
              if (!lf) {
                const { node, local: at } = texts[index]!.locate(local, local + segment.length);
                range.setStart(node, at);
                range.setEnd(node, at + segment.length);
                const first = range.getClientRects()[0];
                rect = first === undefined ? null : relative(first, origin, zoom);
              }
              const ascent = ascents[index]!;
              const grapheme: Grapheme = {
                start: runStart + local,
                end: runStart + local + segment.length,
                run: index,
                lf,
                space: isHangingSpace(segment),
                rect,
              };
              graphemes.push(
                rect === null || ascent === null
                  ? grapheme
                  : { ...grapheme, baseline: rect.top + ascent },
              );
            }
          });
          return graphemes;
        };

        // Pass 1: cluster rects, without probes.
        const passOne = target.getBoundingClientRect();
        const measured = read(passOne);
        const lines = assignLines(measured, textLength);
        // Pen anchors (review r1 S1): Chromium gives each inline box a width of at least 0, so
        // under negative letter spacing a run that starts inside a line starts its pen at its
        // span's left edge, not where the previous run's pen ended. The first grapheme of a run
        // inside a line therefore takes the left of its span's fragment on that line.
        const graphemes = measured.map((grapheme, index): Grapheme => {
          const previous = measured[index - 1];
          if (
            grapheme.lf ||
            grapheme.rect === null ||
            previous === undefined ||
            previous.lf ||
            previous.run === grapheme.run
          ) {
            return grapheme;
          }
          const local = grapheme.start - runStarts[grapheme.run]!;
          const { node } = texts[grapheme.run]!.locate(
            local,
            grapheme.end - runStarts[grapheme.run]!,
          );
          const fragment = overlapping(
            (node.parentNode as Element).getClientRects(),
            passOne,
            grapheme.rect,
            zoom,
          );
          return fragment === null ? grapheme : { ...grapheme, anchor: fragment.left };
        });
        const lfRuns = new Map<number, number>();
        for (const grapheme of graphemes) if (grapheme.lf) lfRuns.set(grapheme.start, grapheme.run);

        // Pass 2. Probes are atomic inlines, which add break opportunities on both sides, so a
        // probe after a line's first cluster lets that cluster wrap back onto the previous line.
        // Pass 2 therefore keeps pass 1's lines: the block switches to `white-space: pre` (no
        // soft wrap) and a `<br>` ends each soft-wrapped line (section 16, M6a-U4 notes). Line
        // boxes hold the same inline boxes, so their tops and baselines are pass 1's. After each
        // line's first cluster go a top-aligned and a baseline-aligned probe (`planInsertions`).
        target.style.setProperty('white-space', 'pre');
        const probes: (readonly [HTMLElement, HTMLElement])[] = [];
        for (const insertion of planInsertions(graphemes, lines, runStarts, textLength, lfRuns)) {
          if (insertion.kind === 'br-after-run') {
            const last = tree.runLast[insertion.run]!;
            last.parentNode!.insertBefore(document.createElement('br'), last.nextSibling);
            continue;
          }
          if (insertion.kind === 'br') {
            texts[insertion.run]!.insertAt(insertion.offset, [document.createElement('br')], 'end');
            continue;
          }
          const pair = [probe('top'), probe('baseline')] as const;
          probes[insertion.line] = pair;
          if (insertion.run === 'sentinel') tree.sentinel!.append(...pair);
          else texts[insertion.run]!.insertAt(insertion.offset, pair, insertion.side);
        }
        const origin = target.getBoundingClientRect();
        const metrics = probes.map(([top, baseline]) => ({
          top: (top.getBoundingClientRect().top - origin.top) * zoom,
          baseline: (baseline.getBoundingClientRect().bottom - origin.top) * zoom,
        }));
        // Fall back unless pass 2 kept every line start, every cluster's rect top and the
        // block's height: a changed line box shows in one of them.
        const again = read(origin);
        const againLines = assignLines(again, textLength);
        const same =
          Math.abs(origin.height - passOne.height) * zoom <= EPSILON &&
          againLines.length === lines.length &&
          againLines.every((line, index) => line.start === lines[index]!.start) &&
          again.every((grapheme, index) => {
            const before = graphemes[index]!.rect;
            const after = grapheme.rect;
            return before === null || after === null || Math.abs(before.top - after.top) <= EPSILON;
          });
        return {
          graphemes,
          lines,
          metrics: same ? metrics : null,
          blockHeight: origin.height * zoom,
        };
      } finally {
        // Probes and the sentinel never outlive a request.
        target.replaceChildren();
      }
    },
    remove() {
      host?.remove();
      host = null;
      block = null;
    },
  };
}
