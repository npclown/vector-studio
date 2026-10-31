import type { TextLayoutRequest } from '@vector-studio/contracts';
import type { Grapheme, LineSlot } from './assemble.js';
import { runDeclarations, TEXT_DECLARATIONS } from './style.js';

// The measurement block's content (docs/plans/mvp-m6a-text-model-contract.md, section 4, with
// the M6a-U4 amendments of section 16) and the pass-2 insertions, kept apart from the reading so
// a test can run them over a small fake node tree. Only `createElement`, `createTextNode`,
// `append`, `insertBefore`, `nextSibling`, `parentNode` and `splitText` are used.

/**
 * Each run is a sequence of sibling spans, each with the run's font, size, letter spacing and
 * line height and the layout's `lang` (see `runSpan`): its text between LFs in spans that also set `direction: ltr; unicode-bidi:
 * bidi-override`, and each LF in a span of its own without the override. An LF inside a
 * `bidi-override` span carried that run's line height onto the next line in Chromium (review r1
 * S2); an override span nested in a run span put an extra edge at run boundaries, which made an
 * emergency break there (width 0) add a line height (review r2, `ab` at 10 then `CD` at 40).
 */
export type RunTree = Readonly<{
  /** Every span of every run, in text order: the block's children before the sentinel. */
  elements: readonly HTMLElement[];
  /** The last span of each run (null for an empty run), after which a run-boundary `<br>` goes. */
  runLast: readonly (HTMLElement | null)[];
  texts: readonly RunText[];
  /** The sentinel's span, in the last run's style, or null when no sentinel is needed. */
  sentinel: HTMLElement | null;
  runStarts: readonly number[];
  textLength: number;
}>;

export const SENTINEL = '\u200b';

type Entry = { node: Text; start: number };

/** The text nodes of one run, by run-local UTF-16 offset, kept in order across splits. */
export class RunText {
  private readonly entries: Entry[] = [];

  add(node: Text, start: number): void {
    this.entries.push({ node, start });
  }

  /** The text node holding `[start, end)` and the local offset of `start` in it. */
  locate(start: number, end: number): { node: Text; local: number } {
    for (const entry of this.entries) {
      if (start >= entry.start && end <= entry.start + entry.node.data.length) {
        return { node: entry.node, local: start - entry.start };
      }
    }
    throw new Error('text-dom: measurement text missing');
  }

  /**
   * Inserts `nodes` at run-local `offset`. `end` puts them at the end of the text node that
   * ends at or holds the offset (after a grapheme); `start` at the start of the node that begins
   * at or holds it (before a grapheme or an LF). A text node is split when the offset is inside.
   */
  insertAt(offset: number, nodes: readonly Node[], side: 'end' | 'start'): void {
    const index = this.entries.findIndex((entry) => {
      const length = entry.node.data.length;
      return side === 'end'
        ? offset > entry.start && offset <= entry.start + length
        : offset >= entry.start && offset < entry.start + length;
    });
    if (index === -1) throw new Error('text-dom: insertion point missing');
    const entry = this.entries[index]!;
    const local = offset - entry.start;
    const parent = entry.node.parentNode!;
    let reference: Node | null;
    if (local === 0) {
      reference = entry.node;
    } else if (local === entry.node.data.length) {
      reference = entry.node.nextSibling;
    } else {
      const rest = entry.node.splitText(local);
      this.entries.splice(index + 1, 0, { node: rest, start: offset });
      reference = rest;
    }
    for (const node of nodes) parent.insertBefore(node, reference);
  }
}

/**
 * A span in run `index`'s style: font list, size, letter spacing and line height (style.ts), and
 * the layout's `lang` as its own attribute. The block's `all: initial` resets the locale the
 * block's `lang` attribute sets (Chromium's `-webkit-locale`), so without a span's own attribute
 * the text shaped with no locale and the font's default forms, while the glyph raster port draws
 * with the context's `lang` and so the locale's `locl` forms (M6c-U3 follow-up, contract U3 notes).
 */
export function runSpan(
  document: Document,
  request: TextLayoutRequest,
  fontLists: readonly string[],
  index: number,
  lang: string,
): HTMLElement {
  const run = request.runs[index]!;
  const span = document.createElement('span');
  span.lang = lang;
  const declarations = runDeclarations({
    fontList: fontLists[index]!,
    size: run.size,
    letterSpacing: request.letterSpacing,
    lineHeight: request.lineHeight,
  });
  for (const [property, value] of declarations) span.style.setProperty(property, value);
  return span;
}

/**
 * The key of a run's ascent (M6a-U4b): its font list and size, the two styles a text rect's
 * height depends on (letter spacing and line height do not move it).
 */
export function ascentKey(fontList: string, size: number): string {
  return JSON.stringify([fontList, size]);
}

/** Each run's ascent key, and the first run of each distinct key, measured once per request. */
export type AscentPlan = Readonly<{ keys: readonly string[]; firsts: readonly number[] }>;

export function planAscents(request: TextLayoutRequest, fontLists: readonly string[]): AscentPlan {
  const keys = request.runs.map((run, index) => ascentKey(fontLists[index]!, run.size));
  const seen = new Set<string>();
  const firsts: number[] = [];
  keys.forEach((key, index) => {
    if (seen.has(key)) return;
    seen.add(key);
    firsts.push(index);
  });
  return { keys, firsts };
}

export function buildRunTree(
  document: Document,
  request: TextLayoutRequest,
  fontLists: readonly string[],
  lang: string,
): RunTree {
  const styled = (index: number): HTMLElement => runSpan(document, request, fontLists, index, lang);
  const elements: HTMLElement[] = [];
  const runLast: (HTMLElement | null)[] = [];
  const texts: RunText[] = [];
  const runStarts: number[] = [];
  let textLength = 0;
  request.runs.forEach((run, index) => {
    const text = new RunText();
    let last: HTMLElement | null = null;
    let local = 0;
    for (const piece of run.text.split(/(\n)/u)) {
      if (piece.length === 0) continue;
      const span = styled(index);
      if (piece !== '\n') {
        for (const [property, value] of TEXT_DECLARATIONS) span.style.setProperty(property, value);
      }
      const node = document.createTextNode(piece);
      span.append(node);
      elements.push(span);
      last = span;
      text.add(node, local);
      local += piece.length;
    }
    runLast.push(last);
    texts.push(text);
    runStarts.push(textLength);
    textLength += run.text.length;
  });
  // M6a-L1: an empty text or one ending in LF gets a sentinel in the last run's style, so its
  // last line has a line box; the sentinel is never a cluster.
  let sentinel: HTMLElement | null = null;
  if (textLength === 0 || request.runs.at(-1)!.text.endsWith('\n')) {
    sentinel = styled(request.runs.length - 1);
    sentinel.append(document.createTextNode(SENTINEL));
  }
  return { elements, runLast, texts, sentinel, runStarts, textLength };
}

/** One pass-2 insertion: a `<br>` or a probe pair, at a run-local offset or in the sentinel. */
export type Insertion = Readonly<
  | { kind: 'br'; run: number; offset: number; side: 'end' }
  | { kind: 'br-after-run'; run: number }
  | { kind: 'probes'; line: number; run: number; offset: number; side: 'end' | 'start' }
  | { kind: 'probes'; line: number; run: 'sentinel' }
>;

/**
 * Pass-2 insertions, in the order they are applied: every `<br>`, then every probe pair, each in
 * text order. A soft-wrapped line (not the first, not after an LF) gets a
 * `<br>` right after the previous line's last grapheme. Inside a run it goes into the text; at a
 * run boundary it goes between the two runs' spans: a `<br>` at the start of the next
 * run's span put that span's opening edge, and its line height, on the previous line (review r1
 * B1), and one at the end of the previous run's span put that span's closing edge on the next
 * line (observed while fixing B1). Each line with a grapheme takes its probes after its first
 * grapheme; an empty line ended by an LF before that LF; the sentinel line in the sentinel.
 */
export function planInsertions(
  graphemes: readonly Grapheme[],
  lines: readonly LineSlot[],
  runStarts: readonly number[],
  textLength: number,
  lfRuns: ReadonlyMap<number, number>,
): Insertion[] {
  const result: Insertion[] = [];
  lines.forEach((line, index) => {
    const first = line.graphemes[0];
    if (first !== undefined) {
      const previous = lines[index - 1];
      if (previous !== undefined && !lfRuns.has(line.start - 1)) {
        const last = graphemes[previous.graphemes.at(-1)!]!;
        const offset = last.end - runStarts[last.run]!;
        const runEnd = (runStarts[last.run + 1] ?? textLength) - runStarts[last.run]!;
        result.push(
          offset === runEnd
            ? { kind: 'br-after-run', run: last.run }
            : { kind: 'br', run: last.run, offset, side: 'end' },
        );
      }
      const grapheme = graphemes[first]!;
      result.push({
        kind: 'probes',
        line: index,
        run: grapheme.run,
        offset: grapheme.end - runStarts[grapheme.run]!,
        side: 'end',
      });
    } else if (line.end < textLength) {
      const run = lfRuns.get(line.end)!;
      result.push({
        kind: 'probes',
        line: index,
        run,
        offset: line.end - runStarts[run]!,
        side: 'start',
      });
    } else {
      result.push({ kind: 'probes', line: index, run: 'sentinel' });
    }
  });
  // Every `<br>` first (review r2 B1): on a soft-wrapped line of one grapheme, its probes and the
  // next line's `<br>` share an offset, and an `end` insertion goes right after the text node, so
  // inserting the `<br>` after the probes put it before them and moved the probes to the next
  // line. With the `<br>`s in place first, each later `end` insertion lands before them.
  return [
    ...result.filter((insertion) => insertion.kind !== 'probes'),
    ...result.filter((insertion) => insertion.kind === 'probes'),
  ];
}
