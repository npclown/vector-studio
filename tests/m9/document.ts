// MVP M9-U1 (M9 contract, section 3.1, M9-A01): the v2 document of the M9 workloads, a
// deterministic 10,000-node editor document with symbols, instances and text, generated from
// indices and one seed (`M9_V2_SEED`), so no committed document fixture is needed.
//
// It starts from the M1-A13 document (`tests/m1-a13/document.ts`, migrated to the current schema
// version by `parseDocument`, as the bench loads it) and changes it as follows:
//
//   - Sources. Ten `symbol` sources of 10 nodes each (the symbol and 9 descendants: a
//     rectangle, an ellipse, a path, a line, a group of three leaves and a last leaf) go to page
//     2. In source 0 the last leaf is a text node. Their 100 nodes replace 100 page-2 nodes: the
//     44 highest-index loose leaves and the 4 highest-index clusters (44 + 4 x 14 = 100), so the
//     document stays at 10,000 nodes (50 loose leaves and then whole clusters cannot make exactly
//     100; see M9_V2_REPLACED).
//   - Instances. In page-1 clusters 2, 4, ..., 224 (112 instances), a leaf of group G becomes an
//     instance of source `i mod 10`: G's rectangle (40 x 30, the source size) when the cluster
//     index is 2 mod 4, G's ellipse (30 x 30, a non-uniform scale) otherwise, so half keep the
//     source size and half are scaled. Instances of source 0 alternate between no text override
//     and one. Each projects 9 expanded copies of the source's descendants (1,008 in all).
//   - Text. In page-1 clusters 1, 3, ..., 399 (200 text nodes), G's rectangle becomes a text node
//     at the rectangle's frame, with one to three runs that meet only at word starts (never
//     inside a word, see `wordStart`), alternately `autoHeight` (fixed width) and
//     `autoWidth`, in the committed test font family (M6a-Q13) and only its subset's code points
//     (ASCII and the listed Hangul syllables). Every fourth (j = 1 mod 4, 50 nodes) names
//     `M9_SECOND_FAMILY` instead; the bench lists the test family after it, as text-dom's
//     `fallbackFamilies`, so it falls back to the committed font until the font-load change.
//     Text j = 0, in cluster 1 (the typical view's top row), is the typing target: ASCII only,
//     exactly 60 clusters.
//   - Rebalance. Whole page-1 clusters move to page 2, highest index first and never cluster 0
//     (the move selection's cluster), until page 1 projects at most 11,000 scene nodes; no
//     moved cluster holds an instance or a text node.
//
// The move selection keeps the M1-A13 definition (`m1A13MoveSelection`): cluster 0 is unchanged.
import { createHash } from 'node:crypto';
import type { TextLayoutResult } from '@vector-studio/contracts';
import { parseDocument, type DocumentV8, type TextNodeV8 } from '@vector-studio/model';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { generateM1A13Document, m1A13MoveSelection } from '../m1-a13/document.js';

type Frame = { x: number; y: number; width: number; height: number };
type Color = { r: number; g: number; b: number; a: number };
type Node = Record<string, unknown> & {
  id: string;
  parent: string;
  frame: Frame;
  rotation: number;
  type: string;
};

export type M9GeneratedDocument = {
  schemaVersion: 8;
  id: string;
  pages: { id: string; name: string; children: string[] }[];
  nodes: Record<string, Node>;
};

export const M9_V2_SEED = 0x6d39;
export const M9_V2_NODE_COUNT = 10_000;
export const M9_V2_PAGE = 'page-1';
/** The page-1 projected scene node range (section 3.1). */
export const M9_V2_PROJECTED = Object.freeze({ min: 10_000, max: 11_000 });
export const M9_V2_SOURCES = 10;
export const M9_V2_SOURCE_NODES = 10;
export const M9_V2_INSTANCES = 112;
export const M9_V2_TEXT_NODES = 200;
export const M9_V2_SECOND_FAMILY_NODES = 50;
export const M9_V2_TARGET_CLUSTERS = 60;
/** The page-2 nodes the sources replace: highest-index loose leaves, then whole clusters. */
export const M9_V2_REPLACED = Object.freeze({ looseLeaves: 44, clusters: 4 });
/** The committed test font's family (apps/next-host/src/m6a-text-host.ts, TEST_FONT_FAMILY). */
export const M9_TEST_FAMILY = 'Noto Sans KR';
/**
 * The second family: installed nowhere, so before the font-load change it falls back to the
 * test family the bench lists after it; the font-load change registers the test font under it.
 */
export const M9_SECOND_FAMILY = 'M9 Font Load';

/**
 * The code points of the committed subset that text may use: ASCII U+0020 to U+007E and the
 * Hangul syllables `pyftsubset` kept (tests/fixtures/m6-text/fonts/README.md).
 */
export const M9_SUBSET_HANGUL: readonly number[] = Object.freeze([
  0xac00, 0xac01, 0xad6d, 0xae00, 0xae30, 0xb098, 0xb155, 0xb2c8, 0xb2e4, 0xb3d9, 0xb77c, 0xb9c8,
  0xbc14, 0xbca1, 0xc0ac, 0xc138, 0xc2b5, 0xc544, 0xc548, 0xc694, 0xc790, 0xc9d1, 0xcc28, 0xcc44,
  0xcc9c, 0xcd94, 0xce74, 0xd0c0, 0xd0dd, 0xd130, 0xd30c, 0xd3b8, 0xd558, 0xd55c, 0xd588,
]);

/** Whether every code point of `text` is in the subset text may use. */
export function inSubset(text: string): boolean {
  const hangul = new Set(M9_SUBSET_HANGUL);
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (!((code >= 0x20 && code <= 0x7e) || hangul.has(code))) return false;
  }
  return true;
}

const ASCII_WORDS = [
  'vector',
  'studio',
  'path',
  'node',
  'frame',
  'group',
  'layer',
  'stroke',
  'fill',
  'text',
  'page',
  'scene',
  'mask',
  'clip',
  'symbol',
  'glyph',
  'font',
  'edit',
  'canvas',
  'pixel',
  'shape',
  'line',
  'curve',
  'point',
  'Draft',
  'Final',
  '2026',
  '#42',
  'v2.1',
] as const;
// Words of the subset's syllables only.
const HANGUL_WORDS = [
  '안녕하세요',
  '한국',
  '글자',
  '벡터',
  '편집',
  '습니다',
  '타자',
  '사자',
  '나라',
  '마차',
  '하나',
  '기차',
  '바다',
  '동사',
  '자세',
  '추가',
  '아기',
  '가각',
  '채택',
  '파카',
] as const;

/** mulberry32, as M1-A13's: a small deterministic PRNG in [0, 1). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** JSON with object keys sorted at every level (as tests/e26/scenarios.ts `canonicalJson`). */
function canonical(value: unknown): string {
  if (value === undefined) throw new TypeError('canonical: undefined');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${value}`);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The SHA-256 (lowercase hex) of the canonical JSON of a generated document, the digest the
 * configuration records; equal to `sha256(canonicalJson(document))` of tests/e26/scenarios.ts.
 */
export function m9DocumentSha256(document: unknown): string {
  return createHash('sha256').update(canonical(document)).digest('hex');
}

/** A layout with no clusters: enough to count projected scene nodes, never to draw. */
function countingLayout(node: TextNodeV8): TextLayoutResult {
  return {
    generation: 0,
    lang: 'ko',
    width: 0,
    height: 0,
    fontLists: node.runs.map(() => 'sans-serif'),
    lines: [],
    clusters: [],
  };
}

/** The page projection with every text node laid out (by `layout`, or counting only). */
export function projectM9Page(
  document: DocumentV8,
  pageId: string,
  layout: (node: TextNodeV8) => TextLayoutResult = countingLayout,
) {
  return projectPage(
    document,
    pageId,
    () => null,
    undefined,
    undefined,
    undefined,
    undefined,
    layout,
  );
}

/**
 * The word start (an offset just after a space) nearest `at` and after `after`, ties to the
 * earlier one. M9-U1 pre-run fix: a run boundary inside a word let browser versions differ on
 * line breaks. The block lays out with `word-break: keep-all` (text-dom), and Chrome 156 broke a
 * Hangul word at a run boundary where the Chromium 153 recording broke at the space before it, so
 * runs now meet only at word starts.
 */
function wordStart(text: string, at: number, after: number): number {
  for (let distance = 0; distance < text.length; distance += 1) {
    for (const offset of [at - distance, at + distance]) {
      if (offset > after && offset < text.length && text[offset - 1] === ' ') return offset;
    }
  }
  throw new Error(`no word start in ${JSON.stringify(text)}`);
}

/** The cluster frames of M1-A13's page 1, by index (650 of them). */
const M1_A13_CLUSTERS = 650;

/** The v2 document (section 3.1). */
export function generateM9V2Document(seed = M9_V2_SEED): M9GeneratedDocument {
  const base = generateM1A13Document();
  const parsed = parseDocument(JSON.stringify(base));
  if (!parsed.ok) throw new Error(`M1-A13 parse: ${parsed.code} ${parsed.path}`);
  // A plain, writable copy at the current schema version.
  const document = JSON.parse(JSON.stringify(parsed.document)) as M9GeneratedDocument;
  if ((document.schemaVersion as number) !== 8) throw new Error('not schema version 8');
  document.id = 'm9-v2';
  const nodes = document.nodes;
  const [page1, page2] = document.pages as [
    M9GeneratedDocument['pages'][number],
    M9GeneratedDocument['pages'][number],
  ];
  const next = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const color = (): Color => ({
    r: Math.round(next() * 255) / 255,
    g: Math.round(next() * 255) / 255,
    b: Math.round(next() * 255) / 255,
    a: 1,
  });
  const clusters = page1.children.slice(0, M1_A13_CLUSTERS);
  const groupOf = (cluster: number) => nodes[clusters[cluster]!]!.children as string[];
  /** G's children of cluster `index`: rectangle a, ellipse, path, group G2. */
  const leavesOf = (index: number) => nodes[groupOf(index)[1]!]!.children as string[];

  // --- Page 2: the replaced nodes.
  const remove = (id: string) => {
    const node = nodes[id]!;
    if (Array.isArray(node.children)) for (const child of node.children as string[]) remove(child);
    delete nodes[id];
  };
  const page2Clusters = page2.children.filter((id) => nodes[id]!.type === 'frame');
  const page2Loose = page2.children.filter((id) => nodes[id]!.type !== 'frame');
  const replaced = new Set([
    ...page2Loose.slice(-M9_V2_REPLACED.looseLeaves),
    ...page2Clusters.slice(-M9_V2_REPLACED.clusters),
  ]);
  for (const id of replaced) remove(id);
  page2.children = page2.children.filter((id) => !replaced.has(id));

  // --- Sources.
  const constraints = { horizontal: 'start', vertical: 'start' };
  const node = (id: string, parent: string, frame: Frame, rest: Record<string, unknown>): Node => {
    const value = {
      id,
      name: id,
      parent,
      frame,
      rotation: 0,
      constraints,
      opacity: 1,
      visible: true,
      ...rest,
      // Schema v7 (E41-S1): no effects.
      effects: [],
    } as unknown as Node;
    nodes[id] = value;
    return value;
  };
  const stroke = (width: number) => ({
    color: color(),
    width,
    cap: 'butt',
    join: 'miter',
    miterLimit: 4,
    dash: null,
  });
  const triangle = { verbs: ['move', 'line', 'line', 'close'], points: [0.5, 0, 1, 1, 0, 1] };
  const SOURCE_SIZE = { width: 40, height: 30 };
  const sourceText = 'm9-s0-text';
  const sources: string[] = [];
  for (let k = 0; k < M9_V2_SOURCES; k += 1) {
    const s = `m9-s${k}`;
    const g = `${s}-g`;
    const children = [
      node(
        `${s}-r`,
        s,
        { x: 0, y: 0, width: 40, height: 6 },
        {
          type: 'rectangle',
          cornerRadii: [0, 1, 1, 0],
          fill: color(),
          stroke: k % 2 === 0 ? stroke(1) : null,
        },
      ).id,
      node(
        `${s}-e`,
        s,
        { x: 0, y: 8, width: 10, height: 10 },
        {
          type: 'ellipse',
          fill: color(),
          stroke: null,
        },
      ).id,
      node(
        `${s}-p`,
        s,
        { x: 12, y: 8, width: 10, height: 10 },
        {
          type: 'path',
          path: { ...triangle, fillRule: 'nonzero' },
          fill: color(),
          stroke: k % 3 === 0 ? stroke(1) : null,
        },
      ).id,
      node(
        `${s}-l`,
        s,
        { x: 24, y: 8, width: 14, height: 4 },
        {
          type: 'line',
          points: [0, 0, 1, 1],
          stroke: stroke(1),
          startArrow: 'none',
          endArrow: k % 2 === 0 ? 'triangle' : 'none',
        },
      ).id,
      node(
        g,
        s,
        { x: 0, y: 19, width: 11, height: 11 },
        {
          type: 'group',
          children: [
            node(
              `${g}-r`,
              g,
              { x: 0, y: 0, width: 5, height: 5 },
              {
                type: 'rectangle',
                cornerRadii: [0, 0, 0, 0],
                fill: color(),
                stroke: null,
              },
            ).id,
            node(
              `${g}-e`,
              g,
              { x: 6, y: 0, width: 5, height: 5 },
              {
                type: 'ellipse',
                fill: color(),
                stroke: null,
              },
            ).id,
            node(
              `${g}-p`,
              g,
              { x: 0, y: 6, width: 5, height: 5 },
              {
                type: 'path',
                path: { ...triangle, fillRule: 'evenodd' },
                fill: color(),
                stroke: null,
              },
            ).id,
          ],
        },
      ).id,
      k === 0
        ? node(
            sourceText,
            s,
            { x: 14, y: 20, width: 26, height: 8 },
            {
              type: 'text',
              runs: [
                { text: 'Symbol 한국 label', family: M9_TEST_FAMILY, size: 4, color: color() },
              ],
              sizing: 'autoWidth',
              align: 'left',
              letterSpacing: 0,
              lineHeight: 1.2,
            },
          ).id
        : node(
            `${s}-x`,
            s,
            { x: 28, y: 18, width: 12, height: 12 },
            {
              type: 'rectangle',
              cornerRadii: [2, 2, 2, 2],
              fill: color(),
              stroke: stroke(1),
            },
          ).id,
    ];
    node(
      s,
      'page-2',
      { x: 60 * k, y: -120, ...SOURCE_SIZE },
      {
        name: `Source ${k}`,
        type: 'symbol',
        children,
        fill: color(),
        stroke: null,
      },
    );
    sources.push(s);
  }
  page2.children.push(...sources);

  // --- Instances: clusters 2, 4, ..., 224.
  const base1 = (id: string) => {
    const { type: _type, ...rest } = nodes[id]!;
    void _type;
    // Keep the leaf's identity, place, opacity and visibility; drop its kind's fields.
    return {
      id: rest.id,
      name: rest.name,
      parent: rest.parent,
      frame: rest.frame,
      rotation: rest.rotation,
      constraints: rest.constraints,
      opacity: rest.opacity,
      visible: rest.visible,
      effects: [],
    };
  };
  const instances: string[] = [];
  for (let i = 0; i < M9_V2_INSTANCES; i += 1) {
    const cluster = 2 * (i + 1);
    const [rect, ellipse] = leavesOf(cluster);
    const id = cluster % 4 === 2 ? rect! : ellipse!;
    const k = i % M9_V2_SOURCES;
    const overridden = k === 0 && Math.floor(i / M9_V2_SOURCES) % 2 === 1;
    nodes[id] = {
      ...base1(id),
      type: 'instance',
      symbol: sources[k]!,
      textOverrides: overridden
        ? {
            [sourceText]: {
              runs: [
                { text: `Override ${i} 편집`, family: M9_TEST_FAMILY, size: 4, color: color() },
              ],
            },
          }
        : {},
    };
    instances.push(id);
  }

  // --- Text: clusters 1, 3, ..., 399.
  const words = (count: number, hangul: boolean): string => {
    let text = '';
    while (text.length < count) {
      const word = hangul && next() < 0.4 ? pick(HANGUL_WORDS) : pick(ASCII_WORDS);
      text = text.length === 0 ? word : `${text} ${word}`;
    }
    return text.slice(0, count).trimEnd();
  };
  const ascii60 = (): string => {
    let text = words(M9_V2_TARGET_CLUSTERS, false);
    while (text.length < M9_V2_TARGET_CLUSTERS) text += 'x';
    return text;
  };
  const texts: string[] = [];
  for (let j = 0; j < M9_V2_TEXT_NODES; j += 1) {
    const cluster = 2 * j + 1;
    const id = leavesOf(cluster)[0]!;
    const target = j === 0;
    const family = j % 4 === 1 ? M9_SECOND_FAMILY : M9_TEST_FAMILY;
    const text = target ? ascii60() : words(30 + Math.floor(next() * 11), j % 3 !== 0);
    const count = target ? 1 : 1 + (j % 3);
    // Split at roughly equal offsets, each moved to the nearest word start; adjacent runs differ
    // in size and colour (canonical runs).
    const size = 4 + (j % 3);
    const cuts = [0];
    for (let r = 1; r < count; r += 1) {
      cuts.push(wordStart(text, Math.floor((r * text.length) / count), cuts[r - 1]!));
    }
    cuts.push(text.length);
    const runs = [];
    for (let r = 0; r < count; r += 1) {
      const run = text.slice(cuts[r], cuts[r + 1]);
      if (run.length === 0) throw new Error(`text ${j}: empty run ${r}`);
      runs.push({ text: run, family, size: size + r * 0.5, color: color() });
    }
    nodes[id] = {
      ...base1(id),
      ...(target ? { opacity: 1, visible: true } : {}),
      type: 'text',
      runs,
      sizing: j % 2 === 0 ? 'autoHeight' : 'autoWidth',
      align: (['left', 'center', 'right'] as const)[Math.floor(j / 2) % 3],
      letterSpacing: 0,
      lineHeight: 1.2,
    };
    texts.push(id);
  }

  // --- Rebalance: whole clusters to page 2, highest index first, never cluster 0.
  const moveCluster = m1A13ClusterOf(document);
  const changed = new Set([...instances, ...texts]);
  let projected = projectedCounts(document);
  let moved = 0;
  for (let index = M1_A13_CLUSTERS - 1; projected.total > M9_V2_PROJECTED.max; index -= 1) {
    if (index <= 0 || index === moveCluster) throw new Error('rebalance ran out of clusters');
    const id = clusters[index]!;
    const subtree: string[] = [];
    const walk = (at: string) => {
      subtree.push(at);
      const children = nodes[at]!.children;
      if (Array.isArray(children)) for (const child of children as string[]) walk(child);
    };
    walk(id);
    if (subtree.some((entry) => changed.has(entry))) {
      throw new Error(`cluster ${index} holds an instance or text`);
    }
    page1.children = page1.children.filter((entry) => entry !== id);
    page2.children.push(id);
    nodes[id]!.parent = 'page-2';
    projected = { ...projected, total: projected.total - projected.byRoot.get(id)! };
    moved += 1;
  }
  const result = document;
  const count = Object.keys(nodes).length;
  if (count !== M9_V2_NODE_COUNT) throw new Error(`generated ${count} nodes, not 10,000`);
  const total = projectedCounts(result).total;
  if (total < M9_V2_PROJECTED.min || total > M9_V2_PROJECTED.max) {
    throw new Error(`page 1 projects ${total} scene nodes`);
  }
  if (moved !== M1_A13_CLUSTERS - pageClusters(result)) throw new Error('moved count');
  return result;
}

/** The M1-A13 clusters still on page 1: its root frames less the frame chain. */
function pageClusters(document: M9GeneratedDocument): number {
  const roots = document.pages[0]!.children.filter((id) => document.nodes[id]!.type === 'frame');
  return roots.length - 1;
}

/** The M1-A13 cluster index of the move selection (cluster 0). */
function m1A13ClusterOf(document: M9GeneratedDocument): number {
  const { group } = m1A13MoveSelection(document as never);
  const frame = document.nodes[group]!.parent;
  return document.pages[0]!.children.indexOf(frame);
}

/** Page-1 projected scene nodes, in all and by page-1 root. */
function projectedCounts(document: M9GeneratedDocument) {
  const parsed = parseDocument(JSON.stringify(document));
  if (!parsed.ok) throw new Error(`parse: ${parsed.code} ${parsed.path}`);
  const projection = projectM9Page(parsed.document, M9_V2_PAGE);
  const rootOf = new Map<string, string>();
  const root = (id: string): string => {
    const known = rootOf.get(id);
    if (known !== undefined) return known;
    const parent = parsed.document.nodes[id]!.parent;
    const value = parent === M9_V2_PAGE ? id : root(parent);
    rootOf.set(id, value);
    return value;
  };
  const byRoot = new Map<string, number>();
  for (const id of projection.nodes.keys()) {
    const index = id.indexOf('\u0000');
    const owner = root(index < 0 ? id : id.slice(0, index));
    byRoot.set(owner, (byRoot.get(owner) ?? 0) + 1);
  }
  return { total: projection.nodes.size, byRoot };
}

/** The typing target (section 3.1): the 60-cluster ASCII text node in cluster 1. */
export function m9TypingTarget(document: M9GeneratedDocument): string {
  const cluster = document.nodes[document.pages[0]!.children[1]!]!;
  const group = (cluster.children as string[])[1]!;
  return (document.nodes[group]!.children as string[])[0]!;
}

export type M9V2Counts = Readonly<{
  documentNodes: number;
  page1Nodes: number;
  page2Nodes: number;
  page1Projected: number;
  /** Expanded copies of source descendants among page 1's scene nodes. */
  fromExpansion: number;
  /** Every scene node of page 1's instances, their own frame nodes included. */
  instanceSceneNodes: number;
  instances: number;
  scaledInstances: number;
  overriddenInstances: number;
  /** Text nodes on page 1 (the source's text node, on page 2, is counted apart). */
  textNodes: number;
  /** Grapheme clusters of page 1's text nodes. */
  textClusters: number;
  secondFamilyTextNodes: number;
  sourceTextNodes: number;
  clustersMoved: number;
}>;

/** Grapheme clusters of a string (Intl.Segmenter). */
export function graphemeCount(text: string): number {
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length;
}

/** The section 3.1 counts of a generated document. */
export function m9V2Counts(document: M9GeneratedDocument): M9V2Counts {
  const parsed = parseDocument(JSON.stringify(document));
  if (!parsed.ok) throw new Error(`parse: ${parsed.code} ${parsed.path}`);
  const doc = parsed.document;
  const projection = projectM9Page(doc, M9_V2_PAGE);
  const onPage = (pageId: string) => {
    let count = 0;
    const visit = (id: string) => {
      count += 1;
      const value = doc.nodes[id]!;
      if ('children' in value) for (const child of value.children) visit(child);
    };
    for (const id of doc.pages.find((page) => page.id === pageId)!.children) visit(id);
    return count;
  };
  const all = Object.values(doc.nodes);
  const instances = all.filter((value) => value.type === 'instance');
  const sourceIds = new Set<string>();
  for (const value of all) {
    if (value.type !== 'symbol') continue;
    const visit = (id: string) => {
      sourceIds.add(id);
      const child = doc.nodes[id]!;
      if ('children' in child) for (const entry of child.children) visit(entry);
    };
    visit(value.id);
  }
  const texts = all.filter(
    (value): value is TextNodeV8 => value.type === 'text' && !sourceIds.has(value.id),
  );
  const ids = [...projection.nodes.keys()];
  return {
    documentNodes: all.length,
    page1Nodes: onPage('page-1'),
    page2Nodes: onPage('page-2'),
    page1Projected: projection.nodes.size,
    fromExpansion: ids.filter((id) => id.includes('\u0000@')).length,
    instanceSceneNodes: ids.filter((id) => {
      const index = id.indexOf('\u0000');
      return doc.nodes[index < 0 ? id : id.slice(0, index)]?.type === 'instance';
    }).length,
    instances: instances.length,
    scaledInstances: instances.filter((value) => value.frame.width !== 40).length,
    overriddenInstances: instances.filter(
      (value) => value.type === 'instance' && Object.keys(value.textOverrides).length > 0,
    ).length,
    textNodes: texts.length,
    textClusters: texts.reduce(
      (sum, value) => sum + graphemeCount(value.runs.map((run) => run.text).join('')),
      0,
    ),
    secondFamilyTextNodes: texts.filter((value) => value.runs[0]!.family === M9_SECOND_FAMILY)
      .length,
    sourceTextNodes: all.filter((value) => value.type === 'text' && sourceIds.has(value.id)).length,
    clustersMoved: M1_A13_CLUSTERS - pageClusters(document),
  };
}
