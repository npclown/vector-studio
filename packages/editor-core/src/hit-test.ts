import type { DocumentV1, Frame, NodeV1, PathData } from '@vector-studio/model';
import type { PagePoint } from './types.js';

// P5 hit testing (plan section 4.4): fill regions and outlines, with outlines flattened by
// editor-core itself at 0.25 / zoom page units. Exact geometry-port hit testing is deferred.

/** Frame-local path geometry for a custom node (its extension's `toScene`), or null. */
export type CustomGeometry = (node: NodeV1) => PathData | null;

type Polyline = { points: PagePoint[]; closed: boolean };

/** Holds the 0.25 / zoom bound for curves up to about 10^5 / zoom page units across. */
const MAX_SEGMENTS_PER_CUBIC = 4096;

function cubicSegments(
  p0: PagePoint,
  p1: PagePoint,
  p2: PagePoint,
  p3: PagePoint,
  tolerance: number,
) {
  // The control-polygon second difference bounds the deviation of the chords (Wang's formula).
  const ddx = Math.max(Math.abs(p0.x - 2 * p1.x + p2.x), Math.abs(p1.x - 2 * p2.x + p3.x));
  const ddy = Math.max(Math.abs(p0.y - 2 * p1.y + p2.y), Math.abs(p1.y - 2 * p2.y + p3.y));
  const n = Math.ceil(Math.sqrt((3 * Math.hypot(ddx, ddy)) / (4 * tolerance)));
  return Math.min(MAX_SEGMENTS_PER_CUBIC, Math.max(1, Number.isFinite(n) ? n : 1));
}

/**
 * Flattens path data into page-space polylines for a frame: `unit` data is in the frame's unit
 * box (path nodes), other data in frame-local page units (custom-node geometry).
 */
export function flatten(
  path: PathData,
  frame: Frame,
  unit: boolean,
  tolerance: number,
): Polyline[] {
  const sx = unit ? frame.width : 1;
  const sy = unit ? frame.height : 1;
  const at = (index: number): PagePoint => ({
    x: frame.x + path.points[index]! * sx,
    y: frame.y + path.points[index + 1]! * sy,
  });
  const lines: Polyline[] = [];
  let current: Polyline | null = null;
  let cursor = 0;
  for (const verb of path.verbs) {
    if (verb === 'move') {
      current = { points: [at(cursor)], closed: false };
      lines.push(current);
      cursor += 2;
    } else if (verb === 'line' && current !== null) {
      current.points.push(at(cursor));
      cursor += 2;
    } else if (verb === 'cubic' && current !== null) {
      const p0 = current.points[current.points.length - 1]!;
      const [p1, p2, p3] = [at(cursor), at(cursor + 2), at(cursor + 4)];
      const n = cubicSegments(p0, p1, p2, p3, tolerance);
      for (let i = 1; i <= n; i += 1) {
        const t = i / n;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const d = t * t * t;
        current.points.push({
          x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
          y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
        });
      }
      cursor += 6;
    } else if (verb === 'close' && current !== null) {
      current.closed = true;
      current = null;
    }
  }
  return lines;
}

function distanceToSegment(p: PagePoint, a: PagePoint, b: PagePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function nearOutline(p: PagePoint, lines: readonly Polyline[], radius: number): boolean {
  for (const { points, closed } of lines) {
    if (points.length === 1 && Math.hypot(p.x - points[0]!.x, p.y - points[0]!.y) <= radius) {
      return true;
    }
    const count = closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i += 1) {
      if (distanceToSegment(p, points[i]!, points[(i + 1) % points.length]!) <= radius) return true;
    }
  }
  return false;
}

/** Winding number over every subpath, each closed implicitly, as a fill does. */
function insideFill(p: PagePoint, lines: readonly Polyline[], evenOdd: boolean): boolean {
  let winding = 0;
  for (const { points } of lines) {
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      if (a.y <= p.y) {
        if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) winding += 1;
      } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) {
        winding -= 1;
      }
    }
  }
  return evenOdd ? winding % 2 !== 0 : winding !== 0;
}

function rectangleOutline(frame: Frame): Polyline {
  const { x, y, width, height } = frame;
  return {
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    closed: true,
  };
}

/** Whether `point` hits `node` at `zoom` (plan section 4.4). */
export function hitsNode(
  node: NodeV1,
  point: PagePoint,
  zoom: number,
  custom: CustomGeometry,
): boolean {
  if (!node.visible) return false;
  const radius = Math.max((node.stroke?.width ?? 0) / 2, 4 / zoom);
  if (node.type === 'rectangle') {
    const { x, y, width, height } = node.frame;
    if (
      node.fill !== null &&
      point.x >= x &&
      point.x <= x + width &&
      point.y >= y &&
      point.y <= y + height
    ) {
      return true;
    }
    return nearOutline(point, [rectangleOutline(node.frame)], radius);
  }
  const geometry = node.type === 'path' ? node.path : custom(node);
  if (geometry === null) return false;
  const lines = flatten(geometry, node.frame, node.type === 'path', 0.25 / zoom);
  if (node.fill !== null && insideFill(point, lines, geometry.fillRule === 'evenodd')) return true;
  return nearOutline(point, lines, radius);
}

/** The topmost visible node hit at `point`, in reverse paint order, or null. */
export function topmostHit(
  document: DocumentV1,
  point: PagePoint,
  zoom: number,
  custom: CustomGeometry,
): string | null {
  const children = document.pages[0].children;
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const node = document.nodes[children[i]!];
    if (node !== undefined && hitsNode(node, point, zoom, custom)) return node.id;
  }
  return null;
}

/** Visible nodes, in paint order, whose frame intersects the rectangle (P5-Q5). */
export function marqueeHits(document: DocumentV1, box: Frame): string[] {
  return document.pages[0].children.filter((id) => {
    const node = document.nodes[id];
    if (node === undefined || !node.visible) return false;
    const { frame } = node;
    return (
      frame.x <= box.x + box.width &&
      box.x <= frame.x + frame.width &&
      frame.y <= box.y + box.height &&
      box.y <= frame.y + frame.height
    );
  });
}

/** The bounding box of the frames of `ids`, or null when there are none. */
export function boundsOf(document: DocumentV1, ids: readonly string[]): Frame | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of ids) {
    const frame = document.nodes[id]?.frame;
    if (frame === undefined) continue;
    minX = Math.min(minX, frame.x);
    minY = Math.min(minY, frame.y);
    maxX = Math.max(maxX, frame.x + frame.width);
    maxY = Math.max(maxY, frame.y + frame.height);
  }
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
