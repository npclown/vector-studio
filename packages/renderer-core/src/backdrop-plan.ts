import { DIAGNOSTIC_CODES, type DiagnosticInput } from '@vector-studio/contracts';
import { planEffectLayers, type EffectLayerPlan } from './effect-layers.js';
import {
  E25_LAYER_BYTES_MAX,
  type BlendRootMode,
  type DeviceRect,
  type LayerCamera,
  type LayerScope,
  type LayerTarget,
} from './layer-plan.js';
import type { SceneBounds } from './scene-numeric.js';

/**
 * V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), unit U4: the plan side of blend
 * roots and backdrop snapshots. A blend root (V35-K3) is a layer whose `R` is composited into
 * its parent target with its mode over a snapshot of that target (K4, K5); an isolating
 * container is a layer composited with source-over. This module plans which of them keep their
 * layer (K6 budget, the 64-root limit, K7), and counts the frame's backdrop splits (K4). Pure
 * CPU data; the snapshot and composite passes belong to `renderer-webgpu`.
 */

/** V35-K6: at most this many blend roots are drawn as blend roots per frame, in paint order. */
export const V35_BLEND_ROOTS_MAX = 64;

/** V35-K6: why a scope's V-35 layers were dropped. */
export type BlendResourceReason = 'budget' | 'count';

export type BlendResourceNotice = Readonly<{
  /** The layer tree's root (`budget`) or the blend root past the first 64 (`count`). */
  nodeId: string;
  /** The tree's bytes with its V-35 layers (`budget`); 0 for `count`. */
  bytes: number;
  limit: number;
  reason: BlendResourceReason;
}>;

/** E41's layer plan with V-35's blend roots: the drawn blend roots and the V-35 notices. */
export type BlendLayerPlan = EffectLayerPlan &
  Readonly<{
    /** The drawn blend roots and their modes (V35-K5). */
    blends: ReadonlyMap<LayerScope, BlendRootMode>;
    /** V35-K6: trees and blend roots whose V-35 layers were dropped this frame. */
    blendNotices: readonly BlendResourceNotice[];
  }>;

/** Whether a scope carries a V-35 layer request (a blend root or an isolating container). */
export function asksForBlendLayer(scope: LayerScope): boolean {
  return scope.blend !== undefined || scope.isolating === true;
}

/** A scope copy without its V-35 fields. */
function withoutBlend(scope: LayerScope): LayerScope {
  const copy: Partial<Record<keyof LayerScope, unknown>> = { ...scope };
  delete copy.blend;
  delete copy.backdrop;
  delete copy.isolating;
  return copy as LayerScope;
}

/**
 * The plan over scopes in which the V-35 requests of `dropped` are removed: a scope that is a
 * layer only for V-35 (`blendOnly`) dissolves into its nearest kept ancestor, with its content;
 * any other loses its mode and stays the E25 layer or effect root it also is. Planning runs on
 * copies whose `parent` is the nearest kept ancestor's copy, and maps back to the originals.
 */
function planWithout(
  scopes: readonly LayerScope[],
  content: ReadonlyMap<LayerScope, readonly SceneBounds[]>,
  camera: LayerCamera,
  target: LayerTarget,
  maxTextureDimension: number,
  dropped: ReadonlySet<LayerScope>,
): Readonly<{ plan: EffectLayerPlan; copies: ReadonlyMap<LayerScope, LayerScope> }> {
  const copies = new Map<LayerScope, LayerScope>();
  const originals = new Map<LayerScope, LayerScope>();
  const kept = (scope: LayerScope | null): LayerScope | null => {
    let next = scope;
    while (next !== null && !copies.has(next)) next = next.parent;
    return next === null ? null : copies.get(next)!;
  };
  const list: LayerScope[] = [];
  for (const scope of scopes) {
    const asks = asksForBlendLayer(scope);
    const removed = asks && dropped.has(scope);
    if (removed && scope.blendOnly === true) continue;
    const parent = kept(scope.parent);
    const copy: LayerScope = removed
      ? withoutBlend({ ...scope, parent, depth: parent === null ? 0 : parent.depth + 1 })
      : {
          ...scope,
          parent,
          depth: parent === null ? 0 : parent.depth + 1,
          // A V-35 layer stays a layer when its tree drops its effects (E41 section 5.4).
          ...(asks && scope.effects !== undefined ? { isolated: true } : {}),
        };
    copies.set(scope, copy);
    originals.set(copy, scope);
    list.push(copy);
  }
  const merged = new Map<LayerScope, SceneBounds[]>();
  for (const [scope, bounds] of content) {
    const owner = copies.get(scope) ?? kept(scope.parent);
    if (owner === null) continue;
    const entry = merged.get(owner);
    if (entry === undefined) merged.set(owner, [...bounds]);
    else entry.push(...bounds);
  }
  const plan = planEffectLayers(list, merged, camera, target, maxTextureDimension);
  const back = <T>(map: ReadonlyMap<LayerScope, T>): Map<LayerScope, T> =>
    new Map([...map].map(([copy, value]) => [originals.get(copy)!, value] as const));
  const states = back(plan.states);
  for (const scope of scopes) if (!copies.has(scope)) states.set(scope, 'dissolved');
  return {
    plan: Object.freeze({
      ...plan,
      states,
      bounds: back(plan.bounds),
      effects: back(plan.effects),
      rejected: back(plan.rejected),
    }),
    copies,
  };
}

/**
 * V35-K3, K6, K7: E41's layer plan (`planEffectLayers`) over scopes that may hold blend roots
 * and isolating containers. Without the blend pipeline (`available` false, K7) every V-35
 * request is dropped and no notice is raised. Otherwise the plan is repeated while it changes:
 *
 * - a layer tree that is not admitted whole and still holds V-35 requests drops all of them
 *   (one `budget` notice on its root), so its blend roots draw as `normal` and its isolating
 *   containers as `passThrough`, and the tree is planned again under E41's and E25's rules;
 * - drawn blend roots past the first 64 in paint order drop their mode (one `count` notice each).
 *
 * Each pass only adds to the dropped set, so the plan settles after at most one pass per tree
 * and per blend root.
 */
export function planBlendLayers(
  scopes: readonly LayerScope[],
  content: ReadonlyMap<LayerScope, readonly SceneBounds[]>,
  camera: LayerCamera,
  target: LayerTarget,
  maxTextureDimension: number,
  available: boolean,
): BlendLayerPlan {
  const dropped = new Set<LayerScope>();
  if (!available) for (const scope of scopes) if (asksForBlendLayer(scope)) dropped.add(scope);
  const notices: BlendResourceNotice[] = [];
  for (;;) {
    const { plan, copies } = planWithout(
      scopes,
      content,
      camera,
      target,
      maxTextureDimension,
      dropped,
    );
    let changed = false;
    // V35-K6, budget: trees not admitted whole that still ask for V-35 layers.
    const rootOf = (scope: LayerScope) => {
      let root = copies.get(scope)!;
      while (root.parent !== null) root = root.parent;
      return root;
    };
    const overBudget = new Set([...plan.rejected.keys()].map((scope) => copies.get(scope)!));
    const noticed = new Set<LayerScope>();
    for (const scope of scopes) {
      if (!copies.has(scope) || !asksForBlendLayer(scope) || dropped.has(scope)) continue;
      const root = rootOf(scope);
      if (!overBudget.has(root)) continue;
      dropped.add(scope);
      changed = true;
      if (noticed.has(root)) continue;
      noticed.add(root);
      const original = [...copies].find(([, copy]) => copy === root)![0];
      notices.push(
        Object.freeze({
          nodeId: original.nodeId,
          bytes: plan.rejected.get(original)!,
          limit: E25_LAYER_BYTES_MAX,
          reason: 'budget' as const,
        }),
      );
    }
    if (!changed) {
      // V35-K6, count: blend roots drawn as blend roots, in paint order (pre-order).
      let drawn = 0;
      for (const scope of scopes) {
        if (scope.blend === undefined || dropped.has(scope)) continue;
        if (plan.states.get(scope) !== 'drawn') continue;
        drawn += 1;
        if (drawn <= V35_BLEND_ROOTS_MAX) continue;
        dropped.add(scope);
        changed = true;
        notices.push(
          Object.freeze({
            nodeId: scope.nodeId,
            bytes: 0,
            limit: V35_BLEND_ROOTS_MAX,
            reason: 'count' as const,
          }),
        );
      }
    }
    if (changed) continue;
    const blends = new Map<LayerScope, BlendRootMode>();
    for (const scope of scopes) {
      if (scope.blend !== undefined && !dropped.has(scope) && plan.states.get(scope) === 'drawn') {
        blends.set(scope, scope.blend);
      }
    }
    return Object.freeze({ ...plan, blends, blendNotices: Object.freeze(notices) });
  }
}

/** One backdrop split (V35-K4): a pass ended and resumed around one snapshot. */
export type BackdropSplit = Readonly<{
  /** The blend root's index in the packet's `layers`. */
  layer: number;
  /** The parent target's tile the composite draws in, or -1 for the main pass. */
  tile: number;
  /** The snapshot rectangle in target pixels: the composite's bound inside that pass. */
  rect: DeviceRect;
}>;

/** What the split plan reads of a packet layer. */
export type BackdropLayer = Readonly<{
  parent: number;
  bound: DeviceRect;
  /** The composite's bound when it differs from `bound` (an effect root's `R`). */
  composite?: DeviceRect;
  backdrop?: Readonly<{ margin: number }>;
}>;

function intersect(left: DeviceRect, right: DeviceRect): DeviceRect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const right0 = Math.min(left.x + left.width, right.x + right.width);
  const bottom = Math.min(left.y + left.height, right.y + right.height);
  return x < right0 && y < bottom ? { x, y, width: right0 - x, height: bottom - y } : null;
}

/**
 * V35-K4: the frame's backdrop splits. A layer with a backdrop request composites once in the
 * main pass (one split) or once in each tile pass of its parent layer that its composite
 * reaches (one split per such tile). Tiles are laid out from the parent's bound origin in
 * steps of `tileWidth` × `tileHeight`, as the layer passes draw them (E25 section 4). The
 * snapshot covers the composite's bound grown by the margin, inside the pass's attachment.
 */
export function planBackdropSplits(
  layers: readonly BackdropLayer[],
  target: Readonly<{ width: number; height: number }>,
  tileWidth: number,
  tileHeight: number,
): readonly BackdropSplit[] {
  const splits: BackdropSplit[] = [];
  layers.forEach((layer, index) => {
    if (layer.backdrop === undefined) return;
    const composite = layer.composite ?? layer.bound;
    const margin = layer.backdrop.margin;
    const grown: DeviceRect = {
      x: composite.x - margin,
      y: composite.y - margin,
      width: composite.width + 2 * margin,
      height: composite.height + 2 * margin,
    };
    if (layer.parent === -1) {
      const rect = intersect(grown, { x: 0, y: 0, width: target.width, height: target.height });
      if (rect !== null) splits.push(Object.freeze({ layer: index, tile: -1, rect }));
      return;
    }
    const parent = layers[layer.parent]!.bound;
    let tile = 0;
    for (let y = 0; y < parent.height; y += tileHeight) {
      for (let x = 0; x < parent.width; x += tileWidth) {
        const region = {
          x: parent.x + x,
          y: parent.y + y,
          width: Math.min(tileWidth, parent.width - x),
          height: Math.min(tileHeight, parent.height - y),
        };
        // The composite draws only in tiles it reaches; its snapshot is taken from the tile.
        if (intersect(composite, region) !== null) {
          const rect = intersect(grown, region);
          if (rect !== null) splits.push(Object.freeze({ layer: index, tile, rect }));
        }
        tile += 1;
      }
    }
  });
  return Object.freeze(splits);
}

/** V35-K6: the `render.blend-resource-limit` diagnostic of a notice. */
export function blendResourceLimitDiagnostic(
  notice: BlendResourceNotice,
  generation: number,
): DiagnosticInput {
  const reason =
    notice.reason === 'count'
      ? `it is past the first ${notice.limit} blend roots of the frame`
      : `its layer tree needs ${notice.bytes} bytes over the ${notice.limit}-byte budget`;
  return Object.freeze({
    code: DIAGNOSTIC_CODES.BLEND_RESOURCE_LIMIT,
    severity: 'warning',
    message: `Blend modes in ${notice.nodeId} are drawn as normal: ${reason}.`,
    generation,
    context: Object.freeze({
      nodeId: notice.nodeId,
      bytes: notice.bytes,
      limit: notice.limit,
      reason: notice.reason,
    }),
  });
}
