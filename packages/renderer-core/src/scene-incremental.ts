import type {
  RenderChildOrder,
  RenderNodeSnapshot,
  SceneAffine,
  SceneRejectionReason,
} from '@vector-studio/contracts';
import { SCENE_MAX_CLIP_DEPTH, SCENE_MAX_ISOLATION_DEPTH } from '@vector-studio/contracts';
import {
  composeSceneAffine,
  getPathLocalPointBounds,
  getPathLocalStrokeBounds,
  getPrimitiveLocalStrokeBounds,
  getTextLocalBounds,
  transformSceneBounds,
} from './scene-numeric.js';
import type { PathSupport, ValidatedChangesInput } from './scene-validation.js';

// E26 contract, section 4.1: the verdict of a change set in work proportional to the change.
// `checkChangeSet` returns exactly what the full pipeline of `RetainedSceneMirror.applyChanges`
// returned before E26 (finite arithmetic over the whole candidate, then the operation checks,
// then `validateCandidateGraph` with its category order), but it visits only the changed nodes,
// their ancestor chains, the lists that change, and the subtrees whose world inputs change. The
// full pipeline stays as the test oracle (`scene-mirror.ts`).
//
// The base scene is valid: every reference resolves, every node has a container parent, there is
// no cycle, each node occurs exactly once in its parent's list, the clip graph is supported and
// all world arithmetic is finite. A rule can therefore only break where the set changes an input
// of it, which is what each check below walks.

/** The resident scene a set applies to. */
export type ResidentScene = Readonly<{
  nodes: ReadonlyMap<string, RenderNodeSnapshot>;
  rootOrder: readonly string[];
  /** Node IDs by `parentId` (null for roots), the reverse of the parent pointers. */
  childrenByParent: ReadonlyMap<string | null, ReadonlySet<string>>;
}>;

/** The candidate: the resident scene with the set's writes over it, as `applyCandidate` built. */
export class CandidateScene {
  /** Written nodes by ID; null for a removed node that nothing wrote again. */
  readonly writes = new Map<string, RenderNodeSnapshot | null>();
  rootOrder: readonly string[];
  /** Whether an order entry replaced the root order. */
  rootOrderWritten = false;
  /** Node lookups made, for the E26-A07 counter. */
  visits = 0;

  constructor(
    readonly resident: ResidentScene,
    input: ValidatedChangesInput,
  ) {
    this.rootOrder = resident.rootOrder;
    // The order of `applyCandidate`: removals, insertions, updates, then orders in sequence.
    for (const id of input.removed) this.writes.set(id, null);
    for (const { node } of input.inserted) this.writes.set(node.id, node);
    for (const { node } of input.updated) this.writes.set(node.id, node);
    for (const order of input.orders) this.#applyOrder(order);
  }

  #applyOrder(order: RenderChildOrder): void {
    if (order.parentId === null) {
      this.rootOrder = order.children;
      this.rootOrderWritten = true;
      return;
    }
    const parent = this.get(order.parentId);
    if (parent?.kind === 'container') {
      this.writes.set(parent.id, Object.freeze({ ...parent, children: order.children }));
    }
  }

  get(id: string): RenderNodeSnapshot | undefined {
    this.visits += 1;
    if (this.writes.has(id)) return this.writes.get(id) ?? undefined;
    return this.resident.nodes.get(id);
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  #writtenByParent: Map<string | null, string[]> | null = null;

  /** The candidate nodes whose `parentId` is `parent`. */
  childrenOf(parent: string | null): string[] {
    if (this.#writtenByParent === null) {
      this.#writtenByParent = new Map();
      for (const [id, node] of this.writes) {
        if (node === null) continue;
        const list = this.#writtenByParent.get(node.parentId);
        if (list === undefined) this.#writtenByParent.set(node.parentId, [id]);
        else list.push(id);
      }
    }
    const result: string[] = [];
    for (const id of this.resident.childrenByParent.get(parent) ?? []) {
      this.visits += 1;
      if (!this.writes.has(id)) result.push(id);
    }
    for (const id of this.#writtenByParent.get(parent) ?? []) result.push(id);
    return result;
  }

  /** The candidate's written entries that hold a node. */
  *writtenNodes(): Iterable<RenderNodeSnapshot> {
    for (const node of this.writes.values()) if (node !== null) yield node;
  }
}

const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];

/**
 * The world transform of `id` by its parent pointers, memoized; null when its chain meets a
 * missing parent or a cycle (the full check skips such nodes), or 'overflow' when composing fails
 * (the full check returns false).
 */
function worldOf(
  candidate: CandidateScene,
  id: string,
  memo: Map<string, SceneAffine | null>,
): SceneAffine | null | 'overflow' {
  const known = memo.get(id);
  if (known !== undefined) return known;
  const path: RenderNodeSnapshot[] = [];
  const onPath = new Set<string>();
  let cursor = candidate.get(id);
  let parentWorld: SceneAffine | null = IDENTITY;
  while (cursor !== undefined) {
    const memoized = memo.get(cursor.id);
    if (memoized !== undefined) {
      parentWorld = memoized;
      break;
    }
    if (onPath.has(cursor.id)) {
      parentWorld = null;
      break;
    }
    onPath.add(cursor.id);
    path.push(cursor);
    if (cursor.parentId === null) {
      parentWorld = IDENTITY;
      break;
    }
    const parent = candidate.get(cursor.parentId);
    if (parent === undefined) {
      parentWorld = null;
      break;
    }
    cursor = parent;
  }
  if (cursor === undefined) parentWorld = null;
  if (parentWorld === null) {
    for (const entry of path) memo.set(entry.id, null);
    return null;
  }
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const node = path[index]!;
    const world = composeSceneAffine(parentWorld, node.transform);
    if (world === null) return 'overflow';
    memo.set(node.id, world);
    parentWorld = world;
  }
  return memo.get(id) ?? null;
}

/** The per-node bound rule of `hasFiniteSceneArithmetic`, given its world transform. */
function boundsFinite(node: RenderNodeSnapshot, world: SceneAffine): boolean {
  if (node.kind === 'container') return true;
  if (node.kind === 'text') {
    if (!node.runs.some((run) => run.clusters.length > 0)) return true;
    const textBounds = getTextLocalBounds(node);
    return textBounds !== null && transformSceneBounds(textBounds, world) !== null;
  }
  if (node.kind === 'path') {
    const pathBounds = getPathLocalPointBounds(node.geometry.points);
    if (pathBounds !== null && transformSceneBounds(pathBounds, world) === null) return false;
    const strokeBounds = getPathLocalStrokeBounds(node.geometry.points, node.style.stroke);
    return strokeBounds === null || transformSceneBounds(strokeBounds, world) !== null;
  }
  const bounds = getPrimitiveLocalStrokeBounds(node);
  return bounds !== null && (bounds === undefined || transformSceneBounds(bounds, world) !== null);
}

function affineEquals(left: SceneAffine, right: SceneAffine): boolean {
  for (let index = 0; index < 6; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

/** Whether a written node changes the world inputs of its descendants. */
function shiftsSubtreeWorld(
  before: RenderNodeSnapshot | undefined,
  after: RenderNodeSnapshot,
): boolean {
  return (
    before === undefined ||
    before.parentId !== after.parentId ||
    !affineEquals(before.transform, after.transform)
  );
}

/** Whether a node isolates its children (E25-S2). */
function isolates(node: RenderNodeSnapshot): boolean {
  return node.kind === 'container' && node.visible && node.opacity > 0 && node.opacity < 1;
}

function clips(node: RenderNodeSnapshot): boolean {
  return node.kind === 'container' && node.clip !== null;
}

/** Whether a written node changes the clip or isolation depth of its descendants. */
function shiftsSubtreeDepth(
  before: RenderNodeSnapshot | undefined,
  after: RenderNodeSnapshot,
): boolean {
  return (
    before === undefined ||
    before.parentId !== after.parentId ||
    clips(before) !== clips(after) ||
    isolates(before) !== isolates(after)
  );
}

/**
 * `hasFiniteSceneArithmetic` of the candidate, given that the resident scene passed it: the
 * written nodes, and every node below a written node that moves or re-transforms its subtree
 * (by parent pointers, as the full check walks them).
 */
export function candidateArithmeticFinite(candidate: CandidateScene): boolean {
  const check = new Set<string>();
  const pending: string[] = [];
  for (const node of candidate.writtenNodes()) {
    check.add(node.id);
    if (shiftsSubtreeWorld(candidate.resident.nodes.get(node.id), node)) pending.push(node.id);
  }
  const expanded = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (expanded.has(id)) continue;
    expanded.add(id);
    for (const child of candidate.childrenOf(id)) {
      check.add(child);
      pending.push(child);
    }
  }
  const memo = new Map<string, SceneAffine | null>();
  for (const id of check) {
    const node = candidate.get(id);
    if (node === undefined) continue;
    const world = worldOf(candidate, id, memo);
    if (world === 'overflow') return false;
    if (world !== null && !boundsFinite(node, world)) return false;
  }
  return true;
}

/**
 * `validateOperations` of the mirror, with membership read from the candidate's writes and the
 * resident map instead of a set of every node.
 */
export function operationReason(
  candidate: CandidateScene,
  input: ValidatedChangesInput,
): 'duplicate-id' | 'conflicting-operation' | 'unknown-node' | null {
  const resident = candidate.resident.nodes;
  for (const group of [input.inserted, input.updated]) {
    const ids = new Set<string>();
    for (const { node } of group) {
      if (ids.has(node.id)) return 'duplicate-id';
      ids.add(node.id);
    }
  }
  if (new Set(input.removed).size !== input.removed.length) return 'duplicate-id';

  const inserted = new Set(input.inserted.map(({ node }) => node.id));
  const updated = new Set(input.updated.map(({ node }) => node.id));
  const removed = new Set(input.removed);
  for (const id of inserted) if (updated.has(id) || removed.has(id)) return 'conflicting-operation';
  for (const id of updated) if (removed.has(id)) return 'conflicting-operation';
  for (const id of inserted) {
    candidate.visits += 1;
    if (resident.has(id)) return 'duplicate-id';
  }

  const orderParents = new Set<string | null>();
  for (const order of input.orders) {
    if (orderParents.has(order.parentId)) return 'conflicting-operation';
    orderParents.add(order.parentId);
  }
  for (const { node } of input.updated) {
    if (node.kind === 'container' && orderParents.has(node.id)) return 'conflicting-operation';
  }
  for (const { node } of input.inserted) {
    if (node.kind === 'container' && orderParents.has(node.id)) return 'conflicting-operation';
  }

  for (const id of [...updated, ...removed]) {
    candidate.visits += 1;
    if (!resident.has(id)) return 'unknown-node';
  }
  const knownAfter = (id: string) => {
    candidate.visits += 1;
    return inserted.has(id) || (!removed.has(id) && resident.has(id));
  };
  for (const order of input.orders) {
    if (order.parentId !== null && !knownAfter(order.parentId)) return 'unknown-node';
    if (order.children.some((id) => !knownAfter(id))) return 'unknown-node';
  }
  return null;
}

/** The ordered child list of `owner` (null: the root order) in the candidate. */
function listOf(candidate: CandidateScene, owner: string | null): readonly string[] | undefined {
  if (owner === null) return candidate.rootOrder;
  const node = candidate.get(owner);
  return node?.kind === 'container' ? node.children : undefined;
}

function residentListOf(resident: ResidentScene, owner: string | null): readonly string[] {
  if (owner === null) return resident.rootOrder;
  const node = resident.nodes.get(owner);
  return node?.kind === 'container' ? node.children : [];
}

/**
 * `validateCandidateGraph` of the candidate (arithmetic already checked), given that the
 * resident scene passed it, in its category order: unknown-node, invalid-parent, cycle,
 * invalid-order, then the clip graph. The mirror applies the order-parent rule between
 * unknown-node and invalid-parent itself, so the first category is returned separately.
 */
export function candidateGraphReason(
  candidate: CandidateScene,
  support: PathSupport,
): Readonly<{ unknown: boolean; reason: SceneRejectionReason | null }> {
  const resident = candidate.resident;

  // The lists to inspect: those that differ from the resident ones (the root order if written,
  // written containers whose children differ), and the old and new parent lists of every node
  // that is inserted, removed or moved. A written node that keeps its parent stays in its
  // parent's list unless that list was written, which the first group covers.
  const owners = new Set<string | null>();
  const placed: RenderNodeSnapshot[] = [];
  if (candidate.rootOrderWritten) owners.add(null);
  for (const [id, node] of candidate.writes) {
    const before = resident.nodes.get(id);
    if (node !== null && node.kind === 'container') {
      const old = before?.kind === 'container' ? before.children : undefined;
      if (old === undefined || !arraysEqual(old, node.children)) owners.add(id);
    }
    if (node === null || before === undefined || before.parentId !== node.parentId) {
      if (node !== null) {
        owners.add(node.parentId);
        placed.push(node);
      }
      if (before !== undefined) owners.add(before.parentId);
    }
  }

  // One pass over those lists finds unknown references (an entry the candidate lacks; this
  // covers a removed node still listed by its unchanged parent) and the per-list order rules
  // (distinct entries whose parent pointer is the owner), which are reported later, after the
  // invalid-parent and cycle categories, as the full check orders them.
  const listed = new Map<string | null, Set<string>>();
  let listOrderBroken = false;
  for (const owner of owners) {
    const list = listOf(candidate, owner);
    if (list === undefined) continue;
    const local = new Set<string>();
    for (const childId of list) {
      const child = candidate.get(childId);
      if (child === undefined) return { unknown: true, reason: null };
      if (local.has(childId) || child.parentId !== owner) listOrderBroken = true;
      local.add(childId);
    }
    listed.set(owner, local);
  }

  // Invalid parents: written nodes, and the resident children of nodes that are removed or stop
  // being containers.
  const parentValid = (node: RenderNodeSnapshot) =>
    node.parentId === null || candidate.get(node.parentId)?.kind === 'container';
  for (const node of candidate.writtenNodes()) {
    if (!parentValid(node)) return { unknown: false, reason: 'invalid-parent' };
  }
  for (const [id, node] of candidate.writes) {
    if (node !== null && node.kind === 'container') continue;
    for (const childId of resident.childrenByParent.get(id) ?? []) {
      const child = candidate.get(childId);
      if (child !== undefined && !parentValid(child)) {
        return { unknown: false, reason: 'invalid-parent' };
      }
    }
  }

  // Cycles: a new cycle passes through a written node, whose parent pointer is the new edge.
  const acyclic = new Set<string>();
  for (const start of candidate.writtenNodes()) {
    const path = new Set<string>();
    let cursor: RenderNodeSnapshot | undefined = start;
    while (cursor !== undefined && !acyclic.has(cursor.id)) {
      if (path.has(cursor.id)) return { unknown: false, reason: 'cycle' };
      path.add(cursor.id);
      cursor = cursor.parentId === null ? undefined : candidate.get(cursor.parentId);
    }
    for (const id of path) acyclic.add(id);
  }

  // Order consistency. Beyond the per-list rules above, a node occurs once exactly when its
  // parent lists it: moved and inserted nodes must be listed, and a node a list dropped must have
  // moved away.
  if (listOrderBroken) return { unknown: false, reason: 'invalid-order' };
  for (const [owner, local] of listed) {
    for (const childId of residentListOf(resident, owner)) {
      if (local.has(childId)) continue;
      const child = candidate.get(childId);
      if (child !== undefined && child.parentId === owner) {
        return { unknown: false, reason: 'invalid-order' };
      }
    }
  }
  for (const node of placed) {
    if (listed.get(node.parentId)?.has(node.id) !== true) {
      return { unknown: false, reason: 'invalid-order' };
    }
  }

  // The clip graph (P4-S2, P4-S3, E25-S2). Mask sources: written containers and the parents of
  // written nodes. Depths: written nodes, and the subtrees whose depth inputs change.
  const maskOwners = new Set<string>();
  for (const node of candidate.writtenNodes()) {
    if (node.kind === 'container') maskOwners.add(node.id);
    if (node.parentId !== null) maskOwners.add(node.parentId);
  }
  for (const owner of maskOwners) {
    const node = candidate.get(owner);
    if (node === undefined || node.kind !== 'container') continue;
    if (node.clip !== null && node.clip.kind === 'mask' && node.children.length > 0) {
      const source = candidate.get(node.children[0]!);
      if (source === undefined || source.kind === 'container' || source.kind === 'text') {
        return { unknown: false, reason: 'unsupported-feature' };
      }
      if (source.kind === 'path' && support.pathFills !== 'supported') {
        return { unknown: false, reason: 'unsupported-feature' };
      }
    }
  }
  const depthOf = (node: RenderNodeSnapshot) => {
    let depth = 0;
    let isolation = 0;
    let cursor = node.parentId === null ? undefined : candidate.get(node.parentId);
    while (cursor !== undefined) {
      if (clips(cursor)) depth += 1;
      if (isolates(cursor)) isolation += 1;
      cursor = cursor.parentId === null ? undefined : candidate.get(cursor.parentId);
    }
    return { depth, isolation };
  };
  const pending: { id: string; depth: number; isolation: number }[] = [];
  const visited = new Set<string>();
  for (const node of candidate.writtenNodes()) {
    const at = depthOf(node);
    if (at.depth > SCENE_MAX_CLIP_DEPTH || at.isolation > SCENE_MAX_ISOLATION_DEPTH) {
      return { unknown: false, reason: 'unsupported-feature' };
    }
    if (shiftsSubtreeDepth(resident.nodes.get(node.id), node)) pending.push({ id: node.id, ...at });
  }
  while (pending.length > 0) {
    const { id, depth, isolation } = pending.pop()!;
    if (depth > SCENE_MAX_CLIP_DEPTH || isolation > SCENE_MAX_ISOLATION_DEPTH) {
      return { unknown: false, reason: 'unsupported-feature' };
    }
    if (visited.has(id)) continue;
    visited.add(id);
    const node = candidate.get(id);
    if (node === undefined || node.kind !== 'container') continue;
    const childDepth = node.clip === null ? depth : depth + 1;
    const childIsolation = isolates(node) ? isolation + 1 : isolation;
    for (const childId of node.children) {
      pending.push({ id: childId, depth: childDepth, isolation: childIsolation });
    }
  }
  return { unknown: false, reason: null };
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}
