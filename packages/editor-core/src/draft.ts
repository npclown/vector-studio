import {
  BINDING_KEYS,
  MAX_TREE_DEPTH,
  bindingHolds,
  tablesOf,
  validateNode,
  type BindingTables,
  type Bindings,
  type DocumentV8,
  type Frame,
  type LayoutFields,
  type NodeV8,
  type PageV8,
  type TextNodeV8,
} from '@vector-studio/model';
import {
  autoLayoutOf,
  layoutFrame,
  layoutSizingOf,
  NoTextLayoutError,
  participantsOf,
} from './auto-layout.js';
import type { ExpansionCache } from './expansion.js';
import { rotatedBounds } from './geometry.js';
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

/** Whether two optional V-34 values are equal (JSON of plain records, keys in fixed order). */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function sameChildren(a: NodeV8, b: NodeV8): boolean {
  const x = (a as { children?: readonly string[] }).children ?? [];
  const y = (b as { children?: readonly string[] }).children ?? [];
  return x.length === y.length && x.every((id, i) => id === y[i]);
}

export class Draft implements WritableTree {
  readonly base: DocumentV8;
  /** The draft resizes auto-layout frames without their constraints (V-34 section 4.3). */
  readonly layoutAware = true;
  /** Nodes a command targeted for placement (V-34 section 4.1): drop-order candidates. */
  readonly placed = new Set<string>();
  /** Nodes a command resized, with their frame before (V-34 section 4.2). */
  readonly resized = new Map<string, Frame>();
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

  /** Records a command's placement target (V-34 section 4.1). */
  markPlaced(id: string): void {
    this.placed.add(id);
  }

  /** Records a node the command resized from `before` (V-34 section 4.2); the first wins. */
  markResized(id: string, before: Frame): void {
    if (!this.resized.has(id)) this.resized.set(id, before);
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
      /** A gesture's accumulated placement targets and resizes (V-34 section 4.1). */
      placed?: Iterable<string> | undefined;
      resized?: ReadonlyMap<string, Frame> | undefined;
    }> = { refit: true },
  ): DocumentV8 | Failure {
    this.expansions = options.expansions;
    for (const id of options.placed ?? []) this.placed.add(id);
    for (const [id, frame] of options.resized ?? []) this.markResized(id, frame);
    this.deleteEmptyGroups();
    const text = this.refitText(options.layout);
    if (text !== null) return text;
    try {
      this.refit(options.placementBase ?? this.base, options.refit, options.layout);
    } catch (error) {
      if (error instanceof NoTextLayoutError) return fail('editor.no-text-layout');
      throw error;
    }
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

  /**
   * The group refit (M1 contract, section 4.2) and the V-34 layout pass (section 4.3) over one
   * pending set, deepest node first. Groups refit only when `groups` holds (not on gesture
   * updates); auto-layout frames lay out either way, with section 4.1's drop order, or with its
   * float rule on gesture updates.
   */
  private refit(
    placementBase: DocumentV8,
    groups: boolean,
    measure: TextLayouter | undefined,
  ): void {
    const before = (id: string) =>
      Object.hasOwn(placementBase.nodes, id) ? placementBase.nodes[id] : undefined;
    this.applySizingRules();
    const pending = new Set<string>();
    const done = new Set<string>();
    const consider = (owner: string | undefined) => {
      if (owner === undefined || done.has(owner)) return;
      const node = this.nodes.get(owner);
      if ((groups && isGroup(node)) || autoLayoutOf(node) !== null) pending.add(owner);
    };
    const seed = (owner: string | undefined) => {
      if (owner !== undefined && autoLayoutOf(this.nodes.get(owner)) !== null) pending.add(owner);
    };
    // Drop-order candidates per auto-layout frame (section 4.1), and the floating ones.
    const candidates = new Map<string, string[]>();
    const floating = new Set<string>();
    for (const id of this.touched) {
      const old = before(id);
      const now = this.nodes.get(id);
      if (now !== undefined && autoLayoutOf(now) !== null) {
        if (
          old === undefined ||
          autoLayoutOf(old) === null ||
          !sameValue((old as LayoutFields).autoLayout, (now as LayoutFields).autoLayout) ||
          !sameValue(layoutSizingOf(old), layoutSizingOf(now)) ||
          old.frame.width !== now.frame.width ||
          old.frame.height !== now.frame.height ||
          !sameChildren(old, now)
        ) {
          seed(id);
        }
      }
      if (groups && (old === undefined || now === undefined || !samePlacement(old, now))) {
        consider(old?.parent);
        consider(now?.parent);
      }
      if (now !== undefined && autoLayoutOf(this.nodes.get(now.parent)) !== null) {
        const owner = now.parent;
        const entered = old === undefined || old.parent !== owner;
        const translated =
          !entered &&
          this.placed.has(id) &&
          old.rotation === now.rotation &&
          old.frame.width === now.frame.width &&
          old.frame.height === now.frame.height &&
          (old.frame.x !== now.frame.x || old.frame.y !== now.frame.y);
        if (translated && !groups) {
          floating.add(id);
        } else {
          if (entered || translated) {
            const list = candidates.get(owner) ?? [];
            list.push(id);
            candidates.set(owner, list);
          }
          if (
            entered ||
            !samePlacement(old, now) ||
            old.visible !== now.visible ||
            !sameValue(layoutSizingOf(old), layoutSizingOf(now))
          ) {
            seed(owner);
          }
        }
      }
      if (old !== undefined && old.parent !== now?.parent) seed(old.parent);
    }
    for (const [owner, ids] of candidates) this.dropOrder(owner, ids);
    const env = { tree: this, measure, floating };
    while (pending.size > 0) {
      // Innermost first: the deepest pending node before any of its ancestors.
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
      done.add(deepest);
      const node = this.nodes.get(deepest);
      const changed =
        autoLayoutOf(node) !== null
          ? layoutFrame(env, deepest)
          : groups && refitGroup(this, deepest);
      if (changed) consider(this.nodes.get(deepest)?.parent);
    }
  }

  /**
   * Section 4.2: a hug axis of a resized auto-layout frame, and a fill axis of a resized child
   * of one, whose size changed become fixed.
   */
  private applySizingRules(): void {
    for (const [id, before] of this.resized) {
      const node = this.nodes.get(id);
      if (node === undefined) continue;
      const sizing = layoutSizingOf(node);
      const own = autoLayoutOf(node) !== null;
      const inLayout = autoLayoutOf(this.nodes.get(node.parent)) !== null;
      const next = { ...sizing };
      for (const axis of ['horizontal', 'vertical'] as const) {
        const size = axis === 'horizontal' ? node.frame.width : node.frame.height;
        const old = axis === 'horizontal' ? before.width : before.height;
        if (size === old) continue;
        if ((own && sizing[axis] === 'hug') || (inLayout && sizing[axis] === 'fill')) {
          next[axis] = 'fixed';
        }
      }
      if (next.horizontal === sizing.horizontal && next.vertical === sizing.vertical) continue;
      this.set(withSizing(node, next));
    }
  }

  /** Section 4.1: each candidate moves before the first participant whose centre is past its own. */
  private dropOrder(owner: string, ids: readonly string[]): void {
    const frame = this.nodes.get(owner)!;
    const layout = autoLayoutOf(frame)!;
    const centre = (id: string) => {
      const box = rotatedBounds(this.nodes.get(id)!);
      return layout.direction === 'horizontal' ? box.x + box.width / 2 : box.y + box.height / 2;
    };
    const visible = new Set(
      participantsOf({ tree: this, measure: undefined }, frame).map((n) => n.id),
    );
    const moving = (frame as { children: readonly string[] }).children.filter(
      (id) => ids.includes(id) && visible.has(id),
    );
    if (moving.length === 0) return;
    const list = childrenOf(this, owner).filter((id) => !moving.includes(id));
    for (const id of moving) {
      const own = centre(id);
      const index = list.findIndex(
        (other) => visible.has(other) && !moving.includes(other) && centre(other) > own,
      );
      if (index < 0) list.push(id);
      else list.splice(index, 0, id);
    }
    this.setChildren(owner, list);
  }
}

/** `node` with `sizing`, the field left out when fixed on both axes (V34-S2). */
export function withSizing(node: NodeV8, sizing: LayoutFields['layoutSizing']): NodeV8 {
  const copy = { ...node } as NodeV8 & LayoutFields & { layoutSizing?: unknown };
  if (sizing === undefined || (sizing.horizontal === 'fixed' && sizing.vertical === 'fixed')) {
    delete copy.layoutSizing;
  } else {
    copy.layoutSizing = sizing;
  }
  return copy;
}
