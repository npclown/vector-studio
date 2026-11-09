import type { PagePoint, TextStyle } from '@vector-studio/editor-core';
import type { Color, DocumentV7, NodeV7, Paint } from '@vector-studio/model';
import { nodePageCorners } from './m2-geometry';

// V-25 slice 7 (readable default text colour): in the studio layout a text tool press picks the
// text tool's colour from what lies under it, so new text is readable: white on a dark backdrop,
// black on a light one. The backdrop is the frontmost visible frame, rectangle or ellipse whose
// box holds the point and that has a mostly opaque fill (frames clip their children, groups are
// searched through, symbols, instances and other leaves are not), else the empty canvas, which
// the WebGPU renderer clears to opaque black. Only the two automatic colours are switched: a
// colour the user set some other way is kept. Host only; the editor is unchanged.

/** The renderer's clear colour (`native-primitive-scene.ts`, the primitive pass). */
export const CANVAS_BACKDROP: Color = { r: 0, g: 0, b: 0, a: 1 };

const BLACK: Color = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Color = { r: 1, g: 1, b: 1, a: 1 };

/** A paint's representative colour: a solid colour, or the mean of a gradient's stops. */
function paintColor(paint: Paint): Color {
  if (!('stops' in paint)) return paint;
  const n = paint.stops.length;
  const sum = paint.stops.reduce(
    (acc, { color }) => ({
      r: acc.r + color.r,
      g: acc.g + color.g,
      b: acc.b + color.b,
      a: acc.a + color.a,
    }),
    { r: 0, g: 0, b: 0, a: 0 },
  );
  return { r: sum.r / n, g: sum.g / n, b: sum.b / n, a: sum.a / n };
}

/** The point in the node's own box units (0..width × 0..height), from its page corners. */
function localPoint(document: DocumentV7, node: NodeV7, point: PagePoint): PagePoint | null {
  const corners = nodePageCorners(document, node.id);
  if (corners === null) return null;
  const [o, x, , y] = corners;
  const ux = x.x - o.x;
  const uy = x.y - o.y;
  const vx = y.x - o.x;
  const vy = y.y - o.y;
  const uu = ux * ux + uy * uy;
  const vv = vx * vx + vy * vy;
  if (uu === 0 || vv === 0) return null;
  const px = point.x - o.x;
  const py = point.y - o.y;
  return {
    x: ((px * ux + py * uy) / uu) * node.frame.width,
    y: ((px * vx + py * vy) / vv) * node.frame.height,
  };
}

function inside(document: DocumentV7, node: NodeV7, point: PagePoint): boolean {
  const local = localPoint(document, node, point);
  if (local === null) return false;
  const { width, height } = node.frame;
  if (node.type === 'ellipse') {
    const dx = (local.x - width / 2) / (width / 2);
    const dy = (local.y - height / 2) / (height / 2);
    return dx * dx + dy * dy <= 1;
  }
  return local.x >= 0 && local.y >= 0 && local.x <= width && local.y <= height;
}

/** A node's fill colour when mostly opaque (its and its ancestors' opacity included), else null. */
function opaqueFill(node: NodeV7, inherited: number): Color | null {
  if (!('fill' in node) || node.fill === null) return null;
  const color = paintColor(node.fill);
  return color.a * node.opacity * inherited >= 0.5 ? color : null;
}

/** The frontmost backdrop fill under `point` among `ids` (back to front), or null. */
function backdropIn(
  document: DocumentV7,
  ids: readonly string[],
  point: PagePoint,
  inherited: number,
): Color | null {
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const node = document.nodes[ids[i]!];
    if (node === undefined || node.visible === false) continue;
    if (node.type === 'group') {
      const found = backdropIn(document, node.children, point, inherited * node.opacity);
      if (found !== null) return found;
    } else if (node.type === 'frame') {
      if (!inside(document, node, point)) continue;
      const inner = backdropIn(document, node.children, point, inherited * node.opacity);
      return inner ?? opaqueFill(node, inherited);
    } else if (node.type === 'rectangle' || node.type === 'ellipse') {
      if (!inside(document, node, point)) continue;
      const fill = opaqueFill(node, inherited);
      if (fill !== null) return fill;
    }
  }
  return null;
}

/** The colour under the page point `point` of page `page`: a backdrop fill or the canvas. */
export function backdropColor(document: DocumentV7, page: string, point: PagePoint): Color {
  const children = document.pages.find((p) => p.id === page)?.children ?? [];
  return backdropIn(document, children, point, 1) ?? CANVAS_BACKDROP;
}

/** WCAG relative luminance of a colour's sRGB channels. */
export function luminance({ r, g, b }: Color): number {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

const same = (a: Color, b: Color) => a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

/**
 * The text tool style for a press at `point`: its colour switched to white over a dark backdrop
 * or black over a light one (the higher contrast: luminance below 0.179 counts as dark), or
 * null when nothing changes (already that colour, or a colour other than the two automatic ones).
 */
export function readableTextStyle(
  document: DocumentV7,
  page: string,
  point: PagePoint,
  style: TextStyle,
): TextStyle | null {
  if (!same(style.color, BLACK) && !same(style.color, WHITE)) return null;
  const color = luminance(backdropColor(document, page, point)) < 0.179 ? WHITE : BLACK;
  return same(color, style.color) ? null : { ...style, color };
}

/**
 * The text tool style over the empty (black) canvas, for the studio's start: white when the
 * style is the default black, else null (any other colour is kept). A plain-text paste outside
 * text edit mode uses the tool style, so it reads on the canvas too.
 */
export function canvasTextStyle(style: TextStyle): TextStyle | null {
  return same(style.color, BLACK) ? { ...style, color: WHITE } : null;
}

/**
 * The caret colour for a caret at the page point `point` (slice 7): white over a dark backdrop,
 * black over a light one, so the caret shows on the black canvas.
 */
export function caretColour(document: DocumentV7, page: string, point: PagePoint): string {
  return luminance(backdropColor(document, page, point)) < 0.179 ? '#ffffff' : '#000000';
}

/**
 * V-25 slice 8: the stroke colour of a new line or path whose first point is `point`: white over
 * a dark backdrop, black over a light one, so a pen path drawn on the black canvas shows (the
 * editor's default stroke is black).
 */
export function readableStrokeColor(document: DocumentV7, page: string, point: PagePoint): Color {
  return luminance(backdropColor(document, page, point)) < 0.179 ? WHITE : BLACK;
}
