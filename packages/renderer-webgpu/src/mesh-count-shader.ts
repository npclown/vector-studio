import { MESH_FILL_SHADER } from './mesh-fill-shader.js';

/**
 * @internal Tests only (E10 contract, section 5): O02's count pass on the product mesh draws.
 * The count module is MESH_FILL_SHADER followed by this suffix, so its vertex entry points are
 * the product's (meshVertexMain, meshJointVertexMain, both through meshPositionNdc with an
 * @invariant position) and MESH_FILL_SHADER itself, with its E3-recorded SHA-256, is unchanged.
 * The fragment entry point writes 1 with no discard; additive blending sums the coverage.
 */
export const MESH_COUNT_SHADER_SUFFIX = /* wgsl */ `
@fragment
fn meshCountFragmentMain() -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
`;

/** @internal Tests only (E10 contract, section 5). */
export const MESH_COUNT_SHADER = MESH_FILL_SHADER + MESH_COUNT_SHADER_SUFFIX;
export const MESH_COUNT_FRAGMENT_ENTRY_POINT = 'meshCountFragmentMain';

/**
 * @internal Tests only (E10 contract, section 5): reads the four samples of the 4x count
 * texture into R, G, B and A of a 1x target with textureLoad, as O02's readout does.
 */
export const MESH_COUNT_READOUT_SHADER = /* wgsl */ `
@group(0) @binding(0) var counts: texture_multisampled_2d<f32>;

@vertex
fn countReadoutVertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn countReadoutFragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(position.xy);
  return vec4f(
    textureLoad(counts, pixel, 0).r,
    textureLoad(counts, pixel, 1).r,
    textureLoad(counts, pixel, 2).r,
    textureLoad(counts, pixel, 3).r,
  );
}
`;

/** IEEE 754 binary16 bits to a number; counts are small integers, exact in binary16 below 2048. */
export function halfToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}
