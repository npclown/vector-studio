import type { DocumentV5, Frame, NodeV5, PathStroke } from '@vector-studio/model';
import { apply, boundsOfPoints, localTransform } from './geometry.js';
import type { PagePoint } from './types.js';

// M7 contract, section 5.1 (M7-U6 hands-on check, 2026-10-30): the visual bounds of a node in its
// parent's space, which a `createSymbol` wrap takes as the new source's frame so that its clip
// does not cut strokes or arrowheads off. They are conservative for the geometric stroke (the
// renderer's anti-aliasing fringe, about half a device pixel past an edge, is not included) and
// never smaller than the node's rotated frame (the geometric bounds `groupNodes` keeps).
// editor-core cannot import renderer-core, so the path rule repeats the renderer's stroke
// culling bound (`getPathLocalStrokeBounds`, B2 stroke contract, section 9.7): the points' box
// grown by w/2 · max(1, miterLimit for a miter join, 1.5 for a square cap).

/** 2^24, the renderer's miter-ratio cap of the same bound. */
const MITER_CAP = 2 ** 24;

/** An axis-aligned box in a node's unrotated frame, in its parent's coordinates. */
type Box = { minX: number; minY: number; maxX: number; maxY: number };

function boxOf(frame: Frame): Box {
  return {
    minX: frame.x,
    minY: frame.y,
    maxX: frame.x + frame.width,
    maxY: frame.y + frame.height,
  };
}

function grow(box: Box, by: number): Box {
  return { minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by };
}

function union(a: Box, b: Box): Box {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function include(box: Box, p: PagePoint, by = 0): Box {
  return union(box, { minX: p.x - by, minY: p.y - by, maxX: p.x + by, maxY: p.y + by });
}

/** The path rule above, in the node's unrotated frame. */
function pathBox(node: Extract<NodeV5, { type: 'path' }>): Box {
  const { frame, stroke } = node;
  let box = boxOf(frame);
  const points = node.path.points;
  for (let i = 0; i + 1 < points.length; i += 2) {
    box = include(box, {
      x: frame.x + points[i]! * frame.width,
      y: frame.y + points[i + 1]! * frame.height,
    });
  }
  if (stroke === null || !(stroke.width > 0) || points.length === 0) return box;
  return grow(box, strokeGrowth(stroke));
}

/** The renderer's growth of a stroked outline's point box: w/2 · k (see above). */
function strokeGrowth(stroke: PathStroke): number {
  const k = Math.max(
    1,
    stroke.join === 'miter' ? Math.min(stroke.miterLimit, MITER_CAP) : 1,
    stroke.cap === 'square' ? 1.5 : 1,
  );
  return (stroke.width / 2) * k;
}

/**
 * A line in its unrotated frame, with the projector's geometry (`lineContent`, M1 section 5).
 * A head has its tip T at the end and its base corners at T − 4w·u ± 2w·n.
 * - No head: one stroked segment, bounded exactly: the shaft w wide (w/2 each side of the axis),
 *   a square cap's corners w/2 beyond the end, a round cap's circle of radius w/2.
 * - `line` heads and no `triangle` (stroke mode): the renderer strokes the open polyline
 *   corner → tip → corner with the line's cap and join, so the outline's points (the ends and
 *   each head's corners) take the path rule, w/2 · max(1, miter limit, 1.5 for a square cap),
 *   which covers the miter at the tip and the diagonal caps at the corners.
 * - A `triangle` end (fill mode): one filled outline, the shaft and caps as above, triangle heads
 *   exactly, a `line` head as two w-wide bars (so its points grow by w/2).
 */
function lineBox(node: Extract<NodeV5, { type: 'line' }>): Box {
  const { frame, stroke } = node;
  const [x0, y0, x1, y1] = node.points;
  const p0 = { x: frame.x + x0 * frame.width, y: frame.y + y0 * frame.height };
  const p1 = { x: frame.x + x1 * frame.width, y: frame.y + y1 * frame.height };
  let box = include(include(boxOf(frame), p0), p1);
  const w = stroke?.width ?? 0;
  const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (stroke === null || !(w > 0)) return box;
  if (length === 0) return grow(box, stroke.cap === 'butt' ? 0 : (w / 2) * Math.SQRT2);
  const d = { x: (p1.x - p0.x) / length, y: (p1.y - p0.y) / length };
  const n = { x: -d.y, y: d.x };
  const at = (p: PagePoint, u: PagePoint, s: number, t: number) => ({
    x: p.x + s * u.x + t * n.x,
    y: p.y + s * u.y + t * n.y,
  });
  const ends: [string, PagePoint, PagePoint][] = [
    [node.startArrow, p0, { x: -d.x, y: -d.y }],
    [node.endArrow, p1, d],
  ];
  if (ends.some(([arrow]) => arrow === 'line') && ends.every(([arrow]) => arrow !== 'triangle')) {
    let outline = include(box, p0);
    for (const [arrow, tip, u] of ends) {
      if (arrow !== 'line') continue;
      outline = include(outline, at(tip, u, -4 * w, 2 * w));
      outline = include(outline, at(tip, u, -4 * w, -2 * w));
    }
    return grow(outline, strokeGrowth(stroke));
  }
  for (const [arrow, tip, u] of ends) {
    // The shaft's corners at this end (a square cap moves them w/2 outward).
    const out = arrow === 'none' && stroke.cap === 'square' ? w / 2 : 0;
    box = include(box, at(tip, u, out, w / 2));
    box = include(box, at(tip, u, out, -w / 2));
    if (arrow === 'none' && stroke.cap === 'round') box = include(box, tip, w / 2);
    if (arrow === 'none') continue;
    const bar = arrow === 'line' ? w / 2 : 0;
    box = include(box, tip, bar);
    box = include(box, at(tip, u, -4 * w, 2 * w), bar);
    box = include(box, at(tip, u, -4 * w, -2 * w), bar);
  }
  return box;
}

/** A node's visual box in its own unrotated frame (coordinates of its parent's space). */
function ownBox(document: DocumentV5, node: NodeV5): Box {
  switch (node.type) {
    case 'rectangle':
    case 'ellipse':
      return grow(boxOf(node.frame), node.stroke === null ? 0 : node.stroke.width / 2);
    case 'path':
      return pathBox(node);
    case 'line':
      return lineBox(node);
    case 'frame':
    case 'symbol':
      // Content is clipped to the frame; a border is centred on its edge.
      return grow(boxOf(node.frame), node.stroke === null ? 0 : node.stroke.width / 2);
    case 'instance': {
      const source = document.nodes[node.symbol];
      const stroke = source?.type === 'symbol' ? source.stroke : null;
      return grow(boxOf(node.frame), stroke === null ? 0 : stroke.width / 2);
    }
    case 'group':
    case 'maskGroup': {
      // Children are in the container's local space (origin at its frame's top-left); a mask
      // group is bounded by all its children, which contain what its mask lets through.
      let box = boxOf(node.frame);
      for (const id of node.children) {
        const child = document.nodes[id];
        if (child === undefined) continue;
        const b = visualBounds(document, child);
        box = union(box, {
          minX: node.frame.x + b.x,
          minY: node.frame.y + b.y,
          maxX: node.frame.x + b.x + b.width,
          maxY: node.frame.y + b.y + b.height,
        });
      }
      return box;
    }
    case 'custom':
      // The extension's outline is assumed to stay inside the frame (its geometry is not known
      // here); the projector strokes it as a path, so a stroke grows the frame by the path rule.
      return node.stroke === null || !(node.stroke.width > 0)
        ? boxOf(node.frame)
        : grow(boxOf(node.frame), strokeGrowth(node.stroke));
    default:
      // Text draws inside its frame here.
      return boxOf(node.frame);
  }
}

/**
 * The visual bounds of `node` in its parent's space: its own visual box turned by its rotation
 * about its frame's centre. Contains `rotatedBounds(node)`.
 */
export function visualBounds(document: DocumentV5, node: NodeV5): Frame {
  const box = ownBox(document, node);
  if (node.rotation === 0) {
    return { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
  }
  // Into the frame's local space, then through the node's local transform.
  const m = localTransform(node.frame, node.rotation);
  const { x, y } = node.frame;
  return boundsOfPoints([
    apply(m, box.minX - x, box.minY - y),
    apply(m, box.maxX - x, box.minY - y),
    apply(m, box.maxX - x, box.maxY - y),
    apply(m, box.minX - x, box.maxY - y),
  ])!;
}
