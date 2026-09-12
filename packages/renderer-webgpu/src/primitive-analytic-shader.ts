export const PRIMITIVE_ANALYTIC_SHADER_KEY = 'p1-analytic-v1';

export const PRIMITIVE_ANALYTIC_SHADER = /* wgsl */ `
struct TransformRecord {
  linear: vec4f,
  translation: vec2f,
  padding: vec2f,
};

struct GeometryRecord {
  kind: u32,
  padding: u32,
  size: vec2f,
  radii: vec4f,
  line: vec4f,
};

struct StyleRecord {
  fill: vec4f,
  stroke: vec4f,
  strokeWidth: f32,
  opacity: f32,
  flags: u32,
  padding: u32,
};

struct FrameRecord {
  originMinusCamera: vec2f,
  zoom: f32,
  devicePixelRatio: f32,
  physicalSize: vec2f,
  padding: vec2f,
};

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) localPosition: vec2f,
  @location(1) @interpolate(flat) slot: u32,
};

@group(0) @binding(0) var<storage, read> transforms: array<TransformRecord>;
@group(0) @binding(1) var<storage, read> geometries: array<GeometryRecord>;
@group(0) @binding(2) var<storage, read> styles: array<StyleRecord>;
@group(0) @binding(3) var<storage, read> order: array<u32>;
@group(0) @binding(4) var<uniform> frame: FrameRecord;

const RECTANGLE_KIND: u32 = 0u;
const ELLIPSE_KIND: u32 = 1u;
const LINE_KIND: u32 = 2u;
const FILL_PRESENT: u32 = 1u;
const STROKE_PRESENT: u32 = 2u;
const LARGE_DISTANCE: f32 = 1e30;

fn transformPoint(transform: TransformRecord, point: vec2f) -> vec2f {
  let firstColumn = transform.linear.xy * point.x;
  let secondColumn = transform.linear.zw * point.y;
  return (firstColumn + secondColumn) + transform.translation;
}

fn localGuard(transform: TransformRecord) -> vec2f {
  let determinant = transform.linear.x * transform.linear.w -
    transform.linear.y * transform.linear.z;
  let documentGuard = 2.0 / (frame.zoom * frame.devicePixelRatio);
  return documentGuard * vec2f(
    abs(transform.linear.w) + abs(transform.linear.z),
    abs(transform.linear.y) + abs(transform.linear.x),
  ) / abs(determinant);
}

@vertex
fn vertexMain(
  @location(0) unitPosition: vec2f,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOutput {
  let slot = order[instanceIndex];
  let transform = transforms[slot];
  let geometry = geometries[slot];
  let style = styles[slot];
  let halfStroke = select(0.0, style.strokeWidth * 0.5, (style.flags & STROKE_PRESENT) != 0u);

  var lower = vec2f(-halfStroke);
  var upper = geometry.size + vec2f(halfStroke);
  if (geometry.kind == LINE_KIND) {
    lower = min(geometry.line.xy, geometry.line.zw) - vec2f(halfStroke);
    upper = max(geometry.line.xy, geometry.line.zw) + vec2f(halfStroke);
  }

  let guard = localGuard(transform);
  let guardedLower = lower - guard;
  let guardedUpper = upper + guard;
  let localPosition = vec2f(
    select(guardedLower.x, guardedUpper.x, unitPosition.x == 1.0),
    select(guardedLower.y, guardedUpper.y, unitPosition.y == 1.0),
  );
  let documentPosition = transformPoint(transform, localPosition) + frame.originMinusCamera;
  let physicalPosition = documentPosition * frame.zoom * frame.devicePixelRatio;

  var output: VertexOutput;
  output.position = vec4f(
    physicalPosition.x * 2.0 / frame.physicalSize.x - 1.0,
    1.0 - physicalPosition.y * 2.0 / frame.physicalSize.y,
    0.0,
    1.0,
  );
  output.localPosition = localPosition;
  output.slot = slot;
  return output;
}

fn segmentDistance(point: vec2f, start: vec2f, end: vec2f) -> f32 {
  let delta = end - start;
  let denominator = dot(delta, delta);
  if (denominator == 0.0) {
    return distance(point, start);
  }
  let amount = clamp(dot(point - start, delta) / denominator, 0.0, 1.0);
  return distance(point, start + amount * delta);
}

fn cornerArcDistance(
  point: vec2f,
  center: vec2f,
  radius: f32,
  quadrant: vec2f,
) -> f32 {
  if (radius == 0.0) {
    return LARGE_DISTANCE;
  }
  let relative = point - center;
  var result = min(
    distance(point, center + vec2f(quadrant.x * radius, 0.0)),
    distance(point, center + vec2f(0.0, quadrant.y * radius)),
  );
  if (relative.x * quadrant.x >= 0.0 && relative.y * quadrant.y >= 0.0) {
    let relativeLength = length(relative);
    if (relativeLength > 0.0) {
      result = min(result, distance(point, center + relative / relativeLength * radius));
    }
  }
  return result;
}

fn roundedRectangleInside(point: vec2f, size: vec2f, radii: vec4f) -> bool {
  if (point.x < 0.0 || point.y < 0.0 || point.x > size.x || point.y > size.y) {
    return false;
  }
  var inside = true;
  if (point.x < radii.x && point.y < radii.x) {
    inside = inside && distance(point, vec2f(radii.x)) <= radii.x;
  }
  if (point.x > size.x - radii.y && point.y < radii.y) {
    inside = inside && distance(point, vec2f(size.x - radii.y, radii.y)) <= radii.y;
  }
  if (point.x > size.x - radii.z && point.y > size.y - radii.z) {
    inside = inside && distance(point, size - vec2f(radii.z)) <= radii.z;
  }
  if (point.x < radii.w && point.y > size.y - radii.w) {
    inside = inside && distance(point, vec2f(radii.w, size.y - radii.w)) <= radii.w;
  }
  return inside;
}

fn roundedRectangleDistance(point: vec2f, size: vec2f, radii: vec4f) -> f32 {
  var boundaryDistance = LARGE_DISTANCE;
  boundaryDistance = min(boundaryDistance, segmentDistance(point, vec2f(radii.x, 0.0), vec2f(size.x - radii.y, 0.0)));
  boundaryDistance = min(boundaryDistance, segmentDistance(point, vec2f(size.x, radii.y), vec2f(size.x, size.y - radii.z)));
  boundaryDistance = min(boundaryDistance, segmentDistance(point, vec2f(size.x - radii.z, size.y), vec2f(radii.w, size.y)));
  boundaryDistance = min(boundaryDistance, segmentDistance(point, vec2f(0.0, size.y - radii.w), vec2f(0.0, radii.x)));
  boundaryDistance = min(boundaryDistance, cornerArcDistance(point, vec2f(radii.x), radii.x, vec2f(-1.0)));
  boundaryDistance = min(boundaryDistance, cornerArcDistance(point, vec2f(size.x - radii.y, radii.y), radii.y, vec2f(1.0, -1.0)));
  boundaryDistance = min(boundaryDistance, cornerArcDistance(point, size - vec2f(radii.z), radii.z, vec2f(1.0)));
  boundaryDistance = min(boundaryDistance, cornerArcDistance(point, vec2f(radii.w, size.y - radii.w), radii.w, vec2f(-1.0, 1.0)));
  return select(boundaryDistance, -boundaryDistance, roundedRectangleInside(point, size, radii));
}

fn ellipseRoot(point: vec2f, squaredRadii: vec2f, parameter: f32) -> f32 {
  let scaled = sqrt(squaredRadii) * point / (vec2f(parameter) + squaredRadii);
  return dot(scaled, scaled) - 1.0;
}

fn ellipseDistance(rawPoint: vec2f, rawRadii: vec2f) -> f32 {
  var point = abs(rawPoint);
  var radii = rawRadii;
  if (radii.x < radii.y) {
    point = point.yx;
    radii = radii.yx;
  }
  if (abs(radii.x - radii.y) <= 1e-6 * radii.x) {
    return length(point) - radii.x;
  }

  let normalizedSquared = dot(point / radii, point / radii);
  let insideSign = select(1.0, -1.0, normalizedSquared < 1.0);
  if (point.x == 0.0 && point.y == 0.0) {
    return -radii.y;
  }
  if (point.y <= 1e-6 * radii.x) {
    let cosine = clamp(radii.x * point.x / (radii.x * radii.x - radii.y * radii.y), 0.0, 1.0);
    let offAxis = radii * vec2f(cosine, sqrt(max(0.0, 1.0 - cosine * cosine)));
    let axisDistance = abs(radii.x - point.x);
    return min(axisDistance, distance(point, offAxis)) * insideSign;
  }
  if (point.x <= 1e-6 * radii.x) {
    return abs(radii.y - point.y) * insideSign;
  }

  let squaredRadii = radii * radii;
  var lower: f32;
  var upper: f32;
  if (normalizedSquared < 1.0) {
    lower = -squaredRadii.y;
    upper = 0.0;
  } else {
    lower = 0.0;
    upper = radii.x * point.x + radii.y * point.y;
  }
  for (var iteration = 0u; iteration < 28u; iteration += 1u) {
    let middle = (lower + upper) * 0.5;
    if (ellipseRoot(point, squaredRadii, middle) > 0.0) {
      lower = middle;
    } else {
      upper = middle;
    }
  }
  let parameter = (lower + upper) * 0.5;
  let closest = squaredRadii * point / (vec2f(parameter) + squaredRadii);
  return distance(point, closest) * insideSign;
}

fn lineDistance(point: vec2f, endpoints: vec4f, strokeWidth: f32) -> f32 {
  let start = endpoints.xy;
  let end = endpoints.zw;
  let direction = end - start;
  let lineLength = length(direction);
  let tangent = direction / lineLength;
  let normal = vec2f(-tangent.y, tangent.x);
  let centered = point - (start + end) * 0.5;
  let boxPoint = abs(vec2f(dot(centered, tangent), dot(centered, normal))) -
    vec2f(lineLength * 0.5, strokeWidth * 0.5);
  return length(max(boxPoint, vec2f(0.0))) + min(max(boxPoint.x, boxPoint.y), 0.0);
}

fn analyticCoverage(distanceFromContour: f32) -> f32 {
  let filterWidth = max(fwidth(distanceFromContour), 1e-6);
  return clamp(0.5 - distanceFromContour / filterWidth, 0.0, 1.0);
}

fn premultipliedContribution(color: vec4f, coverage: f32) -> vec4f {
  let alpha = color.a * coverage;
  return vec4f(color.rgb * alpha, alpha);
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  let geometry = geometries[input.slot];
  let style = styles[input.slot];
  var contourDistance = LARGE_DISTANCE;
  if (geometry.kind == RECTANGLE_KIND) {
    contourDistance = roundedRectangleDistance(input.localPosition, geometry.size, geometry.radii);
  } else if (geometry.kind == ELLIPSE_KIND) {
    contourDistance = ellipseDistance(input.localPosition - geometry.size * 0.5, geometry.size * 0.5);
  } else if (geometry.kind == LINE_KIND) {
    contourDistance = lineDistance(input.localPosition, geometry.line, style.strokeWidth);
  }
  let contourCoverage = analyticCoverage(contourDistance);
  let centeredStrokeCoverage = analyticCoverage(abs(contourDistance) - style.strokeWidth * 0.5);

  var fill = vec4f(0.0);
  if (geometry.kind != LINE_KIND && (style.flags & FILL_PRESENT) != 0u) {
    fill = premultipliedContribution(style.fill, contourCoverage);
  }
  var stroke = vec4f(0.0);
  if ((style.flags & STROKE_PRESENT) != 0u && style.strokeWidth > 0.0) {
    let coverage = select(centeredStrokeCoverage, contourCoverage, geometry.kind == LINE_KIND);
    stroke = premultipliedContribution(style.stroke, coverage);
  }
  let local = stroke + fill * (1.0 - stroke.a);
  if (local.a == 0.0) {
    discard;
  }
  return local * style.opacity;
}
`;
