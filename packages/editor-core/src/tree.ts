import {
  MAX_TREE_DEPTH,
  type ContainerNode,
  type DocumentV2,
  type GroupNode,
  type NodeV2,
  type PageV2,
} from '@vector-studio/model';
import { IDENTITY, localTransform, multiply, type Matrix } from './geometry.js';

// Tree queries over a v2 document (M1 contract, M1-S3). The model bounds the tree depth by 256,
// so every walk up the parent chain is bounded.

/** Read access to a document tree, shared by documents and the edit draft. */
export interface TreeView {
  node(id: string): NodeV2 | undefined;
  page(id: string): PageV2 | undefined;
}

export function documentTree(document: DocumentV2): TreeView {
  return {
    node: (id) => (Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined),
    page: (id) => document.pages.find((page) => page.id === id),
  };
}

export function isContainer(node: NodeV2 | undefined): node is ContainerNode {
  return (
    node !== undefined &&
    (node.type === 'group' || node.type === 'maskGroup' || node.type === 'frame')
  );
}

/** A `group` or `maskGroup`: the containers that refit to their children. */
export function isGroup(node: NodeV2 | undefined): node is GroupNode {
  return node !== undefined && (node.type === 'group' || node.type === 'maskGroup');
}

/** Container ancestors of `id`, innermost first. */
export function ancestors(tree: TreeView, id: string): ContainerNode[] {
  const chain: ContainerNode[] = [];
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

/** Clip levels above a node: one per `frame` or `maskGroup` ancestor (section 4.3). */
export function clipDepth(tree: TreeView, id: string): number {
  return ancestors(tree, id).filter((node) => node.type === 'frame' || node.type === 'maskGroup')
    .length;
}

/** Deepest clip level a frame or mask group may sit at, and a node may sit at. */
const MAX_CLIP_CONTAINER_DEPTH = 31;
const MAX_CLIP_DEPTH = 32;

/**
 * The first node of the subtrees of `roots` (pre-order) that breaks the clip-depth rule: a frame
 * or mask group at clip depth 32 or more, or a node at 33 or more (a frame's background sits at
 * the frame's depth plus one, so a frame at 31 is the deepest). Null when all fit.
 */
export function clipDepthViolation(tree: TreeView, roots: readonly string[]): string | null {
  for (const root of roots) {
    const stack: [string, number][] = [[root, clipDepth(tree, root)]];
    while (stack.length > 0) {
      const [id, depth] = stack.pop()!;
      const node = tree.node(id);
      if (node === undefined) continue;
      const clips = node.type === 'frame' || node.type === 'maskGroup';
      if (depth > MAX_CLIP_DEPTH || (clips && depth > MAX_CLIP_CONTAINER_DEPTH)) return id;
      if (isContainer(node)) {
        const next = clips ? depth + 1 : depth;
        for (let i = node.children.length - 1; i >= 0; i -= 1)
          stack.push([node.children[i]!, next]);
      }
    }
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

/** The first node of a document that breaks the clip-depth rule, in page and pre-order. */
export function documentClipViolation(document: DocumentV2): string | null {
  const tree = documentTree(document);
  for (const page of document.pages) {
    const found = clipDepthViolation(tree, page.children);
    if (found !== null) return found;
  }
  return null;
}

/** A JSON Pointer to a node field. */
export function nodePath(id: string, field = ''): string {
  return `/nodes/${id.replaceAll('~', '~0').replaceAll('/', '~1')}${field}`;
}
