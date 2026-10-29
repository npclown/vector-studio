import { isValidId, type DocumentV3, type NodeV3 } from '@vector-studio/model';
import { fail, type Draft, type Failure } from './draft.js';
import { expansionFailure, type ExpansionCache } from './expansion.js';
import type { CustomDefaults, CustomFailure } from './extensions.js';
import {
  clipDepthViolation,
  documentTree,
  instanceClipViolation,
  instanceTreeViolation,
  nestedSymbolViolation,
  nodePath,
  symbolChange,
} from './tree.js';
import type { IdSource, PagePoint } from './types.js';

// Shared support for the document edits (`edits.ts`) and the arrange commands (`arrange.ts`):
// result and context types, argument checks, the structural rules of M1 section 4.3.1 and ID
// drawing. Kept apart so that neither module imports the other.

export type EditResult =
  | Readonly<{
      ok: true;
      document: DocumentV3;
      /** Nodes created, changed or removed. */
      touched: readonly string[];
      /** Nodes or pages the command created. */
      created: readonly string[];
      /** The IDs the command returns when they are not `created` (the path commands, M3). */
      ids?: readonly string[];
    }>
  | Failure;

/** The extension checks edits need (an `ExtensionRegistry`). */
export type CustomRules = Readonly<{
  check(node: NodeV3): CustomFailure | null;
  defaults(customType: string): CustomDefaults;
}>;

export type EditContext = Readonly<{
  ids: IdSource;
  custom?: CustomRules;
  /** Creation without `parent` uses this page's root. */
  activePage: string;
  /** False during a gesture update: groups refit only at commit (section 4.2). */
  refit?: boolean;
  /**
   * A gesture's pre-gesture document. A container resized during the gesture applies the resize
   * rules from its state there, so each update is independent of the ones before it.
   */
  resizeBase?: DocumentV3;
  /**
   * The session state `paste` reads (M2 contract, section 6): the in-memory clipboard, used when
   * the command has no `text`, and the scope and selection that pick its target parent.
   */
  clipboard?: string | null;
  scope?: string | null;
  selection?: readonly string[];
  /**
   * The editor's expansion cache (M7 contract, M7-X4), which the expansion checks of every
   * command use; without it a command uses a fresh cache with `custom`'s check.
   */
  expansions?: ExpansionCache;
}>;

export const ID_ATTEMPTS = 1000;
export const PENDING_ID = 'pending';

export function freshId(document: DocumentV3, ids: IdSource): string | null {
  for (let attempt = 0; attempt < ID_ATTEMPTS; attempt += 1) {
    const id = ids();
    if (
      isValidId(id) &&
      !document.pages.some((page) => page.id === id) &&
      !Object.hasOwn(document.nodes, id)
    ) {
      return id;
    }
  }
  return null;
}

export function uniqueIds(ids: unknown): readonly string[] | null {
  if (!Array.isArray(ids)) return null;
  const seen = new Set<string>();
  for (const id of ids as unknown[]) {
    if (typeof id !== 'string' || seen.has(id)) return null;
    seen.add(id);
  }
  return [...seen];
}

export function nodeOf(document: DocumentV3, id: unknown): NodeV3 | undefined {
  return typeof id === 'string' && Object.hasOwn(document.nodes, id)
    ? document.nodes[id]
    : undefined;
}

export function inserted<T>(list: readonly T[], index: number, items: readonly T[]): T[] {
  return [...list.slice(0, index), ...items, ...list.slice(index)];
}

/**
 * The structural rules checked after a command's document is built, in the section 4.3.1 table
 * order: every touched mask group keeps a path as its first child, then no `symbol` or
 * `instance` lands inside a `symbol` (M7 contract, section 5.3, `editor.nested-symbol` at the
 * first such node's `/parent`), then the clip depth of the subtrees whose ancestry changed.
 */
export function structural(
  document: DocumentV3,
  touched: Iterable<string>,
  clipRoots: readonly string[],
  nestingRoots: readonly string[] = [],
): Failure | null {
  for (const id of touched) {
    const node = nodeOf(document, id);
    if (node?.type !== 'maskGroup') continue;
    if (document.nodes[node.children[0]!]?.type !== 'path') {
      return fail('editor.invalid-mask-source', nodePath(id, '/children/0'));
    }
  }
  const nested = nestingRoots.length === 0 ? null : nestedSymbolViolation(document, nestingRoots);
  if (nested !== null) return fail('editor.nested-symbol', nodePath(nested, '/parent'));
  // The M7-S5 clip depth of instances follows, in page order, in `success`.
  const deep = clipDepthViolation(documentTree(document), clipRoots, false);
  return deep === null ? null : fail('editor.clip-depth', nodePath(deep, '/parent'));
}

/**
 * The rules every command's result passes after `Draft.finish`, in the M1 section 4.3.1 order
 * extended by the M7 contract, section 5.5: the M7-S5 tree depth of the instances the change can
 * deepen (`document.invalid-field`), the structural rules (mask source, nesting, the clip depth
 * of the changed subtrees), the M7-S5 clip depth of the instances the change can deepen
 * (`editor.clip-depth`), then every expansion's validity and the caps. The depth checks visit
 * only the instances of `symbolChange` (section 5.3): those in a created, reparented or retyped
 * subtree and every instance of a source that holds one, so a change that adds nothing to a
 * source and moves no instance checks none.
 */
export function success(
  document: DocumentV3 | Failure,
  draft: Draft,
  created: readonly string[],
  clipRoots: readonly string[] = [],
): EditResult {
  if ('ok' in document) return document;
  const change = symbolChange(draft.base, document, draft.touched);
  const tree = documentTree(document);
  const tall = instanceTreeViolation(tree, change.instances);
  if (tall !== null) return fail('document.invalid-field', nodePath(tall, '/parent'));
  const rejected = structural(document, draft.touched, clipRoots, change.roots);
  if (rejected !== null) return rejected;
  const deep = instanceClipViolation(tree, change.instances);
  if (deep !== null) return fail('editor.clip-depth', nodePath(deep, '/parent'));
  // Then the expansions of every instance (M7 contract, sections 3 and 4.1, order of 5.5).
  const expansion =
    draft.expansions === undefined ? null : expansionFailure(document, draft.expansions);
  if (expansion !== null) return expansion;
  return { ok: true, document, touched: [...draft.touched], created };
}

export function isPoint(value: unknown): value is PagePoint {
  const point = value as PagePoint | null;
  return (
    typeof point === 'object' &&
    point !== null &&
    typeof point.x === 'number' &&
    Number.isFinite(point.x) &&
    typeof point.y === 'number' &&
    Number.isFinite(point.y)
  );
}

/**
 * `count` placeholder IDs (`pending-1`, `pending-2`, ...) that no page or node of `document` has,
 * for the trial build a creating command checks before it draws any ID (M2 contract, S8).
 */
export function placeholderIds(document: DocumentV3, count: number): string[] {
  const placeholders: string[] = [];
  for (let n = 1; placeholders.length < count; n += 1) {
    const id = `${PENDING_ID}-${n}`;
    if (!document.pages.some((page) => page.id === id) && !Object.hasOwn(document.nodes, id)) {
      placeholders.push(id);
    }
  }
  return placeholders;
}

/**
 * A trial failure whose path lies inside node `from[i]` reported at node `to[i]` instead, the
 * rest of the path kept; any other failure is returned as is.
 */
export function remapFailure(
  failure: Failure,
  from: readonly string[],
  to: readonly string[],
): Failure {
  const path = failure.path;
  for (let i = 0; path !== undefined && i < from.length; i += 1) {
    const prefix = nodePath(from[i]!);
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return fail(failure.code, nodePath(to[i]!) + path.slice(prefix.length));
    }
  }
  return failure;
}

/**
 * Draws `count` fresh IDs (M2 contract, S8) in call order: each must be a valid ID that no page
 * or node of `document` has and that this draw has not returned; at most `ID_ATTEMPTS` calls per
 * ID. Null when an ID cannot be drawn (`editor.duplicate-id`). Callers run every other check
 * first, so a failed command draws no ID.
 */
export function drawIds(document: DocumentV3, ids: IdSource, count: number): string[] | null {
  const drawn: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    let id: string | null = null;
    for (let attempt = 0; attempt < ID_ATTEMPTS && id === null; attempt += 1) {
      const next = ids();
      if (
        isValidId(next) &&
        !seen.has(next) &&
        !document.pages.some((page) => page.id === next) &&
        !Object.hasOwn(document.nodes, next)
      ) {
        id = next;
      }
    }
    if (id === null) return null;
    seen.add(id);
    drawn.push(id);
  }
  return drawn;
}
