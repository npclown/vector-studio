import type { Frame, NodeV6, PathData } from '@vector-studio/model';
import { apply, boundsOfPoints, corners, localTransform } from './geometry.js';
import type { PagePoint } from './types.js';

// V-26: the box the select tool shows and works with for a node. A path's frame is the bounding
// box of its points, Bézier handles included, so a curve whose handles reach past it got a box
// larger than the drawn curve. The content box of a path is the box of the curve itself (its
// anchors and the extrema of each cubic) in the node's own axes; a group's is the bounds of
// its children's; every other node's content box is its whole frame. The document model is
// unchanged: the frame still holds the handles, and the content box sits inside it.

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

/** Reads a node of the same document by ID (a group's children). */
export type NodeLookup = (id: string) => NodeV6 | undefined;

/** A path's curve box in its own axes, or null when the curve fills its frame. */
function pathBox(node: Extract<NodeV6, { type: 'path' }>): Frame | null {
  // Cached by node object, so a group's cache sees the same box object while the path is unchanged.
  const cached = pathBoxes.get(node);
  if (cached !== undefined) return cached;
  let box: Frame | null = null;
  const b = pathUnitBounds(node.path);
  if (b !== null && !(b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 1)) {
    const [x0, y0, x1, y1] = b;
    const { width, height } = node.frame;
    const x = x0 * width;
    const y = y0 * height;
    box = { x, y, width: x1 * width - x, height: y1 * height - y };
  }
  pathBoxes.set(node, box);
  return box;
}

const pathBoxes = new WeakMap<NodeV6, Frame | null>();

/** A group's computed box with the child nodes and child boxes it was computed from. */
type GroupEntry = {
  children: readonly (NodeV6 | undefined)[];
  boxes: readonly (Frame | null)[];
  box: Frame | null;
};

/**
 * Groups' computed boxes by node object. Nodes are frozen, but a descendant can change while the
 * group object stays, so an entry holds only while its child objects and their own (cached, so
 * identical) boxes are the same: a lookup costs one pass over the subtree, with no repeated work.
 */
const groupBoxes = new WeakMap<NodeV6, GroupEntry>();

/** A node's corners in its parent's space for its content box `box` (null: its whole frame). */
function cornersOf(node: NodeV6, box: Frame | null): PagePoint[] {
  if (box === null) return corners(node.frame, node.rotation);
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

/**
 * A node's content box when it differs from its frame, else null: a path whose curve is inside
 * its frame; a group or mask group whose children's content boxes (through groups only; a frame,
 * symbol or instance clips or owns its box) bound a box other than its frame.
 */
function innerBox(node: NodeV6, lookup: NodeLookup): Frame | null {
  if (node.type === 'path') return pathBox(node);
  if (node.type !== 'group' && node.type !== 'maskGroup') return null;
  const children = node.children.map(lookup);
  const boxes = children.map((child) => (child === undefined ? null : innerBox(child, lookup)));
  const cached = groupBoxes.get(node);
  if (
    cached !== undefined &&
    cached.children.length === children.length &&
    children.every((child, i) => child === cached.children[i] && boxes[i] === cached.boxes[i])
  ) {
    return cached.box;
  }
  let box: Frame | null = null;
  if (boxes.some((b) => b !== null)) {
    const points: PagePoint[] = [];
    children.forEach((child, i) => {
      if (child !== undefined) points.push(...cornersOf(child, boxes[i] ?? null));
    });
    const b = boundsOfPoints(points);
    const { width, height } = node.frame;
    if (b !== null && (b.x !== 0 || b.y !== 0 || b.width !== width || b.height !== height)) {
      box = b;
    }
  }
  groupBoxes.set(node, { children, boxes, box });
  return box;
}

/**
 * Whether a node's content box differs from its frame (`innerBox`). Every other node keeps its
 * frame, bit for bit.
 */
export function hasInnerContentBox(node: NodeV6, lookup: NodeLookup): boolean {
  return innerBox(node, lookup) !== null;
}

/**
 * A node's content box in its own unrotated axes, relative to its frame's top-left corner: for
 * a path the box of its curve; for a group or mask group, the bounds of its children's content
 * boxes in its own space (V-26; the group's frame is still fitted to its children's frames); for
 * any other node `{ 0, 0, width, height }`.
 */
export function contentBox(node: NodeV6, lookup: NodeLookup): Frame {
  return (
    innerBox(node, lookup) ?? { x: 0, y: 0, width: node.frame.width, height: node.frame.height }
  );
}

/** The four corners of a node's rotated content box in its parent's space. */
export function contentCorners(node: NodeV6, lookup: NodeLookup): PagePoint[] {
  return cornersOf(node, innerBox(node, lookup));
}

/** The page-aligned bounds of a node's rotated content box in its parent's space. */
export function contentBounds(node: NodeV6, lookup: NodeLookup): Frame {
  return boundsOfPoints(contentCorners(node, lookup))!;
}
