import type {
  RenderNodeSnapshot,
  RendererSceneSynchronization,
  SceneApplyResult,
  SceneIdentity,
  SceneRejectionReason,
  ScenePathGeometry,
} from '@vector-studio/contracts';
import type { DocumentV1, NodeV1, PathData } from '@vector-studio/model';
import type { DiagnosticEvent } from './types.js';

// The scene projector (P5 plan, section 4.5): maps the document to `contracts` scene data and
// keeps an injected renderer synchronized with it.

/** Frame-local path geometry for a custom node (its extension's `toScene`), or null. */
export type CustomProjection = (node: NodeV1) => PathData | null;

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function pathGeometry(path: PathData, sx: number, sy: number): ScenePathGeometry {
  return {
    kind: 'path',
    verbs: [...path.verbs],
    points: path.points.map((value, index) => value * (index % 2 === 0 ? sx : sy) + 0),
    fillRule: path.fillRule,
  };
}

/** One node's scene snapshot, or null when it cannot be projected (an unowned custom type). */
export function projectNode(node: NodeV1, custom: CustomProjection): RenderNodeSnapshot | null {
  const base = {
    id: node.id,
    parentId: null,
    // Translation to the frame origin only (plan section 4.5).
    transform: [1, 0, 0, 1, node.frame.x, node.frame.y] as const,
    visible: node.visible,
    opacity: node.opacity,
  };
  switch (node.type) {
    case 'rectangle':
      return {
        ...base,
        kind: 'primitive',
        geometry: {
          kind: 'rectangle',
          width: node.frame.width,
          height: node.frame.height,
          cornerRadii: [0, 0, 0, 0],
        },
        style: { fill: node.fill, stroke: node.stroke },
      };
    case 'path':
      // Unit-box points scale by the frame; stroke width stays in page units.
      return {
        ...base,
        kind: 'path',
        geometry: pathGeometry(node.path, node.frame.width, node.frame.height),
        style: { fill: node.fill, stroke: node.stroke },
      };
    case 'custom': {
      const geometry = custom(node);
      if (geometry === null) return null;
      return {
        ...base,
        kind: 'path',
        geometry: pathGeometry(geometry, 1, 1),
        style: { fill: node.fill, stroke: node.stroke },
      };
    }
  }
}

export class SceneProjector {
  private readonly renderer: RendererSceneSynchronization;
  private readonly custom: CustomProjection;
  private readonly report: (event: DiagnosticEvent) => void;
  /** The projector's own revision; every scene it sends carries a larger one. */
  private sceneRevision = 0;
  /** The renderer's revision from the last result, the base of the next change set. */
  private base: number | null = null;
  private identity: SceneIdentity | null = null;
  /** What the renderer holds, as far as the projector knows. */
  private sent = new Map<string, RenderNodeSnapshot>();
  private sentOrder: readonly string[] = [];
  /** Nodes left out after a rejection, until a document change touches them again. */
  private readonly excluded = new Set<string>();
  private disposed = false;

  constructor(
    renderer: RendererSceneSynchronization,
    custom: CustomProjection,
    report: (event: DiagnosticEvent) => void,
  ) {
    this.renderer = renderer;
    this.custom = custom;
    this.report = report;
  }

  get active(): boolean {
    return !this.disposed;
  }

  /** Sends the whole projection: on attach, after a load and after `resync-required`. */
  replace(document: DocumentV1): void {
    if (this.disposed) return;
    const { nodes, order } = this.project(document, document.pages[0].children);
    const identity = { documentId: document.id, pageId: document.pages[0].id };
    const result = this.renderer.replaceSnapshot({
      identity,
      revision: this.nextRevision(),
      nodes: [...nodes.values()],
      rootOrder: order,
    });
    if (this.accepted(result)) {
      this.identity = identity;
      this.sent = nodes;
      this.sentOrder = order;
      return;
    }
    this.identity = null;
    this.base = null;
    if (result.status !== 'invalid-scene') return;
    // Start from an empty scene and add the nodes one at a time, so only the nodes the renderer
    // rejects on their own are left out.
    const empty = this.renderer.replaceSnapshot({
      identity,
      revision: this.nextRevision(),
      nodes: [],
      rootOrder: [],
    });
    if (!this.accepted(empty)) {
      if (empty.status === 'invalid-scene') this.exclude(empty, [...nodes.keys()]);
      return;
    }
    this.identity = identity;
    this.sent = new Map();
    this.sentOrder = [];
    this.isolate(document, [...nodes.values()], nodes.size === 1 ? result : null);
  }

  /** Sends one change set for a document change that touched `touched`. */
  change(document: DocumentV1, touched: readonly string[]): void {
    if (this.disposed) return;
    touched.forEach((id) => this.excluded.delete(id));
    if (this.identity === null || this.base === null) {
      this.replace(document);
      return;
    }
    const candidates: RenderNodeSnapshot[] = [];
    const removed: string[] = [];
    for (const id of touched) {
      const node = Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;
      const snapshot = node === undefined ? null : projectNode(node, this.custom);
      if (snapshot !== null) candidates.push(snapshot);
      else if (this.sent.has(id)) removed.push(id);
    }
    const result = this.send(document, candidates, removed);
    if (result === null || this.accepted(result)) return;
    if (result.status === 'resync-required') {
      this.identity = null;
      this.base = null;
      this.replace(document);
    } else if (result.status === 'invalid-scene') {
      // Apply the removals alone, then each node on its own.
      if (removed.length > 0 && candidates.length > 0) {
        const removal = this.send(document, [], removed);
        if (removal !== null && !this.accepted(removal)) return;
      }
      if (candidates.length === 0) this.exclude(result, removed);
      else this.isolate(document, candidates, removed.length === 0 ? result : null);
    }
  }

  /**
   * Sends each node in its own change set after they were rejected together; `first` is that
   * result when it already was a single-node set. The ones the
   * renderer rejects on their own are reported once per reason and left out; a stale copy of a
   * rejected node is dropped from the renderer.
   */
  private isolate(
    document: DocumentV1,
    candidates: readonly RenderNodeSnapshot[],
    first: SceneApplyResult | null,
  ): void {
    const rejected = new Map<SceneRejectionReason, string[]>();
    const remember = (result: SceneApplyResult, id: string) => {
      if (result.status !== 'invalid-scene') return false;
      rejected.set(result.reason, [...(rejected.get(result.reason) ?? []), id]);
      return true;
    };
    const single = first !== null && candidates.length === 1;
    if (single) remember(first, candidates[0]!.id);
    for (const snapshot of single ? [] : candidates) {
      const result = this.send(document, [snapshot], []);
      if (result === null || this.accepted(result)) continue;
      if (!remember(result, snapshot.id)) return;
    }
    const stale = [...rejected.values()].flat().filter((id) => this.sent.has(id));
    if (stale.length > 0) this.send(document, [], stale);
    for (const [reason, ids] of rejected) this.exclude({ reason }, ids);
  }

  /**
   * Sends inserts and updates of `candidates` and the removal of `removed`, with an order entry
   * when the paint order changes. Returns null when there is nothing to send or after a
   * `disposed` result; state is updated only on success.
   */
  private send(
    document: DocumentV1,
    candidates: readonly RenderNodeSnapshot[],
    removed: readonly string[],
  ): SceneApplyResult | null {
    if (this.disposed || this.identity === null || this.base === null) return null;
    const next = new Map(this.sent);
    removed.forEach((id) => next.delete(id));
    candidates.forEach((snapshot) => next.set(snapshot.id, snapshot));
    const order = document.pages[0].children.filter((id) => next.has(id));
    const reordered = !sameStrings(order, this.sentOrder);
    if (candidates.length === 0 && removed.length === 0 && !reordered) return null;
    const result = this.renderer.applyChanges({
      identity: this.identity,
      revision: this.nextRevision(),
      baseRevision: this.base,
      inserted: candidates.filter((snapshot) => !this.sent.has(snapshot.id)),
      updated: candidates.filter((snapshot) => this.sent.has(snapshot.id)),
      removed: [...removed],
      orders: reordered ? [{ parentId: null, children: order }] : [],
    });
    if (this.accepted(result)) {
      this.sent = next;
      this.sentOrder = order;
    }
    return result.status === 'disposed' ? null : result;
  }

  /** Records the renderer's revision on success, and marks the projector dead on `disposed`. */
  private accepted(result: SceneApplyResult): boolean {
    if (result.status === 'disposed') {
      this.disposed = true;
      return false;
    }
    if (result.status !== 'applied' && result.status !== 'replayed') return false;
    this.base = result.current.revision;
    return true;
  }

  /** Reports a rejection and leaves its nodes out until a change touches them again. */
  private exclude(
    result: Readonly<{ reason: SceneRejectionReason }>,
    ids: readonly string[],
  ): void {
    if (ids.length === 0) return;
    this.report({
      type: 'diagnostic',
      code:
        result.reason === 'unsupported-feature'
          ? 'editor.renderer-unsupported'
          : 'editor.scene-rejected',
      reason: result.reason,
      nodeIds: [...ids].sort(),
    });
    ids.forEach((id) => this.excluded.add(id));
  }

  private project(document: DocumentV1, children: readonly string[]) {
    const nodes = new Map<string, RenderNodeSnapshot>();
    for (const id of children) {
      if (this.excluded.has(id)) continue;
      const snapshot = projectNode(document.nodes[id]!, this.custom);
      if (snapshot !== null) nodes.set(id, snapshot);
    }
    return { nodes, order: children.filter((id) => nodes.has(id)) };
  }

  private nextRevision(): number {
    this.sceneRevision = Math.max(this.sceneRevision, this.base ?? 0) + 1;
    return this.sceneRevision;
  }
}
