import type { GradientPaintRecord } from '@vector-studio/renderer-core';

import { CLIP_BLOCK, clipVariantKey, replaceOnce } from './clip-pipeline.js';
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

// E23 contract (docs/plans/d9-e23-gradient-paint-contract.md), unit U3: the gradient paint
// pipeline variants. Each variant is its base module with the constant paint colour replaced by
// the paint block's value, under its own shader key and a pipeline layout with the paint bind
// group at group 2 (group 1 is the clip group, or an empty group without a clip). The base and
// clip modules, keys and pipelines are untouched (E23-A08); a draw whose paints are all solid
// always uses its base or clip pipeline.

export const PAINT_VARIANT_SUFFIX = '+paint-v0';
export const PAINT_LAYOUT_KEY = 'e23-paint-v0';
export const PAINT_BIND_GROUP_INDEX = 2;
/**
 * Binding 1 is the draw kind's index table: the scene binds one group over the primitive table
 * for analytic draws and one over the mesh table for mesh draws, both with this layout.
 */
export const PAINT_BINDINGS = Object.freeze({ gradients: 0, indices: 1 });
/** SCENE_MAX_GRADIENT_STOPS. */
export const PAINT_MAX_STOPS = 16;
/** The record: header, map (linear lanes, translation lanes), 16 offsets and 16 colours. */
export const GRADIENT_RECORD_SIZE = 16 + 16 + 16 + PAINT_MAX_STOPS * 4 + PAINT_MAX_STOPS * 16;
/** Per primitive slot or mesh instance: the fill (or own) paint index, then the stroke's. */
export const PAINT_INDEX_STRIDE = 8;
/** The smallest index table, so a binding never has size 0. */
export const PAINT_INDEX_MIN_SIZE = 16;

const FRAGMENT_VISIBILITY = 0x2;

/**
 * The paint block, over the module's `frame` uniform. `paintValue` is E23-K1 to K3 for record
 * `index` at pixel centre `pixel`, premultiplied, or the premultiplied solid colour for index 0:
 * the document point relative to the packet origin is `p / (zoom · DPR) − (origin − camera)`, and
 * the record's map takes it to gradient space. The stop lookup runs a fixed 16-step loop, and
 * no step takes a derivative, so the callers evaluate it after their coverage derivatives.
 * `paintContribution` is P1's `premultipliedContribution` with the paint in place of the colour,
 * and exactly that function for a solid paint.
 */
function paintBlock(table: 'primitivePaints' | 'meshPaints'): string {
  return /* wgsl */ `
struct GradientRecord {
  header: vec4u,
  mapLinear: vec4f,
  mapTranslation: vec4f,
  offsets: array<vec4f, ${PAINT_MAX_STOPS / 4}>,
  colors: array<vec4f, ${PAINT_MAX_STOPS}>,
};

@group(${PAINT_BIND_GROUP_INDEX}) @binding(${PAINT_BINDINGS.gradients}) var<storage, read> gradients: array<GradientRecord>;
@group(${PAINT_BIND_GROUP_INDEX}) @binding(${PAINT_BINDINGS.indices}) var<storage, read> ${table}: array<u32>;

const GRADIENT_RADIAL: u32 = 1u;
const SPREAD_REFLECT: u32 = 1u;
const SPREAD_REPEAT: u32 = 2u;

fn gradientOffset(index: u32, stop: u32) -> f32 {
  return gradients[index].offsets[stop / 4u][stop % 4u];
}

fn paintValue(index: u32, solid: vec4f, pixel: vec2f) -> vec4f {
  if (index == 0u) {
    return vec4f(solid.rgb * solid.a, solid.a);
  }
  let header = gradients[index].header;
  let map = gradients[index].mapLinear;
  let document = pixel / (frame.zoom * frame.devicePixelRatio) - frame.originMinusCamera;
  let point = (map.xy * document.x + map.zw * document.y) + gradients[index].mapTranslation.xy;
  var t = select(point.x, length(point), header.x == GRADIENT_RADIAL);
  if (header.y == SPREAD_REPEAT) {
    t = t - floor(t);
  } else if (header.y == SPREAD_REFLECT) {
    let u = t - 2.0 * floor(t * 0.5);
    t = 1.0 - abs(u - 1.0);
  } else {
    t = clamp(t, 0.0, 1.0);
  }
  let count = min(header.z, ${PAINT_MAX_STOPS}u);
  var value = gradients[index].colors[0];
  for (var stop = 1u; stop < ${PAINT_MAX_STOPS}u; stop += 1u) {
    if (stop < count) {
      let lower = gradientOffset(index, stop - 1u);
      let upper = gradientOffset(index, stop);
      if (t >= upper) {
        value = gradients[index].colors[stop];
      } else if (t >= lower) {
        let start = gradients[index].colors[stop - 1u];
        let weight = (t - lower) / (upper - lower);
        value = start + weight * (gradients[index].colors[stop] - start);
      }
    }
  }
  return value;
}
`;
}

const PRIMITIVE_PAINT_BLOCK = /* wgsl */ `
fn paintContribution(index: u32, solid: vec4f, coverage: f32, pixel: vec2f) -> vec4f {
  if (index == 0u) {
    return premultipliedContribution(solid, coverage);
  }
  return paintValue(index, solid, pixel) * coverage;
}
`;

const PRIMITIVE_FRAGMENT_HEADER =
  '@fragment\nfn fragmentMain(input: VertexOutput) -> @location(0) vec4f {';

export const PRIMITIVE_ANALYTIC_PAINT_SHADER_KEY = `${PRIMITIVE_ANALYTIC_SHADER_KEY}${PAINT_VARIANT_SUFFIX}`;

/**
 * The P1 module with its fill and stroke contributions taking the slot's paints (E23-K4). The
 * replaced calls sit after both `analyticCoverage` calls.
 */
export const PRIMITIVE_ANALYTIC_PAINT_SHADER = `${replaceOnce(
  replaceOnce(
    PRIMITIVE_ANALYTIC_SHADER,
    'fill = premultipliedContribution(style.fill, contourCoverage);',
    'fill = paintContribution(primitivePaints[input.slot * 2u], style.fill, contourCoverage, input.position.xy);',
  ),
  'stroke = premultipliedContribution(style.stroke, coverage);',
  'stroke = paintContribution(primitivePaints[input.slot * 2u + 1u], style.stroke, coverage, input.position.xy);',
)}${paintBlock('primitivePaints')}${PRIMITIVE_PAINT_BLOCK}`;

export const PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER_KEY = `${PRIMITIVE_ANALYTIC_PAINT_SHADER_KEY}+clip-v0`;

/** The paint module wrapped by the clip block exactly as P4's clip variant wraps P1. */
export const PRIMITIVE_ANALYTIC_PAINT_CLIP_SHADER = `${replaceOnce(
  PRIMITIVE_ANALYTIC_PAINT_SHADER,
  PRIMITIVE_FRAGMENT_HEADER,
  'fn shadePrimitive(input: VertexOutput) -> vec4f {',
)}${CLIP_BLOCK}
@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let clip = clipCoverage(input.position.xy);
  return shadePrimitive(input) * clip;
}
`;

export const MESH_FILL_PAINT_SHADER_KEY = `${MESH_FILL_SHADER_KEY}${PAINT_VARIANT_SUFFIX}`;
export const MESH_JOINT_PAINT_SHADER_KEY = `${MESH_JOINT_SHADER_KEY}${PAINT_VARIANT_SUFFIX}`;
export const MESH_FILL_PAINT_CLIP_SHADER_KEY = `${MESH_FILL_PAINT_SHADER_KEY}+clip-v0`;
export const MESH_JOINT_PAINT_CLIP_SHADER_KEY = `${MESH_JOINT_PAINT_SHADER_KEY}+clip-v0`;

/**
 * The P3 mesh module with both fragment entry points replaced (E23-K4): a fill or stroke draw
 * outputs `o · c · Q(p)`, the joint fill draw `o · c_F · Q_F(p) · (1 − a_S) / (1 − o · a_S)` with
 * `a_S = c_S · Q_S(p).a`. The instance's index pair holds its own paint and, on a joint fill
 * record, the stroke paint. With the clip block, the clip coverage k is taken first (its
 * derivatives in uniform control flow); a fill multiplies by k and the joint formula runs with
 * `o · k`, as P4's clip variants do.
 */
function meshPaintShader(clipped: boolean): string {
  const base = replaceOnce(
    replaceOnce(
      MESH_FILL_SHADER,
      '@fragment\nfn meshFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {',
      'fn meshShadeSolid(input: MeshVertexOutput) -> vec4f {',
    ),
    '@fragment\nfn meshJointFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {',
    'fn meshJointShadeSolid(input: MeshVertexOutput) -> vec4f {',
  );
  const clip = clipped ? 'clipCoverage(input.position.xy)' : '1.0';
  return `${base}${paintBlock('meshPaints')}${clipped ? CLIP_BLOCK : ''}
@fragment
fn meshFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {
  let clip = ${clip};
  let triangle = triangles[input.triangle];
  let instance = instances[input.instance];
  let coverage = meshCoverage(input.position.xy, triangle, instance);
  let paint = paintValue(meshPaints[input.instance * 2u], instance.fill, input.position.xy);
  let color = paint * (coverage * instance.opacity);
  if (color.a == 0.0) {
    discard;
  }
  return color * clip;
}

@fragment
fn meshJointFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {
  let clip = ${clip};
  let triangle = triangles[input.triangle];
  let fill = instances[input.instance];
  let stroke = instances[fill.strokeLink - 1u];
  let coverage = meshJointCoverage(input.position.xy, triangle, fill, stroke);
  let fillPaint = paintValue(meshPaints[input.instance * 2u], fill.fill, input.position.xy);
  let strokePaint = paintValue(meshPaints[input.instance * 2u + 1u], stroke.fill, input.position.xy);
  let opacity = fill.opacity * clip;
  let strokeAlpha = coverage.y * strokePaint.a;
  let factor = opacity * (1.0 - strokeAlpha) / (1.0 - opacity * strokeAlpha);
  let color = fillPaint * (coverage.x * factor);
  if (color.a == 0.0) {
    discard;
  }
  return color;
}
`;
}

export const MESH_FILL_PAINT_SHADER = meshPaintShader(false);
export const MESH_FILL_PAINT_CLIP_SHADER = meshPaintShader(true);

export function createPaintBindGroupLayoutDescriptor(): GPUBindGroupLayoutDescriptor {
  const storage = (binding: number, minBindingSize: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: FRAGMENT_VISIBILITY,
    buffer: { type: 'read-only-storage', minBindingSize },
  });
  return {
    label: 'vector-studio/e23-paint-layout',
    entries: [
      storage(PAINT_BINDINGS.gradients, GRADIENT_RECORD_SIZE),
      storage(PAINT_BINDINGS.indices, PAINT_INDEX_MIN_SIZE),
    ],
  };
}

/** A paint variant's cache key: the base key with the suffixed shader and layout keys. */
export function paintVariantKey(base: PipelineCacheKey): PipelineCacheKey {
  return Object.freeze({
    ...base,
    shaderKey: `${base.shaderKey}${PAINT_VARIANT_SUFFIX}`,
    layoutKey: `${base.layoutKey}+${PAINT_LAYOUT_KEY}`,
  });
}

/** A paint and clip variant's cache key: the paint key with the clip suffixes. */
export function paintClipVariantKey(base: PipelineCacheKey): PipelineCacheKey {
  return clipVariantKey(paintVariantKey(base));
}

const KIND_CODES: Readonly<Record<string, number>> = Object.freeze({ linear: 0, radial: 1 });
const SPREAD_CODES: Readonly<Record<string, number>> = Object.freeze({
  pad: 0,
  reflect: 1,
  repeat: 2,
});

/**
 * A record's bytes: header (kind, spread, stop count), the map's linear lanes `a b c d`, its
 * translation `e f`, the offsets and the premultiplied colours, all as given (renderer-core
 * rounded each once). Null when a field is malformed, a lane is not a finite binary32, an
 * offset is outside [0, 1] or decreasing, or a colour lane is outside [0, 1].
 */
export function packGradientRecord(record: GradientPaintRecord): Uint8Array | null {
  if (typeof record !== 'object' || record === null) return null;
  const kind = KIND_CODES[record.kind];
  const spread = SPREAD_CODES[record.spread];
  const map: unknown = record.map;
  const offsets: unknown = record.offsets;
  const colors: unknown = record.colors;
  const isLane = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && Math.fround(value) === value;
  const lanes = (value: unknown): readonly number[] | null =>
    Array.isArray(value) && (value as readonly unknown[]).every(isLane)
      ? (value as readonly number[])
      : null;
  const mapLanes = lanes(map);
  const offsetLanes = lanes(offsets);
  const colorLanes = lanes(colors);
  if (
    kind === undefined ||
    spread === undefined ||
    mapLanes === null ||
    offsetLanes === null ||
    colorLanes === null ||
    mapLanes.length !== 6 ||
    offsetLanes.length < 1 ||
    offsetLanes.length > PAINT_MAX_STOPS ||
    colorLanes.length !== offsetLanes.length * 4
  ) {
    return null;
  }
  for (const [index, offset] of offsetLanes.entries()) {
    if (offset < 0 || offset > 1) return null;
    if (index > 0 && offset < offsetLanes[index - 1]!) return null;
  }
  if (!colorLanes.every((lane) => lane >= 0 && lane <= 1)) return null;
  const bytes = new Uint8Array(GRADIENT_RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, kind, true);
  view.setUint32(4, spread, true);
  view.setUint32(8, offsetLanes.length, true);
  // The map [a, b, c, d, e, f]: linear lanes at 16 (mapLinear), translation lanes at 32.
  for (const [lane, value] of mapLanes.entries()) view.setFloat32(16 + lane * 4, value, true);
  for (const [index, offset] of offsetLanes.entries()) {
    view.setFloat32(48 + index * 4, offset, true);
  }
  for (const [index, lane] of colorLanes.entries()) view.setFloat32(112 + index * 4, lane, true);
  return bytes;
}

/** An index table: per entry, its pair at `2 · key` and `2 · key + 1`; at least 16 bytes. */
export function packPaintIndices(
  entries: ReadonlyMap<number, readonly [number, number]>,
): Uint8Array {
  let size = 0;
  for (const key of entries.keys()) size = Math.max(size, (key + 1) * PAINT_INDEX_STRIDE);
  const bytes = new Uint8Array(Math.max(size, PAINT_INDEX_MIN_SIZE));
  const view = new DataView(bytes.buffer);
  for (const [key, [first, second]] of entries) {
    view.setUint32(key * PAINT_INDEX_STRIDE, first, true);
    view.setUint32(key * PAINT_INDEX_STRIDE + 4, second, true);
  }
  return bytes;
}
