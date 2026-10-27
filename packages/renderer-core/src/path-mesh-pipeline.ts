import { meetsClipChain, type ClipChain } from './clip-resolution.js';
import {
  DIAGNOSTIC_CODES,
  PATH_VERB_CODES,
  type DiagnosticInput,
  type FillMesh,
  type FillMeshPort,
  type FillMeshRequest,
  type PathStroke,
  type RenderNodeSnapshot,
  type SceneAffine,
  type SceneColor,
  type SceneFillRule,
  type SceneStrokeCap,
  type SceneStrokeJoin,
  type StrokeMeshFailureCode,
  type StrokeMeshPort,
  type StrokeMeshRequest,
} from '@vector-studio/contracts';
import {
  E_MAX,
  E_MIN,
  F_MAX,
  F_MIN,
  STROKE_E_MIN,
  computePathBuckets,
  type PathBuckets,
  type PathLinearMap,
} from './path-buckets.js';
import {
  pathFringeBytes,
  type PathFringe,
  type PathFringeBuilder,
  type PathFringeBuildResult,
} from './path-fringe.js';
import {
  JOINT_OVERLAY_LIMITS,
  buildJointOverlay,
  type JointOverlay,
} from './path-joint-overlay.js';
import {
  getPathLocalPointBounds,
  getPathLocalStrokeBounds,
  transformSceneBounds,
  type SceneBounds,
} from './scene-numeric.js';

// CPU path-mesh pipeline of the P3 V3 contract: port consumption, batch isolation, exact
// buckets, the mesh cache, the failure memo and the failure notice queue (unit V3a), plus the
// geometry-owned K4 offsets and the transform-owned instance lanes of section f (unit V3b), and
// the fringe variants of section e (unit V3c). The packet mesh part itself is assembled by
// path-mesh-packet.ts; the exact fringe builder lives in path-fringe.ts.
//
// B2 stroke contract, section 9 (unit ST-U6): a second, optional StrokeMeshPort beside the fill
// port. Both paints share one mesh cache and one failure memo with paint-tagged keys; each port
// has its own batch, isolation stack, call bound and `disposed` latch. A drawn stroked path
// emits its fill draw (if drawable) and then its stroke draw; if either drawable paint fails,
// the whole path is not drawn (V1-Q4 extended to strokes, ST-A0 S5).
//
// ST-U7 addendum (docs/plans/p3-b2-st-u7-joint-coverage-addendum.md), unit ST-U7c: a path with
// both paints drawable at 0 < opacity < 1 is drawn by a joint-coverage fill draw over a
// renderer-derived overlay (path-joint-overlay.ts), then the unchanged stroke draw, so opacity
// applies once. The overlay is built on first need and cached on the fill entry, at most two per
// node; a failed build is the state `overlay-unsupported` (paint null), which hides
// the path and keeps both cached meshes. Functional evidence only: precision is UNVERIFIED.

export type { PathFringe, PathFringeBuilder, PathFringeBuildResult };

type PathNode = Extract<RenderNodeSnapshot, { kind: 'path' }>;

/** The paint a cache entry, memo entry, draw or notice belongs to (B2 section 9.3). */
export type PathPaint = 'fill' | 'stroke';

export type DerivedPath = Readonly<{
  id: string;
  node: PathNode;
  world: SceneAffine;
  hidden: boolean;
  /** P4 contract, U2: the clipping ancestors; a paint is drawable only if it meets their bound. */
  clip?: ClipChain;
}>;

export type PathMeshFailureScope = 'path' | 'batch' | 'renderer';
export type PathMeshBatchFailureCode =
  'internal-error' | 'resource-limit' | 'invalid-request' | 'disposed';
export type PathMeshRendererFailureCode =
  | 'tolerance-range'
  | 'fringe-range'
  | 'port-version'
  | 'invalid-response'
  | 'invalid-mesh'
  | 'fringe-unsupported'
  | 'fringe-work-cap'
  | 'packing-range'
  | 'mesh-pipeline-unavailable'
  | 'overlay-unsupported';
export type PathMeshFailureCode =
  StrokeMeshFailureCode | PathMeshBatchFailureCode | PathMeshRendererFailureCode;

/** One path mesh failure notice (P3 V3 contract, section h; B2 stroke contract, section 9.8;
 *  E11-U4 addendum). */
export type PathMeshNotice = Readonly<{
  nodeId: string | null;
  failureScope: PathMeshFailureScope;
  failureCode: PathMeshFailureCode;
  toleranceExponent: number | null;
  /**
   * The paint of a path or batch failure or of a one-paint state failure; null for
   * `overlay-unsupported`, `port-version` (of either port) and `mesh-pipeline-unavailable`.
   */
  paint: PathPaint | null;
}>;

/** A paint served from the mesh cache in this frame, in paint order. */
export type PathMeshDraw = Readonly<{
  nodeId: string;
  /**
   * The served paint; absent means 'fill'. A stroked path's stroke draw follows its fill draw
   * with the same paint position (B2 section 9.5).
   */
  paint?: PathPaint;
  /** The path slot of this paint: the node's fill slot, or its second slot for the stroke. */
  slot: number;
  /** The served entry's e', not the requested e (section c reuse rule). */
  toleranceExponent: number;
  /** The served fringe variant's f', or null when no fringe builder is installed. */
  fringeBucket: number | null;
  /**
   * The served fringe variant (section e), or null for a region-only draw. Only tests install
   * no builder; the region-only seam is also V4's MSAA baseline of section k.
   */
  fringe: Readonly<{ id: symbol; data: PathFringe }> | null;
  orientation: 1 | -1;
  mesh: FillMesh;
  /** Identity of the served cache entry; its GPU ranges live while it is resident. */
  entryId: symbol;
  /** Geometry-owned K4 offsets u = fround(v - m), two per port vertex (section f). */
  offsets: Float32Array;
  /** Transform-owned f32 lanes a, b, c, d of the world linear map. */
  linear: readonly [number, number, number, number];
  /** Transform-owned anchor B = fround(W(m) - O_m). */
  anchor: readonly [number, number];
  opacity: number;
  /** The straight color lanes: the fill color, or the stroke color for a stroke draw. */
  fill: SceneColor;
  /**
   * ST-U7 addendum, section 4.5: present only on a joint fill draw, the fill draw of a path with
   * both paints drawn at 0 < opacity < 1. Its stroke draw follows unchanged.
   */
  composite?: 'joint-fill';
  /** The served overlay variant of a joint fill draw (addendum section 4.2); absent otherwise. */
  overlay?: Readonly<{ id: symbol; data: JointOverlay }>;
}>;

export type PathMeshStatistics = Readonly<{
  entries: number;
  bytes: number;
  peakBytes: number;
  evictions: number;
  overBudgetFrames: number;
  memoEntries: number;
  memoOverCapFrames: number;
  noticesQueued: number;
  noticesDropped: number;
  /** Calls to the fill port. */
  portCalls: number;
  bucketComputations: number;
  /** Calls to the stroke port; present exactly when a stroke port is given. */
  strokePortCalls?: number;
  portLinearMemoryBytes?: number;
  strokePortLinearMemoryBytes?: number;
  pathMeshMemoryBytes?: number;
}>;

export type PathMeshLimits = Readonly<{
  byteBudget: number;
  memoCapacity: number;
  noticeQueueCapacity: number;
  noticesPerPacket: number;
  callsPerPrepare: number;
  requestsPerCall: number;
  resourceLimitExpiryPrepares: number;
  toleranceVariantsPerNode: number;
  fringeVariantsPerEntry: number;
  /**
   * V4 builder work cap (outcome O2 while the TypeScript fringe builder ships): a mesh with more
   * distinct boundary vertices than this is drawn region-only, without calling the fringe
   * builder, and notifies `fringe-work-cap` once.
   */
  fringeBoundaryVertexCap: number;
  /** ST-U7 addendum, section 4.6: at most this many overlay variants (or marks) per node. */
  overlayVariantsPerNode: number;
  /** ST7-Q5 (a), current-cap estimates: the overlay work cap per build (section 4.6). */
  overlayExactTests: number;
  overlaySteinerPoints: number;
}>;

/** The contract's numbers (sections b, d and h). Tests may lower them; production never does. */
export const PATH_MESH_LIMITS: PathMeshLimits = Object.freeze({
  byteBudget: 67_108_864,
  memoCapacity: 4_096,
  noticeQueueCapacity: 4_096,
  noticesPerPacket: 32,
  callsPerPrepare: 32,
  requestsPerCall: 2 ** 31,
  resourceLimitExpiryPrepares: 256,
  toleranceVariantsPerNode: 3,
  fringeVariantsPerEntry: 2,
  fringeBoundaryVertexCap: 128,
  overlayVariantsPerNode: 2,
  overlayExactTests: JOINT_OVERLAY_LIMITS.exactTests,
  overlaySteinerPoints: JOINT_OVERLAY_LIMITS.steinerPoints,
});

/** @internal Tests only: the seeded defect ST7-D8 of the ST-U7 addendum, section 5.6. */
export type PathMeshSeededDefect = 'ST7-D8';

export type PathMeshPipelineOptions = Readonly<{
  /** The fill-mesh port (V3). */
  port?: FillMeshPort;
  /** Host hook for the fill port's linear memory. */
  memoryBytes?: () => number;
  /** The stroke-mesh port (B2 stroke contract, section 9.1). */
  strokePort?: StrokeMeshPort;
  /** Host hook for the stroke port's linear memory. */
  strokeMemoryBytes?: () => number;
  limits?: Partial<PathMeshLimits>;
  fringeBuilder?: PathFringeBuilder;
  /** @internal Tests only: a seeded defect of the ST-U7 addendum, section 5.6. */
  seededDefect?: PathMeshSeededDefect;
}>;

export type PathMeshPrepareInput = Readonly<{
  paths: readonly DerivedPath[];
  geometryRevision: (id: string) => number | undefined;
  camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>;
  target: Readonly<{ width: number; height: number; devicePixelRatio: number }>;
  /**
   * Section f packing inputs: the per-view mesh origin O_m and whether the shared meshFrame
   * lanes are finite. A nonfinite meshFrame makes every drawable path packing-range.
   */
  packing: Readonly<{ origin: Readonly<{ x: number; y: number }>; frameFinite: boolean }>;
}>;

/**
 * The paint-specific key fields (B2 section 9.3). The fill key is V3's with the tag 'fill'; the
 * stroke key adds every mesh-affecting stroke value. Fields are compared with `===`.
 */
type PaintKey =
  | Readonly<{ paint: 'fill'; fillRule: SceneFillRule }>
  | Readonly<{
      paint: 'stroke';
      width: number;
      cap: SceneStrokeCap;
      join: SceneStrokeJoin;
      miterLimit: number;
    }>;

type FringeVariant = Readonly<{ id: symbol; f: number; fringe: PathFringe; bytes: number }>;
/**
 * ST-U7 addendum, section 4.6: one overlay variant of a fill entry, or its failure mark. It
 * belongs to one pair of served variants: this fill entry's fringe variant (null: region-only)
 * and the stroke entry with its fringe variant (null: region-only).
 */
type OverlayVariant = {
  readonly fillVariant: symbol | null;
  readonly strokeEntry: symbol;
  readonly strokeVariant: symbol | null;
  readonly built: Readonly<{ id: symbol; overlay: JointOverlay; bytes: number }> | null;
  lastServed: number;
};
type MeshEntry = {
  readonly id: symbol;
  readonly e: number;
  readonly mesh: FillMesh | null;
  /** Packed K4 offsets of the port vertices; null when one is not a finite binary32 value. */
  readonly offsets: Float32Array | null;
  readonly midpoint: Readonly<{ x: number; y: number }>;
  readonly meshBytes: number;
  /** Distinct vertex indices in the port's boundaryEdges (the V4 builder work measure). */
  readonly boundaryVertices: number;
  readonly variants: Map<number, FringeVariant | 'unsupported'>;
  /** Overlay variants and marks; only fill entries hold them (ST-U7 addendum, section 4.6). */
  overlays: OverlayVariant[];
  /** Set once the entry's `fringe-work-cap` notice is queued. */
  capNotified: boolean;
  lastServed: number;
};
type NodeCache = {
  readonly revision: number;
  readonly key: PaintKey;
  readonly operationId: string;
  readonly entries: Map<number, MeshEntry>;
};
type MemoEntry = {
  readonly nodeId: string;
  readonly revision: number;
  readonly key: PaintKey;
  readonly operationId: string;
  readonly scope: PathMeshFailureScope;
  readonly code: PathMeshFailureCode;
  readonly expiresAt: number | null;
  lastConsulted: number;
};
type PendingRequest = Readonly<{
  nodeId: string;
  revision: number;
  key: PaintKey;
  e: number;
  operationId: string;
  node: PathNode;
}>;
type Evaluated = Readonly<{
  path: DerivedPath;
  paint: PathPaint;
  e: number;
  f: number;
  orientation: 1 | -1;
  color: SceneColor;
}>;
type EvaluatedPath = Readonly<{ path: DerivedPath; items: readonly Evaluated[] }>;
type BucketCacheEntry = Readonly<{
  lanes: PathLinearMap;
  zoom: number;
  devicePixelRatio: number;
  buckets: PathBuckets;
}>;
type BoundsCacheEntry = Readonly<{
  revision: number;
  world: SceneAffine;
  stroke: PathStroke | null;
  worldBounds: SceneBounds | null;
}>;
type PortReading = Readonly<{ ok: true; operationId: string }> | Readonly<{ ok: false }>;
type Verdict =
  | Readonly<{ kind: 'ok'; mesh: FillMesh; bytes: number }>
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'failed'; code: StrokeMeshFailureCode }>
  | Readonly<{ kind: 'invalid-response' | 'invalid-mesh' }>;
type CallOutcome =
  | 'settled'
  | 'invalid-response'
  | 'internal-error'
  | 'resource-limit'
  | 'invalid-request'
  | 'disposed';
type StateFailure = Readonly<{
  nodeId: string;
  paint: PathPaint | null;
  code: PathMeshRendererFailureCode;
}>;

/** One port and its own batch state (V3 section b, applied per port by B2 section 9.4). */
type PortChannel = {
  readonly paint: PathPaint;
  readonly port: Readonly<{ portVersion: unknown; operationId: unknown }>;
  readonly build: (requests: readonly PendingRequest[]) => unknown;
  readonly failureCodes: ReadonlySet<string>;
  readonly memoryBytes: (() => number) | undefined;
  readonly eMin: number;
  stack: PendingRequest[][];
  latchedDisposed: boolean;
  calls: number;
  linearMemoryBytes: number | null;
};

const FILL_FAILURE_CODES: ReadonlySet<string> = new Set([
  'invalid-path',
  'invalid-tolerance',
  'numeric-range',
  'work-limit',
  'unsupported-geometry',
]);
const STROKE_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...FILL_FAILURE_CODES,
  'invalid-stroke',
]);
const BATCH_CODES: ReadonlySet<string> = new Set([
  'invalid-request',
  'disposed',
  'resource-limit',
  'internal-error',
]);
const PAINTS: readonly PathPaint[] = ['fill', 'stroke'];

export class PathMeshPipeline {
  readonly #channels: Readonly<Record<PathPaint, PortChannel | undefined>>;
  readonly #limits: PathMeshLimits;
  readonly #fringeBuilder: PathFringeBuilder | undefined;
  readonly #seededDefect: PathMeshSeededDefect | undefined;
  #overlayBuilds = 0;
  #prepareCount = 0;
  #disposed = false;
  #cache: Record<PathPaint, Map<string, NodeCache>> = { fill: new Map(), stroke: new Map() };
  #memo = new Map<string, MemoEntry>();
  #buckets = new Map<string, BucketCacheEntry>();
  #bounds: Record<PathPaint, Map<string, BoundsCacheEntry>> = {
    fill: new Map(),
    stroke: new Map(),
  };
  #states = new Map<string, StateFailure>();
  #currentE: Record<PathPaint, Map<string, number>> = { fill: new Map(), stroke: new Map() };
  #slots = new Map<string, number>();
  #strokeSlots = new Map<string, number>();
  #slotIds: Array<string | undefined> = [];
  #notices: PathMeshNotice[] = [];
  #noticesDropped = 0;
  #peakBytes = 0;
  #evictions = 0;
  #overBudgetFrames = 0;
  #memoOverCapFrames = 0;
  #bucketComputations = 0;

  public constructor(options: PathMeshPipelineOptions) {
    const fill = options.port;
    const stroke = options.strokePort;
    if (fill === undefined && stroke === undefined) {
      throw new TypeError('PathMeshPipeline needs a fill-mesh port, a stroke-mesh port or both.');
    }
    this.#channels = Object.freeze({
      fill:
        fill === undefined
          ? undefined
          : createChannel('fill', fill, E_MIN, FILL_FAILURE_CODES, options.memoryBytes, (range) =>
              fill.buildFillMeshes(Object.freeze(range.map(fillRequest))),
            ),
      stroke:
        stroke === undefined
          ? undefined
          : createChannel(
              'stroke',
              stroke,
              STROKE_E_MIN,
              STROKE_FAILURE_CODES,
              options.strokeMemoryBytes,
              (range) => stroke.buildStrokeMeshes(Object.freeze(range.map(strokeRequest))),
            ),
    });
    this.#limits = Object.freeze({ ...PATH_MESH_LIMITS, ...options.limits });
    this.#fringeBuilder = options.fringeBuilder;
    this.#seededDefect = options.seededDefect;
  }

  /** Steps 1-9 of section b, without packing. Returns the paints served in paint order. */
  public prepare(input: PathMeshPrepareInput): readonly PathMeshDraw[] {
    if (this.#disposed) return [];
    this.#prepareCount += 1;
    const now = this.#prepareCount;
    // B2 section 9.3: portVersion and operationId are read from each port at every prepare.
    const readings: Record<PathPaint, PortReading | undefined> = {
      fill: undefined,
      stroke: undefined,
    };
    for (const paint of PAINTS) {
      const channel = this.#channels[paint];
      if (channel === undefined) continue;
      readings[paint] = readPort(channel);
      channel.linearMemoryBytes = readMemoryBytes(channel.memoryBytes);
    }

    // Step 1: reconcile slots, caches and memo against the published path nodes.
    const revisions = new Map<string, number>();
    for (const path of input.paths) {
      revisions.set(path.id, input.geometryRevision(path.id) ?? 0);
    }
    this.#reconcile(input.paths, revisions, readings);

    // Steps 2-4: drawability, buckets, state checks, mesh lookup, then the memo.
    const { zoom } = input.camera;
    const { devicePixelRatio } = input.target;
    const viewport = viewportBounds(input.camera, input.target);
    // P4-K5: the primitive cull's guard, 2 physical px in world units.
    const clipGuard = 2 / (zoom * devicePixelRatio);
    const evaluated: EvaluatedPath[] = [];
    const missing: Record<PathPaint, PendingRequest[]> = { fill: [], stroke: [] };
    const frameStates = new Map<string, StateFailure | null>();
    for (const path of input.paths) {
      const node = path.node;
      if (path.hidden || node.geometry.verbs.length === 0) continue;
      const revision = revisions.get(path.id)!;
      // B2 section 9.2: the fill is V3's drawable paint; the stroke is drawable with a stroke,
      // width > 0 and stroke world bounds meeting the viewport. A path is culled only when
      // neither paint's bounds meet it.
      const drawable = PAINTS.filter((paint) => {
        if (this.#channels[paint] === undefined || paintKeyOf(node, paint) === null) return false;
        const worldBounds = this.#worldBounds(path, revision, paint);
        return (
          worldBounds !== null &&
          meetsViewport(worldBounds, viewport) &&
          meetsClipChain(worldBounds, path.clip ?? null, clipGuard)
        );
      });
      if (drawable.length === 0) continue;
      const buckets = this.#bucketsFor(path, zoom, devicePixelRatio);
      if (buckets.singular) continue;

      // The node-level state, one key per node: port-version of either drawable paint's port.
      // It notifies once per (node, code) transition. ST-U7 removed the interim composition state:
      // both paints at 0 < opacity < 1 now draw through the joint fill draw (step 8).
      const nodeCode: PathMeshRendererFailureCode | null = drawable.some(
        (paint) => !readings[paint]!.ok,
      )
        ? 'port-version'
        : null;
      frameStates.set(
        stateKey(path.id, null),
        nodeCode === null ? null : Object.freeze({ nodeId: path.id, paint: null, code: nodeCode }),
      );
      if (nodeCode !== null) continue;

      // Every drawable paint's state and memo are evaluated first. A path with a paint known to
      // fail in this prepare requests nothing, so an undrawable path never calls a port every
      // frame; the other paint's cached mesh stays (B2 section 9.6, review B1).
      const items: Evaluated[] = [];
      const requests: PendingRequest[] = [];
      let failed = false;
      for (const paint of drawable) {
        const channel = this.#channels[paint]!;
        const port = readings[paint] as Extract<PortReading, { ok: true }>;
        // One state code per node, paint and prepare, in a fixed order: the exact bucket ranges
        // of section c, then the f32 orientation check of the packed lanes.
        const code: PathMeshRendererFailureCode | null =
          buckets.e < channel.eMin
            ? 'tolerance-range'
            : buckets.f < F_MIN || buckets.f > F_MAX
              ? 'fringe-range'
              : buckets.f32OrientationMismatch
                ? 'packing-range'
                : null;
        frameStates.set(
          stateKey(path.id, paint),
          code === null ? null : Object.freeze({ nodeId: path.id, paint, code }),
        );
        if (code !== null) {
          failed = true;
          continue;
        }

        const e = Math.min(buckets.e, E_MAX);
        const key = paintKeyOf(node, paint)!;
        this.#currentE[paint].set(path.id, e);
        items.push(
          Object.freeze({
            path,
            paint,
            e,
            f: buckets.f,
            orientation: buckets.orientation,
            color: paint === 'fill' ? node.style.fill! : node.style.stroke!.color,
          }),
        );
        if (this.#lookup(paint, path.id, e) !== undefined) continue;
        if (this.#consultMemo(path.id, revision, key, e, port.operationId, now)) {
          failed = true;
          continue;
        }
        requests.push(
          Object.freeze({ nodeId: path.id, revision, key, e, operationId: port.operationId, node }),
        );
      }
      if (failed) continue;
      for (const request of requests) missing[request.key.paint].push(request);
      evaluated.push(Object.freeze({ path, items: Object.freeze(items) }));
    }

    // Steps 5-7: one batch per port (fill first, then stroke), isolation of a failed batch,
    // response validation and publication.
    for (const paint of PAINTS) {
      const channel = this.#channels[paint];
      if (channel !== undefined && readings[paint]!.ok) {
        this.#resolveMissing(channel, missing[paint], now);
      }
    }

    // Step 8: serve meshes and fringe variants in paint order, then pack the section f lanes.
    const draws: PathMeshDraw[] = [];
    const working = new Set<MeshEntry>();
    const { origin, frameFinite } = input.packing;
    for (const { path, items } of evaluated) {
      const entries = items.map((item) => this.#lookup(item.paint, path.id, item.e));
      // A paint that is still missing or memoized as failed hides the whole path this frame.
      if (entries.some((entry) => entry === undefined)) {
        // Review follow-up (ST-U6 pending-paint churn): a published sibling stays in this
        // frame's working set, without a lastServed stamp, so budget eviction cannot drop it
        // before the path can draw. Single-paint paths have no published sibling to keep.
        for (const entry of entries) if (entry !== undefined) working.add(entry);
        continue;
      }
      const pathDraws: PathMeshDraw[] = [];
      let failed = false;
      items.forEach((item, index) => {
        const entry = entries[index]!;
        entry.lastServed = now;
        working.add(entry);
        if (entry.mesh === null) return;
        const drawn = this.#servePaint(item, entry, origin, frameFinite, frameStates);
        if (drawn === null) failed = true;
        else pathDraws.push(drawn);
      });
      if (failed) continue;
      // ST-U7 addendum, section 4.1: the joint condition. Both paints are drawn (neither failed
      // nor empty) and 0 < o < 1. The joint fill draw takes the fill draw's place, before the
      // unchanged stroke draw; at o = 0, o = 1 and for one paint the draws are ST-U6's.
      const opacity = path.node.opacity;
      if (pathDraws.length === 2 && opacity > 0 && opacity < 1) {
        const fillEntry = entries[0]!;
        const overlay = this.#serveOverlay(path.id, fillEntry, entries[1]!, pathDraws, now);
        if (overlay === null) continue;
        const joint: PathMeshDraw = Object.freeze({
          ...pathDraws[0]!,
          composite: 'joint-fill' as const,
          overlay,
        });
        draws.push(
          ...(this.#seededDefect === 'ST7-D8' ? [pathDraws[1]!, joint] : [joint, pathDraws[1]!]),
        );
        continue;
      }
      draws.push(...pathDraws);
    }

    // State-failure notices on (node, paint, code) transitions only.
    for (const [key, state] of frameStates) {
      const previous = this.#states.get(key) ?? null;
      if (state?.code === previous?.code) continue;
      if (state === null) {
        this.#states.delete(key);
      } else {
        this.#states.set(key, state);
        this.#enqueue(state.nodeId, 'renderer', state.code, null, statePaintTag(state));
      }
    }

    // Step 9: bounded eviction. Overlay variants whose parent variant is gone are unreachable
    // and dropped first (ST-U7 addendum, section 4.6); evicting a fill entry drops its overlays.
    this.#sweepOverlays();
    this.#peakBytes = Math.max(this.#peakBytes, this.#totalBytes());
    this.#trimToleranceVariants(working);
    this.#evictToBudget(working);
    this.#sweepOverlays();
    this.#evictMemo(now);
    return Object.freeze(draws);
  }

  /** Occupied fill path slots by node id, including hidden and culled path nodes. */
  public getPathSlots(): ReadonlyMap<string, number> {
    return this.#slots;
  }

  /**
   * Occupied stroke slots by node id (B2 section 9.5): the second slot of each path node whose
   * stroke has width > 0, from the same allocator as the fill slots.
   */
  public getStrokeSlots(): ReadonlyMap<string, number> {
    return this.#strokeSlots;
  }

  /** Identities of every resident cache entry and of each entry's built fringe variants. */
  public getResidentIds(): ReadonlySet<symbol> {
    const ids = new Set<symbol>();
    for (const paint of PAINTS) {
      for (const nodeCache of this.#cache[paint].values()) {
        for (const entry of nodeCache.entries.values()) {
          ids.add(entry.id);
          for (const variant of entry.variants.values()) {
            if (variant !== 'unsupported') ids.add(variant.id);
          }
          for (const overlay of entry.overlays) {
            if (overlay.built !== null) ids.add(overlay.built.id);
          }
        }
      }
    }
    return ids;
  }

  /**
   * @internal Tests only (ST-U7 addendum, ST-A15): the number of overlay builds so far. It is
   * not a field of the exported PathMeshStatistics.
   */
  public getOverlayBuildCount(): number {
    return this.#overlayBuilds;
  }

  /**
   * @internal Tests only (E10 contract, section 3.1): false when the pipeline was built
   * without a fringe builder; it classifies the draw record's region-only draws.
   */
  public get hasFringeBuilder(): boolean {
    return this.#fringeBuilder !== undefined;
  }

  /** At most `noticesPerPacket` queued notices, oldest first; the rest stay queued. */
  public takePacketNotices(): readonly PathMeshNotice[] {
    return Object.freeze(this.#notices.splice(0, this.#limits.noticesPerPacket));
  }

  public getStatistics(): PathMeshStatistics {
    const bytes = this.#totalBytes();
    let entries = 0;
    for (const paint of PAINTS) {
      for (const nodeCache of this.#cache[paint].values()) entries += nodeCache.entries.size;
    }
    const fill = this.#channels.fill;
    const stroke = this.#channels.stroke;
    const statistics: Record<string, number> = {
      entries,
      bytes,
      peakBytes: this.#peakBytes,
      evictions: this.#evictions,
      overBudgetFrames: this.#overBudgetFrames,
      memoEntries: this.#memo.size,
      memoOverCapFrames: this.#memoOverCapFrames,
      noticesQueued: this.#notices.length,
      noticesDropped: this.#noticesDropped,
      portCalls: fill?.calls ?? 0,
      bucketComputations: this.#bucketComputations,
    };
    if (stroke !== undefined) statistics.strokePortCalls = stroke.calls;
    const fillLinear = fill?.linearMemoryBytes ?? null;
    const strokeLinear = stroke?.linearMemoryBytes ?? null;
    if (fillLinear !== null) statistics.portLinearMemoryBytes = fillLinear;
    if (strokeLinear !== null) statistics.strokePortLinearMemoryBytes = strokeLinear;
    // B2 section 9.1: pathMeshMemoryBytes includes the stroke port's linear memory.
    if (fillLinear !== null || strokeLinear !== null) {
      statistics.pathMeshMemoryBytes = bytes + (fillLinear ?? 0) + (strokeLinear ?? 0);
    }
    return Object.freeze(statistics) as PathMeshStatistics;
  }

  /** Terminal and idempotent. It never disposes a port, which the host owns. */
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const paint of PAINTS) {
      this.#cache[paint].clear();
      this.#bounds[paint].clear();
      this.#currentE[paint].clear();
      const channel = this.#channels[paint];
      if (channel !== undefined) channel.stack = [];
    }
    this.#memo.clear();
    this.#buckets.clear();
    this.#states.clear();
    this.#slots.clear();
    this.#strokeSlots.clear();
    this.#slotIds = [];
    this.#notices = [];
  }

  #reconcile(
    paths: readonly DerivedPath[],
    revisions: ReadonlyMap<string, number>,
    readings: Readonly<Record<PathPaint, PortReading | undefined>>,
  ): void {
    const present = new Map(paths.map((path) => [path.id, path.node]));
    const reachable = (
      paint: PathPaint,
      nodeId: string,
      revision: number,
      key: PaintKey,
      operationId: string,
    ) => {
      const node = present.get(nodeId);
      if (node === undefined || revisions.get(nodeId) !== revision) return false;
      // V3: a fill entry depends on fillRule only, so `fill: null` keeps it. A stroke entry
      // needs the same stroke key fields; a null or width-0 stroke has none.
      const current =
        paint === 'fill'
          ? Object.freeze({ paint: 'fill' as const, fillRule: node.geometry.fillRule })
          : paintKeyOf(node, paint);
      const port = readings[paint];
      return (
        current !== null &&
        paintKeysEqual(current, key) &&
        (port === undefined || !port.ok || port.operationId === operationId)
      );
    };

    for (const paint of PAINTS) {
      for (const [nodeId, nodeCache] of this.#cache[paint]) {
        if (!reachable(paint, nodeId, nodeCache.revision, nodeCache.key, nodeCache.operationId)) {
          this.#cache[paint].delete(nodeId);
        }
      }
    }
    for (const [key, entry] of this.#memo) {
      if (!reachable(entry.key.paint, entry.nodeId, entry.revision, entry.key, entry.operationId)) {
        this.#memo.delete(key);
      }
    }
    for (const map of [
      this.#buckets,
      this.#bounds.fill,
      this.#bounds.stroke,
      this.#currentE.fill,
      this.#currentE.stroke,
    ]) {
      for (const nodeId of map.keys()) if (!present.has(nodeId)) map.delete(nodeId);
    }
    for (const [key, state] of this.#states) {
      if (!present.has(state.nodeId)) this.#states.delete(key);
    }
    for (const [nodeId, slot] of this.#slots) {
      if (present.has(nodeId)) continue;
      this.#slots.delete(nodeId);
      this.#slotIds[slot] = undefined;
    }
    for (const [nodeId, slot] of this.#strokeSlots) {
      const node = present.get(nodeId);
      if (node !== undefined && this.#wantsStrokeSlot(node)) continue;
      this.#strokeSlots.delete(nodeId);
      this.#slotIds[slot] = undefined;
    }
    // V3's allocator, first free index; a stroked node's stroke slot follows its fill slot.
    for (const path of paths) {
      if (!this.#slots.has(path.id)) this.#slots.set(path.id, this.#allocateSlot(path.id));
      if (this.#wantsStrokeSlot(path.node) && !this.#strokeSlots.has(path.id)) {
        this.#strokeSlots.set(path.id, this.#allocateSlot(path.id));
      }
    }
  }

  #wantsStrokeSlot(node: PathNode): boolean {
    return this.#channels.stroke !== undefined && paintKeyOf(node, 'stroke') !== null;
  }

  #allocateSlot(nodeId: string): number {
    let slot = this.#slotIds.findIndex((entry) => entry === undefined);
    if (slot < 0) slot = this.#slotIds.length;
    this.#slotIds[slot] = nodeId;
    return slot;
  }

  /**
   * World bounds of one paint: V3's point box for the fill, the section 9.7 stroke bounds box
   * for the stroke, both mapped with P1's arithmetic rule.
   */
  #worldBounds(path: DerivedPath, revision: number, paint: PathPaint): SceneBounds | null {
    const stroke = paint === 'stroke' ? path.node.style.stroke : null;
    const cache = this.#bounds[paint];
    const previous = cache.get(path.id);
    if (
      previous !== undefined &&
      previous.revision === revision &&
      numbersEqual(previous.world, path.world) &&
      strokeBoundsEqual(previous.stroke, stroke)
    ) {
      return previous.worldBounds;
    }
    const points = path.node.geometry.points;
    const local =
      paint === 'fill' ? getPathLocalPointBounds(points) : getPathLocalStrokeBounds(points, stroke);
    const worldBounds = local === null ? null : transformSceneBounds(local, path.world);
    cache.set(path.id, Object.freeze({ revision, world: path.world, stroke, worldBounds }));
    return worldBounds;
  }

  #bucketsFor(path: DerivedPath, zoom: number, devicePixelRatio: number): PathBuckets {
    const lanes: PathLinearMap = [path.world[0], path.world[1], path.world[2], path.world[3]];
    const previous = this.#buckets.get(path.id);
    // Recomputed only when the world linear lanes, the zoom or the DPR change; a pan never.
    if (
      previous !== undefined &&
      previous.zoom === zoom &&
      previous.devicePixelRatio === devicePixelRatio &&
      numbersEqual(previous.lanes, lanes)
    ) {
      return previous.buckets;
    }
    this.#bucketComputations += 1;
    const buckets = computePathBuckets(lanes, zoom, devicePixelRatio);
    this.#buckets.set(path.id, Object.freeze({ lanes, zoom, devicePixelRatio, buckets }));
    return buckets;
  }

  /** Section c reuse rule, per node and paint: exactly e, else the largest e' in [e - 2, e - 1]. */
  #lookup(paint: PathPaint, nodeId: string, e: number): MeshEntry | undefined {
    const entries = this.#cache[paint].get(nodeId)?.entries;
    if (entries === undefined) return undefined;
    return entries.get(e) ?? entries.get(e - 1) ?? entries.get(e - 2);
  }

  #consultMemo(
    nodeId: string,
    revision: number,
    key: PaintKey,
    e: number,
    operationId: string,
    now: number,
  ): boolean {
    for (const memo of [
      memoKey(operationId, nodeId, revision, key, null),
      memoKey(operationId, nodeId, revision, key, e),
    ]) {
      const entry = this.#memo.get(memo);
      if (entry === undefined) continue;
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.#memo.delete(memo);
        continue;
      }
      entry.lastConsulted = now;
      return true;
    }
    return false;
  }

  #resolveMissing(channel: PortChannel, missing: readonly PendingRequest[], now: number): void {
    if (channel.latchedDisposed) {
      for (const request of missing) this.#memoize(request, 'batch', 'disposed', now);
      channel.stack = [];
      return;
    }
    if (channel.stack.length > 0) {
      // Resume: drop requests whose node vanished, is no longer drawable or whose key changed.
      const current = new Map(missing.map((request) => [request.nodeId, request]));
      channel.stack = channel.stack
        .map((range) =>
          range.flatMap((request) => {
            const latest = current.get(request.nodeId);
            return latest !== undefined && sameKey(latest, request) ? [latest] : [];
          }),
        )
        .filter((range) => range.length > 0);
    }
    // New keys wait until the stack is empty.
    if (channel.stack.length === 0 && missing.length > 0) {
      channel.stack.push(missing.slice(0, this.#limits.requestsPerCall));
    }
    let calls = 0;
    while (channel.stack.length > 0 && calls < this.#limits.callsPerPrepare) {
      const range = channel.stack.pop()!;
      calls += 1;
      const outcome = this.#call(channel, range, now);
      if (outcome === 'settled') continue;
      if (outcome === 'internal-error' || outcome === 'resource-limit') {
        if (range.length > 1) {
          // Depth-first, left-first: the left half is on top of the stack.
          const middle = Math.floor(range.length / 2);
          channel.stack.push(range.slice(middle));
          channel.stack.push(range.slice(0, middle));
        } else {
          this.#memoize(range[0]!, 'batch', outcome, now);
        }
        continue;
      }
      if (outcome === 'disposed') {
        channel.latchedDisposed = true;
        for (const pending of [range, ...channel.stack.reverse()]) {
          for (const request of pending) this.#memoize(request, 'batch', 'disposed', now);
        }
        channel.stack = [];
        return;
      }
      const scope = outcome === 'invalid-request' ? 'batch' : 'renderer';
      for (const request of range) this.#memoize(request, scope, outcome, now);
    }
  }

  #call(channel: PortChannel, range: readonly PendingRequest[], now: number): CallOutcome {
    channel.calls += 1;
    let verdicts: Verdict[];
    try {
      const result: unknown = channel.build(range);
      if (typeof result !== 'object' || result === null) return 'invalid-response';
      const record = result as Record<string, unknown>;
      if (record.status === 'batch-failed') {
        const code = record.code;
        return typeof code === 'string' && BATCH_CODES.has(code)
          ? (code as PathMeshBatchFailureCode)
          : 'invalid-response';
      }
      if (record.status !== 'ok') return 'invalid-response';
      const results = record.results;
      if (!Array.isArray(results) || results.length !== range.length) return 'invalid-response';
      verdicts = range.map((request, index) =>
        classifyResult(request, results[index], index, channel.failureCodes),
      );
    } catch {
      return 'invalid-response';
    }
    // Every response is validated before anything is published.
    range.forEach((request, index) => {
      const verdict = verdicts[index]!;
      if (verdict.kind === 'ok' || verdict.kind === 'empty') {
        this.#publish(request, verdict.kind === 'ok' ? verdict : null);
      } else if (verdict.kind === 'failed') {
        this.#memoize(request, 'path', verdict.code, now);
      } else {
        this.#memoize(request, 'renderer', verdict.kind, now);
      }
    });
    return 'settled';
  }

  #publish(
    request: PendingRequest,
    result: Readonly<{ mesh: FillMesh; bytes: number }> | null,
  ): void {
    const cache = this.#cache[request.key.paint];
    let nodeCache = cache.get(request.nodeId);
    if (nodeCache === undefined) {
      nodeCache = {
        revision: request.revision,
        key: request.key,
        operationId: request.operationId,
        entries: new Map(),
      };
      cache.set(request.nodeId, nodeCache);
    }
    const mesh = result?.mesh ?? null;
    const packed = mesh === null ? null : packOffsets(mesh);
    nodeCache.entries.set(request.e, {
      id: Symbol(`path-${request.key.paint}-mesh-${request.nodeId}`),
      e: request.e,
      mesh,
      offsets: packed?.offsets ?? null,
      midpoint: packed?.midpoint ?? { x: 0, y: 0 },
      // Section d: the packed Float32 offsets of the port vertices are owned by the entry.
      meshBytes: (result?.bytes ?? 0) + (packed?.offsets?.byteLength ?? 0),
      boundaryVertices: mesh === null ? 0 : new Set(mesh.boundaryEdges).size,
      variants: new Map(),
      overlays: [],
      capNotified: false,
      lastServed: 0,
    });
  }

  #memoize(
    request: PendingRequest,
    scope: PathMeshFailureScope,
    code: PathMeshFailureCode,
    now: number,
  ): void {
    // invalid-path and invalid-stroke are decided before the tolerance stage (V2; B2 section 7.8),
    // so their key and notice omit the exponent.
    const exponent = code === 'invalid-path' || code === 'invalid-stroke' ? null : request.e;
    const key = memoKey(
      request.operationId,
      request.nodeId,
      request.revision,
      request.key,
      exponent,
    );
    if (this.#memo.has(key)) return;
    this.#memo.set(key, {
      nodeId: request.nodeId,
      revision: request.revision,
      key: request.key,
      operationId: request.operationId,
      scope,
      code,
      expiresAt: code === 'resource-limit' ? now + this.#limits.resourceLimitExpiryPrepares : null,
      lastConsulted: now,
    });
    this.#enqueue(request.nodeId, scope, code, exponent, request.key.paint);
  }

  /**
   * Packs one served paint, or records its state failure and returns null. A null result hides
   * the whole path (B2 section 9.6).
   */
  #servePaint(
    item: Evaluated,
    entry: MeshEntry,
    origin: Readonly<{ x: number; y: number }>,
    frameFinite: boolean,
    frameStates: Map<string, StateFailure | null>,
  ): PathMeshDraw | null {
    const nodeId = item.path.id;
    const fail = (code: PathMeshRendererFailureCode) => {
      frameStates.set(
        stateKey(nodeId, item.paint),
        Object.freeze({ nodeId, paint: item.paint, code }),
      );
      return null;
    };
    // The shared meshFrame failing makes every drawable path packing-range (section f).
    if (!frameFinite) return fail('packing-range');
    const lanes = packInstanceLanes(item.path.world, entry, origin);
    if (lanes === null) return fail('packing-range');
    let fringeBucket: number | null = null;
    let fringe: PathMeshDraw['fringe'] = null;
    if (
      this.#fringeBuilder !== undefined &&
      entry.boundaryVertices > this.#limits.fringeBoundaryVertexCap
    ) {
      // V4 builder work cap: draw the region triangles without a fringe (aliased edges,
      // opacity applied once) and never call the builder for this entry. One notice per entry.
      if (!entry.capNotified) {
        entry.capNotified = true;
        this.#enqueue(nodeId, 'renderer', 'fringe-work-cap', entry.e, item.paint);
      }
    } else if (this.#fringeBuilder !== undefined) {
      const served = this.#serveFringe(item, entry, this.#fringeBuilder);
      if (served === 'range') return fail('fringe-range');
      if (served === 'unsupported') return null;
      fringeBucket = served.f;
      fringe = Object.freeze({ id: served.id, data: served.fringe });
    }
    const slot = item.paint === 'fill' ? this.#slots.get(nodeId)! : this.#strokeSlots.get(nodeId)!;
    return Object.freeze({
      nodeId,
      paint: item.paint,
      slot,
      toleranceExponent: entry.e,
      fringeBucket,
      fringe,
      orientation: item.orientation,
      mesh: entry.mesh!,
      entryId: entry.id,
      offsets: lanes.offsets,
      linear: lanes.linear,
      anchor: lanes.anchor,
      opacity: item.path.node.opacity,
      fill: item.color,
    });
  }

  #serveFringe(
    item: Evaluated,
    entry: MeshEntry,
    builder: PathFringeBuilder,
  ): FringeVariant | 'unsupported' | 'range' {
    // A variant built for f' serves f <= f' <= f + 1.
    for (const candidate of [item.f, item.f + 1]) {
      const variant = entry.variants.get(candidate);
      if (variant !== undefined && variant !== 'unsupported') return variant;
    }
    if (entry.variants.get(item.f) === 'unsupported') return 'unsupported';
    const built = builder(entry.mesh!, item.f);
    if (built.status === 'range') return 'range';
    const variant =
      built.status === 'built'
        ? Object.freeze({
            id: Symbol(`path-${item.paint}-fringe-${item.path.id}`),
            f: item.f,
            fringe: built.fringe,
            bytes: pathFringeBytes(built.fringe),
          })
        : ('unsupported' as const);
    entry.variants.set(item.f, variant);
    while (entry.variants.size > this.#limits.fringeVariantsPerEntry) {
      const farthest = [...entry.variants.keys()]
        .filter((f) => f !== item.f)
        .sort(
          (left, right) => Math.abs(right - item.f) - Math.abs(left - item.f) || right - left,
        )[0]!;
      entry.variants.delete(farthest);
    }
    if (variant === 'unsupported') {
      this.#enqueue(item.path.id, 'renderer', 'fringe-unsupported', item.e, item.paint);
      return 'unsupported';
    }
    return variant;
  }

  /**
   * ST-U7 addendum, sections 4.2 and 4.6: the overlay variant of one served variant pair, built
   * on first need (ST7-Q3 a) and cached on the fill entry, or null when it is marked as failed:
   * the renderer state `overlay-unsupported` with paint null, one notice per mark (ST7-Q4 a).
   * Opacity changes reuse it, and no port is called in any case.
   */
  #serveOverlay(
    nodeId: string,
    fillEntry: MeshEntry,
    strokeEntry: MeshEntry,
    pathDraws: readonly PathMeshDraw[],
    now: number,
  ): Readonly<{ id: symbol; data: JointOverlay }> | null {
    const [fillDraw, strokeDraw] = pathDraws as readonly [PathMeshDraw, PathMeshDraw];
    const fillVariant = fillDraw.fringe?.id ?? null;
    const strokeVariant = strokeDraw.fringe?.id ?? null;
    let overlay = fillEntry.overlays.find(
      (candidate) =>
        candidate.fillVariant === fillVariant &&
        candidate.strokeEntry === strokeEntry.id &&
        candidate.strokeVariant === strokeVariant,
    );
    if (overlay === undefined) {
      this.#overlayBuilds += 1;
      const result = buildJointOverlay(
        {
          fill: {
            mesh: fillEntry.mesh!,
            fringeBucket: fillDraw.fringe === null ? null : fillDraw.fringeBucket,
          },
          stroke: {
            mesh: strokeEntry.mesh!,
            fringeBucket: strokeDraw.fringe === null ? null : strokeDraw.fringeBucket,
          },
        },
        {
          limits: {
            exactTests: this.#limits.overlayExactTests,
            steinerPoints: this.#limits.overlaySteinerPoints,
          },
        },
      );
      overlay = {
        fillVariant,
        strokeEntry: strokeEntry.id,
        strokeVariant,
        built:
          result.status === 'built'
            ? Object.freeze({
                id: Symbol(`path-joint-overlay-${nodeId}`),
                overlay: result.overlay,
                bytes:
                  result.overlay.positions.byteLength +
                  result.overlay.triangles.byteLength +
                  result.overlay.lists.byteLength,
              })
            : null,
        lastServed: now,
      };
      fillEntry.overlays.push(overlay);
      this.#trimOverlays(nodeId, overlay);
      if (overlay.built === null)
        this.#enqueue(nodeId, 'renderer', 'overlay-unsupported', null, null);
    }
    overlay.lastServed = now;
    return overlay.built === null
      ? null
      : Object.freeze({ id: overlay.built.id, data: overlay.built.overlay });
  }

  /** At most overlayVariantsPerNode overlay variants per node; least recently served first. */
  #trimOverlays(nodeId: string, keep: OverlayVariant): void {
    const fillCache = this.#cache.fill.get(nodeId);
    if (fillCache === undefined) return;
    for (;;) {
      const all = [...fillCache.entries.values()].flatMap((entry) =>
        entry.overlays.map((overlay) => ({ entry, overlay })),
      );
      if (all.length <= this.#limits.overlayVariantsPerNode) return;
      const victim = all
        .filter(({ overlay }) => overlay !== keep)
        .sort((left, right) => left.overlay.lastServed - right.overlay.lastServed)[0];
      if (victim === undefined) return;
      victim.entry.overlays = victim.entry.overlays.filter((overlay) => overlay !== victim.overlay);
    }
  }

  /**
   * Drops overlay variants that became unreachable: their fill fringe variant left the fill
   * entry, or their stroke entry or its fringe variant is no longer resident (section 4.6).
   * Returns the bytes dropped.
   */
  #sweepOverlays(): number {
    let dropped = 0;
    for (const [nodeId, fillCache] of this.#cache.fill) {
      const strokeEntries = this.#cache.stroke.get(nodeId)?.entries;
      for (const entry of fillCache.entries.values()) {
        if (entry.overlays.length === 0) continue;
        const fillVariants = new Set<symbol>();
        for (const variant of entry.variants.values()) {
          if (variant !== 'unsupported') fillVariants.add(variant.id);
        }
        entry.overlays = entry.overlays.filter((overlay) => {
          const stroke =
            strokeEntries === undefined
              ? undefined
              : [...strokeEntries.values()].find(
                  (candidate) => candidate.id === overlay.strokeEntry,
                );
          const reachable =
            (overlay.fillVariant === null || fillVariants.has(overlay.fillVariant)) &&
            stroke !== undefined &&
            (overlay.strokeVariant === null ||
              [...stroke.variants.values()].some(
                (variant) => variant !== 'unsupported' && variant.id === overlay.strokeVariant,
              ));
          if (!reachable) dropped += overlay.built?.bytes ?? 0;
          return reachable;
        });
      }
    }
    return dropped;
  }

  #enqueue(
    nodeId: string,
    failureScope: PathMeshFailureScope,
    failureCode: PathMeshFailureCode,
    toleranceExponent: number | null,
    paint: PathPaint | null,
  ): void {
    if (this.#notices.length >= this.#limits.noticeQueueCapacity) {
      this.#noticesDropped += 1;
      return;
    }
    this.#notices.push(
      Object.freeze({ nodeId, failureScope, failureCode, toleranceExponent, paint }),
    );
  }

  #totalBytes(): number {
    let bytes = 0;
    for (const paint of PAINTS) {
      for (const nodeCache of this.#cache[paint].values()) {
        for (const entry of nodeCache.entries.values()) bytes += entryBytes(entry);
      }
    }
    return bytes;
  }

  /** At most toleranceVariantsPerNode entries per node and paint (B2 section 9.3). */
  #trimToleranceVariants(working: ReadonlySet<MeshEntry>): void {
    for (const paint of PAINTS) {
      for (const [nodeId, nodeCache] of this.#cache[paint]) {
        const current = this.#currentE[paint].get(nodeId);
        if (current === undefined) continue;
        while (nodeCache.entries.size > this.#limits.toleranceVariantsPerNode) {
          const victim = [...nodeCache.entries.values()]
            .filter((entry) => !working.has(entry))
            .sort(
              (left, right) =>
                Math.abs(right.e - current) - Math.abs(left.e - current) || right.e - left.e,
            )[0];
          if (victim === undefined) break;
          nodeCache.entries.delete(victim.e);
          this.#evictions += 1;
        }
      }
    }
  }

  /** V3's byte budget over the total of both paints; ties by key order (tag, node, e). */
  #evictToBudget(working: ReadonlySet<MeshEntry>): void {
    let bytes = this.#totalBytes();
    if (bytes <= this.#limits.byteBudget) return;
    const candidates: Array<Readonly<{ paint: PathPaint; nodeId: string; entry: MeshEntry }>> = [];
    for (const paint of PAINTS) {
      for (const [nodeId, nodeCache] of this.#cache[paint]) {
        for (const entry of nodeCache.entries.values()) {
          if (!working.has(entry)) candidates.push({ paint, nodeId, entry });
        }
      }
    }
    candidates.sort(
      (left, right) =>
        left.entry.lastServed - right.entry.lastServed ||
        compareOrdinal(left.paint, right.paint) ||
        compareOrdinal(left.nodeId, right.nodeId) ||
        left.entry.e - right.entry.e,
    );
    for (const { paint, nodeId, entry } of candidates) {
      if (bytes <= this.#limits.byteBudget) break;
      const nodeCache = this.#cache[paint].get(nodeId)!;
      nodeCache.entries.delete(entry.e);
      if (nodeCache.entries.size === 0) this.#cache[paint].delete(nodeId);
      bytes -= entryBytes(entry);
      this.#evictions += 1;
      // Evicting a stroke parent evicts the overlays that reference it (ST-U7, section 4.6).
      if (paint === 'stroke') bytes -= this.#sweepOverlays();
    }
    // A working set above budget is kept and counted.
    if (bytes > this.#limits.byteBudget) this.#overBudgetFrames += 1;
  }

  #evictMemo(now: number): void {
    if (this.#memo.size <= this.#limits.memoCapacity) return;
    const stale = [...this.#memo].filter(([, entry]) => entry.lastConsulted !== now);
    if (this.#memo.size - stale.length > this.#limits.memoCapacity) this.#memoOverCapFrames += 1;
    stale.sort(
      ([leftKey, left], [rightKey, right]) =>
        left.lastConsulted - right.lastConsulted || compareOrdinal(leftKey, rightKey),
    );
    for (const [key] of stale) {
      if (this.#memo.size <= this.#limits.memoCapacity) break;
      this.#memo.delete(key);
    }
  }
}

/** Formats a queued notice as the path mesh failure diagnostic (V3 section h, B2 section 9.8,
 *  E11-U4 addendum section 5). */
export function pathMeshNoticeDiagnostic(
  notice: PathMeshNotice,
  generation: number,
): DiagnosticInput {
  // fringe-work-cap (the V4 builder work cap) still draws the region triangles, without a fringe.
  const outcome =
    notice.failureCode === 'fringe-work-cap'
      ? 'is drawn without its coverage fringe'
      : 'is not drawn';
  const subject =
    notice.nodeId === null ? 'Mesh paths are not drawn' : `Path ${notice.nodeId} ${outcome}`;
  return Object.freeze({
    code: DIAGNOSTIC_CODES.PATH_MESH_FAILURE,
    severity: 'warning',
    message: `${subject} (${notice.failureScope} ${notice.failureCode}).`,
    generation,
    context: Object.freeze({
      nodeId: notice.nodeId,
      failureScope: notice.failureScope,
      failureCode: notice.failureCode,
      toleranceExponent: notice.toleranceExponent,
      paint: notice.paint,
    }),
  });
}

function createChannel(
  paint: PathPaint,
  port: Readonly<{ portVersion: unknown; operationId: unknown }>,
  eMin: number,
  failureCodes: ReadonlySet<string>,
  memoryBytes: (() => number) | undefined,
  build: (requests: readonly PendingRequest[]) => unknown,
): PortChannel {
  return {
    paint,
    port,
    build,
    failureCodes,
    memoryBytes,
    eMin,
    stack: [],
    latchedDisposed: false,
    calls: 0,
    linearMemoryBytes: null,
  };
}

function readPort(channel: PortChannel): PortReading {
  try {
    const portVersion: unknown = channel.port.portVersion;
    const operationId: unknown = channel.port.operationId;
    if (portVersion === 0 && typeof operationId === 'string' && operationId.length > 0) {
      return Object.freeze({ ok: true, operationId });
    }
  } catch {
    // A throwing getter is treated like a changed port version.
  }
  return Object.freeze({ ok: false });
}

function readMemoryBytes(memoryBytes: (() => number) | undefined): number | null {
  if (memoryBytes === undefined) return null;
  try {
    const value = memoryBytes();
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Fresh request buffers per request (V3 section b); requestId is the batch index. */
function fillRequest(request: PendingRequest, requestId: number): FillMeshRequest {
  const key = request.key as Extract<PaintKey, { paint: 'fill' }>;
  return Object.freeze({
    requestId,
    verbs: Uint8Array.from(request.node.geometry.verbs, (verb) => PATH_VERB_CODES[verb]),
    points: Float64Array.from(request.node.geometry.points),
    fillRule: key.fillRule,
    toleranceExponent: request.e,
  });
}

function strokeRequest(request: PendingRequest, requestId: number): StrokeMeshRequest {
  const key = request.key as Extract<PaintKey, { paint: 'stroke' }>;
  return Object.freeze({
    requestId,
    verbs: Uint8Array.from(request.node.geometry.verbs, (verb) => PATH_VERB_CODES[verb]),
    points: Float64Array.from(request.node.geometry.points),
    width: key.width,
    cap: key.cap,
    join: key.join,
    miterLimit: key.miterLimit,
    toleranceExponent: request.e,
  });
}

/** The paint's key fields, or null when the node has no such paint to draw. */
function paintKeyOf(node: PathNode, paint: PathPaint): PaintKey | null {
  if (paint === 'fill') {
    return node.style.fill === null
      ? null
      : Object.freeze({ paint: 'fill', fillRule: node.geometry.fillRule });
  }
  const stroke = node.style.stroke;
  if (stroke === null || !(stroke.width > 0)) return null;
  return Object.freeze({
    paint: 'stroke',
    width: stroke.width,
    cap: stroke.cap,
    join: stroke.join,
    miterLimit: stroke.miterLimit,
  });
}

function paintKeysEqual(left: PaintKey, right: PaintKey): boolean {
  if (left.paint === 'fill') return right.paint === 'fill' && left.fillRule === right.fillRule;
  if (right.paint === 'fill') return false;
  return (
    left.width === right.width &&
    left.cap === right.cap &&
    left.join === right.join &&
    left.miterLimit === right.miterLimit
  );
}

function strokeBoundsEqual(left: PathStroke | null, right: PathStroke | null): boolean {
  return left === null || right === null
    ? left === right
    : left.width === right.width &&
        left.cap === right.cap &&
        left.join === right.join &&
        left.miterLimit === right.miterLimit;
}

function stateKey(nodeId: string, paint: PathPaint | null): string {
  return JSON.stringify([nodeId, paint]);
}

/** B2 section 9.8: port-version carries no paint (overlay-unsupported is queued directly). */
function statePaintTag(state: StateFailure): PathPaint | null {
  return state.code === 'port-version' ? null : state.paint;
}

function classifyResult(
  request: PendingRequest,
  value: unknown,
  index: number,
  failureCodes: ReadonlySet<string>,
): Verdict {
  try {
    if (typeof value !== 'object' || value === null) return { kind: 'invalid-response' };
    const record = value as Record<string, unknown>;
    if (record.requestId !== index || record.toleranceExponent !== request.e) {
      return { kind: 'invalid-response' };
    }
    if (record.status === 'empty') return { kind: 'empty' };
    if (record.status === 'failed') {
      const code = record.code;
      return typeof code === 'string' && failureCodes.has(code)
        ? { kind: 'failed', code: code as StrokeMeshFailureCode }
        : { kind: 'invalid-response' };
    }
    if (record.status !== 'ok') return { kind: 'invalid-response' };
    const mesh = validateMesh(record.mesh);
    return mesh === null ? { kind: 'invalid-mesh' } : { kind: 'ok', ...mesh };
  } catch {
    return { kind: 'invalid-response' };
  }
}

/**
 * Section h's invalid-mesh checks: nonfinite position, index out of range, index count not a
 * multiple of 3, odd boundaryEdges, bounds unequal to the positions' exact bounds.
 */
function validateMesh(value: unknown): Readonly<{ mesh: FillMesh; bytes: number }> | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { positions, indices, boundaryEdges, bounds } = record;
  if (
    !(positions instanceof Float64Array) ||
    !(indices instanceof Uint32Array) ||
    !(boundaryEdges instanceof Uint32Array) ||
    positions.length % 2 !== 0 ||
    positions.length === 0 ||
    indices.length === 0 ||
    indices.length % 3 !== 0 ||
    boundaryEdges.length % 2 !== 0
  ) {
    return null;
  }
  const vertexCount = positions.length / 2;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 2) {
    const x = positions[index]!;
    const y = positions[index + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (const array of [indices, boundaryEdges]) {
    for (let index = 0; index < array.length; index += 1) {
      if (array[index]! >= vertexCount) return null;
    }
  }
  if (typeof bounds !== 'object' || bounds === null) return null;
  const box = bounds as Record<string, unknown>;
  if (box.minX !== minX || box.minY !== minY || box.maxX !== maxX || box.maxY !== maxY) {
    return null;
  }
  return Object.freeze({
    mesh: Object.freeze({
      positions,
      indices,
      boundaryEdges,
      bounds: Object.freeze({ minX, minY, maxX, maxY }),
    }),
    bytes: positions.byteLength + indices.byteLength + boundaryEdges.byteLength,
  });
}

/**
 * Section f, geometry-owned: m from V2's exact bounds (minX/2 + maxX/2, which cannot overflow)
 * and one binary32 offset u = fround(v - m) per port vertex, the difference taken in Float64.
 */
function packOffsets(mesh: FillMesh): Readonly<{
  midpoint: Readonly<{ x: number; y: number }>;
  offsets: Float32Array | null;
}> {
  const midpoint = Object.freeze({
    x: mesh.bounds.minX / 2 + mesh.bounds.maxX / 2,
    y: mesh.bounds.minY / 2 + mesh.bounds.maxY / 2,
  });
  const offsets = new Float32Array(mesh.positions.length);
  for (let index = 0; index < mesh.positions.length; index += 2) {
    offsets[index] = mesh.positions[index]! - midpoint.x;
    offsets[index + 1] = mesh.positions[index + 1]! - midpoint.y;
    if (!Number.isFinite(offsets[index]!) || !Number.isFinite(offsets[index + 1]!)) {
      return Object.freeze({ midpoint, offsets: null });
    }
  }
  return Object.freeze({ midpoint, offsets });
}

/**
 * Section f, transform-owned: the f32 lanes a, b, c, d of L and the anchor
 * B = fround(W(m) - O_m) with W(m) in Float64. Null when the entry's offsets or one of these
 * lanes is not a finite binary32 value (state failure packing-range).
 */
function packInstanceLanes(
  world: SceneAffine,
  entry: MeshEntry,
  origin: Readonly<{ x: number; y: number }>,
): Readonly<{
  offsets: Float32Array;
  linear: readonly [number, number, number, number];
  anchor: readonly [number, number];
}> | null {
  if (entry.offsets === null) return null;
  const { x, y } = entry.midpoint;
  const linear = Object.freeze([
    Math.fround(world[0]),
    Math.fround(world[1]),
    Math.fround(world[2]),
    Math.fround(world[3]),
  ] as const);
  const anchor = Object.freeze([
    Math.fround(world[0] * x + world[2] * y + world[4] - origin.x),
    Math.fround(world[1] * x + world[3] * y + world[5] - origin.y),
  ] as const);
  if (![...linear, ...anchor].every((lane) => Number.isFinite(lane))) return null;
  return Object.freeze({ offsets: entry.offsets, linear, anchor });
}

function entryBytes(entry: MeshEntry): number {
  let bytes = entry.meshBytes;
  for (const variant of entry.variants.values()) {
    if (variant !== 'unsupported') bytes += variant.bytes;
  }
  // ST-U7 addendum, section 4.6: overlay bytes count in the budget with their fill entry.
  for (const overlay of entry.overlays) bytes += overlay.built?.bytes ?? 0;
  return bytes;
}

/**
 * The memo key: the paint tag, then V3's fields, then the stroke's key fields. Every entry also
 * stores its fields, which reachability compares with `===` (no hash is trusted).
 */
function memoKey(
  operationId: string,
  nodeId: string,
  revision: number,
  key: PaintKey,
  e: number | null,
): string {
  const fields =
    key.paint === 'fill' ? [key.fillRule] : [key.width, key.cap, key.join, key.miterLimit];
  return JSON.stringify([key.paint, 0, operationId, nodeId, revision, ...fields, e]);
}

function sameKey(left: PendingRequest, right: PendingRequest): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.revision === right.revision &&
    paintKeysEqual(left.key, right.key) &&
    left.e === right.e &&
    left.operationId === right.operationId
  );
}

/** P1's viewport with its two-physical-pixel guard (primitive-scene-source.ts cullPrimitives). */
function viewportBounds(
  camera: PathMeshPrepareInput['camera'],
  target: PathMeshPrepareInput['target'],
): SceneBounds {
  const guard = 2 / (camera.zoom * target.devicePixelRatio);
  return {
    minX: camera.position.x - guard,
    minY: camera.position.y - guard,
    maxX: camera.position.x + target.width / target.devicePixelRatio / camera.zoom + guard,
    maxY: camera.position.y + target.height / target.devicePixelRatio / camera.zoom + guard,
  };
}

function meetsViewport(bounds: SceneBounds, viewport: SceneBounds): boolean {
  return (
    bounds.maxX >= viewport.minX &&
    bounds.minX <= viewport.maxX &&
    bounds.maxY >= viewport.minY &&
    bounds.minY <= viewport.maxY
  );
}

function numbersEqual(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * @internal Tests only (E10 contract, section 3.1): one mesh draw of the last non-null prepare.
 * The triangle split is null for a joint fill draw, whose records carry two role bits.
 */
export type PathDrawRecordEntryForTesting = Readonly<{
  nodeId: string;
  paint: PathPaint;
  composite: 'plain' | 'joint-fill';
  fringe: 'built' | 'region-only-cap' | 'region-only-off';
  triangleCount: number;
  regionTriangles: number | null;
  exteriorTriangles: number | null;
}>;

/** @internal Tests only (E10 contract, section 3.1). */
export type PathDrawRecordForTesting = Readonly<{
  /** Non-null prepares so far, from 1. */
  prepareSerial: number;
  draws: readonly PathDrawRecordEntryForTesting[];
}>;
