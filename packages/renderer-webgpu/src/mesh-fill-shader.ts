export const MESH_FILL_SHADER_KEY = 'p3-mesh-fill-v0';

/**
 * P3 V3 contract, section f: one non-indexed vertex-pulling draw per path mesh. V3b evaluates
 * coverage c = 1 for region triangles (role 0); exterior triangles (role 1) and their feature
 * lists arrive with the V3c coverage rule and draw nothing here. Functional only: precision is
 * UNVERIFIED against the 0.25 physical-pixel target.
 */
export const MESH_FILL_SHADER = /* wgsl */ `
struct MeshTriangle {
  i0: u32,
  i1: u32,
  i2: u32,
  listOffset: u32,
  listCount: u32,
  role: u32,
  padding0: u32,
  padding1: u32,
};

struct MeshFeature {
  words: array<vec4u, 4>,
};

struct MeshInstance {
  linear: vec4f,
  anchor: vec2f,
  orientation: f32,
  opacity: f32,
  fill: vec4f,
  vertexBase: u32,
  listBase: u32,
  featureBase: u32,
  padding: u32,
};

struct MeshFrame {
  originMinusCamera: vec2f,
  zoom: f32,
  devicePixelRatio: f32,
  physicalSize: vec2f,
  padding: vec2f,
};

struct MeshVertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) triangle: u32,
  @location(1) @interpolate(flat) instance: u32,
};

@group(0) @binding(0) var<storage, read> positions: array<vec2f>;
@group(0) @binding(1) var<storage, read> triangles: array<MeshTriangle>;
@group(0) @binding(2) var<storage, read> featureLists: array<u32>;
@group(0) @binding(3) var<storage, read> features: array<MeshFeature>;
@group(0) @binding(4) var<storage, read> instances: array<MeshInstance>;
@group(0) @binding(5) var<uniform> frame: MeshFrame;

const REGION_ROLE: u32 = 0u;

@vertex
fn meshVertexMain(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32,
) -> MeshVertexOutput {
  let triangleIndex = vertexIndex / 3u;
  let corner = vertexIndex % 3u;
  let triangle = triangles[triangleIndex];
  let instance = instances[instanceIndex];
  var local = triangle.i0;
  if (corner == 1u) {
    local = triangle.i1;
  } else if (corner == 2u) {
    local = triangle.i2;
  }
  let offset = positions[instance.vertexBase + local];
  // K4: p = ((A * u + B) + (O_m - camera)) * zoom * DPR, then NDC exactly as the P1 shader.
  let linear = instance.linear.xy * offset.x + instance.linear.zw * offset.y;
  let documentPosition = (linear + instance.anchor) + frame.originMinusCamera;
  let physicalPosition = documentPosition * frame.zoom * frame.devicePixelRatio;

  var output: MeshVertexOutput;
  output.position = vec4f(
    physicalPosition.x * 2.0 / frame.physicalSize.x - 1.0,
    1.0 - physicalPosition.y * 2.0 / frame.physicalSize.y,
    0.0,
    1.0,
  );
  output.triangle = triangleIndex;
  output.instance = instanceIndex;
  return output;
}

fn meshCoverage(triangle: MeshTriangle) -> f32 {
  // V3b: region triangles are fully covered. The O02 coverage rule over the triangle's feature
  // list (featureLists, features) replaces this in V3c; the explicit pipeline layout keeps
  // those bindings even though this shader does not read them yet.
  return select(0.0, 1.0, triangle.role == REGION_ROLE);
}

@fragment
fn meshFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {
  let triangle = triangles[input.triangle];
  let instance = instances[input.instance];
  let coverage = meshCoverage(triangle);
  // out = c * opacity * (r * a, g * a, b * a, a), premultiplied for P1's blend.
  let alpha = coverage * instance.opacity * instance.fill.a;
  if (alpha == 0.0) {
    discard;
  }
  return vec4f(instance.fill.rgb * alpha, alpha);
}
`;
