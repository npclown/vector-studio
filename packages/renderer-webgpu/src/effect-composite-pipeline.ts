import { CLIP_BLOCK, CLIP_LAYOUT_KEY, CLIP_VARIANT_SUFFIX, replaceOnce } from './clip-pipeline.js';
import {
  LAYER_COMPOSITE_SHADER,
  LAYER_VARIANT_SUFFIX,
  createLayerCompositePipelineDescriptor,
  layerCompositePipelineKey,
} from './layer-pipeline.js';
import type { PipelineCacheKey } from './pipeline-cache.js';
import type { PrimitiveTargetFormat } from './primitive-pipeline.js';
import { SHIFTED_LAYER_VARIANT_SUFFIX, shiftedVertexStages } from './shifted-layer-pipeline.js';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), unit U5c: K5's effect composite.
// An effect root's `R` is drawn into its parent target by E25's composite when its composite has
// no clip state, and by the clip variant `effect-composite-v0+clip-v0` when it has one (E41-K2b:
// the root's ancestors' clips and masks, applied once). The clip variant is E25's composite
// module with its fragment entry wrapped by P4's clip block, read at the target pixel (the
// attachment pixel plus `layerPass.shift`, 0 in the main pass), so one module serves the main
// pass and E25 layer passes; its shifted form serves a root inside a root, whose pass maps the
// tile through its vertex stage (U5b). E25's composite module, keys and pipelines are untouched.
// A mask level reads coverage 0 past the target; a root whose subtree holds a mask group is
// clamped to the target (E41-K2), which keeps that exact. Relaxing that clamp needs mask levels
// past the target first.

export const EFFECT_COMPOSITE_SHADER_KEY = 'e41-effect-composite-v0';

/** The clip variant: E25's composite × P4-K1's clip coverage at the target pixel. */
export const EFFECT_COMPOSITE_CLIP_SHADER = `${replaceOnce(
  LAYER_COMPOSITE_SHADER,
  '@fragment\nfn compositeFragmentMain(input: CompositeOutput) -> @location(0) vec4f {',
  'fn shadeComposite(input: CompositeOutput) -> vec4f {',
)}${CLIP_BLOCK}
@fragment
fn compositeFragmentMain(input: CompositeOutput) -> @location(0) vec4f {
  let clip = clipCoverage(input.position.xy + layerPass.shift);
  return shadeComposite(input) * clip;
}
`;

/** The clip variant for a pass that maps its tile through the vertex stage (a root in a root). */
export const EFFECT_COMPOSITE_CLIP_SHIFTED_SHADER = shiftedVertexStages(
  EFFECT_COMPOSITE_CLIP_SHADER,
);

/** The clip variant's key: E25's composite key with the clip layout at group 1. */
export function effectCompositeClipKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil: boolean,
): PipelineCacheKey {
  const composite = layerCompositePipelineKey(targetFormat, sampleCount, stencil);
  return Object.freeze({
    ...composite,
    shaderKey: `${EFFECT_COMPOSITE_SHADER_KEY}${CLIP_VARIANT_SUFFIX}`,
    layoutKey: `${composite.layoutKey}+${CLIP_LAYOUT_KEY}`,
  });
}

/** The shifted clip variant's key. */
export function effectCompositeClipShiftedKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil: boolean,
): PipelineCacheKey {
  const key = effectCompositeClipKey(targetFormat, sampleCount, stencil);
  return Object.freeze({
    ...key,
    shaderKey: `${key.shaderKey}${LAYER_VARIANT_SUFFIX}${SHIFTED_LAYER_VARIANT_SUFFIX}`,
  });
}

/** E25's composite descriptor (premultiplied source-over, stencil-keep in a stencil pass). */
export function createEffectCompositeClipPipelineDescriptor(
  module: GPUShaderModule,
  layout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil: boolean,
  shifted: boolean,
): GPURenderPipelineDescriptor {
  return {
    ...createLayerCompositePipelineDescriptor(module, layout, targetFormat, sampleCount, stencil),
    label: `vector-studio/${EFFECT_COMPOSITE_SHADER_KEY}-clip-${stencil ? 'stencil-' : ''}${sampleCount}x${shifted ? SHIFTED_LAYER_VARIANT_SUFFIX : ''}`,
  };
}
