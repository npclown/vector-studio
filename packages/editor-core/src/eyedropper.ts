import type { Color, DocumentV7, Gradient, NodeV7, Paint } from '@vector-studio/model';
import type { Tool, ToolContext } from './editor.js';
import type { ExpansionCache } from './expansion.js';
import { paintHitAt, type CustomGeometry, type PaintHit } from './hit-test.js';
import type { DocumentCommand, PagePoint, ToolOverlay } from './types.js';

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), E6 and E7: the colour under a
// page point, read from the document's paints, and the eyedropper tool that applies it.

function isGradient(paint: Paint): paint is Gradient {
  return 'stops' in paint;
}

/** E23-K2 spread. */
function spread(t: number, mode: Gradient['spread']): number {
  if (mode === 'pad') return Math.min(1, Math.max(0, t));
  if (mode === 'repeat') return t - Math.floor(t);
  const u = t - 2 * Math.floor(t / 2);
  return 1 - Math.abs(u - 1);
}

/**
 * The colour of `paint` at `unit`, a point of the node's frame unit box (M4-S2): a solid colour
 * as is; a gradient by E23-K1 to K3 (gradient point through the inverse transform, spread, stop
 * lookup interpolated premultiplied, the later stop winning at a shared offset), returned with
 * straight alpha (0 colour where the alpha is 0).
 */
export function paintColorAt(paint: Paint, unit: PagePoint): Color {
  if (!isGradient(paint)) return { r: paint.r, g: paint.g, b: paint.b, a: paint.a };
  const [a, b, c, d, e, f] = paint.transform;
  const det = a * d - b * c;
  let t = 0;
  if (det !== 0 && Number.isFinite(det)) {
    const u = unit.x - e;
    const v = unit.y - f;
    const x = (d * u - c * v) / det;
    const y = (-b * u + a * v) / det;
    t = paint.kind === 'linear' ? x : Math.hypot(x, y);
  }
  const s = spread(t, paint.spread);
  const stops = paint.stops;
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  if (s < first.offset) return { ...first.color };
  if (s >= last.offset) return { ...last.color };
  let i = 0;
  while (i + 1 < stops.length && stops[i + 1]!.offset <= s) i += 1;
  const from = stops[i]!;
  const to = stops[i + 1]!;
  const w = (s - from.offset) / (to.offset - from.offset);
  const alpha = from.color.a + w * (to.color.a - from.color.a);
  const channel = (key: 'r' | 'g' | 'b') => {
    if (alpha <= 0) return 0;
    const p = from.color[key] * from.color.a;
    const q = to.color[key] * to.color.a;
    return Math.min(1, Math.max(0, (p + w * (q - p)) / alpha));
  };
  return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha };
}

/** The paint the hit part shows, or null (a text node's first run colour for its box). */
function hitPaint(hit: PaintHit): Paint | null {
  const node: NodeV7 = hit.node;
  if (node.type === 'text') return hit.part === 'fill' ? (node.runs[0]?.color ?? null) : null;
  if (hit.part === 'stroke')
    return 'stroke' in node && node.stroke !== null ? node.stroke.color : null;
  return 'fill' in node ? node.fill : null;
}

/**
 * E6: the colour under the page point `point` on `page`, or null where nothing is painted. Node
 * and ancestor opacity are not applied (V39-Q5).
 */
export function sampleColor(
  document: DocumentV7,
  page: string,
  point: PagePoint,
  zoom: number,
  custom: CustomGeometry,
  expansions?: ExpansionCache,
): Color | null {
  const hit = paintHitAt(document, page, point, zoom, custom, expansions, (found) => {
    return hitPaint(found) !== null;
  });
  if (hit === null) return null;
  return paintColorAt(hitPaint(hit)!, hit.unit);
}

/** Whether a node takes the picked colour as a fill (E7), else as a stroke colour. */
function takesFill(node: NodeV7): boolean {
  return 'fill' in node;
}

/**
 * The commands that apply `color` to `ids` (E7): `fill` where the node has a fill field (Shift:
 * the stroke colour, a null stroke getting the default), a line's stroke colour, a text node's
 * run colour over its whole text. Groups and instances take nothing. Empty when nothing applies.
 */
export function eyedropperCommands(
  document: DocumentV7,
  ids: readonly string[],
  color: Color,
  stroke: boolean,
): DocumentCommand[] {
  const fills: string[] = [];
  const strokes: string[] = [];
  const commands: DocumentCommand[] = [];
  for (const id of ids) {
    const node = document.nodes[id];
    if (node === undefined) continue;
    if (node.type === 'text') {
      const length = node.runs.reduce((sum, run) => sum + run.text.length, 0);
      commands.push({ type: 'setTextStyle', id, start: 0, end: length, style: { color } });
    } else if (!stroke && takesFill(node)) fills.push(id);
    else if ('stroke' in node) strokes.push(id);
  }
  const list: DocumentCommand[] = [];
  if (fills.length > 0) list.push({ type: 'setStyle', ids: fills, style: { fill: color } });
  if (strokes.length > 0) {
    list.push({ type: 'setStyle', ids: strokes, style: { stroke: { color } } });
  }
  return [...list, ...commands];
}

/**
 * E7: the eyedropper tool. A move updates the overlay; a primary press samples, applies the
 * colour to the selection as one undo step (a gesture `replace`), reports it through `picked`
 * and returns to the select tool. Escape returns to the select tool.
 */
export function createEyedropperTool(
  sample: (point: PagePoint) => Color | null,
  picked: (color: Color) => void,
): Tool {
  let hover: { point: PagePoint; color: Color | null } | null = null;
  const toSelect = (context: ToolContext) => context.execute({ type: 'setTool', tool: 'select' });
  return {
    input(event, context) {
      if (event.kind === 'keydown') {
        if (event.key !== 'Escape') return false;
        toSelect(context);
        return true;
      }
      if (event.kind === 'pointermove') {
        hover = { point: event.point, color: sample(event.point) };
        return true;
      }
      if (event.kind !== 'pointerdown') return false;
      if (event.button !== undefined && event.button !== 0) return false;
      const color = sample(event.point);
      hover = { point: event.point, color };
      if (color === null) return true;
      const document = context.query({ type: 'document' });
      const selection = context.query({ type: 'selection' });
      const commands = eyedropperCommands(document, selection, color, event.modifiers.shift);
      if (commands.length > 0 && context.gesture.begin()) {
        // A text node in an auto size needs the layout port even for a colour; without one its
        // command fails, so the pick is applied again without the text nodes (disclosed, E7).
        let result = context.gesture.replace(commands);
        if (!result.ok) {
          const rest = commands.filter((command) => command.type !== 'setTextStyle');
          if (rest.length > 0 && rest.length < commands.length) {
            result = context.gesture.replace(rest);
          }
        }
        if (result.ok) context.gesture.commit();
        else context.gesture.cancel();
      }
      picked(color);
      toSelect(context);
      return true;
    },
    reset() {
      hover = null;
    },
    overlay(): ToolOverlay | null {
      // Sampled again for each overlay read, so an undo or a camera change keeps it current.
      if (hover === null) return null;
      return { kind: 'eyedropper', point: hover.point, color: sample(hover.point) };
    },
  };
}
