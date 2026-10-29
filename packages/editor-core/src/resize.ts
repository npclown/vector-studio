import { normalizeRotation, type Constraint, type Frame, type NodeV3 } from '@vector-studio/model';
import {
  apply,
  boundsOfPoints,
  corners,
  fitPoints,
  localTransform,
  rotate,
  rotatedBounds,
} from './geometry.js';
import { ancestors, isFrameLike, isGroup, type TreeView } from './tree.js';
import type { PagePoint } from './types.js';

// Resize rules (M1 contract, section 4.4) and the group refit (section 4.2), as functions over a
// tree that can be written. `setFrames` on a container uses them; the tools' rotated handles and
// multi-selection resize (M1-U4) use the same functions.

/** A tree whose nodes can be replaced, such as the edit draft. */
export interface WritableTree extends TreeView {
  set(node: NodeV3): void;
}

/**
 * An axis-aligned scale in a **scale space** whose axes are turned by `psi` against the current
 * space: a point with scale-space coordinates `q` maps to `t + s·(q − o)` per axis. Scales are at
 * least 0.
 */
export type ScaleMap = Readonly<{
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  tx: number;
  ty: number;
  psi: number;
}>;

/** A scale by `(sx, sy)` about `origin` (default the space's origin), in unrotated axes. */
export function scaleAbout(sx: number, sy: number, origin: PagePoint = { x: 0, y: 0 }): ScaleMap {
  return { sx, sy, ox: origin.x, oy: origin.y, tx: origin.x, ty: origin.y, psi: 0 };
}

export function mapPoint(map: ScaleMap, x: number, y: number): PagePoint {
  const q = rotate(-map.psi, x, y);
  const mapped = { x: map.tx + map.sx * (q.x - map.ox), y: map.ty + map.sy * (q.y - map.oy) };
  return rotate(map.psi, mapped.x, mapped.y);
}

/** The same map expressed in the local space of a container placed by `frame` and `rotation`. */
export function conjugate(map: ScaleMap, frame: Frame, rotation: number): ScaleMap {
  const m = localTransform(frame, rotation);
  const delta = rotate(-map.psi, m[4], m[5]);
  return {
    sx: map.sx,
    sy: map.sy,
    ox: map.ox - delta.x,
    oy: map.oy - delta.y,
    tx: map.tx - delta.x,
    ty: map.ty - delta.y,
    psi: map.psi - rotation,
  };
}

/**
 * The approximation (MVP-Q3 (a)): the size of a node whose axes make the angle `theta` with the
 * scale space's axes. Exact for θ ∈ {0, π} and θ = ±π/2 (swapped scales); otherwise the width and
 * height scale by `hypot(sx·cos θ, sy·sin θ)` and `hypot(sx·sin θ, sy·cos θ)`.
 */
export function approximateSize(
  width: number,
  height: number,
  theta: number,
  sx: number,
  sy: number,
): { width: number; height: number } {
  const t = normalizeRotation(theta);
  if (t === 0 || t === Math.PI) return { width: width * sx, height: height * sy };
  if (Math.abs(t) === Math.PI / 2) return { width: width * sy, height: height * sx };
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  return {
    width: width * Math.hypot(sx * cos, sy * sin),
    height: height * Math.hypot(sx * sin, sy * cos),
  };
}

/**
 * The frame of a node of `frame` and `rotation` scaled by `(sx, sy)` in its own axes about the
 * point at fractions `(fx, fy)` of its box (the opposite handle), which stays in place in the
 * parent's space (section 4.4, rotated node, single selection).
 */
export function resizeInOwnAxes(
  frame: Frame,
  rotation: number,
  fx: number,
  fy: number,
  sx: number,
  sy: number,
): Frame {
  const width = frame.width * sx;
  const height = frame.height * sy;
  if (rotation === 0) {
    return {
      x: frame.x + fx * frame.width - fx * width,
      y: frame.y + fy * frame.height - fy * height,
      width,
      height,
    };
  }
  const anchor = apply(localTransform(frame, rotation), fx * frame.width, fy * frame.height);
  const offset = rotate(rotation, (fx - 0.5) * width, (fy - 0.5) * height);
  return {
    x: anchor.x - offset.x - width / 2,
    y: anchor.y - offset.y - height / 2,
    width,
    height,
  };
}

function isAligned(theta: number): boolean {
  return theta === 0 || theta === Math.PI || Math.abs(theta) === Math.PI / 2;
}

/** The points of a path or line in its parent's space, interleaved. */
function parentPoints(node: Extract<NodeV3, { type: 'path' | 'line' }>): number[] {
  const unit = node.type === 'path' ? node.path.points : node.points;
  const m = localTransform(node.frame, node.rotation);
  const out: number[] = [];
  for (let i = 0; i + 1 < unit.length; i += 2) {
    const p = apply(m, unit[i]! * node.frame.width, unit[i + 1]! * node.frame.height);
    out.push(p.x, p.y);
  }
  return out;
}

/**
 * Maps one node (in its parent's space) by `map`, top-down through its descendants (section 4.4,
 * group resize): a leaf keeps its rotation, its centre maps exactly and its size follows the
 * approximation; a path or line under a skewing map maps its points exactly and refits its frame
 * in its own axes; a frame or symbol maps like a leaf and its children then follow its
 * constraints (M7 contract, section 1.2); a group keeps its frame and its children are mapped in
 * turn (the caller refits it afterwards).
 * A pure translation moves the node rigidly.
 */
export function mapNode(tree: WritableTree, id: string, map: ScaleMap): void {
  const node = tree.node(id);
  if (node === undefined) return;
  if (map.sx === 1 && map.sy === 1) {
    const d = rotate(map.psi, map.tx - map.ox, map.ty - map.oy);
    if (d.x === 0 && d.y === 0) return;
    const frame =
      map.psi === 0 && node.rotation === 0
        ? {
            ...node.frame,
            x: map.tx + (node.frame.x - map.ox),
            y: map.ty + (node.frame.y - map.oy),
          }
        : { ...node.frame, x: node.frame.x + d.x, y: node.frame.y + d.y };
    tree.set({ ...node, frame });
    return;
  }
  if (isGroup(node)) {
    const inner = conjugate(map, node.frame, node.rotation);
    for (const child of node.children) mapNode(tree, child, inner);
    return;
  }
  const theta = normalizeRotation(node.rotation - map.psi);
  if ((node.type === 'path' || node.type === 'line') && !isAligned(theta) && map.sx !== map.sy) {
    const source = parentPoints(node);
    const mapped: number[] = [];
    for (let i = 0; i + 1 < source.length; i += 2) {
      const p = mapPoint(map, source[i]!, source[i + 1]!);
      mapped.push(p.x, p.y);
    }
    const { frame, unit } = fitPoints(mapped, node.rotation);
    if (node.type === 'path') {
      tree.set({ ...node, frame, path: { ...node.path, points: unit } });
    } else {
      tree.set({ ...node, frame, points: [unit[0]!, unit[1]!, unit[2]!, unit[3]!] });
    }
    return;
  }
  const size = approximateSize(node.frame.width, node.frame.height, theta, map.sx, map.sy);
  let frame: Frame;
  if (map.psi === 0 && node.rotation === 0) {
    frame = {
      x: map.tx + map.sx * (node.frame.x - map.ox),
      y: map.ty + map.sy * (node.frame.y - map.oy),
      ...size,
    };
  } else {
    const centre = mapPoint(
      map,
      node.frame.x + node.frame.width / 2,
      node.frame.y + node.frame.height / 2,
    );
    frame = { x: centre.x - size.width / 2, y: centre.y - size.height / 2, ...size };
  }
  tree.set({ ...node, frame });
  if (isFrameLike(node)) applyConstraints(tree, id, node.frame.width, node.frame.height);
}

/** The per-axis map of one constraint (section 4.4, frame resize). */
function axisMap(
  constraint: Constraint,
  start: number,
  size: number,
  before: number,
  after: number,
): { s: number; o: number; t: number } {
  switch (constraint) {
    case 'start':
      return { s: 1, o: 0, t: 0 };
    case 'end':
      return { s: 1, o: 0, t: after - before };
    case 'center':
      return { s: 1, o: 0, t: (after - before) / 2 };
    case 'startEnd': {
      // Both edge offsets kept; the stretched size clamps at 0, a size-0 child is not scaled.
      const stretched = Math.max(0, size + after - before);
      return { s: size > 0 ? stretched / size : 1, o: start, t: start };
    }
    case 'scale':
      return before === 0 ? { s: 1, o: 0, t: 0 } : { s: after / before, o: 0, t: 0 };
  }
}

/**
 * Applies each child's constraints for a frame or symbol resized from `before` to its current
 * size: per axis on the child's bounds in the frame's space, then the child maps as `mapNode`
 * does.
 */
export function applyConstraints(
  tree: WritableTree,
  frameId: string,
  beforeWidth: number,
  beforeHeight: number,
): void {
  const frame = tree.node(frameId);
  if (!isFrameLike(frame)) return;
  const { width, height } = frame.frame;
  if (width === beforeWidth && height === beforeHeight) return;
  for (const id of frame.children) {
    const child = tree.node(id);
    if (child === undefined) continue;
    const b = rotatedBounds(child);
    const h = axisMap(child.constraints.horizontal, b.x, b.width, beforeWidth, width);
    const v = axisMap(child.constraints.vertical, b.y, b.height, beforeHeight, height);
    mapNode(tree, id, { sx: h.s, sy: v.s, ox: h.o, oy: v.o, tx: h.t, ty: v.t, psi: 0 });
  }
}

/**
 * Applies the resize rules to the descendants of a container whose frame changed from `before`
 * to its current one: a group's children scale with it in its local space (an axis whose old
 * size is 0 is not scaled), a frame's or symbol's children follow their constraints. Position
 * and rotation alone move the subtree rigidly, which needs no change to the children.
 */
export function resizeContainer(tree: WritableTree, id: string, before: Frame): void {
  const node = tree.node(id);
  if (node === undefined) return;
  const { width, height } = node.frame;
  if (width === before.width && height === before.height) return;
  if (isFrameLike(node)) {
    applyConstraints(tree, id, before.width, before.height);
  } else if (isGroup(node)) {
    const sx = before.width === 0 ? 1 : width / before.width;
    const sy = before.height === 0 ? 1 : height / before.height;
    for (const child of node.children) mapNode(tree, child, scaleAbout(sx, sy));
  }
}

/**
 * Maps a node by a map given in page space (section 4.4, several nodes): the map is expressed in
 * the node's parent space through the parent chain, then applied as `mapNode` does.
 */
export function mapNodeInPageSpace(tree: WritableTree, id: string, map: ScaleMap): void {
  let local = map;
  for (const container of ancestors(tree, id).reverse()) {
    local = conjugate(local, container.frame, container.rotation);
  }
  mapNode(tree, id, local);
}

/**
 * Refits a group or mask group to its children (section 4.2): the new frame is the bounds of the
 * children's rotated frames in its local space, placed so that no descendant moves on the page,
 * and the children shift by the bounds' origin. Returns whether anything changed.
 */
export function refitGroup(tree: WritableTree, id: string): boolean {
  const group = tree.node(id);
  if (!isGroup(group)) return false;
  const children = group.children.map((child) => tree.node(child)!);
  const b = boundsOfPoints(children.flatMap((child) => corners(child.frame, child.rotation)));
  if (b === null) return false;
  const { x, y, width, height } = group.frame;
  if (b.x === 0 && b.y === 0 && b.width === width && b.height === height) return false;
  let origin: PagePoint;
  if (group.rotation === 0) origin = { x: x + b.x, y: y + b.y };
  else {
    // p + c − R·c + R·(bx, by) + R·c' − c', with c the old and c' the new half size.
    const v = rotate(
      group.rotation,
      b.x + b.width / 2 - width / 2,
      b.y + b.height / 2 - height / 2,
    );
    origin = { x: x + width / 2 - b.width / 2 + v.x, y: y + height / 2 - b.height / 2 + v.y };
  }
  tree.set({ ...group, frame: { ...origin, width: b.width, height: b.height } });
  if (b.x !== 0 || b.y !== 0) {
    for (const child of children) {
      tree.set({
        ...child,
        frame: { ...child.frame, x: child.frame.x - b.x, y: child.frame.y - b.y },
      });
    }
  }
  return true;
}
