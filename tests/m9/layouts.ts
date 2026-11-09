// MVP M9-U1 (M9 contract, section 3.2, M9-A02): the text layouts of the v2 document's page 1, so
// Node can project its text leaves with the committed font's layout (E28-K9 bounds) and choose
// the typical-view camera and check the fitted camera F as U1a does for v1, the same on every
// machine.
//
// The editor does not refit text frames on load (it projects stored frames), so every layout
// request of page 1, expanded instance text included, follows from the generated document alone:
// `m9LayoutRequests` lists them. The browser answers them: the harness test `m9-v2-layouts`
// (tests/e26/e26-harness.spec.ts, run only when `E26_SCENARIOS=m9-v2-layouts`) opens the bench
// page with `doc=m9-v2` (test font registered under the test family, `M9_SECOND_FAMILY` falling
// back to it) and lays out each request through the page's port, then judges the camera claims
// over those layouts and reports how they differ from the committed table `m9-v2-layouts.json`
// (`m9LayoutDiff`), or with `M9_RECORD_LAYOUTS=1` writes it. The table stores each result
// compactly (lines and clusters as arrays); `m9ReplayLayout` expands it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  TextLayoutCluster,
  TextLayoutLine,
  TextLayoutRequest,
  TextLayoutResult,
} from '@vector-studio/contracts';
import type { DocumentV7, TextNodeV7 } from '@vector-studio/model';
import { layoutRequest } from '../../packages/editor-core/src/text.js';
import { M9_V2_PAGE, projectM9Page } from './document.js';

export const M9_LAYOUT_TABLE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'm9-v2-layouts.json',
);

type Line = [number, number, number, number, number, number, number];
type Cluster = [number, number, number, number, number, number, number];
export type CompactLayout = Readonly<{
  generation: number;
  lang: string;
  width: number;
  height: number;
  fontLists: readonly string[];
  lines: readonly Line[];
  clusters: readonly Cluster[];
}>;
export type M9LayoutTable = Readonly<{
  /** How the table was made: the page URL and the browser. */
  recordedWith: Readonly<{ url: string; browser: string }>;
  /** Request key (`JSON.stringify` of the request, the editor cache's key) to result. */
  layouts: Readonly<Record<string, CompactLayout>>;
}>;

/** The cache key the editor uses (editor-core text.ts `TextLayoutCache`). */
export function requestKey(request: TextLayoutRequest): string {
  return JSON.stringify(request);
}

/** Every distinct layout request of the page's text, expanded copies included, in key order. */
export function m9LayoutRequests(
  document: DocumentV7,
  pageId = M9_V2_PAGE,
): readonly TextLayoutRequest[] {
  const requests = new Map<string, TextLayoutRequest>();
  projectM9Page(document, pageId, (node: TextNodeV7) => {
    const request = layoutRequest(node);
    requests.set(requestKey(request), request);
    return {
      generation: 0,
      lang: 'ko',
      width: 0,
      height: 0,
      fontLists: node.runs.map(() => 'sans-serif'),
      lines: [],
      clusters: [],
    };
  });
  return [...requests.keys()].sort().map((key) => requests.get(key)!);
}

export function compactLayout(result: TextLayoutResult): CompactLayout {
  return {
    generation: result.generation,
    lang: result.lang,
    width: result.width,
    height: result.height,
    fontLists: [...result.fontLists],
    lines: result.lines.map((line) => [
      line.start,
      line.end,
      line.top,
      line.height,
      line.baseline,
      line.left,
      line.width,
    ]),
    clusters: result.clusters.map((cluster) => [
      cluster.start,
      cluster.end,
      cluster.line,
      cluster.run,
      cluster.x,
      cluster.y,
      cluster.advance,
    ]),
  };
}

export function expandLayout(compact: CompactLayout): TextLayoutResult {
  return {
    generation: compact.generation,
    lang: compact.lang,
    width: compact.width,
    height: compact.height,
    fontLists: [...compact.fontLists],
    lines: compact.lines.map(
      ([start, end, top, height, baseline, left, width]): TextLayoutLine => ({
        start,
        end,
        top,
        height,
        baseline,
        left,
        width,
      }),
    ),
    clusters: compact.clusters.map(([start, end, line, run, x, y, advance]): TextLayoutCluster => ({
      start,
      end,
      line,
      run,
      x,
      y,
      advance,
    })),
  };
}

export function readM9LayoutTable(file = M9_LAYOUT_TABLE): M9LayoutTable {
  return JSON.parse(readFileSync(file, 'utf8')) as M9LayoutTable;
}

/** A layouter answering from the table; a request it does not hold throws. */
export function m9ReplayLayout(table: M9LayoutTable): (node: TextNodeV7) => TextLayoutResult {
  const cache = new Map<string, TextLayoutResult>();
  return (node) => {
    const key = requestKey(layoutRequest(node));
    let result = cache.get(key);
    if (result === undefined) {
      const compact = table.layouts[key];
      if (compact === undefined) throw new Error(`no recorded layout for ${key}`);
      result = expandLayout(compact);
      cache.set(key, result);
    }
    return result;
  };
}

/**
 * How a browser's layouts differ from the committed table (M9-U1: reported by the headed
 * `m9-v2-layouts` check, not failed, since the exact numbers move between browser versions; the
 * camera claims are what it asserts). `generation` is ignored. A layout "breaks differently" when
 * its lines' `[start, end]` offsets differ.
 */
export function m9LayoutDiff(live: M9LayoutTable, committed: M9LayoutTable) {
  const keys = [...new Set([...Object.keys(live.layouts), ...Object.keys(committed.layouts)])];
  const missing: string[] = [];
  const differing: string[] = [];
  const lineBreaks: {
    key: string;
    committed: readonly (readonly [number, number])[];
    live: readonly (readonly [number, number])[];
  }[] = [];
  let numericDiffs = 0;
  let maxNumericDelta = 0;
  const histogram = { upTo0001: 0, upTo001: 0, upTo01: 0, upTo1: 0, over1: 0 };
  const compare = (a: unknown, b: unknown): boolean => {
    if (typeof a === 'number' && typeof b === 'number') {
      if (a === b) return true;
      const delta = Math.abs(a - b);
      numericDiffs += 1;
      maxNumericDelta = Math.max(maxNumericDelta, delta);
      if (delta <= 0.001) histogram.upTo0001 += 1;
      else if (delta <= 0.01) histogram.upTo001 += 1;
      else if (delta <= 0.1) histogram.upTo01 += 1;
      else if (delta <= 1) histogram.upTo1 += 1;
      else histogram.over1 += 1;
      return false;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      let same = a.length === b.length;
      for (let i = 0; i < Math.min(a.length, b.length); i += 1) same = compare(a[i], b[i]) && same;
      return same;
    }
    return JSON.stringify(a) === JSON.stringify(b);
  };
  for (const key of keys.sort()) {
    const a = live.layouts[key];
    const b = committed.layouts[key];
    if (a === undefined || b === undefined) {
      missing.push(key);
      continue;
    }
    const ends = (layout: CompactLayout) =>
      layout.lines.map(([start, end]) => [start, end] as const);
    const breaks = JSON.stringify(ends(a)) !== JSON.stringify(ends(b));
    if (breaks) lineBreaks.push({ key, committed: ends(b), live: ends(a) });
    let same = !breaks;
    for (const field of ['lang', 'width', 'height', 'fontLists', 'lines', 'clusters'] as const) {
      same = compare(a[field], b[field]) && same;
    }
    if (!same) differing.push(key);
  }
  return {
    layouts: keys.length,
    missing,
    differing: differing.length,
    numericDiffs,
    maxNumericDelta,
    histogram,
    lineBreaks,
    differingKeys: differing,
  };
}
