import type {
  Editor,
  ExportNode,
  ExportScene,
  PathStroke,
  SceneAffine,
  SceneGradient,
  ScenePaint,
  ScenePathGeometry,
} from '@vector-studio/editor-core';

// V-30 export contract (docs/plans/viz-v30-export-contract.md), section 3: a PNG of the export
// scene painted with Canvas 2D in the page's document, so the fonts registered for text layout
// draw as on the editor canvas.

/** V30-P1: the largest side and pixel count of an exported image. */
export const EXPORT_MAX_SIDE = 16_384;
export const EXPORT_MAX_PIXELS = 2 ** 27;
/** V30-P1: the largest export scale. */
export const EXPORT_MAX_SCALE = 16;
/** Repetitions of a reflected or repeated gradient over a shape's extent, at most. */
const MAX_SPREAD_CYCLES = 4096;

/** What `exportPng` exports: `ids` as the `exportScene` query takes them, at `scale`. */
export type ExportPngOptions = Readonly<{
  /** Omitted: the active page's top-level nodes. */
  ids?: readonly string[];
  /** In (0, 16]; default 1. */
  scale?: number;
}>;

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Surface = HTMLCanvasElement | OffscreenCanvas;
type Matrix = SceneAffine;

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!(Math.abs(det) > 1e-300) || !Number.isFinite(det)) return null;
  const [a, b, c, d, e, f] = m;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

function setMatrix(context: Context, m: Matrix): void {
  context.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
}

function cssColor(color: { r: number; g: number; b: number; a: number }): string {
  const byte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  const alpha = Math.min(1, Math.max(0, color.a));
  return `rgba(${byte(color.r)}, ${byte(color.g)}, ${byte(color.b)}, ${alpha})`;
}

function pathOf(geometry: ScenePathGeometry): Path2D {
  const path = new Path2D();
  const p = geometry.points;
  let at = 0;
  for (const verb of geometry.verbs) {
    switch (verb) {
      case 'move':
        path.moveTo(p[at]!, p[at + 1]!);
        at += 2;
        break;
      case 'line':
        path.lineTo(p[at]!, p[at + 1]!);
        at += 2;
        break;
      case 'cubic':
        path.bezierCurveTo(p[at]!, p[at + 1]!, p[at + 2]!, p[at + 3]!, p[at + 4]!, p[at + 5]!);
        at += 6;
        break;
      case 'close':
        path.closePath();
        break;
    }
  }
  return path;
}

/**
 * The stops of `gradient` laid over `[t0, t1]` of its axis, as Canvas offsets in [0, 1] of that
 * range: `pad` keeps them, `reflect` and `repeat` repeat them (canvas gradients only pad).
 */
export function spreadStops(
  gradient: Pick<SceneGradient, 'stops' | 'spread'>,
  t0: number,
  t1: number,
): { offset: number; color: string }[] {
  const stops = gradient.stops;
  if (stops.length === 0) return [];
  const span = t1 - t0;
  const at = (t: number) => (t - t0) / span;
  if (gradient.spread === 'pad' || !(span > 0)) {
    return stops.map((stop) => ({ offset: stop.offset, color: cssColor(stop.color) }));
  }
  // Every stop of the cycles that touch [t0, t1], then cut at t0 and t1 with the colour
  // interpolated there, so partial first and last cycles keep their true colours.
  const first = Math.floor(t0);
  const last = Math.min(Math.ceil(t1), first + MAX_SPREAD_CYCLES);
  const points: { t: number; color: SceneGradient['stops'][number]['color'] }[] = [];
  for (let cycle = first; cycle < last; cycle += 1) {
    const mirrored = gradient.spread === 'reflect' && Math.abs(cycle % 2) === 1;
    const ordered = mirrored ? [...stops].reverse() : stops;
    for (const stop of ordered) {
      points.push({ t: cycle + (mirrored ? 1 - stop.offset : stop.offset), color: stop.color });
    }
  }
  const colorAt = (t: number) => {
    const after = points.findIndex((point) => point.t >= t);
    if (after <= 0) return points[after === 0 ? 0 : points.length - 1]!.color;
    const a = points[after - 1]!;
    const b = points[after]!;
    const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
    const mix = (x: number, y: number) => x + (y - x) * f;
    return {
      r: mix(a.color.r, b.color.r),
      g: mix(a.color.g, b.color.g),
      b: mix(a.color.b, b.color.b),
      a: mix(a.color.a, b.color.a),
    };
  };
  const end = Math.min(t1, last);
  const out = [{ offset: 0, color: cssColor(colorAt(t0)) }];
  for (const point of points) {
    if (point.t > t0 && point.t < end)
      out.push({ offset: at(point.t), color: cssColor(point.color) });
  }
  out.push({ offset: at(end), color: cssColor(colorAt(end)) });
  return out;
}

class Painter {
  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly make: (width: number, height: number) => Surface,
    private readonly scene: ExportScene,
  ) {}

  layer(): { surface: Surface; context: Context } {
    const surface = this.make(this.width, this.height);
    const context = surface.getContext('2d');
    if (context === null) throw new Error('exportPng: no 2d context');
    return { surface, context };
  }

  /** Paints `layer` onto `context` at device scale, with `alpha`. */
  composite(context: Context, layer: Surface, alpha: number): void {
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = alpha;
    context.drawImage(layer, 0, 0);
    context.restore();
  }

  /**
   * Fills the current layer `source-in` with `gradient` under `m` (node to device): the layer
   * holds the shape in an opaque colour, so the result is the gradient inside the shape.
   */
  gradientInto(context: Context, gradient: SceneGradient, m: Matrix): void {
    const toDevice = multiply(m, gradient.transform);
    const toGradient = invert(toDevice);
    if (toGradient === null) {
      context.clearRect(0, 0, this.width, this.height);
      return;
    }
    // The device rectangle in gradient space: the extent the gradient must cover.
    const corners = [
      [0, 0],
      [this.width, 0],
      [this.width, this.height],
      [0, this.height],
    ].map(([x, y]) => ({
      x: toGradient[0] * x! + toGradient[2] * y! + toGradient[4],
      y: toGradient[1] * x! + toGradient[3] * y! + toGradient[5],
    }));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const box = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
    let canvasGradient: CanvasGradient;
    if (gradient.kind === 'linear') {
      const t0 = gradient.spread === 'pad' ? 0 : Math.min(0, box.minX);
      const t1 = gradient.spread === 'pad' ? 1 : Math.max(1, box.maxX);
      canvasGradient = context.createLinearGradient(t0, 0, t1, 0);
      for (const stop of spreadStops(gradient, t0, t1))
        canvasGradient.addColorStop(stop.offset, stop.color);
    } else {
      const reach = Math.max(...corners.map((p) => Math.hypot(p.x, p.y)));
      const t1 = gradient.spread === 'pad' ? 1 : Math.max(1, reach);
      canvasGradient = context.createRadialGradient(0, 0, 0, 0, 0, t1);
      for (const stop of spreadStops(gradient, 0, t1))
        canvasGradient.addColorStop(stop.offset, stop.color);
    }
    context.save();
    context.globalCompositeOperation = 'source-in';
    setMatrix(context, toDevice);
    context.fillStyle = canvasGradient;
    context.fillRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
    context.restore();
  }

  /** Paints `draw` (which fills or strokes in `style`) with `paint` under `m`. */
  paint(context: Context, paint: ScenePaint, m: Matrix, draw: (target: Context) => void): void {
    if (!('kind' in paint)) {
      context.save();
      setMatrix(context, m);
      context.fillStyle = cssColor(paint);
      context.strokeStyle = cssColor(paint);
      draw(context);
      context.restore();
      return;
    }
    const { surface, context: layer } = this.layer();
    setMatrix(layer, m);
    layer.fillStyle = '#000';
    layer.strokeStyle = '#000';
    draw(layer);
    this.gradientInto(layer, paint, m);
    this.composite(context, surface, 1);
  }

  strokeStyle(target: Context, stroke: PathStroke): void {
    target.lineWidth = stroke.width;
    target.lineCap = stroke.cap;
    target.lineJoin = stroke.join;
    target.miterLimit = stroke.miterLimit;
    const dash = stroke.dash;
    if (dash !== undefined && dash !== null && dash.pattern.length > 0) {
      target.setLineDash([...dash.pattern]);
      target.lineDashOffset = dash.phase;
    }
  }

  /** Applies a container's clip to `context` under `m`; false when it covers nothing. */
  clip(context: Context, node: Extract<ExportNode, { kind: 'container' }>, m: Matrix): boolean {
    const clip = node.clip;
    if (clip === null) return true;
    if (clip.kind === 'rect') {
      setMatrix(context, m);
      context.beginPath();
      context.rect(clip.x, clip.y, clip.width, clip.height);
      context.clip();
      return true;
    }
    const id = node.children[0];
    const source = id === undefined ? undefined : this.scene.nodes.get(id);
    if (source?.kind !== 'path') return false;
    setMatrix(context, multiply(m, source.transform));
    context.clip(pathOf(source.geometry), source.geometry.fillRule);
    return true;
  }

  node(context: Context, id: string, parent: Matrix): void {
    const node = this.scene.nodes.get(id);
    if (node === undefined || !(node.opacity > 0)) return;
    const m = multiply(parent, node.transform);
    // Isolated opacity (E25-K1, and the P3 joint draw of a leaf): one layer, composited once.
    if (node.opacity < 1) {
      const { surface, context: layer } = this.layer();
      this.draw(layer, node, m);
      this.composite(context, surface, node.opacity);
      return;
    }
    this.draw(context, node, m);
  }

  draw(context: Context, node: ExportNode, m: Matrix): void {
    switch (node.kind) {
      case 'container': {
        context.save();
        if (this.clip(context, node, m)) {
          const children = node.clip?.kind === 'mask' ? node.children.slice(1) : node.children;
          for (const child of children) this.node(context, child, m);
        }
        context.restore();
        return;
      }
      case 'path': {
        const path = pathOf(node.geometry);
        if (node.fill !== null) {
          this.paint(context, node.fill, m, (target) => target.fill(path, node.geometry.fillRule));
        }
        const stroke = node.stroke;
        if (stroke !== null && stroke.width > 0) {
          this.paint(context, stroke.color, m, (target) => {
            this.strokeStyle(target, stroke);
            target.stroke(path);
          });
        }
        return;
      }
      case 'text': {
        context.save();
        setMatrix(context, m);
        context.textBaseline = 'alphabetic';
        context.textAlign = 'left';
        context.direction = 'ltr';
        for (const run of node.runs) {
          context.font = `${run.size}px ${run.fontList}`;
          context.fillStyle = cssColor(run.color);
          for (const cluster of run.clusters) context.fillText(cluster.text, cluster.x, cluster.y);
        }
        context.restore();
        return;
      }
    }
  }
}

function defaultSurface(width: number, height: number): Surface {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return new OffscreenCanvas(width, height);
}

async function toBlob(surface: Surface): Promise<Blob | null> {
  if ('convertToBlob' in surface) return surface.convertToBlob({ type: 'image/png' });
  return new Promise((resolve) => surface.toBlob((blob) => resolve(blob), 'image/png'));
}

/** The pixel size of an export of `scene` at `scale`, or null over the V30-P1 limits. */
export function exportPixelSize(
  scene: Pick<ExportScene, 'bounds'>,
  scale: number,
): { width: number; height: number } | null {
  if (!(scale > 0 && scale <= EXPORT_MAX_SCALE)) return null;
  const width = Math.ceil(scene.bounds.width * scale);
  const height = Math.ceil(scene.bounds.height * scale);
  if (width > EXPORT_MAX_SIDE || height > EXPORT_MAX_SIDE || width * height > EXPORT_MAX_PIXELS) {
    return null;
  }
  return { width: Math.max(1, width), height: Math.max(1, height) };
}

/**
 * Paints the export scene of `ids` (or of the active page) at `scale` and returns it as a PNG
 * (V-30 export contract, section 3), or null when nothing would draw. Rejects with a
 * `RangeError` when the scale is out of (0, 16] or the image would exceed 16,384 px on a side or
 * 2^27 pixels, and with an `Error` when the browser cannot paint or encode it. Call it in the
 * browser, where the text layout port registered its fonts.
 */
export async function exportPng(
  editor: Editor,
  options: ExportPngOptions = {},
): Promise<Blob | null> {
  const scale = options.scale ?? 1;
  if (!(scale > 0 && scale <= EXPORT_MAX_SCALE)) {
    throw new RangeError(`exportPng: scale ${scale} is outside (0, ${EXPORT_MAX_SCALE}]`);
  }
  const scene = editor.query(
    options.ids === undefined ? { type: 'exportScene' } : { type: 'exportScene', ids: options.ids },
  );
  if (scene === null) return null;
  const size = exportPixelSize(scene, scale);
  if (size === null) {
    throw new RangeError(
      `exportPng: the image would be ${Math.ceil(scene.bounds.width * scale)} × ${Math.ceil(scene.bounds.height * scale)} px, over the ${EXPORT_MAX_SIDE} px side or 2^27 pixel limit`,
    );
  }
  const painter = new Painter(size.width, size.height, defaultSurface, scene);
  const { surface, context } = painter.layer();
  const { x, y } = scene.bounds;
  const base: Matrix = [scale, 0, 0, scale, -x * scale, -y * scale];
  for (const id of scene.rootOrder) painter.node(context, id, base);
  return toBlob(surface);
}
