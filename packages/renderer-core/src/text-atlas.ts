import {
  DIAGNOSTIC_CODES,
  type DiagnosticInput,
  type GlyphRasterPhase,
  type GlyphRasterPort,
  type GlyphRasterResult,
  type RenderNodeSnapshot,
  type SceneAffine,
} from '@vector-studio/contracts';
import { clusterLocalBounds, type SceneBounds } from './scene-numeric.js';

export { clusterLocalBounds, getTextLocalBounds } from './scene-numeric.js';

/**
 * E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md), unit U2: the glyph atlas plan.
 * Text clusters are placed by E28-K1 to K3 on the CPU, looked up by the E28-K10 key and, on a
 * miss, rasterized through the `GlyphRasterPort` and packed into atlas pages. The plan decides
 * page count, clears and uploads, and commits them only when the packet that carried them is
 * acknowledged (section 4, Lifetime). Pure CPU data; the GPU pages and pipeline belong to U3.
 */

/** Section 4, Pages: at most 8 pages of 2048 × 2048 r8unorm, 32 MiB in all. */
export const E28_ATLAS_PAGES_MAX = 8;
export const E28_ATLAS_PAGE_SIZE = 2048;
/** Section 4, Raster budget (E28-Q6 (a)): port calls per prepared frame. */
export const E28_RASTER_PER_FRAME = 256;
/** E28-K4: the raster cap C, in device px. */
export const E28_RASTER_CAP = 256;
/** The port's largest bitmap edge (section 2); larger results are `too-large`. */
const BITMAP_EDGE_MAX = 1024;
/** Section 4, Pages: the gap between packed bitmaps. */
const GUTTER = 1;
/** Floats per instance record (section 4, Packet). */
export const TEXT_INSTANCE_FLOATS = 16;
/** Section 5: the queue limits of the text warnings, as for `render.clip-resource-limit`. */
const NOTICES_QUEUED = 4096;
export const TEXT_NOTICES_PER_PACKET = 32;
/** Cached empty and failed outcomes kept before the cache is cleared. */
const OUTCOMES_MAX = 65_536;
/** E28-K3: the relative tolerance of the snapped classification. */
const SNAP_TOLERANCE = 1e-9;

export type TextFailureReason = 'too-large' | 'unavailable' | 'threw';
/** E28-D2 and E28-D3, with their section 5 contexts. */
export type TextNotice =
  | Readonly<{ code: 'text-resource-limit'; nodeId: string; omitted: number; pages: number }>
  | Readonly<{ code: 'glyph-raster-failure'; nodeId: string; reason: TextFailureReason }>;

export function textNoticeDiagnostic(notice: TextNotice, generation: number): DiagnosticInput {
  if (notice.code === 'text-resource-limit') {
    return Object.freeze({
      code: DIAGNOSTIC_CODES.TEXT_RESOURCE_LIMIT,
      severity: 'warning',
      message: `Text node ${notice.nodeId} omits ${notice.omitted} clusters: this frame's clusters exceed the ${notice.pages}-page glyph atlas.`,
      generation,
      context: Object.freeze({
        nodeId: notice.nodeId,
        omitted: notice.omitted,
        pages: notice.pages,
      }),
    });
  }
  return Object.freeze({
    code: DIAGNOSTIC_CODES.GLYPH_RASTER_FAILURE,
    severity: 'warning',
    message: `A cluster of text node ${notice.nodeId} is not drawn: its glyph raster ${notice.reason === 'threw' ? 'threw' : `failed (${notice.reason})`}.`,
    generation,
    context: Object.freeze({ nodeId: notice.nodeId, reason: notice.reason }),
  });
}

/**
 * E28-K1: the map from a node's local units to device px, `(world − camera) · zoom · DPR` after
 * the node's world transform.
 */
export function textDeviceMap(
  world: SceneAffine,
  camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
  devicePixelRatio: number,
): SceneAffine {
  const scale = camera.zoom * devicePixelRatio;
  const [a, b, c, d, e, f] = world;
  return [
    scale * a,
    scale * b,
    scale * c,
    scale * d,
    scale * (e - camera.position.x),
    scale * (f - camera.position.y),
  ];
}

/** Half-up rounding, `⌊v + 0.5⌋`, also for negative values (E28-K3). */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5);
}

/** E28-K2: the size bucket of a device size `s ≥ 0.5`, clamped to the raster cap (E28-K4). */
export function sizeBucket(size: number): number {
  const bucket = size <= 64 ? roundHalfUp(4 * size) / 4 : roundHalfUp(size);
  return Math.min(bucket, E28_RASTER_CAP);
}

/** E28-K3: `M_lin = σ · I` within a relative 1e-9 (uniform positive scale, no rotation or flip). */
export function isUniformScale(map: SceneAffine, sigma: number): boolean {
  const [a, b, c, d] = map;
  const tolerance = SNAP_TOLERANCE * sigma;
  return (
    a > 0 &&
    d > 0 &&
    Math.abs(a - sigma) <= tolerance &&
    Math.abs(d - sigma) <= tolerance &&
    Math.abs(b) <= tolerance &&
    Math.abs(c) <= tolerance
  );
}

/** E28-K3, snapped: the phase and the device pixel corner `P` of a pen point `o`. */
export function snappedPlacement(
  x: number,
  y: number,
): Readonly<{ phaseX: GlyphRasterPhase; px: number; py: number }> {
  const q = roundHalfUp(4 * x);
  const phaseX = ((((q % 4) + 4) % 4) / 4) as GlyphRasterPhase;
  return { phaseX, px: Math.floor(q / 4), py: roundHalfUp(y) };
}

/** An atlas entry: one rasterized bitmap in a page. */
export type AtlasEntry = Readonly<{
  key: string;
  base: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  bucket: number;
  phaseX: GlyphRasterPhase;
  generation: number;
}>;

type Shelf = Readonly<{ y: number; height: number; x: number }>;
type AtlasPage = Readonly<{
  shelves: readonly Shelf[];
  /** The first row below every shelf. */
  bottom: number;
  keys: ReadonlySet<string>;
  /** The last frame that drew from the page. */
  lastUsed: number;
  /** True when the page's content is unknown: it is cleared before its next allocation. */
  dirty: boolean;
  /** The backend incarnation of the page, from the last acknowledged receipt. */
  incarnation: symbol | null;
}>;

const EMPTY_PAGE: AtlasPage = Object.freeze({
  shelves: Object.freeze([]),
  bottom: 0,
  keys: new Set<string>(),
  lastUsed: -1,
  dirty: false,
  incarnation: null,
});

export type TextClear = Readonly<{
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}>;
export type TextUpload = Readonly<{
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  coverage: Uint8Array;
}>;

/** One visible cluster to resolve: its key fields (E28-K10). */
export type AtlasRequest = Readonly<{
  nodeId: string;
  generation: number;
  lang: string;
  fontList: string;
  text: string;
  bucket: number;
  phaseX: GlyphRasterPhase;
}>;

/**
 * A cluster's resolution: an exact entry, a fallback entry of another bucket or phase drawn by
 * the general path (the cluster is deferred), or nothing. `deferred` without an entry draws
 * nothing this frame; `omitted` and `failed` are never deferred.
 */
export type AtlasResolution =
  | Readonly<{ kind: 'entry'; entry: AtlasEntry; fallback: boolean }>
  | Readonly<{ kind: 'deferred' | 'empty' | 'failed' | 'omitted' }>;

/** A planned frame: the packet's atlas fields, and the working state that its receipt commits. */
export type AtlasFrame = Readonly<{
  rendererGeneration: number;
  frame: number;
  pageCount: number;
  clears: readonly TextClear[];
  uploads: readonly TextUpload[];
  resolutions: readonly AtlasResolution[];
  deferred: number;
  omitted: number;
  /** Working pages; index `i` holds page `i`. */
  pages: readonly AtlasPage[];
  added: ReadonlyMap<string, AtlasEntry>;
  evicted: ReadonlySet<number>;
  used: ReadonlySet<number>;
  evictions: number;
  /** Section 4, Compaction: the page this frame evicted before its lookups, if any. */
  compacted: number | null;
  /** Section 4, Compaction: the page the next frame evicts first, if any. */
  compactNext: number | null;
}>;

/** The backend's part of a receipt for a packet with a `text` part (section 4, Lifetime). */
export type TextReceiptPart = Readonly<{
  /** Per page index, the incarnation the packet's clears, uploads and draws used. */
  pages: readonly symbol[];
  clears: number;
  uploads: number;
}>;

export type GlyphAtlasOptions = Readonly<{ pages?: number; pageSize?: number }>;

/**
 * Section 4, Atlas plan: the committed atlas state and the per-frame plan over it. Committed
 * state changes only on `acknowledge`; a frame replaced without acknowledgement drops the
 * entries on every page it cleared or uploaded to (`replaced`).
 */
export class GlyphAtlasPlan {
  readonly #port: GlyphRasterPort;
  readonly #pagesMax: number;
  readonly #pageSize: number;
  #rendererGeneration: number | null = null;
  #pages: AtlasPage[] = [];
  #entries = new Map<string, AtlasEntry>();
  #bases = new Map<string, Set<string>>();
  /** Empty and failed raster outcomes; they touch no page, so they are kept at once. */
  #outcomes = new Map<
    string,
    Readonly<{ generation: number; status: 'empty' | 'failed'; reason?: TextFailureReason }>
  >();
  #newestGeneration = -1;
  #frame = 0;
  #overLimit = false;
  /** Section 4, Compaction: the page the next frame evicts before its lookups. */
  #compactNext: number | null = null;
  #failuresReported = new Set<string>();
  #notices: TextNotice[] = [];
  #noticesDropped = 0;
  #rasterCalls = 0;
  #uploads = 0;
  #evictions = 0;

  public constructor(port: GlyphRasterPort, options: GlyphAtlasOptions = {}) {
    this.#port = port;
    this.#pagesMax = options.pages ?? E28_ATLAS_PAGES_MAX;
    this.#pageSize = options.pageSize ?? E28_ATLAS_PAGE_SIZE;
  }

  public get pageSize(): number {
    return this.#pageSize;
  }

  /** Committed page count: the pages the backend holds after the last acknowledged packet. */
  public get committedPageCount(): number {
    return this.#pages.length;
  }

  public get rasterCalls(): number {
    return this.#rasterCalls;
  }

  public get uploads(): number {
    return this.#uploads;
  }

  public get evictions(): number {
    return this.#evictions;
  }

  public get noticesDropped(): number {
    return this.#noticesDropped;
  }

  /** The notices of the next packet; they leave the queue through `consumeNotices`. */
  public peekNotices(): readonly TextNotice[] {
    return this.#notices.slice(0, TEXT_NOTICES_PER_PACKET);
  }

  public consumeNotices(count: number): void {
    this.#notices.splice(0, count);
  }

  /** Drops every entry and page: device loss, release and dispose. */
  public reset(): void {
    this.#compactNext = null;
    this.#pages = [];
    this.#entries.clear();
    this.#bases.clear();
  }

  /**
   * Plans one frame. `holdsText` is false when the scene holds no text node, which releases
   * every page (section 4, Release). A new renderer generation starts from an empty plan.
   */
  public plan(
    rendererGeneration: number,
    requests: readonly AtlasRequest[],
    holdsText: boolean,
  ): AtlasFrame {
    if (rendererGeneration !== this.#rendererGeneration) {
      this.#rendererGeneration = rendererGeneration;
      this.reset();
    }
    this.#frame += 1;
    const frame = this.#frame;
    if (!holdsText) {
      this.#outcomes.clear();
      return Object.freeze({
        rendererGeneration,
        frame,
        pageCount: 0,
        clears: [],
        uploads: [],
        resolutions: [],
        deferred: 0,
        omitted: 0,
        pages: [],
        added: new Map<string, AtlasEntry>(),
        evicted: new Set(this.#pages.map((_, index) => index)),
        used: new Set<number>(),
        evictions: 0,
        compacted: null,
        compactNext: null,
      });
    }
    for (const request of requests) this.#observeGeneration(request.generation);

    const pages = [...this.#pages];
    const added = new Map<string, AtlasEntry>();
    const addedBases = new Map<string, Set<string>>();
    const evicted = new Set<number>();
    const used = new Set<number>();
    const clears: TextClear[] = [];
    const uploads: TextUpload[] = [];
    // Keys this frame draws from; an entry outside it is stale for this frame.
    const usedKeys = new Set<string>();
    // Pages whose key set this frame already copied, so an allocation adds to it in place.
    const ownedKeys = new Set<number>();
    let evictions = 0;
    const evict = (index: number) => {
      evicted.add(index);
      clears.push(fullPageClear(index, this.#pageSize));
      evictions += 1;
      pages[index] = Object.freeze({
        ...EMPTY_PAGE,
        keys: new Set<string>(),
        incarnation: pages[index]!.incarnation,
      });
      ownedKeys.add(index);
    };
    // Section 4, Compaction: the page a fragmented frame chose is evicted before the lookups, so
    // the clusters this frame draws from it are rasterized again.
    const compacted =
      this.#compactNext !== null && this.#compactNext < pages.length ? this.#compactNext : null;
    if (compacted !== null) evict(compacted);
    const lookup = (key: string): AtlasEntry | undefined => {
      const fresh = added.get(key);
      if (fresh !== undefined) return fresh;
      const entry = this.#entries.get(key);
      return entry === undefined || evicted.has(entry.page) ? undefined : entry;
    };

    // Phase one: every hit marks its page as used by this frame, before any allocation.
    const keys = requests.map((request) =>
      JSON.stringify([
        request.generation,
        request.lang,
        request.fontList,
        request.text,
        request.bucket,
        request.phaseX,
      ]),
    );
    const resolutions: (AtlasResolution | undefined)[] = requests.map((_, index) => {
      const entry = lookup(keys[index]!);
      if (entry === undefined) return undefined;
      used.add(entry.page);
      usedKeys.add(entry.key);
      return Object.freeze({ kind: 'entry', entry, fallback: false });
    });

    // Phase two: the misses, in paint order, under the raster budget.
    let calls = 0;
    let deferred = 0;
    let omitted = 0;
    let firstOmitted: string | null = null;
    // Eviction step 3: once every page is used by this frame, later misses are omitted without a
    // port call, so an over-limit frame neither spends the budget nor defers (and converges).
    let full = false;
    // Section 4, Compaction: every page is used by this frame, but some hold entries it does not
    // draw. This and later misses are deferred, and the next frame evicts the stalest page.
    let fragmented = false;
    const fragmentDeferred: number[] = [];
    const omittedKeys = new Set<string>();
    const addKey = (index: number, key: string) => {
      if (!ownedKeys.has(index)) {
        pages[index] = Object.freeze({ ...pages[index]!, keys: new Set(pages[index]!.keys) });
        ownedKeys.add(index);
      }
      (pages[index]!.keys as Set<string>).add(key);
    };
    const allocate = (
      width: number,
      height: number,
    ): Readonly<{ page: number; x: number; y: number }> | null => {
      // A bitmap larger than a page fits nowhere; it evicts nothing.
      if (width > this.#pageSize || height > this.#pageSize) return null;
      const fit = (index: number) => {
        const page = pages[index]!;
        const placed = placeOnPage(page, width, height, this.#pageSize);
        if (placed === null) return null;
        if (page.dirty) {
          clears.push(fullPageClear(index, this.#pageSize));
        }
        pages[index] = placed.page;
        return { page: index, x: placed.x, y: placed.y };
      };
      for (let index = 0; index < pages.length; index += 1) {
        const result = fit(index);
        if (result !== null) return result;
      }
      if (pages.length < this.#pagesMax) {
        pages.push(EMPTY_PAGE);
        const result = fit(pages.length - 1);
        if (result !== null) return result;
        pages.pop();
        return null;
      }
      // Eviction (E28-Q3 (a)): a page not used by this frame, pages holding only older-generation
      // entries first, then the least recently used, then the lowest index.
      let victim = -1;
      let victimOld = false;
      for (let index = 0; index < pages.length; index += 1) {
        if (used.has(index)) continue;
        const page = pages[index]!;
        const old = this.#holdsOnlyOlder(page, added);
        if (
          victim < 0 ||
          (old && !victimOld) ||
          (old === victimOld && page.lastUsed < pages[victim]!.lastUsed)
        ) {
          victim = index;
          victimOld = old;
        }
      }
      if (victim < 0) {
        if (pages.some((page) => [...page.keys].some((key) => !usedKeys.has(key)))) {
          fragmented = true;
        } else {
          full = true;
        }
        return null;
      }
      for (const key of pages[victim]!.keys) {
        const entry = added.get(key);
        if (entry !== undefined) {
          added.delete(key);
          addedBases.get(entry.base)?.delete(key);
        }
      }
      evict(victim);
      return fit(victim);
    };

    requests.forEach((request, index) => {
      if (resolutions[index] !== undefined) return;
      const key = keys[index]!;
      // The same key twice in a frame is rasterized once.
      const known = lookup(key);
      if (known !== undefined) {
        used.add(known.page);
        usedKeys.add(known.key);
        resolutions[index] = Object.freeze({ kind: 'entry', entry: known, fallback: false });
        return;
      }
      const outcome = this.#outcomes.get(key);
      if (outcome !== undefined) {
        if (outcome.status === 'failed') this.#reportFailure(request, outcome.reason!);
        resolutions[index] = Object.freeze({ kind: outcome.status });
        return;
      }
      if (full || omittedKeys.has(key)) {
        omitted += 1;
        firstOmitted ??= request.nodeId;
        resolutions[index] = Object.freeze({ kind: 'omitted' });
        return;
      }
      const defer = () => {
        deferred += 1;
        const fallback = this.#fallback(request, lookup, addedBases);
        if (fallback !== null) {
          used.add(fallback.page);
          usedKeys.add(fallback.key);
        }
        resolutions[index] = Object.freeze(
          fallback === null
            ? { kind: 'deferred' }
            : { kind: 'entry', entry: fallback, fallback: true },
        );
      };
      if (fragmented) {
        fragmentDeferred.push(index);
        defer();
        return;
      }
      if (calls >= E28_RASTER_PER_FRAME) {
        defer();
        return;
      }
      calls += 1;
      this.#rasterCalls += 1;
      const result = this.#rasterize(request);
      if (result.status === 'empty' || result.status === 'failed') {
        if (this.#outcomes.size >= OUTCOMES_MAX) this.#outcomes.clear();
        this.#outcomes.set(
          key,
          Object.freeze(
            result.status === 'empty'
              ? { generation: request.generation, status: 'empty' as const }
              : {
                  generation: request.generation,
                  status: 'failed' as const,
                  reason: result.reason,
                },
          ),
        );
        if (result.status === 'failed') this.#reportFailure(request, result.reason);
        resolutions[index] = Object.freeze({ kind: result.status });
        return;
      }
      const place = allocate(result.width, result.height);
      if (place === null && fragmented) {
        // The miss that finds the pages fragmented has spent its port call; its bitmap is
        // dropped and rasterized again after the compaction.
        fragmentDeferred.push(index);
        defer();
        return;
      }
      if (place === null) {
        omitted += 1;
        firstOmitted ??= request.nodeId;
        omittedKeys.add(key);
        resolutions[index] = Object.freeze({ kind: 'omitted' });
        return;
      }
      const base = baseKey(request);
      const entry: AtlasEntry = Object.freeze({
        key,
        base,
        page: place.page,
        x: place.x,
        y: place.y,
        width: result.width,
        height: result.height,
        left: result.left,
        top: result.top,
        bucket: request.bucket,
        phaseX: request.phaseX,
        generation: request.generation,
      });
      addKey(place.page, key);
      added.set(key, entry);
      usedKeys.add(key);
      const list = addedBases.get(base);
      if (list === undefined) addedBases.set(base, new Set([key]));
      else list.add(key);
      used.add(place.page);
      uploads.push(
        Object.freeze({
          page: place.page,
          x: place.x,
          y: place.y,
          width: result.width,
          height: result.height,
          coverage: result.coverage,
        }),
      );
      resolutions[index] = Object.freeze({ kind: 'entry', entry, fallback: false });
    });

    // Section 4, Compaction: the page with the most stale area (entries this frame does not draw,
    // its fallbacks included), the lowest index on a tie. When the frame's later lookups used
    // every stale entry, nothing can be freed: the fragmentation deferrals become omissions
    // (step 3), drawn fallbacks included.
    let compactNext: number | null = null;
    if (fragmented) {
      let most = 0;
      pages.forEach((page, index) => {
        let area = 0;
        for (const key of page.keys) {
          if (usedKeys.has(key)) continue;
          const entry = added.get(key) ?? this.#entries.get(key);
          if (entry !== undefined) area += entry.width * entry.height;
        }
        if (area > most) {
          most = area;
          compactNext = index;
        }
      });
      if (compactNext === null) {
        for (const index of fragmentDeferred) {
          resolutions[index] = Object.freeze({ kind: 'omitted' });
          deferred -= 1;
          omitted += 1;
          firstOmitted ??= requests[index]!.nodeId;
        }
      }
    }

    // E28-D2: raised on the transition into the over-limit state; cleared by a frame that draws
    // every cluster (none omitted and none deferred).
    if (omitted > 0 && !this.#overLimit) {
      this.#queue(
        Object.freeze({
          code: 'text-resource-limit',
          nodeId: firstOmitted!,
          omitted,
          pages: this.#pagesMax,
        }),
      );
    }
    if (omitted > 0) this.#overLimit = true;
    else if (deferred === 0) this.#overLimit = false;
    return Object.freeze({
      rendererGeneration,
      frame,
      pageCount: pages.length,
      clears: Object.freeze(clears),
      uploads: Object.freeze(uploads),
      resolutions: Object.freeze(resolutions as AtlasResolution[]),
      deferred,
      omitted,
      pages: Object.freeze(pages),
      added,
      evicted,
      used,
      evictions,
      compacted,
      compactNext,
    });
  }

  /** True when the receipt's text part matches the frame: page count, clears and uploads. */
  public validateReceipt(frame: AtlasFrame, receipt: TextReceiptPart | undefined): boolean {
    return (
      receipt !== undefined &&
      typeof receipt === 'object' &&
      Array.isArray(receipt.pages) &&
      receipt.pages.length === frame.pageCount &&
      receipt.pages.every((incarnation) => typeof incarnation === 'symbol') &&
      receipt.clears === frame.clears.length &&
      receipt.uploads === frame.uploads.length
    );
  }

  /**
   * Commits a frame whose packet was acknowledged, after `validateReceipt`. Returns true when
   * entries were lost to a changed page incarnation, so the frame must be drawn again.
   */
  public acknowledge(frame: AtlasFrame, receipt: TextReceiptPart): boolean {
    if (frame.rendererGeneration !== this.#rendererGeneration) return false;
    for (const page of frame.evicted) this.#dropPage(page);
    let lost = false;
    const pages = frame.pages.map((page, index) => {
      const incarnation = receipt.pages[index]!;
      let next = page;
      if (page.incarnation !== null && page.incarnation !== incarnation) {
        // The backend recreated the page: only this packet's uploads are in it.
        const kept = new Set<string>();
        for (const key of page.keys) {
          if (frame.added.has(key)) kept.add(key);
          else if (this.#entries.has(key)) {
            this.#removeEntry(key);
            lost = true;
          }
        }
        next = { ...next, keys: kept };
      }
      return Object.freeze({
        ...next,
        incarnation,
        lastUsed: frame.used.has(index) ? frame.frame : page.lastUsed,
      });
    });
    for (let index = pages.length; index < this.#pages.length; index += 1) this.#dropPage(index);
    this.#pages = pages;
    for (const entry of frame.added.values()) {
      if (entry.page >= pages.length || !pages[entry.page]!.keys.has(entry.key)) continue;
      this.#entries.set(entry.key, entry);
      const list = this.#bases.get(entry.base);
      if (list === undefined) this.#bases.set(entry.base, new Set([entry.key]));
      else list.add(entry.key);
    }
    this.#uploads += frame.uploads.length;
    this.#evictions += frame.evictions;
    // A frame that compacted consumed the request; a fragmented frame makes a new one.
    if (frame.compacted !== null || frame.pageCount === 0) this.#compactNext = null;
    if (frame.compactNext !== null) this.#compactNext = frame.compactNext;
    return lost;
  }

  /**
   * A frame whose packet was replaced without acknowledgement: the backend may have written to
   * the pages it cleared or uploaded to, so their entries are dropped and the pages are cleared
   * before their next allocation.
   */
  public replaced(frame: AtlasFrame): void {
    if (frame.rendererGeneration !== this.#rendererGeneration) return;
    const written = new Set([
      ...frame.clears.map((clear) => clear.page),
      ...frame.uploads.map((upload) => upload.page),
    ]);
    for (const index of written) {
      if (index >= this.#pages.length) continue;
      this.#dropPage(index);
      this.#pages[index] = Object.freeze({
        ...EMPTY_PAGE,
        dirty: true,
        lastUsed: this.#pages[index]!.lastUsed,
        incarnation: this.#pages[index]!.incarnation,
      });
    }
  }

  #dropPage(index: number): void {
    const page = this.#pages[index];
    if (page === undefined) return;
    for (const key of page.keys) this.#removeEntry(key);
  }

  #removeEntry(key: string): void {
    const entry = this.#entries.get(key);
    if (entry === undefined) return;
    this.#entries.delete(key);
    const list = this.#bases.get(entry.base);
    list?.delete(key);
    if (list?.size === 0) this.#bases.delete(entry.base);
  }

  #observeGeneration(generation: number): void {
    if (generation <= this.#newestGeneration) return;
    this.#newestGeneration = generation;
    for (const [key, outcome] of this.#outcomes) {
      if (outcome.generation < generation) this.#outcomes.delete(key);
    }
    for (const key of this.#failuresReported) {
      if (Number(key.slice(key.lastIndexOf('\u0000') + 1)) < generation) {
        this.#failuresReported.delete(key);
      }
    }
  }

  /** True when every entry of the page is of a layout generation below the newest one seen. */
  #holdsOnlyOlder(page: AtlasPage, added: ReadonlyMap<string, AtlasEntry>): boolean {
    if (page.keys.size === 0) return false;
    for (const key of page.keys) {
      const entry = added.get(key) ?? this.#entries.get(key);
      if (entry === undefined || entry.generation >= this.#newestGeneration) return false;
    }
    return true;
  }

  /**
   * Section 4, Raster budget: an entry whose key differs only in bucket and phase, the nearest
   * bucket (the smaller on a tie), then phase 0, then the smaller phase.
   */
  #fallback(
    request: AtlasRequest,
    lookup: (key: string) => AtlasEntry | undefined,
    addedBases: ReadonlyMap<string, ReadonlySet<string>>,
  ): AtlasEntry | null {
    const base = baseKey(request);
    let best: AtlasEntry | null = null;
    const consider = (key: string) => {
      const entry = lookup(key);
      if (entry === undefined) return;
      if (best === null || compareFallback(entry, best, request.bucket) < 0) best = entry;
    };
    for (const key of this.#bases.get(base) ?? []) consider(key);
    for (const key of addedBases.get(base) ?? []) consider(key);
    return best;
  }

  #rasterize(request: AtlasRequest):
    | Readonly<{
        status: 'ok';
        width: number;
        height: number;
        left: number;
        top: number;
        coverage: Uint8Array;
      }>
    | Readonly<{ status: 'empty' }>
    | Readonly<{ status: 'failed'; reason: TextFailureReason }> {
    let result: GlyphRasterResult;
    try {
      result = this.#port.rasterize(
        Object.freeze({
          text: request.text,
          fontList: request.fontList,
          lang: request.lang,
          pixelSize: request.bucket,
          phaseX: request.phaseX,
        }),
      );
    } catch {
      return { status: 'failed', reason: 'threw' };
    }
    // A port throw or a malformed result is caught here (section 4, Port failures); it never
    // fails the packet.
    if (typeof result !== 'object' || result === null) {
      return { status: 'failed', reason: 'threw' };
    }
    if (result.status === 'empty') return { status: 'empty' };
    if (result.status === 'failed') {
      return {
        status: 'failed',
        reason: result.reason === 'too-large' ? 'too-large' : 'unavailable',
      };
    }
    if (result.status !== 'ok') return { status: 'failed', reason: 'threw' };
    const { width, height, left, top, coverage } = result;
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      !Number.isSafeInteger(left) ||
      !Number.isSafeInteger(top) ||
      !(coverage instanceof Uint8Array) ||
      coverage.length !== width * height
    ) {
      return { status: 'failed', reason: 'threw' };
    }
    if (width > BITMAP_EDGE_MAX || height > BITMAP_EDGE_MAX) {
      return { status: 'failed', reason: 'too-large' };
    }
    return { status: 'ok', width, height, left, top, coverage: coverage.slice() };
  }

  /** E28-D3: once per node, reason and layout generation. */
  #reportFailure(request: AtlasRequest, reason: TextFailureReason): void {
    const key = `${request.nodeId}\u0000${reason}\u0000${request.generation}`;
    if (this.#failuresReported.has(key)) return;
    this.#failuresReported.add(key);
    this.#queue(Object.freeze({ code: 'glyph-raster-failure', nodeId: request.nodeId, reason }));
  }

  #queue(notice: TextNotice): void {
    if (this.#notices.length < NOTICES_QUEUED) this.#notices.push(notice);
    else this.#noticesDropped += 1;
  }
}

function baseKey(request: AtlasRequest): string {
  return JSON.stringify([request.generation, request.lang, request.fontList, request.text]);
}

function compareFallback(left: AtlasEntry, right: AtlasEntry, bucket: number): number {
  const distance = Math.abs(left.bucket - bucket) - Math.abs(right.bucket - bucket);
  if (distance !== 0) return distance;
  if (left.bucket !== right.bucket) return left.bucket - right.bucket;
  if ((left.phaseX === 0) !== (right.phaseX === 0)) return left.phaseX === 0 ? -1 : 1;
  return left.phaseX - right.phaseX;
}

function fullPageClear(page: number, size: number): TextClear {
  return Object.freeze({ page, x: 0, y: 0, width: size, height: size });
}

/** Shelf packing with a 1 px gutter; null when the bitmap fits no shelf and no new shelf. */
function placeOnPage(
  page: AtlasPage,
  width: number,
  height: number,
  size: number,
): Readonly<{ page: AtlasPage; x: number; y: number }> | null {
  if (width > size || height > size) return null;
  const shelves = page.shelves;
  for (let index = 0; index < shelves.length; index += 1) {
    const shelf = shelves[index]!;
    if (shelf.height < height || shelf.x + width > size) continue;
    const next = [...shelves];
    next[index] = Object.freeze({ ...shelf, x: shelf.x + width + GUTTER });
    return {
      page: Object.freeze({ ...page, shelves: Object.freeze(next), dirty: false }),
      x: shelf.x,
      y: shelf.y,
    };
  }
  if (page.bottom + height > size) return null;
  const shelf = Object.freeze({ y: page.bottom, height, x: width + GUTTER });
  return {
    page: Object.freeze({
      ...page,
      shelves: Object.freeze([...shelves, shelf]),
      bottom: page.bottom + height + GUTTER,
      dirty: false,
    }),
    x: 0,
    y: page.bottom,
  };
}

/** A visible text leaf, in paint order. */
export type TextLeaf = Readonly<{
  id: string;
  node: Extract<RenderNodeSnapshot, { kind: 'text' }>;
  world: SceneAffine;
}>;
/** One draw of a text leaf: consecutive instances on one page. */
export type TextLeafDraw = Readonly<{ first: number; count: number; page: number }>;
export type TextFrame = Readonly<{
  atlas: AtlasFrame;
  /** `TEXT_INSTANCE_FLOATS` floats per drawn cluster. */
  instances: Float32Array;
  /** Per leaf, its draws in cluster order; empty when nothing of it is drawn. */
  draws: readonly (readonly TextLeafDraw[])[];
}>;

type Placed = Readonly<{
  leaf: number;
  map: SceneAffine;
  ox: number;
  oy: number;
  size: number;
  snapped: boolean;
  px: number;
  py: number;
  color: readonly [number, number, number, number];
}>;

/**
 * Section 4: places every visible cluster (E28-K1 to K3), resolves it through the atlas and
 * builds the instance records. A cluster with `s < 0.5` or whose E28-K9 bound misses the target
 * draws nothing and reaches no port.
 */
export function planTextFrame(
  atlas: GlyphAtlasPlan,
  leaves: readonly TextLeaf[],
  holdsText: boolean,
  camera: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
  target: Readonly<{ generation: number; width: number; height: number; devicePixelRatio: number }>,
): TextFrame {
  const requests: AtlasRequest[] = [];
  const placed: Placed[] = [];
  // The 2 px guard of primitive culling.
  const guard = 2;
  leaves.forEach((leaf, leafIndex) => {
    const map = textDeviceMap(leaf.world, camera, target.devicePixelRatio);
    const [a, b, c, d, e, f] = map;
    const sigma = Math.sqrt(Math.abs(a * d - b * c));
    const uniform = isUniformScale(map, sigma);
    const opacity = leaf.node.opacity;
    for (const run of leaf.node.runs) {
      const size = run.size * sigma;
      if (!(size >= 0.5)) continue;
      const bucket = sizeBucket(size);
      const snapped = uniform && size <= E28_RASTER_CAP;
      const alpha = run.color.a * opacity;
      const color = [run.color.r * alpha, run.color.g * alpha, run.color.b * alpha, alpha] as const;
      for (const cluster of run.clusters) {
        const bound = clusterLocalBounds(cluster, run.size);
        if (!deviceBoundMeets(map, bound, target.width, target.height, guard)) continue;
        const ox = a * cluster.x + c * cluster.y + e;
        const oy = b * cluster.x + d * cluster.y + f;
        const snap = snapped ? snappedPlacement(ox, oy) : null;
        requests.push(
          Object.freeze({
            nodeId: leaf.id,
            generation: leaf.node.generation,
            lang: leaf.node.lang,
            fontList: run.fontList,
            text: cluster.text,
            bucket,
            phaseX: snap?.phaseX ?? 0,
          }),
        );
        placed.push({
          leaf: leafIndex,
          map,
          ox,
          oy,
          size: run.size,
          snapped,
          px: snap?.px ?? 0,
          py: snap?.py ?? 0,
          color,
        });
      }
    }
  });
  const frame = atlas.plan(target.generation, requests, holdsText);
  const records: number[] = [];
  const draws: TextLeafDraw[][] = leaves.map(() => []);
  frame.resolutions.forEach((resolution, index) => {
    if (resolution.kind !== 'entry') return;
    const entry = resolution.entry;
    const cluster = placed[index]!;
    const first = records.length / TEXT_INSTANCE_FLOATS;
    if (cluster.snapped && !resolution.fallback) {
      // E28-K3, snapped: the bitmap unscaled on whole pixels.
      records.push(
        cluster.px - entry.left,
        cluster.py - entry.top,
        entry.width,
        0,
        0,
        entry.height,
      );
    } else {
      // E28-K3, general: bitmap point u maps to o + (size / b) · M_lin · (u − (left + phaseX, top)).
      const [a, b, c, d] = cluster.map;
      const scale = cluster.size / entry.bucket;
      const ux = -(entry.left + entry.phaseX);
      const uy = -entry.top;
      records.push(
        cluster.ox + scale * (a * ux + c * uy),
        cluster.oy + scale * (b * ux + d * uy),
        scale * a * entry.width,
        scale * b * entry.width,
        scale * c * entry.height,
        scale * d * entry.height,
      );
    }
    const general = !cluster.snapped || resolution.fallback;
    records.push(
      entry.x,
      entry.y,
      entry.width,
      entry.height,
      entry.page,
      general ? 1 : 0,
      ...cluster.color,
    );
    const list = draws[cluster.leaf]!;
    const last = list.at(-1);
    if (last !== undefined && last.page === entry.page && last.first + last.count === first) {
      list[list.length - 1] = { ...last, count: last.count + 1 };
    } else {
      list.push({ first, count: 1, page: entry.page });
    }
  });
  return Object.freeze({
    atlas: frame,
    instances: new Float32Array(records),
    draws: Object.freeze(
      draws.map((list) => Object.freeze(list.map((draw) => Object.freeze(draw)))),
    ),
  });
}

/** True when the device image of a local bound meets the target widened by `guard` px. */
function deviceBoundMeets(
  map: SceneAffine,
  bound: SceneBounds,
  width: number,
  height: number,
  guard: number,
): boolean {
  const [a, b, c, d, e, f] = map;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of [
    [bound.minX, bound.minY],
    [bound.maxX, bound.minY],
    [bound.maxX, bound.maxY],
    [bound.minX, bound.maxY],
  ] as const) {
    const dx = a * x + c * y + e;
    const dy = b * x + d * y + f;
    minX = Math.min(minX, dx);
    maxX = Math.max(maxX, dx);
    minY = Math.min(minY, dy);
    maxY = Math.max(maxY, dy);
  }
  return maxX >= -guard && minX <= width + guard && maxY >= -guard && minY <= height + guard;
}
