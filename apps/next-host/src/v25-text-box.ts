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
 * zoom, as every overlay layer), four points from the box's top-left clockwise; null outside text
 * edit mode or when the edited node is gone.
 */
export function textEditBox(snapshot: EditorSnapshot): readonly Point[] | null {
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
  return corners.map((p): Point => [(p.x - position.x) * zoom, (p.y - position.y) * zoom]);
}
