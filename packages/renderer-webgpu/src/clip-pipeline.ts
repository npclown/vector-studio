import type { ClipPacketPart } from '@vector-studio/renderer-core';

import {
  MESH_FILL_SHADER,
  MESH_FILL_SHADER_KEY,
  MESH_JOINT_SHADER_KEY,
} from './mesh-fill-shader.js';
import type { PipelineCacheKey } from './pipeline-cache.js';
import {
  PRIMITIVE_ANALYTIC_SHADER,
  PRIMITIVE_ANALYTIC_SHADER_KEY,
} from './primitive-analytic-shader.js';

// P4 contract (docs/plans/p4-clip-mask.md), unit U3: the rect-clip pipeline variants. Each
// variant is its base module with the fragment entry point wrapped by the clip block, under its
// own shader key and a pipeline layout with the clip bind group at group 1. The base modules,
// keys and pipelines are untouched (P4-A09); an unclipped draw always uses a base pipeline.

export const CLIP_VARIANT_SUFFIX = '+clip-v0';
export const CLIP_LAYOUT_KEY = 'p4-clip-v0';
export const CLIP_BIND_GROUP_INDEX = 1;
/** SCENE_MAX_CLIP_DEPTH: a chain has at most 32 rect levels. */
export const CLIP_MAX_RECTS = 32;
export const CLIP_FRAME_SIZE = 16;
export const CLIP_RECT_SIZE = 32;
/** U4: the state header, rect count, mask flag, mask texel offset and pixel shift. */
export const CLIP_STATE_HEADER_SIZE = 32;
/** The state record: the header and the fixed rect array. */
export const CLIP_STATE_SIZE = CLIP_STATE_HEADER_SIZE + CLIP_MAX_RECTS * CLIP_RECT_SIZE;

export const CLIP_BINDINGS = Object.freeze({ frame: 0, state: 1, mask: 2 });

const FRAGMENT_VISIBILITY = 0x2;

/**
 * The clip block. `clipCoverage` is P4-K1 for every rect level of the draw's state, multiplied:
 * P1's signed rectangle distance at radius 0 (the radius-0 terms of `roundedRectangleDistance`,
 * in the same order) and P1's `analyticCoverage` rule. The pixel, shifted by the state's pixel
 * shift into target pixels (non-zero only in a mask pass, whose attachment covers the level's
 * device rect), is mapped to the world through the camera rebased to the packet origin, then
 * into each rect's frame; the loop bound is read from a uniform, so `fwidth` stays in uniform
 * control flow. U4: a state with a mask multiplies by its mask texture's texel at the pixel
 * plus the state's texel offset, and by 0 outside the texture.
 */
export const CLIP_BLOCK = /* wgsl */ `
struct ClipFrame {
  cameraMinusOrigin: vec2f,
  pixelSize: f32,
  padding: f32,
};

struct ClipRect {
  linear: vec4f,
  translation: vec2f,
  size: vec2f,
};

struct ClipState {
  rectCount: u32,
  hasMask: u32,
  maskOffset: vec2i,
  pixelShift: vec2f,
  padding: vec2f,
  rects: array<ClipRect, ${CLIP_MAX_RECTS}>,
};

@group(${CLIP_BIND_GROUP_INDEX}) @binding(${CLIP_BINDINGS.frame}) var<uniform> clipFrame: ClipFrame;
@group(${CLIP_BIND_GROUP_INDEX}) @binding(${CLIP_BINDINGS.state}) var<uniform> clipState: ClipState;
@group(${CLIP_BIND_GROUP_INDEX}) @binding(${CLIP_BINDINGS.mask}) var clipMask: texture_2d<f32>;

fn clipSegmentDistance(point: vec2f, start: vec2f, end: vec2f) -> f32 {
  let delta = end - start;
  let denominator = dot(delta, delta);
  if (denominator == 0.0) {
    return distance(point, start);
  }
  let amount = clamp(dot(point - start, delta) / denominator, 0.0, 1.0);
  return distance(point, start + amount * delta);
}

fn clipRectangleDistance(point: vec2f, size: vec2f) -> f32 {
  var boundaryDistance = 1e30;
  boundaryDistance = min(boundaryDistance, clipSegmentDistance(point, vec2f(0.0, 0.0), vec2f(size.x, 0.0)));
  boundaryDistance = min(boundaryDistance, clipSegmentDistance(point, vec2f(size.x, 0.0), vec2f(size.x, size.y)));
  boundaryDistance = min(boundaryDistance, clipSegmentDistance(point, vec2f(size.x, size.y), vec2f(0.0, size.y)));
  boundaryDistance = min(boundaryDistance, clipSegmentDistance(point, vec2f(0.0, size.y), vec2f(0.0, 0.0)));
  let inside = point.x >= 0.0 && point.y >= 0.0 && point.x <= size.x && point.y <= size.y;
  return select(boundaryDistance, -boundaryDistance, inside);
}

fn clipCoverage(pixel: vec2f) -> f32 {
  let world = clipFrame.cameraMinusOrigin + (pixel + clipState.pixelShift) * clipFrame.pixelSize;
  let count = min(clipState.rectCount, ${CLIP_MAX_RECTS}u);
  var coverage = 1.0;
  for (var index = 0u; index < count; index += 1u) {
    let rect = clipState.rects[index];
    let local = (rect.linear.xy * world.x + rect.linear.zw * world.y) + rect.translation;
    let contourDistance = clipRectangleDistance(local, rect.size);
    let filterWidth = max(fwidth(contourDistance), 1e-6);
    coverage *= clamp(0.5 - contourDistance / filterWidth, 0.0, 1.0);
  }
  if (clipState.hasMask != 0u) {
    let texel = vec2i(floor(pixel)) + clipState.maskOffset;
    let size = vec2i(textureDimensions(clipMask));
    if (all(texel >= vec2i(0)) && all(texel < size)) {
      coverage *= textureLoad(clipMask, texel, 0).r;
    } else {
      coverage = 0.0;
    }
  }
  return coverage;
}
`;

/** Replaces `header` (which must occur exactly once) by `replacement`. */
export function replaceOnce(source: string, header: string, replacement: string): string {
  const first = source.indexOf(header);
  if (first < 0 || source.indexOf(header, first + 1) >= 0) {
    throw new Error(`Shader variant: the header "${header}" must occur once.`);
  }
  return source.slice(0, first) + replacement + source.slice(first + header.length);
}

export const PRIMITIVE_ANALYTIC_CLIP_SHADER_KEY = `${PRIMITIVE_ANALYTIC_SHADER_KEY}${CLIP_VARIANT_SUFFIX}`;

/** The P1 module with `fragmentMain` renamed to a helper and wrapped: contribution × coverage. */
export const PRIMITIVE_ANALYTIC_CLIP_SHADER = `${replaceOnce(
  PRIMITIVE_ANALYTIC_SHADER,
  '@fragment\nfn fragmentMain(input: VertexOutput) -> @location(0) vec4f {',
  'fn shadePrimitive(input: VertexOutput) -> vec4f {',
)}${CLIP_BLOCK}
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let clip = clipCoverage(input.position.xy);
  return shadePrimitive(input) * clip;
}
`;

export const MESH_FILL_CLIP_SHADER_KEY = `${MESH_FILL_SHADER_KEY}${CLIP_VARIANT_SUFFIX}`;
export const MESH_JOINT_CLIP_SHADER_KEY = `${MESH_JOINT_SHADER_KEY}${CLIP_VARIANT_SUFFIX}`;

/**
 * The P3 mesh module with both fragment entry points wrapped. A plain fill multiplies its
 * contribution by the coverage k. The joint fill (ST-U7 addendum, section 3.2) runs its formula
 * with the opacity o replaced by o·k: the stroke draw that follows carries the same clip state,
 * so it contributes o·k·S, and the pair composites as the clipped group k·o·(F under S). Plain
 * multiplication of the joint output by k would be exact only at k = 0 and k = 1.
 */
export const MESH_FILL_CLIP_SHADER = `${replaceOnce(
  replaceOnce(
    MESH_FILL_SHADER,
    '@fragment\nfn meshFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {',
    'fn meshShade(input: MeshVertexOutput) -> vec4f {',
  ),
  '@fragment\nfn meshJointFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {',
  'fn meshJointShadeUnclipped(input: MeshVertexOutput) -> vec4f {',
)}${CLIP_BLOCK}
@fragment
fn meshFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {
  let clip = clipCoverage(input.position.xy);
  return meshShade(input) * clip;
}

@fragment
fn meshJointFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {
  let clip = clipCoverage(input.position.xy);
  let triangle = triangles[input.triangle];
  let fill = instances[input.instance];
  let stroke = instances[fill.strokeLink - 1u];
  let coverage = meshJointCoverage(input.position.xy, triangle, fill, stroke);
  let opacity = fill.opacity * clip;
  let strokeAlpha = coverage.y * stroke.fill.a;
  let factor = opacity * (1.0 - strokeAlpha) / (1.0 - opacity * strokeAlpha);
  let alpha = coverage.x * fill.fill.a * factor;
  if (alpha == 0.0) {
    discard;
  }
  return vec4f(fill.fill.rgb * alpha, alpha);
}
`;

export const PRIMITIVE_ANALYTIC_MASK_SHADER_KEY = `${PRIMITIVE_ANALYTIC_SHADER_KEY}+mask-v0`;

/**
 * U4 (P4-K2): the mask pass's primitive source module. The vertex stage reads the source slot
 * from the instance index instead of the order buffer; the fragment stage writes the fill
 * area's P1 coverage times the pass's clip coverage to every channel, whatever the source's
 * style, so the `r8unorm` mask texture holds opaque-white coverage.
 */
export const PRIMITIVE_ANALYTIC_MASK_SHADER = `${replaceOnce(
  replaceOnce(
    PRIMITIVE_ANALYTIC_SHADER,
    'let slot = order[instanceIndex];',
    'let slot = instanceIndex;',
  ),
  '@fragment\nfn fragmentMain(input: VertexOutput) -> @location(0) vec4f {',
  'fn shadePrimitive(input: VertexOutput) -> vec4f {',
)}${CLIP_BLOCK}
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let geometry = geometries[input.slot];
  var contourDistance = LARGE_DISTANCE;
  if (geometry.kind == RECTANGLE_KIND) {
    contourDistance = roundedRectangleDistance(input.localPosition, geometry.size, geometry.radii);
  } else if (geometry.kind == ELLIPSE_KIND) {
    contourDistance = ellipseDistance(input.localPosition - geometry.size * 0.5, geometry.size * 0.5);
  }
  let coverage = analyticCoverage(contourDistance);
  let clip = clipCoverage(input.position.xy);
  return vec4f(coverage * clip);
}
`;

export const MESH_FILL_MASK_SHADER_KEY = `${MESH_FILL_SHADER_KEY}+mask-v0`;

/**
 * U4 (P4-K2): the mask pass's mesh source module. The P3 coverage is evaluated at the target
 * pixel (the pass pixel plus the pass's pixel shift), since the fringe coverage reads the pixel
 * position; the fill area's coverage times the pass's clip coverage goes to every channel,
 * whatever the source's style. A zero-coverage fragment is discarded, so the E17-K2 write-once
 * stencil stays free for the overlapping triangle that covers the sample.
 */
export const MESH_FILL_MASK_SHADER = `${replaceOnce(
  MESH_FILL_SHADER,
  '@fragment\nfn meshFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {',
  'fn meshShade(input: MeshVertexOutput) -> vec4f {',
)}${CLIP_BLOCK}
@fragment
fn meshFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {
  let clip = clipCoverage(input.position.xy);
  let triangle = triangles[input.triangle];
  let instance = instances[input.instance];
  let coverage = meshCoverage(input.position.xy + clipState.pixelShift, triangle, instance);
  if (coverage == 0.0) {
    discard;
  }
  return vec4f(coverage * clip);
}
`;

/** U4: the mask texture format. */
export const CLIP_MASK_FORMAT = 'r8unorm';

export function createClipBindGroupLayoutDescriptor(): GPUBindGroupLayoutDescriptor {
  return {
    label: 'vector-studio/p4-clip-layout',
    entries: [
      {
        binding: CLIP_BINDINGS.frame,
        visibility: FRAGMENT_VISIBILITY,
        buffer: { type: 'uniform', minBindingSize: CLIP_FRAME_SIZE },
      },
      {
        binding: CLIP_BINDINGS.state,
        visibility: FRAGMENT_VISIBILITY,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: CLIP_STATE_SIZE },
      },
      {
        binding: CLIP_BINDINGS.mask,
        visibility: FRAGMENT_VISIBILITY,
        texture: { sampleType: 'float', viewDimension: '2d', multisampled: false },
      },
    ],
  };
}

/** A clip variant's cache key: the base key with the suffixed shader and layout keys. */
export function clipVariantKey(base: PipelineCacheKey): PipelineCacheKey {
  return Object.freeze({
    ...base,
    shaderKey: `${base.shaderKey}${CLIP_VARIANT_SUFFIX}`,
    layoutKey: `${base.layoutKey}+${CLIP_LAYOUT_KEY}`,
  });
}

/** The state stride in the clip buffer: a record per dynamic-offset slot. */
export function clipStateStride(minUniformBufferOffsetAlignment: number): number {
  const alignment = Math.max(minUniformBufferOffsetAlignment, CLIP_FRAME_SIZE);
  return Math.ceil(CLIP_STATE_SIZE / alignment) * alignment;
}

/**
 * The frame lanes: camera minus origin and world units per physical pixel, computed in binary64
 * and rounded once. Null when a lane is not a finite binary32 or the scale is not positive.
 */
export function packClipFrame(part: ClipPacketPart, devicePixelRatio: number): Float32Array | null {
  const lanes = new Float32Array([
    part.camera.x - part.origin.x,
    part.camera.y - part.origin.y,
    1 / (part.camera.zoom * devicePixelRatio),
    0,
  ]);
  if (!lanes.every(Number.isFinite) || !(lanes[2]! > 0)) return null;
  return lanes;
}

/**
 * U4: the mask lanes of a state. `maskOffset` maps a pass pixel to a texel of the state's mask
 * texture (null without a mask); `pixelShift` maps a pass pixel to a target pixel.
 */
export type ClipMaskLanes = Readonly<{
  maskOffset: readonly [number, number] | null;
  pixelShift: readonly [number, number];
}>;

/** A record's lanes: the rect levels it multiplies, and the mask levels it lies under. */
export type ClipStateInput = Readonly<{
  rects: ClipPacketPart['states'][number]['rects'];
  masks: readonly string[];
}>;

/**
 * A state record: the header, then per rect the world-to-local linear part, the translation
 * rebased to the packet origin (`L·origin + t`, in binary64 before the one rounding, so the GPU
 * never cancels large terms) and the size. Without `lanes` (U3) the record must have no mask
 * level and at least one rect; with them (U4) a record under a mask level needs a mask offset,
 * and a record may have no rect. Null when a lane is not a finite binary32, a size is negative,
 * a shift or offset is not an integer, or those rules fail.
 */
export function packClipState(
  record: ClipStateInput,
  origin: ClipPacketPart['origin'],
  lanes?: ClipMaskLanes,
): Uint8Array | null {
  if (
    record.rects.length > CLIP_MAX_RECTS ||
    record.rects.some((rect) => !(rect.width >= 0 && rect.height >= 0))
  ) {
    return null;
  }
  if (lanes === undefined) {
    if (record.masks.length !== 0 || record.rects.length === 0) return null;
  } else {
    if ((record.masks.length !== 0) !== (lanes.maskOffset !== null)) return null;
    const integers = [...(lanes.maskOffset ?? []), ...lanes.pixelShift];
    if (!integers.every((value) => Number.isSafeInteger(value) && Math.abs(value) <= 0x7fffffff)) {
      return null;
    }
  }
  const bytes = new Uint8Array(CLIP_STATE_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, record.rects.length, true);
  if (lanes !== undefined) {
    if (lanes.maskOffset !== null) {
      view.setUint32(4, 1, true);
      view.setInt32(8, lanes.maskOffset[0], true);
      view.setInt32(12, lanes.maskOffset[1], true);
    }
    view.setFloat32(16, lanes.pixelShift[0], true);
    view.setFloat32(20, lanes.pixelShift[1], true);
  }
  for (const [index, rect] of record.rects.entries()) {
    const [a, b, c, d, e, f] = rect.toLocal;
    const values = [
      a,
      b,
      c,
      d,
      a * origin.x + c * origin.y + e,
      b * origin.x + d * origin.y + f,
      rect.width,
      rect.height,
    ];
    const base = CLIP_STATE_HEADER_SIZE + index * CLIP_RECT_SIZE;
    for (const [lane, value] of values.entries()) {
      const rounded = Math.fround(value);
      if (!Number.isFinite(rounded)) return null;
      view.setFloat32(base + lane * 4, rounded, true);
    }
  }
  return bytes;
}
