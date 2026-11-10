import { rebaseClipChain } from './clip-resolution.js';
import type { SceneBounds } from './scene-numeric.js';
import {
  deviceEffects,
  effectBounds,
  effectMargin,
  planEffectBudget,
  type BudgetLayer,
  type DeviceBox,
  type DeviceEffects,
  type EffectBudgetNotice,
  type TreeNotice,
} from './effect-plan.js';
import {
  layerBound,
  type DeviceRect,
  type LayerCamera,
  type LayerScope,
  type LayerTarget,
} from './layer-plan.js';

/**
 * E41 contract, unit U4b: the frame's layer plan when the scene holds effect roots (section
 * 5.2, K1, K2, K2c; budget 5.4). Scenes without effect roots keep E25's plan unchanged.
 *
 * Each scope ends in one of three states: `drawn` (a layer with its bound, an effect root with
 * its effect bounds), `dissolved` (an effect root that is not isolated, in a tree whose effects
 * were dropped: its content draws in its nearest drawn ancestor) or `dropped` (not drawn, with
 * its content: an empty bound, inside one, or a tree over the budget).
 */

/** An effect root drawn with its effects: the device effects and K2's two bounds. */
export type EffectLayer = Readonly<{
  effects: DeviceEffects;
  source: DeviceRect;
  output: DeviceRect;
  /** A leaf root's opacity, which its draws in `L` keep (U5 builds `R` with it); else 1. */
  contentOpacity: number;
}>;

export type LayerState = 'drawn' | 'dissolved' | 'dropped';

export type EffectLayerPlan = Readonly<{
  states: ReadonlyMap<LayerScope, LayerState>;
  /** The bound of each drawn scope: an effect root's source bound, else E25-K5's. */
  bounds: ReadonlyMap<LayerScope, DeviceRect>;
  /** The drawn effect roots. */
  effects: ReadonlyMap<LayerScope, EffectLayer>;
  layerNotices: readonly TreeNotice[];
  effectNotices: readonly EffectBudgetNotice[];
  /** E41-K4: σ clamped over the drawn effect roots (frame statistics). */
  clampedSigmas: number;
}>;

type Scale = Readonly<{ camera: LayerCamera; scale: number }>;

function deviceBox(bounds: SceneBounds, view: Scale): DeviceBox {
  const { camera, scale } = view;
  return {
    minX: (bounds.minX - camera.x) * scale,
    minY: (bounds.minY - camera.y) * scale,
    maxX: (bounds.maxX - camera.x) * scale,
    maxY: (bounds.maxY - camera.y) * scale,
  };
}

function boxOfRect(rect: DeviceRect): DeviceBox {
  return { minX: rect.x, minY: rect.y, maxX: rect.x + rect.width, maxY: rect.y + rect.height };
}

function rectOfBox(box: DeviceBox | null): DeviceRect | null {
  if (box === null || !(box.minX < box.maxX && box.minY < box.maxY)) return null;
  return { x: box.minX, y: box.minY, width: box.maxX - box.minX, height: box.maxY - box.minY };
}

function intersectBoxes(left: DeviceBox, right: DeviceBox): DeviceBox | null {
  const box = {
    minX: Math.max(left.minX, right.minX),
    minY: Math.max(left.minY, right.minY),
    maxX: Math.min(left.maxX, right.maxX),
    maxY: Math.min(left.maxY, right.maxY),
  };
  return box.minX < box.maxX && box.minY < box.maxY ? box : null;
}

function intersectRects(left: DeviceRect, right: DeviceRect): DeviceRect | null {
  const box = intersectBoxes(boxOfRect(left), boxOfRect(right));
  return box === null ? null : Object.freeze(rectOfBox(box)!);
}

/** `C` of an effect root: its drawn content and nested reach, widened by 1 px, in its own clip. */
function contentBox(
  scope: LayerScope,
  content: readonly SceneBounds[],
  nested: readonly DeviceRect[],
  view: Scale,
): DeviceBox | null {
  let box: DeviceBox | null = null;
  const add = (next: DeviceBox) => {
    box =
      box === null
        ? next
        : {
            minX: Math.min(box.minX, next.minX),
            minY: Math.min(box.minY, next.minY),
            maxX: Math.max(box.maxX, next.maxX),
            maxY: Math.max(box.maxY, next.maxY),
          };
  };
  for (const bounds of content) add(deviceBox(bounds, view));
  for (const rect of nested) add(boxOfRect(rect));
  if (box === null) return null;
  const grown: DeviceBox = {
    minX: (box as DeviceBox).minX - 1,
    minY: (box as DeviceBox).minY - 1,
    maxX: (box as DeviceBox).maxX + 1,
    maxY: (box as DeviceBox).maxY + 1,
  };
  // The root's own clip (a container root's clip level), each widened by 1 px; its
  // ancestors' clips apply at the composite (5.1 step 4), not to `L`.
  const own = ownClipBounds(scope);
  if (own === null) return null;
  let clipped: DeviceBox | null = grown;
  for (const bounds of own) {
    const clip = deviceBox(bounds, view);
    clipped =
      clipped === null
        ? null
        : intersectBoxes(clipped, {
            minX: clip.minX - 1,
            minY: clip.minY - 1,
            maxX: clip.maxX + 1,
            maxY: clip.maxY + 1,
          });
  }
  return clipped;
}

/** The root's own clip bounds, or null when its own clip is empty. */
function ownClipBounds(scope: LayerScope): readonly SceneBounds[] | null {
  if (scope.chain === null || scope.chain === scope.outerChain) return [];
  if (scope.chain.empty && scope.outerChain?.empty !== true) return null;
  const outer = scope.outerChain?.bounds.length ?? 0;
  return scope.chain.bounds.slice(outer);
}

/**
 * The clip bounds between an enclosing layer and a root: the levels of `chain` past the
 * enclosing layer's own chain (E41-K2: `V` is intersected with them).
 */
function chainBetween(scope: LayerScope): readonly SceneBounds[] {
  // A null `outerChain` is an unclipped ancestry, not an absent one.
  const chain = scope.outerChain !== undefined ? scope.outerChain : scope.chain;
  if (chain === null) return [];
  const parentLength = scope.parent?.chain?.bounds.length ?? 0;
  return chain.bounds.slice(parentLength);
}

/** The innermost effect root around a scope (not the scope itself), or null. */
function effectRootOf(scope: LayerScope): LayerScope | null {
  for (let parent = scope.parent; parent !== null; parent = parent.parent) {
    if (parent.effects !== undefined) return parent;
  }
  return null;
}

function rootOf(scope: LayerScope): LayerScope {
  let root = scope;
  while (root.parent !== null) root = root.parent;
  return root;
}

/** E25-K5 bounds of the scopes in `kept`, each nested in its nearest kept ancestor. */
function plainBounds(
  scopes: readonly LayerScope[],
  kept: (scope: LayerScope) => boolean,
  content: ReadonlyMap<LayerScope, readonly SceneBounds[]>,
  camera: LayerCamera,
  target: LayerTarget,
): Map<LayerScope, DeviceRect> {
  const keptParent = (scope: LayerScope) => {
    let parent = scope.parent;
    while (parent !== null && !kept(parent)) parent = parent.parent;
    return parent;
  };
  // A dissolved scope's content belongs to its nearest kept ancestor.
  const owned = new Map<LayerScope, SceneBounds[]>();
  for (const scope of scopes) {
    const target = kept(scope) ? scope : keptParent(scope);
    if (target === null) continue;
    const list = owned.get(target) ?? [];
    list.push(...(content.get(scope) ?? []));
    owned.set(target, list);
  }
  const unclamped = new Map<LayerScope, DeviceRect>();
  const nested = new Map<LayerScope, DeviceRect[]>();
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index]!;
    if (!kept(scope)) continue;
    const bound = layerBound(
      owned.get(scope) ?? [],
      nested.get(scope) ?? [],
      scope.chain,
      camera,
      target,
      null,
    );
    if (bound === null) continue;
    unclamped.set(scope, bound);
    const parent = keptParent(scope);
    if (parent !== null) nested.set(parent, [...(nested.get(parent) ?? []), bound]);
  }
  const bounds = new Map<LayerScope, DeviceRect>();
  for (const scope of scopes) {
    const own = unclamped.get(scope);
    if (own === undefined) continue;
    const parent = keptParent(scope);
    if (parent === null) {
      bounds.set(scope, own);
      continue;
    }
    const outer = bounds.get(parent);
    const clamped = outer === undefined ? null : intersectRects(own, outer);
    if (clamped !== null) bounds.set(scope, clamped);
  }
  return bounds;
}

/**
 * The frame's layer plan over `scopes` (pre-order) with effect roots. `content` holds each
 * scope's drawn leaf bounds in world units.
 */
export function planEffectLayers(
  scopes: readonly LayerScope[],
  content: ReadonlyMap<LayerScope, readonly SceneBounds[]>,
  camera: LayerCamera,
  target: LayerTarget,
  maxTextureDimension: number,
): EffectLayerPlan {
  const view: Scale = { camera, scale: camera.zoom * target.devicePixelRatio };
  const targetRect: DeviceRect = { x: 0, y: 0, width: target.width, height: target.height };
  const device = new Map<LayerScope, DeviceEffects>();
  for (const scope of scopes) {
    if (scope.effects !== undefined && scope.world !== undefined) {
      device.set(scope, deviceEffects(scope.effects, scope.world, view.scale));
    }
  }

  // Bottom-up reach: what each scope adds to its parent's content (E41-K2c: an effect root
  // adds its output reach, `C ⊕ m`, before `V` is known).
  const reach = new Map<LayerScope, DeviceRect>();
  const contents = new Map<LayerScope, DeviceBox>();
  const nested = new Map<LayerScope, DeviceRect[]>();
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index]!;
    const effects = device.get(scope);
    let bound: DeviceRect | null;
    if (effects === undefined) {
      // E41-K2b: inside an effect root, the layer's draws carry chains rebased at the innermost
      // root, so its bound is cut by the levels inside that root only; its ancestors' clips
      // apply at its composite. (A backend that does not rebase still clips each draw.)
      const root = effectRootOf(scope);
      bound = layerBound(
        content.get(scope) ?? [],
        nested.get(scope) ?? [],
        root === null
          ? scope.chain
          : rebaseClipChain(scope.chain, root.outerChain ?? null, root.nodeId),
        camera,
        target,
        null,
        root === null,
      );
    } else {
      const box = contentBox(scope, content.get(scope) ?? [], nested.get(scope) ?? [], view);
      if (box !== null) contents.set(scope, box);
      const m = effectMargin(effects);
      bound =
        box === null
          ? null
          : rectOfBox({
              minX: box.minX - m,
              minY: box.minY - m,
              maxX: box.maxX + m,
              maxY: box.maxY + m,
            });
    }
    if (bound === null) continue;
    reach.set(scope, bound);
    if (scope.parent !== null) {
      nested.set(scope.parent, [...(nested.get(scope.parent) ?? []), bound]);
    }
  }

  // Top-down: each scope's bound inside its enclosing layer.
  const effectBoundsOf = new Map<
    LayerScope,
    Readonly<{ source: DeviceRect; output: DeviceRect }>
  >();
  const withEffects = new Map<LayerScope, DeviceRect>();
  for (const scope of scopes) {
    const own = reach.get(scope);
    if (own === undefined) continue;
    const parent = scope.parent;
    if (parent !== null && !withEffects.has(parent)) continue;
    // `V`: the target, or the enclosing layer's (source) bound.
    const enclosing = parent === null ? targetRect : withEffects.get(parent)!;
    const effects = device.get(scope);
    if (effects === undefined) {
      const clamped = parent === null ? own : intersectRects(own, enclosing);
      if (clamped !== null) withEffects.set(scope, clamped);
      continue;
    }
    let v: DeviceBox | null = boxOfRect(enclosing);
    for (const bounds of chainBetween(scope)) {
      const clip = deviceBox(bounds, view);
      v =
        v === null
          ? null
          : intersectBoxes(v, {
              minX: clip.minX - 1,
              minY: clip.minY - 1,
              maxX: clip.maxX + 1,
              maxY: clip.maxY + 1,
            });
    }
    const box = contents.get(scope);
    const vRect = rectOfBox(v);
    if (box === undefined || vRect === null) continue;
    const bounds = effectBounds(box, vRect, effects, scope.hasMask === true ? targetRect : null);
    if (bounds === null) continue;
    effectBoundsOf.set(scope, bounds);
    withEffects.set(scope, bounds.source);
  }

  // The tree's plan without its effects: isolated scopes stay E25 layers, each top-level one
  // the root of its own E25 tree.
  const isolated = (scope: LayerScope) => scope.isolated !== false;
  const plain = plainBounds(scopes, isolated, content, camera, target);
  const plainRootOf = (scope: LayerScope): LayerScope => {
    let root = scope;
    for (let parent = scope.parent; parent !== null; parent = parent.parent) {
      if (isolated(parent)) root = parent;
    }
    return root;
  };

  // Section 5.4: trees in paint order.
  const trees = new Map<
    LayerScope,
    {
      layers: BudgetLayer[];
      withoutEffects: Map<LayerScope, { width: number; height: number }[]>;
      effectRoots: string[];
    }
  >();
  const treeOf = (scope: LayerScope) => {
    const root = rootOf(scope);
    let tree = trees.get(root);
    if (tree === undefined) {
      tree = { layers: [], withoutEffects: new Map(), effectRoots: [] };
      trees.set(root, tree);
    }
    return tree;
  };
  for (const scope of scopes) {
    const bound = withEffects.get(scope);
    const plainBound = plain.get(scope);
    if (bound === undefined && plainBound === undefined && scope.effects === undefined) continue;
    const tree = treeOf(scope);
    if (scope.effects !== undefined) tree.effectRoots.push(scope.nodeId);
    const effect = effectBoundsOf.get(scope);
    if (effect !== undefined) tree.layers.push({ kind: 'effect', ...effect });
    else if (bound !== undefined) {
      tree.layers.push({ kind: 'layer', width: bound.width, height: bound.height });
    }
    if (plainBound !== undefined) {
      const sub = plainRootOf(scope);
      tree.withoutEffects.set(sub, [...(tree.withoutEffects.get(sub) ?? []), plainBound]);
    }
  }
  const budget = planEffectBudget(
    [...trees].map(([root, tree]) => ({
      rootId: root.nodeId,
      layers: tree.layers,
      effectRoots: tree.effectRoots,
      withoutEffects: [...tree.withoutEffects].map(([sub, layers]) => ({
        rootId: sub.nodeId,
        layers,
      })),
    })),
    target.sampleCount,
    maxTextureDimension,
  );

  const states = new Map<LayerScope, LayerState>();
  const bounds = new Map<LayerScope, DeviceRect>();
  const effects = new Map<LayerScope, EffectLayer>();
  let clampedSigmas = 0;
  for (const scope of scopes) {
    const root = rootOf(scope).nodeId;
    if (budget.withEffects.has(root)) {
      const bound = withEffects.get(scope);
      if (bound === undefined) {
        states.set(scope, 'dropped');
        continue;
      }
      states.set(scope, 'drawn');
      bounds.set(scope, bound);
      const effect = effectBoundsOf.get(scope);
      if (effect !== undefined) {
        const deviceEffect = device.get(scope)!;
        clampedSigmas += deviceEffect.clamped;
        effects.set(
          scope,
          Object.freeze({
            effects: deviceEffect,
            source: effect.source,
            output: effect.output,
            contentOpacity: scope.contentOpacity ?? 1,
          }),
        );
      }
      continue;
    }
    // Admitted whole without effects (a tree with no effect root), or split into E25 trees.
    if (!isolated(scope)) {
      states.set(scope, 'dissolved');
      continue;
    }
    const admittedPlain =
      budget.admitted.has(root) || budget.plainAdmitted.has(plainRootOf(scope).nodeId);
    const bound = plain.get(scope);
    if (!admittedPlain || bound === undefined) states.set(scope, 'dropped');
    else {
      states.set(scope, 'drawn');
      bounds.set(scope, bound);
    }
  }
  return Object.freeze({
    states,
    bounds,
    effects,
    layerNotices: budget.layerNotices,
    effectNotices: budget.effectNotices,
    clampedSigmas,
  });
}
