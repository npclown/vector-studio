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
import { hasFiniteSceneArithmetic } from './scene-numeric.js';
import {
  firstDuplicateNodeId,
  snapshotsEqual,
  validateCandidateGraph,
  validateChangesShape,
  validateSnapshotShape,
  type ValidatedChangesInput,
  type ValidatedSnapshotInput,
} from './scene-validation.js';

export type RetainedSceneView = Readonly<{
  version: SceneVersion;
  nodes: readonly RenderNodeSnapshot[];
  rootOrder: readonly string[];
  getNode(id: string): RenderNodeSnapshot | undefined;
}>;

export type ScenePendingChangeState = Readonly<{
  sceneChanged: boolean;
  cameraChanged: boolean;
  invalidationToken: symbol | null;
}>;

type CameraTransition =
  | Readonly<{ status: 'applied' | 'unchanged'; state: RenderCameraState }>
  | Readonly<{ status: 'invalid-camera'; reason: 'invalid-value' | 'revision-overflow' }>;

type OwnedScene = Readonly<{
  identity: SceneIdentity;
  revision: number;
  nodes: ReadonlyMap<string, RenderNodeSnapshot>;
  nodeList: readonly RenderNodeSnapshot[];
  rootOrder: readonly string[];
}>;

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

  public constructor(onInvalidate: () => void = () => undefined) {
    this.#onInvalidate = onInvalidate;
  }

  public replaceSnapshot(snapshot: RenderSceneSnapshot): SceneApplyResult {
    if (this.#synchronizationStatus === 'disposed') return disposedResult();

    let input: ValidatedSnapshotInput | null;
    try {
      input = validateSnapshotShape(snapshot);
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
    );
    if (graphReason !== null) return this.#invalidScene(graphReason);

    const published = this.#publishScene(
      input.identity,
      input.revision,
      candidateNodes,
      input.rootOrder,
    );
    return appliedResult(published);
  }

  public applyChanges(changes: RenderChangeSet): SceneApplyResult {
    if (this.#synchronizationStatus === 'disposed') return disposedResult();
    if (this.#synchronizationStatus !== 'synchronized' || this.#scene === null) {
      this.#synchronizationStatus = 'resync-required';
      return resyncResult(this.#scene);
    }

    let input: ValidatedChangesInput | null;
    try {
      input = validateChangesShape(changes);
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
    );
    if (graphReason === 'unknown-node') return this.#invalidScene(graphReason);
    if (hasInvalidOrderParent) return this.#invalidScene('invalid-parent');
    if (graphReason !== null) return this.#invalidScene(graphReason);

    const published = this.#publishScene(
      input.identity,
      input.revision,
      candidate.nodes,
      candidate.rootOrder,
    );
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
    return Object.freeze({
      version: copyVersion(scene),
      nodes: scene.nodeList,
      rootOrder: scene.rootOrder,
      getNode: (id: string) => scene.nodes.get(id),
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
    this.#synchronizationStatus = 'disposed';
  }

  #publishScene(
    identity: SceneIdentity,
    revision: number,
    nodes: ReadonlyMap<string, RenderNodeSnapshot>,
    rootOrder: readonly string[],
  ): OwnedScene {
    const ownedNodes = new Map(nodes);
    const nodeList = Object.freeze([...ownedNodes.values()].sort(compareNodes));
    const published = Object.freeze({ identity, revision, nodes: ownedNodes, nodeList, rootOrder });
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

function compareNodes(left: RenderNodeSnapshot, right: RenderNodeSnapshot): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
