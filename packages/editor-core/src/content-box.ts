import type { Frame, NodeV6, PathData } from '@vector-studio/model';
import { apply, boundsOfPoints, corners, localTransform } from './geometry.js';
import type { PagePoint } from './types.js';

// V-26: the box the select tool shows and works with for a node. A path's frame is the bounding
// box of its points, Bézier handles included, so a curve whose handles reach past it got a box
// larger than the drawn curve. The content box of a path is the box of the curve itself (its
// anchors and the extrema of each cubic) in the node's own axes; every other node's content box
// is its whole frame. The document model is unchanged: the frame still holds the handles, and
// the content box sits inside it.

/** The tight unit-box bounds `[minX, minY, maxX, maxY]` of each path's curve, by data object. */
const unitBounds = new WeakMap<PathData, readonly [number, number, number, number]>();

/** The parameters in (0, 1) where `at² + bt + c` is 0 (the cubic's derivative per axis). */
function roots(a: number, b: number, c: number): number[] {
  const out: number[] = [];
  const push = (t: number) => {
    if (t > 0 && t < 1) out.push(t);
  };
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) push(-c / b);
    return out;
  }
  const d = b * b - 4 * a * c;
  if (d < 0) return out;
  const s = Math.sqrt(d);
  push((-b + s) / (2 * a));
  push((-b - s) / (2 * a));
  return out;
}

/** The cubic Bézier coordinate at `t` for one axis. */
function cubicCoordinate(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** One axis's range of a cubic: its end points and the extrema between them. */
function cubicRange(p0: number, p1: number, p2: number, p3: number): [number, number] {
  let min = Math.min(p0, p3);
  let max = Math.max(p0, p3);
  // Handles inside the end points' range keep the curve inside it (convex hull).
  if (p1 >= min && p1 <= max && p2 >= min && p2 <= max) return [min, max];
  const a = 3 * (-p0 + 3 * p1 - 3 * p2 + p3);
  const b = 6 * (p0 - 2 * p1 + p2);
  const c = 3 * (p1 - p0);
  for (const t of roots(a, b, c)) {
    const v = cubicCoordinate(p0, p1, p2, p3, t);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return [min, max];
}

/**
 * The tight bounds of path data's curve in its unit box, `[minX, minY, maxX, maxY]`, clamped to
 * `[0, 1]`, or null for data with no points.
 */
export function pathUnitBounds(path: PathData): readonly [number, number, number, number] | null {
  const cached = unitBounds.get(path);
  if (cached !== undefined) return cached;
  const p = path.points;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (x0: number, x1: number, y0: number, y1: number) => {
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1);
    minY = Math.min(minY, y0);
    maxY = Math.max(maxY, y1);
  };
  let i = 0;
  let cx = 0;
  let cy = 0;
  for (const verb of path.verbs) {
    if (verb === 'move' || verb === 'line') {
      cx = p[i]!;
      cy = p[i + 1]!;
      take(cx, cx, cy, cy);
      i += 2;
    } else if (verb === 'cubic') {
      const [x0, x1] = cubicRange(cx, p[i]!, p[i + 2]!, p[i + 4]!);
      const [y0, y1] = cubicRange(cy, p[i + 1]!, p[i + 3]!, p[i + 5]!);
      take(x0, x1, y0, y1);
      cx = p[i + 4]!;
      cy = p[i + 5]!;
      i += 6;
    }
  }
  if (minX === Infinity) return null;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const bounds = [clamp(minX), clamp(minY), clamp(maxX), clamp(maxY)] as const;
  unitBounds.set(path, bounds);
  return bounds;
}

/**
 * A node's content box in its own unrotated axes, relative to its frame's top-left corner: for
 * a path the box of its curve, for any other node `{ 0, 0, width, height }`.
 */
export function contentBox(node: NodeV6): Frame {
  const { width, height } = node.frame;
  const whole = { x: 0, y: 0, width, height };
  if (node.type !== 'path') return whole;
  const b = pathUnitBounds(node.path);
  if (b === null) return whole;
  const [x0, y0, x1, y1] = b;
  if (x0 === 0 && y0 === 0 && x1 === 1 && y1 === 1) return whole;
  const x = x0 * width;
  const y = y0 * height;
  return { x, y, width: x1 * width - x, height: y1 * height - y };
}

/** Whether a node's content box is smaller than its frame. */
export function hasInnerContentBox(node: NodeV6): boolean {
  if (node.type !== 'path') return false;
  const box = contentBox(node);
  return (
    box.x !== 0 || box.y !== 0 || box.width !== node.frame.width || box.height !== node.frame.height
  );
}

/** The four corners of a node's rotated content box in its parent's space. */
export function contentCorners(node: NodeV6): PagePoint[] {
  if (!hasInnerContentBox(node)) return corners(node.frame, node.rotation);
  const box = contentBox(node);
  const left = box.x;
  const top = box.y;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  if (node.rotation === 0) {
    const { x, y } = node.frame;
    return [
      { x: x + left, y: y + top },
      { x: x + right, y: y + top },
      { x: x + right, y: y + bottom },
      { x: x + left, y: y + bottom },
    ];
  }
  const m = localTransform(node.frame, node.rotation);
  return [
    apply(m, left, top),
    apply(m, right, top),
    apply(m, right, bottom),
    apply(m, left, bottom),
  ];
}

/** The page-aligned bounds of a node's rotated content box in its parent's space. */
export function contentBounds(node: NodeV6): Frame {
  return boundsOfPoints(contentCorners(node))!;
}
