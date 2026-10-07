/**
 * P3.1o O01 candidate shader literals (docs/plans/p3-o01-coverage-experiment-contract.md).
 * Side-effect free: the Playwright spec imports these strings to hash them.
 */

const COMMON = `struct Frame {
  origin: vec2<f32>,
  pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> frame: Frame;

struct VertexInput {
  @location(0) ndc: vec4<f32>,
  @location(1) e0: vec4<f32>,
  @location(2) e1: vec4<f32>,
  @location(3) e2: vec4<f32>,
};

struct Varying {
  @builtin(position) position: vec4<f32>,
  @location(0) @interpolate(flat, either) e0: vec4<f32>,
  @location(1) @interpolate(flat, either) e1: vec4<f32>,
  @location(2) @interpolate(flat, either) e2: vec4<f32>,
};

@vertex
fn vertexMain(input: VertexInput) -> Varying {
  var output: Varying;
  output.position = vec4<f32>(input.ndc.x, input.ndc.y, 0.0, 1.0);
  output.e0 = input.e0;
  output.e1 = input.e1;
  output.e2 = input.e2;
  return output;
}

fn edgeDistance(edge: vec4<f32>, pixel: vec2<f32>) -> f32 {
  return dot(edge.xy, pixel - frame.origin) + edge.z;
}

fn ramp(d: f32) -> f32 {
  return clamp(0.5 - d / max(fwidth(d), 1e-6), 0.0, 1.0);
}

fn rampedInterior(input: Varying) -> f32 {
  let d0 = edgeDistance(input.e0, input.position.xy);
  let d1 = edgeDistance(input.e1, input.position.xy);
  let d2 = edgeDistance(input.e2, input.position.xy);
  let r0 = select(1.0, ramp(d0), input.e0.w > 0.5);
  let r1 = select(1.0, ramp(d1), input.e1.w > 0.5);
  let r2 = select(1.0, ramp(d2), input.e2.w > 0.5);
  return min(r0, min(r1, r2));
}
`;

/** A1: opaque interior, outward fringe discontinuous at the contour. */
export const P3_COVERAGE_A1_WGSL = `${COMMON}
@fragment
fn interiorMain(input: Varying) -> @location(0) vec4<f32> {
  return vec4<f32>(1.0);
}

@fragment
fn fringeMain(input: Varying) -> @location(0) vec4<f32> {
  let d = edgeDistance(input.e0, input.position.xy);
  let r = ramp(d);
  return vec4<f32>(select(0.0, r, d >= 0.0));
}
`;

/** A2: inside-only ramp; no fringe is drawn. */
export const P3_COVERAGE_A2_WGSL = `${COMMON}
@fragment
fn interiorMain(input: Varying) -> @location(0) vec4<f32> {
  return vec4<f32>(rampedInterior(input));
}

@fragment
fn fringeMain(input: Varying) -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}
`;

/** A5: symmetric straddling ramp; the fringe evaluates the same ramp unconditionally. */
export const P3_COVERAGE_A5_WGSL = `${COMMON}
@fragment
fn interiorMain(input: Varying) -> @location(0) vec4<f32> {
  return vec4<f32>(rampedInterior(input));
}

@fragment
fn fringeMain(input: Varying) -> @location(0) vec4<f32> {
  return vec4<f32>(ramp(edgeDistance(input.e0, input.position.xy)));
}
`;

export const P3_COVERAGE_SHADERS = Object.freeze({
  A1: P3_COVERAGE_A1_WGSL,
  A2: P3_COVERAGE_A2_WGSL,
  A5: P3_COVERAGE_A5_WGSL,
});

export type P3CoverageCandidate = keyof typeof P3_COVERAGE_SHADERS;
