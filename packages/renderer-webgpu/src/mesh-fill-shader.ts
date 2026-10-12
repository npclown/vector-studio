export const MESH_FILL_SHADER_KEY = 'p3-mesh-fill-v0';

/**
 * P3 V3 contract, sections e and f: one non-indexed vertex-pulling draw per path mesh, with the
 * O02 A5 coverage rule (docs/plans/p3-o02-a5-coverage-contract.md, "Coverage rule" and "Features
 * and reach") evaluated per pixel center over the triangle's feature list.
 *
 * Differences from O02's test-only realization (section e): features are node-local binary32
 * offsets from the mesh midpoint m, mapped to physical pixels here with the same K4 expression
 * as the vertex stage; EDGE records carry their endpoints, and the shader derives the normal and
 * the endpoint parameters in physical pixels; VERTEX sector directions are unnormalized local
 * directions mapped with the linear lanes; every side and sector test is multiplied by the
 * orientation sigma = sign(det L), because boundary orientation is node-local. Functional only:
 * precision is UNVERIFIED against the 0.25 physical-pixel target and no Q4 threshold is claimed.
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
const EDGE_KIND: u32 = 0u;
const FAR_FIELD_PX: f32 = 1.0;

// K4: p = ((A * u + B) + (O_m - camera)) * zoom * DPR, in physical pixels.
fn toPhysical(offset: vec2f, instance: MeshInstance) -> vec2f {
  let linear = instance.linear.xy * offset.x + instance.linear.zw * offset.y;
  let documentPosition = (linear + instance.anchor) + frame.originMinusCamera;
  return documentPosition * frame.zoom * frame.devicePixelRatio;
}

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
  let physicalPosition = toPhysical(positions[instance.vertexBase + local], instance);

  var output: MeshVertexOutput;
  // NDC exactly as the P1 shader, y flipped.
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

fn cross2(a: vec2f, b: vec2f) -> f32 {
  return a.x * b.y - a.y * b.x;
}

fn word(feature: MeshFeature, index: u32) -> u32 {
  return feature.words[index / 4u][index % 4u];
}

fn lane(feature: MeshFeature, index: u32) -> f32 {
  return bitcast<f32>(word(feature, index));
}

// O02's sector test with sigma: below 180 deg both strict tests hold; at 180 deg or more NOT
// (both tests <= 0). The reflex bit selects the test, so no f32 angle decision is made.
fn insideSector(
  feature: MeshFeature,
  sector: u32,
  flags: u32,
  d: vec2f,
  instance: MeshInstance,
) -> bool {
  let at = 4u + sector * 4u;
  let localOut = vec2f(lane(feature, at), lane(feature, at + 1u));
  let localIn = vec2f(lane(feature, at + 2u), lane(feature, at + 3u));
  let rOut = instance.linear.xy * localOut.x + instance.linear.zw * localOut.y;
  let rIn = instance.linear.xy * localIn.x + instance.linear.zw * localIn.y;
  let a = instance.orientation * cross2(rOut, d);
  let b = instance.orientation * cross2(d, rIn);
  if (((flags >> (8u + sector)) & 1u) == 1u) {
    return !(a <= 0.0 && b <= 0.0);
  }
  return a > 0.0 && b > 0.0;
}

// The O02 coverage rule at the pixel center p: the nearest listed feature by f32 distance with
// strict-< updates in list order, s positive outside, w = |v.x| + |v.y| over |v|, and the 1.0 px
// far-field clamp to the role constant.
fn meshCoverage(p: vec2f, triangle: MeshTriangle, instance: MeshInstance) -> f32 {
  let roleConstant = select(0.0, 1.0, triangle.role == REGION_ROLE);
  let count = triangle.listCount;
  let listStart = instance.listBase + triangle.listOffset;
  var best = 3.0e38;
  var side = 0.0;
  var width = 1.0;
  for (var index = 0u; index < count; index = index + 1u) {
    let feature = features[instance.featureBase + featureLists[listStart + index]];
    if (word(feature, 0u) == EDGE_KIND) {
      let a = toPhysical(vec2f(lane(feature, 1u), lane(feature, 2u)), instance);
      let b = toPhysical(vec2f(lane(feature, 3u), lane(feature, 4u)), instance);
      let e = b - a;
      let len = length(e);
      if (len > 0.0) {
        let t = e / len;
        let q = p - a;
        let u = dot(t, q);
        if (u >= 0.0 && u <= len) {
          // The region is on the left of a -> b in node-local; sigma maps that to pixels.
          let v = -instance.orientation * cross2(t, q);
          let dist = abs(v);
          if (dist < best) {
            best = dist;
            side = v;
            width = abs(t.x) + abs(t.y);
          }
        }
      }
    } else {
      let x = toPhysical(vec2f(lane(feature, 2u), lane(feature, 3u)), instance);
      let d = p - x;
      let dist = length(d);
      if (dist < best) {
        let flags = word(feature, 1u);
        let sectors = flags & 0xffu;
        var inside = false;
        for (var sector = 0u; sector < sectors; sector = sector + 1u) {
          inside = inside || insideSector(feature, sector, flags, d, instance);
        }
        best = dist;
        side = select(dist, -dist, inside);
        width = select(1.0, (abs(d.x) + abs(d.y)) / dist, dist > 0.0);
      }
    }
  }
  if (count == 0u || best >= FAR_FIELD_PX) {
    return roleConstant;
  }
  return clamp(0.5 - side / width, 0.0, 1.0);
}

@fragment
fn meshFragmentMain(input: MeshVertexOutput) -> @location(0) vec4f {
  let triangle = triangles[input.triangle];
  let instance = instances[input.instance];
  // @builtin(position) is the pixel center; no sample interpolation or alpha-to-coverage.
  let coverage = meshCoverage(input.position.xy, triangle, instance);
  // out = c * opacity * (r * a, g * a, b * a, a), premultiplied for P1's blend.
  let alpha = coverage * instance.opacity * instance.fill.a;
  if (alpha == 0.0) {
    discard;
  }
  return vec4f(instance.fill.rgb * alpha, alpha);
}
`;
