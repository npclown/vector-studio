// M6-S0 text spike (docs/plans/mvp-m6-text-plan.md, sections 4.1, 6 and 8): a playground page,
// not product code. It lays text out the way the planned `@vector-studio/text-dom` service would
// (a hidden measurement element in its own shadow root with `all: initial` and `lang`, one span per
// run, grapheme clusters read with `Range.getClientRects`) and exposes `window.__vectorStudioM6S0`
// for the measurement scripts in docs/evidence/m6-s0/. Nothing here is imported by a package.

export type SpikeRun = Readonly<{ text: string; family: string; size: number }>;
export type SpikeNode = Readonly<{
  id: string;
  runs: readonly SpikeRun[];
  /** `fixedWidth` wraps at `width`; `autoWidth` wraps only at LF. */
  sizing: 'autoWidth' | 'fixedWidth';
  width: number;
  letterSpacing: number;
  lineHeight: number;
}>;

/** One grapheme cluster: UTF-16 offsets over the node text, its run and its first client rect. */
export type SpikeCluster = Readonly<{
  s: number;
  e: number;
  run: number;
  line: number;
  lf: boolean;
  /** Relative to the block's top-left corner, CSS px; null when the cluster has no rect. */
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  rects: number;
}>;

export type SpikeLayout = Readonly<{
  id: string;
  width: number;
  height: number;
  lineCount: number;
  /** UTF-16 offset of the first cluster of each line. */
  lineStarts: readonly number[];
  clusters: readonly SpikeCluster[];
}>;

export type Stats = Readonly<{
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  total: number;
}>;

export type ThroughputOptions = Readonly<{
  count: number;
  seed: number;
  families: readonly string[];
  sizes: readonly number[];
  passes: number;
  warmup: number;
  keepLayouts: boolean;
}>;

export type ThroughputPass = Readonly<{
  pass: number;
  nodes: number;
  clusters: number;
  /** Building the spans and text nodes. */
  buildMs: Stats;
  /** `Intl.Segmenter` grapheme segmentation. */
  segmentMs: Stats;
  /** Layout forced by the first read plus every cluster's `getClientRects`. */
  readMs: Stats;
  totalMs: Stats;
  wallMs: number;
}>;

/** The fixed tail of every M6-F2 font list (the host fallback list is empty in the spike). */
const FIXED_FALLBACK_TAIL = ['Malgun Gothic', 'Apple SD Gothic Neo'];
const LANG = 'ko';
const HIGHLIGHT = 'm6s0-probe';

function quote(family: string): string {
  return `"${family.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

/** M6-F2: `"<family>", <host fallback list>, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`. */
export function fontList(family: string): string {
  return [quote(family), ...FIXED_FALLBACK_TAIL.map(quote), 'sans-serif'].join(', ');
}

// --- deterministic fixture generator -------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LATIN_WORDS = [
  'Vector',
  'Studio',
  'AV',
  'Wa',
  'To',
  'Ty',
  'kerning',
  'office',
  'fi',
  'layout',
  'text',
  '42',
  '3.14',
  '(GPU)',
  'naïve',
  'Ångström',
  '—',
];
const HANGUL_WORDS = [
  '한글',
  '편집기',
  '벡터',
  '스튜디오',
  '글꼴',
  '줄바꿈',
  '가나다라',
  '안녕하세요',
  '각',
  '읽기',
  '쓰기',
  '값',
  '했습니다.',
];

function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('empty pick list');
  return item;
}

/** 1,000 nodes of mixed Latin and Hangul, 1 to 3 runs each, some with LF and fixed widths. */
export function generateNodes(
  count: number,
  seed: number,
  families: readonly string[],
  sizes: readonly number[],
): SpikeNode[] {
  const random = mulberry32(seed);
  const nodes: SpikeNode[] = [];
  for (let index = 0; index < count; index += 1) {
    const words: string[] = [];
    const wordCount = 3 + Math.floor(random() * 23);
    for (let w = 0; w < wordCount; w += 1) {
      words.push(pick(random, random() < 0.5 ? LATIN_WORDS : HANGUL_WORDS));
    }
    const runCount = 1 + Math.floor(random() * 3);
    const cuts = new Set<number>();
    while (cuts.size < runCount - 1 && wordCount > runCount) {
      cuts.add(1 + Math.floor(random() * (wordCount - 1)));
    }
    const boundaries = [0, ...[...cuts].sort((a, b) => a - b), wordCount];
    const runs: SpikeRun[] = [];
    for (let r = 0; r + 1 < boundaries.length; r += 1) {
      const from = boundaries[r] ?? 0;
      const to = boundaries[r + 1] ?? wordCount;
      let text = '';
      for (let w = from; w < to; w += 1) {
        const separator = w === 0 ? '' : random() < 0.08 ? '\n' : ' ';
        text += separator + (words[w] ?? '');
      }
      runs.push({ text, family: pick(random, families), size: pick(random, sizes) });
    }
    const fixed = random() < 0.6;
    nodes.push({
      id: `n${index}`,
      runs,
      sizing: fixed ? 'fixedWidth' : 'autoWidth',
      width: fixed ? 80 + Math.floor(random() * 320) : 0,
      letterSpacing: pick(random, [0, 0, 0.02, -0.01]),
      lineHeight: pick(random, [1.2, 1.5]),
    });
  }
  return nodes;
}

// --- the measurement element ---------------------------------------------------------------

const host = document.createElement('div');
host.id = 'm6s0-measure-host';
host.style.cssText =
  'position: absolute; left: 24px; top: 24px; visibility: hidden; pointer-events: none;';
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = `<style>
  :host { all: initial; }
  .block {
    all: initial;
    display: block;
    white-space: pre-wrap;
    font-variant-ligatures: none;
    word-break: keep-all;
    overflow-wrap: anywhere;
    text-align: left;
    color: #000;
  }
  .block.probe { color: transparent; }
  .block.probe .c { color: transparent; }
  .block.probe .c.on { color: #000; }
  .block.probe::highlight(${HIGHLIGHT}) { color: #000; }
  .baseline { display: inline-block; width: 0; height: 0; vertical-align: baseline; }
</style><div class="block" lang="${LANG}"></div>`;
const blockElement = shadow.querySelector<HTMLDivElement>('.block');
if (!blockElement) throw new Error('measurement block missing');
const block: HTMLDivElement = blockElement;
document.body.append(host);

const segmenter = new Intl.Segmenter(LANG, { granularity: 'grapheme' });

type Built = { textNodes: Text[]; runStarts: number[]; text: string };

function build(node: SpikeNode, baselineMarker = false): Built {
  const first = node.runs[0];
  if (!first) throw new Error(`${node.id}: no runs`);
  block.style.fontFamily = fontList(first.family);
  block.style.fontSize = `${first.size}px`;
  block.style.lineHeight = String(node.lineHeight);
  block.style.letterSpacing = `${node.letterSpacing}em`;
  block.style.width = node.sizing === 'fixedWidth' ? `${node.width}px` : 'max-content';
  const fragment = document.createDocumentFragment();
  if (baselineMarker) {
    const marker = document.createElement('span');
    marker.className = 'baseline';
    fragment.append(marker);
  }
  const textNodes: Text[] = [];
  const runStarts: number[] = [];
  let text = '';
  for (const run of node.runs) {
    const span = document.createElement('span');
    span.style.fontFamily = fontList(run.family);
    span.style.fontSize = `${run.size}px`;
    const textNode = document.createTextNode(run.text);
    span.append(textNode);
    fragment.append(span);
    textNodes.push(textNode);
    runStarts.push(text.length);
    text += run.text;
  }
  block.replaceChildren(fragment);
  return { textNodes, runStarts, text };
}

type Segment = { s: number; e: number; run: number };

function segment(built: Built): Segment[] {
  const segments: Segment[] = [];
  built.textNodes.forEach((textNode, run) => {
    const start = built.runStarts[run] ?? 0;
    for (const part of segmenter.segment(textNode.data)) {
      segments.push({ s: start + part.index, e: start + part.index + part.segment.length, run });
    }
  });
  return segments;
}

function read(node: SpikeNode, built: Built, segments: readonly Segment[]): SpikeLayout {
  const origin = block.getBoundingClientRect();
  const range = document.createRange();
  const clusters: SpikeCluster[] = [];
  const lineStarts: number[] = [];
  let line = -1;
  let previousLeft = Number.POSITIVE_INFINITY;
  let lineBottom = Number.POSITIVE_INFINITY;
  let forceBreak = true;
  for (const { s, e, run } of segments) {
    const textNode = built.textNodes[run];
    const runStart = built.runStarts[run] ?? 0;
    if (!textNode) throw new Error('missing text node');
    range.setStart(textNode, s - runStart);
    range.setEnd(textNode, e - runStart);
    const rects = range.getClientRects();
    const rect = rects[0];
    const lf = built.text.slice(s, e) === '\n';
    const left = rect ? rect.left - origin.left : null;
    const top = rect ? rect.top - origin.top : null;
    // A new line after an LF, when the pen moves backwards (left-aligned LTR text), or when the
    // rect starts at or below the current line's bottom.
    if (
      forceBreak ||
      (left !== null && left < previousLeft - 0.01) ||
      (top !== null && top >= lineBottom - 0.01)
    ) {
      line += 1;
      lineStarts.push(s);
      forceBreak = false;
      lineBottom = Number.NEGATIVE_INFINITY;
    }
    if (rect && top !== null && !lf) lineBottom = Math.max(lineBottom, top + rect.height);
    clusters.push({
      s,
      e,
      run,
      line,
      lf,
      x: left,
      y: top,
      w: rect ? rect.width : null,
      h: rect ? rect.height : null,
      rects: rects.length,
    });
    if (left !== null && !lf) previousLeft = left;
    if (lf) {
      forceBreak = true;
      previousLeft = Number.POSITIVE_INFINITY;
      lineBottom = Number.POSITIVE_INFINITY;
    }
  }
  if (forceBreak && lineStarts.length === 0) lineStarts.push(0);
  return {
    id: node.id,
    width: origin.width,
    height: origin.height,
    lineCount: Math.max(line + 1, 1),
    lineStarts,
    clusters,
  };
}

export function layoutNode(node: SpikeNode): SpikeLayout {
  const built = build(node);
  return read(node, built, segment(built));
}

function stats(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    n: values.length,
    mean: values.length ? total / values.length : 0,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1] ?? 0,
    total,
  };
}

export function throughput(options: ThroughputOptions): {
  options: ThroughputOptions;
  passes: ThroughputPass[];
  layouts: SpikeLayout[] | null;
} {
  const nodes = generateNodes(options.count, options.seed, options.families, options.sizes);
  for (let index = 0; index < options.warmup; index += 1) {
    const node = nodes[index % nodes.length];
    if (node) layoutNode(node);
  }
  const passes: ThroughputPass[] = [];
  let layouts: SpikeLayout[] | null = null;
  for (let pass = 0; pass < options.passes; pass += 1) {
    const build_: number[] = [];
    const segment_: number[] = [];
    const read_: number[] = [];
    const total: number[] = [];
    const kept: SpikeLayout[] = [];
    let clusters = 0;
    const wallStart = performance.now();
    for (const node of nodes) {
      const t0 = performance.now();
      const built = build(node);
      const t1 = performance.now();
      const segments = segment(built);
      const t2 = performance.now();
      const layout = read(node, built, segments);
      const t3 = performance.now();
      build_.push(t1 - t0);
      segment_.push(t2 - t1);
      read_.push(t3 - t2);
      total.push(t3 - t0);
      clusters += layout.clusters.length;
      if (options.keepLayouts && pass === 0) kept.push(layout);
    }
    const wallMs = performance.now() - wallStart;
    if (options.keepLayouts && pass === 0) layouts = kept;
    passes.push({
      pass,
      nodes: nodes.length,
      clusters,
      buildMs: stats(build_),
      segmentMs: stats(segment_),
      readMs: stats(read_),
      totalMs: stats(total),
      wallMs,
    });
  }
  return { options, passes, layouts };
}

// --- environment ---------------------------------------------------------------------------

/**
 * A user "minimum font size" setting clamps small DOM text (plan section 11). The width of a 9 px
 * run should be half that of the same run at 18 px; a ratio above 1 shows a clamp.
 */
function minimumFontSizeProbe(): Record<string, number | boolean> {
  const width = (size: number) => {
    build({
      id: 'min-font-size',
      runs: [{ text: 'Vector 한글 Studio', family: 'sans-serif', size }],
      sizing: 'autoWidth',
      width: 0,
      letterSpacing: 0,
      lineHeight: 1.2,
    });
    return block.getBoundingClientRect().width;
  };
  const w9 = width(9);
  const w18 = width(18);
  const ratio = w9 / (w18 / 2);
  block.replaceChildren();
  return { width9: w9, width18: w18, ratio9To18Half: ratio, clampSuspected: ratio > 1.02 };
}

type UaData = { getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> };

async function environment(): Promise<Record<string, unknown>> {
  const uaData = (navigator as Navigator & { userAgentData?: UaData }).userAgentData;
  const highEntropy = uaData
    ? await uaData
        .getHighEntropyValues([
          'platform',
          'platformVersion',
          'architecture',
          'fullVersionList',
          'bitness',
        ])
        .catch((error: unknown) => ({ error: String(error) }))
    : null;
  const context = new OffscreenCanvas(1, 1).getContext('2d');
  const faces: Record<string, unknown>[] = [];
  document.fonts.forEach((face) => {
    faces.push({ family: face.family, status: face.status, weight: face.weight });
  });
  return {
    userAgent: navigator.userAgent,
    userAgentData: highEntropy,
    devicePixelRatio: window.devicePixelRatio,
    languages: navigator.languages,
    documentFonts: { size: document.fonts.size, status: document.fonts.status, faces },
    canvasLangSupported: context !== null && 'lang' in context,
    canvasLetterSpacingSupported: context !== null && 'letterSpacing' in context,
    customHighlightSupported: typeof CSS !== 'undefined' && 'highlights' in CSS,
    measurementLang: LANG,
    fixedFallbackTail: FIXED_FALLBACK_TAIL,
    minimumFontSize: minimumFontSizeProbe(),
    sampleFontList: fontList('<family>'),
  };
}

// --- fallback hypothesis (M6-F2) -----------------------------------------------------------

type CanvasMeasure = { cluster: number[]; total: number; actualLeft: number; actualRight: number };

function measureOn(
  context: OffscreenCanvasRenderingContext2D,
  font: string,
  lang: string | null,
  text: string,
  clusters: readonly string[],
): CanvasMeasure {
  context.font = font;
  if (lang !== null) (context as unknown as { lang: string }).lang = lang;
  context.letterSpacing = '0px';
  context.fontKerning = 'normal';
  const metrics = context.measureText(text);
  return {
    cluster: clusters.map((cluster) => context.measureText(cluster).width),
    total: metrics.width,
    actualLeft: metrics.actualBoundingBoxLeft,
    actualRight: metrics.actualBoundingBoxRight,
  };
}

// Runs the same measurements in a dedicated worker, whose canvas sees `self.fonts`, not
// `document.fonts`. The source is inline so the page needs no worker build step.
const WORKER_SOURCE = `
self.onmessage = (event) => {
  const { cases } = event.data;
  const probe = new OffscreenCanvas(1, 1).getContext('2d');
  const faces = [];
  if (self.fonts) self.fonts.forEach((face) => faces.push({ family: face.family, status: face.status }));
  // A fresh context per case, so a lang set for one case never leaks into the no-lang case.
  const results = cases.map(({ font, lang, text, clusters }) => {
    const context = new OffscreenCanvas(1, 1).getContext('2d');
    context.font = font;
    if (lang !== null) context.lang = lang;
    context.letterSpacing = '0px';
    context.fontKerning = 'normal';
    const metrics = context.measureText(text);
    return {
      cluster: clusters.map((cluster) => context.measureText(cluster).width),
      total: metrics.width,
      actualLeft: metrics.actualBoundingBoxLeft,
      actualRight: metrics.actualBoundingBoxRight,
    };
  });
  self.postMessage({
    results,
    selfFonts: self.fonts ? { size: self.fonts.size, status: self.fonts.status, faces } : null,
    canvasLangSupported: probe !== null && 'lang' in probe,
  });
};`;

type WorkerCase = { font: string; lang: string | null; text: string; clusters: string[] };
type WorkerReply = {
  results: CanvasMeasure[];
  selfFonts: Record<string, unknown> | null;
  canvasLangSupported: boolean;
};

function inWorker(cases: WorkerCase[]): Promise<WorkerReply> {
  const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
  const worker = new Worker(url);
  return new Promise<WorkerReply>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      resolve(event.data);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.onerror = (event) => {
      reject(new Error(event.message));
      worker.terminate();
    };
    worker.postMessage({ cases });
  });
}

export type FallbackOptions = Readonly<{
  latinFamily: string;
  texts: readonly string[];
  sizes: readonly number[];
}>;

const DOC_ALIAS = 'M6S0 Document Alias';

async function fallback(options: FallbackOptions): Promise<Record<string, unknown>> {
  // A FontFace registered in document.fonts only, aliasing the Latin family through local():
  // the main thread sees it, a worker does not (it has its own self.fonts).
  const alias = new FontFace(DOC_ALIAS, `local(${quote(options.latinFamily)})`);
  let aliasStatus: string;
  try {
    document.fonts.add(alias);
    await alias.load();
    aliasStatus = alias.status;
  } catch (error) {
    aliasStatus = `error: ${String(error)}`;
  }
  // A fresh context per measurement, as in the worker.
  const fresh = () => {
    const context = new OffscreenCanvas(1, 1).getContext('2d');
    if (!context) throw new Error('no 2d context');
    return context;
  };
  type Case = { family: string; text: string; size: number };
  const cases: Case[] = [];
  for (const size of options.sizes) {
    for (const text of options.texts) cases.push({ family: options.latinFamily, text, size });
    cases.push({ family: DOC_ALIAS, text: 'Vector Studio', size });
  }
  const workerCases: WorkerCase[] = [];
  const rows = cases.map(({ family, text, size }) => {
    const node: SpikeNode = {
      id: 'fallback',
      runs: [{ text, family, size }],
      sizing: 'autoWidth',
      width: 0,
      letterSpacing: 0,
      lineHeight: 1.2,
    };
    const built = build(node);
    const segments = segment(built);
    const layout = read(node, built, segments);
    const range = document.createRange();
    const textNode = built.textNodes[0];
    if (!textNode) throw new Error('missing text node');
    range.selectNodeContents(textNode);
    const domTotal = range.getBoundingClientRect().width;
    const clusterTexts = segments.map(({ s, e }) => text.slice(s, e));
    const font = `${size}px ${fontList(family)}`;
    workerCases.push({ font, lang: LANG, text, clusters: clusterTexts });
    workerCases.push({ font, lang: null, text, clusters: clusterTexts });
    return {
      family,
      text,
      size,
      font,
      clusters: clusterTexts,
      domCluster: layout.clusters.map((cluster) => cluster.w),
      domTotal,
      canvasLang: measureOn(fresh(), font, LANG, text, clusterTexts),
      canvasNoLang: measureOn(fresh(), font, null, text, clusterTexts),
    };
  });
  // The alias with a monospace fallback, so a face the worker cannot see shows as a width change.
  const aliasFont = `24px ${quote(DOC_ALIAS)}, monospace`;
  const aliasText = 'Vector Studio';
  workerCases.push({ font: aliasFont, lang: LANG, text: aliasText, clusters: [] });
  const worker = await inWorker(workerCases);
  const aliasProbe = {
    font: aliasFont,
    text: aliasText,
    mainCanvas: measureOn(fresh(), aliasFont, LANG, aliasText, []).total,
    worker: worker.results[workerCases.length - 1]?.total ?? null,
    monospaceReference: measureOn(fresh(), '24px monospace', LANG, aliasText, []).total,
    documentFontsCheck: document.fonts.check(aliasFont, aliasText),
  };
  const maxAbs = (a: readonly (number | null)[], b: readonly number[]) =>
    a.reduce<number>(
      (max, value, index) => Math.max(max, Math.abs((value ?? 0) - (b[index] ?? 0))),
      0,
    );
  const results = rows.map((row, index) => {
    const workerLang = worker.results[index * 2];
    const workerNoLang = worker.results[index * 2 + 1];
    return {
      ...row,
      workerLang,
      workerNoLang,
      maxClusterDelta: {
        domVsCanvasLang: maxAbs(row.domCluster, row.canvasLang.cluster),
        domVsCanvasNoLang: maxAbs(row.domCluster, row.canvasNoLang.cluster),
        domVsWorkerLang: workerLang ? maxAbs(row.domCluster, workerLang.cluster) : null,
      },
      totalDelta: {
        domVsCanvasLang: row.domTotal - row.canvasLang.total,
        domVsWorkerLang: workerLang ? row.domTotal - workerLang.total : null,
      },
    };
  });
  return {
    latinFamily: options.latinFamily,
    documentAlias: {
      family: DOC_ALIAS,
      source: `local(${quote(options.latinFamily)})`,
      status: aliasStatus,
    },
    documentFontsSize: document.fonts.size,
    aliasProbe,
    worker: { selfFonts: worker.selfFonts, canvasLangSupported: worker.canvasLangSupported },
    results,
  };
}

/** Renders each fallback text into a light-DOM element (the CDP platform-font query needs it). */
function platformFontProbes(options: FallbackOptions): string[] {
  const container = document.createElement('div');
  container.id = 'm6s0-platform-fonts';
  container.style.cssText = 'position: absolute; left: 0; top: 2000px;';
  const ids: string[] = [];
  options.texts.forEach((text, index) => {
    const element = document.createElement('div');
    element.id = `m6s0-pf-${index}`;
    element.lang = LANG;
    element.style.cssText = `font: 16px ${fontList(options.latinFamily)}; white-space: pre; font-variant-ligatures: none;`;
    element.textContent = text;
    container.append(element);
    ids.push(element.id);
  });
  document.getElementById('m6s0-platform-fonts')?.remove();
  document.body.append(container);
  return ids;
}

// --- ink probes (M6-G3) --------------------------------------------------------------------

export type ProbeCluster = Readonly<{
  index: number;
  text: string;
  run: number;
  family: string;
  size: number;
  /** Viewport CSS px. */
  left: number;
  top: number;
  width: number;
  height: number;
}>;

let probeRanges: Range[] = [];
let probeSpans: HTMLSpanElement[] = [];
let probeMode: ProbeMode = 'spans';

/**
 * How one cluster is isolated. `spans`: each cluster is its own span, transparent unless shown
 * (Chrome shapes across same-font element boundaries; `layoutDelta` reports any layout change).
 * `highlight`: a CSS custom highlight paints the cluster with no DOM change, but Chrome clips
 * highlight painting to the range's box, so overhanging ink (kerned pairs) is cut.
 */
export type ProbeMode = 'spans' | 'highlight';

function clusterRect(range: Range): DOMRect | undefined {
  return range.getClientRects()[0];
}

/** Shows a single-line node visibly, with every cluster transparent until shown. */
function probeShow(
  node: SpikeNode,
  mode: ProbeMode = 'spans',
): { baseline: number; clusters: ProbeCluster[]; layoutDelta: number } {
  probeMode = mode;
  const built = build(node, true);
  const segments = segment(built);
  host.style.visibility = 'visible';
  block.classList.add('probe');
  block.dataset.mode = mode;
  CSS.highlights.delete(HIGHLIGHT);
  const marker = block.querySelector('.baseline');
  if (!marker) throw new Error('baseline marker missing');
  const plainRanges = segments.map(({ s, e, run }) => {
    const textNode = built.textNodes[run];
    const runStart = built.runStarts[run] ?? 0;
    if (!textNode) throw new Error('missing run');
    const range = document.createRange();
    range.setStart(textNode, s - runStart);
    range.setEnd(textNode, e - runStart);
    return range;
  });
  const plainRects = plainRanges.map(clusterRect);
  const plainBaseline = marker.getBoundingClientRect().bottom;
  probeSpans = [];
  probeRanges = plainRanges;
  if (mode === 'spans') {
    // Replace each run's text node by one span per cluster.
    built.textNodes.forEach((textNode, run) => {
      const parts = segments
        .filter((part) => part.run === run)
        .map(({ s, e }) => {
          const span = document.createElement('span');
          span.className = 'c';
          span.textContent = built.text.slice(s, e);
          probeSpans.push(span);
          return span;
        });
      textNode.replaceWith(...parts);
    });
    probeRanges = probeSpans.map((span) => {
      const range = document.createRange();
      range.selectNodeContents(span);
      return range;
    });
  }
  const baseline = marker.getBoundingClientRect().bottom;
  let layoutDelta = Math.abs(baseline - plainBaseline);
  const clusters: ProbeCluster[] = [];
  segments.forEach(({ s, e, run }, index) => {
    const spec = node.runs[run];
    const range = probeRanges[index];
    if (!spec || !range) throw new Error('missing run');
    const rect = clusterRect(range);
    const plain = plainRects[index];
    if (rect && plain) {
      layoutDelta = Math.max(
        layoutDelta,
        Math.abs(rect.left - plain.left),
        Math.abs(rect.top - plain.top),
        Math.abs(rect.width - plain.width),
        Math.abs(rect.height - plain.height),
      );
    }
    clusters.push({
      index,
      text: built.text.slice(s, e),
      run,
      family: spec.family,
      size: spec.size,
      left: rect?.left ?? Number.NaN,
      top: rect?.top ?? Number.NaN,
      width: rect?.width ?? Number.NaN,
      height: rect?.height ?? Number.NaN,
    });
  });
  return { baseline, clusters, layoutDelta };
}

/** Shows one cluster (all with -1, none with null, ordinary black text with 'plain'). */
async function probeHighlight(index: number | null | 'plain'): Promise<void> {
  CSS.highlights.delete(HIGHLIGHT);
  block.classList.toggle('probe', index !== 'plain');
  if (probeMode === 'spans') {
    probeSpans.forEach((span, i) => span.classList.toggle('on', index === -1 || index === i));
  } else if (index === -1) {
    CSS.highlights.set(HIGHLIGHT, new Highlight(...probeRanges));
  } else if (typeof index === 'number') {
    const range = probeRanges[index];
    if (!range) throw new Error(`no cluster ${index}`);
    CSS.highlights.set(HIGHLIGHT, new Highlight(range));
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function probeHide(): void {
  CSS.highlights.delete(HIGHLIGHT);
  block.classList.remove('probe');
  host.style.visibility = 'hidden';
}

export type InkBox = Readonly<{
  /** Thresholded coverage bounds in device px within the image, or null when blank. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  inked: number;
} | null>;

/**
 * Subpixel ink measures in device px, independent of the thresholds. Edges are coverage-weighted:
 * the profile of a column (row) is its largest coverage in 0..1, and an edge column with
 * profile c puts the edge at its far side minus c (an anti-aliased edge covering a fraction c of
 * the pixel). The centroid is the first moment of coverage; mass is the summed coverage.
 */
export type SubpixelInk = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  cx: number;
  cy: number;
  mass: number;
} | null>;

/** Coverage at or below this (out of 255) is noise for the subpixel measures. */
const SUBPIXEL_FLOOR = 2;

/** Coverage is 255 minus the minimum channel over a white background (handles LCD AA). */
function coverage(data: ImageData): Float32Array {
  const out = new Float32Array(data.width * data.height);
  for (let index = 0; index < out.length; index += 1) {
    const offset = index * 4;
    out[index] =
      255 -
      Math.min(
        data.data[offset] ?? 255,
        data.data[offset + 1] ?? 255,
        data.data[offset + 2] ?? 255,
      );
  }
  return out;
}

function inkBoxes(data: ImageData, thresholds: readonly number[]): InkBox[] {
  const values = coverage(data);
  const { width, height } = data;
  return thresholds.map((threshold) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let inked = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if ((values[y * width + x] ?? 0) > threshold) {
          inked += 1;
          if (x < x0) x0 = x;
          if (y < y0) y0 = y;
          if (x + 1 > x1) x1 = x + 1;
          if (y + 1 > y1) y1 = y + 1;
        }
      }
    }
    return inked === 0 ? null : { x0, y0, x1, y1, inked };
  });
}

function subpixelInk(data: ImageData): SubpixelInk {
  const values = coverage(data);
  const { width, height } = data;
  const columns = new Float32Array(width);
  const rows = new Float32Array(height);
  let mass = 0;
  let mx = 0;
  let my = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const raw = values[y * width + x] ?? 0;
      if (raw <= SUBPIXEL_FLOOR) continue;
      const c = raw / 255;
      mass += c;
      mx += (x + 0.5) * c;
      my += (y + 0.5) * c;
      if (c > (columns[x] ?? 0)) columns[x] = c;
      if (c > (rows[y] ?? 0)) rows[y] = c;
    }
  }
  if (mass === 0) return null;
  const first = (profile: Float32Array) => profile.findIndex((value) => value > 0);
  const last = (profile: Float32Array) => {
    for (let index = profile.length - 1; index >= 0; index -= 1) {
      if ((profile[index] ?? 0) > 0) return index;
    }
    return -1;
  };
  const fx = first(columns);
  const lx = last(columns);
  const fy = first(rows);
  const ly = last(rows);
  return {
    left: fx + 1 - (columns[fx] ?? 0),
    right: lx + (columns[lx] ?? 0),
    top: fy + 1 - (rows[fy] ?? 0),
    bottom: ly + (rows[ly] ?? 0),
    cx: mx / mass,
    cy: my / mass,
    mass,
  };
}

async function decodePng(base64: string): Promise<ImageData> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0);
  return context.getImageData(0, 0, bitmap.width, bitmap.height);
}

async function domInk(base64: string, thresholds: readonly number[]) {
  const data = await decodePng(base64);
  return {
    width: data.width,
    height: data.height,
    boxes: inkBoxes(data, thresholds),
    subpixel: subpixelInk(data),
  };
}

/** Pixel difference of two screenshots (the highlight painting check). */
async function pngDiff(a: string, b: string) {
  const [left, right] = await Promise.all([decodePng(a), decodePng(b)]);
  if (left.width !== right.width || left.height !== right.height) return { sizeMismatch: true };
  let differing = 0;
  let maxChannel = 0;
  for (let index = 0; index < left.data.length; index += 4) {
    let pixel = 0;
    for (let c = 0; c < 3; c += 1) {
      pixel = Math.max(pixel, Math.abs((left.data[index + c] ?? 0) - (right.data[index + c] ?? 0)));
    }
    if (pixel > 0) differing += 1;
    maxChannel = Math.max(maxChannel, pixel);
  }
  return { sizeMismatch: false, differing, maxChannel, pixels: left.width * left.height };
}

export type CanvasInkRequest = Readonly<{
  /** Clip rectangle, viewport CSS px (integers). */
  clip: Readonly<{ x: number; y: number; width: number; height: number }>;
  text: string;
  family: string;
  size: number;
  x: number;
  baseline: number;
  dpr: number;
  thresholds: readonly number[];
}>;

/** Rasterizes one cluster with canvas `fillText` at the DOM origin, over white, at `dpr`. */
function canvasInk(request: CanvasInkRequest) {
  const { clip, dpr } = request;
  const width = Math.round(clip.width * dpr);
  const height = Math.round(clip.height * dpr);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.setTransform(dpr, 0, 0, dpr, -clip.x * dpr, -clip.y * dpr);
  context.font = `${request.size}px ${fontList(request.family)}`;
  (context as unknown as { lang: string }).lang = LANG;
  context.letterSpacing = '0px';
  context.fontKerning = 'normal';
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#000';
  context.fillText(request.text, request.x, request.baseline);
  const data = context.getImageData(0, 0, width, height);
  return { width, height, boxes: inkBoxes(data, request.thresholds), subpixel: subpixelInk(data) };
}

// --- manual panel --------------------------------------------------------------------------

const api = {
  ready: document.fonts.ready.then(() => true),
  environment,
  fontList,
  generateNodes,
  layoutNode,
  throughput,
  fallback,
  platformFontProbes,
  probeShow,
  probeHighlight,
  probeHide,
  domInk,
  pngDiff,
  canvasInk,
};
export type M6S0Api = typeof api;
(window as unknown as { __vectorStudioM6S0: M6S0Api }).__vectorStudioM6S0 = api;

const panel = document.querySelector<HTMLElement>('#panel');
if (panel) {
  const families = (
    new URLSearchParams(location.search).get('families') ?? 'Arial,Malgun Gothic,Segoe UI'
  )
    .split(',')
    .map((family) => family.trim())
    .filter(Boolean);
  const label = document.createElement('input');
  label.type = 'text';
  label.placeholder = 'Setting label, e.g. monitor-150 or zoom-125';
  label.style.cssText = 'width: 280px; margin-right: 8px';
  const output = document.createElement('pre');
  const runButton = document.createElement('button');
  runButton.textContent = 'Run 1,000-node layout and download JSON';
  runButton.addEventListener('click', () => {
    const settingLabel = label.value.trim();
    if (settingLabel === '') {
      output.textContent = 'Enter a label for this setting (monitor scale, browser zoom) first.';
      return;
    }
    const result = throughput({
      count: 1000,
      seed: 1,
      families,
      sizes: [9, 12, 13, 16, 24, 32],
      passes: 1,
      warmup: 50,
      keepLayouts: true,
    });
    const pass = result.passes[0];
    output.textContent = `${settingLabel}, DPR ${window.devicePixelRatio}: ${pass?.nodes} nodes, total ${pass?.totalMs.total.toFixed(1)} ms, mean ${pass?.totalMs.mean.toFixed(3)} ms/node`;
    void environment().then((pageEnvironment) => {
      const report = {
        spike: 'M6-S0',
        measurement: 'b (manual): layout at a real DPR or browser zoom',
        createdAt: new Date().toISOString(),
        label: settingLabel,
        devicePixelRatio: window.devicePixelRatio,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        families,
        page: pageEnvironment,
        ...result,
      };
      const link = document.createElement('a');
      link.href = URL.createObjectURL(
        new Blob([JSON.stringify(report)], { type: 'application/json' }),
      );
      const safe = settingLabel.replace(/[^A-Za-z0-9._-]+/g, '_');
      link.download = `m6-s0-manual-layout-${safe}-dpr${window.devicePixelRatio}.json`;
      link.click();
    });
  });
  panel.append(label, runButton, output);
}
