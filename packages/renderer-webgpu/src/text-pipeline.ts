import { CLIP_BLOCK, clipVariantKey, replaceOnce } from './clip-pipeline.js';
import { layerVariantKey, layerVariantSource } from './layer-pipeline.js';
import type { PipelineCacheKey } from './pipeline-cache.js';
import type { PrimitiveTargetFormat } from './primitive-pipeline.js';
import { stencilKeepState } from './primitive-pipeline.js';

// E28 contract (docs/plans/d9-e28-text-glyph-atlas-contract.md), unit U3: the text pipeline and
// its `+clip-v0`, `+layer-v0` and combined variants (section 4, Text pipeline). Group 0 is the
// text group; groups 1 to 3 keep their roles (clip or empty, empty, layer). Existing modules,
// keys and pipelines are untouched (E28-A07).

export const TEXT_SHADER_KEY = 'e28-text-v0';
export const TEXT_LAYOUT_KEY = 'e28-text-v0';
const TEXT_VERTEX_LAYOUT_KEY = 'none-6-v0';
const TEXT_RENDER_STATE_KEY = 'premultiplied-source-over/no-depth/no-cull/triangle-list-v1';
const TEXT_STENCIL_RENDER_STATE_KEY =
  'premultiplied-source-over/stencil8-keep/no-cull/triangle-list-v1';

export const TEXT_BINDINGS = Object.freeze({ instances: 0, page: 1, sampler: 2, target: 3 });
/** The target uniform: the target's size in pixels, and padding. */
export const TEXT_TARGET_SIZE = 16;
/** One instance record: 16 binary32 lanes (E28 section 4, the `text` part). */
export const TEXT_INSTANCE_SIZE = 64;
/** The atlas page format (section 4, Atlas pages). */
export const TEXT_PAGE_FORMAT = 'r8unorm';

const FRAGMENT_VISIBILITY = 0x2;
const VERTEX_VISIBILITY = 0x1;

/**
 * The text module. An instance is four `vec4f`: the quad origin and x axis, the y axis and the
 * entry's texel origin, the texel size, page and mode, and the premultiplied colour, in target
 * pixels. The vertex stage draws the quad `origin + s·axisX + t·axisY` through the target-sized
 * viewport (a layer tile pass shifts the viewport, as E25 does). The fragment stage reads
 * coverage: in snapped mode (E28-K3) the quad lies on whole pixels with unit axes, so the pixel
 * at `floor(position − origin)` reads exactly that texel; in general mode the bitmap point is
 * interpolated and sampled bilinearly at level 0, clamped to the entry's rect inset by half a
 * texel so no neighbouring entry is read. The output is the colour times coverage (E28-K5).
 */
export const TEXT_SHADER = /* wgsl */ `
struct TextTarget {
  size: vec2f,
  padding: vec2f,
};

@group(0) @binding(${TEXT_BINDINGS.instances}) var<storage, read> textInstances: array<vec4f>;
@group(0) @binding(${TEXT_BINDINGS.page}) var textPage: texture_2d<f32>;
@group(0) @binding(${TEXT_BINDINGS.sampler}) var textSampler: sampler;
@group(0) @binding(${TEXT_BINDINGS.target}) var<uniform> textTarget: TextTarget;

struct TextVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) bitmap: vec2f,
  @location(1) @interpolate(flat) instance: u32,
};

@vertex
fn textVertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> TextVertexOutput {
  var corners = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vertexIndex];
  let base = instanceIndex * 4u;
  let head = textInstances[base];
  let axisY = textInstances[base + 1u].xy;
  let rect = textInstances[base + 2u];
  let pixel = head.xy + corner.x * head.zw + corner.y * axisY;
  let ndc = pixel / textTarget.size * 2.0 - 1.0;
  var output: TextVertexOutput;
  output.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
  output.bitmap = corner * rect.xy;
  output.instance = instanceIndex;
  return output;
}

fn textCoverage(input: TextVertexOutput) -> f32 {
  let base = input.instance * 4u;
  let origin = textInstances[base].xy;
  let texel = textInstances[base + 1u].zw;
  let rect = textInstances[base + 2u];
  let size = rect.xy;
  if (rect.w == 0.0) {
    let local = clamp(floor(input.position.xy - origin), vec2f(0.0), size - 1.0);
    return textureLoad(textPage, vec2i(texel + local), 0).r;
  }
  let point = clamp(input.bitmap, vec2f(0.5), max(size - 0.5, vec2f(0.5)));
  let pageSize = vec2f(textureDimensions(textPage));
  return textureSampleLevel(textPage, textSampler, (texel + point) / pageSize, 0.0).r;
}

@fragment
fn textFragmentMain(input: TextVertexOutput) -> @location(0) vec4f {
  let color = textInstances[input.instance * 4u + 3u];
  return color * textCoverage(input);
}
`;

const TEXT_FRAGMENT_HEADER =
  '@fragment\nfn textFragmentMain(input: TextVertexOutput) -> @location(0) vec4f {';

/** E28-K8: the text module wrapped by the clip block, contribution × K_n. */
export const TEXT_CLIP_SHADER = `${replaceOnce(
  TEXT_SHADER,
  TEXT_FRAGMENT_HEADER,
  'fn shadeText(input: TextVertexOutput) -> vec4f {',
)}${CLIP_BLOCK}
@fragment
fn textFragmentMain(input: TextVertexOutput) -> @location(0) vec4f {
  let clip = clipCoverage(input.position.xy);
  return shadeText(input) * clip;
}
`;

/** E28-K8: the layer variants, each position read shifted by the pass's `layerPass.shift`. */
export const TEXT_LAYER_SHADER = layerVariantSource(TEXT_SHADER);
export const TEXT_CLIP_LAYER_SHADER = layerVariantSource(TEXT_CLIP_SHADER);

/** The variants the scene creates: plain, clip, layer and both. */
export type TextVariant = 'plain' | 'clip' | 'layer' | 'clip-layer';
export const TEXT_VARIANTS: readonly TextVariant[] = Object.freeze([
  'plain',
  'clip',
  'layer',
  'clip-layer',
]);

export function textVariantSource(variant: TextVariant): string {
  switch (variant) {
    case 'plain':
      return TEXT_SHADER;
    case 'clip':
      return TEXT_CLIP_SHADER;
    case 'layer':
      return TEXT_LAYER_SHADER;
    case 'clip-layer':
      return TEXT_CLIP_LAYER_SHADER;
  }
}

export function textPipelineKey(
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil: boolean,
  variant: TextVariant = 'plain',
): PipelineCacheKey {
  const base: PipelineCacheKey = Object.freeze({
    shaderKey: TEXT_SHADER_KEY,
    layoutKey: TEXT_LAYOUT_KEY,
    vertexLayoutKey: TEXT_VERTEX_LAYOUT_KEY,
    targetFormat,
    renderStateKey: stencil ? TEXT_STENCIL_RENDER_STATE_KEY : TEXT_RENDER_STATE_KEY,
    sampleCount,
  });
  switch (variant) {
    case 'plain':
      return base;
    case 'clip':
      return clipVariantKey(base);
    case 'layer':
      return layerVariantKey(base);
    case 'clip-layer':
      return layerVariantKey(clipVariantKey(base));
  }
}

/** Group 0: the instance storage, one atlas page, the sampler and the target uniform. */
export function createTextBindGroupLayoutDescriptor(): GPUBindGroupLayoutDescriptor {
  return {
    label: 'vector-studio/e28-text-layout',
    entries: [
      {
        binding: TEXT_BINDINGS.instances,
        visibility: VERTEX_VISIBILITY | FRAGMENT_VISIBILITY,
        buffer: { type: 'read-only-storage', minBindingSize: TEXT_INSTANCE_SIZE },
      },
      {
        binding: TEXT_BINDINGS.page,
        visibility: FRAGMENT_VISIBILITY,
        texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
      },
      {
        binding: TEXT_BINDINGS.sampler,
        visibility: FRAGMENT_VISIBILITY,
        sampler: { type: 'filtering' },
      },
      {
        binding: TEXT_BINDINGS.target,
        visibility: VERTEX_VISIBILITY,
        buffer: { type: 'uniform', minBindingSize: TEXT_TARGET_SIZE },
      },
    ],
  };
}

/** The renderer's first sampler: bilinear, clamped to the edge, level 0 only. */
export function createTextSamplerDescriptor(): GPUSamplerDescriptor {
  return {
    label: 'vector-studio/e28-text-sampler',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
  };
}

/**
 * A text pipeline: no vertex buffers, premultiplied source-over (P1 D2), and the stencil-keep
 * state when the scene's passes have the write-once stencil attachment (text never writes it).
 */
export function createTextPipelineDescriptor(
  module: GPUShaderModule,
  layout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  sampleCount: 1 | 4,
  stencil: boolean,
  variant: TextVariant = 'plain',
): GPURenderPipelineDescriptor {
  const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } as const;
  const suffix =
    variant === 'plain'
      ? ''
      : variant === 'clip'
        ? '+clip-v0'
        : variant === 'layer'
          ? '+layer-v0'
          : '+clip-v0+layer-v0';
  return {
    label: `vector-studio/e28-text-${stencil ? 'stencil-' : ''}${sampleCount}x${suffix}`,
    layout,
    vertex: { module, entryPoint: 'textVertexMain', buffers: [] },
    fragment: {
      module,
      entryPoint: 'textFragmentMain',
      targets: [{ format: targetFormat, blend: { color: blend, alpha: blend }, writeMask: 0xf }],
    },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    ...(stencil ? { depthStencil: stencilKeepState() } : {}),
    multisample: { count: sampleCount, mask: 0xffffffff, alphaToCoverageEnabled: false },
  };
}

/** The target uniform's bytes. */
export function packTextTarget(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(TEXT_TARGET_SIZE);
  const view = new DataView(bytes.buffer);
  view.setFloat32(0, width, true);
  view.setFloat32(4, height, true);
  return bytes;
}
