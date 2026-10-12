import {
  DIAGNOSTIC_CODES,
  PATH_VERB_CODES,
  type DiagnosticInput,
  type FillMesh,
  type FillMeshFailureCode,
  type FillMeshPort,
  type FillMeshRequest,
  type RenderNodeSnapshot,
  type SceneAffine,
  type SceneColor,
  type SceneFillRule,
} from '@vector-studio/contracts';
import {
  E_MAX,
  E_MIN,
  F_MAX,
  F_MIN,
  computePathBuckets,
  type PathBuckets,
  type PathLinearMap,
} from './path-buckets.js';
import {
  getPathLocalPointBounds,
  transformSceneBounds,
  type SceneBounds,
} from './scene-numeric.js';

// CPU path-mesh pipeline of the P3 V3 contract: port consumption, batch isolation, exact
// buckets, the mesh cache, the failure memo and the D8-interim notice queue (unit V3a), plus the
// geometry-owned K4 offsets and the transform-owned instance lanes of section f (unit V3b). The
// packet mesh part itself is assembled by path-mesh-packet.ts; V3c adds the fringe builder.

type PathNode = Extract<RenderNodeSnapshot, { kind: 'path' }>;

export type DerivedPath = Readonly<{
  id: string;
  node: PathNode;
  world: SceneAffine;
  hidden: boolean;
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
  | 'packing-range'
  | 'mesh-pipeline-unavailable';
export type PathMeshFailureCode =
  FillMeshFailureCode | PathMeshBatchFailureCode | PathMeshRendererFailureCode;

/** One D8-interim failure notice (P3 V3 contract, section h). */
export type PathMeshNotice = Readonly<{
  interim: 'd8';
  nodeId: string | null;
  failureScope: PathMeshFailureScope;
  failureCode: PathMeshFailureCode;
  toleranceExponent: number | null;
}>;

/** A path served from the mesh cache in this frame, in paint order. */
export type PathMeshDraw = Readonly<{
  nodeId: string;
  slot: number;
  /** The served entry's e', not the requested e (section c reuse rule). */
  toleranceExponent: number;
  /** The served fringe variant's f', or null when no fringe builder is installed. */
  fringeBucket: number | null;
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
  fill: SceneColor;
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
  portCalls: number;
  bucketComputations: number;
  portLinearMemoryBytes?: number;
  pathMeshMemoryBytes?: number;
}>;

/** Fringe-builder seam: V3c installs the exact builder; tests install doubles. */
export type PathFringeBuildResult =
  | Readonly<{ status: 'built'; arrays: readonly ArrayBufferView[] }>
  | Readonly<{ status: 'unsupported' }>
  | Readonly<{ status: 'range' }>;
export type PathFringeBuilder = (mesh: FillMesh, fringeBucket: number) => PathFringeBuildResult;

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
});

export type PathMeshPipelineOptions = Readonly<{
  port: FillMeshPort;
  memoryBytes?: () => number;
  limits?: Partial<PathMeshLimits>;
  fringeBuilder?: PathFringeBuilder;
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

type FringeVariant = Readonly<{ f: number; arrays: readonly ArrayBufferView[]; bytes: number }>;
type MeshEntry = {
  readonly id: symbol;
  readonly e: number;
  readonly mesh: FillMesh | null;
  /** Packed K4 offsets of the port vertices; null when one is not a finite binary32 value. */
  readonly offsets: Float32Array | null;
  readonly midpoint: Readonly<{ x: number; y: number }>;
  readonly meshBytes: number;
  readonly variants: Map<number, FringeVariant | 'unsupported'>;
  lastServed: number;
};
type NodeCache = {
  readonly revision: number;
  readonly fillRule: SceneFillRule;
  readonly operationId: string;
  readonly entries: Map<number, MeshEntry>;
};
type MemoEntry = {
  readonly nodeId: string;
  readonly revision: number;
  readonly fillRule: SceneFillRule;
  readonly operationId: string;
  readonly scope: PathMeshFailureScope;
  readonly code: PathMeshFailureCode;
  readonly expiresAt: number | null;
  lastConsulted: number;
};
type PendingRequest = Readonly<{
  nodeId: string;
  revision: number;
  fillRule: SceneFillRule;
  e: number;
  operationId: string;
  node: PathNode;
}>;
type Evaluated = Readonly<{
  path: DerivedPath;
  revision: number;
  e: number;
  f: number;
  orientation: 1 | -1;
}>;
type BucketCacheEntry = Readonly<{
  lanes: PathLinearMap;
  zoom: number;
  devicePixelRatio: number;
  buckets: PathBuckets;
}>;
type BoundsCacheEntry = Readonly<{
  revision: number;
  world: SceneAffine;
  worldBounds: SceneBounds | null;
}>;
type PortReading = Readonly<{ ok: true; operationId: string }> | Readonly<{ ok: false }>;
type Verdict =
  | Readonly<{ kind: 'ok'; mesh: FillMesh; bytes: number }>
  | Readonly<{ kind: 'empty' }>
  | Readonly<{ kind: 'failed'; code: FillMeshFailureCode }>
  | Readonly<{ kind: 'invalid-response' | 'invalid-mesh' }>;
type CallOutcome =
  | 'settled'
  | 'invalid-response'
  | 'internal-error'
  | 'resource-limit'
  | 'invalid-request'
  | 'disposed';

const FAILURE_CODES: ReadonlySet<string> = new Set([
  'invalid-path',
  'invalid-tolerance',
  'numeric-range',
  'work-limit',
  'unsupported-geometry',
]);
const BATCH_CODES: ReadonlySet<string> = new Set([
  'invalid-request',
  'disposed',
  'resource-limit',
  'internal-error',
]);

export class PathMeshPipeline {
  readonly #port: FillMeshPort;
  readonly #memoryBytes: (() => number) | undefined;
  readonly #limits: PathMeshLimits;
  readonly #fringeBuilder: PathFringeBuilder | undefined;
  #prepareCount = 0;
  #latchedDisposed = false;
  #disposed = false;
  #cache = new Map<string, NodeCache>();
  #memo = new Map<string, MemoEntry>();
  #buckets = new Map<string, BucketCacheEntry>();
  #bounds = new Map<string, BoundsCacheEntry>();
  #states = new Map<string, PathMeshRendererFailureCode>();
  #currentE = new Map<string, number>();
  #slots = new Map<string, number>();
  #slotIds: Array<string | undefined> = [];
  #stack: PendingRequest[][] = [];
  #notices: PathMeshNotice[] = [];
  #noticesDropped = 0;
  #peakBytes = 0;
  #evictions = 0;
  #overBudgetFrames = 0;
  #memoOverCapFrames = 0;
  #portCalls = 0;
  #bucketComputations = 0;
  #portLinearMemoryBytes: number | null = null;

  public constructor(options: PathMeshPipelineOptions) {
    this.#port = options.port;
    this.#memoryBytes = options.memoryBytes;
    this.#limits = Object.freeze({ ...PATH_MESH_LIMITS, ...options.limits });
    this.#fringeBuilder = options.fringeBuilder;
  }

  /** Steps 1-9 of section b, without packing. Returns the paths served in paint order. */
  public prepare(input: PathMeshPrepareInput): readonly PathMeshDraw[] {
    if (this.#disposed) return [];
    this.#prepareCount += 1;
    const now = this.#prepareCount;
    const port = this.#readPort();
    this.#portLinearMemoryBytes = this.#readMemoryBytes();

    // Step 1: reconcile slots, caches and memo against the published path nodes.
    const revisions = new Map<string, number>();
    for (const path of input.paths) {
      revisions.set(path.id, input.geometryRevision(path.id) ?? 0);
    }
    this.#reconcile(input.paths, revisions, port);

    // Steps 2-4: drawability, buckets, state checks, mesh lookup, then the memo.
    const { zoom } = input.camera;
    const { devicePixelRatio } = input.target;
    const viewport = viewportBounds(input.camera, input.target);
    const evaluated: Evaluated[] = [];
    const missing: PendingRequest[] = [];
    const frameStates = new Map<string, PathMeshRendererFailureCode | null>();
    for (const path of input.paths) {
      const node = path.node;
      if (path.hidden || node.style.fill === null || node.geometry.verbs.length === 0) continue;
      const revision = revisions.get(path.id)!;
      const worldBounds = this.#worldBounds(path, revision);
      if (worldBounds === null || !meetsViewport(worldBounds, viewport)) continue;
      const buckets = this.#bucketsFor(path, zoom, devicePixelRatio);
      if (buckets.singular) continue;

      // One state code per node and prepare, in a fixed order: the port, then the exact bucket
      // ranges of section c, then the f32 orientation check of the packed lanes.
      const state: PathMeshRendererFailureCode | null = !port.ok
        ? 'port-version'
        : buckets.e < E_MIN
          ? 'tolerance-range'
          : buckets.f < F_MIN || buckets.f > F_MAX
            ? 'fringe-range'
            : buckets.f32OrientationMismatch
              ? 'packing-range'
              : null;
      frameStates.set(path.id, state);
      if (state !== null || !port.ok) continue;

      const e = Math.min(buckets.e, E_MAX);
      this.#currentE.set(path.id, e);
      evaluated.push(
        Object.freeze({ path, revision, e, f: buckets.f, orientation: buckets.orientation }),
      );
      if (this.#lookup(path.id, e) !== undefined) continue;
      if (this.#consultMemo(path, revision, e, port.operationId, now)) continue;
      missing.push(
        Object.freeze({
          nodeId: path.id,
          revision,
          fillRule: node.geometry.fillRule,
          e,
          operationId: port.operationId,
          node,
        }),
      );
    }

    // Steps 5-7: one batch, isolation of a failed batch, response validation and publication.
    if (port.ok) this.#resolveMissing(missing, now);

    // Step 8: serve meshes and fringe variants in paint order, then pack the section f lanes.
    const draws: PathMeshDraw[] = [];
    const working = new Set<MeshEntry>();
    const { origin, frameFinite } = input.packing;
    for (const item of evaluated) {
      const entry = this.#lookup(item.path.id, item.e);
      if (entry === undefined) continue;
      entry.lastServed = now;
      working.add(entry);
      if (entry.mesh === null) continue;
      // The shared meshFrame failing makes every drawable path packing-range (section f).
      if (!frameFinite) {
        frameStates.set(item.path.id, 'packing-range');
        continue;
      }
      const lanes = packInstanceLanes(item.path.world, entry, origin);
      if (lanes === null) {
        frameStates.set(item.path.id, 'packing-range');
        continue;
      }
      let fringeBucket: number | null = null;
      if (this.#fringeBuilder !== undefined) {
        const served = this.#serveFringe(item, entry, this.#fringeBuilder);
        if (served === 'range') {
          frameStates.set(item.path.id, 'fringe-range');
          continue;
        }
        if (served === 'unsupported') continue;
        fringeBucket = served.f;
      }
      draws.push(
        Object.freeze({
          nodeId: item.path.id,
          slot: this.#slots.get(item.path.id)!,
          toleranceExponent: entry.e,
          fringeBucket,
          orientation: item.orientation,
          mesh: entry.mesh,
          entryId: entry.id,
          offsets: lanes.offsets,
          linear: lanes.linear,
          anchor: lanes.anchor,
          opacity: item.path.node.opacity,
          fill: item.path.node.style.fill!,
        }),
      );
    }

    // State-failure notices on (node, code) transitions only.
    for (const [nodeId, state] of frameStates) {
      const previous = this.#states.get(nodeId) ?? null;
      if (state === previous) continue;
      if (state === null) {
        this.#states.delete(nodeId);
      } else {
        this.#states.set(nodeId, state);
        this.#enqueue(nodeId, 'renderer', state, null);
      }
    }

    // Step 9: bounded eviction.
    this.#peakBytes = Math.max(this.#peakBytes, this.#totalBytes());
    this.#trimToleranceVariants(working);
    this.#evictToBudget(working);
    this.#evictMemo(now);
    return Object.freeze(draws);
  }

  /** Occupied path slots by node id, including hidden and culled path nodes. */
  public getPathSlots(): ReadonlyMap<string, number> {
    return this.#slots;
  }

  /** Identities of every entry currently resident in the mesh cache. */
  public getResidentEntryIds(): ReadonlySet<symbol> {
    const ids = new Set<symbol>();
    for (const nodeCache of this.#cache.values()) {
      for (const entry of nodeCache.entries.values()) ids.add(entry.id);
    }
    return ids;
  }

  /** At most `noticesPerPacket` queued notices, oldest first; the rest stay queued. */
  public takePacketNotices(): readonly PathMeshNotice[] {
    return Object.freeze(this.#notices.splice(0, this.#limits.noticesPerPacket));
  }

  public getStatistics(): PathMeshStatistics {
    const bytes = this.#totalBytes();
    let entries = 0;
    for (const nodeCache of this.#cache.values()) entries += nodeCache.entries.size;
    const statistics = {
      entries,
      bytes,
      peakBytes: this.#peakBytes,
      evictions: this.#evictions,
      overBudgetFrames: this.#overBudgetFrames,
      memoEntries: this.#memo.size,
      memoOverCapFrames: this.#memoOverCapFrames,
      noticesQueued: this.#notices.length,
      noticesDropped: this.#noticesDropped,
      portCalls: this.#portCalls,
      bucketComputations: this.#bucketComputations,
    };
    const linear = this.#portLinearMemoryBytes;
    return Object.freeze(
      linear === null
        ? statistics
        : { ...statistics, portLinearMemoryBytes: linear, pathMeshMemoryBytes: bytes + linear },
    );
  }

  /** Terminal and idempotent. It never disposes the port, which the host owns. */
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cache.clear();
    this.#memo.clear();
    this.#buckets.clear();
    this.#bounds.clear();
    this.#states.clear();
    this.#currentE.clear();
    this.#slots.clear();
    this.#slotIds = [];
    this.#stack = [];
    this.#notices = [];
  }

  #readPort(): PortReading {
    try {
      const portVersion: unknown = this.#port.portVersion;
      const operationId: unknown = this.#port.operationId;
      if (portVersion === 0 && typeof operationId === 'string' && operationId.length > 0) {
        return Object.freeze({ ok: true, operationId });
      }
    } catch {
      // A throwing getter is treated like a changed port version.
    }
    return Object.freeze({ ok: false });
  }

  #readMemoryBytes(): number | null {
    if (this.#memoryBytes === undefined) return null;
    try {
      const value = this.#memoryBytes();
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  #reconcile(
    paths: readonly DerivedPath[],
    revisions: ReadonlyMap<string, number>,
    port: PortReading,
  ): void {
    const present = new Map(paths.map((path) => [path.id, path.node.geometry.fillRule]));
    const reachable = (
      nodeId: string,
      revision: number,
      fillRule: SceneFillRule,
      operationId: string,
    ) =>
      present.get(nodeId) === fillRule &&
      revisions.get(nodeId) === revision &&
      (!port.ok || port.operationId === operationId);

    for (const [nodeId, nodeCache] of this.#cache) {
      if (!reachable(nodeId, nodeCache.revision, nodeCache.fillRule, nodeCache.operationId)) {
        this.#cache.delete(nodeId);
      }
    }
    for (const [key, entry] of this.#memo) {
      if (!reachable(entry.nodeId, entry.revision, entry.fillRule, entry.operationId)) {
        this.#memo.delete(key);
      }
    }
    for (const map of [this.#buckets, this.#bounds, this.#states, this.#currentE]) {
      for (const nodeId of map.keys()) if (!present.has(nodeId)) map.delete(nodeId);
    }
    for (const [nodeId, slot] of this.#slots) {
      if (present.has(nodeId)) continue;
      this.#slots.delete(nodeId);
      this.#slotIds[slot] = undefined;
    }
    for (const path of paths) {
      if (this.#slots.has(path.id)) continue;
      let slot = this.#slotIds.findIndex((entry) => entry === undefined);
      if (slot < 0) slot = this.#slotIds.length;
      this.#slots.set(path.id, slot);
      this.#slotIds[slot] = path.id;
    }
  }

  #worldBounds(path: DerivedPath, revision: number): SceneBounds | null {
    const previous = this.#bounds.get(path.id);
    if (
      previous !== undefined &&
      previous.revision === revision &&
      numbersEqual(previous.world, path.world)
    ) {
      return previous.worldBounds;
    }
    const local = getPathLocalPointBounds(path.node.geometry.points);
    const worldBounds = local === null ? null : transformSceneBounds(local, path.world);
    this.#bounds.set(path.id, Object.freeze({ revision, world: path.world, worldBounds }));
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

  /** Section c reuse rule: exactly e, else the largest resident e' in [e - 2, e - 1]. */
  #lookup(nodeId: string, e: number): MeshEntry | undefined {
    const entries = this.#cache.get(nodeId)?.entries;
    if (entries === undefined) return undefined;
    return entries.get(e) ?? entries.get(e - 1) ?? entries.get(e - 2);
  }

  #consultMemo(
    path: DerivedPath,
    revision: number,
    e: number,
    operationId: string,
    now: number,
  ): boolean {
    const fillRule = path.node.geometry.fillRule;
    for (const key of [
      memoKey(operationId, path.id, revision, fillRule, null),
      memoKey(operationId, path.id, revision, fillRule, e),
    ]) {
      const entry = this.#memo.get(key);
      if (entry === undefined) continue;
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.#memo.delete(key);
        continue;
      }
      entry.lastConsulted = now;
      return true;
    }
    return false;
  }

  #resolveMissing(missing: readonly PendingRequest[], now: number): void {
    if (this.#latchedDisposed) {
      for (const request of missing) this.#memoize(request, 'batch', 'disposed', now);
      this.#stack = [];
      return;
    }
    if (this.#stack.length > 0) {
      // Resume: drop requests whose node vanished, is no longer drawable or whose key changed.
      const current = new Map(missing.map((request) => [request.nodeId, request]));
      this.#stack = this.#stack
        .map((range) =>
          range.flatMap((request) => {
            const latest = current.get(request.nodeId);
            return latest !== undefined && sameKey(latest, request) ? [latest] : [];
          }),
        )
        .filter((range) => range.length > 0);
    }
    // New keys wait until the stack is empty.
    if (this.#stack.length === 0 && missing.length > 0) {
      this.#stack.push(missing.slice(0, this.#limits.requestsPerCall));
    }
    let calls = 0;
    while (this.#stack.length > 0 && calls < this.#limits.callsPerPrepare) {
      const range = this.#stack.pop()!;
      calls += 1;
      const outcome = this.#call(range, now);
      if (outcome === 'settled') continue;
      if (outcome === 'internal-error' || outcome === 'resource-limit') {
        if (range.length > 1) {
          // Depth-first, left-first: the left half is on top of the stack.
          const middle = Math.floor(range.length / 2);
          this.#stack.push(range.slice(middle));
          this.#stack.push(range.slice(0, middle));
        } else {
          this.#memoize(range[0]!, 'batch', outcome, now);
        }
        continue;
      }
      if (outcome === 'disposed') {
        this.#latchedDisposed = true;
        for (const pending of [range, ...this.#stack.reverse()]) {
          for (const request of pending) this.#memoize(request, 'batch', 'disposed', now);
        }
        this.#stack = [];
        return;
      }
      const scope = outcome === 'invalid-request' ? 'batch' : 'renderer';
      for (const request of range) this.#memoize(request, scope, outcome, now);
    }
  }

  #call(range: readonly PendingRequest[], now: number): CallOutcome {
    this.#portCalls += 1;
    const requests: FillMeshRequest[] = range.map((request, requestId) =>
      Object.freeze({
        requestId,
        verbs: Uint8Array.from(request.node.geometry.verbs, (verb) => PATH_VERB_CODES[verb]),
        points: Float64Array.from(request.node.geometry.points),
        fillRule: request.fillRule,
        toleranceExponent: request.e,
      }),
    );
    let verdicts: Verdict[];
    try {
      const result: unknown = this.#port.buildFillMeshes(Object.freeze(requests));
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
      verdicts = range.map((request, index) => classifyResult(request, results[index], index));
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
    let nodeCache = this.#cache.get(request.nodeId);
    if (nodeCache === undefined) {
      nodeCache = {
        revision: request.revision,
        fillRule: request.fillRule,
        operationId: request.operationId,
        entries: new Map(),
      };
      this.#cache.set(request.nodeId, nodeCache);
    }
    const mesh = result?.mesh ?? null;
    const packed = mesh === null ? null : packOffsets(mesh);
    nodeCache.entries.set(request.e, {
      id: Symbol(`path-mesh-${request.nodeId}`),
      e: request.e,
      mesh,
      offsets: packed?.offsets ?? null,
      midpoint: packed?.midpoint ?? { x: 0, y: 0 },
      // Section d: the packed Float32 offsets of the port vertices are owned by the entry.
      meshBytes: (result?.bytes ?? 0) + (packed?.offsets?.byteLength ?? 0),
      variants: new Map(),
      lastServed: 0,
    });
  }

  #memoize(
    request: PendingRequest,
    scope: PathMeshFailureScope,
    code: PathMeshFailureCode,
    now: number,
  ): void {
    // invalid-path is decided before the tolerance stage, so its key omits the exponent.
    const exponent = code === 'invalid-path' ? null : request.e;
    const key = memoKey(
      request.operationId,
      request.nodeId,
      request.revision,
      request.fillRule,
      exponent,
    );
    if (this.#memo.has(key)) return;
    this.#memo.set(key, {
      nodeId: request.nodeId,
      revision: request.revision,
      fillRule: request.fillRule,
      operationId: request.operationId,
      scope,
      code,
      expiresAt: code === 'resource-limit' ? now + this.#limits.resourceLimitExpiryPrepares : null,
      lastConsulted: now,
    });
    this.#enqueue(request.nodeId, scope, code, exponent);
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
            f: item.f,
            arrays: Object.freeze([...built.arrays]),
            bytes: built.arrays.reduce((sum, array) => sum + array.byteLength, 0),
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
      this.#enqueue(item.path.id, 'renderer', 'fringe-unsupported', item.e);
      return 'unsupported';
    }
    return variant;
  }

  #enqueue(
    nodeId: string,
    failureScope: PathMeshFailureScope,
    failureCode: PathMeshFailureCode,
    toleranceExponent: number | null,
  ): void {
    if (this.#notices.length >= this.#limits.noticeQueueCapacity) {
      this.#noticesDropped += 1;
      return;
    }
    this.#notices.push(
      Object.freeze({ interim: 'd8', nodeId, failureScope, failureCode, toleranceExponent }),
    );
  }

  #totalBytes(): number {
    let bytes = 0;
    for (const nodeCache of this.#cache.values()) {
      for (const entry of nodeCache.entries.values()) bytes += entryBytes(entry);
    }
    return bytes;
  }

  #trimToleranceVariants(working: ReadonlySet<MeshEntry>): void {
    for (const [nodeId, nodeCache] of this.#cache) {
      const current = this.#currentE.get(nodeId);
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

  #evictToBudget(working: ReadonlySet<MeshEntry>): void {
    let bytes = this.#totalBytes();
    if (bytes <= this.#limits.byteBudget) return;
    const candidates: Array<Readonly<{ nodeId: string; entry: MeshEntry }>> = [];
    for (const [nodeId, nodeCache] of this.#cache) {
      for (const entry of nodeCache.entries.values()) {
        if (!working.has(entry)) candidates.push({ nodeId, entry });
      }
    }
    candidates.sort(
      (left, right) =>
        left.entry.lastServed - right.entry.lastServed ||
        compareOrdinal(left.nodeId, right.nodeId) ||
        left.entry.e - right.entry.e,
    );
    for (const { nodeId, entry } of candidates) {
      if (bytes <= this.#limits.byteBudget) break;
      const nodeCache = this.#cache.get(nodeId)!;
      nodeCache.entries.delete(entry.e);
      if (nodeCache.entries.size === 0) this.#cache.delete(nodeId);
      bytes -= entryBytes(entry);
      this.#evictions += 1;
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

/** Formats a queued notice as the D8-interim diagnostic of section h. */
export function pathMeshNoticeDiagnostic(
  notice: PathMeshNotice,
  generation: number,
): DiagnosticInput {
  const subject = notice.nodeId === null ? 'the mesh path' : `path ${notice.nodeId}`;
  return Object.freeze({
    code: DIAGNOSTIC_CODES.PATH_MESH_INTERIM_FAILURE,
    severity: 'warning',
    message: `D8-interim: ${subject} is not drawn (${notice.failureScope} ${notice.failureCode}).`,
    generation,
    context: Object.freeze({
      interim: notice.interim,
      nodeId: notice.nodeId,
      failureScope: notice.failureScope,
      failureCode: notice.failureCode,
      toleranceExponent: notice.toleranceExponent,
    }),
  });
}

function classifyResult(request: PendingRequest, value: unknown, index: number): Verdict {
  try {
    if (typeof value !== 'object' || value === null) return { kind: 'invalid-response' };
    const record = value as Record<string, unknown>;
    if (record.requestId !== index || record.toleranceExponent !== request.e) {
      return { kind: 'invalid-response' };
    }
    if (record.status === 'empty') return { kind: 'empty' };
    if (record.status === 'failed') {
      const code = record.code;
      return typeof code === 'string' && FAILURE_CODES.has(code)
        ? { kind: 'failed', code: code as FillMeshFailureCode }
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
  return bytes;
}

function memoKey(
  operationId: string,
  nodeId: string,
  revision: number,
  fillRule: SceneFillRule,
  e: number | null,
): string {
  return JSON.stringify([0, operationId, nodeId, revision, fillRule, e]);
}

function sameKey(left: PendingRequest, right: PendingRequest): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.revision === right.revision &&
    left.fillRule === right.fillRule &&
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
