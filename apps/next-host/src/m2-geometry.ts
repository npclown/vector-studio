import type { PagePoint, SelectionHandles } from '@vector-studio/editor-core';
import type { DocumentV6 } from '@vector-studio/model';

// M2-U8 (MVP M2 contract, sections 3, 4.1 and 5): the host-side geometry of the next-host page's
// M2 chrome, kept pure so it is unit tested without a DOM. The editor decides every behaviour;
// these helpers only draw it: the scope outline and the rotate-zone cursor. The zoom label moved to
// `@vector-studio/ui`'s toolbar (MVP M8 contract, M8-L1; removed here in M8-U6).

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
export function nodePageCorners(document: DocumentV6, id: string): Quad | null {
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

/**
 * V-28 (Figma): the cursor a select-tool hover at `point` shows over the handle box, mirroring the
 * press order of the select tool (M2 contract, section 4.1): a resize handle within `6 / zoom`
 * (except inside a box too small for its handles, where a press on the node moves it), then the
 * rotate zone. `angle` is the screen direction in degrees (y down) the handle or corner points away
 * from the box: a resize cursor is a double arrow along it, a rotate cursor curls around it. Null
 * shows the default cursor.
 */
export type HandleCursor = Readonly<{ kind: 'resize' | 'rotate'; angle: number }>;

export function handleCursorAt(
  handles: SelectionHandles,
  point: PagePoint,
  zoom: number,
): HandleCursor | null {
  const [origin, right, , bottom] = handles.corners;
  const width = Math.hypot(right.x - origin.x, right.y - origin.y);
  const height = Math.hypot(bottom.x - origin.x, bottom.y - origin.y);
  const cos = Math.cos(handles.rotation);
  const sin = Math.sin(handles.rotation);
  // A page point in the box's own axes, from its top-left corner.
  const toLocal = (p: PagePoint) => {
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
  };
  // The side (-1, 0 or 1) of a local coordinate along an axis of `size`; 0 on a flat axis.
  const side = (value: number, size: number) => {
    if (size <= 0) return 0;
    const t = value / size;
    return t < 0.25 ? -1 : t > 0.75 ? 1 : 0;
  };
  // The outward direction of a local handle position, turned by the box rotation, in degrees.
  const direction = (local: PagePoint): number | null => {
    const sx = side(local.x, width);
    const sy = side(local.y, height);
    if (sx === 0 && sy === 0) return null;
    const x = sx * cos - sy * sin;
    const y = sx * sin + sy * cos;
    return (Math.atan2(y, x) * 180) / Math.PI;
  };
  const local = toLocal(point);
  const inside = local.x > 0 && local.x < width && local.y > 0 && local.y < height;
  // The select tool moves instead of resizing inside a box under four handle radii; the hover
  // cannot see the node under the pointer, so it shows no resize cursor anywhere inside such a box.
  const reach = (4 * HANDLE_PX) / zoom;
  const small = width < reach || height < reach;
  if (!(small && inside)) {
    let best: PagePoint | null = null;
    let edgeCursor: HandleCursor | null = null;
    let bestDistance = HANDLE_PX / zoom;
    for (const handle of handles.handles) {
      const d = Math.hypot(point.x - handle.x, point.y - handle.y);
      if (d <= bestDistance) {
        best = handle;
        bestDistance = d;
      }
    }
    // V-29 (Figma): anywhere along an edge, on or just outside the box within the handle reach
    // and between its corners, resizes that edge, as the select tool's press does.
    if (best === null && !inside) {
      const reachEdge = HANDLE_PX / zoom;
      const alongX = local.x >= 0 && local.x <= width;
      const alongY = local.y >= 0 && local.y <= height;
      // No edges across an axis thinner than the small-box reach (the select tool's rule).
      const scalesY = height >= reach;
      const scalesX = width >= reach;
      const edges: [PagePoint, number, boolean][] = [
        [{ x: width / 2, y: 0 }, Math.abs(local.y), alongX && scalesY],
        [{ x: width, y: height / 2 }, Math.abs(local.x - width), alongY && scalesX],
        [{ x: width / 2, y: height }, Math.abs(local.y - height), alongX && scalesY],
        [{ x: 0, y: height / 2 }, Math.abs(local.x), alongY && scalesX],
      ];
      let edgeDistance = reachEdge;
      for (const [middle, d, along] of edges) {
        if (along && d <= edgeDistance) {
          edgeDistance = d;
          const angle = direction(middle);
          if (angle !== null) edgeCursor = { kind: 'resize', angle };
        }
      }
    }
    if (edgeCursor !== null) return edgeCursor;
    if (best !== null) {
      const angle = direction(toLocal(best));
      // A handle at the centre of a flat box points along its one axis.
      return {
        kind: 'resize',
        angle: angle ?? (width > 0 ? 0 : 90) + (handles.rotation * 180) / Math.PI,
      };
    }
  }
  if (!inRotateZone(handles, point, zoom)) return null;
  // The nearest corner, whose outward diagonal the rotate cursor curls around.
  let corner = handles.corners[0];
  for (const candidate of handles.corners) {
    if (
      Math.hypot(point.x - candidate.x, point.y - candidate.y) <
      Math.hypot(point.x - corner.x, point.y - corner.y)
    )
      corner = candidate;
  }
  const local2 = toLocal(corner);
  const sx = width > 0 && local2.x > width / 2 ? 1 : -1;
  const sy = height > 0 && local2.y > height / 2 ? 1 : -1;
  const x = sx * cos - sy * sin;
  const y = sx * sin + sy * cos;
  return { kind: 'rotate', angle: (Math.atan2(y, x) * 180) / Math.PI };
}

/** A page-space angle in radians as degrees with at most one decimal, for the snap label. */
export function degreesLabel(radians: number): string {
  return `${Math.round((radians * 1800) / Math.PI) / 10}°`;
}
