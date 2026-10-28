import type { PagePoint, SelectionHandles } from '@vector-studio/editor-core';
import type { DocumentV2 } from '@vector-studio/model';

// M2-U8 (MVP M2 contract, sections 3, 4.1 and 5): the host-side geometry of the next-host page's
// M2 chrome, kept pure so it is unit tested without a DOM. The editor decides every behaviour;
// these helpers only draw it: the scope outline, the rotate-zone cursor and the zoom label.

/** The resize-handle pick radius in CSS px (M2 contract, section 4.1: `6 / zoom` page units). */
export const HANDLE_PX = 6;
/** The rotate zone's reach around each handle-box corner in CSS px (`18 / zoom` page units). */
export const ROTATE_PX = 18;

type Quad = readonly [PagePoint, PagePoint, PagePoint, PagePoint];
type Matrix = readonly [number, number, number, number, number, number];

/** The node-local to parent-local transform of schema v2: rotation about the frame centre. */
function local(
  frame: Readonly<{ x: number; y: number; width: number; height: number }>,
  rotation: number,
): Matrix {
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

function apply(m: Matrix, x: number, y: number): PagePoint {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * A node's rotated frame in page space: top-left, top-right, bottom-right and bottom-left in the
 * node's own axes, composed up its parent chain (M1 contract, section 5). Null for an unknown
 * node or a broken chain. The page draws the scope indicator from it.
 */
export function nodePageCorners(document: DocumentV2, id: string): Quad | null {
  const node = document.nodes[id];
  if (node === undefined) return null;
  let matrix = local(node.frame, node.rotation);
  let parent = node.parent;
  // A chain longer than the node count is a cycle; the model forbids it, so stop rather than spin.
  for (let steps = 0; !document.pages.some((page) => page.id === parent); steps += 1) {
    const owner = document.nodes[parent];
    if (owner === undefined || steps > Object.keys(document.nodes).length) return null;
    matrix = multiply(local(owner.frame, owner.rotation), matrix);
    parent = owner.parent;
  }
  const { width, height } = node.frame;
  return [
    apply(matrix, 0, 0),
    apply(matrix, width, 0),
    apply(matrix, width, height),
    apply(matrix, 0, height),
  ];
}

/**
 * Whether a select-tool press at the page point `point` would start the rotate gesture (M2
 * contract, section 4.1): no active resize handle within `6 / zoom`, the point strictly outside
 * the handle box in the box's own axes, and within `18 / zoom` of one of its corners. The page
 * shows the rotate cursor there; the editor still decides the press.
 */
export function inRotateZone(handles: SelectionHandles, point: PagePoint, zoom: number): boolean {
  const near = (p: PagePoint, reach: number) => Math.hypot(point.x - p.x, point.y - p.y) <= reach;
  if (handles.handles.some((handle) => near(handle, HANDLE_PX / zoom))) return false;
  const [origin, right, , bottom] = handles.corners;
  const width = Math.hypot(right.x - origin.x, right.y - origin.y);
  const height = Math.hypot(bottom.x - origin.x, bottom.y - origin.y);
  // The point in the box's own axes, from its top-left corner.
  const cos = Math.cos(handles.rotation);
  const sin = Math.sin(handles.rotation);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const outside = lx < 0 || lx > width || ly < 0 || ly > height;
  return outside && handles.corners.some((corner) => near(corner, ROTATE_PX / zoom));
}

/** The zoom as a percentage with at most two decimals: `1` is `100%`, `1/64` is `1.56%`. */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 10_000) / 100}%`;
}

/** A page-space angle in radians as degrees with at most one decimal, for the snap label. */
export function degreesLabel(radians: number): string {
  return `${Math.round((radians * 1800) / Math.PI) / 10}°`;
}
