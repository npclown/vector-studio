import { validateNode, type DocumentV3, type NodeV3, type PageV2 } from '@vector-studio/model';
import { deepFreeze } from './freeze.js';
import { refitGroup, type WritableTree } from './resize.js';
import {
  childrenOf,
  expansionDepthViolation,
  isContainer,
  isGroup,
  nodePath,
  treeDepth,
} from './tree.js';
import type { CommandResult, EditorErrorCode } from './types.js';

// The edit draft: a mutable copy of a document that one command changes, then validates and
// freezes. It records every node it created, changed or removed (`touched`).

export type Failure = Extract<CommandResult, { ok: false }>;

export function fail(code: EditorErrorCode, path?: string): Failure {
  return path === undefined ? { ok: false, code } : { ok: false, code, path };
}

/** The extension check of a custom node; other nodes pass. `path` is relative to the node. */
export type CustomCheck = (
  node: NodeV3,
) => Readonly<{ code: EditorErrorCode; path: string }> | null;

function samePlacement(a: NodeV3, b: NodeV3): boolean {
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
  readonly base: DocumentV3;
  private readonly nodes: Map<string, NodeV3>;
  private pages: PageV2[];
  /** Nodes created, changed or removed. */
  readonly touched = new Set<string>();
  /** Nodes set from derived values, validated by `finish`. */
  private readonly unchecked = new Set<string>();
  /** Custom nodes whose extension check the command already ran. */
  private readonly customChecked = new Set<string>();

  constructor(base: DocumentV3) {
    this.base = base;
    this.nodes = new Map(Object.entries(base.nodes));
    this.pages = [...base.pages];
  }

  node(id: string): NodeV3 | undefined {
    return this.nodes.get(id);
  }

  page(id: string): PageV2 | undefined {
    return this.pages.find((page) => page.id === id);
  }

  get pageList(): readonly PageV2[] {
    return this.pages;
  }

  /** Replaces or adds a node; `finish` validates it with the model's field rules. */
  set(node: NodeV3): void {
    this.nodes.set(node.id, node);
    this.touched.add(node.id);
    this.unchecked.add(node.id);
    this.customChecked.delete(node.id);
  }

  /**
   * Replaces or adds a node the command has already validated with the model's rules, and with
   * its extension when `custom` is true.
   */
  setChecked(node: NodeV3, custom = false): void {
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
   * Deletes groups and mask groups left without children (cascading upward), refits the groups
   * whose children changed placement or membership against `placementBase` (innermost first),
   * validates every derived node with the model's rules and every touched custom node with its
   * extension, and returns the frozen document.
   */
  finish(
    check: CustomCheck,
    options: Readonly<{ refit: boolean; placementBase?: DocumentV3 }> = { refit: true },
  ): DocumentV3 | Failure {
    this.deleteEmptyGroups();
    if (options.refit) this.refit(options.placementBase ?? this.base);
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
    const document = this.document();
    // Interim until M7-U4's command checks (M7 contract, section 5.3): no command commits a
    // document whose expansions break the M7-S5 tree depth; the model's code and path.
    const deep = expansionDepthViolation(document);
    return deep === null ? document : fail('document.invalid-field', nodePath(deep, '/parent'));
  }

  /** The current state as a frozen document, without the `finish` rules. */
  document(): DocumentV3 {
    return deepFreeze({
      schemaVersion: 3,
      id: this.base.id,
      pages: this.pages,
      // fromEntries defines own properties, so a "__proto__" ID stays data.
      nodes: Object.fromEntries(this.nodes),
    });
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

  private refit(placementBase: DocumentV3): void {
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
