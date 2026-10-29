import type { DocumentV5, Frame } from '@vector-studio/model';
import { apply, localTransform, multiply, type Matrix } from './geometry.js';
import { boundsOf } from './hit-test.js';
import { documentTree, spaceOf } from './tree.js';
import type { PagePoint } from './types.js';

// The select tool's handle box (M1 contract, section 4.4; M1-U5 `handles` query) and its centre,
// the rotate pivot (M2 contract, section 4.1). Shared by the tools and the document edits.

/** Handle positions on the box, as fractions of its width and height. */
export const HANDLES = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5],
] as const;

export type Handle = (typeof HANDLES)[number];

/** The handles that can scale at least one axis of `box`, in `HANDLES` order. */
export function activeHandles(box: Frame): Handle[] {
  return HANDLES.filter(
    (handle) => (handle[0] !== 0.5 && box.width > 0) || (handle[1] !== 0.5 && box.height > 0),
  );
}

/**
 * The box the handles sit on. `p5`: the page-aligned bounds of a page-root selection with
 * rotation 0, resized as in P5. `single`: one other node, its own rotated box (`matrix` maps
 * its local space to the page). `map`: the page-aligned bounds of any other multi-selection.
 */
export type HandleBox =
  | { mode: 'p5' | 'map'; box: Frame }
  | { mode: 'single'; box: Frame; id: string; matrix: Matrix; turn: number };

/** The handle box of `selection` on `page` (section 4.4), or null for an empty selection. */
export function handleBoxOf(
  document: DocumentV5,
  page: string,
  selection: readonly string[],
): HandleBox | null {
  const box = boundsOf(document, selection);
  if (box === null) return null;
  const p5 = selection.every((id) => {
    const node = document.nodes[id];
    return node !== undefined && node.parent === page && node.rotation === 0;
  });
  if (p5) return { mode: 'p5', box };
  if (selection.length > 1) return { mode: 'map', box };
  // A single node: the handles follow its rotation (section 4.4).
  const id = selection[0]!;
  const node = document.nodes[id]!;
  const space = spaceOf(documentTree(document), node.parent);
  return {
    mode: 'single',
    box: { x: 0, y: 0, width: node.frame.width, height: node.frame.height },
    id,
    matrix: multiply(space.matrix, localTransform(node.frame, node.rotation)),
    turn: space.rotation + node.rotation,
  };
}

/** A handle's page-space point on the handle box. */
export function handlePoint(handles: HandleBox, handle: Handle): PagePoint {
  const { box } = handles;
  if (handles.mode !== 'single') {
    return { x: box.x + handle[0] * box.width, y: box.y + handle[1] * box.height };
  }
  return apply(handles.matrix, handle[0] * box.width, handle[1] * box.height);
}

/** The page-space centre of the handle box: the rotate gesture's pivot (M2 section 4.1). */
export function handleCentre(handles: HandleBox): PagePoint {
  const { box } = handles;
  if (handles.mode !== 'single') return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return apply(handles.matrix, box.width / 2, box.height / 2);
}
