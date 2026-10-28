import type {
  RenderChangeSet,
  RenderNodeSnapshot,
  RendererSceneSynchronization,
  SceneApplyResult,
  SceneIdentity,
  SceneRejectionReason,
  ScenePathGeometry,
  ScenePathVerb,
} from '@vector-studio/contracts';
import type { DocumentV2, FrameNode, LineNode, NodeV2, PathData } from '@vector-studio/model';
import { localTransform } from './geometry.js';
import type { DiagnosticEvent } from './types.js';

// The scene projector (P5 plan, section 4.5; MVP M1 contract, section 5): maps the active page of
// the document to `contracts` scene data and keeps an injected renderer synchronized with it.
//
// Every node of the page projects with its parent-local transform under its scene parent: the
// page root (`null`), a group or mask group (its ID) or a frame's content container. A frame is
// one unit of two to four scene nodes with synthetic IDs (the frame ID, U+0000 and a role). After
// a rejected set the projector isolates the units one per set in document pre-order and leaves
// the rejected ones out with their subtrees, until a change touches the subtree again.

/** Frame-local path geometry for a custom node (its extension's `toScene`), or null. */
export type CustomProjection = (node: NodeV2) => PathData | null;

/** Synthetic scene IDs of a frame (M1 contract, section 5); document IDs never hold U+0000. */
export function frameContentId(frameId: string): string {
  return `${frameId}\u0000content`;
}
export function frameBackgroundId(frameId: string): string {
  return `${frameId}\u0000background`;
}
export function frameBorderId(frameId: string): string {
  return `${frameId}\u0000border`;
}

/** The document ID a scene ID stands for: synthetic frame IDs map back to the frame. */
export function documentIdOf(sceneId: string): string {
  const index = sceneId.indexOf('\u0000');
  return index < 0 ? sceneId : sceneId.slice(0, index);
}

const IDENTITY_TRANSFORM = [1, 0, 0, 1, 0, 0] as const;
const ZERO_RADII = [0, 0, 0, 0] as const;
/** The cubic half-disc constant of the line fill outline, literal by contract (section 5). */
const KAPPA = 0.5523;
/** Above the model's tree depth bound (256), so every walk up a parent chain ends. */
const PARENT_WALK_LIMIT = 300;

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

type Vec = Readonly<{ x: number; y: number }>;

/** `p + s·q`. */
function add(p: Vec, q: Vec, s = 1): Vec {
  return { x: p.x + q.x * s, y: p.y + q.y * s };
}

/** A path built from subpaths; negative zero is removed so equal geometry compares equal. */
class Outline {
  readonly verbs: ScenePathVerb[] = [];
  readonly points: number[] = [];

  private push(verb: ScenePathVerb, points: readonly Vec[]): this {
    this.verbs.push(verb);
    for (const p of points) this.points.push(p.x + 0, p.y + 0);
    return this;
  }

  move(p: Vec): this {
    return this.push('move', [p]);
  }

  line(p: Vec): this {
    return this.push('line', [p]);
  }

  cubic(c1: Vec, c2: Vec, p: Vec): this {
    return this.push('cubic', [c1, c2, p]);
  }

  close(): this {
    return this.push('close', []);
  }

  polygon(vertices: readonly Vec[]): this {
    this.move(vertices[0]!);
    vertices.slice(1).forEach((vertex) => this.line(vertex));
    return this.close();
  }

  /** The closed quad of width `w` along `from → to`: the shaft and line-head rectangle form. */
  bar(from: Vec, to: Vec, w: number): this {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const m = { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
    const q = { x: -m.y, y: m.x };
    const h = w / 2;
    return this.polygon([add(from, q, -h), add(to, q, -h), add(to, q, h), add(from, q, h)]);
  }

  geometry(): ScenePathGeometry {
    return { kind: 'path', verbs: this.verbs, points: this.points, fillRule: 'nonzero' };
  }
}

type PathContent = Pick<Extract<RenderNodeSnapshot, { kind: 'path' }>, 'geometry' | 'style'>;

/**
 * The scene content of a line (section 5): stroke mode (no `triangle` end) keeps the line's
 * stroke; fill mode is one filled outline in the stroke colour, with the literal vertex lists.
 */
export function lineContent(node: LineNode): PathContent {
  const { width: fw, height: fh } = node.frame;
  const [x0, y0, x1, y1] = node.points;
  const p0 = { x: x0 * fw, y: y0 * fh };
  const p1 = { x: x1 * fw, y: y1 * fh };
  const stroke = node.stroke;
  const w = stroke?.width ?? 0;
  const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const plain = new Outline().move(p0).line(p1);
  if (stroke === null || w === 0 || length === 0) {
    return { geometry: plain.geometry(), style: { fill: null, stroke } };
  }
  const d = { x: (p1.x - p0.x) / length, y: (p1.y - p0.y) / length };
  const n = { x: -d.y, y: d.x };
  // Each end: tip T, outward direction u, base centre B = T − 4w·u, base corners B ± 2w·n, and
  // the cap side N (n at P0, −n at P1).
  const ends = (
    [
      [node.startArrow, p0, { x: -d.x, y: -d.y }, n],
      [node.endArrow, p1, d, { x: -n.x, y: -n.y }],
    ] as const
  ).map(([arrow, tip, out, side]) => {
    const base = add(tip, out, -4 * w);
    return { arrow, tip, out, side, base, plus: add(base, n, 2 * w), minus: add(base, n, -2 * w) };
  });
  if (ends.every((end) => end.arrow !== 'triangle')) {
    for (const end of ends) {
      if (end.arrow === 'line') plain.move(end.plus).line(end.tip).line(end.minus);
    }
    return { geometry: plain.geometry(), style: { fill: null, stroke } };
  }
  const outline = new Outline();
  const [start, end] = [ends[0]!, ends[1]!];
  const s0 = start.arrow === 'triangle' ? start.base : start.tip;
  const s1 = end.arrow === 'triangle' ? end.base : end.tip;
  // The shaft and its cap pieces, unless the heads leave no shaft (tested before extension).
  if ((s1.x - s0.x) * d.x + (s1.y - s0.y) * d.y > 0) {
    const square = stroke.cap === 'square';
    const a0 = square && start.arrow !== 'triangle' ? add(s0, d, -w / 2) : s0;
    const a1 = square && end.arrow !== 'triangle' ? add(s1, d, w / 2) : s1;
    outline.bar(a0, a1, w);
    if (stroke.cap === 'round') {
      const h = w / 2;
      for (const { arrow, tip: e, out: u, side: s } of ends) {
        if (arrow === 'triangle') continue;
        outline
          .move(add(e, s, h))
          .cubic(
            add(e, { x: s.x + KAPPA * u.x, y: s.y + KAPPA * u.y }, h),
            add(e, { x: u.x + KAPPA * s.x, y: u.y + KAPPA * s.y }, h),
            add(e, u, h),
          )
          .cubic(
            add(e, { x: u.x - KAPPA * s.x, y: u.y - KAPPA * s.y }, h),
            add(e, { x: KAPPA * u.x - s.x, y: KAPPA * u.y - s.y }, h),
            add(e, s, -h),
          )
          .close();
      }
    }
  }
  ends.forEach((head, index) => {
    if (head.arrow === 'triangle') {
      outline.polygon(
        index === 0 ? [head.tip, head.minus, head.plus] : [head.tip, head.plus, head.minus],
      );
    } else if (head.arrow === 'line') {
      outline.bar(head.tip, head.plus, w).bar(head.tip, head.minus, w);
    }
  });
  return { geometry: outline.geometry(), style: { fill: stroke.color, stroke: null } };
}

/**
 * One leaf node's scene snapshot under the scene parent `parentId`, or null when it cannot be
 * projected (an unowned custom type, or a container: containers project through `projectPage`).
 */
export function projectNode(
  node: NodeV2,
  custom: CustomProjection,
  parentId: string | null = null,
): RenderNodeSnapshot | null {
  const base = {
    id: node.id,
    parentId,
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
    case 'ellipse':
      return {
        ...base,
        kind: 'primitive',
        geometry: { kind: 'ellipse', width: node.frame.width, height: node.frame.height },
        style: { fill: node.fill, stroke: node.stroke },
      };
    case 'line':
      return { ...base, kind: 'path', ...lineContent(node) };
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
      return null;
  }
}

type ContainerSnapshot = Extract<RenderNodeSnapshot, { kind: 'container' }>;

/**
 * The scene nodes of a frame (section 5), outer first: the outer container, its content
 * container (rect clip) holding the background and `children`, and the border.
 */
function frameSnapshots(
  node: FrameNode,
  parentId: string | null,
  children: readonly string[],
): RenderNodeSnapshot[] {
  const { width, height } = node.frame;
  const content = frameContentId(node.id);
  const inner = { transform: IDENTITY_TRANSFORM, visible: true, opacity: 1 };
  const rectangle = { kind: 'rectangle' as const, width, height, cornerRadii: ZERO_RADII };
  const background: RenderNodeSnapshot | null =
    node.fill === null
      ? null
      : {
          id: frameBackgroundId(node.id),
          parentId: content,
          ...inner,
          kind: 'primitive',
          geometry: rectangle,
          style: { fill: node.fill, stroke: null },
        };
  const border: RenderNodeSnapshot | null =
    node.stroke === null
      ? null
      : {
          id: frameBorderId(node.id),
          parentId: node.id,
          ...inner,
          kind: 'primitive',
          geometry: rectangle,
          style: { fill: null, stroke: node.stroke },
        };
  const snapshots: RenderNodeSnapshot[] = [
    {
      id: node.id,
      parentId,
      transform: localTransform(node.frame, node.rotation),
      visible: node.visible,
      opacity: node.opacity,
      kind: 'container',
      children: border === null ? [content] : [content, border.id],
      clip: null,
    },
    {
      id: content,
      parentId: node.id,
      ...inner,
      kind: 'container',
      children: background === null ? [...children] : [background.id, ...children],
      clip: { kind: 'rect', x: 0, y: 0, width, height },
    },
  ];
  if (background !== null) snapshots.push(background);
  if (border !== null) snapshots.push(border);
  return snapshots;
}

/** The projection of one page. */
export type PageProjection = Readonly<{
  /** Scene ID to snapshot, in document pre-order (a frame's own nodes before its children). */
  nodes: ReadonlyMap<string, RenderNodeSnapshot>;
  rootOrder: readonly string[];
  /** Projected document IDs in pre-order. */
  units: readonly string[];
  /** The scene IDs of each unit: the node, or a frame's two to four nodes. */
  unitIds: ReadonlyMap<string, readonly string[]>;
}>;

/** A node's last snapshots, reused while the node, its scene parent and its children hold. */
export type ProjectionMemo = Map<
  string,
  Readonly<{
    node: NodeV2;
    parentId: string | null;
    children: readonly string[] | null;
    snapshots: readonly RenderNodeSnapshot[];
  }>
>;

/**
 * Projects page `pageId` of `document`, leaving out the subtrees rooted at `omit` and a mask
 * group whose source is omitted. With `memo`, a node that did not change keeps the same
 * snapshot objects, so a changed snapshot is always a new object.
 */
export function projectPage(
  document: DocumentV2,
  pageId: string,
  custom: CustomProjection,
  omit: ReadonlySet<string> = new Set(),
  memo?: ProjectionMemo,
): PageProjection {
  const built = new Map<string, RenderNodeSnapshot>();
  const order: string[] = [];
  const units: string[] = [];
  const unitIds = new Map<string, readonly string[]>();

  const reused = (node: NodeV2, parentId: string | null, children: readonly string[] | null) => {
    const entry = memo?.get(node.id);
    if (entry === undefined || entry.node !== node || entry.parentId !== parentId) return null;
    if (entry.children === null || children === null) {
      return entry.children === children ? entry.snapshots : null;
    }
    return sameStrings(entry.children, children) ? entry.snapshots : null;
  };

  /** Projects `ids` under the scene parent `parentId`; returns the projected document IDs. */
  const walk = (ids: readonly string[], parentId: string | null): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      if (omit.has(id) || !Object.hasOwn(document.nodes, id)) continue;
      const node = document.nodes[id]!;
      const at = order.length;
      let children: string[] | null = null;
      let snapshots: readonly RenderNodeSnapshot[];
      if (node.type === 'group' || node.type === 'maskGroup' || node.type === 'frame') {
        if (node.type === 'maskGroup') {
          const source = node.children[0];
          if (source === undefined || omit.has(source)) continue;
        }
        units.push(id);
        children = walk(node.children, node.type === 'frame' ? frameContentId(id) : id);
        snapshots =
          reused(node, parentId, children) ??
          (node.type === 'frame'
            ? keepEqual(frameSnapshots(node, parentId, children), memo?.get(id)?.snapshots)
            : [
                {
                  id,
                  parentId,
                  transform: localTransform(node.frame, node.rotation),
                  visible: node.visible,
                  opacity: node.opacity,
                  kind: 'container',
                  children,
                  clip: node.type === 'maskGroup' ? { kind: 'mask' } : null,
                },
              ]);
      } else {
        const snapshot = reused(node, parentId, null)?.[0] ?? projectNode(node, custom, parentId);
        if (snapshot === null) continue;
        units.push(id);
        snapshots = [snapshot];
      }
      memo?.set(id, { node, parentId, children, snapshots });
      snapshots.forEach((snapshot) => built.set(snapshot.id, snapshot));
      // A container's own nodes go before its children, which the walk above already listed.
      order.splice(at, 0, ...snapshots.map((snapshot) => snapshot.id));
      unitIds.set(
        id,
        snapshots.map((snapshot) => snapshot.id),
      );
      out.push(id);
    }
    return out;
  };

  const page = document.pages.find((entry) => entry.id === pageId);
  const rootOrder = walk(page?.children ?? [], null);
  if (memo !== undefined) {
    for (const id of memo.keys()) if (!Object.hasOwn(document.nodes, id)) memo.delete(id);
  }
  const nodes = new Map<string, RenderNodeSnapshot>();
  for (const id of order) nodes.set(id, built.get(id)!);
  return { nodes, rootOrder, units, unitIds };
}

/**
 * Keeps the previous object of each synthetic frame node whose value did not change, so that a
 * frame change sends only the frame nodes it changes (leaves compare by identity).
 */
function keepEqual(
  snapshots: RenderNodeSnapshot[],
  previous: readonly RenderNodeSnapshot[] | undefined,
): RenderNodeSnapshot[] {
  if (previous === undefined) return snapshots;
  return snapshots.map((snapshot) => {
    const old = previous.find((entry) => entry.id === snapshot.id);
    return old !== undefined && JSON.stringify(old) === JSON.stringify(snapshot) ? old : snapshot;
  });
}

function sameClip(a: ContainerSnapshot['clip'], b: ContainerSnapshot['clip']): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === 'mask' || b.kind === 'mask') return a.kind === b.kind;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Whether the renderer holds `held` as `next`: leaves by identity, containers by value. */
function sameSnapshot(held: RenderNodeSnapshot, next: RenderNodeSnapshot): boolean {
  if (held === next) return true;
  if (held.kind !== 'container' || next.kind !== 'container') return false;
  return (
    held.id === next.id &&
    held.parentId === next.parentId &&
    held.visible === next.visible &&
    held.opacity === next.opacity &&
    held.transform.every((value, index) => value === next.transform[index]) &&
    sameStrings(held.children, next.children) &&
    sameClip(held.clip, next.clip)
  );
}

/** A container's children limited to the scene nodes `held` accepts; other nodes unchanged. */
function limited(snapshot: RenderNodeSnapshot, held: (id: string) => boolean): RenderNodeSnapshot {
  if (snapshot.kind !== 'container' || snapshot.children.every(held)) return snapshot;
  return { ...snapshot, children: snapshot.children.filter(held) };
}

type Changes = Pick<RenderChangeSet, 'inserted' | 'updated' | 'removed' | 'orders'>;
type Rejection = Extract<SceneApplyResult, { status: 'invalid-scene' }>;

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
  /** Roots of subtrees left out after a rejection, until a change touches the subtree. */
  private readonly excluded = new Set<string>();
  /** Snapshots of the last projection, reused for nodes that did not change. */
  private readonly memo: ProjectionMemo = new Map();
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
   * Sends the whole projection of `page` under the identity `{ documentId, pageId: page }`: on
   * attach, after a load, after a change of active page and after `resync-required`.
   */
  replace(document: DocumentV2, page: string, retried = false): void {
    if (this.disposed) return;
    this.page = page;
    // A renderer may already hold a scene from an earlier attach; start above its revision.
    this.raiseRevision(this.renderer.getSynchronizationState().current?.revision);
    const projection = this.project(document);
    const identity = { documentId: document.id, pageId: page };
    const result = this.renderer.replaceSnapshot({
      identity,
      revision: this.nextRevision(),
      nodes: [...projection.nodes.values()],
      rootOrder: projection.rootOrder,
    });
    if (this.accepted(result)) {
      this.identity = identity;
      this.sent = new Map(projection.nodes);
      this.sentOrder = projection.rootOrder;
      return;
    }
    this.identity = null;
    this.base = null;
    if (result.status !== 'invalid-scene') return;
    if (isBookkeeping(result)) {
      // Revision bookkeeping, not a node rejection: move above the renderer and send once more.
      this.raiseRevision(result.current?.revision);
      if (!retried) this.replace(document, page, true);
      return;
    }
    // A projection of one unit was rejected on its own (P5-U4); otherwise isolate.
    const only = projection.units.length === 1 ? projection.units[0]! : null;
    this.isolate(document, projection, only === null ? null : { id: only, result });
  }

  /** Sends one change set for a document change on `page` that touched `touched`. */
  change(document: DocumentV2, page: string, touched: readonly string[]): void {
    if (this.disposed) return;
    const retry = this.release(document, touched);
    if (this.identity === null || this.base === null || this.page !== page) {
      this.replace(document, page);
      return;
    }
    // Released subtrees are retried one unit per set after the main set.
    const result = this.sync(this.project(document, retry));
    if (result === null || this.accepted(result)) {
      this.retry(document, retry);
      return;
    }
    if (result.status !== 'invalid-scene') {
      this.resync(document);
      return;
    }
    const { inserted, updated, removed } = result.changes;
    const units = new Set([...inserted, ...updated].map((node) => documentIdOf(node.id)));
    if (units.size === 0) {
      // A rejected removal leaves nodes the document no longer has; a snapshot drops them.
      this.exclude(document, result, [...new Set(removed.map(documentIdOf))]);
      this.resync(document);
    } else if (units.size === 1 && removed.length === 0) {
      // One unit rejected on its own (P5-U4): leave it out and drop its stale copy.
      this.exclude(document, result, [...units]);
      const cleanup = this.sync(this.project(document, retry));
      if (cleanup !== null && !this.accepted(cleanup)) this.resync(document);
      else this.retry(document, retry);
    } else {
      this.isolate(document, this.project(document), null);
    }
  }

  /**
   * Isolation (section 5): an empty snapshot, then one set per unit in pre-order. `only` is a
   * rejection already known to be the projection's only unit's own.
   */
  private isolate(
    document: DocumentV2,
    projection: PageProjection,
    only: Readonly<{ id: string; result: Rejection }> | null,
  ): void {
    const identity = { documentId: document.id, pageId: this.page };
    let empty = this.sendEmpty(identity);
    if (empty.status === 'invalid-scene' && isBookkeeping(empty)) {
      this.raiseRevision(empty.current?.revision);
      empty = this.sendEmpty(identity);
    }
    if (!this.accepted(empty)) {
      if (empty.status !== 'disposed') this.resync(document);
      return;
    }
    this.identity = identity;
    this.sent = new Map();
    this.sentOrder = [];
    if (only !== null) this.exclude(document, only.result, [only.id]);
    else this.addUnits(document, projection, null);
  }

  /** Retries the released subtrees from their roots, one unit per set. */
  private retry(document: DocumentV2, roots: ReadonlySet<string>): void {
    if (roots.size > 0) this.addUnits(document, this.project(document), roots);
  }

  /**
   * Sends each unit of `projection` under `roots` (or every unit) in its own set, in pre-order.
   * A rejected unit is left out with its subtree; a rejected mask source takes its mask group
   * out. Rejections are reported once per reason; any other failure ends in a full snapshot.
   */
  private addUnits(
    document: DocumentV2,
    projection: PageProjection,
    roots: ReadonlySet<string> | null,
  ): void {
    const rejected = new Map<SceneRejectionReason, string[]>();
    const inScope = new Set<string>();
    const dead = new Set<string>();
    let failed = false;
    for (const id of projection.units) {
      const node = document.nodes[id]!;
      if (roots !== null && !roots.has(id) && !inScope.has(node.parent)) continue;
      inScope.add(id);
      if (dead.has(node.parent)) {
        dead.add(id);
        continue;
      }
      const result = this.addUnit(projection, id);
      if (result === null) {
        if (this.disposed) return;
        dead.add(id);
        continue;
      }
      if (this.accepted(result)) continue;
      if (result.status !== 'invalid-scene') {
        failed = true;
        break;
      }
      rejected.set(result.reason, [...(rejected.get(result.reason) ?? []), id]);
      dead.add(id);
      const root = this.excludedRoot(document, id);
      this.excluded.add(root);
      if (root !== id) {
        // A mask group whose source is rejected is removed with its subtree.
        dead.add(root);
        const removal = this.removeUnit(root);
        if (removal !== null && !this.accepted(removal)) {
          failed = true;
          break;
        }
      }
    }
    for (const [reason, ids] of rejected) this.reportRejection(reason, ids);
    if (failed) this.resync(document);
  }

  /**
   * Inserts one unit: the node (a frame with its synthetic nodes), with its containers'
   * children limited to nodes held or inserted here, and an order entry for its scene parent.
   * Returns null when its scene parent is not held, or after `disposed`.
   */
  private addUnit(projection: PageProjection, id: string): SceneApplyResult | null {
    const ids = projection.unitIds.get(id)!;
    const own = new Set(ids);
    const held = (scene: string) => this.sent.has(scene) || own.has(scene);
    const snapshots = ids.map((scene) => limited(projection.nodes.get(scene)!, held));
    const parentId = snapshots[0]!.parentId;
    let children: readonly string[];
    if (parentId === null) {
      children = projection.rootOrder.filter(held);
    } else {
      const parent = projection.nodes.get(parentId);
      if (parent?.kind !== 'container' || !this.sent.has(parentId)) return null;
      children = parent.children.filter(held);
    }
    const result = this.apply({
      inserted: snapshots.filter((snapshot) => !this.sent.has(snapshot.id)),
      updated: snapshots.filter((snapshot) => this.sent.has(snapshot.id)),
      removed: [],
      orders: [{ parentId, children }],
    });
    if (result !== null && this.accepted(result)) {
      snapshots.forEach((snapshot) => this.sent.set(snapshot.id, snapshot));
      this.setHeldChildren(parentId, children);
    }
    return result;
  }

  /** Removes a held unit with every held scene node below it, in one set. */
  private removeUnit(id: string): SceneApplyResult | null {
    const top = this.sent.get(id);
    if (top === undefined) return null;
    const removed: string[] = [];
    const pending = [id];
    while (pending.length > 0) {
      const scene = pending.pop()!;
      const node = this.sent.get(scene);
      if (node === undefined) continue;
      removed.push(scene);
      if (node.kind === 'container') pending.push(...node.children);
    }
    const parentId = top.parentId;
    const parent = parentId === null ? null : this.sent.get(parentId);
    const siblings =
      parentId === null ? this.sentOrder : parent?.kind === 'container' ? parent.children : [];
    const children = siblings.filter((scene) => scene !== id);
    const result = this.apply({
      inserted: [],
      updated: [],
      removed,
      orders: [{ parentId, children }],
    });
    if (result !== null && this.accepted(result)) {
      removed.forEach((scene) => this.sent.delete(scene));
      this.setHeldChildren(parentId, children);
    }
    return result;
  }

  /** Records the held children of a scene parent after an accepted order entry. */
  private setHeldChildren(parentId: string | null, children: readonly string[]): void {
    if (parentId === null) {
      this.sentOrder = children;
      return;
    }
    const parent = this.sent.get(parentId);
    if (parent?.kind === 'container') this.sent.set(parentId, { ...parent, children });
  }

  /** The root to leave out for a rejected node: its mask group when it is a mask source. */
  private excludedRoot(document: DocumentV2, id: string): string {
    const node = Object.hasOwn(document.nodes, id) ? document.nodes[id]! : undefined;
    const parent =
      node !== undefined && Object.hasOwn(document.nodes, node.parent)
        ? document.nodes[node.parent]
        : undefined;
    return parent?.type === 'maskGroup' && parent.children[0] === id ? parent.id : id;
  }

  /** The document parent chain of `id`, itself first (bounded by the tree depth). */
  private chain(document: DocumentV2, id: string): string[] {
    const ids: string[] = [];
    let cursor: string | undefined = id;
    for (let guard = 0; cursor !== undefined && guard < PARENT_WALK_LIMIT; guard += 1) {
      ids.push(cursor);
      cursor = Object.hasOwn(document.nodes, cursor) ? document.nodes[cursor]!.parent : undefined;
    }
    return ids;
  }

  /**
   * Releases the excluded subtrees that `touched` reaches (a touched node in one, or its root)
   * with every excluded root inside them, and returns the outermost roots the document still
   * has; those are retried whole.
   */
  private release(document: DocumentV2, touched: readonly string[]): Set<string> {
    const roots = new Set<string>();
    if (this.excluded.size === 0) return roots;
    for (const id of touched) {
      const top = this.chain(document, id)
        .reverse()
        .find((entry) => this.excluded.has(entry));
      if (top !== undefined) roots.add(top);
    }
    for (const id of [...this.excluded]) {
      if (this.chain(document, id).some((entry) => roots.has(entry))) this.excluded.delete(id);
    }
    for (const root of [...roots]) if (!Object.hasOwn(document.nodes, root)) roots.delete(root);
    return roots;
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
   * Sends the difference between what the renderer holds and `projection`: inserts, updates,
   * removals and a root order entry when the paint order changes; a container's new children
   * travel in its own update, so no container order entry is needed. Returns null when there is
   * nothing to send or after `disposed`; state is updated only on success.
   */
  private sync(projection: PageProjection): (SceneApplyResult & { changes: Changes }) | null {
    const inserted: RenderNodeSnapshot[] = [];
    const updated: RenderNodeSnapshot[] = [];
    for (const [id, snapshot] of projection.nodes) {
      const held = this.sent.get(id);
      if (held === undefined) inserted.push(snapshot);
      else if (!sameSnapshot(held, snapshot)) updated.push(snapshot);
    }
    const removed = [...this.sent.keys()].filter((id) => !projection.nodes.has(id));
    const reordered = !sameStrings(projection.rootOrder, this.sentOrder);
    if (inserted.length === 0 && updated.length === 0 && removed.length === 0 && !reordered) {
      return null;
    }
    const changes: Changes = {
      inserted,
      updated,
      removed,
      orders: reordered ? [{ parentId: null, children: projection.rootOrder }] : [],
    };
    const result = this.apply(changes);
    if (result === null) return null;
    if (this.accepted(result)) {
      this.sent = new Map(projection.nodes);
      this.sentOrder = projection.rootOrder;
    }
    return { ...result, changes };
  }

  /** Sends one change set on the current base; null when not synchronized or after `disposed`. */
  private apply(changes: Changes): SceneApplyResult | null {
    if (this.disposed || this.identity === null || this.base === null) return null;
    const result = this.renderer.applyChanges({
      identity: this.identity,
      revision: this.nextRevision(),
      baseRevision: this.base,
      ...changes,
    });
    if (result.status === 'disposed') {
      this.disposed = true;
      return null;
    }
    return result;
  }

  private sendEmpty(identity: SceneIdentity): SceneApplyResult {
    return this.renderer.replaceSnapshot({
      identity,
      revision: this.nextRevision(),
      nodes: [],
      rootOrder: [],
    });
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

  /** Reports a rejection of `ids` and leaves their subtrees out until a change touches them. */
  private exclude(document: DocumentV2, result: Rejection, ids: readonly string[]): void {
    this.reportRejection(result.reason, ids);
    ids.forEach((id) => this.excluded.add(this.excludedRoot(document, id)));
  }

  private reportRejection(reason: SceneRejectionReason, ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.report({
      type: 'diagnostic',
      code:
        reason === 'unsupported-feature' ? 'editor.renderer-unsupported' : 'editor.scene-rejected',
      reason,
      nodeIds: [...ids].sort(),
    });
  }

  /** The projection of the active page minus the exclusions and `skip`. */
  private project(document: DocumentV2, skip: ReadonlySet<string> = new Set()): PageProjection {
    const omit = skip.size === 0 ? this.excluded : new Set([...this.excluded, ...skip]);
    return projectPage(document, this.page, this.custom, omit, this.memo);
  }

  private raiseRevision(revision: number | undefined): void {
    if (revision !== undefined) this.sceneRevision = Math.max(this.sceneRevision, revision);
  }

  private nextRevision(): number {
    this.sceneRevision = Math.max(this.sceneRevision, this.base ?? 0) + 1;
    return this.sceneRevision;
  }
}

function isBookkeeping(result: Rejection): boolean {
  return result.reason === 'stale-snapshot' || result.reason === 'revision-conflict';
}
