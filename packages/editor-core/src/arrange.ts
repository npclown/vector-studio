import { type DocumentV3, type Frame, type NodeV3 } from '@vector-studio/model';
import { Draft, fail, type Failure } from './draft.js';
import {
  drawIds,
  inserted,
  isPoint,
  nodeOf,
  placeholderIds,
  remapFailure,
  success,
  uniqueIds,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import { rotate } from './geometry.js';
import { boundsOf } from './hit-test.js';
import {
  ancestors,
  childrenOf,
  documentTree,
  isContainer,
  isFrameLike,
  nodePath,
  pageOf,
  spaceOf,
  subtree,
  treeDepthViolation,
  type TreeView,
} from './tree.js';
import type { AlignEdge, DocumentCommand, PagePoint, ReorderOp } from './types.js';

// Arrange commands (MVP M2 contract, section 4.3). They act on nodes of the active page at any
// depth; a listed descendant of a listed node is ignored (the M1 selection rule). Boxes are the
// page-aligned bounds of the nodes' rotated frames (`boundsOf`), and each node moves by a page
// vector turned into its parent space, so nodes of different parents mix freely. A command that
// changes nothing returns the document itself, which the editor records as no step.

export type Finish = (draft: Draft) => DocumentV3 | Failure;
type Arranged = Readonly<{ tree: TreeView; roots: readonly string[] }>;

const EDGES: readonly AlignEdge[] = ['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'];
const OPS: readonly ReorderOp[] = ['forward', 'backward', 'front', 'back'];

/**
 * The shared checks of the arrange commands in the section 4.4 order: `ids` (a list of distinct
 * strings, not empty) at `/ids`, then the command's own fields (`fields`), then the nodes, which
 * must be on the active page. Returns the listed roots in listed order.
 */
export function arranged(
  document: DocumentV3,
  rawIds: unknown,
  context: Pick<EditContext, 'activePage'>,
  fields: () => Failure | null,
): Arranged | Failure {
  const ids = uniqueIds(rawIds);
  if (ids === null || ids.length === 0) return fail('editor.invalid-command', '/ids');
  const shape = fields();
  if (shape !== null) return shape;
  const tree = documentTree(document);
  if (
    ids.some((id) => nodeOf(document, id) === undefined || pageOf(tree, id) !== context.activePage)
  ) {
    return fail('editor.unknown-node');
  }
  const listed = new Set(ids);
  return { tree, roots: ids.filter((id) => !ancestors(tree, id).some((n) => listed.has(n.id))) };
}

/** The frame of `node` moved by the page vector `(dx, dy)` turned into its parent space. */
function translated(tree: TreeView, node: NodeV3, dx: number, dy: number): Frame {
  const d = rotate(-spaceOf(tree, node.parent).rotation, dx, dy);
  return { ...node.frame, x: node.frame.x + d.x, y: node.frame.y + d.y };
}

/** Sets `frame` on `node` when its position differs; true when it did. */
function place(draft: Draft, node: NodeV3, frame: Frame): boolean {
  if (frame.x === node.frame.x && frame.y === node.frame.y) return false;
  draft.set({ ...node, frame });
  return true;
}

/** Each node's position in the document pre-order of `page`. */
export function preorder(document: DocumentV3, tree: TreeView, page: string): Map<string, number> {
  const roots = document.pages.find((entry) => entry.id === page)?.children ?? [];
  return new Map(
    roots.flatMap((child) => subtree(tree, child)).map((id, position) => [id, position] as const),
  );
}

function unchangedResult(document: DocumentV3): EditResult {
  return { ok: true, document, touched: [], created: [] };
}

/**
 * `alignNodes`: the target is the union of the nodes' boxes, or for one node the box of its
 * nearest frame ancestor (none: no change). A page-root node with rotation 0 sets `x` (or `y`)
 * exactly to the target's edge, centre minus half its size, or far edge minus its size; any
 * other node moves by the difference of its box's value from the target's.
 */
export function alignNodes(
  document: DocumentV3,
  command: Extract<DocumentCommand, { type: 'alignNodes' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const edge = command.edge;
  const checked = arranged(document, command.ids, context, () =>
    EDGES.includes(edge) ? null : fail('editor.invalid-command', '/edge'),
  );
  if ('ok' in checked) return checked;
  const { tree, roots } = checked;
  let target: Frame | null;
  if (roots.length === 1) {
    // A symbol is an alignment target as a frame (MVP M7 contract, section 1.2).
    const frame = ancestors(tree, roots[0]!).find(isFrameLike);
    target = frame === undefined ? null : boundsOf(document, [frame.id]);
  } else {
    target = boundsOf(document, roots);
  }
  if (target === null) return unchangedResult(document);
  const horizontal = edge === 'left' || edge === 'hcenter' || edge === 'right';
  // The fraction of the box the edge sits at: 0 the low edge, 0.5 the centre, 1 the high edge.
  const at =
    edge === 'left' || edge === 'top' ? 0 : edge === 'hcenter' || edge === 'vcenter' ? 0.5 : 1;
  const [low, size] = horizontal ? [target.x, target.width] : [target.y, target.height];
  const value = (origin: number, extent: number) =>
    at === 0 ? origin : at === 0.5 ? origin + extent / 2 : origin + extent;
  const goal = value(low, size);
  const draft = new Draft(document);
  for (const id of roots) {
    const node = document.nodes[id]!;
    if (tree.page(node.parent) !== undefined && node.rotation === 0) {
      const own = horizontal ? node.frame.width : node.frame.height;
      const exact = at === 0 ? low : at === 0.5 ? low + size / 2 - own / 2 : low + size - own;
      place(draft, node, horizontal ? { ...node.frame, x: exact } : { ...node.frame, y: exact });
      continue;
    }
    const box = boundsOf(document, [id])!;
    const delta = horizontal ? goal - value(box.x, box.width) : goal - value(box.y, box.height);
    place(draft, node, translated(tree, node, horizontal ? delta : 0, horizontal ? 0 : delta));
  }
  if (draft.touched.size === 0) return unchangedResult(document);
  return success(finish(draft), draft, []);
}

/**
 * `distributeNodes`: at least 3 nodes. They sort by box centre on the axis, ties by document
 * pre-order; the first and last stay; with span `S = last.max − first.min` and
 * `gap = (S − Σ sizes) / (n − 1)` (sizes summed in sorted order, `gap` possibly negative), each
 * next box's min is the previous box's new max plus `gap`. A page-root node with rotation 0 sets
 * that min exactly; any other node moves by the difference from its box's min.
 */
export function distributeNodes(
  document: DocumentV3,
  command: Extract<DocumentCommand, { type: 'distributeNodes' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const axis = command.axis;
  const checked = arranged(document, command.ids, context, () =>
    axis === 'horizontal' || axis === 'vertical' ? null : fail('editor.invalid-command', '/axis'),
  );
  if ('ok' in checked) return checked;
  const { tree, roots } = checked;
  if (roots.length < 3) return fail('editor.too-few-nodes');
  const order = preorder(document, tree, context.activePage);
  const horizontal = axis === 'horizontal';
  const entries = roots
    .map((id) => {
      const box = boundsOf(document, [id])!;
      const [min, size] = horizontal ? [box.x, box.width] : [box.y, box.height];
      return { id, min, size, centre: min + size / 2, order: order.get(id)! };
    })
    .sort((a, b) => a.centre - b.centre || a.order - b.order);
  let total = 0;
  for (const entry of entries) total += entry.size;
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const span = last.min + last.size - first.min;
  const gap = (span - total) / (entries.length - 1);
  const draft = new Draft(document);
  let previous = first.min + first.size;
  for (const entry of entries.slice(1, -1)) {
    const min = previous + gap;
    const node = document.nodes[entry.id]!;
    if (tree.page(node.parent) !== undefined && node.rotation === 0) {
      // A page-root node with rotation 0 sets its min exactly, as align does (its box's min is
      // its own `x` or `y`).
      place(draft, node, horizontal ? { ...node.frame, x: min } : { ...node.frame, y: min });
    } else {
      const delta = min - entry.min;
      place(draft, node, translated(tree, node, horizontal ? delta : 0, horizontal ? 0 : delta));
    }
    previous = min + entry.size;
  }
  if (draft.touched.size === 0) return unchangedResult(document);
  return success(finish(draft), draft, []);
}

/**
 * The children of one parent after `op` on the `listed` ones: `front` and `back` move them to
 * the top or bottom in their relative order; `forward` moves each maximal run of listed children
 * above the next unlisted sibling above it, `backward` below the next one below it, so runs never
 * pass each other. The last child is on top.
 */
function reordered(children: readonly string[], listed: ReadonlySet<string>, op: ReorderOp) {
  const ins = children.filter((id) => listed.has(id));
  const outs = children.filter((id) => !listed.has(id));
  if (op === 'front') return [...outs, ...ins];
  if (op === 'back') return [...ins, ...outs];
  // Tokens bottom to top: each maximal run of listed children, and each unlisted child alone.
  const tokens: { run: boolean; ids: string[] }[] = [];
  for (const id of children) {
    const previous = tokens[tokens.length - 1];
    if (listed.has(id) && previous?.run === true) previous.ids.push(id);
    else tokens.push({ run: listed.has(id), ids: [id] });
  }
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    // Forward: a run trades places with the unlisted child above it; backward: an unlisted
    // child trades places with the run above it (the run moves below it).
    const swap = next !== undefined && (op === 'forward' ? token.run : next.run);
    if (swap) {
      out.push(...next.ids, ...token.ids);
      i += 1;
    } else {
      out.push(...token.ids);
    }
  }
  return out;
}

/**
 * `reorderNodes`: within each node's own parent, several parents independently. A result that
 * leaves a mask group with a non-path first child fails with `editor.invalid-mask-source`.
 */
export function reorderNodes(
  document: DocumentV3,
  command: Extract<DocumentCommand, { type: 'reorderNodes' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const op = command.op;
  const checked = arranged(document, command.ids, context, () =>
    OPS.includes(op) ? null : fail('editor.invalid-command', '/op'),
  );
  if ('ok' in checked) return checked;
  const { tree, roots } = checked;
  const byParent = new Map<string, Set<string>>();
  for (const id of roots) {
    const parent = document.nodes[id]!.parent;
    const set = byParent.get(parent) ?? new Set<string>();
    set.add(id);
    byParent.set(parent, set);
  }
  const draft = new Draft(document);
  for (const [parent, listed] of byParent) {
    const children = childrenOf(tree, parent);
    const next = reordered(children, listed, op);
    if (next.every((id, i) => id === children[i])) continue;
    draft.setChildren(parent, next);
    // The moved nodes are listed as touched, as for a reorder by `moveNodes`.
    next.forEach((id, i) => {
      if (id !== children[i]) draft.setChecked(draft.node(id)!, true);
    });
  }
  if (draft.touched.size === 0) return unchangedResult(document);
  return success(finish(draft), draft, []);
}

/**
 * `nudgeNodes`: each node moves by the page vector `(dx, dy)` turned into its parent space; a
 * page-root node sets `x + dx` and `y + dy` exactly.
 */
export function nudgeNodes(
  document: DocumentV3,
  command: Extract<DocumentCommand, { type: 'nudgeNodes' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const { dx, dy } = command as { dx: unknown; dy: unknown };
  const checked = arranged(document, command.ids, context, () => {
    if (typeof dx !== 'number' || !Number.isFinite(dx))
      return fail('editor.invalid-command', '/dx');
    if (typeof dy !== 'number' || !Number.isFinite(dy))
      return fail('editor.invalid-command', '/dy');
    return null;
  });
  if ('ok' in checked) return checked;
  const { tree, roots } = checked;
  const draft = new Draft(document);
  for (const id of roots) {
    const node = document.nodes[id]!;
    place(draft, node, translated(tree, node, dx as number, dy as number));
  }
  if (draft.touched.size === 0) return unchangedResult(document);
  return success(finish(draft), draft, []);
}

/**
 * `duplicateNodes` (section 4.3, S8): every check runs on a build with placeholder IDs first, so
 * a failed command draws no ID. That build also gives the copies' paint order in the result, and
 * the IDs are then drawn root by root in that order, each subtree in pre-order (a container
 * before its children, in `children` order), so the drawn order is the returned order. Each copy
 * goes into its original's parent directly above the topmost original of that parent, the
 * copies of one parent in their originals' relative order, and moves by the page `offset`.
 */
export function duplicateNodes(
  document: DocumentV3,
  command: Extract<DocumentCommand, { type: 'duplicateNodes' }>,
  context: EditContext,
  finish: Finish,
): EditResult {
  const offset: unknown = command.offset;
  const checked = arranged(document, command.ids, context, () =>
    offset === undefined || isPoint(offset) ? null : fail('editor.invalid-command', '/offset'),
  );
  if ('ok' in checked) return checked;
  const { tree } = checked;
  const order = preorder(document, tree, context.activePage);
  const move = (offset as PagePoint | undefined) ?? { x: 0, y: 0 };
  const build = (roots: readonly string[], ids: readonly string[]) =>
    buildDuplicate(document, tree, context.activePage, roots, ids, move, finish);
  // The trial: roots in the originals' paint order, with placeholders no page or node has.
  const roots = [...checked.roots].sort((a, b) => order.get(a)! - order.get(b)!);
  const count = roots.reduce((sum, root) => sum + subtree(tree, root).length, 0);
  const placeholders = placeholderIds(document, count);
  const trial = build(roots, placeholders);
  if (!trial.ok) {
    // A failure in a copy is reported at its original.
    const originals = roots.flatMap((root) => subtree(tree, root));
    return remapFailure(trial, placeholders, originals);
  }
  // The originals in their copies' paint order in the result.
  const rootOf = new Map(roots.map((root, i) => [trial.ids[i]!, root] as const));
  const painted = trial.created.map((copy) => rootOf.get(copy)!);
  const ids = drawIds(document, context.ids, count);
  if (ids === null) return fail('editor.duplicate-id');
  const result = build(painted, ids);
  if (!result.ok) return result;
  const { document: next, touched, created } = result;
  return { ok: true, document: next, touched, created };
}

type Duplicate =
  (Extract<EditResult, { ok: true }> & Readonly<{ ids: readonly string[] }>) | Failure;

/**
 * The duplicate of `roots` with `ids` for their subtrees, root by root in `roots` order, each in
 * pre-order. `ids` of the result is each root's copy in `roots` order; `created` is the copies'
 * roots in the result's paint order.
 */
function buildDuplicate(
  document: DocumentV3,
  tree: TreeView,
  page: string,
  roots: readonly string[],
  ids: readonly string[],
  offset: PagePoint,
  finish: Finish,
): Duplicate {
  const originals = roots.flatMap((root) => subtree(tree, root));
  const copyOf = new Map(originals.map((id, i) => [id, ids[i]!] as const));
  const rootSet = new Set(roots);
  const draft = new Draft(document);
  for (const id of originals) {
    const node = document.nodes[id]!;
    const copy: Record<string, unknown> = {
      ...node,
      id: copyOf.get(id)!,
      parent: rootSet.has(id) ? node.parent : copyOf.get(node.parent)!,
    };
    if (isContainer(node)) copy.children = node.children.map((child) => copyOf.get(child)!);
    if (rootSet.has(id)) copy.frame = translated(tree, node, offset.x, offset.y);
    draft.set(copy as NodeV3);
  }
  const parents = [...new Set(roots.map((id) => document.nodes[id]!.parent))];
  for (const parent of parents) {
    const siblings = childrenOf(tree, parent);
    const listed = siblings.filter((id) => rootSet.has(id));
    const top = siblings.indexOf(listed[listed.length - 1]!) + 1;
    draft.setChildren(
      parent,
      inserted(
        siblings,
        top,
        listed.map((id) => copyOf.get(id)!),
      ),
    );
  }
  const copies = roots.map((id) => copyOf.get(id)!);
  const deep = treeDepthViolation(draft, copies);
  if (deep !== null) return fail('document.invalid-field', nodePath(deep, '/parent'));
  const result = success(finish(draft), draft, [], copies);
  if (!result.ok) return result;
  const placed = preorder(result.document, documentTree(result.document), page);
  const created = [...copies].sort((a, b) => placed.get(a)! - placed.get(b)!);
  return { ...result, created, ids: copies };
}
