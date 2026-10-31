import type { TextLayoutRequest, TextLayoutResult } from '@vector-studio/contracts';

// M6a-U6 (MVP M6a contract, section 16, M6a-U4 review r3 carry list): the in-page reference the
// headed spec compares text-dom with. `installProbe` is passed to `page.evaluate`, so it is
// serialized and must not reference anything outside its own body.
//
// For a request, `compare` lays it out through the page's text-dom port (`window.__p5Host.text`)
// and builds an unprobed `white-space: pre-wrap` reference block of the same runs at text-dom's
// measurement scale (M6-Q3 (b), contract section 3.2: sizes and width times the scale, every
// reference length divided by it, the scale passed in by the spec from text-dom's constants): the block
// styles of section 4 (zero-size strut, `keep-all`, `overflow-wrap: anywhere`, no ligatures,
// `text-spacing-trim: space-all`, `text-autospace: no-autospace`, `lang`), one span per run (with
// the `lang` too, since the block's `all: initial` resets the locale its own `lang` sets) with
// the result's font list, size, letter spacing in em and unitless line height, no bidi override,
// no `<br>` and no probe, plus text-dom's U+200B sentinel when the text is empty or ends in LF.
//
// - Line tops, line heights and the block height: the bottom of line i is the height of the
//   reference block cut at the start of line i + 1 (whole lines only, so the earlier lines break
//   as in the full block), the last line's bottom the full block's height.
// - Cluster baselines: each cluster's `Range` rect top in the full reference block, plus the
//   cluster's ascent above its baseline measured alone in a one-line block with a baseline
//   marker, is that cluster's reference baseline; it must equal the baseline of the cluster's
//   line in the result, so a cluster on another line, or a displaced line box, shows as a
//   difference of about a line pitch.
// - Ink: each cluster's canvas ink (`measureText` with the result's font list) against its
//   E28-K9 bound `[x + min(advance, 0) - size, x + max(advance, 0) + size]`.

export type ProbeLine = Readonly<{
  top: number;
  height: number;
  refTop: number;
  refHeight: number;
}>;

export type ProbeReport = Readonly<{
  result: TextLayoutResult;
  /** `fallbacks` of the port after the request minus before it. */
  fallbacks: number;
  height: number;
  refHeight: number;
  lines: readonly ProbeLine[];
  /** Per cluster: the result's line baseline minus the reference baseline. */
  baselineDeltas: readonly number[];
  /** Clusters whose canvas ink leaves the E28-K9 bound. */
  inkOutside: readonly Readonly<{
    index: number;
    ink: [number, number];
    bound: [number, number];
  }>[];
}>;

export type Probe = Readonly<{
  compare(request: TextLayoutRequest): ProbeReport;
  /** The canvas advance of `text` alone in `size` px of `fontList`. */
  canvasWidth(text: string, size: number, fontList: string): number;
}>;

declare global {
  interface Window {
    __m6aProbe?: Probe;
  }
}

/** text-dom's scale constants (packages/text-dom/src/scale.ts), passed in by the spec. */
export type ProbeScale = Readonly<{
  referenceScale: number;
  maxMeasuredSize: number;
  maxMeasuredExtent: number;
}>;

export function installProbe({
  referenceScale,
  maxMeasuredSize,
  maxMeasuredExtent,
}: ProbeScale): void {
  type Run = TextLayoutRequest['runs'][number];

  /** text-dom's `measurementScale` and `scaleRequest`, repeated: the probe is serialized. */
  const scaleOf = (request: TextLayoutRequest): number => {
    const largest = Math.max(...request.runs.map((r) => r.size));
    const units = request.runs.reduce((sum, r) => sum + r.text.length, 0) + 1;
    const emPerUnit = Math.max(request.lineHeight, 2 + Math.max(0, request.letterSpacing));
    const extent = largest * units * emPerUnit;
    let scale = referenceScale;
    while (scale > 1 && (largest * scale > maxMeasuredSize || extent * scale > maxMeasuredExtent)) {
      scale /= 2;
    }
    return scale;
  };
  const scaled = (request: TextLayoutRequest, scale: number): TextLayoutRequest => ({
    ...request,
    runs: request.runs.map((r) => ({ ...r, size: r.size * scale })),
    width: request.width === null ? null : Math.min(request.width * scale, Number.MAX_VALUE),
  });
  const port = (
    window as unknown as {
      __p5Host: {
        text: { port: { layout(r: TextLayoutRequest): TextLayoutResult; fallbacks: number } };
      };
    }
  ).__p5Host.text.port;

  /** The result's `lang`, set by `compare` before it builds a block. */
  let lang = 'ko';

  const HOST_STYLE = [
    'all: initial',
    'display: block',
    'position: fixed',
    'left: 0',
    'top: 0',
    'width: 0',
    'height: 0',
    'visibility: hidden',
    'contain: strict',
    'pointer-events: none',
  ];
  const host = document.createElement('m6a-reference');
  for (const declaration of HOST_STYLE) {
    const [property, value] = declaration.split(': ') as [string, string];
    host.style.setProperty(property, value, 'important');
  }
  const root = host.attachShadow({ mode: 'open' });
  document.body.append(host);

  const blockStyle = (width: string) =>
    [
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
      `width: ${width}`,
    ].join('; ');

  const spanStyle = (fontList: string, size: number, request: TextLayoutRequest) =>
    `font-family: ${fontList}; font-size: ${size}px; letter-spacing: ${request.letterSpacing}em; line-height: ${request.lineHeight}`;

  type Built = Readonly<{ block: HTMLElement; spans: HTMLElement[] }>;

  /** The reference block of `request` cut at `cut` (UTF-16 offset), with or without sentinel. */
  function build(
    request: TextLayoutRequest,
    fontLists: readonly string[],
    cut: number,
    sentinel: boolean,
  ): Built {
    const block = document.createElement('div');
    block.lang = lang;
    block.style.cssText = blockStyle(request.width === null ? 'max-content' : `${request.width}px`);
    const spans: HTMLElement[] = [];
    let start = 0;
    request.runs.forEach((run: Run, index) => {
      const text = run.text.slice(0, Math.max(0, cut - start));
      start += run.text.length;
      const span = document.createElement('span');
      span.lang = lang;
      span.style.cssText = spanStyle(fontLists[index]!, run.size, request);
      span.textContent = text;
      spans.push(span);
      if (text.length > 0) block.append(span);
    });
    if (sentinel) {
      const last = request.runs.length - 1;
      const span = document.createElement('span');
      span.lang = lang;
      span.style.cssText = spanStyle(fontLists[last]!, request.runs[last]!.size, request);
      span.textContent = '\u200b';
      block.append(span);
    }
    root.replaceChildren(block);
    return { block, spans };
  }

  function heightOf(
    request: TextLayoutRequest,
    fontLists: readonly string[],
    cut: number,
    sentinel: boolean,
  ): number {
    const { block } = build(request, fontLists, cut, sentinel);
    return block.getBoundingClientRect().height;
  }

  /** The ascent of `text` above its baseline, alone on one line in the run's style. */
  function ascentOf(
    text: string,
    fontList: string,
    size: number,
    request: TextLayoutRequest,
  ): number {
    const block = document.createElement('div');
    block.lang = lang;
    block.style.cssText = blockStyle('max-content');
    const span = document.createElement('span');
    span.lang = lang;
    span.style.cssText = spanStyle(fontList, size, request);
    span.textContent = text;
    const marker = document.createElement('span');
    marker.style.cssText =
      'display: inline-block; width: 0; height: 0; margin: 0; padding: 0; border: 0; vertical-align: baseline';
    span.append(marker);
    block.append(span);
    root.replaceChildren(block);
    const range = document.createRange();
    range.setStart(span.firstChild!, 0);
    range.setEnd(span.firstChild!, text.length);
    const rect = range.getClientRects()[0]!;
    return marker.getBoundingClientRect().bottom - rect.top;
  }

  const canvas = new OffscreenCanvas(8, 8).getContext('2d')!;

  function canvasWidth(text: string, size: number, fontList: string): number {
    canvas.font = `${size}px ${fontList}`;
    return canvas.measureText(text).width;
  }

  function compare(original: TextLayoutRequest): ProbeReport {
    const before = port.fallbacks;
    const result = port.layout(original);
    const fallbacks = port.fallbacks - before;
    // The reference is built at text-dom's scale; its lengths are divided back below.
    const scale = scaleOf(original);
    const request = scaled(original, scale);
    lang = result.lang;
    const text = request.runs.map((run) => run.text).join('');
    const sentinel = text.length === 0 || text.endsWith('\n');
    const { fontLists, lines } = result;

    const bottoms = lines.map(
      (_, index) =>
        (index < lines.length - 1
          ? heightOf(request, fontLists, lines[index + 1]!.start, false)
          : heightOf(request, fontLists, text.length, sentinel)) / scale,
    );
    const probeLines = lines.map((line, index) => {
      const refTop = index === 0 ? 0 : bottoms[index - 1]!;
      return { top: line.top, height: line.height, refTop, refHeight: bottoms[index]! - refTop };
    });

    // Cluster baselines against the full reference block.
    const ascents = result.clusters.map((cluster) => {
      const run = request.runs[cluster.run]!;
      const runStart = request.runs
        .slice(0, cluster.run)
        .reduce((sum, previous) => sum + previous.text.length, 0);
      const piece = run.text.slice(cluster.start - runStart, cluster.end - runStart);
      return ascentOf(piece, fontLists[cluster.run]!, run.size, request);
    });
    const { block, spans } = build(request, fontLists, text.length, sentinel);
    const origin = block.getBoundingClientRect();
    const refHeight = origin.height / scale;
    const range = document.createRange();
    const baselineDeltas = result.clusters.map((cluster, index) => {
      const runStart = request.runs
        .slice(0, cluster.run)
        .reduce((sum, previous) => sum + previous.text.length, 0);
      const node = spans[cluster.run]!.firstChild!;
      range.setStart(node, cluster.start - runStart);
      range.setEnd(node, cluster.end - runStart);
      const rect = range.getClientRects()[0];
      if (rect === undefined) return Number.NaN;
      const refBaseline = (rect.top - origin.top + ascents[index]!) / scale;
      return lines[cluster.line]!.baseline - refBaseline;
    });
    root.replaceChildren();

    const inkOutside: { index: number; ink: [number, number]; bound: [number, number] }[] = [];
    // Ink in page units, against the original request.
    result.clusters.forEach((cluster, index) => {
      const run = original.runs[cluster.run]!;
      const runStart = original.runs
        .slice(0, cluster.run)
        .reduce((sum, previous) => sum + previous.text.length, 0);
      const piece = run.text.slice(cluster.start - runStart, cluster.end - runStart);
      canvas.font = `${run.size}px ${fontLists[cluster.run]!}`;
      const metrics = canvas.measureText(piece);
      const ink: [number, number] = [
        cluster.x - metrics.actualBoundingBoxLeft,
        cluster.x + metrics.actualBoundingBoxRight,
      ];
      const bound: [number, number] = [
        cluster.x + Math.min(cluster.advance, 0) - run.size,
        cluster.x + Math.max(cluster.advance, 0) + run.size,
      ];
      if (ink[0] < bound[0] - 1e-6 || ink[1] > bound[1] + 1e-6)
        inkOutside.push({ index, ink, bound });
    });

    return {
      result,
      fallbacks,
      height: result.height,
      refHeight,
      lines: probeLines,
      baselineDeltas,
      inkOutside,
    };
  }

  window.__m6aProbe = { compare, canvasWidth };
}
