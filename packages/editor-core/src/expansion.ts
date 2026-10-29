import { validateNode, type DocumentV3, type NodeV3, type SymbolNode } from '@vector-studio/model';
import { fail, samePlacement, type CustomCheck, type Failure } from './draft.js';
import { deepFreeze } from './freeze.js';
import { mapNode, refitGroup, scaleAbout, type WritableTree } from './resize.js';
import { isContainer, isGroup, nodePath, pageInstances } from './tree.js';

// Instance expansion (MVP M7 contract, section 3): the content of an instance is derived from
// its source, never stored. Under M7-Q4 (c) the copies of the source's descendants map by the
// instance's scale as a group resize does (`mapNode`, then groups refit innermost first); at equal
// size they are the source's own node objects. The cache (M7-X4) keys every result by node
// identity, and the checks of M7-X3 and section 4.1 run over every instance of a document.

/** Scene nodes the instances of one page may add (section 4.1; provisional, M7-Q13). */
export const MAX_EXPANDED_NODES = 100_000;
/** Scene nodes the instances of one document may add (section 4.1; provisional, M7-Q13). */
export const MAX_EXPANDED_NODES_TOTAL = 1_000_000;

/** The content of one instance. */
export type Expansion = Readonly<{
  /** The source's children in paint order: the roots of the expanded tree. */
  children: readonly string[];
  /**
   * The expanded nodes keyed by their source node IDs, in the source's pre-order. The map is
   * shared by every caller of the cache and must not be changed (a `ReadonlyMap`; a `Map` cannot
   * be frozen, so consumers such as the M7-U3 projector rely on the type). Each keeps the
   * source node's `id` and `parent` (the source's direct children name the source), and frames
   * are in the space of the instance's content (`0, 0, width, height`).
   */
  nodes: ReadonlyMap<string, NodeV3>;
}>;

export type ExpansionResult =
  | Readonly<{ ok: true; expansion: Expansion }>
  | Readonly<{
      ok: false;
      code: 'editor.invalid-expansion';
      /** The instance's path, `/nodes/<instance>`. */
      path: string;
      /** The source node whose expanded copy failed. */
      node: string;
    }>;

/** One direct child of a source: the node objects of its subtree, in pre-order. */
type ChildState = Readonly<{ id: string; objects: readonly NodeV3[]; count: number }>;

/** A source as one document holds it; reused while every node object is the same. */
type SourceState = Readonly<{
  node: SymbolNode;
  children: readonly ChildState[];
  /** Scene nodes one instance of the source adds (section 4.1). */
  count: number;
}>;

/** An expanded subtree, or the source node whose copy failed. */
type Subtree = Readonly<{
  child: ChildState;
  sx: number;
  sy: number;
  nodes: readonly NodeV3[] | Readonly<{ failed: string }>;
}>;

type Entry = Readonly<{
  instance: NodeV3;
  source: SourceState;
  subtrees: readonly Subtree[];
  result: ExpansionResult;
}>;

const PASS: CustomCheck = () => null;

/** The node objects of the subtree of `id` in `document`, in pre-order. */
function subtreeObjects(document: DocumentV3, id: string): NodeV3[] {
  const out: NodeV3[] = [];
  const stack = [id];
  while (stack.length > 0) {
    const next = stack.pop()!;
    const node = Object.hasOwn(document.nodes, next) ? document.nodes[next] : undefined;
    if (node === undefined) continue;
    out.push(node);
    if (isContainer(node)) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]!);
    }
  }
  return out;
}

function sameObjects(a: readonly NodeV3[], b: readonly NodeV3[]): boolean {
  return a.length === b.length && a.every((node, i) => node === b[i]);
}

/**
 * Scene nodes an expanded subtree adds: one per node, and a frame's content, background and
 * border nodes (M1 contract, section 5) when present.
 */
function sceneCount(objects: readonly NodeV3[]): number {
  let count = 0;
  for (const node of objects) {
    count += 1;
    if (node.type === 'frame') {
      count += 1 + (node.fill === null ? 0 : 1) + (node.stroke === null ? 0 : 1);
    }
  }
  return count;
}

/** The instance's scale per axis: an axis whose source size is 0 is not scaled (M7-X1). */
function scaleOf(instance: NodeV3, source: SymbolNode): { sx: number; sy: number } {
  const { width, height } = source.frame;
  return {
    sx: width === 0 ? 1 : instance.frame.width / width,
    sy: height === 0 ? 1 : instance.frame.height / height,
  };
}

/**
 * Refits the groups of the subtree of `id` whose children changed placement, innermost first,
 * as the edit draft does after a group resize (M1 contract, section 4.2). Returns whether `id`
 * itself changed placement.
 */
function refitChanged(
  tree: WritableTree,
  id: string,
  original: ReadonlyMap<string, NodeV3>,
): boolean {
  const node = tree.node(id)!;
  if (isContainer(node)) {
    let moved = false;
    for (const child of node.children) {
      if (refitChanged(tree, child, original)) moved = true;
    }
    if (moved && isGroup(node)) refitGroup(tree, id);
  }
  return !samePlacement(original.get(id)!, tree.node(id)!);
}

/**
 * The expanded copies of one source child's subtree at scale `(sx, sy)` (M7-X1), each checked
 * with the model's field rules and, for a custom node, `check` (M7-X3). At `(1, 1)` the source's
 * own objects are the copies.
 */
function expandSubtree(
  child: ChildState,
  sx: number,
  sy: number,
  check: CustomCheck,
): Subtree['nodes'] {
  if (sx === 1 && sy === 1) return child.objects;
  const original = new Map(child.objects.map((node) => [node.id, node]));
  const local = new Map(original);
  const tree: WritableTree = {
    node: (id) => local.get(id),
    page: () => undefined,
    set: (node) => {
      local.set(node.id, node);
    },
  };
  // About the source's local origin, as a group resize maps its children (M7-X1).
  mapNode(tree, child.id, scaleAbout(sx, sy));
  refitChanged(tree, child.id, original);
  const out: NodeV3[] = [];
  for (const source of child.objects) {
    const node = local.get(source.id)!;
    if (node === source) {
      out.push(source);
      continue;
    }
    const result = validateNode(node);
    if (!result.ok) return { failed: source.id };
    const copy = deepFreeze(result.node);
    if (check(copy) !== null) return { failed: source.id };
    out.push(copy);
  }
  return out;
}

/**
 * One expansion cache per editor (M7-X4), shared by the checks, the projector and hit testing:
 * a source is compared with its last state once per symbol per document, an instance's expansion
 * is recomputed only when the instance node or a node object of its source changed, and within a
 * recomputed expansion each subtree under a direct child of the source is reused while its node
 * objects and the scale are unchanged.
 */
export class ExpansionCache {
  private readonly check: CustomCheck;
  private document: DocumentV3 | null = null;
  /** Source states compared against `document`. */
  private checked = new Map<string, SourceState>();
  private readonly sources = new Map<string, SourceState>();
  private readonly entries = new Map<string, Entry>();
  /** Subtrees expanded rather than reused so far; for tests of the reuse rule. */
  computed = 0;

  /** `check` is the extension check of a custom node (M7-X3); by default every node passes. */
  constructor(check: CustomCheck = PASS) {
    this.check = check;
  }

  /** The expansion of instance `id` in `document`, or null when `id` is not an instance. */
  expand(document: DocumentV3, id: string): ExpansionResult | null {
    this.use(document);
    const instance = Object.hasOwn(document.nodes, id) ? document.nodes[id]! : undefined;
    if (instance?.type !== 'instance') return null;
    const source = this.source(document, instance.symbol);
    if (source === null) return null;
    const entry = this.entries.get(id);
    if (entry !== undefined && entry.instance === instance && entry.source === source) {
      return entry.result;
    }
    const { sx, sy } = scaleOf(instance, source.node);
    // The reuse key is the scale: under M7-Q4 (c) a subtree's copies are a pure function of its
    // nodes and `(sx, sy)`. If M7-Q4 ever switches to (a) (constraints), the key must become the
    // source and instance sizes, since `startEnd` and `end` margins depend on absolute sizes.
    const reusable = new Map<ChildState, Subtree>();
    for (const subtree of entry?.subtrees ?? []) {
      if (subtree.sx === sx && subtree.sy === sy) reusable.set(subtree.child, subtree);
    }
    const subtrees: Subtree[] = [];
    const nodes = new Map<string, NodeV3>();
    let failed: string | null = null;
    for (const child of source.children) {
      let subtree = reusable.get(child);
      if (subtree === undefined) {
        this.computed += 1;
        subtree = { child, sx, sy, nodes: expandSubtree(child, sx, sy, this.check) };
      }
      subtrees.push(subtree);
      if ('failed' in subtree.nodes) {
        failed = subtree.nodes.failed;
        break;
      }
      for (const node of subtree.nodes) nodes.set(node.id, node);
    }
    const result: ExpansionResult = deepFreeze(
      failed === null
        ? { ok: true, expansion: { children: source.node.children, nodes } }
        : { ok: false, code: 'editor.invalid-expansion', path: nodePath(id), node: failed },
    );
    this.entries.set(id, { instance, source, subtrees, result });
    return result;
  }

  /** Scene nodes one instance of `symbol` adds in `document` (section 4.1), or 0. */
  count(document: DocumentV3, symbol: string): number {
    this.use(document);
    return this.source(document, symbol)?.count ?? 0;
  }

  /** Starts a new document: drops the entries of nodes it no longer holds. */
  private use(document: DocumentV3): void {
    if (document === this.document) return;
    this.document = document;
    this.checked = new Map();
    const holds = (id: string, type: NodeV3['type']) =>
      Object.hasOwn(document.nodes, id) && document.nodes[id]!.type === type;
    for (const id of this.entries.keys()) if (!holds(id, 'instance')) this.entries.delete(id);
    for (const id of this.sources.keys()) if (!holds(id, 'symbol')) this.sources.delete(id);
  }

  private source(document: DocumentV3, id: string): SourceState | null {
    const known = this.checked.get(id);
    if (known !== undefined) return known;
    const node = Object.hasOwn(document.nodes, id) ? document.nodes[id]! : undefined;
    if (node?.type !== 'symbol') return null;
    const previous = this.sources.get(id);
    const before = new Map(previous?.children.map((child) => [child.id, child]));
    const children = node.children.map((child): ChildState => {
      const objects = subtreeObjects(document, child);
      const old = before.get(child);
      return old !== undefined && sameObjects(old.objects, objects)
        ? old
        : { id: child, objects, count: sceneCount(objects) };
    });
    const unchanged =
      previous !== undefined &&
      previous.node === node &&
      children.every((child, i) => child === previous.children[i]);
    const state: SourceState = unchanged
      ? previous
      : {
          node,
          children,
          // The instance's outer and content nodes, and its background and border when present.
          count:
            2 +
            (node.fill === null ? 0 : 1) +
            (node.stroke === null ? 0 : 1) +
            children.reduce((sum, child) => sum + child.count, 0),
        };
    this.sources.set(id, state);
    this.checked.set(id, state);
    return state;
  }
}

function hasInstance(document: DocumentV3): boolean {
  for (const id in document.nodes) {
    if (Object.hasOwn(document.nodes, id) && document.nodes[id]!.type === 'instance') return true;
  }
  return false;
}

/**
 * The expansion of instance `id` (M7-X1, M7-X2): a pure function of the document, null when `id`
 * is not an instance of a source in it. `check` is the extension check of custom nodes (M7-X3).
 */
export function expandInstance(
  document: DocumentV3,
  id: string,
  check: CustomCheck = PASS,
): ExpansionResult | null {
  return new ExpansionCache(check).expand(document, id);
}

/**
 * The expansion rules of a finished document, in the section 5.5 order: every expansion's
 * validity (`editor.invalid-expansion`, M7-X3), then the caps (`editor.expansion-limit`, section
 * 4.1), each naming the first failing instance in `pages` order, then page-tree pre-order.
 * Validity is checked up to the instance that crosses a cap, so the work stays bounded by the
 * caps; the cache makes an unchanged instance's check one lookup. The clip and tree depth through
 * an expansion are checked before this: per command for the instances a change can deepen
 * (section 5.3, `success` in `edit-support.ts`), and on load for the whole document. Null when
 * the document passes.
 */
export function expansionFailure(document: DocumentV3, cache: ExpansionCache): Failure | null {
  // A document without instances pays one scan of its node map, not the page walks.
  if (!hasInstance(document)) return null;
  const pages = pageInstances(document);
  const instances = pages.flat();
  if (instances.length === 0) return null;
  let crossing: string | null = null;
  let total = 0;
  let last = instances.length - 1;
  let index = 0;
  for (const page of pages) {
    let onPage = 0;
    for (const id of page) {
      const node = document.nodes[id]!;
      const count = node.type === 'instance' ? cache.count(document, node.symbol) : 0;
      onPage += count;
      total += count;
      if (onPage > MAX_EXPANDED_NODES || total > MAX_EXPANDED_NODES_TOTAL) {
        crossing = id;
        last = index;
        break;
      }
      index += 1;
    }
    if (crossing !== null) break;
  }
  for (let i = 0; i <= last; i += 1) {
    const result = cache.expand(document, instances[i]!);
    if (result !== null && !result.ok) return fail(result.code, result.path);
  }
  return crossing === null ? null : fail('editor.expansion-limit', nodePath(crossing));
}
