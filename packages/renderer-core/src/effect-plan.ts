import {
  DIAGNOSTIC_CODES,
  type DiagnosticInput,
  type SceneAffine,
  type SceneColor,
  type SceneEffect,
} from '@vector-studio/contracts';
import type { ClipChain } from './clip-resolution.js';
import { E25_LAYER_BYTES_MAX, layerTileBytes, type DeviceRect } from './layer-plan.js';
import type { SceneBounds } from './scene-numeric.js';

/**
 * E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), unit U4b: the pure parts of the
 * effect-layer plan. Device parameters of an effect root (E41-S9, K4's clamp), its margin
 * (K1), its source and output bounds (K2) and the frame budget shared with E25 layers (5.4).
 * Pure CPU data; the blur and composite passes belong to U5.
 */

/** E41-K4: `σ_px` is clamped to this. */
export const E41_SIGMA_PX_MAX = 256;

/**
 * E41 U5b: how far past the target an effect layer's bound may reach, in device pixels, on
 * every side. The shifted layer variants subtract the tile origin in binary32, which stays
 * exact to a 1/32 pixel within this reach of a target up to 4096 pixels wide.
 */
export const E41_LAYER_REACH_MAX = 1 << 17;
/** E41-K4: taps per side of one blur pass. */
export const E41_BLUR_TAPS_MAX = 32;
/** E41-K4: downsample levels at most, so `σ_px ≤ 341` before the clamp. */
export const E41_BLUR_LEVELS_MAX = 5;

/** One drop shadow in device pixels. */
export type DeviceShadow = Readonly<{
  color: SceneColor;
  /** The offset mapped through the root's world transform and the camera, in device pixels. */
  dx: number;
  dy: number;
  /** After the clamp. */
  sigmaPx: number;
}>;

/** An effect root's effects in device pixels (E41-S9). */
export type DeviceEffects = Readonly<{
  shadows: readonly DeviceShadow[];
  /** V-36 contract, V36-K1: inner shadows in list order; absent when there are none. */
  innerShadows?: readonly DeviceShadow[];
  /** V36 section 5: the background blur's `σ_px` after the clamp; absent without one. */
  backgroundBlur?: Readonly<{ sigmaPx: number }>;
  /** The layer blur's `σ_px` after the clamp, or null without a layer blur. */
  blurSigmaPx: number | null;
  /** How many σ were clamped to E41_SIGMA_PX_MAX (frame statistics, K4). */
  clamped: number;
}>;

/** The largest singular value of the linear part of `affine`. */
export function largestSingularValue(affine: SceneAffine): number {
  const [a, b, c, d] = affine;
  // Singular values of [[a, c], [b, d]]: sqrt of the eigenvalues of MᵀM.
  const p = a * a + b * b;
  const q = c * c + d * d;
  const r = a * c + b * d;
  const half = (p + q) / 2;
  const root = Math.sqrt(((p - q) / 2) ** 2 + r * r);
  return Math.sqrt(half + root);
}

/**
 * E41-S9: an effect root's effects in device pixels. `world` is the root's world transform and
 * `scale` the camera's zoom times the device pixel ratio. Offsets map through the linear part of
 * `world`, then `scale`; σ through `world`'s largest singular value (its scale under a
 * similarity), then `scale`, clamped to E41_SIGMA_PX_MAX.
 */
export function deviceEffects(
  effects: readonly SceneEffect[],
  world: SceneAffine,
  scale: number,
): DeviceEffects {
  const sigmaScale = largestSingularValue(world) * scale;
  let clamped = 0;
  const clamp = (sigma: number) => {
    const px = sigma * sigmaScale;
    if (px > E41_SIGMA_PX_MAX) {
      clamped += 1;
      return E41_SIGMA_PX_MAX;
    }
    return px;
  };
  const shadows: DeviceShadow[] = [];
  const innerShadows: DeviceShadow[] = [];
  let blurSigmaPx: number | null = null;
  let backgroundBlur: DeviceEffects['backgroundBlur'];
  for (const effect of effects) {
    if (effect.kind === 'layerBlur') {
      blurSigmaPx = clamp(effect.sigma);
      continue;
    }
    if (effect.kind === 'backgroundBlur') {
      backgroundBlur = Object.freeze({ sigmaPx: clamp(effect.sigma) });
      continue;
    }
    const [a, b, c, d] = world;
    (effect.kind === 'innerShadow' ? innerShadows : shadows).push(
      Object.freeze({
        color: effect.color,
        dx: (a * effect.offsetX + c * effect.offsetY) * scale,
        dy: (b * effect.offsetX + d * effect.offsetY) * scale,
        sigmaPx: clamp(effect.sigma),
      }),
    );
  }
  // V-36: the fields exist only with their effects, so E41's records are unchanged.
  return Object.freeze({
    shadows: Object.freeze(shadows),
    ...(innerShadows.length === 0 ? {} : { innerShadows: Object.freeze(innerShadows) }),
    blurSigmaPx,
    ...(backgroundBlur === undefined ? {} : { backgroundBlur }),
    clamped,
  });
}

/** `⌈3 σ⌉`, the blur's reach in device pixels (0 for σ = 0). */
export function blurReach(sigmaPx: number | null): number {
  return sigmaPx === null ? 0 : Math.ceil(3 * sigmaPx);
}

/**
 * E41-K4: the downsample levels a blur of `sigmaPx` needs, so that the blur at the last level
 * fits E41_BLUR_TAPS_MAX taps per side (`⌈3 σ_px / 2^k⌉ ≤ 32`). At most E41_BLUR_LEVELS_MAX.
 */
export function blurLevels(sigmaPx: number): number {
  let levels = 0;
  while (levels < E41_BLUR_LEVELS_MAX && Math.ceil((3 * sigmaPx) / 2 ** levels) > E41_BLUR_TAPS_MAX)
    levels += 1;
  return levels;
}

/** E41-K1: the margin `m = ⌈3 σ_blur⌉ + maxᵢ(⌈3 σᵢ⌉ + |offsetᵢ|)` in device pixels. */
export function effectMargin(effects: DeviceEffects): number {
  let shadow = 0;
  for (const entry of effects.shadows) {
    shadow = Math.max(shadow, blurReach(entry.sigmaPx) + Math.ceil(Math.hypot(entry.dx, entry.dy)));
  }
  return blurReach(effects.blurSigmaPx) + shadow;
}

/** A device rectangle in fractional pixels, before rounding. */
export type DeviceBox = Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;

function grow(box: DeviceBox, by: number): DeviceBox {
  return { minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by };
}

function intersect(left: DeviceBox, right: DeviceBox): DeviceBox | null {
  const box = {
    minX: Math.max(left.minX, right.minX),
    minY: Math.max(left.minY, right.minY),
    maxX: Math.min(left.maxX, right.maxX),
    maxY: Math.min(left.maxY, right.maxY),
  };
  return box.minX < box.maxX && box.minY < box.maxY ? box : null;
}

function union(left: DeviceBox, right: DeviceBox): DeviceBox {
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

/** E25-K5's even rounding: x and y down to even values, the size up to even. Null when empty. */
export function evenRect(box: DeviceBox | null): DeviceRect | null {
  if (box === null || !(box.minX < box.maxX && box.minY < box.maxY)) return null;
  const x = 2 * Math.floor(Math.floor(box.minX) / 2);
  const y = 2 * Math.floor(Math.floor(box.minY) / 2);
  const width = 2 * Math.ceil((Math.ceil(box.maxX) - x) / 2);
  const height = 2 * Math.ceil((Math.ceil(box.maxY) - y) / 2);
  return Object.freeze({ x, y, width, height });
}

function boxOf(rect: DeviceRect): DeviceBox {
  return { minX: rect.x, minY: rect.y, maxX: rect.x + rect.width, maxY: rect.y + rect.height };
}

function clampRect(rect: DeviceRect, to: DeviceRect): DeviceRect | null {
  const x = Math.max(rect.x, to.x);
  const y = Math.max(rect.y, to.y);
  const right = Math.min(rect.x + rect.width, to.x + to.width);
  const bottom = Math.min(rect.y + rect.height, to.y + to.height);
  return x < right && y < bottom
    ? Object.freeze({ x, y, width: right - x, height: bottom - y })
    : null;
}

/** An effect root's two device rectangles (E41-K2). */
export type EffectBounds = Readonly<{
  /** Where `L` is rendered. */
  source: DeviceRect;
  /** Where `R` is built and the composite quad covers. */
  output: DeviceRect;
  /**
   * V36-K1b: with inner shadows, the source bound before any clamp to the target, so a later
   * cut of `L` is known by side; absent without inner shadows.
   */
  uncut?: DeviceRect;
  /**
   * V-36 section 5.5: with inner shadows, the largest harden region `H` in pixels (the output
   * bound grown by a shadow's read reach and K4's chain slack); absent without inner shadows.
   */
  innerScratch?: number;
}>;

/**
 * E41-K2: the source and output bounds of an effect root. `content` is `C`, the root's content
 * bound in device pixels (its own clip applied, its ancestors' not); `view` is `V`, the target
 * or the enclosing layer's source bound, already intersected with the clip-chain bound of the
 * root's ancestors up to that layer. With `clampTo` (the target, when the root's subtree holds
 * a mask group), both bounds are clamped to it. Null when either bound is empty: the root draws
 * nothing in this frame.
 */
export function effectBounds(
  content: DeviceBox,
  view: DeviceRect,
  effects: DeviceEffects,
  clampTo: DeviceRect | null = null,
): EffectBounds | null {
  const b = blurReach(effects.blurSigmaPx);
  const v = boxOf(view);
  let reach = grow(v, b);
  // V36-K1: an inner shadow samples `L` at `p − offset` as a drop shadow does.
  for (const shadow of [...effects.shadows, ...(effects.innerShadows ?? [])]) {
    const shifted = {
      minX: v.minX - shadow.dx,
      minY: v.minY - shadow.dy,
      maxX: v.maxX - shadow.dx,
      maxY: v.maxY - shadow.dy,
    };
    reach = union(reach, grow(shifted, blurReach(shadow.sigmaPx) + b));
  }
  let source = intersect(content, reach);
  const uncut = effects.innerShadows === undefined ? null : evenRect(source);
  let output = intersect(grow(content, effectMargin(effects)), grow(v, b));
  if (clampTo !== null) {
    const target = boxOf(clampTo);
    source = source === null ? null : intersect(source, target);
    output = output === null ? null : intersect(output, target);
  }
  let sourceRect = evenRect(source);
  let outputRect = evenRect(output);
  // Rounding the size up to even can pass an odd target edge: clamp again, as `layerBound` does.
  if (clampTo !== null) {
    sourceRect = sourceRect === null ? null : clampRect(sourceRect, clampTo);
    outputRect = outputRect === null ? null : clampRect(outputRect, clampTo);
  }
  if (sourceRect === null || outputRect === null) return null;
  if (effects.innerShadows === undefined || uncut === null) {
    return Object.freeze({ source: sourceRect, output: outputRect });
  }
  let innerScratch = 0;
  for (const shadow of effects.innerShadows) {
    const r =
      blurReach(shadow.sigmaPx) +
      Math.ceil(Math.hypot(shadow.dx, shadow.dy)) +
      2 +
      2 ** (blurLevels(shadow.sigmaPx) + 1);
    innerScratch = Math.max(innerScratch, (outputRect.width + 2 * r) * (outputRect.height + 2 * r));
  }
  return Object.freeze({ source: sourceRect, output: outputRect, uncut, innerScratch });
}

/** One planned layer of a tree for the budget: an E25 layer, or an effect root's two bounds. */
export type BudgetLayer =
  | Readonly<{ kind: 'layer'; width: number; height: number }>
  | Readonly<{
      kind: 'effect';
      source: DeviceRect;
      output: DeviceRect;
      /** V-36 section 5.5: the largest inner-shadow harden region, in pixels. */
      innerScratch?: number;
    }>;

/** A layer tree for the effect budget, in paint order. */
export type EffectBudgetTree = Readonly<{
  rootId: string;
  layers: readonly BudgetLayer[];
  /**
   * The E25 layer trees the tree splits into if its effects are dropped: isolated scopes stay
   * layers, the others dissolve, so each top-level isolated scope roots one tree.
   */
  withoutEffects: readonly Readonly<{
    rootId: string;
    layers: readonly Readonly<{ width: number; height: number }>[];
  }>[];
  /** The effect roots of the tree, for the notice. */
  effectRoots: readonly string[];
}>;

export type EffectBudgetNotice = Readonly<{
  nodeId: string;
  bytes: number;
  limit: number;
  /** True when the tree's effects were dropped for a root's bound over the texture limit. */
  overTextureLimit: boolean;
}>;

/** The layer resource notice of a tree not drawn at all (E25 section 4). */
export type TreeNotice = Readonly<{ nodeId: string; bytes: number; limit: number }>;

/**
 * E41 section 5.4: the frame budget over E25 layers and effect roots. Trees are admitted whole
 * in paint order while the resident bytes fit `limit`:
 *
 * - an E25 layer at 4 bytes per pixel; an effect root at `4 (S + O)`;
 * - shared scratch `4 × (2 + 2/3) × max O` over the admitted effect roots (V-36 section 5.5:
 *   or the largest inner-shadow harden region `H`, when larger);
 * - E25's tile set over the widest admitted layer or source bound.
 *
 * A tree with effects that does not fit, or holds a bound over `maxTextureDimension`, drops its
 * effects (one `effects` notice on its root) and its E25 trees are planned again under E25's
 * rule, each admitted whole or not drawn with one `layers` notice on its root (`plainAdmitted`).
 */
export function planEffectBudget(
  trees: readonly EffectBudgetTree[],
  sampleCount: 1 | 4,
  maxTextureDimension: number,
  limit = E25_LAYER_BYTES_MAX,
): Readonly<{
  admitted: ReadonlySet<string>;
  withEffects: ReadonlySet<string>;
  /** The E25 trees admitted from trees that dropped their effects, by root. */
  plainAdmitted: ReadonlySet<string>;
  effectNotices: readonly EffectBudgetNotice[];
  layerNotices: readonly TreeNotice[];
}> {
  const admitted = new Set<string>();
  const plainAdmitted = new Set<string>();
  const withEffects = new Set<string>();
  const effectNotices: EffectBudgetNotice[] = [];
  const layerNotices: TreeNotice[] = [];
  let resident = 0;
  let maxWidth = 0;
  let maxHeight = 0;
  let maxOutput = 0;
  const scratch = (output: number) => Math.ceil(4 * (2 + 2 / 3) * output);
  for (const tree of trees) {
    let bytes = 0;
    let width = maxWidth;
    let height = maxHeight;
    let output = maxOutput;
    let oversize = false;
    for (const layer of tree.layers) {
      if (layer.kind === 'layer') {
        bytes += layer.width * layer.height * 4;
        width = Math.max(width, layer.width);
        height = Math.max(height, layer.height);
        continue;
      }
      const { source, output: out } = layer;
      if (Math.max(source.width, source.height, out.width, out.height) > maxTextureDimension) {
        oversize = true;
      }
      bytes += 4 * (source.width * source.height + out.width * out.height);
      width = Math.max(width, source.width);
      height = Math.max(height, source.height);
      output = Math.max(output, out.width * out.height, layer.innerScratch ?? 0);
    }
    const total = resident + bytes + scratch(output) + layerTileBytes(width, height, sampleCount);
    if (!oversize && total <= limit) {
      admitted.add(tree.rootId);
      if (tree.effectRoots.length > 0) withEffects.add(tree.rootId);
      resident += bytes;
      maxWidth = width;
      maxHeight = height;
      maxOutput = output;
      continue;
    }
    if (tree.effectRoots.length > 0) {
      effectNotices.push(
        Object.freeze({ nodeId: tree.rootId, bytes: total, limit, overTextureLimit: oversize }),
      );
    }
    // E25's rule over each tree the tree splits into without its effects.
    for (const sub of tree.withoutEffects) {
      let plain = 0;
      width = maxWidth;
      height = maxHeight;
      for (const layer of sub.layers) {
        plain += layer.width * layer.height * 4;
        width = Math.max(width, layer.width);
        height = Math.max(height, layer.height);
      }
      const plainTotal =
        resident + plain + scratch(maxOutput) + layerTileBytes(width, height, sampleCount);
      if (plainTotal > limit) {
        layerNotices.push(Object.freeze({ nodeId: sub.rootId, bytes: plainTotal, limit }));
        continue;
      }
      plainAdmitted.add(sub.rootId);
      resident += plain;
      maxWidth = width;
      maxHeight = height;
    }
  }
  return Object.freeze({
    admitted,
    withEffects,
    plainAdmitted,
    effectNotices: Object.freeze(effectNotices),
    layerNotices: Object.freeze(layerNotices),
  });
}

/** E41-S8: the `render.effect-resource-limit` diagnostic of a budget notice. */
export function effectResourceLimitDiagnostic(
  notice: EffectBudgetNotice,
  generation: number,
): DiagnosticInput {
  const reason = notice.overTextureLimit
    ? 'an effect layer is larger than the device texture limit'
    : `its effect layers need ${notice.bytes} bytes over the ${notice.limit}-byte budget`;
  return Object.freeze({
    code: DIAGNOSTIC_CODES.EFFECT_RESOURCE_LIMIT,
    severity: 'warning',
    message: `Effect roots in the layer tree of ${notice.nodeId} are drawn without effects: ${reason}.`,
    generation,
    context: Object.freeze({
      nodeId: notice.nodeId,
      bytes: notice.bytes,
      limit: notice.limit,
      overTextureLimit: notice.overTextureLimit,
    }),
  });
}

/**
 * E41-K3: how far the effect roots around a leaf reach, in world units, and the clip chain its
 * reach is tested against (the outermost root's ancestors'; clips inside a root apply to `L`,
 * which its shadows then spread past). Culling tests the leaf's bound grown by `margin`.
 */
export type EffectReach = Readonly<{ margin: number; clip: ClipChain | null }>;

/**
 * E41-K1 in world units, without K4's clamp (which only shrinks the reach): `3 σ_blur` plus the
 * largest `3 σᵢ + |offsetᵢ|` over drop and (V36-K1) inner shadows, σ through `world`'s largest singular value, offsets through its
 * linear part. Device rounding is within the cull's 2 px guard.
 */
export function worldEffectMargin(effects: readonly SceneEffect[], world: SceneAffine): number {
  const scale = largestSingularValue(world);
  const [a, b, c, d] = world;
  let blurReachWorld = 0;
  let shadow = 0;
  for (const effect of effects) {
    if (effect.kind === 'layerBlur') {
      blurReachWorld = 3 * effect.sigma * scale;
      continue;
    }
    // V36-K1: the background blur reads nothing of the root's content past its own pixels; an
    // inner shadow's output stays inside the content bound but samples content at its offset,
    // so it joins the drop shadows' max (this margin is the cull reach only).
    if (effect.kind === 'backgroundBlur') continue;
    const dx = a * effect.offsetX + c * effect.offsetY;
    const dy = b * effect.offsetX + d * effect.offsetY;
    shadow = Math.max(shadow, 3 * effect.sigma * scale + Math.hypot(dx, dy));
  }
  return blurReachWorld + shadow;
}

/** The reach of the effect roots from `parent` down, adding a root with `effects` at `world`. */
export function extendEffectReach(
  parent: EffectReach | null,
  effects: readonly SceneEffect[],
  world: SceneAffine,
  outerChain: ClipChain | null,
): EffectReach {
  return Object.freeze({
    margin: (parent?.margin ?? 0) + worldEffectMargin(effects, world),
    clip: parent === null ? outerChain : parent.clip,
  });
}

/** E41-K3: the bound and clip chain a leaf is culled by. */
export function cullTarget(
  bounds: SceneBounds,
  clip: ClipChain | null,
  reach: EffectReach | undefined,
): Readonly<{ bounds: SceneBounds; clip: ClipChain | null }> {
  if (reach === undefined) return { bounds, clip };
  const m = reach.margin;
  return {
    bounds: {
      minX: bounds.minX - m,
      minY: bounds.minY - m,
      maxX: bounds.maxX + m,
      maxY: bounds.maxY + m,
    },
    clip: reach.clip,
  };
}
