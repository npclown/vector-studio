import type { DocumentV8 } from '@vector-studio/model';
import { apply, invertRigid } from './geometry.js';
import { ancestors, childrenOf, documentTree, isAncestor, spaceOf, type TreeView } from './tree.js';
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
  document: DocumentV8,
  tree: TreeView,
  owner: string,
  point: PagePoint,
  exclude: ReadonlySet<string>,
): string | null {
  const children = childrenOf(tree, owner);
  for (let i = children.length - 1; i >= 0; i -= 1) {
    const id = children[i]!;
    const node = document.nodes[id];
    // V31-E4: nothing is adopted into a locked frame (a locked group locks its subtree).
    if (node === undefined || exclude.has(id) || node.visible === false || node.locked === true) {
      continue;
    }
    if (node.type === 'frame') {
      if (insideFrame(tree, id, point)) return frameIn(document, tree, id, point, exclude) ?? id;
    } else if (node.type === 'group') {
      const found = frameIn(document, tree, id, point, exclude);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Whether `point` is in the visible part of `id`: inside every frame among it and its ancestors. */
function visibleAt(tree: TreeView, id: string, point: PagePoint): boolean {
  const chain = [tree.node(id), ...ancestors(tree, id)];
  return chain.every((node) => node?.type !== 'frame' || insideFrame(tree, node.id, point));
}

/**
 * The innermost visible symbol set of `owner`'s subtree whose box contains `point`, searching
 * through groups but not frames (the owner is already the innermost frame there), front first;
 * V-37 contract, section 2.1: a dragged symbol is adopted into it.
 */
function setIn(
  document: DocumentV8,
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
    if (node.type === 'symbolSet') {
      if (insideFrame(tree, id, point)) return id;
    } else if (node.type === 'group') {
      const found = setIn(document, tree, id, point, exclude);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Whether a node lies in a symbol source (its contents follow the M7 rules, not adoption). */
function inSymbol(tree: TreeView, id: string): boolean {
  return [tree.node(id), ...ancestors(tree, id)].some((node) => node?.type === 'symbol');
}

/**
 * The owner a node drawn or dropped at `point` belongs to: the innermost frame there, inside the
 * session scope when the point is in the scope's visible part (inside it if it is a frame and
 * inside each frame above it, since frames clip), else on the page; the scope itself (a group
 * scope holds any such point, as the text tool's pending node), or the page, when no frame is
 * there.
 */
export function adoptionOwner(
  document: DocumentV8,
  page: string,
  scope: string | null,
  point: PagePoint,
  exclude: ReadonlySet<string> = new Set(),
): string {
  const tree = documentTree(document);
  // A set takes no node a tool draws: its scope draws into the set's parent (V-37 contract,
  // section 2.1), and the point inside a set is not a frame there.
  const scoped = scope === null ? undefined : tree.node(scope);
  if (scoped?.type === 'symbolSet') scope = scoped.parent === page ? null : scoped.parent;
  if (
    scope !== null &&
    tree.node(scope) !== undefined &&
    !exclude.has(scope) &&
    visibleAt(tree, scope, point)
  ) {
    return frameIn(document, tree, scope, point, exclude) ?? scope;
  }
  return frameIn(document, tree, page, point, exclude) ?? page;
}

/** Whether a frame's whole box lies inside the frame `owner` at their page placements. */
function containedIn(tree: TreeView, id: string, owner: string): boolean {
  const node = tree.node(id)!;
  const matrix = spaceOf(tree, id).matrix;
  const { width, height } = node.frame;
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ].every(([x, y]) => visibleAt(tree, owner, apply(matrix, x!, y!)));
}

/**
 * The nodes of a finished move that change owner when dropped at `point` (V-25 slice 4), and
 * that owner; null when none does. The owner is the page or a frame outside any symbol source.
 * A node moves only when its parent is the page or a frame and it is not in a symbol source (a
 * group's child stays in its group); a top-level frame (an artboard) moves into a frame only
 * when its whole box lies inside that frame, so artboards dragged past each other never nest.
 * The moved nodes and their subtrees are never the target.
 */
export function dropAdoption(
  document: DocumentV8,
  page: string,
  scope: string | null,
  ids: readonly string[],
  point: PagePoint,
): Readonly<{ ids: readonly string[]; parent: string }> | null {
  const tree = documentTree(document);
  const moved = new Set(ids);
  const outer = adoptionOwner(document, page, scope, point, moved);
  const frame = tree.node(outer);
  if (frame !== undefined && (frame.type !== 'frame' || inSymbol(tree, outer))) return null;
  // Symbols dropped on a set under the pointer join it, and nothing else does (V-37 contract,
  // section 2.1).
  const roots = ids.filter(
    (id) => !ids.some((other) => other !== id && isAncestor(tree, other, id)),
  );
  const set = roots.every((id) => tree.node(id)?.type === 'symbol')
    ? setIn(document, tree, outer, point, moved)
    : null;
  const parent = set ?? outer;
  const target = tree.node(parent);
  const adopted = ids.filter((id) => {
    const node = tree.node(id);
    if (node === undefined || node.parent === parent) return false;
    // A symbol (a variant too) is not inside a source; its descendants are.
    if (ancestors(tree, id).some((up) => up.type === 'symbol')) return false;
    if (node.type !== 'symbol' && inSymbol(tree, id)) return false;
    if (ids.some((other) => other !== id && isAncestor(tree, other, id))) return false;
    if (set === null && node.type === 'symbol' && tree.node(node.parent)?.type !== 'symbolSet') {
      return false;
    }
    const owner = node.parent;
    if (tree.page(owner) !== undefined) {
      return node.type !== 'frame' || (target !== undefined && containedIn(tree, id, parent));
    }
    const above = tree.node(owner)?.type;
    return above === 'frame' || above === 'symbolSet';
  });
  return adopted.length === 0 ? null : { ids: adopted, parent };
}
