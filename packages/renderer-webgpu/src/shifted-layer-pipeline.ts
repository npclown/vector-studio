import { MESH_FILL_CLIP_SHADER, PRIMITIVE_ANALYTIC_CLIP_SHADER } from './clip-pipeline.js';
import {
  LAYER_BLOCK,
  LAYER_COMPOSITE_SHADER,
  LAYER_VARIANT_SUFFIX,
  layerVariantKey,
} from './layer-pipeline.js';
import { MESH_FILL_SHADER } from './mesh-fill-shader.js';
import {
  MESH_FILL_PAINT_CLIP_SHADER,
  MESH_FILL_PAINT_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_SHADER,
} from './paint-pipeline.js';
import type { PipelineCacheKey } from './pipeline-cache.js';
import { PRIMITIVE_ANALYTIC_SHADER } from './primitive-analytic-shader.js';
import { TEXT_CLIP_SHADER, TEXT_SHADER } from './text-pipeline.js';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), unit U5b: the shifted layer
// variants. E25's layer variants keep every vertex stage and map a layer tile through a
// target-sized viewport at −shift, so clip space is the target and content outside it is
// clipped. An effect root's `L` (and every layer inside it) reaches past the target (E41-K2),
// so its tile passes draw with these variants instead: each vertex stage maps a target pixel
// `p` to the tile's clip space, `(p − layerPass.shift) / layerPass.size`, with the viewport at
// (0, 0) and the tile's size, and each fragment read of the position adds `layerPass.shift` as
// E25's do. Fragments therefore see target pixels as in the main pass, at any distance from
// the target. Base, clip, paint, layer and text modules, keys and pipelines are untouched.

export const SHIFTED_LAYER_VARIANT_SUFFIX = '+shift-v0';

const POSITION_READ = 'input.position.xy';

/** Each vertex stage's clip-space mapping and its shifted form; each must occur at most once. */
const NDC_REWRITES: readonly (readonly [string, string])[] = Object.freeze([
  // The analytic and mesh modules (P1's mapping, y flipped).
  [
    'physicalPosition.x * 2.0 / frame.physicalSize.x - 1.0',
    '(physicalPosition.x - layerPass.shift.x) * 2.0 / layerPass.size.x - 1.0',
  ],
  [
    '1.0 - physicalPosition.y * 2.0 / frame.physicalSize.y',
    '1.0 - (physicalPosition.y - layerPass.shift.y) * 2.0 / layerPass.size.y',
  ],
  // The text module.
  [
    'let ndc = pixel / textTarget.size * 2.0 - 1.0;',
    'let ndc = (pixel - layerPass.shift) / layerPass.size * 2.0 - 1.0;',
  ],
  // E25's composite module.
  [
    'let ndc = pixel / layerPass.size * 2.0 - 1.0;',
    'let ndc = (pixel - layerPass.shift) / layerPass.size * 2.0 - 1.0;',
  ],
]);

/** Reads that must not survive a rewrite: a vertex stage mapping through the target's size. */
const TARGET_SIZE_READS: readonly string[] = Object.freeze([
  'frame.physicalSize',
  'textTarget.size',
]);

function rewriteVertexStages(source: string): string {
  let rewritten = source;
  let applied = 0;
  for (const [from, to] of NDC_REWRITES) {
    const parts = rewritten.split(from);
    if (parts.length > 2) throw new Error(`Shifted layer variant: "${from}" occurs twice.`);
    if (parts.length === 2) {
      rewritten = parts.join(to);
      applied += 1;
    }
  }
  if (applied === 0) throw new Error('Shifted layer variant: the module maps no vertex.');
  for (const read of TARGET_SIZE_READS) {
    if (rewritten.includes(read)) {
      throw new Error(`Shifted layer variant: the module still reads ${read}.`);
    }
  }
  return rewritten;
}

/**
 * A module's shifted layer variant: its vertex stages map through the tile, its fragment reads
 * of the position are shifted as `layerVariantSource` shifts them, and the layer block is
 * appended. Unlike E25's, a module that reads no fragment position has one (the plain analytic
 * module draws in a shifted pass through it).
 */
export function shiftedLayerVariantSource(source: string): string {
  const rewritten = rewriteVertexStages(source);
  return `${rewritten.split(POSITION_READ).join(`(${POSITION_READ} + layerPass.shift)`)}${LAYER_BLOCK}`;
}

/** The analytic modules: plain, clip, paint, paint and clip. */
export const PRIMITIVE_ANALYTIC_SHIFTED_SHADER =
  shiftedLayerVariantSource(PRIMITIVE_ANALYTIC_SHADER);
export const PRIMITIVE_ANALYTIC_CLIP_SHIFTED_SHADER = shiftedLayerVariantSource(
  PRIMITIVE_ANALYTIC_CLIP_SHADER,
);
export const PRIMITIVE_ANALYTIC_PAINT_SHIFTED_SHADER = shiftedLayerVariantSource(
  PRIMITIVE_ANALYTIC_PAINT_SHADER,
);
export const PRIMITIVE_ANALYTIC_PAINT_CLIP_SHIFTED_SHADER = shiftedLayerVariantSource(
  PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER,
);
/** The mesh modules (fill, joint, covers and stencil passes share each). */
export const MESH_FILL_SHIFTED_SHADER = shiftedLayerVariantSource(MESH_FILL_SHADER);
export const MESH_FILL_CLIP_SHIFTED_SHADER = shiftedLayerVariantSource(MESH_FILL_CLIP_SHADER);
export const MESH_FILL_PAINT_SHIFTED_SHADER = shiftedLayerVariantSource(MESH_FILL_PAINT_SHADER);
export const MESH_FILL_PAINT_CLIP_SHIFTED_SHADER = shiftedLayerVariantSource(
  MESH_FILL_PAINT_CLIP_SHADER,
);
/** The text modules, plain and clip. */
export const TEXT_SHIFTED_SHADER = shiftedLayerVariantSource(TEXT_SHADER);
export const TEXT_CLIP_SHIFTED_SHADER = shiftedLayerVariantSource(TEXT_CLIP_SHADER);
/** E25's composite module, which already holds the layer block and its shifted fragment read. */
export const LAYER_COMPOSITE_SHIFTED_SHADER = rewriteVertexStages(LAYER_COMPOSITE_SHADER);

/**
 * A shifted variant's cache key: the base variant's key (its clip and paint suffixes) with the
 * layer suffixes and the shift suffix. `base` is the key without the layer suffix.
 */
export function shiftedLayerVariantKey(base: PipelineCacheKey): PipelineCacheKey {
  const layered = layerVariantKey(base);
  return Object.freeze({
    ...layered,
    shaderKey: `${layered.shaderKey}${SHIFTED_LAYER_VARIANT_SUFFIX}`,
  });
}

/** A shifted composite key from E25's composite key (which already holds its layer layout). */
export function shiftedCompositeKey(composite: PipelineCacheKey): PipelineCacheKey {
  return Object.freeze({
    ...composite,
    shaderKey: `${composite.shaderKey}${LAYER_VARIANT_SUFFIX}${SHIFTED_LAYER_VARIANT_SUFFIX}`,
  });
}
