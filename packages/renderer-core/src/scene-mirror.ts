import type {
  CameraApplyResult,
  RenderCamera,
  RenderCameraState,
  RenderChangeSet,
  RendererSceneSynchronization,
  RenderNodeSnapshot,
  RenderSceneSnapshot,
  SceneApplyResult,
  SceneIdentity,
  SceneRejectionReason,
  SceneSynchronizationState,
  SceneVersion,
} from '@vector-studio/contracts';
import {
  CandidateScene,
  candidateArithmeticFinite,
  candidateGraphReason,
  operationReason,
  type ResidentScene,
} from './scene-incremental.js';
import { hasFiniteSceneArithmetic } from './scene-numeric.js';
import {
  firstDuplicateNodeId,
  snapshotsEqual,
  validateCandidateGraph,
  validateChangesShape,
  validateSnapshotShape,
  pathDataEquals,
  type ClipSupport,
  type DashSupport,
  type GroupOpacitySupport,
  type PaintSupport,
  type PathNodeSupport,
  type PathSupport,
  type TextSupport,
  type ValidatedChangesInput,
  type ValidatedSnapshotInput,
} from './scene-validation.js';

export type RetainedSceneView = Readonly<{
  sceneEpoch: symbol;
  version: SceneVersion;
  nodes: readonly RenderNodeSnapshot[];
  rootOrder: readonly string[];
  getNode(id: string): RenderNodeSnapshot | undefined;
  /** The mirror-derived geometry revision of a path node; never carried by the scene contract. */
  getGeometryRevision(id: string): number | undefined;
}>;

/**
 * Port presence, fixed at construction (P3 V3 contract, section a; B2 stroke contract, section 5
 * and the section 9.1 amendment S4). `pathFills` takes the value of `pathNodes` when omitted, so
 * V3 calls keep their meaning; `pathStrokes` defaults to 'unsupported'.
 */
export type RetainedSceneMirrorOptions = Readonly<{
  pathNodes: PathNodeSupport;
  pathFills?: PathNodeSupport;
  pathStrokes?: PathNodeSupport;
  /** P4 contract, units U1 and U3: which non-null container clips are drawn; default none. */
  clips?: ClipSupport;
  /** E23 contract, E23-S3: whether gradient paints are drawn; default 'solid'. */
  paints?: PaintSupport;
  /** E24 contract, E24-S3: whether path stroke dashes are drawn; default 'unsupported'. */
  dashes?: DashSupport;
  /**
   * E25 contract, E25-S1: whether isolated container opacity is drawn; default 'unsupported'.
   * Tests only until E25 U3: `PrimitiveSceneSource` plans layers (U2), but no renderer draws
   * them yet, and no service sets this option before then.
   */
  groupOpacity?: GroupOpacitySupport;
  /** E28 contract, E28-S3: whether text nodes are drawn; default 'unsupported'. */
  textNodes?: TextSupport;
}>;

export type ScenePendingChangeState = Readonly<{
  sceneChanged: boolean;
  cameraChanged: boolean;
  invalidationToken: symbol | null;
}>;

type CameraTransition =
  | Readonly<{ status: 'applied' | 'unchanged'; state: RenderCameraState }>
  | Readonly<{ status: 'invalid-camera'; reason: 'invalid-value' | 'revision-overflow' }>;

/**
 * A published scene version. Its maps are the mirror's live maps, which the next accepted set
 * updates in place (E26 contract, section 4.1). A view takes its own copies when it is first read
 * for this version (`view`), so a published view stays immutable and no set copies a whole map.
 */
type OwnedScene = {
  readonly sceneEpoch: symbol;
  readonly identity: SceneIdentity;
  readonly revision: number;
  readonly nodes: Map<string, RenderNodeSnapshot>;
  readonly rootOrder: readonly string[];
  readonly geometryRevisions: Map<string, number>;
  view: Readonly<{
    nodeList: readonly RenderNodeSnapshot[];
    nodes: ReadonlyMap<string, RenderNodeSnapshot>;
    geometryRevisions: ReadonlyMap<string, number>;
  }> | null;
};

/** The mirror's indexes of the current scene, mutated in place by each publish. */
type SceneIndexes = {
  /** Node IDs by `parentId`. */
  childrenByParent: Map<string | null, Set<string>>;
  /**
   * Every node ID in ordinal order, the order of `RetainedSceneView.nodes`, as of the last read;
   * the IDs added and deleted since then are merged into it on the next read.
   */
  sortedIds: string[];
  pendingAdded: Set<string>;
  pendingDeleted: Set<string>;
};

function emptyIndexes(): SceneIndexes {
  return {
    childrenByParent: new Map(),
    sortedIds: [],
    pendingAdded: new Set(),
    pendingDeleted: new Set(),
  };
}

let injectNextGeometryRevision: (mirror: RetainedSceneMirror, next: number) => void;
let injectFullValidation: (mirror: RetainedSceneMirror) => void;
let readLastSetVisits: (mirror: RetainedSceneMirror) => number;

export class RetainedSceneMirror implements RendererSceneSynchronization {
  #scene: OwnedScene | null = null;
  #synchronizationStatus: SceneSynchronizationState['status'] = 'awaiting-snapshot';
  #cameraState: RenderCameraState | null = freezeCameraState(
    { position: { x: 0, y: 0 }, zoom: 1 },
    0,
  );
  #sceneChanged = false;
  #cameraChanged = false;
  #invalidationToken: symbol | null = null;
  #onInvalidate: () => void;
  readonly #pathNodes: PathSupport;
  #nextGeometryRevision = 1;
  #indexes: SceneIndexes = emptyIndexes();
  /** Test seam: validate and publish change sets with the full pre-E26 pipeline (the oracle). */
  #fullValidation = false;
  #lastSetVisits = 0;

  static {
    injectNextGeometryRevision = (mirror, next) => {
      mirror.#nextGeometryRevision = next;
    };
    injectFullValidation = (mirror) => {
      mirror.#fullValidation = true;
    };
    readLastSetVisits = (mirror) => mirror.#lastSetVisits;
  }

  public constructor(
    onInvalidate: () => void = () => undefined,
    options: RetainedSceneMirrorOptions = { pathNodes: 'unsupported' },
  ) {
    this.#onInvalidate = onInvalidate;
    // Fixed at construction, so validation and replay equality stay stable for the mirror's life.
    const pathNodes = options.pathNodes === 'supported' ? 'supported' : 'unsupported';
    const pathFills =
      options.pathFills === undefined
        ? pathNodes
        : options.pathFills === 'supported'
          ? 'supported'
          : 'unsupported';
    const pathStrokes = options.pathStrokes === 'supported' ? 'supported' : 'unsupported';
    const clips: ClipSupport =
      options.clips === 'supported' || options.clips === 'rect' ? options.clips : 'unsupported';
    const paints: PaintSupport = options.paints === 'gradient' ? 'gradient' : 'solid';
    const dashes: DashSupport = options.dashes === 'supported' ? 'supported' : 'unsupported';
    const groupOpacity: GroupOpacitySupport =
      options.groupOpacity === 'supported' ? 'supported' : 'unsupported';
    const textNodes: TextSupport = options.textNodes === 'supported' ? 'supported' : 'unsupported';
    this.#pathNodes = Object.freeze({
      pathNodes,
      pathFills,
      pathStrokes,
      clips,
      paints,
      dashes,
      groupOpacity,
      textNodes,
    });
  }

  public replaceSnapshot(snapshot: RenderSceneSnapshot): SceneApplyResult {
    if (this.#synchronizationStatus === 'disposed') return disposedResult();

    let input: ValidatedSnapshotInput | null;
    try {
      input = validateSnapshotShape(snapshot, this.#pathNodes);
    } catch {
      input = null;
    }
    if (input === null) return this.#invalidScene('invalid-value');

    const candidateNodes = mapSnapshotNodes(input);
    if (!hasFiniteSceneArithmetic(candidateNodes)) {
      return this.#invalidScene('invalid-value');
    }

    const current = this.#scene;
    const sameIdentity = current !== null && identitiesEqual(current.identity, input.identity);
    if (sameIdentity && input.revision < current.revision) {
      return this.#invalidScene('stale-snapshot');
    }

    if (sameIdentity && input.revision === current.revision) {
      if (
        firstDuplicateNodeId(input.nodes) !== null ||
        !snapshotsEqual(current.nodes, current.rootOrder, candidateNodes, input.rootOrder)
      ) {
        return this.#invalidScene('revision-conflict');
      }
      this.#synchronizationStatus = 'synchronized';
      return replayedResult(current);
    }

    if (firstDuplicateNodeId(input.nodes) !== null) {
      return this.#invalidScene('duplicate-id');
    }

    const graphReason = validateCandidateGraph(
      candidateNodes,
      input.rootOrder,
      input.nodes.some((entry) => entry.unsupported),
      true,
      this.#pathNodes,
    );
    if (graphReason !== null) return this.#invalidScene(graphReason);

    const published = this.#publishScene(
      input.identity,
      input.revision,
      candidateNodes,
      input.rootOrder,
    );
    if (published === null) return this.#invalidScene('invalid-value');
    return appliedResult(published);
  }

  public applyChanges(changes: RenderChangeSet): SceneApplyResult {
    if (this.#fullValidation) return this.#applyChangesFull(changes);
    this.#lastSetVisits = 0;
    if (this.#synchronizationStatus === 'disposed') return disposedResult();
    if (this.#synchronizationStatus !== 'synchronized' || this.#scene === null) {
      this.#synchronizationStatus = 'resync-required';
      return resyncResult(this.#scene);
    }

    let input: ValidatedChangesInput | null;
    try {
      input = validateChangesShape(changes, this.#pathNodes);
    } catch {
      input = null;
    }
    if (input === null || input.revision <= input.baseRevision) {
      return this.#invalidScene('invalid-value');
    }

    // E26 contract, section 4.1: the same verdicts as #applyChangesFull, in the same order, in
    // work proportional to the change.
    const scene = this.#scene;
    const resident: ResidentScene = {
      nodes: scene.nodes,
      rootOrder: scene.rootOrder,
      childrenByParent: this.#indexes.childrenByParent,
    };
    const candidate = new CandidateScene(resident, input);
    try {
      if (!candidateArithmeticFinite(candidate)) return this.#invalidScene('invalid-value');

      if (
        !identitiesEqual(scene.identity, input.identity) ||
        input.baseRevision !== scene.revision
      ) {
        this.#synchronizationStatus = 'resync-required';
        return resyncResult(scene);
      }

      const operation = operationReason(candidate, input);
      if (operation !== null) return this.#invalidScene(operation);

      const hasInvalidOrderParent = input.orders.some(
        (order) => order.parentId !== null && candidate.get(order.parentId)?.kind !== 'container',
      );
      const graph = candidateGraphReason(candidate, this.#pathNodes);
      if (graph.unknown) return this.#invalidScene('unknown-node');
      if (hasInvalidOrderParent) return this.#invalidScene('invalid-parent');
      if (graph.reason !== null) return this.#invalidScene(graph.reason);
      if (
        input.inserted.some((entry) => entry.unsupported) ||
        input.updated.some((entry) => entry.unsupported)
      ) {
        return this.#invalidScene('unsupported-feature');
      }

      const published = this.#publishWrites(input, candidate);
      if (published === null) return this.#invalidScene('invalid-value');
      return appliedResult(published);
    } finally {
      this.#lastSetVisits = candidate.visits;
    }
  }

  /** The pre-E26 pipeline over the whole candidate: the oracle of the incremental one. */
  #applyChangesFull(changes: RenderChangeSet): SceneApplyResult {
    if (this.#synchronizationStatus === 'disposed') return disposedResult();
    if (this.#synchronizationStatus !== 'synchronized' || this.#scene === null) {
      this.#synchronizationStatus = 'resync-required';
      return resyncResult(this.#scene);
    }

    let input: ValidatedChangesInput | null;
    try {
      input = validateChangesShape(changes, this.#pathNodes);
    } catch {
      input = null;
    }
    if (input === null || input.revision <= input.baseRevision) {
      return this.#invalidScene('invalid-value');
    }

    const arithmeticCandidate = applyCandidate(this.#scene, input);
    if (!hasFiniteSceneArithmetic(arithmeticCandidate.nodes)) {
      return this.#invalidScene('invalid-value');
    }

    if (
      !identitiesEqual(this.#scene.identity, input.identity) ||
      input.baseRevision !== this.#scene.revision
    ) {
      this.#synchronizationStatus = 'resync-required';
      return resyncResult(this.#scene);
    }

    const operationReason = validateOperations(this.#scene, input);
    if (operationReason !== null) return this.#invalidScene(operationReason);

    const candidate = arithmeticCandidate;
    const hasInvalidOrderParent = input.orders.some(
      (order) =>
        order.parentId !== null && candidate.nodes.get(order.parentId)?.kind !== 'container',
    );
    const graphReason = validateCandidateGraph(
      candidate.nodes,
      candidate.rootOrder,
      input.inserted.some((entry) => entry.unsupported) ||
        input.updated.some((entry) => entry.unsupported),
      true,
      this.#pathNodes,
    );
    if (graphReason === 'unknown-node') return this.#invalidScene(graphReason);
    if (hasInvalidOrderParent) return this.#invalidScene('invalid-parent');
    if (graphReason !== null) return this.#invalidScene(graphReason);

    const published = this.#publishScene(
      input.identity,
      input.revision,
      candidate.nodes,
      candidate.rootOrder,
      this.#scene.sceneEpoch,
    );
    if (published === null) return this.#invalidScene('invalid-value');
    return appliedResult(published);
  }

  public getSynchronizationState(): SceneSynchronizationState {
    if (this.#synchronizationStatus === 'disposed') {
      return Object.freeze({ status: 'disposed', current: null });
    }
    return Object.freeze({
      status: this.#synchronizationStatus,
      current: this.#scene === null ? null : copyVersion(this.#scene),
    });
  }

  public setCamera(camera: RenderCamera): CameraApplyResult {
    if (this.#synchronizationStatus === 'disposed' || this.#cameraState === null) {
      return Object.freeze({ status: 'disposed' });
    }
    const transition = transitionCameraState(this.#cameraState, camera);
    if (transition.status === 'invalid-camera') return transition;
    if (transition.status === 'unchanged') {
      return Object.freeze({ status: 'unchanged', current: copyCameraState(transition.state) });
    }
    this.#cameraState = transition.state;
    this.#cameraChanged = true;
    this.#invalidate();
    return Object.freeze({ status: 'applied', current: copyCameraState(transition.state) });
  }

  public getCameraState(): RenderCameraState | null {
    return this.#cameraState === null ? null : copyCameraState(this.#cameraState);
  }

  public readRetainedScene(): RetainedSceneView | null {
    const scene = this.#scene;
    if (scene === null || this.#synchronizationStatus === 'disposed') return null;
    // Once per version, on the frame path: the list and the view's own maps (E26 section 4.1).
    if (scene.view === null) mergePendingIds(this.#indexes);
    scene.view ??= Object.freeze({
      nodeList: Object.freeze(this.#indexes.sortedIds.map((id) => scene.nodes.get(id)!)),
      nodes: new Map(scene.nodes),
      geometryRevisions: new Map(scene.geometryRevisions),
    });
    const { nodes, geometryRevisions, nodeList } = scene.view;
    return Object.freeze({
      sceneEpoch: scene.sceneEpoch,
      version: copyVersion(scene),
      nodes: nodeList,
      rootOrder: scene.rootOrder,
      getNode: (id: string) => nodes.get(id),
      getGeometryRevision: (id: string) => geometryRevisions.get(id),
    });
  }

  public getPendingChangeState(): ScenePendingChangeState {
    return Object.freeze({
      sceneChanged: this.#sceneChanged,
      cameraChanged: this.#cameraChanged,
      invalidationToken: this.#invalidationToken,
    });
  }

  public dispose(): void {
    if (this.#synchronizationStatus === 'disposed') return;
    this.#scene = null;
    this.#cameraState = null;
    this.#sceneChanged = false;
    this.#cameraChanged = false;
    this.#invalidationToken = null;
    this.#onInvalidate = () => undefined;
    this.#indexes = emptyIndexes();
    this.#synchronizationStatus = 'disposed';
  }

  #publishScene(
    identity: SceneIdentity,
    revision: number,
    nodes: ReadonlyMap<string, RenderNodeSnapshot>,
    rootOrder: readonly string[],
    sceneEpoch: symbol = Symbol('scene-epoch'),
  ): OwnedScene | null {
    const ownedNodes = new Map(nodes);
    const revisions = assignGeometryRevisions(this.#scene, ownedNodes, this.#nextGeometryRevision);
    // Overflow publishes nothing (P3 V3 contract, section b).
    if (revisions === null) return null;
    const childrenByParent = new Map<string | null, Set<string>>();
    for (const node of ownedNodes.values()) addChild(childrenByParent, node.parentId, node.id);
    this.#indexes = {
      childrenByParent,
      sortedIds: [...ownedNodes.keys()].sort(compareOrdinal),
      pendingAdded: new Set(),
      pendingDeleted: new Set(),
    };
    const published: OwnedScene = {
      sceneEpoch,
      identity,
      revision,
      nodes: ownedNodes,
      rootOrder,
      geometryRevisions: new Map(revisions.revisions),
      view: null,
    };
    this.#nextGeometryRevision = revisions.next;
    this.#scene = published;
    this.#synchronizationStatus = 'synchronized';
    this.#sceneChanged = true;
    this.#invalidate();
    return published;
  }

  /**
   * Publishes an accepted set's writes over the current scene (E26 contract, section 4.1): the
   * live maps and the indexes are updated in place, and geometry revisions are assigned to the
   * written path nodes only, in ordinal order. Revision overflow publishes nothing, as
   * #publishScene.
   */
  #publishWrites(input: ValidatedChangesInput, candidate: CandidateScene): OwnedScene | null {
    const current = this.#scene!;
    const writtenIds = [...candidate.writes.keys()].sort(compareOrdinal);
    const assigned = new Map<string, number>();
    let next = this.#nextGeometryRevision;
    for (const id of writtenIds) {
      const node = candidate.writes.get(id);
      if (node === null || node === undefined || node.kind !== 'path') continue;
      const previous = current.nodes.get(id);
      const previousRevision = current.geometryRevisions.get(id);
      if (
        previous?.kind === 'path' &&
        previousRevision !== undefined &&
        pathDataEquals(previous.geometry, node.geometry)
      ) {
        continue;
      }
      if (next > Number.MAX_SAFE_INTEGER) return null;
      assigned.set(id, next);
      next += 1;
    }

    const { nodes, geometryRevisions } = current;
    const { childrenByParent, pendingAdded, pendingDeleted } = this.#indexes;
    for (const id of writtenIds) {
      const before = nodes.get(id);
      const after = candidate.writes.get(id)!;
      if (before !== undefined) removeChild(childrenByParent, before.parentId, id);
      if (after === null) {
        nodes.delete(id);
        geometryRevisions.delete(id);
        if (!pendingAdded.delete(id)) pendingDeleted.add(id);
        continue;
      }
      if (before === undefined && !pendingDeleted.delete(id)) pendingAdded.add(id);
      nodes.set(id, after);
      addChild(childrenByParent, after.parentId, id);
      const revision = assigned.get(id);
      if (revision !== undefined) geometryRevisions.set(id, revision);
      else if (after.kind !== 'path') geometryRevisions.delete(id);
    }
    const published: OwnedScene = {
      sceneEpoch: current.sceneEpoch,
      identity: input.identity,
      revision: input.revision,
      nodes,
      rootOrder: candidate.rootOrder,
      geometryRevisions,
      view: null,
    };
    this.#nextGeometryRevision = next;
    this.#scene = published;
    this.#synchronizationStatus = 'synchronized';
    this.#sceneChanged = true;
    this.#invalidate();
    return published;
  }

  #invalidate(): void {
    this.#invalidationToken = Symbol('scene-invalidation');
    this.#onInvalidate();
  }

  #invalidScene(reason: SceneRejectionReason): SceneApplyResult {
    return invalidSceneResult(reason, this.#scene);
  }
}

/**
 * Test seam (E26-A07): validate and publish this mirror's change sets with the full pre-E26
 * pipeline, the oracle of the incremental one. Not exported from the package index.
 */
export function useFullChangeValidationForTesting(mirror: RetainedSceneMirror): void {
  injectFullValidation(mirror);
}

/**
 * Test seam (E26-A07): the node lookups the last incremental change set made, from its
 * candidate's construction to its verdict. Not exported from the package index.
 */
export function lastSceneSetVisitsForTesting(mirror: RetainedSceneMirror): number {
  return readLastSetVisits(mirror);
}

/** Test seam for the V3-A2 overflow fixture; not exported from the package index. */
export function setNextGeometryRevisionForTesting(mirror: RetainedSceneMirror, next: number): void {
  injectNextGeometryRevision(mirror, next);
}

/**
 * P3 V3 contract, section b: a published path node keeps the resident node's revision when the
 * resident node with the same id is a path with equal verbs and points; otherwise it takes the
 * next counter value. Returns null when a value above Number.MAX_SAFE_INTEGER would be needed.
 */
function assignGeometryRevisions(
  resident: OwnedScene | null,
  nodes: ReadonlyMap<string, RenderNodeSnapshot>,
  nextRevision: number,
): Readonly<{ revisions: ReadonlyMap<string, number>; next: number }> | null {
  const revisions = new Map<string, number>();
  let next = nextRevision;
  for (const id of [...nodes.keys()].sort(compareOrdinal)) {
    const node = nodes.get(id)!;
    if (node.kind !== 'path') continue;
    const previous = resident?.nodes.get(id);
    const previousRevision = resident?.geometryRevisions.get(id);
    if (
      previous?.kind === 'path' &&
      previousRevision !== undefined &&
      pathDataEquals(previous.geometry, node.geometry)
    ) {
      revisions.set(id, previousRevision);
      continue;
    }
    if (next > Number.MAX_SAFE_INTEGER) return null;
    revisions.set(id, next);
    next += 1;
  }
  return Object.freeze({ revisions, next });
}

/** Production transition logic is separately callable for the controlled overflow fixture. */
export function transitionCameraState(
  current: RenderCameraState,
  input: unknown,
): CameraTransition {
  let camera: RenderCamera | null;
  try {
    camera = copyCamera(input);
  } catch {
    camera = null;
  }
  if (camera === null) {
    return Object.freeze({ status: 'invalid-camera', reason: 'invalid-value' });
  }
  if (
    camera.position.x === current.camera.position.x &&
    camera.position.y === current.camera.position.y &&
    camera.zoom === current.camera.zoom
  ) {
    return Object.freeze({ status: 'unchanged', state: current });
  }
  if (current.revision === Number.MAX_SAFE_INTEGER) {
    return Object.freeze({ status: 'invalid-camera', reason: 'revision-overflow' });
  }
  return Object.freeze({
    status: 'applied',
    state: freezeCameraState(camera, current.revision + 1),
  });
}

function validateOperations(
  current: OwnedScene,
  input: ValidatedChangesInput,
): 'duplicate-id' | 'conflicting-operation' | 'unknown-node' | null {
  for (const group of [input.inserted, input.updated]) {
    if (firstDuplicateNodeId(group) !== null) return 'duplicate-id';
  }
  if (new Set(input.removed).size !== input.removed.length) return 'duplicate-id';

  const inserted = new Set(input.inserted.map(({ node }) => node.id));
  const updated = new Set(input.updated.map(({ node }) => node.id));
  const removed = new Set(input.removed);
  if (
    intersects(inserted, updated) ||
    intersects(inserted, removed) ||
    intersects(updated, removed)
  )
    return 'conflicting-operation';
  if ([...inserted].some((id) => current.nodes.has(id))) return 'duplicate-id';

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

  if ([...updated, ...removed].some((id) => !current.nodes.has(id))) return 'unknown-node';
  const knownAfterNodeOperations = new Set(current.nodes.keys());
  for (const id of removed) knownAfterNodeOperations.delete(id);
  for (const id of inserted) knownAfterNodeOperations.add(id);
  for (const order of input.orders) {
    if (order.parentId !== null && !knownAfterNodeOperations.has(order.parentId)) {
      return 'unknown-node';
    }
    if (order.children.some((id) => !knownAfterNodeOperations.has(id))) return 'unknown-node';
  }
  return null;
}

function applyCandidate(
  current: OwnedScene,
  input: ValidatedChangesInput,
): Readonly<{ nodes: ReadonlyMap<string, RenderNodeSnapshot>; rootOrder: readonly string[] }> {
  const nodes = new Map(current.nodes);
  for (const id of input.removed) nodes.delete(id);
  for (const { node } of input.inserted) nodes.set(node.id, node);
  for (const { node } of input.updated) nodes.set(node.id, node);
  let rootOrder = current.rootOrder;
  for (const order of input.orders) {
    if (order.parentId === null) {
      rootOrder = order.children;
    } else {
      const parent = nodes.get(order.parentId);
      if (parent?.kind === 'container') {
        nodes.set(parent.id, Object.freeze({ ...parent, children: order.children }));
      }
    }
  }
  return Object.freeze({ nodes, rootOrder });
}

function mapSnapshotNodes(input: ValidatedSnapshotInput): ReadonlyMap<string, RenderNodeSnapshot> {
  const nodes = new Map<string, RenderNodeSnapshot>();
  for (const { node } of input.nodes) nodes.set(node.id, node);
  return nodes;
}

function copyCamera(value: unknown): RenderCamera | null {
  if (!isExactObject(value, ['position', 'zoom'])) return null;
  const record = value as Record<string, unknown>;
  if (!isExactObject(record.position, ['x', 'y'])) return null;
  const position = record.position as Record<string, unknown>;
  if (
    typeof position.x !== 'number' ||
    !Number.isFinite(position.x) ||
    typeof position.y !== 'number' ||
    !Number.isFinite(position.y) ||
    typeof record.zoom !== 'number' ||
    !Number.isFinite(record.zoom) ||
    record.zoom <= 0
  )
    return null;
  return Object.freeze({
    position: Object.freeze({ x: position.x, y: position.y }),
    zoom: record.zoom,
  });
}

function isExactObject(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function freezeCameraState(camera: RenderCamera, revision: number): RenderCameraState {
  const copy = copyCamera(camera)!;
  return Object.freeze({ camera: copy, revision });
}

function copyCameraState(state: RenderCameraState): RenderCameraState {
  return freezeCameraState(state.camera, state.revision);
}

function copyVersion(scene: Pick<OwnedScene, 'identity' | 'revision'>): SceneVersion {
  return Object.freeze({
    identity: Object.freeze({
      documentId: scene.identity.documentId,
      pageId: scene.identity.pageId,
    }),
    revision: scene.revision,
  });
}

function appliedResult(scene: OwnedScene): SceneApplyResult {
  return Object.freeze({ status: 'applied', current: copyVersion(scene) });
}

function replayedResult(scene: OwnedScene): SceneApplyResult {
  return Object.freeze({ status: 'replayed', current: copyVersion(scene) });
}

function invalidSceneResult(
  reason: SceneRejectionReason,
  scene: OwnedScene | null,
): SceneApplyResult {
  return Object.freeze({
    status: 'invalid-scene',
    reason,
    current: scene === null ? null : copyVersion(scene),
  });
}

function resyncResult(scene: OwnedScene | null): SceneApplyResult {
  return Object.freeze({
    status: 'resync-required',
    current: scene === null ? null : copyVersion(scene),
  });
}

function disposedResult(): SceneApplyResult {
  return Object.freeze({ status: 'disposed' });
}

function identitiesEqual(left: SceneIdentity, right: SceneIdentity): boolean {
  return left.documentId === right.documentId && left.pageId === right.pageId;
}

function intersects<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addChild(index: Map<string | null, Set<string>>, parent: string | null, id: string) {
  let set = index.get(parent);
  if (set === undefined) {
    set = new Set();
    index.set(parent, set);
  }
  set.add(id);
}

function removeChild(index: Map<string | null, Set<string>>, parent: string | null, id: string) {
  const set = index.get(parent);
  if (set === undefined) return;
  set.delete(id);
  if (set.size === 0) index.delete(parent);
}

/**
 * Merges the IDs added and deleted since the last read into the ordinal-sorted IDs: one pass,
 * on the frame path with the view's copy (E26 contract, section 4.1).
 */
function mergePendingIds(indexes: SceneIndexes): void {
  const { pendingAdded, pendingDeleted } = indexes;
  if (pendingAdded.size === 0 && pendingDeleted.size === 0) return;
  const added = [...pendingAdded].sort(compareOrdinal);
  const merged: string[] = [];
  let next = 0;
  for (const id of indexes.sortedIds) {
    if (pendingDeleted.has(id)) continue;
    while (next < added.length && compareOrdinal(added[next]!, id) < 0) merged.push(added[next++]!);
    merged.push(id);
  }
  while (next < added.length) merged.push(added[next++]!);
  indexes.sortedIds = merged;
  pendingAdded.clear();
  pendingDeleted.clear();
}
