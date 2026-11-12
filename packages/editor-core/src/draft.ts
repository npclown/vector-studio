import {
  BINDING_KEYS,
  MAX_TREE_DEPTH,
  bindingHolds,
  tablesOf,
  validateNode,
  type BindingTables,
  type Bindings,
  type DocumentV8,
  type InstanceNodeV8,
  type NodeOverride,
  type NodeV8,
  type PageV8,
  type SymbolNodeV8,
  type TextNodeV8,
} from '@vector-studio/model';
import type { ExpansionCache } from './expansion.js';
import { deepFreeze } from './freeze.js';
import { distinctVariant, namesOf, tupleKey, valueFromName } from './variant-names.js';
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
  node: NodeV8,
) => Readonly<{ code: EditorErrorCode; path: string }> | null;

/** Whether two versions of a node have the same parent, frame and rotation. */
export function samePlacement(a: NodeV8, b: NodeV8): boolean {
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
  readonly base: DocumentV8;
  private readonly nodes: Map<string, NodeV8>;
  private pages: PageV8[];
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

  /** V-39: the colour styles and variables (V39-S1, S2), carried over and replaceable. */
  private tableState: BindingTables;

  constructor(base: DocumentV8) {
    this.base = base;
    this.nodes = new Map(Object.entries(base.nodes));
    this.pages = [...base.pages];
    this.tableState = tablesOf(base);
  }

  /** The draft's colour styles and variables (V-39). */
  get tables(): BindingTables {
    return this.tableState;
  }

  /** Replaces the tables (V-39 section 3); an absent key removes that table. */
  setTables(tables: BindingTables): void {
    this.tableState = {
      ...(tables.colorStyles === undefined ? {} : { colorStyles: tables.colorStyles }),
      ...(tables.variables === undefined ? {} : { variables: tables.variables }),
    };
  }

  /** The IDs of every node, for the V-39 resync. */
  nodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  node(id: string): NodeV8 | undefined {
    return this.nodes.get(id);
  }

  page(id: string): PageV8 | undefined {
    return this.pages.find((page) => page.id === id);
  }

  get pageList(): readonly PageV8[] {
    return this.pages;
  }

  /** Replaces or adds a node; `finish` validates it with the model's field rules. */
  set(node: NodeV8): void {
    this.nodes.set(node.id, node);
    this.touched.add(node.id);
    this.unchecked.add(node.id);
    this.customChecked.delete(node.id);
  }

  /**
   * Replaces or adds a node the command has already validated with the model's rules, and with
   * its extension when `custom` is true.
   */
  setChecked(node: NodeV8, custom = false): void {
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

  setPages(pages: readonly PageV8[]): void {
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
      placementBase?: DocumentV8;
      expansions?: ExpansionCache;
      layout?: TextLayouter | undefined;
    }> = { refit: true },
  ): DocumentV8 | Failure {
    this.expansions = options.expansions;
    this.deleteEmptyGroups();
    this.normalizeVariants();
    const text = this.refitText(options.layout);
    if (text !== null) return text;
    if (options.refit) this.refit(options.placementBase ?? this.base);
    this.pruneOverrides();
    this.detachBindings();
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

  /**
   * V-39 contract, E4: each touched node loses every binding that no longer holds against the
   * draft's tables (a missing target, a field it can no longer carry, a value that differs), so
   * a direct edit of a bound property detaches it. The node keeps its unchecked state.
   */
  private detachBindings(): void {
    for (const id of this.touched) {
      const node = this.nodes.get(id);
      if (node?.bindings === undefined) continue;
      const kept: Partial<Record<(typeof BINDING_KEYS)[number], Bindings[keyof Bindings]>> = {};
      let dropped = false;
      for (const key of BINDING_KEYS) {
        const ref = node.bindings[key];
        if (ref === undefined) continue;
        if (bindingHolds(node, key, ref, this.tableState)) kept[key] = ref;
        else dropped = true;
      }
      if (!dropped) continue;
      const { bindings: _old, ...rest } = node;
      void _old;
      const next = (Object.keys(kept).length === 0 ? rest : { ...rest, bindings: kept }) as NodeV8;
      this.nodes.set(id, next);
    }
  }

  /** The current state as a frozen document, without the `finish` rules. */
  document(): DocumentV8 {
    return deepFreeze({
      schemaVersion: 8,
      id: this.base.id,
      ...this.tableState,
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
      const valid = result.node as TextNodeV8;
      const frame = refitFrame(valid, layout(valid));
      if (frame !== valid.frame) this.set({ ...valid, frame });
    }
    this.textRefits.clear();
    return null;
  }

  /**
   * Drops the override keys left without their node (deleted, moved out of the source, retyped)
   * or whose instance now names another source: a text key needs a text node (M7-T3), a property
   * key any node of the source subtree (V37-S3). A property field that no longer applies to its
   * node is dropped (V37-X4), an override left empty and an empty map are removed. Runs only when
   * the change can have done so: a touched instance, or a touched node that was a text node or a
   * container in `base`, or left, changed type or changed parent; then it visits every instance
   * with overrides.
   */
  private pruneOverrides(): void {
    let possible = false;
    for (const id of this.touched) {
      const before = Object.hasOwn(this.base.nodes, id) ? this.base.nodes[id] : undefined;
      const now = this.nodes.get(id);
      if (
        now?.type === 'instance' ||
        before?.type === 'text' ||
        isContainer(before) ||
        (before !== undefined &&
          (now === undefined || now.type !== before.type || now.parent !== before.parent))
      ) {
        possible = true;
        break;
      }
    }
    if (!possible) return;
    for (const [id, node] of this.nodes) {
      if (node.type !== 'instance') continue;
      const keys = Object.keys(node.textOverrides);
      const kept = keys.filter((key) => this.isSourceText(key, node.symbol));
      const props = this.keptProps(node);
      if (kept.length === keys.length && props === node.overrides) continue;
      const next: Record<string, unknown> = {
        ...node,
        textOverrides: Object.fromEntries(kept.map((key) => [key, node.textOverrides[key]!])),
      };
      if (props === undefined) delete next.overrides;
      else next.overrides = props;
      // Removing keys keeps a valid node valid, so it needs no new field check.
      const unchecked = this.unchecked.has(id);
      this.setChecked(next as NodeV8, this.customChecked.has(id));
      if (unchecked) this.unchecked.add(id);
    }
  }

  /**
   * The property overrides of `instance` that still satisfy V37-S3 (V37-X4): the same object when
   * none changes, undefined when none is left.
   */
  private keptProps(instance: InstanceNodeV8): InstanceNodeV8['overrides'] {
    const overrides = instance.overrides;
    if (overrides === undefined) return undefined;
    let changed = false;
    const out: Record<string, NodeOverride> = {};
    for (const key of Object.keys(overrides)) {
      const target = this.nodes.get(key);
      const isSource = key === instance.symbol;
      if (
        target === undefined ||
        (isSource ? target.type !== 'symbol' : !this.isBelow(key, instance.symbol))
      ) {
        changed = true;
        continue;
      }
      const override = overrides[key]!;
      const fields: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(override)) {
        const own = field === 'fill' || field === 'stroke';
        if (own ? field in target : !isSource) fields[field] = value;
      }
      if (Object.keys(fields).length !== Object.keys(override).length) changed = true;
      if (Object.keys(fields).length > 0) out[key] = fields;
    }
    if (!changed) return overrides;
    return Object.keys(out).length === 0 ? undefined : out;
  }

  /** Whether `symbol` is a proper ancestor of `id`. */
  private isBelow(id: string, symbol: string): boolean {
    let up = this.nodes.get(this.nodes.get(id)?.parent ?? '');
    for (let steps = 0; up !== undefined && steps <= MAX_TREE_DEPTH + 1; steps += 1) {
      if (up.id === symbol) return up.type === 'symbol';
      up = this.nodes.get(up.parent);
    }
    return false;
  }

  /** Whether `id` is a text node with the `symbol` node `symbol` among its ancestors. */
  private isSourceText(id: string, symbol: string): boolean {
    return this.nodes.get(id)?.type === 'text' && this.isBelow(id, symbol);
  }

  private deleteEmptyGroups(): void {
    let queue = [...this.touched];
    while (queue.length > 0) {
      const next: string[] = [];
      for (const id of queue) {
        const node = this.nodes.get(id);
        // A set left without children goes with its last variant (V-37 contract, section 2.1).
        if (!(isGroup(node) || node?.type === 'symbolSet') || node.children.length > 0) continue;
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

  /**
   * V-37 contract, sections 2.1 and 4.1: a symbol outside a set loses its `variant` (it left a
   * set), and a symbol that entered a set (a new node, or one whose parent changed) takes the
   * names of the set's first child before the command with that child's values, then V37-N2
   * suffixes in the set's child order. A new symbol of a new set, and a copy of a variant, keep
   * their own values (then N2). Runs only for the sets and symbols the change touched.
   */
  private normalizeVariants(): void {
    const sets = new Set<string>();
    for (const id of this.touched) {
      const node = this.nodes.get(id);
      if (node?.type === 'symbolSet') sets.add(id);
      if (node?.type !== 'symbol') continue;
      if (this.nodes.get(node.parent)?.type === 'symbolSet') sets.add(node.parent);
      else if (node.variant !== undefined) {
        const next: Record<string, unknown> = { ...node };
        delete next.variant;
        this.set(next as NodeV8);
      }
    }
    for (const id of sets) {
      const set = this.nodes.get(id);
      if (set?.type !== 'symbolSet') continue;
      const kids = set.children.map((child) => this.nodes.get(child)).filter(isSymbol);
      const baseSet = Object.hasOwn(this.base.nodes, id) ? this.base.nodes[id] : undefined;
      const wasHere = (kid: SymbolNodeV8) =>
        baseSet !== undefined &&
        Object.hasOwn(this.base.nodes, kid.id) &&
        this.base.nodes[kid.id]!.parent === id;
      const entering = kids.filter((kid) => !wasHere(kid));
      if (entering.length === 0) continue;
      const first =
        baseSet?.type === 'symbolSet' && baseSet.children.length > 0
          ? this.base.nodes[baseSet.children[0]!]
          : undefined;
      const template = first?.type === 'symbol' ? first.variant : undefined;
      const seen = new Set<string>();
      for (const kid of kids) {
        if (wasHere(kid) && kid.variant !== undefined) {
          seen.add(tupleKey(kid.variant, namesOf(kid.variant)));
        }
      }
      for (const kid of entering) {
        const isNew = !Object.hasOwn(this.base.nodes, kid.id);
        const own =
          baseSet === undefined || (isNew && kid.variant !== undefined)
            ? (kid.variant ?? { 'Property 1': valueFromName(kid.name) })
            : (template ?? { 'Property 1': valueFromName(kid.name) });
        const variant = distinctVariant(own, seen);
        if (variant !== kid.variant) this.set({ ...kid, variant });
      }
    }
  }

  private refit(placementBase: DocumentV8): void {
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

const isSymbol = (node: NodeV8 | undefined): node is SymbolNodeV8 => node?.type === 'symbol';
