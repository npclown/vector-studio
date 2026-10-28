import type {
  RenderNodeSnapshot,
  RendererSceneSynchronization,
  SceneApplyResult,
  SceneIdentity,
  SceneRejectionReason,
  ScenePathGeometry,
} from '@vector-studio/contracts';
import type { DocumentV2, NodeV2, PathData } from '@vector-studio/model';
import { localTransform } from './geometry.js';
import type { DiagnosticEvent } from './types.js';

// The scene projector (P5 plan, section 4.5): maps the active page of the document to
// `contracts` scene data and keeps an injected renderer synchronized with it.
//
// M1-U2 scope: rectangle, path and custom nodes at the page root project as in P5, with the
// section 5 transform (exactly P5's translation for θ = 0) and clamped corner radii. Ellipses,
// lines and containers with their subtrees are not projected yet: their projection, synthetic
// frame nodes and the per-subtree isolation are M1-U3.

/** Frame-local path geometry for a custom node (its extension's `toScene`), or null. */
export type CustomProjection = (node: NodeV2) => PathData | null;

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

/** Corner radii scaled by `min(1, w/(tl+tr), w/(bl+br), h/(tl+bl), h/(tr+br))` (section 5). */
export function clampedRadii(
  radii: readonly [number, number, number, number],
  width: number,
  height: number,
): [number, number, number, number] {
  const [tl, tr, br, bl] = radii;
  let f = 1;
  for (const [size, sum] of [
    [width, tl + tr],
    [width, bl + br],
    [height, tl + bl],
    [height, tr + br],
  ] as const) {
    if (sum > 0) f = Math.min(f, size / sum);
  }
  return f === 1 ? [tl, tr, br, bl] : [tl * f, tr * f, br * f, bl * f];
}

/**
 * One page-root node's scene snapshot, or null when it cannot be projected: an unowned custom
 * type, or a node type whose projection is M1-U3 work (ellipse, line, containers).
 */
export function projectNode(node: NodeV2, custom: CustomProjection): RenderNodeSnapshot | null {
  const base = {
    id: node.id,
    parentId: null,
    // Exactly the translation to the frame origin for θ = 0 (P5), else section 5's rotation.
    transform: localTransform(node.frame, node.rotation),
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
          cornerRadii: clampedRadii(node.cornerRadii, node.frame.width, node.frame.height),
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
    default:
      // Ellipse, line, group, mask group and frame: projected by M1-U3.
      return null;
  }
}

/** Whether `node` is projected on `page`: a page child (M1-U2; nested nodes come with M1-U3). */
function onPageRoot(node: NodeV2 | undefined, page: string): node is NodeV2 {
  return node !== undefined && node.parent === page;
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
  private resyncing = false;
  /** The page the projection shows (M1 contract, section 3). */
  private page = '';

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

  /**
   * Sends the whole projection of `page`: on attach, after a load, after a change of active page
   * and after `resync-required`.
   */
  replace(document: DocumentV2, page: string, retried = false): void {
    if (this.disposed) return;
    this.page = page;
    // A renderer may already hold a scene from an earlier attach; start above its revision.
    this.raiseRevision(this.renderer.getSynchronizationState().current?.revision);
    const { nodes, order } = this.project(document, this.childrenOf(document));
    const identity = { documentId: document.id, pageId: page };
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
    if (result.reason === 'stale-snapshot' || result.reason === 'revision-conflict') {
      // Revision bookkeeping, not a node rejection: move above the renderer and send once more.
      this.raiseRevision(result.current?.revision);
      if (!retried) this.replace(document, page, true);
      return;
    }
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

  /** Sends one change set for a document change on `page` that touched `touched`. */
  change(document: DocumentV2, page: string, touched: readonly string[]): void {
    if (this.disposed) return;
    touched.forEach((id) => this.excluded.delete(id));
    if (this.identity === null || this.base === null || this.page !== page) {
      this.replace(document, page);
      return;
    }
    const candidates: RenderNodeSnapshot[] = [];
    const removed: string[] = [];
    for (const id of touched) {
      const node = Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;
      const snapshot = onPageRoot(node, page) ? projectNode(node, this.custom) : null;
      if (snapshot !== null) candidates.push(snapshot);
      else if (this.sent.has(id)) removed.push(id);
    }
    const result = this.send(document, candidates, removed);
    if (result === null || this.accepted(result)) return;
    if (result.status !== 'invalid-scene') {
      this.resync(document);
    } else if (candidates.length === 0) {
      // A rejected removal leaves nodes the document no longer has; a snapshot drops them.
      this.exclude(result, removed);
      this.resync(document);
    } else {
      // Apply the removals alone, then each node on its own.
      if (removed.length > 0) {
        const removal = this.send(document, [], removed);
        if (removal !== null && !this.accepted(removal)) {
          this.resync(document);
          return;
        }
      }
      this.isolate(document, candidates, removed.length === 0 ? result : null);
    }
  }

  /**
   * Sends each node in its own change set after they were rejected together; `first` is that
   * result when it already was a single-node set. The nodes the renderer rejects on their own
   * are reported once per reason and left out, and a stale copy of a rejected node is dropped
   * from the renderer. Any other failure ends in a full snapshot.
   */
  private isolate(
    document: DocumentV2,
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
    let failed = false;
    for (const snapshot of single ? [] : candidates) {
      const result = this.send(document, [snapshot], []);
      if (result === null || this.accepted(result)) continue;
      if (!remember(result, snapshot.id)) {
        failed = true;
        break;
      }
    }
    const stale = [...rejected.values()].flat().filter((id) => this.sent.has(id));
    if (!failed && stale.length > 0) {
      const result = this.send(document, [], stale);
      failed = result !== null && !this.accepted(result);
    }
    for (const [reason, ids] of rejected) this.exclude({ reason }, ids);
    if (failed) this.resync(document);
  }

  /**
   * Forgets the renderer's state and sends a full snapshot, once per call chain: a renderer
   * that keeps failing is retried at the next document change, never in a loop.
   */
  private resync(document: DocumentV2): void {
    this.identity = null;
    this.base = null;
    if (this.resyncing) return;
    this.resyncing = true;
    try {
      this.replace(document, this.page);
    } finally {
      this.resyncing = false;
    }
  }

  /**
   * Sends inserts and updates of `candidates` and the removal of `removed`, with an order entry
   * when the paint order changes. Returns null when there is nothing to send or after a
   * `disposed` result; state is updated only on success.
   */
  private send(
    document: DocumentV2,
    candidates: readonly RenderNodeSnapshot[],
    removed: readonly string[],
  ): SceneApplyResult | null {
    if (this.disposed || this.identity === null || this.base === null) return null;
    const next = new Map(this.sent);
    removed.forEach((id) => next.delete(id));
    candidates.forEach((snapshot) => next.set(snapshot.id, snapshot));
    const order = this.childrenOf(document).filter((id) => next.has(id));
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

  /** The active page's children, or none when the page is gone. */
  private childrenOf(document: DocumentV2): readonly string[] {
    return document.pages.find((entry) => entry.id === this.page)?.children ?? [];
  }

  private project(document: DocumentV2, children: readonly string[]) {
    const nodes = new Map<string, RenderNodeSnapshot>();
    for (const id of children) {
      if (this.excluded.has(id)) continue;
      const snapshot = projectNode(document.nodes[id]!, this.custom);
      if (snapshot !== null) nodes.set(id, snapshot);
    }
    return { nodes, order: children.filter((id) => nodes.has(id)) };
  }

  private raiseRevision(revision: number | undefined): void {
    if (revision !== undefined) this.sceneRevision = Math.max(this.sceneRevision, revision);
  }

  private nextRevision(): number {
    this.sceneRevision = Math.max(this.sceneRevision, this.base ?? 0) + 1;
    return this.sceneRevision;
  }
}
