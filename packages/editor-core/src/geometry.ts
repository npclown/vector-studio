import { normalizeRotation, type Frame, type NodeV4 } from '@vector-studio/model';
import type { PagePoint } from './types.js';

// Placement geometry of schema v2 (M1 contract, M1-S1 and section 5): a node's frame is in its
// parent's local space, and its rotation (radians, clockwise on screen) turns it about the frame
// centre. A container's local space has its origin at the container frame's top-left corner.

/** An affine map `x' = a·x + c·y + e`, `y' = b·x + d·y + f` (the renderer's convention). */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** The node-local to parent-local transform; exactly a translation for θ = 0 (section 5). */
export function localTransform(frame: Frame, rotation: number): Matrix {
  if (rotation === 0) return [1, 0, 0, 1, frame.x, frame.y];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const hw = frame.width / 2;
  const hh = frame.height / 2;
  return [
    cos,
    sin,
    -sin,
    cos,
    frame.x + hw - (hw * cos - hh * sin),
    frame.y + hh - (hw * sin + hh * cos),
  ];
}

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** The inverse of a rigid map (rotation and translation), as every placement chain is. */
export function invertRigid(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m;
  return [a, c, b, d, -(a * e + b * f), -(c * e + d * f)];
}

export function apply(m: Matrix, x: number, y: number): PagePoint {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function isTranslation(m: Matrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1;
}

/** Rotates `(x, y)` by `theta` about the origin; exact for θ = 0. */
export function rotate(theta: number, x: number, y: number): PagePoint {
  if (theta === 0) return { x, y };
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** The four corners of a node's rotated frame in its parent's space. */
export function corners(frame: Frame, rotation: number): PagePoint[] {
  const { x, y, width, height } = frame;
  if (rotation === 0) {
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  }
  const m = localTransform(frame, rotation);
  return [apply(m, 0, 0), apply(m, width, 0), apply(m, width, height), apply(m, 0, height)];
}

/** Axis-aligned bounds of points, or null for none. */
export function boundsOfPoints(points: readonly PagePoint[]): Frame | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return minX === Infinity ? null : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Bounds of a node's rotated frame in its parent's space. */
export function rotatedBounds(node: Pick<NodeV4, 'frame' | 'rotation'>): Frame {
  return boundsOfPoints(corners(node.frame, node.rotation))!;
}

/**
 * The frame and unit-box points of a path or line whose points are `points` (interleaved, in the
 * parent's space) and whose rotation is `rotation`: the frame is the bounding box of the points in
 * the node's own axes (P5 section 3.1 rules, zero-size axes give unit coordinate 0).
 */
export function fitPoints(points: readonly number[], rotation: number) {
  const own: number[] = [];
  if (rotation === 0) own.push(...points);
  else {
    for (let i = 0; i + 1 < points.length; i += 2) {
      const p = rotate(-rotation, points[i]!, points[i + 1]!);
      own.push(p.x, p.y);
    }
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < own.length; i += 2) {
    minX = Math.min(minX, own[i]!);
    maxX = Math.max(maxX, own[i]!);
    minY = Math.min(minY, own[i + 1]!);
    maxY = Math.max(maxY, own[i + 1]!);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const unit = own.map((value, index) => {
    const size = index % 2 === 0 ? width : height;
    const origin = index % 2 === 0 ? minX : minY;
    const mapped = size === 0 ? 0 : (value - origin) / size;
    return mapped === 0 ? 0 : mapped;
  });
  if (rotation === 0) return { frame: { x: minX, y: minY, width, height }, unit };
  // The box's centre in the node's axes, turned back into the parent's space.
  const centre = rotate(rotation, minX + width / 2, minY + height / 2);
  return {
    frame: { x: centre.x - width / 2, y: centre.y - height / 2, width, height },
    unit,
  };
}

/**
 * A rigid placement change: the frame (same size) and rotation that keep a node with `frame` and
 * `rotation` in place when it moves from a space placed by `from` (rotation `fromRotation`) to
 * one placed by `to` (rotation `toRotation`), both relative to a common space (the page).
 */
export function relocate(
  frame: Frame,
  rotation: number,
  from: Matrix,
  fromRotation: number,
  to: Matrix,
  toRotation: number,
): { frame: Frame; rotation: number } {
  const map = multiply(invertRigid(to), from);
  // The spaces' difference first, so that equal spaces keep the rotation exactly.
  const next = normalizeRotation(rotation + (fromRotation - toRotation));
  if (isTranslation(map)) {
    return { frame: { ...frame, x: frame.x + map[4], y: frame.y + map[5] }, rotation: next };
  }
  const centre = apply(map, frame.x + frame.width / 2, frame.y + frame.height / 2);
  return {
    frame: {
      x: centre.x - frame.width / 2,
      y: centre.y - frame.height / 2,
      width: frame.width,
      height: frame.height,
    },
    rotation: next,
  };
}
