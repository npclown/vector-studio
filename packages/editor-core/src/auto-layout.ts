import {
  normalizeRotation,
  type AutoLayout,
  type Frame,
  type LayoutFields,
  type LayoutSizing,
  type NodeV8,
} from '@vector-studio/model';
import { apply, localTransform, rotate, rotatedBounds } from './geometry.js';
import { mapNode, refitGroup, resizeContainer, type WritableTree } from './resize.js';
import { frameRule, refitFrame, type TextLayouter } from './text.js';
import { isContainer, isFrameLike, isGroup } from './tree.js';

// The layout of one auto-layout frame (V-34 contract, section 3) and the settle step of an
// inline fill resize (section 3.3). Every function works on a writable tree, such as the edit
// draft, and leaves nodes for the draft's `finish` to validate.

/** A node as V-34 reads it: the optional fields of the unreleased v8. */
type LayoutNode = NodeV8 & LayoutFields;

export const FIXED_SIZING: LayoutSizing = Object.freeze({ horizontal: 'fixed', vertical: 'fixed' });

/** The smallest size a fill share gives (section 3.2), so a child can always grow back. */
export const MIN_FILL_SIZE = 1;

/** The auto layout of `node`, or null (only a frame carries one, V34-S1). */
export function autoLayoutOf(node: NodeV8 | undefined): AutoLayout | null {
  if (node?.type !== 'frame') return null;
  return (node as LayoutNode).autoLayout ?? null;
}

export function layoutSizingOf(node: NodeV8): LayoutSizing {
  return (node as LayoutNode).layoutSizing ?? FIXED_SIZING;
}

/** The text layouter is required and absent (section 3.3): the edit fails. */
export class NoTextLayoutError extends Error {
  constructor() {
    super('editor.no-text-layout');
  }
}

export type LayoutEnv = Readonly<{
  tree: WritableTree;
  /** The draft's text layouter, for `autoHeight` text resized by a fill share. */
  measure: TextLayouter | undefined;
  /** Candidates floating on a gesture update (section 4.1): not participants. */
  floating?: ReadonlySet<string>;
}>;

type Axis = 'horizontal' | 'vertical';

function sizeOn(frame: Frame, axis: Axis): number {
  return axis === 'horizontal' ? frame.width : frame.height;
}

/** A participant's box (section 3.1): its frame at rotation 0, else its rotated bounds. */
function boxOf(node: NodeV8): Frame {
  return node.rotation === 0 ? node.frame : rotatedBounds(node);
}

/** Rotation 0 or π: the node's frame axes are the parent's (section 3.1). */
function isAxisAligned(node: NodeV8): boolean {
  const r = normalizeRotation(node.rotation);
  return r === 0 || r === Math.PI;
}

/** Whether `child` takes a fill share on `axis` (sections 3.1 and 3.3). */
export function takesFill(child: NodeV8, axis: Axis): boolean {
  if (layoutSizingOf(child)[axis] !== 'fill') return false;
  if (isGroup(child) || !isAxisAligned(child)) return false;
  if (
    (child.type === 'path' || child.type === 'line' || child.type === 'custom') &&
    sizeOn(child.frame, axis) === 0
  ) {
    return false;
  }
  return true;
}

/** The participants of `frame` (section 3.1): visible children not floating, in order. */
export function participantsOf(env: LayoutEnv, frame: NodeV8): NodeV8[] {
  if (!isContainer(frame)) return [];
  const out: NodeV8[] = [];
  for (const id of frame.children) {
    const child = env.tree.node(id);
    if (child === undefined || !child.visible || env.floating?.has(id) === true) continue;
    out.push(child);
  }
  return out;
}

/**
 * The frame of a node of `frame` and `rotation` resized to `width` × `height` with its own
 * top-left corner fixed in its parent's space (section 3.2).
 */
export function anchoredResize(
  frame: Frame,
  rotation: number,
  width: number,
  height: number,
): Frame {
  if (rotation === 0) return { x: frame.x, y: frame.y, width, height };
  const corner = apply(localTransform(frame, rotation), 0, 0);
  const half = rotate(rotation, width / 2, height / 2);
  return { x: corner.x + half.x - width / 2, y: corner.y + half.y - height / 2, width, height };
}

/**
 * A tree that records the text nodes a resize marks for a refit, so the settle step measures
 * them (section 3.3); every other call goes to `tree`.
 */
function recordingTree(tree: WritableTree, marks: Set<string>): WritableTree {
  return {
    node: (id) => tree.node(id),
    page: (id) => tree.page(id),
    set: (node) => tree.set(node),
    markTextRefit: (id) => marks.add(id),
    layoutAware: true,
  };
}

/** Measures an auto text node again with the layouter (section 3.3). */
function measureText(env: LayoutEnv, id: string): void {
  const node = env.tree.node(id);
  if (node?.type !== 'text' || node.sizing === 'fixed') return;
  if (env.measure === undefined) throw new NoTextLayoutError();
  const frame = refitFrame(node, env.measure(node));
  if (frame !== node.frame) env.tree.set({ ...node, frame });
}

/**
 * Resizes a fill child to `size` on `axis` with its top-left corner kept, then settles its
 * subtree (section 3.3).
 */
function resizeFill(env: LayoutEnv, id: string, axis: Axis, size: number): void {
  const child = env.tree.node(id)!;
  const before = child.frame;
  // 4.2: an autoWidth text under horizontal fill turns autoHeight even when its width is the share.
  const autoWidthText =
    child.type === 'text' && axis === 'horizontal' && child.sizing === 'autoWidth';
  if (sizeOn(before, axis) === size && !autoWidthText) return;
  const frame: Frame =
    axis === 'horizontal' ? { ...before, width: size } : { ...before, height: size };
  const marks = new Set<string>();
  const tree = recordingTree(env.tree, marks);
  if (child.type === 'text') {
    const rule = frameRule(child, frame);
    // 4.2: horizontal fill on autoWidth text makes it autoHeight, whatever the width did.
    const sizing =
      axis === 'horizontal' && child.sizing === 'autoWidth' ? 'autoHeight' : rule.sizing;
    env.tree.set({ ...child, frame, sizing });
    if (sizing === 'autoHeight') marks.add(id);
  } else if (child.type === 'path' || child.type === 'line' || child.type === 'custom') {
    const sx = axis === 'horizontal' ? size / before.width : 1;
    const sy = axis === 'vertical' ? size / before.height : 1;
    mapNode(tree, id, { sx, sy, ox: before.x, oy: before.y, tx: before.x, ty: before.y, psi: 0 });
  } else {
    env.tree.set({ ...child, frame });
    if (isContainer(child)) resizeContainer(tree, id, before);
  }
  settle(env, id, marks);
}

/**
 * Settles the subtree of `id` after an inline resize (section 3.3): one walk, deepest node
 * first; a marked auto text is measured again, an auto-layout frame lays out, a group refits.
 */
function settle(env: LayoutEnv, id: string, marks: ReadonlySet<string>): void {
  const node = env.tree.node(id);
  if (node === undefined) return;
  if (isContainer(node)) for (const child of node.children) settle(env, child, marks);
  if (marks.has(id)) measureText(env, id);
  const current = env.tree.node(id)!;
  if (autoLayoutOf(current) !== null) layoutFrame(env, id);
  else if (isGroup(current)) refitGroup(env.tree, id);
}

/**
 * Lays out the auto-layout frame `id` (section 3.2): cross fill, main hug, main fill, cross
 * hug, positions. Returns whether the frame's own frame changed.
 */
export function layoutFrame(env: LayoutEnv, id: string): boolean {
  const start = env.tree.node(id);
  const layout = autoLayoutOf(start);
  if (start === undefined || layout === null) return false;
  const mainAxis: Axis = layout.direction;
  const crossAxis: Axis = mainAxis === 'horizontal' ? 'vertical' : 'horizontal';
  const [top, right, bottom, left] = layout.padding;
  const padMain = mainAxis === 'horizontal' ? left : top;
  const padMainEnd = mainAxis === 'horizontal' ? right : bottom;
  const padCross = mainAxis === 'horizontal' ? top : left;
  const padCrossEnd = mainAxis === 'horizontal' ? bottom : right;
  const pm = padMain + padMainEnd;
  const pc = padCross + padCrossEnd;
  const sizing = layoutSizingOf(start);
  const mainHug = sizing[mainAxis] === 'hug';
  const crossHug = sizing[crossAxis] === 'hug';
  let main = sizeOn(start.frame, mainAxis);
  let cross = sizeOn(start.frame, crossAxis);
  const gap = layout.gap;

  // 1. Cross fill.
  if (!crossHug) {
    for (const child of participantsOf(env, start)) {
      if (takesFill(child, crossAxis)) {
        resizeFill(env, child.id, crossAxis, Math.max(MIN_FILL_SIZE, cross - pc));
      }
    }
  }
  const boxMain = (node: NodeV8) => sizeOn(boxOf(node), mainAxis);
  const boxCross = (node: NodeV8) => sizeOn(boxOf(node), crossAxis);
  let parts = participantsOf(env, env.tree.node(id)!);
  const n = parts.length;
  const gaps = gap * Math.max(0, n - 1);
  // 2. Main hug, or 3. main fill.
  if (mainHug) {
    if (n > 0) main = Math.max(0, pm + parts.reduce((sum, c) => sum + boxMain(c), 0) + gaps);
  } else {
    const fillers = parts.filter((c) => takesFill(c, mainAxis));
    if (fillers.length > 0) {
      const filling = new Set(fillers);
      const fixed = parts.filter((c) => !filling.has(c));
      const free = main - pm - fixed.reduce((sum, c) => sum + boxMain(c), 0) - gaps;
      const share = Math.max(MIN_FILL_SIZE, free / fillers.length);
      for (const child of fillers) resizeFill(env, child.id, mainAxis, share);
      parts = participantsOf(env, env.tree.node(id)!);
    }
  }
  // 4. Cross hug.
  if (crossHug && n > 0) cross = pc + parts.reduce((max, c) => Math.max(max, boxCross(c)), 0);

  // The frame's own size, its top-left corner fixed.
  const current = env.tree.node(id)!;
  const width = mainAxis === 'horizontal' ? main : cross;
  const height = mainAxis === 'horizontal' ? cross : main;
  let changed = false;
  if (width !== current.frame.width || height !== current.frame.height) {
    env.tree.set({
      ...current,
      frame: anchoredResize(current.frame, current.rotation, width, height),
    });
    changed = true;
  }

  // 5. Positions.
  const sizes = parts.map(boxMain);
  const total = sizes.reduce((sum, s) => sum + s, 0);
  const hasMainFill = !mainHug && parts.some((c) => takesFill(c, mainAxis));
  let step = gap;
  let offset = padMain;
  const free = main - pm - total - gaps;
  if (layout.primaryAlign === 'center') offset += free / 2;
  else if (layout.primaryAlign === 'end') offset += free;
  else if (layout.primaryAlign === 'spaceBetween' && n >= 2 && !hasMainFill) {
    step = (main - pm - total) / (n - 1);
  }
  for (const [index, child] of parts.entries()) {
    const box = boxOf(child);
    const c = sizeOn(box, crossAxis);
    let crossAt = padCross;
    if (layout.counterAlign === 'center') crossAt = padCross + (cross - pc - c) / 2;
    else if (layout.counterAlign === 'end') crossAt = cross - padCrossEnd - c;
    const x = mainAxis === 'horizontal' ? offset : crossAt;
    const y = mainAxis === 'horizontal' ? crossAt : offset;
    const dx = x - box.x;
    const dy = y - box.y;
    if (dx !== 0 || dy !== 0) {
      const node = env.tree.node(child.id)!;
      env.tree.set({
        ...node,
        frame: { ...node.frame, x: node.frame.x + dx, y: node.frame.y + dy },
      });
    }
    offset += sizes[index]! + step;
  }
  return changed;
}

/** Whether a frame-like node's resize applies constraints (section 4.3, Constraints). */
export function skipsConstraints(tree: WritableTree, node: NodeV8): boolean {
  return tree.layoutAware === true && isFrameLike(node) && autoLayoutOf(node) !== null;
}

/** The rounded mean, never negative (section 5's inference). */
function roundedNonNegative(value: number): number {
  const r = Math.round(value);
  return r > 0 ? r : 0;
}

/**
 * `addAutoLayout`'s inference (V-34 section 5, rule 1) from participant boxes in the frame's
 * space: the direction, the order (indices into `boxes`), the gap and the padding (0 when
 * `wrap`, or with no boxes).
 */
export function inferAutoLayout(
  boxes: readonly Frame[],
  width: number,
  height: number,
  wrap: boolean,
): Readonly<{ layout: AutoLayout; order: number[] }> {
  const n = boxes.length;
  let direction: AutoLayout['direction'] = 'horizontal';
  if (n > 0) {
    const cx = boxes.map((b) => b.x + b.width / 2);
    const cy = boxes.map((b) => b.y + b.height / 2);
    const spreadX = Math.max(...cx) - Math.min(...cx);
    const spreadY = Math.max(...cy) - Math.min(...cy);
    direction = spreadX > spreadY ? 'horizontal' : 'vertical';
  }
  const horizontal = direction === 'horizontal';
  const start = (b: Frame) => (horizontal ? b.x : b.y);
  const size = (b: Frame) => (horizontal ? b.width : b.height);
  const order = boxes.map((_, i) => i).sort((a, b) => start(boxes[a]!) - start(boxes[b]!) || a - b);
  let gap = 0;
  if (n >= 2) {
    let sum = 0;
    for (let i = 1; i < n; i += 1) {
      const prev = boxes[order[i - 1]!]!;
      sum += start(boxes[order[i]!]!) - (start(prev) + size(prev));
    }
    gap = roundedNonNegative(sum / (n - 1));
  }
  let padding: [number, number, number, number] = [0, 0, 0, 0];
  if (n > 0 && !wrap) {
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));
    padding = [
      roundedNonNegative(minY),
      roundedNonNegative(width - maxX),
      roundedNonNegative(height - maxY),
      roundedNonNegative(minX),
    ];
  }
  return {
    layout: { direction, gap, padding, primaryAlign: 'start', counterAlign: 'start' },
    order,
  };
}

/** Hug on both axes, keeping an axis that is already `fill` (section 5, rule 1). */
export function hugSizing(node: NodeV8): LayoutSizing {
  const sizing = layoutSizingOf(node);
  return {
    horizontal: sizing.horizontal === 'fill' ? 'fill' : 'hug',
    vertical: sizing.vertical === 'fill' ? 'fill' : 'hug',
  };
}

/** `sizing` with hug axes made fixed (section 4.2, removing auto layout). */
export function unhug(sizing: LayoutSizing): LayoutSizing {
  return {
    horizontal: sizing.horizontal === 'hug' ? 'fixed' : sizing.horizontal,
    vertical: sizing.vertical === 'hug' ? 'fixed' : sizing.vertical,
  };
}
