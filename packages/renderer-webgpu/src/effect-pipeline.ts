import {
  E41_BLUR_TAPS_MAX,
  blurLevels,
  type DeviceRect,
  type LayerEffectRecord,
} from '@vector-studio/renderer-core';

import type { PipelineCacheKey } from './pipeline-cache.js';
import type { PrimitiveTargetFormat } from './primitive-pipeline.js';

// E41 contract (docs/plans/d9-e41-boolean-effects-contract.md), unit U5: the effect passes of
// section 5.2 (K4 blur, K5 composite). An effect root's content `L` is its E25 layer texture;
// its result `R` is a texture at its output bound, which the E25 composite pipeline draws into
// the parent target. Between them run single-sample passes of one module: downsample, blur and
// upsample (no blending), and tint and merge (premultiplied source-over). Every pass covers a
// rectangle of its attachment from (0, 0), and its record maps that rectangle to absolute pixel
// coordinates of its level, so regions, levels and offsets are planned on the CPU
// (`planEffectPasses`) and the module only loads texels. A texel outside a source's region
// reads transparent black, as section 5.1's Gaussian has outside the layer.

export const EFFECT_SHADER_KEY = 'e41-effect-v0';
export const EFFECT_LAYOUT_KEY = 'e41-effect-v0';
const EFFECT_VERTEX_LAYOUT_KEY = 'none-3-v0';
const EFFECT_REPLACE_STATE_KEY = 'replace/no-depth/no-cull/triangle-list-v1';
const EFFECT_OVER_STATE_KEY = 'premultiplied-source-over/no-depth/no-cull/triangle-list-v1';
export const EFFECT_BINDINGS = Object.freeze({ source: 0, record: 1 });
/** One pass record; see `packEffectPassRecord`. */
export const EFFECT_PASS_RECORD_SIZE = 80;

const FRAGMENT_VISIBILITY = 0x2;

export type EffectPassKind = 'downsample' | 'blur' | 'upsample' | 'tint' | 'merge';
export const EFFECT_PASS_KINDS: readonly EffectPassKind[] = Object.freeze([
  'downsample',
  'blur',
  'upsample',
  'tint',
  'merge',
]);
/** The passes that blend over their attachment; the others replace it. */
export function effectPassBlends(kind: EffectPassKind): boolean {
  return kind === 'tint' || kind === 'merge';
}

/**
 * The effect module. Record fields, in pixels of the level each names: `srcOrigin` and
 * `srcSize`, the source texture's region (texel 0 is `srcOrigin`); `dstOrigin`, the absolute
 * coordinate of the attachment's texel 0; `dir`, the blur axis; `offset`, a shadow's device
 * offset at level 0; `radius` and `sigma`, the blur's taps per side and σ at the source level;
 * `levelScale`, 2^k for a sample of level k at level-0 pixels; `contentScale`, 1/c for a leaf
 * root's content opacity c (section 5.2); `color`, a shadow's premultiplied colour.
 */
export const EFFECT_SHADER = /* wgsl */ `
struct EffectPass {
  srcOrigin: vec2i,
  srcSize: vec2i,
  dstOrigin: vec2i,
  dir: vec2i,
  offset: vec2f,
  radius: i32,
  levelScale: f32,
  sigma: f32,
  contentScale: f32,
  padding: vec2f,
  color: vec4f,
};

@group(0) @binding(${EFFECT_BINDINGS.source}) var source: texture_2d<f32>;
@group(0) @binding(${EFFECT_BINDINGS.record}) var<uniform> effect: EffectPass;

struct EffectOutput {
  @builtin(position) position: vec4f,
};

@vertex
fn effectVertexMain(@builtin(vertex_index) vertexIndex: u32) -> EffectOutput {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var output: EffectOutput;
  output.position = vec4f(corners[vertexIndex], 0.0, 1.0);
  return output;
}

fn sourceTexel(texel: vec2i) -> vec4f {
  let local = texel - effect.srcOrigin;
  if (any(local < vec2i(0)) || any(local >= effect.srcSize)) {
    return vec4f(0.0);
  }
  return textureLoad(source, local, 0);
}

fn destinationTexel(position: vec4f) -> vec2i {
  return vec2i(floor(position.xy)) + effect.dstOrigin;
}

// Bilinear at a point in the source level's pixel units (texel i spans [i, i + 1)).
fn sourceBilinear(point: vec2f) -> vec4f {
  let base = point - 0.5;
  let cell = floor(base);
  let weight = base - cell;
  let texel = vec2i(cell);
  let top = mix(sourceTexel(texel), sourceTexel(texel + vec2i(1, 0)), weight.x);
  let bottom = mix(sourceTexel(texel + vec2i(0, 1)), sourceTexel(texel + vec2i(1, 1)), weight.x);
  return mix(top, bottom, weight.y);
}

@fragment
fn downsampleMain(input: EffectOutput) -> @location(0) vec4f {
  let texel = destinationTexel(input.position) * 2;
  return 0.25 * (sourceTexel(texel) + sourceTexel(texel + vec2i(1, 0)) +
    sourceTexel(texel + vec2i(0, 1)) + sourceTexel(texel + vec2i(1, 1)));
}

@fragment
fn blurMain(input: EffectOutput) -> @location(0) vec4f {
  let texel = destinationTexel(input.position);
  let radius = min(effect.radius, ${E41_BLUR_TAPS_MAX});
  let denominator = 2.0 * effect.sigma * effect.sigma;
  var sum = vec4f(0.0);
  var total = 0.0;
  for (var tap = -radius; tap <= radius; tap += 1) {
    let distance = f32(tap);
    let weight = exp(-(distance * distance) / denominator);
    sum += weight * sourceTexel(texel + tap * effect.dir);
    total += weight;
  }
  return sum / total;
}

@fragment
fn upsampleMain(input: EffectOutput) -> @location(0) vec4f {
  let pixel = vec2f(destinationTexel(input.position)) + 0.5;
  return sourceBilinear(pixel / effect.levelScale);
}

@fragment
fn tintMain(input: EffectOutput) -> @location(0) vec4f {
  let pixel = vec2f(destinationTexel(input.position)) + 0.5 - effect.offset;
  let alpha = sourceBilinear(pixel / effect.levelScale).a;
  return effect.color * min(alpha * effect.contentScale, 1.0);
}

@fragment
fn mergeMain(input: EffectOutput) -> @location(0) vec4f {
  return min(sourceTexel(destinationTexel(input.position)) * effect.contentScale, vec4f(1.0));
}
`;

export function effectFragmentEntryPoint(kind: EffectPassKind): string {
  return `${kind}Main`;
}

export function createEffectBindGroupLayoutDescriptor(): GPUBindGroupLayoutDescriptor {
  return {
    label: 'vector-studio/e41-effect-layout',
    entries: [
      {
        binding: EFFECT_BINDINGS.source,
        visibility: FRAGMENT_VISIBILITY,
        texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
      },
      {
        binding: EFFECT_BINDINGS.record,
        visibility: FRAGMENT_VISIBILITY,
        buffer: {
          type: 'uniform',
          hasDynamicOffset: true,
          minBindingSize: EFFECT_PASS_RECORD_SIZE,
        },
      },
    ],
  };
}

export function effectPipelineKey(
  targetFormat: PrimitiveTargetFormat,
  kind: EffectPassKind,
): PipelineCacheKey {
  return Object.freeze({
    shaderKey: `${EFFECT_SHADER_KEY}#${kind}`,
    layoutKey: EFFECT_LAYOUT_KEY,
    vertexLayoutKey: EFFECT_VERTEX_LAYOUT_KEY,
    targetFormat,
    renderStateKey: effectPassBlends(kind) ? EFFECT_OVER_STATE_KEY : EFFECT_REPLACE_STATE_KEY,
    sampleCount: 1,
  });
}

/** One pass's pipeline: single-sample, no depth or stencil, replace or source-over. */
export function createEffectPipelineDescriptor(
  module: GPUShaderModule,
  layout: GPUPipelineLayout,
  targetFormat: PrimitiveTargetFormat,
  kind: EffectPassKind,
): GPURenderPipelineDescriptor {
  const over = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } as const;
  return {
    label: `vector-studio/e41-effect-${kind}`,
    layout,
    vertex: { module, entryPoint: 'effectVertexMain', buffers: [] },
    fragment: {
      module,
      entryPoint: effectFragmentEntryPoint(kind),
      targets: [
        {
          format: targetFormat,
          ...(effectPassBlends(kind) ? { blend: { color: over, alpha: over } } : {}),
          writeMask: 0xf,
        },
      ],
    },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    multisample: { count: 1, mask: 0xffffffff, alphaToCoverageEnabled: false },
  };
}

/** The textures a pass reads or writes: `L`, `R` and the two shared scratch textures. */
export type EffectSurface = 'content' | 'result' | 'scratch0' | 'scratch1';

type Point = readonly [number, number];

/** One planned pass. Its attachment region is `width` × `height` texels from (0, 0). */
export type EffectPass = Readonly<{
  kind: EffectPassKind;
  source: EffectSurface;
  target: EffectSurface;
  /** True on the first pass that writes `R`: it clears the attachment. */
  clear: boolean;
  width: number;
  height: number;
  dstOrigin: Point;
  srcOrigin: Point;
  srcSize: Point;
  dir: Point;
  offset: Point;
  radius: number;
  sigma: number;
  levelScale: number;
  contentScale: number;
  /** Premultiplied. */
  color: readonly [number, number, number, number];
}>;

export type EffectPassPlan = Readonly<{
  passes: readonly EffectPass[];
  /** The scratch textures' size, 0 × 0 when no pass uses them. */
  scratch: Readonly<{ width: number; height: number }>;
}>;

/** A region of a level's pixel grid, [x0, x1) × [y0, y1). */
type Region = Readonly<{ x0: number; y0: number; x1: number; y1: number }>;

const NO_COLOR = Object.freeze([0, 0, 0, 0] as const);
const NO_POINT: Point = Object.freeze([0, 0] as const);

/**
 * E41-K4 and K5: the passes that build `R` (at `result`, absolute target pixels) from `L` (at
 * `content`). In list order, each shadow's alpha is downsampled by 2 per level while K4 needs
 * it, blurred horizontally then vertically between the scratch textures, and tinted over `R`
 * at its device offset (sampled bilinearly, upsampled from its level). Then `L` is merged over
 * `R`, and a layer blur runs over `R` in the same way, writing it back. A leaf root's `L`
 * carries its content opacity c; the tint and merge scale by 1/c and the composite applies c
 * (section 5.2's "Leaf roots"), which is section 5.1's result exactly.
 *
 * Regions are exact for every pixel of `R`: a blur pass covers what the next pass reads, and
 * a texel beyond a source's region is transparent, which is what `L` and `R` hold there.
 */
export function planEffectPasses(
  content: DeviceRect,
  result: DeviceRect,
  effect: LayerEffectRecord,
): EffectPassPlan {
  const passes: EffectPass[] = [];
  let scratchWidth = 0;
  let scratchHeight = 0;
  let resultWritten = false;
  const contentScale = 1 / effect.contentOpacity;
  const contentSurface = surfaceOf('content', content);
  const resultSurface = surfaceOf('result', result);
  const push = (pass: Omit<EffectPass, 'clear'>) => {
    let clear = false;
    if (pass.target === 'result') {
      clear = !resultWritten;
      resultWritten = true;
    } else {
      scratchWidth = Math.max(scratchWidth, pass.width);
      scratchHeight = Math.max(scratchHeight, pass.height);
    }
    passes.push(Object.freeze({ ...pass, clear }));
  };
  /**
   * Blurs `from` (level 0) at σ into a scratch texture, for samples over `result` at `offset`;
   * returns the blurred surface and its region and level scale, or null when σ is 0.
   */
  const blur = (
    from: Readonly<{ surface: EffectSurface; region: Region }>,
    sigmaPx: number,
    offset: Point,
  ): Readonly<{ surface: EffectSurface; region: Region; scale: number }> | null => {
    if (!(sigmaPx > 0)) return null;
    const levels = blurLevels(sigmaPx);
    const scale = 2 ** levels;
    const sigma = sigmaPx / scale;
    const radius = Math.min(Math.ceil(3 * sigma), E41_BLUR_TAPS_MAX);
    const sampled = sampledRegion(result, offset, scale);
    // The level-k texels the horizontal pass reads.
    const needed: Region = {
      x0: sampled.x0 - radius,
      y0: sampled.y0 - radius,
      x1: sampled.x1 + radius,
      y1: sampled.y1 + radius,
    };
    const chain: Region[] = [needed];
    for (let level = levels - 1; level >= 1; level -= 1) {
      const above = chain[0]!;
      chain.unshift({ x0: 2 * above.x0, y0: 2 * above.y0, x1: 2 * above.x1, y1: 2 * above.y1 });
    }
    let current = from;
    for (let level = 1; level <= levels; level += 1) {
      const region = chain[level - 1]!;
      const surface: EffectSurface = level % 2 === 1 ? 'scratch0' : 'scratch1';
      push(passOf('downsample', current, surface, region));
      current = { surface, region };
    }
    const horizontal: Region = {
      x0: sampled.x0,
      y0: sampled.y0 - radius,
      x1: sampled.x1,
      y1: sampled.y1 + radius,
    };
    const across: EffectSurface = current.surface === 'scratch0' ? 'scratch1' : 'scratch0';
    push({
      ...passOf('blur', current, across, horizontal),
      dir: [1, 0],
      radius,
      sigma,
    });
    const down: EffectSurface = across === 'scratch0' ? 'scratch1' : 'scratch0';
    push({
      ...passOf('blur', { surface: across, region: horizontal }, down, sampled),
      dir: [0, 1],
      radius,
      sigma,
    });
    return { surface: down, region: sampled, scale };
  };
  for (const shadow of effect.shadows) {
    const offset: Point = [shadow.dx, shadow.dy];
    const blurred = blur(contentSurface, shadow.sigmaPx, offset) ?? {
      ...contentSurface,
      scale: 1,
    };
    const a = shadow.color.a;
    push({
      ...passOf('tint', blurred, 'result', resultSurface.region),
      offset,
      levelScale: blurred.scale,
      contentScale,
      color: [shadow.color.r * a, shadow.color.g * a, shadow.color.b * a, a],
    });
  }
  push({ ...passOf('merge', contentSurface, 'result', resultSurface.region), contentScale });
  if (effect.blurSigmaPx !== null && effect.blurSigmaPx > 0) {
    const sigmaPx = effect.blurSigmaPx;
    const levels = blurLevels(sigmaPx);
    if (levels === 0) {
      // `R` is transparent beyond its bound, so the horizontal pass covers `R` only.
      const sigma = sigmaPx;
      const radius = Math.min(Math.ceil(3 * sigma), E41_BLUR_TAPS_MAX);
      push({
        ...passOf('blur', resultSurface, 'scratch0', resultSurface.region),
        dir: [1, 0],
        radius,
        sigma,
      });
      push({
        ...passOf(
          'blur',
          { surface: 'scratch0', region: resultSurface.region },
          'result',
          resultSurface.region,
        ),
        dir: [0, 1],
        radius,
        sigma,
      });
    } else {
      const blurred = blur(resultSurface, sigmaPx, NO_POINT)!;
      push({
        ...passOf('upsample', blurred, 'result', resultSurface.region),
        levelScale: blurred.scale,
      });
    }
  }
  return Object.freeze({
    passes: Object.freeze(passes),
    scratch: Object.freeze({ width: scratchWidth, height: scratchHeight }),
  });
}

function surfaceOf(
  surface: EffectSurface,
  rect: DeviceRect,
): Readonly<{ surface: EffectSurface; region: Region }> {
  return {
    surface,
    region: { x0: rect.x, y0: rect.y, x1: rect.x + rect.width, y1: rect.y + rect.height },
  };
}

/**
 * The level-k texels that bilinear samples at `(p + 0.5 − offset) / 2^k` read, for the pixels
 * p of `result`: texel i spans [i, i + 1), so a sample at s reads ⌊s − 0.5⌋ and the next.
 */
function sampledRegion(result: DeviceRect, offset: Point, scale: number): Region {
  const low = (pixel: number, shift: number) => Math.floor((pixel + 0.5 - shift) / scale - 0.5);
  return {
    x0: low(result.x, offset[0]),
    y0: low(result.y, offset[1]),
    x1: low(result.x + result.width - 1, offset[0]) + 2,
    y1: low(result.y + result.height - 1, offset[1]) + 2,
  };
}

function passOf(
  kind: EffectPassKind,
  from: Readonly<{ surface: EffectSurface; region: Region }>,
  target: EffectSurface,
  region: Region,
): Omit<EffectPass, 'clear'> {
  return {
    kind,
    source: from.surface,
    target,
    width: region.x1 - region.x0,
    height: region.y1 - region.y0,
    dstOrigin: [region.x0, region.y0],
    srcOrigin: [from.region.x0, from.region.y0],
    srcSize: [from.region.x1 - from.region.x0, from.region.y1 - from.region.y0],
    dir: NO_POINT,
    offset: NO_POINT,
    radius: 0,
    sigma: 0,
    levelScale: 1,
    contentScale: 1,
    color: NO_COLOR,
  };
}

/** A pass record's bytes, as `EffectPass` in the module. */
export function packEffectPassRecord(pass: EffectPass): Uint8Array {
  const bytes = new Uint8Array(EFFECT_PASS_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, pass.srcOrigin[0], true);
  view.setInt32(4, pass.srcOrigin[1], true);
  view.setInt32(8, pass.srcSize[0], true);
  view.setInt32(12, pass.srcSize[1], true);
  view.setInt32(16, pass.dstOrigin[0], true);
  view.setInt32(20, pass.dstOrigin[1], true);
  view.setInt32(24, pass.dir[0], true);
  view.setInt32(28, pass.dir[1], true);
  view.setFloat32(32, pass.offset[0], true);
  view.setFloat32(36, pass.offset[1], true);
  view.setInt32(40, pass.radius, true);
  view.setFloat32(44, pass.levelScale, true);
  view.setFloat32(48, pass.sigma, true);
  view.setFloat32(52, pass.contentScale, true);
  pass.color.forEach((value, index) => view.setFloat32(64 + index * 4, value, true));
  return bytes;
}
