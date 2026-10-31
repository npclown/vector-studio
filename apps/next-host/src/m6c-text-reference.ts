import type { Editor } from '@vector-studio/editor-core';
import { referenceStyle, type StyleDeclarations } from '@vector-studio/text-dom';
import {
  clusterPlacements,
  probeHostSize,
  textScene,
  type ClusterPlacement,
  type DeviceBox,
  type DeviceRect,
  type FrameCrop,
} from './m6c-text-probe';

// M6c-U3 (MVP M6c contract, sections 2 and 6.1; M6c-Q6 (a)): the DOM side of the agreement,
// loaded only under `?test=1` beside the cluster probe (src/m6c-text-probe.ts, U2 note 3), as
// `window.__p5Host.text.reference`. Since M6-Q14 (a) no product DOM draws text, so these elements
// exist only here. Every style comes from text-dom's `referenceStyle`, the declarations its
// measurement block and run spans are built from, so the reference cannot drift from what
// text-dom measures.
// - `reference(id, index)`: the placed DOM cluster. The cluster alone in its own visible span at
//   the displayed size, in a white box over the page at the viewport origin, which is where the
//   probe's canvas lies, so a viewport device pixel is a probe frame pixel. The span is moved
//   until its pen origin (the left of the cluster's text rect) reads back on the target pen and
//   its baseline (a zero-size baseline-aligned probe, as text-dom reads baselines) on the snapped
//   corner row `P.y` (`PlacedTarget`); the residual is returned. The page cannot read its own DOM pixels, so the
//   spec screenshots `clip` at device scale and hands the PNG to `readReference`, which returns it
//   as a `FrameCrop` comparable with `readCluster`'s (absolute device px) and removes the box.
//   The box is a composited layer (`will-change: transform`), on which Chromium paints text with
//   grayscale antialiasing, as the atlas's coverage is; `{ lcd: true }` leaves it in the page's
//   own layer, where it may get LCD (ClearType) antialiasing (section 12), for the record.
// - `reference(id)`: the flowed DOM block. The whole node in one hidden block at the displayed
//   size, as the browser flows it (text-dom's run spans, the node's width and alignment), read
//   per cluster with `Range.getClientRects`; baselines from each run's ascent, measured as
//   text-dom measures it (a U+200B with a baseline probe). Positions only: the layout term is
//   recorded, not gated.

/**
 * Where the placed DOM cluster's pen point goes, in viewport CSS px. `baseline` is the snapped
 * corner row `P.y`. Chromium paints a text baseline on a whole layout px (under CDP
 * `deviceScaleFactor` emulation a whole CSS px, so a half CSS px at DPR 2 lands one device px
 * low), so the block's own baseline is put on the whole CSS px `baseline − layerShift` and the
 * reference layer is translated by `layerShift`, a whole number of device px at an integer DPR,
 * which moves its raster without resampling. `x` is the GPU's quantized pen `P.x + phaseX`
 * (`pen: 'quantized'`, the gated reading: E28's own quantization of `o.x` is the placement term's)
 * or `o.x` itself (`pen: 'origin'`, recorded).
 */
export type PlacedTarget = Readonly<{ x: number; baseline: number; layerShift: number }>;

export type PenTarget = 'quantized' | 'origin';

/** The target of a snapped placement; throws for a general or omitted one. */
export function placedTarget(
  placement: ClusterPlacement,
  devicePixelRatio: number,
  pen: PenTarget = 'quantized',
): PlacedTarget {
  if (placement.mode !== 'snapped' || placement.corner === null) {
    throw new Error(`The cluster is ${placement.mode}, not snapped: it has no corner P.`);
  }
  const [px, py] = placement.corner;
  const baseline = py / devicePixelRatio;
  return {
    x: (pen === 'quantized' ? px + placement.phaseX : placement.origin[0]) / devicePixelRatio,
    baseline,
    layerShift: baseline - Math.floor(baseline),
  };
}

/** The displayed size in CSS px (contract section 2): the device size over the DPR. */
export function displayedSize(placement: ClusterPlacement, devicePixelRatio: number): number {
  return placement.deviceSize / devicePixelRatio;
}

/** The block's next position: its current one moved by the read-back residual. */
export function nextPosition(
  position: Readonly<{ left: number; top: number }>,
  measured: Readonly<{ pen: number; baseline: number }>,
  target: Pick<PlacedTarget, 'x' | 'baseline'>,
): { left: number; top: number } {
  return {
    left: position.left + (target.x - measured.pen),
    top: position.top + (target.baseline - measured.baseline),
  };
}

/** A viewport rectangle in whole CSS px. */
export type CssRect = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * The screenshot clip for a cluster: the whole CSS px covering its E28-K9 bound padded by 2
 * device px (as `readCluster`'s crop), clamped to `area` (the probe canvas's CSS size), and the
 * device rectangle that clip covers.
 */
export function referenceClip(
  bound: DeviceBox,
  devicePixelRatio: number,
  area: Readonly<{ width: number; height: number }>,
): Readonly<{ clip: CssRect; rect: DeviceRect }> {
  const x0 = Math.max(0, Math.floor((bound.x0 - 2) / devicePixelRatio));
  const y0 = Math.max(0, Math.floor((bound.y0 - 2) / devicePixelRatio));
  const x1 = Math.min(area.width, Math.ceil((bound.x1 + 2) / devicePixelRatio));
  const y1 = Math.min(area.height, Math.ceil((bound.y1 + 2) / devicePixelRatio));
  const clip = { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  const device = (value: number) => Math.round(value * devicePixelRatio);
  return {
    clip,
    rect: {
      x: device(clip.x),
      y: device(clip.y),
      width: device(clip.width),
      height: device(clip.height),
    },
  };
}

/** One span's text: a run's text between LFs, or one LF, at its offset in the node text. */
export type TextPiece = Readonly<{ run: number; start: number; text: string; lf: boolean }>;

/** Each run's text split at LFs, as text-dom's run tree builds its spans. */
export function textPieces(runs: readonly Readonly<{ text: string }>[]): TextPiece[] {
  const pieces: TextPiece[] = [];
  let offset = 0;
  runs.forEach((run, index) => {
    for (const piece of run.text.split(/(\n)/u)) {
      if (piece.length === 0) continue;
      pieces.push({ run: index, start: offset, text: piece, lf: piece === '\n' });
      offset += piece.length;
    }
  });
  return pieces;
}

/** The piece holding `[start, end)` and the local offset of `start` in it. */
export function locatePiece(
  pieces: readonly TextPiece[],
  start: number,
  end: number,
): Readonly<{ piece: number; local: number }> {
  const index = pieces.findIndex(
    (piece) => !piece.lf && start >= piece.start && end <= piece.start + piece.text.length,
  );
  if (index === -1) throw new Error(`No text piece holds [${start}, ${end}).`);
  return { piece: index, local: start - pieces[index]!.start };
}

/**
 * Line indices of flowed clusters in text order: a cluster starts a new line after `breaks` LFs,
 * or when its baseline is more than 0.5 px below the current line's (as text-dom's pass 1 assigns
 * lines by baseline, M6a-U4b), so mixed sizes on one baseline stay on one line; text rects of
 * consecutive lines overlap when the line height is below the content area.
 */
export function flowedLines(
  clusters: readonly Readonly<{ baseline: number; breaks?: number }>[],
): number[] {
  const lines: number[] = [];
  let line = 0;
  let baseline = Number.NEGATIVE_INFINITY;
  for (const cluster of clusters) {
    const breaks = cluster.breaks ?? 0;
    if (lines.length > 0 && (breaks > 0 || cluster.baseline > baseline + 0.5)) {
      line += Math.max(1, breaks);
    }
    if (lines.length === 0 || breaks > 0 || cluster.baseline > baseline + 0.5) {
      baseline = cluster.baseline;
    }
    lines.push(line);
  }
  return lines;
}

/** `reference(id, index)`'s result. */
export type PlacedReference = Readonly<{
  placement: ClusterPlacement;
  /** The span's font size, CSS px. */
  displayedSize: number;
  target: PlacedTarget;
  /** The pen origin and baseline read back after placing, CSS px. */
  pen: number;
  baseline: number;
  /** Read back minus target, CSS px. */
  residual: Readonly<{ x: number; y: number }>;
  /** Placement passes run (at most `MAX_PASSES`). */
  passes: number;
  lcd: boolean;
  penTarget: PenTarget;
  /** Screenshot this at device scale, then pass the PNG to `readReference`. */
  clip: CssRect;
  /** The device rectangle of the screenshot, as `readReference`'s crop will carry it. */
  rect: DeviceRect;
}>;

export type PlacedReferenceOptions = Readonly<{
  /** Paint in the page's own layer (LCD antialiasing where the OS uses it); recorded only. */
  lcd?: boolean;
  /** The pen target (see `PlacedTarget`); default `quantized`. */
  pen?: PenTarget;
}>;

/** `reference(id)`'s result: the flowed DOM block, positions relative to its content box. */
export type FlowedReference = Readonly<{
  id: string;
  /** Displayed CSS px per page unit. */
  scale: number;
  /** Lines the flowed block's clusters fall on. */
  lines: number;
  portLines: number;
  clusters: readonly Readonly<{
    index: number;
    start: number;
    end: number;
    text: string;
    run: number;
    line: number;
    portLine: number;
    /** Pen origin and baseline, CSS px at the displayed size. */
    x: number;
    baseline: number;
    portX: number;
    portBaseline: number;
  }>[];
}>;

/** M6-S0's minimum-font-size probe: a 9 px run's width against half the 18 px width. */
export type MinimumFontSize = Readonly<{
  width9: number;
  width18: number;
  ratio9To18Half: number;
  clampSuspected: boolean;
}>;

const HOST_TAG = 'vector-studio-text-reference';
const PROBE_STYLE =
  'display: inline-block; width: 0; height: 0; margin: 0; padding: 0; border: 0; vertical-align: baseline';
const SENTINEL = '​';
/** Enough for Chromium's layout unit: the second pass lands within it. */
const MAX_PASSES = 4;

let shown: { host: HTMLElement; rect: DeviceRect } | null = null;

function apply(element: HTMLElement, declarations: StyleDeclarations): void {
  for (const [property, value] of declarations) element.style.setProperty(property, value);
}

/** A box over the probe canvas's area at the viewport origin, with a shadow root. */
function createHost(
  area: Readonly<{ width: number; height: number }>,
  visible: boolean,
  lcd: boolean,
  reset: StyleDeclarations,
  layerShift = 0,
) {
  const host = document.createElement(HOST_TAG);
  const style: (readonly [string, string])[] = [
    ...reset,
    ['display', 'block'],
    ['position', 'fixed'],
    // One CSS px of margin above and below, so a layer shift never uncovers a row of the area.
    ['left', '0'],
    ['top', '-1px'],
    ['width', `${area.width}px`],
    ['height', `${area.height + 2}px`],
    ['overflow', 'hidden'],
    ['contain', 'strict'],
    ['pointer-events', 'none'],
    ['z-index', '2147483647'],
  ];
  if (visible) style.push(['background', '#ffffff']);
  else style.push(['visibility', 'hidden']);
  if (!lcd) style.push(['will-change', 'transform']);
  if (layerShift !== 0) style.push(['transform', `translateY(${layerShift}px)`]);
  for (const [property, value] of style) host.style.setProperty(property, value, 'important');
  host.setAttribute('aria-hidden', 'true');
  const root = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  return { host, root };
}

function baselineProbe(): HTMLElement {
  const probe = document.createElement('span');
  probe.style.cssText = PROBE_STYLE;
  return probe;
}

type Leaf = NonNullable<ReturnType<typeof textScene>>['leaves'][number];

function hostLeaf(id: string) {
  const scene = textScene();
  const size = probeHostSize();
  const leaf = scene?.leaves.find((value) => value.id === id);
  if (scene === null || size === null || leaf === undefined) {
    throw new Error(`No projected text leaf ${id}.`);
  }
  if (scene.camera === null) throw new Error('The host renderer has no camera yet.');
  return { leaf, camera: scene.camera, size };
}

function textNode(editor: Editor, id: string) {
  const node = editor.query({ type: 'node', id });
  if (node === null || node.type !== 'text') throw new Error(`${id} is not a text node.`);
  return node;
}

/** Removes the shown placed reference, if any. */
export function clearReference(): void {
  shown?.host.remove();
  shown = null;
}

/** The placed DOM cluster `index` (text order across runs) of the leaf `id`, shown. */
export function placeReference(
  editor: Editor,
  id: string,
  index: number,
  options: PlacedReferenceOptions = {},
): PlacedReference {
  clearReference();
  const { leaf, camera, size } = hostLeaf(id);
  const dpr = size.devicePixelRatio;
  const placement = clusterPlacements(leaf, camera, dpr)[index];
  if (placement === undefined) throw new Error(`Leaf ${id} has no cluster ${index}.`);
  const penTarget = options.pen ?? 'quantized';
  const target = placedTarget(placement, dpr, penTarget);
  const node = textNode(editor, id);
  const fontSize = displayedSize(placement, dpr);
  const style = referenceStyle({
    lang: leaf.leaf.lang,
    fontList: placement.fontList,
    size: fontSize,
    letterSpacing: node.letterSpacing,
    lineHeight: node.lineHeight,
  });
  const lcd = options.lcd === true;
  // The layer shift moves the painted text and its rects alike, so the read-back below still
  // aims at `target`, and the block's own baseline lands on the whole CSS px under it.
  const { host, root } = createHost(size, true, lcd, style.host, target.layerShift);
  const block = document.createElement('div');
  block.lang = style.lang;
  apply(block, style.block);
  apply(block, [
    ['position', 'absolute'],
    ['left', '0px'],
    ['top', '0px'],
    ['color', '#000000'],
  ]);
  const span = document.createElement('span');
  apply(span, style.text);
  const text = document.createTextNode(placement.text);
  const probe = baselineProbe();
  span.append(text, probe);
  block.append(span);
  root.append(block);
  const { clip, rect } = referenceClip(placement.bound, dpr, size);
  shown = { host, rect };
  const range = document.createRange();
  range.selectNodeContents(text);
  const read = () => {
    const rect = range.getClientRects()[0];
    if (rect === undefined)
      throw new Error(`The cluster ${JSON.stringify(placement.text)} has no rect.`);
    return { pen: rect.left, baseline: probe.getBoundingClientRect().bottom };
  };
  let position = { left: 0, top: 0 };
  let measured = read();
  let passes = 0;
  while (passes < MAX_PASSES) {
    if (measured.pen === target.x && measured.baseline === target.baseline) break;
    position = nextPosition(position, measured, target);
    block.style.setProperty('left', `${position.left}px`);
    block.style.setProperty('top', `${position.top}px`);
    passes += 1;
    const next = read();
    const unchanged = next.pen === measured.pen && next.baseline === measured.baseline;
    measured = next;
    if (unchanged) break;
  }
  return {
    placement,
    displayedSize: fontSize,
    target,
    pen: measured.pen,
    baseline: measured.baseline,
    residual: { x: measured.pen - target.x, y: measured.baseline - target.baseline },
    passes,
    lcd,
    penTarget,
    clip,
    rect,
  };
}

/** The shown placed reference's screenshot (a PNG, base64) as a crop; removes the reference. */
export async function readReference(pngBase64: string): Promise<FrameCrop> {
  const current = shown;
  if (current === null) throw new Error('No placed reference is shown.');
  try {
    const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const { rect } = current;
    if (bitmap.width !== rect.width || bitmap.height !== rect.height) {
      throw new Error(
        `The screenshot is ${bitmap.width} x ${bitmap.height}, not ${rect.width} x ${rect.height}.`,
      );
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('No 2D context to decode the screenshot.');
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let text = '';
    for (let offset = 0; offset < rgba.length; offset += 8192) {
      text += String.fromCharCode(...rgba.subarray(offset, offset + 8192));
    }
    return { ...rect, rgbaBase64: btoa(text) };
  } finally {
    clearReference();
  }
}

function runKey(fontList: string, size: number): string {
  return JSON.stringify([fontList, size]);
}

/** The flowed DOM block of the leaf `id` at its displayed size (positions, recorded only). */
export function flowedReference(editor: Editor, id: string): FlowedReference {
  const { leaf, camera, size } = hostLeaf(id);
  const dpr = size.devicePixelRatio;
  const node = textNode(editor, id);
  const layout = editor.query({ type: 'textLayout', id });
  if (layout === null) throw new Error(`${id} has no layout.`);
  const scale = displayScale(leaf, camera, dpr);
  const styleOf = (run: number) =>
    referenceStyle({
      lang: layout.lang,
      fontList: layout.fontLists[run]!,
      size: node.runs[run]!.size * scale,
      letterSpacing: node.letterSpacing,
      lineHeight: node.lineHeight,
    });
  const { host, root } = createHost(size, false, true, styleOf(0).host);
  try {
    // Each run's ascent, as text-dom measures it: a U+200B in the run's style, then a baseline
    // probe, on a line of its own.
    const ascents = new Map<string, number>();
    const samples = document.createElement('div');
    apply(samples, styleOf(0).block);
    samples.style.setProperty('white-space', 'pre');
    const pending: [string, Text, HTMLElement][] = [];
    node.runs.forEach((run, index) => {
      const key = runKey(layout.fontLists[index]!, run.size);
      if (pending.some(([seen]) => seen === key)) return;
      const span = document.createElement('span');
      apply(span, styleOf(index).text);
      const text = document.createTextNode(SENTINEL);
      const probe = baselineProbe();
      span.append(text, probe);
      samples.append(span, document.createElement('br'));
      pending.push([key, text, probe]);
    });
    const block = document.createElement('div');
    block.lang = layout.lang;
    apply(block, styleOf(0).block);
    apply(block, [
      ['width', node.sizing === 'autoWidth' ? 'max-content' : `${node.frame.width * scale}px`],
      ['text-align', node.align],
    ]);
    const pieces = textPieces(node.runs);
    const texts = pieces.map((piece) => {
      const span = document.createElement('span');
      apply(span, piece.lf ? styleOf(piece.run).run : styleOf(piece.run).text);
      const text = document.createTextNode(piece.text);
      span.append(text);
      block.append(span);
      return text;
    });
    root.append(samples, block);
    const range = document.createRange();
    for (const [key, text, probe] of pending) {
      range.selectNodeContents(text);
      const rect = range.getClientRects()[0];
      if (rect !== undefined) ascents.set(key, probe.getBoundingClientRect().bottom - rect.top);
    }
    const origin = block.getBoundingClientRect();
    let lastEnd = 0;
    const rects = layout.clusters.map((cluster) => {
      const { piece, local } = locatePiece(pieces, cluster.start, cluster.end);
      range.setStart(texts[piece]!, local);
      range.setEnd(texts[piece]!, local + cluster.end - cluster.start);
      const rect = range.getClientRects()[0];
      if (rect === undefined) {
        throw new Error(`Cluster [${cluster.start}, ${cluster.end}) has no rect.`);
      }
      const ascent = ascents.get(
        runKey(layout.fontLists[cluster.run]!, node.runs[cluster.run]!.size),
      );
      if (ascent === undefined) throw new Error(`Run ${cluster.run} has no ascent.`);
      const breaks = pieces.filter(
        (value) => value.lf && value.start >= lastEnd && value.start < cluster.start,
      ).length;
      lastEnd = cluster.end;
      return { left: rect.left - origin.left, baseline: rect.top - origin.top + ascent, breaks };
    });
    const lines = flowedLines(rects);
    const text = node.runs.map((run) => run.text).join('');
    const clusters = layout.clusters.map((cluster, index) => {
      const rect = rects[index]!;
      return {
        index,
        start: cluster.start,
        end: cluster.end,
        text: text.slice(cluster.start, cluster.end),
        run: cluster.run,
        line: lines[index]!,
        portLine: cluster.line,
        x: rect.left,
        baseline: rect.baseline,
        portX: cluster.x * scale,
        portBaseline: cluster.y * scale,
      };
    });
    return {
      id,
      scale,
      lines: lines.length === 0 ? 0 : lines.at(-1)! + 1,
      portLines: layout.lines.length,
      clusters,
    };
  } finally {
    host.remove();
  }
}

/** Displayed CSS px per page unit of a uniformly scaled leaf. */
function displayScale(
  leaf: Leaf,
  camera: Parameters<typeof clusterPlacements>[1],
  devicePixelRatio: number,
): number {
  const [placement] = clusterPlacements(leaf, camera, devicePixelRatio);
  if (placement === undefined) throw new Error(`Leaf ${leaf.id} has no cluster.`);
  return placement.deviceSize / placement.size / devicePixelRatio;
}

/** M6-S0's minimum-font-size probe in `fontList` with text-dom's styles. */
export function minimumFontSize(fontList: string): MinimumFontSize {
  const size = probeHostSize() ?? { width: 960, height: 640, devicePixelRatio: 1 };
  const styleAt = (px: number) =>
    referenceStyle({ lang: 'ko', fontList, size: px, letterSpacing: 0, lineHeight: 1.2 });
  const { host, root } = createHost(size, false, true, styleAt(9).host);
  try {
    const width = (px: number) => {
      const style = styleAt(px);
      const block = document.createElement('div');
      apply(block, style.block);
      block.style.setProperty('width', 'max-content');
      const span = document.createElement('span');
      apply(span, style.text);
      span.append(document.createTextNode('Vector 한글 Studio'));
      block.append(span);
      root.append(block);
      const value = span.getBoundingClientRect().width;
      block.remove();
      return value;
    };
    const width9 = width(9);
    const width18 = width(18);
    const ratio9To18Half = width9 / (width18 / 2);
    return { width9, width18, ratio9To18Half, clampSuspected: ratio9To18Half > 1.02 };
  } finally {
    host.remove();
  }
}
