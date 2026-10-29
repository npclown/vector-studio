import {
  MAX_TREE_DEPTH,
  type ContainerNodeV3,
  type DocumentV3,
  type FrameNode,
  type GroupNode,
  type NodeV3,
  type PageV2,
  type SymbolNode,
} from '@vector-studio/model';
import { IDENTITY, localTransform, multiply, type Matrix } from './geometry.js';

// Tree queries over a v2 document (M1 contract, M1-S3). The model bounds the tree depth by 256,
// so every walk up the parent chain is bounded.

/** Read access to a document tree, shared by documents and the edit draft. */
export interface TreeView {
  node(id: string): NodeV3 | undefined;
  page(id: string): PageV2 | undefined;
}

export function documentTree(document: DocumentV3): TreeView {
  return {
    node: (id) => (Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined),
    page: (id) => document.pages.find((page) => page.id === id),
  };
}

/**
 * A node with children: a group, mask group, frame or symbol. A symbol is a container as a frame
 * is (M7 contract, section 1.2).
 */
export function isContainer(node: NodeV3 | undefined): node is ContainerNodeV3 {
  return (
    node !== undefined &&
    (node.type === 'group' ||
      node.type === 'maskGroup' ||
      node.type === 'frame' ||
      node.type === 'symbol')
  );
}

/**
 * A `frame` or a `symbol`: the containers the frame rules apply to (M7 contract, section 1.2):
 * constraints when resized, the mapping inside a resized group, the top-level artboard target.
 */
export function isFrameLike(node: NodeV3 | undefined): node is FrameNode | SymbolNode {
  return node?.type === 'frame' || node?.type === 'symbol';
}

/** A `group` or `maskGroup`: the containers that refit to their children. */
export function isGroup(node: NodeV3 | undefined): node is GroupNode {
  return node !== undefined && (node.type === 'group' || node.type === 'maskGroup');
}

/** Container ancestors of `id`, innermost first. */
export function ancestors(tree: TreeView, id: string): ContainerNodeV3[] {
  const chain: ContainerNodeV3[] = [];
  let parent = tree.node(id)?.parent;
  for (let guard = 0; parent !== undefined && guard <= MAX_TREE_DEPTH + 1; guard += 1) {
    const node = tree.node(parent);
    if (!isContainer(node)) break;
    chain.push(node);
    parent = node.parent;
  }
  return chain;
}

/** The page that holds `id`, or undefined. */
export function pageOf(tree: TreeView, id: string): string | undefined {
  const node = tree.node(id);
  if (node === undefined) return undefined;
  const chain = ancestors(tree, id);
  const top = chain.length === 0 ? node : chain[chain.length - 1]!;
  return tree.page(top.parent) === undefined ? undefined : top.parent;
}

export function isAncestor(tree: TreeView, ancestor: string, id: string): boolean {
  return ancestors(tree, id).some((node) => node.id === ancestor);
}

/**
 * The local-to-page transform of an owner's space (a page: identity; a container: its chain of
 * transforms) and the sum of the chain's rotations.
 */
export function spaceOf(tree: TreeView, owner: string): { matrix: Matrix; rotation: number } {
  const node = tree.node(owner);
  if (!isContainer(node)) return { matrix: IDENTITY, rotation: 0 };
  const chain = [node, ...ancestors(tree, owner)].reverse();
  let matrix = IDENTITY;
  let rotation = 0;
  for (const container of chain) {
    matrix = multiply(matrix, localTransform(container.frame, container.rotation));
    rotation += container.rotation;
  }
  return { matrix, rotation };
}

/** The children of a page or container, or an empty list for a leaf or unknown ID. */
export function childrenOf(tree: TreeView, owner: string): readonly string[] {
  const page = tree.page(owner);
  if (page !== undefined) return page.children;
  const node = tree.node(owner);
  return isContainer(node) ? node.children : [];
}

/** `id` and its descendants in document pre-order. */
export function subtree(tree: TreeView, id: string): string[] {
  const out: string[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const next = stack.pop()!;
    out.push(next);
    const children = childrenOf(tree, next);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
  }
  return out;
}

/** Number of container ancestors (the M1-S3 tree depth). */
export function treeDepth(tree: TreeView, id: string): number {
  return ancestors(tree, id).length;
}

/**
 * Whether a container adds a clip level: a `frame`, a `maskGroup` (section 4.3) or a `symbol`,
 * which clips as a frame (M7 contract, section 1.2).
 */
export function clipsChildren(node: NodeV3 | undefined): boolean {
  return node?.type === 'frame' || node?.type === 'maskGroup' || node?.type === 'symbol';
}

/** Clip levels above a node: one per `frame`, `maskGroup` or `symbol` ancestor (section 4.3). */
export function clipDepth(tree: TreeView, id: string): number {
  return ancestors(tree, id).filter(clipsChildren).length;
}

/** Deepest clip level a frame or mask group may sit at, and a node may sit at. */
const MAX_CLIP_CONTAINER_DEPTH = 31;
const MAX_CLIP_DEPTH = 32;

/**
 * The clip levels the frames, mask groups and symbols strictly between a source and its
 * descendants add (M7 contract, M7-S5): the most below any descendant (`node`) and below any
 * descendant that clips (`container`); -1 when there is none.
 */
export type SourceClipLevels = Readonly<{ node: number; container: number }>;

export function sourceClipLevels(tree: TreeView, source: string): SourceClipLevels {
  let node = -1;
  let container = -1;
  const stack: [string, number][] = childrenOf(tree, source).map((id) => [id, 0]);
  while (stack.length > 0) {
    const [id, level] = stack.pop()!;
    const entry = tree.node(id);
    if (entry === undefined) continue;
    const clips = clipsChildren(entry);
    if (level > node) node = level;
    if (clips && level > container) container = level;
    if (isContainer(entry)) {
      for (const child of entry.children) stack.push([child, clips ? level + 1 : level]);
    }
  }
  return { node, container };
}

/**
 * Whether an instance at clip depth `depth` breaks the clip-depth rule through its expansion
 * (M7-S5): it projects as a frame, so it may sit at 31 at most, and an expanded node sits at the
 * instance's depth plus one plus its source clip levels.
 */
export function instanceClipBreaks(depth: number, levels: SourceClipLevels): boolean {
  return (
    depth > MAX_CLIP_CONTAINER_DEPTH ||
    depth + 1 + levels.node > MAX_CLIP_DEPTH ||
    depth + 1 + levels.container > MAX_CLIP_CONTAINER_DEPTH
  );
}

/** `sourceClipLevels` once per source within one check. */
function clipLevelsMemo(tree: TreeView): (source: string) => SourceClipLevels {
  const memo = new Map<string, SourceClipLevels>();
  return (source) => {
    let levels = memo.get(source);
    if (levels === undefined) {
      levels = sourceClipLevels(tree, source);
      memo.set(source, levels);
    }
    return levels;
  };
}

/**
 * The first node of the subtrees of `roots` (pre-order) that breaks the clip-depth rule: a frame
 * or mask group at clip depth 32 or more, or a node at 33 or more (a frame's background sits at
 * the frame's depth plus one, so a frame at 31 is the deepest), or an instance whose expansion
 * breaks it (M7-S5); with `instances` false the instances are left to `instanceClipViolation`
 * (the command checks of section 5.3). Null when all fit.
 */
export function clipDepthViolation(
  tree: TreeView,
  roots: readonly string[],
  instances = true,
): string | null {
  const levelsOf = clipLevelsMemo(tree);
  for (const root of roots) {
    const stack: [string, number][] = [[root, clipDepth(tree, root)]];
    while (stack.length > 0) {
      const [id, depth] = stack.pop()!;
      const node = tree.node(id);
      if (node === undefined) continue;
      const clips = clipsChildren(node);
      if (depth > MAX_CLIP_DEPTH || (clips && depth > MAX_CLIP_CONTAINER_DEPTH)) return id;
      if (
        instances &&
        node.type === 'instance' &&
        instanceClipBreaks(depth, levelsOf(node.symbol))
      ) {
        return id;
      }
      if (isContainer(node)) {
        const next = clips ? depth + 1 : depth;
        for (let i = node.children.length - 1; i >= 0; i -= 1)
          stack.push([node.children[i]!, next]);
      }
    }
  }
  return null;
}

/**
 * The first instance of `instances` whose expansion breaks the clip-depth rule (M7-S5), or null:
 * the check every command runs over the instances of each source it may change (section 5.3).
 */
export function instanceClipViolation(tree: TreeView, instances: readonly string[]): string | null {
  const levelsOf = clipLevelsMemo(tree);
  for (const id of instances) {
    const node = tree.node(id);
    if (node?.type !== 'instance') continue;
    if (instanceClipBreaks(clipDepth(tree, id), levelsOf(node.symbol))) return id;
  }
  return null;
}

/** The first node of the subtrees of `roots` (pre-order) deeper than the M1-S3 bound, or null. */
export function treeDepthViolation(tree: TreeView, roots: readonly string[]): string | null {
  for (const root of roots) {
    const stack: [string, number][] = [[root, treeDepth(tree, root)]];
    while (stack.length > 0) {
      const [id, depth] = stack.pop()!;
      const node = tree.node(id);
      if (node === undefined) continue;
      if (depth > MAX_TREE_DEPTH) return id;
      if (isContainer(node)) {
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          stack.push([node.children[i]!, depth + 1]);
        }
      }
    }
  }
  return null;
}

/**
 * The first node of a document that breaks the clip-depth rule, in page and pre-order, an
 * instance whose expansion breaks it included (M7-S5).
 */
export function documentClipViolation(document: DocumentV3): string | null {
  const tree = documentTree(document);
  for (const page of document.pages) {
    const found = clipDepthViolation(tree, page.children);
    if (found !== null) return found;
  }
  return null;
}

/** The height of each source's subtree (0 for an empty source), once per source in one check. */
function heightMemo(tree: TreeView): (source: string) => number {
  const heights = new Map<string, number>();
  return (source) => {
    let height = heights.get(source);
    if (height !== undefined) return height;
    height = 0;
    const stack: [string, number][] = [[source, 0]];
    while (stack.length > 0) {
      const [id, below] = stack.pop()!;
      if (below > height) height = below;
      for (const child of childrenOf(tree, id)) stack.push([child, below + 1]);
    }
    heights.set(source, height);
    return height;
  };
}

/**
 * The first instance of `instances` whose deepest expanded node breaks the M7-S5 tree depth (M7
 * contract, section 2): the instance's depth plus its source subtree's height above
 * `MAX_TREE_DEPTH`. Null when none does.
 */
export function instanceTreeViolation(tree: TreeView, instances: readonly string[]): string | null {
  const heightOf = heightMemo(tree);
  for (const id of instances) {
    const node = tree.node(id);
    if (node?.type !== 'instance') continue;
    if (treeDepth(tree, id) + heightOf(node.symbol) > MAX_TREE_DEPTH) return id;
  }
  return null;
}

/** The height of a source's subtree, for the depth check of a new instance (section 5.3). */
export function sourceHeight(tree: TreeView, source: string): number {
  return heightMemo(tree)(source);
}

/**
 * What one change can break of the M7 nesting and depth rules (M7 contract, section 5.3).
 * `roots` are the nodes the change created, reparented or retyped (in `touched` order, each
 * listed once and no descendant of another root), the only places a `symbol` or `instance` can
 * newly sit inside a source. `instances` are the instances whose M7-S5 depth may have changed,
 * in `pages` order then page-tree pre-order: those in the subtrees of `roots`, and every instance,
 * on any page, of each source that holds a root. A change that creates, reparents or retypes
 * nothing finds no root and costs one lookup per touched node.
 */
export type SymbolChange = Readonly<{ roots: readonly string[]; instances: readonly string[] }>;

export function symbolChange(
  base: DocumentV3,
  document: DocumentV3,
  touched: Iterable<string>,
): SymbolChange {
  const tree = documentTree(document);
  const moved: string[] = [];
  for (const id of touched) {
    if (!Object.hasOwn(document.nodes, id)) continue;
    const node = document.nodes[id]!;
    const before = Object.hasOwn(base.nodes, id) ? base.nodes[id] : undefined;
    if (before !== undefined && before.parent === node.parent && before.type === node.type) {
      continue;
    }
    moved.push(id);
  }
  if (moved.length === 0) return { roots: [], instances: [] };
  const movedSet = new Set(moved);
  const roots = moved.filter((id) => !ancestors(tree, id).some((node) => movedSet.has(node.id)));
  const sources = new Set<string>();
  const found = new Set<string>();
  for (const root of roots) {
    const source = ancestors(tree, root).find((node) => node.type === 'symbol');
    if (source !== undefined) sources.add(source.id);
    for (const id of subtree(tree, root)) {
      if (tree.node(id)?.type === 'instance') found.add(id);
    }
  }
  if (sources.size > 0) {
    for (const id in document.nodes) {
      if (!Object.hasOwn(document.nodes, id)) continue;
      const node = document.nodes[id]!;
      if (node.type === 'instance' && sources.has(node.symbol)) found.add(id);
    }
  }
  if (found.size === 0) return { roots, instances: [] };
  return {
    roots,
    instances: pageInstances(document).flatMap((page) => page.filter((id) => found.has(id))),
  };
}

/**
 * The first `symbol` or `instance` in the subtrees of `roots` that has a `symbol` ancestor (M7-S3,
 * section 5.3: `editor.nested-symbol`), in `pages` order then page-tree pre-order, or null.
 */
export function nestedSymbolViolation(
  document: DocumentV3,
  roots: readonly string[],
): string | null {
  const tree = documentTree(document);
  const found = new Set<string>();
  for (const root of roots) {
    const stack: [string, boolean][] = [
      [root, ancestors(tree, root).some((node) => node.type === 'symbol')],
    ];
    while (stack.length > 0) {
      const [id, inSymbol] = stack.pop()!;
      const node = tree.node(id);
      if (node === undefined) continue;
      if (inSymbol && (node.type === 'symbol' || node.type === 'instance')) found.add(id);
      if (isContainer(node)) {
        const below = inSymbol || node.type === 'symbol';
        for (const child of node.children) stack.push([child, below]);
      }
    }
  }
  if (found.size === 0) return null;
  for (const page of document.pages) {
    for (const root of page.children) {
      for (const id of subtree(tree, root)) if (found.has(id)) return id;
    }
  }
  return null;
}

/**
 * The instances of each page of `document`, in `pages` order, each in page-tree pre-order (the
 * reporting order of the M7 contract, sections 3 and 4.1); empty lists when there is none.
 */
export function pageInstances(document: DocumentV3): string[][] {
  const tree = documentTree(document);
  return document.pages.map((page) =>
    page.children.flatMap((root) =>
      subtree(tree, root).filter((id) => tree.node(id)?.type === 'instance'),
    ),
  );
}

/** A JSON Pointer to a node field. */
export function nodePath(id: string, field = ''): string {
  return `/nodes/${id.replaceAll('~', '~0').replaceAll('/', '~1')}${field}`;
}
