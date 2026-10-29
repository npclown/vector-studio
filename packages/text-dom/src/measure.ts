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
import { buildRunTree, planInsertions } from './tree.js';

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

function relative(rect: DOMRect, origin: DOMRect): Rect {
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  };
}

/** The fragment of `rects` that overlaps `rect` vertically the most, relative to `origin`. */
function overlapping(rects: DOMRectList, origin: DOMRect, rect: Rect): Rect | null {
  let best: Rect | null = null;
  let bestOverlap = 0;
  for (const fragment of Array.from(rects)) {
    const candidate = relative(fragment, origin);
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
    }
    if (!host.isConnected) {
      const parent = document.body ?? document.documentElement;
      if (parent === null) throw new Error('text-dom: the document has no element to measure in');
      parent.append(host);
    }
    return block;
  }

  function probe(alignment: 'top' | 'baseline'): HTMLElement {
    const element = document.createElement('span');
    element.style.cssText = `${PROBE_STYLE}; vertical-align: ${alignment}`;
    return element;
  }

  return {
    measure(request, fontLists) {
      const target = ensureBlock();
      const width = request.width === null ? 'max-content' : `${request.width}px`;
      target.style.cssText = `${BLOCK_STYLE}; width: ${width}`;
      const tree = buildRunTree(document, request, fontLists);
      const { texts, runStarts, textLength } = tree;
      target.replaceChildren(...tree.elements, ...(tree.sentinel === null ? [] : [tree.sentinel]));

      try {
        const range = document.createRange();
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
                rect = first === undefined ? null : relative(first, origin);
              }
              graphemes.push({
                start: runStart + local,
                end: runStart + local + segment.length,
                run: index,
                lf,
                space: isHangingSpace(segment),
                rect,
              });
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
          top: top.getBoundingClientRect().top - origin.top,
          baseline: baseline.getBoundingClientRect().bottom - origin.top,
        }));
        // Fall back unless pass 2 kept every line start, every cluster's rect top and the
        // block's height: a changed line box shows in one of them.
        const again = read(origin);
        const againLines = assignLines(again, textLength);
        const same =
          Math.abs(origin.height - passOne.height) <= EPSILON &&
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
          blockHeight: origin.height,
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
