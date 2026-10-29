import type { DocumentV4, InstanceNode, NodeV4, SymbolNode } from '@vector-studio/model';
import { Draft, fail, type Failure } from './draft.js';
import {
  drawIds,
  nodeOf,
  placeholderIds,
  remapFailure,
  success,
  uniqueIds,
  type EditContext,
  type EditResult,
} from './edit-support.js';
import type { Expansion, ExpansionCache } from './expansion.js';
import { documentTree, isContainer, nodePath, pageInstances, pageOf } from './tree.js';
import type { DocumentCommand, IdSource } from './types.js';

// Detach and the source deletion rule (MVP M7 contract, sections 5.2 and 5.4). An instance
// becomes a `frame` with its own ID and placement, its source's fill and stroke, and copies of
// its expansion with fresh IDs. Every check runs on a build with placeholder IDs first, so a
// failed command draws no ID; IDs follow the instances in `pages` order, then page-tree
// pre-order, each expansion in the source's pre-order.

type Plan = Readonly<{
  instances: readonly string[];
  expansions: readonly Expansion[];
  /** The source node of each copy, in ID order. */
  originals: readonly string[];
}>;

function plan(
  document: DocumentV4,
  instances: readonly string[],
  cache: ExpansionCache,
): Plan | Failure {
  const expansions: Expansion[] = [];
  const originals: string[] = [];
  for (const id of instances) {
    const result = cache.expand(document, id);
    // Every instance of a valid document names a source, so `result` is never null here.
    if (result === null) return fail('editor.invalid-expansion', nodePath(id));
    if (!result.ok) return fail(result.code, result.path);
    expansions.push(result.expansion);
    originals.push(...result.expansion.nodes.keys());
  }
  return { instances, expansions, originals };
}

/** Turns each planned instance into its detached frame in `draft`, the copies taking `ids`. */
function detach(draft: Draft, document: DocumentV4, planned: Plan, ids: readonly string[]): void {
  let next = 0;
  planned.instances.forEach((id, i) => {
    const instance = document.nodes[id] as InstanceNode;
    const source = document.nodes[instance.symbol] as SymbolNode;
    const { children, nodes } = planned.expansions[i]!;
    const copyOf = new Map<string, string>();
    for (const key of nodes.keys()) copyOf.set(key, ids[next++]!);
    for (const [key, node] of nodes) {
      const copy: Record<string, unknown> = {
        ...node,
        id: copyOf.get(key)!,
        // The source's direct children name the source; their copies name the frame.
        parent: node.parent === source.id ? id : copyOf.get(node.parent)!,
      };
      if (isContainer(node)) copy.children = node.children.map((child) => copyOf.get(child)!);
      draft.set(copy as NodeV4);
    }
    draft.set({
      id,
      name: instance.name,
      parent: instance.parent,
      frame: instance.frame,
      rotation: instance.rotation,
      constraints: instance.constraints,
      opacity: instance.opacity,
      visible: instance.visible,
      type: 'frame',
      children: children.map((child) => copyOf.get(child)!),
      fill: source.fill,
      stroke: source.stroke,
    });
  });
}

/**
 * Runs an edit that detaches `instances` (in ID order) in the same transaction: `edit` applies
 * the rest of the command to the draft and `complete` finishes and checks it. With instances to
 * detach, the expansions are read first (M7-X3: an invalid one fails the command, after any
 * failure of the edit without the detach, so the section 5.5 order holds), then the whole command
 * is built with placeholder IDs, and only then are IDs drawn (`editor.duplicate-id` last).
 */
export function withDetach(
  document: DocumentV4,
  instances: readonly string[],
  ids: IdSource,
  cache: ExpansionCache,
  edit: (draft: Draft) => void,
  complete: (draft: Draft) => EditResult,
): EditResult {
  const build = (planned: Plan | null, drawn: readonly string[]) => {
    const draft = new Draft(document);
    if (planned !== null) detach(draft, document, planned, drawn);
    edit(draft);
    return complete(draft);
  };
  if (instances.length === 0) return build(null, []);
  const planned = plan(document, instances, cache);
  if ('ok' in planned) {
    const alone = build(null, []);
    return alone.ok ? planned : alone;
  }
  const placeholders = placeholderIds(document, planned.originals.length);
  const trial = build(planned, placeholders);
  // A failure in a copy is reported at its source node, as `duplicateNodes` reports originals.
  if (!trial.ok) return remapFailure(trial, placeholders, planned.originals);
  const drawn = drawIds(document, ids, planned.originals.length);
  if (drawn === null) return fail('editor.duplicate-id');
  return build(planned, drawn);
}

/**
 * The instances the source deletion rule detaches when the nodes of `removed` leave the
 * document (section 5.4): every instance outside `removed`, on any page, of a `symbol` inside it,
 * in `pages` order then page-tree pre-order. An instance removed too is deleted, not detached.
 */
export function orphanedInstances(document: DocumentV4, removed: ReadonlySet<string>): string[] {
  const sources = new Set<string>();
  for (const id of removed) {
    if (nodeOf(document, id)?.type === 'symbol') sources.add(id);
  }
  if (sources.size === 0) return [];
  return pageInstances(document)
    .flat()
    .filter((id) => !removed.has(id) && sources.has((document.nodes[id] as InstanceNode).symbol));
}

/**
 * `detachInstances` (section 5.2): instances of the active page at any depth, in the M1 section
 * 4.3.1 order (`ids` shape, `editor.unknown-node`, `editor.not-an-instance`), then the checks of
 * the detached document, then `editor.duplicate-id`. Returns empty `ids`.
 */
export function detachInstances(
  document: DocumentV4,
  command: Extract<DocumentCommand, { type: 'detachInstances' }>,
  context: EditContext,
  cache: ExpansionCache,
  finish: (draft: Draft) => DocumentV4 | Failure,
): EditResult {
  const ids = uniqueIds(command.ids);
  if (ids === null || ids.length === 0) return fail('editor.invalid-command', '/ids');
  const tree = documentTree(document);
  if (
    ids.some((id) => nodeOf(document, id) === undefined || pageOf(tree, id) !== context.activePage)
  ) {
    return fail('editor.unknown-node');
  }
  if (ids.some((id) => document.nodes[id]!.type !== 'instance')) {
    return fail('editor.not-an-instance');
  }
  const listed = new Set(ids);
  const instances = pageInstances(document)
    .flat()
    .filter((id) => listed.has(id));
  return withDetach(
    document,
    instances,
    context.ids,
    cache,
    () => {},
    (draft) => success(finish(draft), draft, []),
  );
}
