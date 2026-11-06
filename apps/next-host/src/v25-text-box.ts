import type { EditorSnapshot } from '@vector-studio/editor-core';
import { nodePageCorners } from './m2-geometry';

// V-25 slice 6 (text box outline): in the studio layout, text edit mode outlines the edited
// text's box, as Figma does, since the `handles` query is null in edit mode (M6b-S1) and the box
// would otherwise be invisible while typing. Drawn by the host from session `textEdit`: the edited
// node's page corners, or a pending node's page-space frame (rotation 0). Nothing in the editor
// changes; the `textEditOverlay` query (M6b contract, section 4.5) keeps its shape.

/** A point in CSS px over the canvas. */
type Point = readonly [number, number];

/**
 * The outline of the text being edited in CSS px over the canvas (CSS px = (page − position) ·
 * zoom, as every overlay layer), four points from the box's top-left clockwise, grown by `grow`
 * CSS px on every side; null outside text edit mode or when the edited node is gone.
 */
export function textEditBox(
  snapshot: EditorSnapshot,
  grow: number = TEXT_BOX_OUTSET,
): readonly Point[] | null {
  const state = snapshot.textEdit;
  if (state === null) return null;
  let corners;
  if (state.pending !== null) {
    const { x, y, width, height } = state.pending.frame;
    corners = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  } else if (state.id !== null) {
    corners = nodePageCorners(snapshot.document, state.id);
  }
  if (corners === undefined || corners === null) return null;
  const { position, zoom } = snapshot.viewport;
  const css = corners.map((p): Point => [(p.x - position.x) * zoom, (p.y - position.y) * zoom]);
  return outset(css, grow);
}

/**
 * The outline sits this many CSS px outside the box (slice 6 follow-up), so the caret at either
 * end of a line, which lies on the box's left or right edge, never covers the outline's edge.
 */
export const TEXT_BOX_OUTSET = 1;

const unit = (x: number, y: number): Point | null => {
  const length = Math.hypot(x, y);
  return length === 0 ? null : [x / length, y / length];
};

/** The quad grown by `d` along its own axes on every side; a zero-size axis takes the other's normal. */
function outset(quad: readonly Point[], d: number): readonly Point[] {
  const [a, b, , c] = quad as readonly [Point, Point, Point, Point];
  let u = unit(b[0] - a[0], b[1] - a[1]);
  let v = unit(c[0] - a[0], c[1] - a[1]);
  if (u === null && v === null) {
    u = [1, 0];
    v = [0, 1];
  } else if (u === null) {
    u = [v![1], -v![0]];
  } else if (v === null) {
    v = [-u[1], u[0]];
  }
  const [ux, uy] = u;
  const [vx, vy] = v!;
  const signs: readonly (readonly [number, number])[] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  return quad.map(([x, y], i): Point => {
    const [su, sv] = signs[i]!;
    return [x + d * (su * ux + sv * vx), y + d * (su * uy + sv * vy)];
  });
}
