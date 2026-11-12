import type { BlendRootMode } from '@vector-studio/renderer-core';
import { CLIP_BLOCK, CLIP_LAYOUT_KEY, CLIP_VARIANT_SUFFIX, replaceOnce } from './clip-pipeline.js';
import {
  LAYER_BLOCK,
  LAYER_COMPOSITE_RECORD_SIZE,
  LAYER_LAYOUT_KEY,
  LAYER_VARIANT_SUFFIX,
} from './layer-pipeline.js';
import type { PipelineCacheKey } from './pipeline-cache.js';
import { stencilKeepState, type PrimitiveTargetFormat } from './primitive-pipeline.js';
import { SHIFTED_LAYER_VARIANT_SUFFIX, shiftedVertexStages } from './shifted-layer-pipeline.js';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-K5: the blend composite. A
// blend root's `R` (its layer, or an effect root's result) is drawn into its parent target over
// the backdrop snapshot of that target (K4) with V35-R2: W3C Compositing Level 1 blending on
// encoded sRGB, straight-alpha colour. The fragment reads `R` and the backdrop at the same device
// pixel and writes the blended premultiplied result with blending off (`one, zero`); a clip or
// mask coverage `c` mixes in the shader, `c · blended + (1 − c) · backdrop`, and a fragment
// where `αs · c = 0` is discarded, so pixels `R` does not cover keep their samples. One module
// holds the 15 non-normal modes, selected by the record's `mode`. Variants follow E41-K5: plain
// and clip, each for the main pass and E25 layer passes (one module, the pass record's shift is
// 0 in the main pass) and shifted for passes inside an effect root's `L` (E41 U5b), each with
// or without the stencil-keep state of the scene's passes.

export const BLEND_COMPOSITE_SHADER_KEY = 'v35-blend-composite-v0';
export const BLEND_COMPOSITE_LAYOUT_KEY = 'v35-blend-composite-v0';
export const BLEND_COMPOSITE_BINDINGS = Object.freeze({ layer: 0, record: 1, backdrop: 2 });
/**
 * One record: E25's composite record (origin, size, alpha at the same offsets, so a blend root
 * can fall back to E25's composite on the same bytes), the mode and the backdrop's origin.
 */
export const BLEND_COMPOSITE_RECORD_SIZE = LAYER_COMPOSITE_RECORD_SIZE;
const BLEND_COMPOSITE_VERTEX_LAYOUT_KEY = 'none-6-v0';
const BLEND_COMPOSITE_RENDER_STATE_KEY = 'replace/no-depth/no-cull/triangle-list-v1';
const BLEND_COMPOSITE_STENCIL_RENDER_STATE_KEY = 'replace/stencil8-keep/no-cull/triangle-list-v1';

/** The record's mode numbers, in V35-S2's order. */
export const BLEND_MODE_INDEX: Readonly<Record<BlendRootMode, number>> = Object.freeze({
  multiply: 1,
  screen: 2,
  overlay: 3,
  darken: 4,
  lighten: 5,
  colorDodge: 6,
  colorBurn: 7,
  hardLight: 8,
  softLight: 9,
  difference: 10,
  exclusion: 11,
  hue: 12,
  saturation: 13,
  color: 14,
  luminosity: 15,
});

const FRAGMENT_VISIBILITY = 0x2;
const VERTEX_VISIBILITY = 0x1;

/** W3C Compositing Level 1, section 10: B(Cb, Cs) for each mode, on straight colour in [0, 1]. */
export const BLEND_FUNCTIONS = /* wgsl */ `
fn blendHardLight(cb: vec3f, cs: vec3f) -> vec3f {
  let low = cb * (2.0 * cs);
  let high2 = 2.0 * cs - 1.0;
  let high = cb + high2 - cb * high2;
  return select(high, low, cs <= vec3f(0.5));
}

fn blendColorDodge(cb: vec3f, cs: vec3f) -> vec3f {
  let ratio = min(vec3f(1.0), cb / max(1.0 - cs, vec3f(1e-12)));
  return select(select(ratio, vec3f(1.0), cs >= vec3f(1.0)), vec3f(0.0), cb <= vec3f(0.0));
}

fn blendColorBurn(cb: vec3f, cs: vec3f) -> vec3f {
  let ratio = 1.0 - min(vec3f(1.0), (1.0 - cb) / max(cs, vec3f(1e-12)));
  return select(select(ratio, vec3f(0.0), cs <= vec3f(0.0)), vec3f(1.0), cb >= vec3f(1.0));
}

fn blendSoftLight(cb: vec3f, cs: vec3f) -> vec3f {
  let d = select(sqrt(cb), ((16.0 * cb - 12.0) * cb + 4.0) * cb, cb <= vec3f(0.25));
  let low = cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
  let high = cb + (2.0 * cs - 1.0) * (d - cb);
  return select(high, low, cs <= vec3f(0.5));
}

fn blendLum(c: vec3f) -> f32 {
  return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b;
}

fn blendClipColor(c: vec3f) -> vec3f {
  let l = blendLum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  var result = c;
  if (n < 0.0) {
    result = l + (result - l) * l / (l - n);
  }
  if (x > 1.0) {
    result = l + (result - l) * (1.0 - l) / (x - l);
  }
  return result;
}

fn blendSetLum(c: vec3f, l: f32) -> vec3f {
  return blendClipColor(c + (l - blendLum(c)));
}

fn blendSat(c: vec3f) -> f32 {
  return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
}

fn blendSetSat(c: vec3f, s: f32) -> vec3f {
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  if (x > n) {
    return (c - n) * s / (x - n);
  }
  return vec3f(0.0);
}

fn blendColor(mode: u32, cb: vec3f, cs: vec3f) -> vec3f {
  switch (mode) {
    case 1u: { return cb * cs; }
    case 2u: { return cb + cs - cb * cs; }
    case 3u: { return blendHardLight(cs, cb); }
    case 4u: { return min(cb, cs); }
    case 5u: { return max(cb, cs); }
    case 6u: { return blendColorDodge(cb, cs); }
    case 7u: { return blendColorBurn(cb, cs); }
    case 8u: { return blendHardLight(cb, cs); }
    case 9u: { return blendSoftLight(cb, cs); }
    case 10u: { return abs(cb - cs); }
    case 11u: { return cb + cs - 2.0 * cb * cs; }
    case 12u: { return blendSetLum(blendSetSat(cs, blendSat(cb)), blendLum(cb)); }
    case 13u: { return blendSetLum(blendSetSat(cb, blendSat(cs)), blendLum(cb)); }
    case 14u: { return blendSetLum(cs, blendLum(cb)); }
    case 15u: { return blendSetLum(cb, blendLum(cs)); }
    default: { return cs; }
  }
}
`;

const PLAIN_FRAGMENT_ENTRY = `@fragment
fn compositeFragmentMain(input: CompositeOutput) -> @location(0) vec4f {
  return shadeBlend(input, 1.0);
}
`;

/**
 * The plain module. The vertex stage is E25's composite's (the same text, so the shifted
 * rewrite applies to it); the fragment stage loads `R` scaled by the record's alpha and the
 * backdrop at the target pixel (the attachment pixel plus `layerPass.shift`).
 */
export const BLEND_COMPOSITE_SHADER = /* wgsl */ `
struct BlendRecord {
  origin: vec2f,
  size: vec2f,
  alpha: f32,
  mode: u32,
  backdropOrigin: vec2f,
};

@group(0) @binding(${BLEND_COMPOSITE_BINDINGS.layer}) var layerTexture: texture_2d<f32>;
@group(0) @binding(${BLEND_COMPOSITE_BINDINGS.record}) var<uniform> composite: BlendRecord;
@group(0) @binding(${BLEND_COMPOSITE_BINDINGS.backdrop}) var backdropTexture: texture_2d<f32>;

struct CompositeOutput {
  @builtin(position) position: vec4f,
};

@vertex
fn compositeVertexMain(@builtin(vertex_index) vertexIndex: u32) -> CompositeOutput {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let pixel = composite.origin + corners[vertexIndex] * composite.size;
  let ndc = pixel / layerPass.size * 2.0 - 1.0;
  var output: CompositeOutput;
  output.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  return output;
}
${BLEND_FUNCTIONS}
/** V35-R2 at one pixel, mixed with the backdrop by the coverage; discarded where αs · c = 0. */
fn shadeBlend(input: CompositeOutput, coverage: f32) -> vec4f {
  let pixel = floor(input.position.xy + layerPass.shift);
  let source = composite.alpha * textureLoad(layerTexture, vec2i(pixel - composite.origin), 0);
  if (source.a * coverage <= 0.0) {
    discard;
  }
  let backdrop = textureLoad(backdropTexture, vec2i(pixel - composite.backdropOrigin), 0);
  let alphaS = source.a;
  let alphaB = backdrop.a;
  let cs = clamp(source.rgb / alphaS, vec3f(0.0), vec3f(1.0));
  let cb = select(vec3f(0.0), clamp(backdrop.rgb / max(alphaB, 1e-12), vec3f(0.0), vec3f(1.0)), alphaB > 0.0);
  let mixed = blendColor(composite.mode, cb, cs);
  let blended = vec4f(
    alphaS * (1.0 - alphaB) * cs + alphaS * alphaB * mixed + (1.0 - alphaS) * backdrop.rgb,
    alphaS + alphaB * (1.0 - alphaS),
  );
  return coverage * blended + (1.0 - coverage) * backdrop;
}

${PLAIN_FRAGMENT_ENTRY}${LAYER_BLOCK}`;

/** The clip variant: the coverage of P4-K1 at the target pixel, taken before any discard. */
export const BLEND_COMPOSITE_CLIP_SHADER = `${replaceOnce(
  BLEND_COMPOSITE_SHADER,
  PLAIN_FRAGMENT_ENTRY,
  '',
)}${CLIP_BLOCK}
@fragment
fn compositeFragmentMain(input: CompositeOutput) -> @location(0) vec4f {
  let coverage = clipCoverage(input.position.xy + layerPass.shift);
  return shadeBlend(input, coverage);
}
`;

/** The shifted forms, for passes that map their tile through the vertex stage (E41 U5b). */
export const BLEND_COMPOSITE_SHIFTED_SHADER = shiftedVertexStages(BLEND_COMPOSITE_SHADER);
export const BLEND_COMPOSITE_CLIP_SHIFTED_SHADER = shiftedVertexStages(BLEND_COMPOSITE_CLIP_SHADER);

/** The variants: {plain, clip} × {E25 pass (main and layer), shifted}. */
export type BlendCompositeVariant = 'plain' | 'clip' | 'shifted' | 'clip-shifted';
export const BLEND_COMPOSITE_VARIANTS: readonly BlendCompositeVariant[] = Object.freeze([
  'plain',
  'clip',
  'shifted',
  'clip-shifted',
]);

export function blendCompositeVariantSource(variant: BlendCompositeVariant): string {
  switch (variant) {
    case 'plain':
      return BLEND_COMPOSITE_SHADER;
    case 'clip':
      return BLEND_COMPOSITE_CLIP_SHADER;
    case 'shifted':
      return BLEND_COMPOSITE_SHIFTED_SHADER;
    case 'clip-shifted':
      return BLEND_COMPOSITE_CLIP_SHIFTED_SHADER;
  }
}

export function blendCompositePipelineKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil: boolean,
  variant: BlendCompositeVariant,
): PipelineCacheKey {
  const clipped = variant === 'clip' || variant === 'clip-shifted';
  const shifted = variant === 'shifted' || variant === 'clip-shifted';
  return Object.freeze({
    shaderKey: `${BLEND_COMPOSITE_SHADER_KEY}${clipped ? CLIP_VARIANT_SUFFIX : ''}${
      shifted ? `${LAYER_VARIANT_SUFFIX}${SHIFTED_LAYER_VARIANT_SUFFIX}` : ''
    }`,
    layoutKey: `${BLEND_COMPOSITE_LAYOUT_KEY}+${LAYER_LAYOUT_KEY}${clipped ? `+${CLIP_LAYOUT_KEY}` : ''}`,
    vertexLayoutKey: BLEND_COMPOSITE_VERTEX_LAYOUT_KEY,
    targetFormat,
    renderStateKey: stencil
      ? BLEND_COMPOSITE_STENCIL_RENDER_STATE_KEY
      : BLEND_COMPOSITE_RENDER_STATE_KEY,
    sampleCount,
  });
}

/** Group 0: `R`, the record and the backdrop snapshot. */
export function createBlendCompositeBindGroupLayoutDescriptor(): GPUBindGroupLayoutDescriptor {
  return {
    label: 'vector-studio/v35-blend-composite-layout',
    entries: [
      {
        binding: BLEND_COMPOSITE_BINDINGS.layer,
        visibility: FRAGMENT_VISIBILITY,
        texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
      },
      {
        binding: BLEND_COMPOSITE_BINDINGS.record,
        visibility: FRAGMENT_VISIBILITY | VERTEX_VISIBILITY,
        buffer: { type: 'uniform', minBindingSize: BLEND_COMPOSITE_RECORD_SIZE },
      },
      {
        binding: BLEND_COMPOSITE_BINDINGS.backdrop,
        visibility: FRAGMENT_VISIBILITY,
        texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
      },
    ],
  };
}

/** Blending off: the fragment writes the composited value (V35-K5). */
export function createBlendCompositePipelineDescriptor(
  module: GPUShaderModule,
  layout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil: boolean,
  variant: BlendCompositeVariant,
): GPURenderPipelineDescriptor {
  return {
    label: `vector-studio/${BLEND_COMPOSITE_SHADER_KEY}-${variant}-${stencil ? 'stencil-' : ''}${sampleCount}x`,
    layout,
    vertex: { module, entryPoint: 'compositeVertexMain', buffers: [] },
    fragment: {
      module,
      entryPoint: 'compositeFragmentMain',
      targets: [{ format: targetFormat, writeMask: 0xf }],
    },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    ...(stencil ? { depthStencil: stencilKeepState() } : {}),
    multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
  };
}

/** A record's bytes: E25's composite record, the mode and the backdrop origin. */
export function packBlendCompositeRecord(
  bound: Readonly<{ x: number; y: number; width: number; height: number }>,
  alpha: number,
  mode: BlendRootMode,
  backdropOrigin: Readonly<{ x: number; y: number }>,
): Uint8Array {
  const bytes = new Uint8Array(BLEND_COMPOSITE_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  view.setFloat32(0, bound.x, true);
  view.setFloat32(4, bound.y, true);
  view.setFloat32(8, bound.width, true);
  view.setFloat32(12, bound.height, true);
  view.setFloat32(16, alpha, true);
  view.setUint32(20, BLEND_MODE_INDEX[mode], true);
  view.setFloat32(24, backdropOrigin.x, true);
  view.setFloat32(28, backdropOrigin.y, true);
  return bytes;
}
