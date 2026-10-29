import {
  DIAGNOSTIC_CODES,
  type DiagnosticInput,
  type RenderNodeSnapshot,
  type SceneAffine,
} from '@vector-studio/contracts';
import { invertAffine } from './camera.js';
import {
  getPathLocalPointBounds,
  transformSceneBounds,
  type SceneBounds,
} from './scene-numeric.js';

/**
 * P4 contract (docs/plans/p4-clip-mask.md), unit U2: clip chains, their culling bounds and the
 * per-frame clip-state table. Pure CPU data; the GPU layout belongs to U3 and U4.
 */

/** A rect level: `toLocal` maps world space to the clip rectangle's frame, origin at (x, y). */
export type ClipRectLevel = Readonly<{
  kind: 'rect';
  containerId: string;
  toLocal: SceneAffine;
  width: number;
  height: number;
}>;
/** A mask level: the source is `children[0]`, or null for an empty mask container. */
export type ClipMaskLevel = Readonly<{
  kind: 'mask';
  containerId: string;
  world: SceneAffine;
  sourceId: string | null;
}>;
export type ClipLevel = ClipRectLevel | ClipMaskLevel;

/**
 * The clipping ancestors of a node, outermost first. `bounds` holds each level's world bound
 * (P4-K5); the camera-dependent 1 px coverage widening is applied per level when culling, so
 * two levels a sub-pixel gap apart never cull a sliver their coverage product still draws.
 * `empty` has structural causes only: P4-S1 zero size, P4-K2b singular affine, or an empty or
 * line mask source.
 */
export type ClipChain = Readonly<{
  key: string;
  levels: readonly ClipLevel[];
  bounds: readonly SceneBounds[];
  empty: boolean;
}>;

/** Extends `parent` by a clipping container with world affine `world`; null when unclipped. */
export function extendClipChain(
  parent: ClipChain | null,
  container: Extract<RenderNodeSnapshot, { kind: 'container' }>,
  world: SceneAffine,
  source: RenderNodeSnapshot | undefined,
  sourceWorld: SceneAffine | null,
): ClipChain | null {
  const clip = container.clip;
  if (clip === null) return parent;
  const levels = [...(parent?.levels ?? [])];
  let bound: SceneBounds | null = null;
  const singular = world[0] * world[3] - world[1] * world[2] === 0;
  if (clip.kind === 'rect') {
    const toLocal = singular ? null : rectToLocal(world, clip.x, clip.y);
    levels.push(
      Object.freeze({
        kind: 'rect',
        containerId: container.id,
        toLocal: toLocal ?? ([0, 0, 0, 0, 0, 0] as const),
        width: clip.width,
        height: clip.height,
      }),
    );
    if (toLocal !== null && clip.width !== 0 && clip.height !== 0) {
      bound = transformSceneBounds(
        { minX: clip.x, minY: clip.y, maxX: clip.x + clip.width, maxY: clip.y + clip.height },
        world,
      );
    }
  } else {
    levels.push(
      Object.freeze({
        kind: 'mask',
        containerId: container.id,
        world,
        sourceId: source?.id ?? null,
      }),
    );
    bound = singular || sourceWorld === null ? null : maskSourceBounds(source, sourceWorld);
  }
  return Object.freeze({
    // Length-prefixed ids, so no two different chains share a key whatever the ids contain.
    key: `${parent?.key ?? ''}${container.id.length}:${container.id};`,
    levels: Object.freeze(levels),
    bounds: Object.freeze(bound === null ? [] : [...(parent?.bounds ?? []), bound]),
    empty: (parent?.empty ?? false) || bound === null,
  });
}

/** P4-K5: true when `bounds` meets every level's bound widened by `guard` world units. */
export function meetsClipChain(
  bounds: SceneBounds,
  chain: ClipChain | null,
  guard: number,
): boolean {
  if (chain === null) return true;
  if (chain.empty) return false;
  return chain.bounds.every(
    (clip) =>
      bounds.maxX >= clip.minX - guard &&
      bounds.minX <= clip.maxX + guard &&
      bounds.maxY >= clip.minY - guard &&
      bounds.minY <= clip.maxY + guard,
  );
}

export type ClipRectRecord = Readonly<{ toLocal: SceneAffine; width: number; height: number }>;

export type ClipStateRecord = Readonly<{
  /** 1-based; 0 is the unclipped state and has no record. */
  index: number;
  chainKey: string;
  /**
   * The rect levels inside the innermost mask level (all of them without a mask level), outermost
   * first. U4: the levels outside it are already in that mask level's texture.
   */
  rects: readonly ClipRectRecord[];
  /** The mask containers of the chain, outermost first; the content draw reads the last. */
  masks: readonly string[];
}>;

/**
 * The frame's clip states. A chain keeps its index for as long as it stays drawn, and a new
 * chain takes the lowest free index, so a state appearing or disappearing elsewhere renumbers
 * nothing. `writes` counts records whose index slot changed content against the previous
 * frame (P4-A06: only changed clip-state records are written). Records are in index order;
 * indices may have gaps.
 */
export class ClipStateTable {
  #indexByKey = new Map<string, number>();
  #taken = new Set<number>();
  #contentByIndex = new Map<number, string>();
  #frame = new Map<string, ClipStateRecord>();
  #writes = 0;

  public begin(): void {
    this.#frame = new Map();
  }

  /** The state index of a drawn draw under `chain`; 0 when unclipped. */
  public stateOf(chain: ClipChain | null): number {
    if (chain === null) return 0;
    const drawn = this.#frame.get(chain.key);
    if (drawn !== undefined) return drawn.index;
    let index = this.#indexByKey.get(chain.key);
    if (index === undefined) {
      index = 1;
      while (this.#taken.has(index)) index += 1;
      this.#indexByKey.set(chain.key, index);
      this.#taken.add(index);
    }
    const record: ClipStateRecord = Object.freeze({
      index,
      chainKey: chain.key,
      rects: rectRecords(chain.levels, innermostMask(chain.levels) + 1, chain.levels.length),
      masks: Object.freeze(
        chain.levels.filter((level) => level.kind === 'mask').map((level) => level.containerId),
      ),
    });
    this.#frame.set(chain.key, record);
    return index;
  }

  /** Ends the frame: releases undrawn chains, returns the records and counts changed ones. */
  public end(): readonly ClipStateRecord[] {
    for (const [key, index] of [...this.#indexByKey]) {
      if (this.#frame.has(key)) continue;
      this.#indexByKey.delete(key);
      this.#taken.delete(index);
    }
    const records = [...this.#frame.values()].sort((left, right) => left.index - right.index);
    const contents = new Map<number, string>();
    for (const record of records) {
      const content = recordContent(record);
      contents.set(record.index, content);
      if (this.#contentByIndex.get(record.index) !== content) this.#writes += 1;
    }
    this.#contentByIndex = contents;
    return Object.freeze(records);
  }

  public get writes(): number {
    return this.#writes;
  }
}

/** The index of the chain's innermost mask level, or -1. */
function innermostMask(levels: readonly ClipLevel[]): number {
  for (let index = levels.length - 1; index >= 0; index -= 1) {
    if (levels[index]!.kind === 'mask') return index;
  }
  return -1;
}

/** The rect records of `levels[start..end)`, outermost first. */
function rectRecords(levels: readonly ClipLevel[], start: number, end: number) {
  return Object.freeze(
    levels
      .slice(start, end)
      .filter((level): level is ClipRectLevel => level.kind === 'rect')
      .map((level) =>
        Object.freeze({ toLocal: level.toLocal, width: level.width, height: level.height }),
      ),
  );
}

/** P4 section 4, Resources (P4-Q5): the resident mask texture budget. */
export const P4_MASK_TEXTURE_BYTES_MAX = 64 * 1024 * 1024;

/** E22-K1: the mask pass tile edge; a frame's tile set is at most this square. */
export const P4_MASK_TILE_SIZE = 1024;

/**
 * E22-K1 and K3: the tile set's extent over mask levels of at most `maxWidth × maxHeight`, and
 * its bytes: colour, resolve and stencil tiles at 4x (4 + 1 + 4 bytes per pixel), colour and
 * stencil at 1x (1 + 1).
 */
export function maskTileSet(
  maxWidth: number,
  maxHeight: number,
  sampleCount: 1 | 4,
): Readonly<{ width: number; height: number; bytes: number }> {
  const width = Math.min(P4_MASK_TILE_SIZE, maxWidth);
  const height = Math.min(P4_MASK_TILE_SIZE, maxHeight);
  return Object.freeze({ width, height, bytes: width * height * (sampleCount === 4 ? 9 : 2) });
}

/** A mask level's source, as the GPU draws it into the level's texture (P4-K2). */
export type MaskSourceRecord =
  Readonly<{ kind: 'primitive'; slot: number }> | Readonly<{ kind: 'mesh'; nodeId: string }>;

/**
 * One mask level of the frame (P4 section 4, Mask coverage textures). Its texture covers
 * `device` (whole physical pixels inside the target) and holds the source's fill coverage times
 * `rects` (the rect levels between `parent` and this level) times the parent level's texture.
 * `key` changes exactly when the texture's content may change (Mask cache).
 */
export type MaskLevelRecord = Readonly<{
  id: string;
  parent: string | null;
  rects: readonly ClipRectRecord[];
  device: Readonly<{ x: number; y: number; width: number; height: number }>;
  source: MaskSourceRecord;
  key: string;
}>;

export type MaskBudgetNotice = Readonly<{ nodeId: string; bytes: number; limit: number }>;

/** P4 contract, section 5: the `render.clip-resource-limit` diagnostic of a budget notice. */
export function clipResourceLimitDiagnostic(
  notice: MaskBudgetNotice,
  generation: number,
): DiagnosticInput {
  return Object.freeze({
    code: DIAGNOSTIC_CODES.CLIP_RESOURCE_LIMIT,
    severity: 'warning',
    message: `Mask ${notice.nodeId} is not drawn: its mask textures need ${notice.bytes} bytes over the ${notice.limit}-byte budget.`,
    generation,
    context: Object.freeze({ nodeId: notice.nodeId, bytes: notice.bytes, limit: notice.limit }),
  });
}

export type MaskPlanInput = Readonly<{
  /** Each level's source and its content key; null when it covers nothing (P4-K2). */
  sourceOf: (level: ClipMaskLevel) => Readonly<{ source: MaskSourceRecord; key: string }> | null;
  camera: Readonly<{ x: number; y: number; zoom: number }>;
  target: Readonly<{ width: number; height: number; devicePixelRatio: number; sampleCount: 1 | 4 }>;
  budget?: number;
}>;

/**
 * Plans the frame's mask levels over the drawn content chains, in paint order. A level is
 * drawable when its parent is, its culled device bound is not empty, its source covers
 * something, and the resident textures plus one tile set over the drawable levels (E22-K3) stay
 * within the budget;
 * a level over the budget is reported once per frame. A chain is drawable exactly when each of
 * its mask levels is.
 */
export class MaskPlan {
  readonly #input: MaskPlanInput;
  readonly #levels = new Map<string, MaskLevelRecord | null>();
  readonly #order: MaskLevelRecord[] = [];
  readonly #notices: MaskBudgetNotice[] = [];
  #resident = 0;
  #maxWidth = 0;
  #maxHeight = 0;

  public constructor(input: MaskPlanInput) {
    this.#input = input;
  }

  /** Plans the chain's levels if needed; true when content under the chain may draw. */
  public admit(chain: ClipChain | null): boolean {
    if (chain === null) return true;
    let parent: MaskLevelRecord | null = null;
    let parentIndex = -1;
    for (const [index, level] of chain.levels.entries()) {
      if (level.kind !== 'mask') continue;
      let record = this.#levels.get(level.containerId);
      if (record === undefined) {
        record = this.#plan(chain, index, level, parent, parentIndex);
        this.#levels.set(level.containerId, record);
        if (record !== null) this.#order.push(record);
      }
      if (record === null) return false;
      parent = record;
      parentIndex = index;
    }
    return true;
  }

  /** The drawable levels, each after its parent. */
  public get levels(): readonly MaskLevelRecord[] {
    return this.#order;
  }

  public get notices(): readonly MaskBudgetNotice[] {
    return this.#notices;
  }

  #plan(
    chain: ClipChain,
    index: number,
    level: ClipMaskLevel,
    parent: MaskLevelRecord | null,
    parentIndex: number,
  ): MaskLevelRecord | null {
    if (parentIndex >= 0 && parent === null) return null;
    const { camera, target } = this.#input;
    const scale = camera.zoom * target.devicePixelRatio;
    // P4-K5: every level up to this one bounds the texture, widened for the coverage ramp.
    const guard = 2 / scale;
    let minX = 0;
    let minY = 0;
    let maxX = target.width;
    let maxY = target.height;
    for (const bound of chain.bounds.slice(0, index + 1)) {
      minX = Math.max(minX, Math.floor((bound.minX - guard - camera.x) * scale));
      minY = Math.max(minY, Math.floor((bound.minY - guard - camera.y) * scale));
      maxX = Math.min(maxX, Math.ceil((bound.maxX + guard - camera.x) * scale));
      maxY = Math.min(maxY, Math.ceil((bound.maxY + guard - camera.y) * scale));
    }
    if (!(maxX > minX && maxY > minY)) return null;
    const source = this.#input.sourceOf(level);
    if (source === null) return null;
    const width = maxX - minX;
    const height = maxY - minY;
    const limit = this.#input.budget ?? P4_MASK_TEXTURE_BYTES_MAX;
    // E22-K3: the resident r8unorm textures, and the frame's one tile set of transient
    // attachments, sized over every drawable level.
    const resident = this.#resident + width * height;
    const maxWidth = Math.max(this.#maxWidth, width);
    const maxHeight = Math.max(this.#maxHeight, height);
    const bytes = resident + maskTileSet(maxWidth, maxHeight, target.sampleCount).bytes;
    if (bytes > limit) {
      this.#notices.push(Object.freeze({ nodeId: level.containerId, bytes, limit }));
      return null;
    }
    this.#resident = resident;
    this.#maxWidth = maxWidth;
    this.#maxHeight = maxHeight;
    const rects = rectRecords(chain.levels, parentIndex + 1, index);
    const device = Object.freeze({ x: minX, y: minY, width, height });
    return Object.freeze({
      id: level.containerId,
      parent: parent?.id ?? null,
      rects,
      device,
      source: source.source,
      key: JSON.stringify([
        parent?.key ?? null,
        rects,
        device,
        source.key,
        camera,
        target.devicePixelRatio,
        target.width,
        target.height,
        target.sampleCount,
      ]),
    });
  }
}

function recordContent(record: ClipStateRecord): string {
  return JSON.stringify([record.chainKey, record.rects, record.masks]);
}

function rectToLocal(world: SceneAffine, x: number, y: number): SceneAffine | null {
  try {
    const [a, b, c, d, e, f] = invertAffine(world);
    return Object.freeze([a, b, c, d, e - x, f - y]);
  } catch {
    return null;
  }
}

/** P4-S2: the source's fill area bound; null when it fills nothing (none, line, empty path). */
function maskSourceBounds(
  source: RenderNodeSnapshot | undefined,
  sourceWorld: SceneAffine,
): SceneBounds | null {
  // E28-S4: a text node is never a mask source, so it never reaches here.
  if (source === undefined || source.kind === 'container' || source.kind === 'text') return null;
  if (sourceWorld[0] * sourceWorld[3] - sourceWorld[1] * sourceWorld[2] === 0) return null;
  let local: SceneBounds | null;
  if (source.kind === 'path') {
    local = getPathLocalPointBounds(source.geometry.points);
  } else {
    if (source.geometry.kind === 'line') return null;
    const { width, height } = source.geometry;
    if (width === 0 || height === 0) return null;
    local = { minX: 0, minY: 0, maxX: width, maxY: height };
  }
  return local === null ? null : transformSceneBounds(local, sourceWorld);
}
