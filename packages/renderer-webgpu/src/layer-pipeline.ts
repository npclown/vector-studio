import {
  MESH_FILL_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_CLIP_SHADER,
  clipVariantKey,
} from './clip-pipeline.js';
import { MESH_FILL_SHADER } from './mesh-fill-shader.js';
import {
  MESH_FILL_PAINT_CLIP_SHADER,
  MESH_FILL_PAINT_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER,
  PRIMITIVE_ANALYTIC_PAINT_SHADER,
  paintClipVariantKey,
  paintVariantKey,
} from './paint-pipeline.js';
import type { PipelineCacheKey } from './pipeline-cache.js';
import type { PrimitiveTargetFormat } from './primitive-pipeline.js';
import { stencilKeepState } from './primitive-pipeline.js';

// E25 contract (docs/plans/d9-e25-isolated-opacity-contract.md), unit U3: the layer pipeline
// variants and the composite pipeline. A layer variant is its module with every fragment read of
// `@builtin(position)` shifted by the pass's `layerShift`, the layer bind group at group 3, so
// a draw inside a layer tile shades exactly as in the main pass (section 4, Layer pipeline
// variants). Base, clip and paint modules, keys and pipelines are untouched (E25-A08).

export const LAYER_VARIANT_SUFFIX = '+layer-v0';
export const LAYER_LAYOUT_KEY = 'e25-layer-v0';
export const LAYER_BIND_GROUP_INDEX = 3;
/** The adapter limit the layer pipeline needs: groups 0 to 3. */
export const LAYER_REQUIRED_BIND_GROUPS = 4;
/**
 * One pass record: `shift` (B_g origin plus tile offset; 0 in the main pass) and the target's
 * size. A layer tile pass sets its viewport to the target's size at `−shift`, as E22-R1 does, so
 * vertex stages are unchanged and the composite's vertex stage maps target pixels.
 */
export const LAYER_PASS_RECORD_SIZE = 16;
/** One composite record: the child layer's origin and size, and its opacity. */
export const LAYER_COMPOSITE_RECORD_SIZE = 32;
export const LAYER_COMPOSITE_BINDINGS = Object.freeze({ layer: 0, record: 1 });
export const LAYER_COMPOSITE_SHADER_KEY = 'e25-layer-composite-v0';
export const LAYER_COMPOSITE_LAYOUT_KEY = 'e25-layer-composite-v0';
const LAYER_COMPOSITE_VERTEX_LAYOUT_KEY = 'none-6-v0';
const LAYER_COMPOSITE_RENDER_STATE_KEY =
  'premultiplied-source-over/no-depth/no-cull/triangle-list-v1';
const LAYER_COMPOSITE_STENCIL_RENDER_STATE_KEY =
  'premultiplied-source-over/stencil8-keep/no-cull/triangle-list-v1';

const FRAGMENT_VISIBILITY = 0x2;
const VERTEX_VISIBILITY = 0x1;

/** The layer block: the pass record, bound at a dynamic offset per layer tile pass. */
export const LAYER_BLOCK = /* wgsl */ `
struct LayerPass {
  shift: vec2f,
  size: vec2f,
};

@group(${LAYER_BIND_GROUP_INDEX}) @binding(0) var<uniform> layerPass: LayerPass;
`;

const POSITION_READ = 'input.position.xy';

/**
 * A layer variant's source: every fragment read of the pixel position, `input.position.xy`,
 * becomes `(input.position.xy + layerPass.shift)`, and the layer block is appended. The shift
 * is uniform, so derivatives are unchanged; it is a whole even number of pixels, and pixel
 * centres are half-integers, so the sum is exact in binary32 for any target size.
 */
export function layerVariantSource(source: string): string {
  const parts = source.split(POSITION_READ);
  if (parts.length < 2) {
    throw new Error('Layer variant: the module reads no fragment position.');
  }
  return `${parts.join(`(${POSITION_READ} + layerPass.shift)`)}${LAYER_BLOCK}`;
}

/** Section 4: analytic with clip; with paint, without and with clip. */
export const PRIMITIVE_ANALYTIC_CLIP_LAYER_SHADER = layerVariantSource(
  PRIMITIVE_ANALYTIC_CLIP_SHADER,
);
export const PRIMITIVE_ANALYTIC_PAINT_LAYER_SHADER = layerVariantSource(
  PRIMITIVE_ANALYTIC_PAINT_SHADER,
);
export const PRIMITIVE_ANALYTIC_PAINT_CLIP_LAYER_SHADER = layerVariantSource(
  PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER,
);
/** Section 4: mesh fill and joint (one module each), without and with clip and paint. */
export const MESH_FILL_LAYER_SHADER = layerVariantSource(MESH_FILL_SHADER);
export const MESH_FILL_CLIP_LAYER_SHADER = layerVariantSource(MESH_FILL_CLIP_SHADER);
export const MESH_FILL_PAINT_LAYER_SHADER = layerVariantSource(MESH_FILL_PAINT_SHADER);
export const MESH_FILL_PAINT_CLIP_LAYER_SHADER = layerVariantSource(MESH_FILL_PAINT_CLIP_SHADER);

/** A layer variant's cache key: the variant's key with the layer suffixes. */
export function layerVariantKey(base: PipelineCacheKey): PipelineCacheKey {
  return Object.freeze({
    ...base,
    shaderKey: `${base.shaderKey}${LAYER_VARIANT_SUFFIX}`,
    layoutKey: `${base.layoutKey}+${LAYER_LAYOUT_KEY}`,
  });
}

/** The kinds of layer variant the scene draws with, by their non-layer key. */
export type LayerVariantBase = 'clip' | 'paint' | 'paint-clip' | 'plain';
export function layerVariantBaseKey(
  base: PipelineCacheKey,
  kind: LayerVariantBase,
): PipelineCacheKey {
  switch (kind) {
    case 'clip':
      return layerVariantKey(clipVariantKey(base));
    case 'paint':
      return layerVariantKey(paintVariantKey(base));
    case 'paint-clip':
      return layerVariantKey(paintClipVariantKey(base));
    case 'plain':
      return layerVariantKey(base);
  }
}

/** Group 3: the pass record, at a dynamic offset (one record per layer tile pass). */
export function createLayerBindGroupLayoutDescriptor(): GPUBindGroupLayoutDescriptor {
  return {
    label: 'vector-studio/e25-layer-layout',
    entries: [
      {
        binding: 0,
        visibility: FRAGMENT_VISIBILITY | VERTEX_VISIBILITY,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: LAYER_PASS_RECORD_SIZE,
        },
      },
    ],
  };
}

/**
 * The composite module (section 4, Composite pipeline). The vertex stage draws the child's
 * bound `B_child` as two triangles in target pixels, through the pass's target-sized viewport.
 * The fragment stage loads the child's layer texel at the target pixel (the attachment pixel
 * plus `layerPass.shift`) and scales it by the opacity; the bound is whole pixels, so every
 * sample of a covered pixel receives the pixel's value at 4x.
 */
export const LAYER_COMPOSITE_SHADER = /* wgsl */ `
struct CompositeRecord {
  origin: vec2f,
  size: vec2f,
  alpha: f32,
  padding0: f32,
  padding1: vec2f,
};

@group(0) @binding(${LAYER_COMPOSITE_BINDINGS.layer}) var layerTexture: texture_2d<f32>;
@group(0) @binding(${LAYER_COMPOSITE_BINDINGS.record}) var<uniform> composite: CompositeRecord;

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

@fragment
fn compositeFragmentMain(input: CompositeOutput) -> @location(0) vec4f {
  let texel = vec2i(floor(input.position.xy + layerPass.shift - composite.origin));
  return composite.alpha * textureLoad(layerTexture, texel, 0);
}
${LAYER_BLOCK}`;

export function createLayerCompositeBindGroupLayoutDescriptor(): GPUBindGroupLayoutDescriptor {
  return {
    label: 'vector-studio/e25-layer-composite-layout',
    entries: [
      {
        binding: LAYER_COMPOSITE_BINDINGS.layer,
        visibility: FRAGMENT_VISIBILITY,
        texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
      },
      {
        binding: LAYER_COMPOSITE_BINDINGS.record,
        visibility: FRAGMENT_VISIBILITY | VERTEX_VISIBILITY,
        buffer: { type: 'uniform', minBindingSize: LAYER_COMPOSITE_RECORD_SIZE },
      },
    ],
  };
}

export function layerCompositePipelineKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil: boolean,
): PipelineCacheKey {
  return Object.freeze({
    shaderKey: LAYER_COMPOSITE_SHADER_KEY,
    layoutKey: `${LAYER_COMPOSITE_LAYOUT_KEY}+${LAYER_LAYOUT_KEY}`,
    vertexLayoutKey: LAYER_COMPOSITE_VERTEX_LAYOUT_KEY,
    targetFormat,
    renderStateKey: stencil
      ? LAYER_COMPOSITE_STENCIL_RENDER_STATE_KEY
      : LAYER_COMPOSITE_RENDER_STATE_KEY,
    sampleCount,
  });
}

/**
 * The composite pipeline: premultiplied source-over (P1 D2), with the stencil-keep state when
 * the pass it draws in has the write-once stencil attachment, as the analytic pipeline chooses.
 */
export function createLayerCompositePipelineDescriptor(
  module: GPUShaderModule,
  layout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil: boolean,
): GPURenderPipelineDescriptor {
  const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } as const;
  return {
    label: `vector-studio/e25-layer-composite-${stencil ? 'stencil-' : ''}${sampleCount}x`,
    layout,
    vertex: { module, entryPoint: 'compositeVertexMain', buffers: [] },
    fragment: {
      module,
      entryPoint: 'compositeFragmentMain',
      targets: [{ format: targetFormat, blend: { color: blend, alpha: blend }, writeMask: 0xf }],
    },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    ...(stencil ? { depthStencil: stencilKeepState() } : {}),
    multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
  };
}

/** A pass record's bytes: the shift and the attachment size, as binary32. */
export function packLayerPassRecord(
  shift: Readonly<{ x: number; y: number }>,
  size: Readonly<{ width: number; height: number }>,
): Uint8Array {
  const bytes = new Uint8Array(LAYER_PASS_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  view.setFloat32(0, shift.x, true);
  view.setFloat32(4, shift.y, true);
  view.setFloat32(8, size.width, true);
  view.setFloat32(12, size.height, true);
  return bytes;
}

/** A composite record's bytes: the child's origin and size, and its opacity. */
export function packLayerCompositeRecord(
  bound: Readonly<{ x: number; y: number; width: number; height: number }>,
  alpha: number,
): Uint8Array {
  const bytes = new Uint8Array(LAYER_COMPOSITE_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  view.setFloat32(0, bound.x, true);
  view.setFloat32(4, bound.y, true);
  view.setFloat32(8, bound.width, true);
  view.setFloat32(12, bound.height, true);
  view.setFloat32(16, alpha, true);
  return bytes;
}
