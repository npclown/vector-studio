import {
  MAX_TREE_DEPTH,
  validateNode,
  type DocumentV5,
  type NodeV5,
  type PageV2,
  type TextNode,
} from '@vector-studio/model';
import type { ExpansionCache } from './expansion.js';
import { deepFreeze } from './freeze.js';
import { refitGroup, type WritableTree } from './resize.js';
import { refitFrame, type TextLayouter } from './text.js';
import { childrenOf, isContainer, isGroup, nodePath, treeDepth } from './tree.js';
import type { CommandResult, EditorErrorCode } from './types.js';

// The edit draft: a mutable copy of a document that one command changes, then validates and
// freezes. It records every node it created, changed or removed (`touched`).

export type Failure = Extract<CommandResult, { ok: false }>;

export function fail(code: EditorErrorCode, path?: string): Failure {
  return path === undefined ? { ok: false, code } : { ok: false, code, path };
}

/** The extension check of a custom node; other nodes pass. `path` is relative to the node. */
export type CustomCheck = (
  node: NodeV5,
) => Readonly<{ code: EditorErrorCode; path: string }> | null;

/** Whether two versions of a node have the same parent, frame and rotation. */
export function samePlacement(a: NodeV5, b: NodeV5): boolean {
  return (
    a.parent === b.parent &&
    a.rotation === b.rotation &&
    a.frame.x === b.frame.x &&
    a.frame.y === b.frame.y &&
    a.frame.width === b.frame.width &&
    a.frame.height === b.frame.height
  );
}

export class Draft implements WritableTree {
  readonly base: DocumentV5;
  private readonly nodes: Map<string, NodeV5>;
  private pages: PageV2[];
  /** Nodes created, changed or removed. */
  readonly touched = new Set<string>();
  /** Nodes set from derived values, validated by `finish`. */
  private readonly unchecked = new Set<string>();
  /** Custom nodes whose extension check the command already ran. */
  private readonly customChecked = new Set<string>();
  /** Text nodes whose auto dimensions `finish` refits (M6a contract, sections 6.2 and 6.3). */
  private readonly textRefits = new Set<string>();
  /**
   * The expansion cache `finish` was given: `success` (`edit-support.ts`) then checks the
   * expansions of the finished document after the structural rules (M7 contract, section 5.5),
   * and the M7 nesting and depth rules of the change against `base` (section 5.3).
   */
  expansions: ExpansionCache | undefined;

  constructor(base: DocumentV5) {
    this.base = base;
    this.nodes = new Map(Object.entries(base.nodes));
    this.pages = [...base.pages];
  }

  node(id: string): NodeV5 | undefined {
    return this.nodes.get(id);
  }

  page(id: string): PageV2 | undefined {
    return this.pages.find((page) => page.id === id);
  }

  get pageList(): readonly PageV2[] {
    return this.pages;
  }

  /** Replaces or adds a node; `finish` validates it with the model's field rules. */
  set(node: NodeV5): void {
    this.nodes.set(node.id, node);
    this.touched.add(node.id);
    this.unchecked.add(node.id);
    this.customChecked.delete(node.id);
  }

  /**
   * Replaces or adds a node the command has already validated with the model's rules, and with
   * its extension when `custom` is true.
   */
  setChecked(node: NodeV5, custom = false): void {
    this.nodes.set(node.id, node);
    this.touched.add(node.id);
    this.unchecked.delete(node.id);
    if (custom) this.customChecked.add(node.id);
    else this.customChecked.delete(node.id);
  }

  /** Records nodes an earlier step changed and validated (a gesture's updates). */
  adopt(ids: Iterable<string>): void {
    for (const id of ids) {
      this.touched.add(id);
      this.customChecked.add(id);
    }
  }

  /** Marks a text node for the refit step of `finish` (M6a contract, section 6.3). */
  markTextRefit(id: string): void {
    this.textRefits.add(id);
  }

  remove(id: string): void {
    this.nodes.delete(id);
    this.touched.add(id);
    this.unchecked.delete(id);
  }

  setPages(pages: readonly PageV2[]): void {
    this.pages = [...pages];
  }

  /** Replaces the children of a page or container. */
  setChildren(owner: string, children: readonly string[]): void {
    const index = this.pages.findIndex((page) => page.id === owner);
    if (index >= 0) {
      this.pages[index] = { ...this.pages[index]!, children: [...children] };
      return;
    }
    const node = this.nodes.get(owner);
    if (!isContainer(node)) throw new Error(`draft: ${owner} owns no children`);
    // A list of existing IDs keeps the node valid, so it needs no new field check.
    const unchecked = this.unchecked.has(owner);
    this.setChecked({ ...node, children: [...children] }, this.customChecked.has(owner));
    if (unchecked) this.unchecked.add(owner);
  }

  /**
   * Deletes groups and mask groups left without children (cascading upward), refits the auto
   * dimensions of the marked text nodes through `layout` (M6a contract, section 6.3; each node
   * is first checked with the model's rules, and without `layout` the edit fails with
   * `editor.no-text-layout`), refits the groups whose children changed placement or membership
   * against `placementBase` (innermost first), validates every derived node with the model's
   * rules and every touched custom node with its extension, and returns the frozen document.
   * The text refit runs whether or not groups refit, so a gesture update refits text too. Then
   * every instance text override whose key no longer names a text node of the instance's source
   * is dropped (M6a contract, section 9, M7-T3, keeping keys valid), in the same transaction.
   */
  finish(
    check: CustomCheck,
    options: Readonly<{
      refit: boolean;
      placementBase?: DocumentV5;
      expansions?: ExpansionCache;
      layout?: TextLayouter | undefined;
    }> = { refit: true },
  ): DocumentV5 | Failure {
    this.expansions = options.expansions;
    this.deleteEmptyGroups();
    const text = this.refitText(options.layout);
    if (text !== null) return text;
    if (options.refit) this.refit(options.placementBase ?? this.base);
    this.pruneOverrides();
    for (const id of this.unchecked) {
      const node = this.nodes.get(id);
      if (node === undefined) continue;
      const result = validateNode(node);
      if (!result.ok) return fail(result.code, nodePath(id, result.path));
      this.nodes.set(id, result.node);
    }
    for (const id of this.touched) {
      const node = this.nodes.get(id);
      if (node?.type !== 'custom' || this.customChecked.has(id)) continue;
      const rejected = check(deepFreeze(node));
      if (rejected !== null) return fail(rejected.code, nodePath(id, rejected.path));
    }
    this.unchecked.clear();
    return this.document();
  }

  /** The current state as a frozen document, without the `finish` rules. */
  document(): DocumentV5 {
    return deepFreeze({
      schemaVersion: 5,
      id: this.base.id,
      pages: this.pages,
      // fromEntries defines own properties, so a "__proto__" ID stays data.
      nodes: Object.fromEntries(this.nodes),
    });
  }

  private refitText(layout: TextLayouter | undefined): Failure | null {
    for (const id of this.textRefits) {
      const node = this.nodes.get(id);
      if (node?.type !== 'text' || node.sizing === 'fixed') continue;
      // A derived size above 4096 or of 0 fails here, before any layout (section 6.3, bounds).
      const result = validateNode(node);
      if (!result.ok) return fail(result.code, nodePath(id, result.path));
      if (layout === undefined) return fail('editor.no-text-layout');
      const valid = result.node as TextNode;
      const frame = refitFrame(valid, layout(valid));
      if (frame !== valid.frame) this.set({ ...valid, frame });
    }
    this.textRefits.clear();
    return null;
  }

  /**
   * Drops the text override keys left without their text node (deleted, moved out of the
   * source, retyped) or whose instance now names another source. Runs only when the change can
   * have done so: a touched instance, or a touched node that was a text node or a container in
   * `base`; then it visits every instance with overrides.
   */
  private pruneOverrides(): void {
    let possible = false;
    for (const id of this.touched) {
      const before = Object.hasOwn(this.base.nodes, id) ? this.base.nodes[id] : undefined;
      if (
        this.nodes.get(id)?.type === 'instance' ||
        before?.type === 'text' ||
        isContainer(before)
      ) {
        possible = true;
        break;
      }
    }
    if (!possible) return;
    for (const [id, node] of this.nodes) {
      if (node.type !== 'instance') continue;
      const keys = Object.keys(node.textOverrides);
      if (keys.length === 0) continue;
      const kept = keys.filter((key) => this.isSourceText(key, node.symbol));
      if (kept.length === keys.length) continue;
      const textOverrides = Object.fromEntries(kept.map((key) => [key, node.textOverrides[key]!]));
      // Removing keys keeps a valid node valid, so it needs no new field check.
      const unchecked = this.unchecked.has(id);
      this.setChecked({ ...node, textOverrides }, this.customChecked.has(id));
      if (unchecked) this.unchecked.add(id);
    }
  }

  /** Whether `id` is a text node with the `symbol` node `symbol` among its ancestors. */
  private isSourceText(id: string, symbol: string): boolean {
    if (this.nodes.get(id)?.type !== 'text') return false;
    let up = this.nodes.get(this.nodes.get(id)!.parent);
    for (let steps = 0; up !== undefined && steps <= MAX_TREE_DEPTH + 1; steps += 1) {
      if (up.id === symbol) return up.type === 'symbol';
      up = this.nodes.get(up.parent);
    }
    return false;
  }

  private deleteEmptyGroups(): void {
    let queue = [...this.touched];
    while (queue.length > 0) {
      const next: string[] = [];
      for (const id of queue) {
        const node = this.nodes.get(id);
        if (!isGroup(node) || node.children.length > 0) continue;
        const owner = node.parent;
        this.setChildren(
          owner,
          childrenOf(this, owner).filter((child) => child !== id),
        );
        this.remove(id);
        next.push(owner);
      }
      queue = next;
    }
  }

  private refit(placementBase: DocumentV5): void {
    const pending = new Set<string>();
    const consider = (owner: string | undefined) => {
      if (owner !== undefined && isGroup(this.nodes.get(owner))) pending.add(owner);
    };
    for (const id of this.touched) {
      const before = Object.hasOwn(placementBase.nodes, id) ? placementBase.nodes[id] : undefined;
      const after = this.nodes.get(id);
      if (before !== undefined && after !== undefined && samePlacement(before, after)) continue;
      consider(before?.parent);
      consider(after?.parent);
    }
    while (pending.size > 0) {
      // Innermost first: the deepest pending group refits before any of its ancestors.
      let deepest = '';
      let depth = -1;
      for (const id of pending) {
        const d = treeDepth(this, id);
        if (d > depth) {
          deepest = id;
          depth = d;
        }
      }
      pending.delete(deepest);
      if (refitGroup(this, deepest)) consider(this.nodes.get(deepest)?.parent);
    }
  }
}
