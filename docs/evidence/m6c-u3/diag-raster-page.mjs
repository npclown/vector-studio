/* global window, document, navigator, OffscreenCanvas, OffscreenCanvasRenderingContext2D, fetch, createImageBitmap, Blob, atob */
// M6c-U3 raster diagnosis, page half (README.md next to this file). Loaded by diag-raster.mjs on
// a page it serves itself (no next-host, no GPU). It lays out the `?fixture=text-gpu` agreement
// nodes with the real text-dom, places each cluster by E28-K1 to K3 (renderer-core's own
// functions, camera at the origin, zoom 1, as next-host shows the fixture), and paints it two
// ways: the placed DOM cluster as the M6c-A06 spec's reference does (m6c-text-reference.ts:
// text-dom's `referenceStyle`, the node's whole run tree transparent, the cluster alone painted,
// pen on P.x + phaseX, baseline on P.y, the composited layer and the baseline layer shift), and
// the canvas raster: E28's real `createCanvasGlyphRaster` and variants of it, composited black on
// white at K3's corner as the atlas draws a snapped cluster (one bitmap pixel to one device pixel,
// colour times coverage). The measures are the spec's own (`m6c-agreement.ts`, served
// transpiled as /agree.js). DOM and canvas variants are set by the caller.
import { createTextDom, referenceStyle } from '@vector-studio/text-dom';
import { sizeBucket, snappedPlacement } from '@vector-studio/renderer-core';
import { createCanvasGlyphRaster } from '@vector-studio/renderer-webgpu';
import { maxChroma, measureInk, rasterTerm } from '/agree.js';

const PROBE_STYLE =
  'display: inline-block; width: 0; height: 0; margin: 0; padding: 0; border: 0; vertical-align: baseline';
const MAX_PASSES = 4;
const PAD = 2;
const SENTINEL_FONT = '7px "vector-studio sentinel"';

let port = null;
const port_raster = createCanvasGlyphRaster();
const nodes = new Map();
const domCrops = new Map();
let shown = null;

function apply(element, declarations) {
  for (const [property, value] of declarations) element.style.setProperty(property, value);
}

function requestOf(node) {
  return {
    runs: node.runs.map((run) => ({ text: run.text, family: run.family, size: run.size })),
    width: node.sizing === 'autoWidth' ? null : node.frame.width,
    align: node.align,
    letterSpacing: node.letterSpacing,
    lineHeight: node.lineHeight,
  };
}

function textPieces(runs) {
  const pieces = [];
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

/** E28-K1 to K3 at camera (0, 0), zoom 1: `o = dpr (frame + cluster)`. */
function placementOf(node, layout, index, dpr) {
  const cluster = layout.clusters[index];
  const text = node.runs
    .map((run) => run.text)
    .join('')
    .slice(cluster.start, cluster.end);
  const origin = [dpr * (node.frame.x + cluster.x), dpr * (node.frame.y + cluster.y)];
  const size = node.runs[cluster.run].size;
  const bucket = sizeBucket(size * dpr);
  const snapped = snappedPlacement(origin[0], origin[1]);
  return {
    index,
    text,
    run: cluster.run,
    origin,
    size,
    bucket,
    phaseX: snapped.phaseX,
    corner: [snapped.px, snapped.py],
    fontList: layout.fontLists[cluster.run],
    lang: layout.lang,
  };
}

export async function init({ fixtureUrl, fontUrl, ids }) {
  port = createTextDom({ document });
  const bytes = await (await fetch(fontUrl)).arrayBuffer();
  const status = await port.registerFont({ family: 'Noto Sans KR', source: { bytes } });
  const doc = await (await fetch(fixtureUrl)).json();
  const out = [];
  for (const id of ids) {
    const node = doc.nodes[id];
    if (node === undefined || node.type !== 'text') throw new Error(`no text node ${id}`);
    const layout = port.layout(requestOf(node));
    nodes.set(id, { node, layout });
    const inked = layout.clusters.flatMap((cluster, index) => {
      const text = node.runs
        .map((run) => run.text)
        .join('')
        .slice(cluster.start, cluster.end);
      return text.trim().length > 0 ? [index] : [];
    });
    out.push({ id, inked, texts: inked.map((index) => placementOf(node, layout, index, 1).text) });
  }
  return {
    status,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    contextLang: 'lang' in OffscreenCanvasRenderingContext2D.prototype,
    contextTextRendering: 'textRendering' in OffscreenCanvasRenderingContext2D.prototype,
    nodes: out,
  };
}

export function clearDom() {
  shown?.remove();
  shown = null;
}

/**
 * Shows the placed DOM cluster `index` of `id` in `variant` ({ layer, textRendering }) and
 * returns the CSS clip to screenshot at device scale and its device rect.
 */
export function placeDom(id, index, variant) {
  clearDom();
  const dpr = window.devicePixelRatio;
  const { node, layout } = nodes.get(id);
  const placement = placementOf(node, layout, index, dpr);
  const cluster = layout.clusters[index];
  const target = {
    x: (placement.corner[0] + placement.phaseX) / dpr,
    baseline: placement.corner[1] / dpr,
  };
  const layerShift = target.baseline - Math.floor(target.baseline);
  const nodeText = node.runs.map((run) => run.text).join('');
  const styleOf = (run) =>
    referenceStyle({
      lang: layout.lang,
      nodeText,
      fontList: layout.fontLists[run],
      size: sizeBucket(node.runs[run].size * dpr) / dpr,
      letterSpacing: node.letterSpacing,
      lineHeight: node.lineHeight,
    });
  const style = styleOf(cluster.run);
  const host = document.createElement('div');
  const hostStyle = [
    ...style.host,
    ['display', 'block'],
    ['position', 'fixed'],
    ['left', '0'],
    ['top', '-1px'],
    ['width', `${window.innerWidth}px`],
    ['height', `${window.innerHeight + 2}px`],
    ['overflow', 'hidden'],
    ['contain', 'strict'],
    ['pointer-events', 'none'],
    ['z-index', '2147483647'],
    ['background', '#ffffff'],
  ];
  if (variant.layer) hostStyle.push(['will-change', 'transform']);
  if (layerShift !== 0) hostStyle.push(['transform', `translateY(${layerShift}px)`]);
  for (const [property, value] of hostStyle) host.style.setProperty(property, value, 'important');
  const root = host.attachShadow({ mode: 'open' });
  document.body.append(host);
  shown = host;
  const block = document.createElement('div');
  block.lang = style.lang;
  apply(block, style.block);
  apply(block, [
    ['position', 'absolute'],
    ['left', '0px'],
    ['top', '0px'],
    ['width', 'max-content'],
  ]);
  if (variant.textRendering) block.style.setProperty('text-rendering', variant.textRendering);
  let clusterText = null;
  let probe = null;
  for (const piece of textPieces(node.runs)) {
    const pieceStyle = styleOf(piece.run);
    const span = document.createElement('span');
    span.lang = pieceStyle.lang;
    apply(span, piece.lf ? pieceStyle.run : pieceStyle.text);
    span.style.setProperty('color', 'transparent');
    const holds =
      !piece.lf && cluster.start >= piece.start && cluster.end <= piece.start + piece.text.length;
    if (!holds) {
      span.append(document.createTextNode(piece.text));
    } else {
      const local = cluster.start - piece.start;
      const length = cluster.end - cluster.start;
      const inner = document.createElement('span');
      inner.style.setProperty('color', '#000000');
      clusterText = document.createTextNode(piece.text.slice(local, local + length));
      inner.append(clusterText);
      probe = document.createElement('span');
      probe.style.cssText = PROBE_STYLE;
      span.append(
        document.createTextNode(piece.text.slice(0, local)),
        inner,
        document.createTextNode(piece.text.slice(local + length)),
        probe,
      );
    }
    block.append(span);
  }
  root.append(block);
  const range = document.createRange();
  range.selectNodeContents(clusterText);
  const read = () => ({
    pen: range.getClientRects()[0].left,
    baseline: probe.getBoundingClientRect().bottom,
  });
  let position = { left: 0, top: 0 };
  let measured = read();
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    if (measured.pen === target.x && measured.baseline === target.baseline) break;
    position = {
      left: position.left + (target.x - measured.pen),
      top: position.top + (target.baseline - measured.baseline),
    };
    block.style.setProperty('left', `${position.left}px`);
    block.style.setProperty('top', `${position.top}px`);
    const next = read();
    const unchanged = next.pen === measured.pen && next.baseline === measured.baseline;
    measured = next;
    if (unchanged) break;
  }
  // The clip: whole CSS px around the cluster's port bitmap rectangle, padded by 4 device px.
  const bitmap = port_raster.rasterize(rasterRequest(placement));
  const box =
    bitmap.status === 'ok'
      ? {
          x0: placement.corner[0] - bitmap.left,
          y0: placement.corner[1] - bitmap.top,
          x1: placement.corner[0] - bitmap.left + bitmap.width,
          y1: placement.corner[1] - bitmap.top + bitmap.height,
        }
      : null;
  if (box === null) throw new Error(`cluster ${index} of ${id} has no bitmap (${bitmap.status})`);
  const x0 = Math.max(0, Math.floor((box.x0 - 4) / dpr));
  const y0 = Math.max(0, Math.floor((box.y0 - 4) / dpr));
  const x1 = Math.ceil((box.x1 + 4) / dpr);
  const y1 = Math.ceil((box.y1 + 4) / dpr);
  const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  return {
    clip,
    residual: { x: measured.pen - target.x, y: measured.baseline - target.baseline },
  };
}

/** Stores the screenshot of the shown placed cluster under `key`. */
export async function storeDom(key, clip, pngBase64) {
  const dpr = window.devicePixelRatio;
  const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  domCrops.set(key, {
    x: Math.round(clip.x * dpr),
    y: Math.round(clip.y * dpr),
    width: bitmap.width,
    height: bitmap.height,
    rgba: new Uint8Array(rgba),
  });
  clearDom();
}

function rasterRequest(placement) {
  return {
    text: placement.text,
    fontList: placement.fontList,
    lang: placement.lang,
    pixelSize: placement.bucket,
    phaseX: placement.phaseX,
  };
}

/**
 * A copy of createCanvasGlyphRaster's `rasterize` (raster-v1, black fill) with the variant's
 * settings: `fill` (the text colour on a transparent surface, coverage the alpha; `#ffffff` is
 * the v0 port), `opaque` (black text on an opaque white
 * surface, coverage `255 − min(R, G, B)`), `willReadFrequently`, `element` (an HTML canvas),
 * `textRendering`, `fontKerning`, `fontVariantLigatures` none.
 */
function rasterVariant(request, variant) {
  const canvas = variant.element
    ? Object.assign(document.createElement('canvas'), { width: 64, height: 64 })
    : new OffscreenCanvas(64, 64);
  let context = canvas.getContext('2d', { willReadFrequently: variant.willReadFrequently });
  const setFont = () => {
    context.font = SENTINEL_FONT;
    const sentinel = context.font;
    context.font = `${request.pixelSize}px ${request.fontList}`;
    if (context.font === sentinel) return false;
    if ('lang' in context) context.lang = request.lang;
    if (variant.textRendering) context.textRendering = variant.textRendering;
    if (variant.fontKerning) context.fontKerning = variant.fontKerning;
    context.textBaseline = 'alphabetic';
    context.textAlign = 'left';
    return true;
  };
  if (!setFont()) return { status: 'failed' };
  const metrics = context.measureText(request.text);
  const left = PAD + Math.ceil(metrics.actualBoundingBoxLeft);
  const top = PAD + Math.ceil(metrics.actualBoundingBoxAscent);
  const width = left + Math.ceil(metrics.actualBoundingBoxRight + request.phaseX) + PAD;
  const height = top + Math.ceil(metrics.actualBoundingBoxDescent) + PAD;
  canvas.width = Math.max(canvas.width, width);
  canvas.height = Math.max(canvas.height, height);
  setFont();
  context.clearRect(0, 0, width, height);
  if (variant.opaque) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.fillStyle = '#000000';
  } else {
    context.fillStyle = variant.fill ?? '#000000';
  }
  context.fillText(request.text, left + request.phaseX, top);
  const pixels = context.getImageData(0, 0, width, height).data;
  const coverage = new Uint8Array(width * height);
  for (let index = 0; index < coverage.length; index += 1) {
    const o = index * 4;
    coverage[index] = variant.opaque
      ? 255 - Math.min(pixels[o], pixels[o + 1], pixels[o + 2])
      : pixels[o + 3];
  }
  return { status: 'ok', width, height, left, top, coverage };
}

/** The bitmap composited black on white at K3's corner, as the atlas draws a snapped cluster. */
function composite(placement, bitmap) {
  const x = placement.corner[0] - bitmap.left - 2;
  const y = placement.corner[1] - bitmap.top - 2;
  const width = bitmap.width + 4;
  const height = bitmap.height + 4;
  const rgba = new Uint8Array(width * height * 4).fill(255);
  for (let row = 0; row < bitmap.height; row += 1) {
    for (let column = 0; column < bitmap.width; column += 1) {
      const a = bitmap.coverage[row * bitmap.width + column];
      const value = Math.round(255 * (1 - a / 255));
      const i = ((row + 2) * width + column + 2) * 4;
      rgba[i] = value;
      rgba[i + 1] = value;
      rgba[i + 2] = value;
    }
  }
  return { x, y, width, height, rgba };
}

const round = (value) => (value === null ? null : Math.round(value * 1e4) / 1e4);

/**
 * Every canvas variant of cluster `index` of `id` against every stored DOM variant: the spec's
 * raster term (GPU side = canvas composite, DOM side = placed cluster), with ink summaries.
 */
export function compare(id, index, canvasVariants, domKeys) {
  const dpr = window.devicePixelRatio;
  const { node, layout } = nodes.get(id);
  const placement = placementOf(node, layout, index, dpr);
  const request = rasterRequest(placement);
  const portBitmap = port_raster.rasterize(request);
  const canvases = {};
  for (const [name, variant] of Object.entries(canvasVariants)) {
    const bitmap = name === 'port' ? portBitmap : rasterVariant(request, variant);
    if (bitmap.status !== 'ok') {
      canvases[name] = { status: bitmap.status };
      continue;
    }
    const sameAsPort =
      portBitmap.status === 'ok' &&
      bitmap.width === portBitmap.width &&
      bitmap.height === portBitmap.height &&
      bitmap.coverage.every((value, i) => value === portBitmap.coverage[i]);
    canvases[name] = { ink: measureInk(composite(placement, bitmap)), sameAsPort };
  }
  const doms = {};
  for (const key of domKeys) {
    const pixels = domCrops.get(`${id}/${index}/${key}`);
    doms[key] = { ink: measureInk(pixels), chroma: maxChroma(pixels) };
  }
  const terms = {};
  for (const [canvasName, canvas] of Object.entries(canvases)) {
    for (const [domName, dom] of Object.entries(doms)) {
      if (!canvas.ink || !dom.ink) {
        terms[`${canvasName}|${domName}`] = null;
        continue;
      }
      const t = rasterTerm(canvas.ink, dom.ink, dpr);
      terms[`${canvasName}|${domName}`] = {
        h: round(t.subOffsetX),
        v: round(t.subOffsetY),
        size: round(t.subSizeDiff),
        cx: round(t.centroidX),
        cy: round(t.centroidY),
        mass: round(t.massRatio),
      };
    }
  }
  return {
    id,
    index,
    text: placement.text,
    origin: placement.origin.map(round),
    corner: placement.corner,
    phaseX: placement.phaseX,
    bucket: placement.bucket,
    sameAsPort: Object.fromEntries(
      Object.entries(canvases).map(([name, value]) => [name, value.sameAsPort ?? null]),
    ),
    domChroma: Object.fromEntries(
      Object.entries(doms).map(([name, value]) => [name, value.chroma]),
    ),
    terms,
  };
}

window.diag = { init, placeDom, storeDom, clearDom, compare };
