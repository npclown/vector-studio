/**
 * P3.1o O02 A5 coverage rule shader literals (docs/plans/p3-o02-a5-coverage-contract.md).
 * Side-effect free: the Playwright spec imports these strings to hash them.
 */

const VERTEX = `struct VertexInput {
  @location(0) ndc: vec2<f32>,
  @location(1) info: vec3<u32>,
};

struct Varying {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat, either) info: vec3<u32>,
};

@vertex
fn vertexMain(input: VertexInput) -> Varying {
  var output: Varying;
  output.position = vec4<f32>(input.ndc.x, input.ndc.y, 0.0, 1.0);
  output.info = input.info;
  return output;
}
`;

/** Main pass: one function for region and exterior primitives; the role is a flat attribute. */
export const P3_O02_MAIN_WGSL = `struct Frame {
  origin: vec2<f32>,
  pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var<storage, read> features: array<u32>;

${VERTEX}
fn word(index: u32) -> f32 {
  return bitcast<f32>(features[index]);
}

fn cross2(a: vec2<f32>, b: vec2<f32>) -> f32 {
  return a.x * b.y - a.y * b.x;
}

fn insideSector(base: u32, sector: u32, flags: u32, d: vec2<f32>) -> bool {
  let at = base + 4u + sector * 4u;
  let rOut = vec2<f32>(word(at), word(at + 1u));
  let rIn = vec2<f32>(word(at + 2u), word(at + 3u));
  let a = cross2(rOut, d);
  let b = cross2(d, rIn);
  if (((flags >> (8u + sector)) & 1u) == 1u) {
    return !(a <= 0.0 && b <= 0.0);
  }
  return a > 0.0 && b > 0.0;
}

fn coverage(input: Varying) -> f32 {
  let p = input.position.xy - frame.origin;
  let offset = input.info.x;
  let count = input.info.y;
  let roleConstant = select(0.0, 1.0, input.info.z == 0u);
  var best = 3.0e38;
  var side = 0.0;
  var width = 1.0;
  for (var index = 0u; index < count; index = index + 1u) {
    let base = (offset + index) * 16u;
    if (features[base] == 0u) {
      let n = vec2<f32>(word(base + 1u), word(base + 2u));
      let t = vec2<f32>(-n.y, n.x);
      let u = dot(t, p);
      if (u >= word(base + 4u) && u <= word(base + 5u)) {
        let v = dot(n, p) + word(base + 3u);
        let dist = abs(v);
        if (dist < best) {
          best = dist;
          side = v;
          width = abs(n.x) + abs(n.y);
        }
      }
    } else {
      let d = p - vec2<f32>(word(base + 1u), word(base + 2u));
      let dist = length(d);
      if (dist < best) {
        let flags = features[base + 3u];
        let sectors = flags & 0xffu;
        var inside = false;
        for (var sector = 0u; sector < sectors; sector = sector + 1u) {
          inside = inside || insideSector(base, sector, flags, d);
        }
        best = dist;
        side = select(dist, -dist, inside);
        width = select(1.0, (abs(d.x) + abs(d.y)) / dist, dist > 0.0);
      }
    }
  }
  if (count == 0u || best >= 1.0) {
    return roleConstant;
  }
  return clamp(0.5 - side / width, 0.0, 1.0);
}

@fragment
fn fragmentMain(input: Varying) -> @location(0) vec4<f32> {
  let c = coverage(input);
  return vec4<f32>(c, c, c, c);
}
`;

/** Count pass: same vertex stage and draw ranges; always writes 1.0, no discard. */
export const P3_O02_COUNT_WGSL = `${VERTEX}
@fragment
fn fragmentMain(input: Varying) -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 0.0, 0.0, 1.0);
}
`;

/** Readout: per-sample counts of the 4x count texture into RGBA of a 1x target. */
export const P3_O02_READOUT_WGSL = `@group(0) @binding(0) var counts: texture_multisampled_2d<f32>;

@vertex
fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(position.xy);
  return vec4<f32>(
    textureLoad(counts, pixel, 0).r,
    textureLoad(counts, pixel, 1).r,
    textureLoad(counts, pixel, 2).r,
    textureLoad(counts, pixel, 3).r,
  );
}
`;

export const P3_O02_SHADERS = Object.freeze({
  main: P3_O02_MAIN_WGSL,
  count: P3_O02_COUNT_WGSL,
  readout: P3_O02_READOUT_WGSL,
});

export type P3O02ShaderName = keyof typeof P3_O02_SHADERS;
