/**
 * Frozen P3.1l native projection shader (contract L02 in
 * docs/plans/p3-native-projection-readiness.md). The value is the contract WGSL block
 * byte-for-byte, lines joined with LF and no trailing newline after the final brace.
 * Any change, including whitespace or comments, is a contract change.
 */
export const P3_NATIVE_PROJECTION_WGSL: string = `struct RowRecord {
  linear: vec4<f32>,
  anchor: vec2<f32>,
  frameOffset: vec2<f32>,
  scale: vec2<f32>,
  size: vec2<f32>,
  rowIndex: u32,
  captureTag: u32,
  reserved0: u32,
  reserved1: u32,
};

struct VertexRecord {
  local: vec2<f32>,
  rowIndex: u32,
  vertexIndex: u32,
};

@group(0) @binding(0) var<uniform> row: RowRecord;
@group(0) @binding(1) var<storage, read> vertices: array<VertexRecord, 256>;

struct ProbeVarying {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat) xyWords: vec4<u32>,
  @location(1) @interpolate(flat) zwWords: vec4<u32>,
};

struct ProbeTargets {
  @location(0) xyWords: vec4<u32>,
  @location(1) zwWords: vec4<u32>,
};

fn projectVertex(u: vec2<f32>) -> vec4<f32> {
  let sx = ((row.linear.x * u.x) + (row.linear.z * u.y)) + row.anchor.x;
  let sy = ((row.linear.y * u.x) + (row.linear.w * u.y)) + row.anchor.y;
  let rx = sx + row.frameOffset.x;
  let ry = sy + row.frameOffset.y;
  let px = (rx * row.scale.x) * row.scale.y;
  let py = (ry * row.scale.x) * row.scale.y;
  let nx = ((px * 2.0) / row.size.x) - 1.0;
  let ny = 1.0 - ((py * 2.0) / row.size.y);
  return vec4<f32>(nx, ny, 0.0, 1.0);
}

@vertex
fn nativeProjectionVertex(@builtin(vertex_index) slot: u32) -> ProbeVarying {
  let record = vertices[slot];
  let clip = bitcast<vec4<u32>>(projectVertex(record.local));
  let column = slot % 16u;
  let line = slot / 16u;
  var output: ProbeVarying;
  output.position = vec4<f32>(
    ((f32(column) + 0.5) * 0.125) - 1.0,
    1.0 - ((f32(line) + 0.5) * 0.125),
    0.0,
    1.0,
  );
  output.xyWords = vec4<u32>(clip.x, clip.y, record.vertexIndex, row.captureTag);
  output.zwWords = vec4<u32>(clip.z, clip.w, record.rowIndex, row.rowIndex);
  return output;
}

@fragment
fn nativeProjectionFragment(input: ProbeVarying) -> ProbeTargets {
  var targets: ProbeTargets;
  targets.xyWords = input.xyWords;
  targets.zwWords = input.zwWords;
  return targets;
}`;
