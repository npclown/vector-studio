import type { DocumentV6 } from '@vector-studio/model';
import { apply, invertRigid } from './geometry.js';
import { childrenOf, documentTree, isAncestor, spaceOf, type TreeView } from './tree.js';
import type { PagePoint } from './types.js';

// V-25 slice 4 (frame adoption, `EditorOptions.adoptIntoFrames`): as in Figma, a shape drawn
// inside a frame becomes the frame's child, and nodes dropped onto a frame move into it (or out
// of it onto the page). Only `frame` nodes adopt: groups are searched through, and symbols, mask
// groups and instances are not entered (their contents follow their own rules, M7, M2).

/** Whether `point` lies in the frame's own box (its local `0..width × 0..height`), edges included. */
function insideFrame(tree: TreeView, id: string, point: PagePoint): boolean {
  const node = tree.node(id);
  if (node === undefined) return false;
  const local = apply(invertRigid(spaceOf(tree, id).matrix), point.x, point.y);
  return (
    local.x >= 0 && local.y >= 0 && local.x <= node.frame.width && local.y <= node.frame.height
  );
}

/**
 * The innermost visible frame of `owner`'s subtree whose box contains `point`, front first (a
 * frame's children before the frame, a later sibling before an earlier one), searching through
 * groups; frames clip, so a frame's children are searched only when the point is inside it.
 * Nodes in `exclude`, and their subtrees, are skipped.
 */
function frameIn(
  document: DocumentV6,
  tree: TreeView,
  owner: string,
  point: PagePoint,
  exclude: ReadonlySet<string>,
): string | null {
  const children = childrenOf(tree, owner);
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const id = children[i]!;
    const node = document.nodes[id];
    if (node === undefined || exclude.has(id) || node.visible === false) continue;
    if (node.type === 'frame') {
      if (insideFrame(tree, id, point)) return frameIn(document, tree, id, point, exclude) ?? id;
    } else if (node.type === 'group') {
      const found = frameIn(document, tree, id, point, exclude);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * The owner a node drawn or dropped at `point` belongs to: the innermost frame there, inside the
 * session scope when the point is in it (a group scope always holds it, as the text tool's
 * pending node), else on the page; the scope itself, or the page, when no frame is there.
 */
export function adoptionOwner(
  document: DocumentV6,
  page: string,
  scope: string | null,
  point: PagePoint,
  exclude: ReadonlySet<string> = new Set(),
): string {
  const tree = documentTree(document);
  if (scope !== null && tree.node(scope) !== undefined && !exclude.has(scope)) {
    const found = frameIn(document, tree, scope, point, exclude);
    if (found !== null) return found;
    if (document.nodes[scope]!.type !== 'frame' || insideFrame(tree, scope, point)) return scope;
  }
  return frameIn(document, tree, page, point, exclude) ?? page;
}

/**
 * The nodes of a finished move that change owner when dropped at `point` (V-25 slice 4), and
 * that owner; null when none does. A node moves only when its parent is the page or a frame (a
 * group's child stays in its group) and it is not a top-level frame (an artboard stays one).
 * The moved nodes and their subtrees are never the target.
 */
export function dropAdoption(
  document: DocumentV6,
  page: string,
  scope: string | null,
  ids: readonly string[],
  point: PagePoint,
): Readonly<{ ids: readonly string[]; parent: string }> | null {
  const tree = documentTree(document);
  const moved = new Set(ids);
  const parent = adoptionOwner(document, page, scope, point, moved);
  const target = tree.node(parent);
  if (target !== undefined && target.type !== 'frame' && parent !== page) return null;
  const adopted = ids.filter((id) => {
    const node = tree.node(id);
    if (node === undefined || node.parent === parent) return false;
    if (ids.some((other) => other !== id && isAncestor(tree, other, id))) return false;
    const owner = node.parent;
    if (tree.page(owner) !== undefined) return node.type !== 'frame';
    return tree.node(owner)?.type === 'frame';
  });
  return adopted.length === 0 ? null : { ids: adopted, parent };
}
