import type { RenderNodeSnapshot, SceneAffine } from '@vector-studio/contracts';
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

export type ClipStateRecord = Readonly<{
  /** 1-based; 0 is the unclipped state and has no record. */
  index: number;
  chainKey: string;
  rects: readonly Readonly<{ toLocal: SceneAffine; width: number; height: number }>[];
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
      rects: Object.freeze(
        chain.levels
          .filter((level): level is ClipRectLevel => level.kind === 'rect')
          .map((level) =>
            Object.freeze({ toLocal: level.toLocal, width: level.width, height: level.height }),
          ),
      ),
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
  if (source === undefined || source.kind === 'container') return null;
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
