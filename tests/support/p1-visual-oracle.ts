import type { RenderNodeSnapshot, SceneAffine } from '@vector-studio/contracts';
import type { VisualFixture } from './p1-visual-corpus.js';

type Point = Readonly<{ x: number; y: number }>;
type Rgba = readonly [number, number, number, number];
type PrimitiveNode = Extract<RenderNodeSnapshot, { kind: 'primitive' }>;

interface Shape {
  readonly node: PrimitiveNode;
  readonly world: SceneAffine;
  readonly opacity: number;
  readonly minimumPhysicalScale: number;
}

type PhysicalContour =
  | Readonly<{ kind: 'segment'; start: Point; end: Point }>
  | Readonly<{
      kind: 'curve';
      start: number;
      end: number;
      divisions: number;
      evaluate(parameter: number): Point;
    }>;

export interface PixelSample {
  readonly position: Point;
  readonly actual: Rgba;
  readonly expected: Rgba;
  readonly kind: 'interior' | 'exterior' | 'edge-inside' | 'edge-outside';
}

export interface PixelInspection {
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly samples: readonly PixelSample[];
  /** Conservative distance of the farthest sampled color disagreement from every contour. */
  readonly edgeMaximumError: number;
  readonly checkedPixelCount: number;
  readonly stableSampleCount: number;
  readonly edgeBandSampleCount: number;
  readonly expectedPaintedSampleCount: number;
  readonly observedPaintedSampleCount: number;
  readonly edgeComparisons: readonly EdgeComparison[];
}

export interface EdgeComparison {
  readonly position: Point;
  readonly analyticDistance: number;
  readonly actual: Rgba;
  readonly expectedRegion: Rgba;
  readonly classifiedRegion: Rgba;
}

const CHANNEL_TOLERANCE = 2 / 255;
const STABLE_DISTANCE = 2;
const STABLE_NUMERIC_EPSILON = 1e-9;
const EDGE_TOLERANCE = 1;
const EDGE_BAND = 3;
const EDGE_NUMERIC_EPSILON = 1e-6;
const MAX_REPORTED_SAMPLES = 192;
const MAX_REPORTED_FAILURES = 24;
const MAX_EDGE_COMPARISONS = 96;
const IDENTITY: SceneAffine = [1, 0, 0, 1, 0, 0];

function compose(left: SceneAffine, right: SceneAffine): SceneAffine {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function transformPoint(transform: SceneAffine, value: Point): Point {
  return {
    x: transform[0] * value.x + transform[2] * value.y + transform[4],
    y: transform[1] * value.x + transform[3] * value.y + transform[5],
  };
}

function inverse(transform: SceneAffine): SceneAffine | null {
  const determinant = transform[0] * transform[3] - transform[1] * transform[2];
  if (determinant === 0) return null;
  return [
    transform[3] / determinant,
    -transform[1] / determinant,
    -transform[2] / determinant,
    transform[0] / determinant,
    (transform[2] * transform[5] - transform[3] * transform[4]) / determinant,
    (transform[1] * transform[4] - transform[0] * transform[5]) / determinant,
  ];
}

function minimumScale(transform: SceneAffine): number {
  const [a, b, c, d] = transform;
  const trace = a * a + b * b + c * c + d * d;
  const determinant = a * d - b * c;
  return Math.sqrt(
    Math.max(
      0,
      (trace - Math.sqrt(Math.max(0, trace * trace - 4 * determinant * determinant))) / 2,
    ),
  );
}

function sourceOver(source: Rgba, destination: Rgba): Rgba {
  return [
    source[0] + destination[0] * (1 - source[3]),
    source[1] + destination[1] * (1 - source[3]),
    source[2] + destination[2] * (1 - source[3]),
    source[3] + destination[3] * (1 - source[3]),
  ];
}

function normalizedRadii(
  radii: readonly [number, number, number, number],
  width: number,
  height: number,
): readonly [number, number, number, number] {
  const [topLeft, topRight, bottomRight, bottomLeft] = radii;
  const ratios = [1];
  if (topLeft + topRight > 0) ratios.push(width / (topLeft + topRight));
  if (bottomLeft + bottomRight > 0) ratios.push(width / (bottomLeft + bottomRight));
  if (topLeft + bottomLeft > 0) ratios.push(height / (topLeft + bottomLeft));
  if (topRight + bottomRight > 0) ratios.push(height / (topRight + bottomRight));
  const scale = Math.min(...ratios);
  return radii.map((radius) => radius * scale) as [number, number, number, number];
}

function segmentDistance(value: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  const amount =
    denominator === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((value.x - start.x) * dx + (value.y - start.y) * dy) / denominator),
        );
  return Math.hypot(value.x - (start.x + amount * dx), value.y - (start.y + amount * dy));
}

function arcDistance(
  value: Point,
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
): number {
  if (radius === 0) return Math.hypot(value.x - center.x, value.y - center.y);
  let angle = Math.atan2(value.y - center.y, value.x - center.x);
  while (angle < startAngle) angle += Math.PI * 2;
  while (angle > endAngle) angle -= Math.PI * 2;
  angle = Math.max(startAngle, Math.min(endAngle, angle));
  return Math.hypot(
    value.x - (center.x + Math.cos(angle) * radius),
    value.y - (center.y + Math.sin(angle) * radius),
  );
}

function rectangleSignedDistance(
  value: Point,
  width: number,
  height: number,
  rawRadii: readonly [number, number, number, number],
): number {
  const radii = normalizedRadii(rawRadii, width, height);
  const [topLeft, topRight, bottomRight, bottomLeft] = radii;
  const distance = Math.min(
    segmentDistance(value, { x: topLeft, y: 0 }, { x: width - topRight, y: 0 }),
    segmentDistance(value, { x: width, y: topRight }, { x: width, y: height - bottomRight }),
    segmentDistance(value, { x: width - bottomRight, y: height }, { x: bottomLeft, y: height }),
    segmentDistance(value, { x: 0, y: height - bottomLeft }, { x: 0, y: topLeft }),
    arcDistance(value, { x: topLeft, y: topLeft }, topLeft, Math.PI, Math.PI * 1.5),
    arcDistance(value, { x: width - topRight, y: topRight }, topRight, Math.PI * 1.5, Math.PI * 2),
    arcDistance(
      value,
      { x: width - bottomRight, y: height - bottomRight },
      bottomRight,
      0,
      Math.PI / 2,
    ),
    arcDistance(value, { x: bottomLeft, y: height - bottomLeft }, bottomLeft, Math.PI / 2, Math.PI),
  );
  let inside = value.x >= 0 && value.y >= 0 && value.x <= width && value.y <= height;
  if (inside && value.x < topLeft && value.y < topLeft)
    inside = Math.hypot(value.x - topLeft, value.y - topLeft) <= topLeft;
  if (inside && value.x > width - topRight && value.y < topRight)
    inside = Math.hypot(value.x - (width - topRight), value.y - topRight) <= topRight;
  if (inside && value.x > width - bottomRight && value.y > height - bottomRight)
    inside =
      Math.hypot(value.x - (width - bottomRight), value.y - (height - bottomRight)) <= bottomRight;
  if (inside && value.x < bottomLeft && value.y > height - bottomLeft)
    inside = Math.hypot(value.x - bottomLeft, value.y - (height - bottomLeft)) <= bottomLeft;
  return inside ? -distance : distance;
}

function ellipseSignedDistance(value: Point, radiusX: number, radiusY: number): number {
  const inside =
    (value.x * value.x) / (radiusX * radiusX) + (value.y * value.y) / (radiusY * radiusY) <= 1;
  const distanceSquared = (angle: number) => {
    const dx = value.x - Math.cos(angle) * radiusX;
    const dy = value.y - Math.sin(angle) * radiusY;
    return dx * dx + dy * dy;
  };
  const divisions = 64;
  let bestIndex = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < divisions; index += 1) {
    const candidate = distanceSquared((index * Math.PI * 2) / divisions);
    if (candidate < best) {
      best = candidate;
      bestIndex = index;
    }
  }
  let lower = ((bestIndex - 1) * Math.PI * 2) / divisions;
  let upper = ((bestIndex + 1) * Math.PI * 2) / divisions;
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const first = (lower * 2 + upper) / 3;
    const second = (lower + upper * 2) / 3;
    if (distanceSquared(first) <= distanceSquared(second)) upper = second;
    else lower = first;
  }
  const distance = Math.sqrt(distanceSquared((lower + upper) / 2));
  return inside ? -distance : distance;
}

function lineSignedDistance(
  value: Point,
  start: Point,
  end: Point,
  strokeWidth: number,
): number | null {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return null;
  const tangentX = dx / length;
  const tangentY = dy / length;
  const centerX = value.x - (start.x + end.x) / 2;
  const centerY = value.y - (start.y + end.y) / 2;
  const boxX = Math.abs(centerX * tangentX + centerY * tangentY) - length / 2;
  const boxY = Math.abs(-centerX * tangentY + centerY * tangentX) - strokeWidth / 2;
  return Math.hypot(Math.max(boxX, 0), Math.max(boxY, 0)) + Math.min(Math.max(boxX, boxY), 0);
}

function shapeSignedDistance(shape: Shape, documentPoint: Point): number | null {
  const worldInverse = inverse(shape.world);
  if (worldInverse === null) return null;
  const local = transformPoint(worldInverse, documentPoint);
  const geometry = shape.node.geometry;
  if (geometry.kind === 'rectangle')
    return rectangleSignedDistance(local, geometry.width, geometry.height, geometry.cornerRadii);
  if (geometry.kind === 'ellipse')
    return ellipseSignedDistance(
      { x: local.x - geometry.width / 2, y: local.y - geometry.height / 2 },
      geometry.width / 2,
      geometry.height / 2,
    );
  return lineSignedDistance(
    local,
    geometry.start,
    geometry.end,
    shape.node.style.stroke?.width ?? 0,
  );
}

function localContourDistance(shape: Shape, signedDistance: number): number {
  const geometry = shape.node.geometry;
  const style = shape.node.style;
  if (geometry.kind === 'line') return Math.abs(signedDistance);
  const distances: number[] = [];
  const stroke = style.stroke !== null && style.stroke.width > 0 ? style.stroke : null;
  if (style.fill !== null && (stroke === null || stroke.color.a < 1))
    distances.push(Math.abs(signedDistance));
  if (stroke !== null) {
    const halfStroke = stroke.width / 2;
    distances.push(Math.abs(signedDistance - halfStroke), Math.abs(signedDistance + halfStroke));
  }
  return distances.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...distances);
}

function contourDistancePhysical(
  list: readonly Shape[],
  documentPoint: Point,
  zoom: number,
  dpr: number,
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const shape of list) {
    const distance = shapeSignedDistance(shape, documentPoint);
    if (distance === null) continue;
    nearest = Math.min(
      nearest,
      localContourDistance(shape, distance) * shape.minimumPhysicalScale * zoom * dpr,
    );
  }
  return nearest;
}

function premultiplied(color: Readonly<{ r: number; g: number; b: number; a: number }>): Rgba {
  return [color.r * color.a, color.g * color.a, color.b * color.a, color.a];
}

function shapeColor(shape: Shape, documentPoint: Point): Rgba {
  const distance = shapeSignedDistance(shape, documentPoint);
  if (distance === null) return [0, 0, 0, 0];
  const geometry = shape.node.geometry;
  const style = shape.node.style;
  const fill =
    geometry.kind !== 'line' && style.fill !== null && distance <= 0
      ? premultiplied(style.fill)
      : ([0, 0, 0, 0] as const);
  const strokePresent =
    style.stroke !== null &&
    style.stroke.width > 0 &&
    (geometry.kind === 'line' ? distance <= 0 : Math.abs(distance) <= style.stroke.width / 2);
  const stroke = strokePresent ? premultiplied(style.stroke.color) : ([0, 0, 0, 0] as const);
  const local = sourceOver(stroke, fill);
  return [
    local[0] * shape.opacity,
    local[1] * shape.opacity,
    local[2] * shape.opacity,
    local[3] * shape.opacity,
  ];
}

function sceneColor(list: readonly Shape[], fixture: VisualFixture, documentPoint: Point): Rgba {
  let result: Rgba = fixture.transparent ? [0, 0, 0, 0] : [0, 0, 0, 1];
  for (const shape of list) result = sourceOver(shapeColor(shape, documentPoint), result);
  return result;
}

function collectShapes(fixture: VisualFixture): Shape[] {
  const nodes = new Map(fixture.snapshot.nodes.map((node) => [node.id, node]));
  const result: Shape[] = [];
  const visit = (id: string, parent: SceneAffine, ancestorsVisible: boolean, opacity: number) => {
    const node = nodes.get(id);
    if (node === undefined) return;
    const world = compose(parent, node.transform);
    if (node.kind === 'container') {
      if (!ancestorsVisible || !node.visible) return;
      for (const child of node.children) visit(child, world, true, opacity * node.opacity);
      return;
    }
    const geometry = node.geometry;
    const drawableGeometry =
      geometry.kind === 'line'
        ? (geometry.start.x !== geometry.end.x || geometry.start.y !== geometry.end.y) &&
          node.style.stroke !== null &&
          node.style.stroke.width > 0
        : geometry.width > 0 &&
          geometry.height > 0 &&
          (node.style.fill !== null || (node.style.stroke !== null && node.style.stroke.width > 0));
    const scale = minimumScale(world);
    if (ancestorsVisible && node.visible && node.opacity > 0 && drawableGeometry && scale > 0) {
      result.push({
        node,
        world,
        opacity: opacity * node.opacity,
        minimumPhysicalScale: scale,
      });
    }
  };
  for (const id of fixture.snapshot.rootOrder) visit(id, IDENTITY, true, 1);
  return result;
}

function pixelCenterDocument(fixture: VisualFixture, dpr: number, x: number, y: number): Point {
  const scale = fixture.camera.zoom * dpr;
  return {
    x: fixture.camera.position.x + (x + 0.5) / scale,
    y: fixture.camera.position.y + (y + 0.5) / scale,
  };
}

function actualColor(rgba: Uint8Array, width: number, x: number, y: number): Rgba {
  const offset = (y * width + x) * 4;
  return [
    rgba[offset]! / 255,
    rgba[offset + 1]! / 255,
    rgba[offset + 2]! / 255,
    rgba[offset + 3]! / 255,
  ];
}

function colorError(left: Rgba, right: Rgba): number {
  return Math.max(...left.map((value, index) => Math.abs(value - right[index]!)));
}

function sameColor(left: Rgba, right: Rgba): boolean {
  return colorError(left, right) <= CHANNEL_TOLERANCE;
}

function localRegionColors(
  list: readonly Shape[],
  fixture: VisualFixture,
  dpr: number,
  x: number,
  y: number,
): readonly Rgba[] {
  const colors: Rgba[] = [];
  for (const offsetY of [-4, -2, 0, 2, 4]) {
    for (const offsetX of [-4, -2, 0, 2, 4]) {
      const color = sceneColor(
        list,
        fixture,
        pixelCenterDocument(fixture, dpr, x + offsetX, y + offsetY),
      );
      if (!colors.some((candidate) => sameColor(candidate, color))) colors.push(color);
    }
  }
  return colors;
}

function classifyRegion(actual: Rgba, expected: Rgba, regions: readonly Rgba[]): Rgba {
  const squaredDistance = (candidate: Rgba) =>
    candidate.reduce((sum, value, index) => sum + (actual[index]! - value) ** 2, 0);
  let classified = expected;
  let best = squaredDistance(expected);
  for (const candidate of regions) {
    const distance = squaredDistance(candidate);
    if (distance + 1e-12 < best) {
      classified = candidate;
      best = distance;
    }
  }
  return classified;
}

function contourSeeds(shape: Shape): readonly Point[] {
  const geometry = shape.node.geometry;
  if (geometry.kind === 'line') {
    const dx = geometry.end.x - geometry.start.x;
    const dy = geometry.end.y - geometry.start.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) return [];
    const half = (shape.node.style.stroke?.width ?? 0) / 2;
    const normal = { x: (-dy * half) / length, y: (dx * half) / length };
    return [
      { x: geometry.start.x + normal.x, y: geometry.start.y + normal.y },
      { x: geometry.end.x + normal.x, y: geometry.end.y + normal.y },
      { x: geometry.end.x - normal.x, y: geometry.end.y - normal.y },
      { x: geometry.start.x - normal.x, y: geometry.start.y - normal.y },
      {
        x: (geometry.start.x + geometry.end.x) / 2 + normal.x,
        y: (geometry.start.y + geometry.end.y) / 2 + normal.y,
      },
      {
        x: (geometry.start.x + geometry.end.x) / 2 - normal.x,
        y: (geometry.start.y + geometry.end.y) / 2 - normal.y,
      },
    ];
  }
  const count = 64;
  if (geometry.kind === 'ellipse')
    return Array.from({ length: count }, (_, index) => {
      const angle = (index * Math.PI * 2) / count;
      return {
        x: geometry.width / 2 + (Math.cos(angle) * geometry.width) / 2,
        y: geometry.height / 2 + (Math.sin(angle) * geometry.height) / 2,
      };
    });
  const radii = normalizedRadii(geometry.cornerRadii, geometry.width, geometry.height);
  return Array.from({ length: count }, (_, index) => {
    const perimeter = (index * 4) / count;
    const side = Math.floor(perimeter);
    const amount = perimeter - side;
    if (side === 0)
      return {
        x: radii[0] + amount * (geometry.width - radii[0] - radii[1]),
        y: 0,
      };
    if (side === 1)
      return {
        x: geometry.width,
        y: radii[1] + amount * (geometry.height - radii[1] - radii[2]),
      };
    if (side === 2)
      return {
        x: geometry.width - radii[2] - amount * (geometry.width - radii[2] - radii[3]),
        y: geometry.height,
      };
    return {
      x: 0,
      y: geometry.height - radii[3] - amount * (geometry.height - radii[3] - radii[0]),
    };
  });
}

function toPhysical(shape: Shape, fixture: VisualFixture, dpr: number, local: Point): Point {
  const document = transformPoint(shape.world, local);
  const scale = fixture.camera.zoom * dpr;
  return {
    x: (document.x - fixture.camera.position.x) * scale,
    y: (document.y - fixture.camera.position.y) * scale,
  };
}

function rectangleLevelContours(
  shape: Shape,
  fixture: VisualFixture,
  dpr: number,
  level: number,
): readonly PhysicalContour[] {
  const geometry = shape.node.geometry;
  if (geometry.kind !== 'rectangle') return [];
  const width = geometry.width + 2 * level;
  const height = geometry.height + 2 * level;
  if (width <= 0 || height <= 0) return [];
  const origin = -level;
  const radii = normalizedRadii(geometry.cornerRadii, geometry.width, geometry.height).map(
    (radius) => Math.max(0, radius + level),
  ) as [number, number, number, number];
  const [topLeft, topRight, bottomRight, bottomLeft] = radii;
  const right = origin + width;
  const bottom = origin + height;
  const physical = (local: Point) => toPhysical(shape, fixture, dpr, local);
  const segment = (start: Point, end: Point): PhysicalContour => ({
    kind: 'segment',
    start: physical(start),
    end: physical(end),
  });
  const arc = (center: Point, radius: number, start: number, end: number): PhysicalContour => ({
    kind: 'curve',
    start,
    end,
    divisions: 16,
    evaluate: (angle) =>
      physical({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius }),
  });
  return [
    segment({ x: origin + topLeft, y: origin }, { x: right - topRight, y: origin }),
    segment({ x: right, y: origin + topRight }, { x: right, y: bottom - bottomRight }),
    segment({ x: right - bottomRight, y: bottom }, { x: origin + bottomLeft, y: bottom }),
    segment({ x: origin, y: bottom - bottomLeft }, { x: origin, y: origin + topLeft }),
    arc({ x: origin + topLeft, y: origin + topLeft }, topLeft, Math.PI, Math.PI * 1.5),
    arc({ x: right - topRight, y: origin + topRight }, topRight, Math.PI * 1.5, Math.PI * 2),
    arc({ x: right - bottomRight, y: bottom - bottomRight }, bottomRight, 0, Math.PI / 2),
    arc({ x: origin + bottomLeft, y: bottom - bottomLeft }, bottomLeft, Math.PI / 2, Math.PI),
  ];
}

function ellipseLevelContour(
  shape: Shape,
  fixture: VisualFixture,
  dpr: number,
  level: number,
): PhysicalContour {
  const geometry = shape.node.geometry;
  if (geometry.kind !== 'ellipse') throw new TypeError('ellipse contour requires ellipse geometry');
  const radiusX = geometry.width / 2;
  const radiusY = geometry.height / 2;
  return {
    kind: 'curve',
    start: 0,
    end: Math.PI * 2,
    divisions: 64,
    evaluate: (angle) => {
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const normalLength = Math.hypot(cosine / radiusX, sine / radiusY);
      return toPhysical(shape, fixture, dpr, {
        x: radiusX + cosine * radiusX + (level * cosine) / (radiusX * normalLength),
        y: radiusY + sine * radiusY + (level * sine) / (radiusY * normalLength),
      });
    },
  };
}

function lineBoxContours(
  shape: Shape,
  fixture: VisualFixture,
  dpr: number,
): readonly PhysicalContour[] {
  const geometry = shape.node.geometry;
  if (geometry.kind !== 'line') return [];
  const dx = geometry.end.x - geometry.start.x;
  const dy = geometry.end.y - geometry.start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [];
  const half = (shape.node.style.stroke?.width ?? 0) / 2;
  const nx = (-dy * half) / length;
  const ny = (dx * half) / length;
  const corners = [
    { x: geometry.start.x + nx, y: geometry.start.y + ny },
    { x: geometry.end.x + nx, y: geometry.end.y + ny },
    { x: geometry.end.x - nx, y: geometry.end.y - ny },
    { x: geometry.start.x - nx, y: geometry.start.y - ny },
  ].map((local) => toPhysical(shape, fixture, dpr, local));
  return corners.map((start, index): PhysicalContour => ({
    kind: 'segment',
    start,
    end: corners[(index + 1) % corners.length]!,
  }));
}

function buildPhysicalContours(
  list: readonly Shape[],
  fixture: VisualFixture,
  dpr: number,
): readonly PhysicalContour[] {
  const result: PhysicalContour[] = [];
  for (const shape of list) {
    const geometry = shape.node.geometry;
    const stroke =
      shape.node.style.stroke !== null && shape.node.style.stroke.width > 0
        ? shape.node.style.stroke
        : null;
    if (geometry.kind === 'line') {
      result.push(...lineBoxContours(shape, fixture, dpr));
      continue;
    }
    const levels = stroke === null ? [0] : [stroke.width / 2, -stroke.width / 2];
    if (shape.node.style.fill !== null && stroke !== null && stroke.color.a < 1) levels.push(0);
    for (const level of levels) {
      if (geometry.kind === 'rectangle')
        result.push(...rectangleLevelContours(shape, fixture, dpr, level));
      else result.push(ellipseLevelContour(shape, fixture, dpr, level));
    }
  }
  return result;
}

function curveDistance(contour: Extract<PhysicalContour, { kind: 'curve' }>, value: Point): number {
  const squared = (parameter: number) => {
    const candidate = contour.evaluate(parameter);
    return (candidate.x - value.x) ** 2 + (candidate.y - value.y) ** 2;
  };
  let bestIndex = 0;
  let best = Number.POSITIVE_INFINITY;
  const periodic = Math.abs(contour.end - contour.start - Math.PI * 2) <= 1e-12;
  const sampleCount = periodic ? contour.divisions : contour.divisions + 1;
  for (let index = 0; index < sampleCount; index += 1) {
    const parameter = contour.start + ((contour.end - contour.start) * index) / contour.divisions;
    const candidate = squared(parameter);
    if (candidate < best) {
      best = candidate;
      bestIndex = index;
    }
  }
  const step = (contour.end - contour.start) / contour.divisions;
  let lower = periodic
    ? contour.start + (bestIndex - 1) * step
    : Math.max(contour.start, contour.start + (bestIndex - 1) * step);
  let upper = periodic
    ? contour.start + (bestIndex + 1) * step
    : Math.min(contour.end, contour.start + (bestIndex + 1) * step);
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const first = (lower * 2 + upper) / 3;
    const second = (lower + upper * 2) / 3;
    if (squared(first) <= squared(second)) upper = second;
    else lower = first;
  }
  return Math.sqrt(squared((lower + upper) / 2));
}

function exactContourDistance(contours: readonly PhysicalContour[], value: Point): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const contour of contours)
    nearest = Math.min(
      nearest,
      contour.kind === 'segment'
        ? segmentDistance(value, contour.start, contour.end)
        : curveDistance(contour, value),
    );
  return nearest;
}

function candidatePixels(
  list: readonly Shape[],
  fixture: VisualFixture,
  dpr: number,
  width: number,
  height: number,
): readonly Point[] {
  if (list.length === 0)
    return Array.from({ length: width * height }, (_, index) => ({
      x: index % width,
      y: Math.floor(index / width),
    }));
  const keys = new Set<string>();
  const add = (x: number, y: number) => {
    if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < width && y < height)
      keys.add(`${x}:${y}`);
  };
  for (let row = 0; row <= 14; row += 1)
    for (let column = 0; column <= 24; column += 1)
      add(
        Math.min(width - 1, Math.floor((column * width) / 24)),
        Math.min(height - 1, Math.floor((row * height) / 14)),
      );

  const scanRows = Array.from({ length: 9 }, (_, index) =>
    Math.min(height - 1, Math.floor(((index + 0.5) * height) / 9)),
  );
  const scanColumns = Array.from({ length: 13 }, (_, index) =>
    Math.min(width - 1, Math.floor(((index + 0.5) * width) / 13)),
  );
  for (const y of scanRows) for (let x = 0; x < width; x += 2) add(x, y);
  for (const x of scanColumns) for (let y = 0; y < height; y += 2) add(x, y);

  const scale = fixture.camera.zoom * dpr;
  for (const shape of list) {
    for (const seed of contourSeeds(shape)) {
      const documentPoint = transformPoint(shape.world, seed);
      const centerX = Math.floor((documentPoint.x - fixture.camera.position.x) * scale);
      const centerY = Math.floor((documentPoint.y - fixture.camera.position.y) * scale);
      for (let dy = -4; dy <= 4; dy += 1)
        for (let dx = -4; dx <= 4; dx += 1) add(centerX + dx, centerY + dy);
    }
  }
  return [...keys].map((key) => {
    const [x, y] = key.split(':').map(Number);
    return { x: x!, y: y! };
  });
}

export function inspectPixels(
  fixture: VisualFixture,
  dpr: number,
  width: number,
  height: number,
  rgba: Uint8Array,
): PixelInspection {
  if (rgba.byteLength !== width * height * 4) {
    return {
      pass: false,
      failures: ['RGBA dimensions do not match supplied image'],
      samples: [],
      edgeMaximumError: Number.POSITIVE_INFINITY,
      checkedPixelCount: 0,
      stableSampleCount: 0,
      edgeBandSampleCount: 0,
      expectedPaintedSampleCount: 0,
      observedPaintedSampleCount: 0,
      edgeComparisons: [],
    };
  }

  const list = collectShapes(fixture);
  const contours = buildPhysicalContours(list, fixture, dpr);
  const failures: string[] = [];
  const failureSamples: PixelSample[] = [];
  const representativeSamples: PixelSample[] = [];
  let stableSampleCount = 0;
  let edgeBandSampleCount = 0;
  let stableFailureCount = 0;
  let edgeFailureCount = 0;
  let edgeMaximumError = 0;
  let expectedPaintedSampleCount = 0;
  let observedPaintedSampleCount = 0;
  const edgeComparisons: EdgeComparison[] = [];
  const clear: Rgba = fixture.transparent ? [0, 0, 0, 0] : [0, 0, 0, 1];
  const candidates = candidatePixels(list, fixture, dpr, width, height);

  for (const position of candidates) {
    const documentPoint = pixelCenterDocument(fixture, dpr, position.x, position.y);
    const expected = sceneColor(list, fixture, documentPoint);
    const actual = actualColor(rgba, width, position.x, position.y);
    const distance = contourDistancePhysical(list, documentPoint, fixture.camera.zoom, dpr);
    const differs = !sameColor(actual, expected);
    const expectedClear = sameColor(expected, clear);
    if (!expectedClear) expectedPaintedSampleCount += 1;
    if (!sameColor(actual, clear)) observedPaintedSampleCount += 1;
    const kind: PixelSample['kind'] =
      distance + STABLE_NUMERIC_EPSILON >= STABLE_DISTANCE
        ? expectedClear
          ? 'exterior'
          : 'interior'
        : expectedClear
          ? 'edge-outside'
          : 'edge-inside';
    const sample = { position, actual, expected, kind } as const;

    if (distance + STABLE_NUMERIC_EPSILON >= STABLE_DISTANCE) {
      stableSampleCount += 1;
      if (differs) {
        stableFailureCount += 1;
        if (failureSamples.length < MAX_REPORTED_SAMPLES) failureSamples.push(sample);
        if (failures.length < MAX_REPORTED_FAILURES)
          failures.push(
            `RGBA ${kind} sample ${position.x},${position.y} is ${distance.toFixed(3)} physical pixels from every contour and exceeds 2/255`,
          );
      }
      if (
        representativeSamples.length < MAX_REPORTED_SAMPLES &&
        !expectedClear &&
        !representativeSamples.some(
          (candidate) => candidate.kind === kind && sameColor(candidate.expected, expected),
        )
      )
        representativeSamples.push(sample);
    }

    if (distance <= EDGE_BAND) {
      edgeBandSampleCount += 1;
      if (differs) {
        const exactDistance = exactContourDistance(contours, {
          x: position.x + 0.5,
          y: position.y + 0.5,
        });
        const classifiedRegion = classifyRegion(
          actual,
          expected,
          localRegionColors(list, fixture, dpr, position.x, position.y),
        );
        if (edgeComparisons.length < MAX_EDGE_COMPARISONS)
          edgeComparisons.push({
            position,
            analyticDistance: exactDistance,
            actual,
            expectedRegion: expected,
            classifiedRegion,
          });
        if (!sameColor(classifiedRegion, expected))
          edgeMaximumError = Math.max(edgeMaximumError, exactDistance);
        if (
          !sameColor(classifiedRegion, expected) &&
          exactDistance > EDGE_TOLERANCE + EDGE_NUMERIC_EPSILON
        ) {
          edgeFailureCount += 1;
          if (failureSamples.length < MAX_REPORTED_SAMPLES) failureSamples.push(sample);
          if (failures.length < MAX_REPORTED_FAILURES)
            failures.push(
              `edge color disagreement at ${position.x},${position.y} is ${exactDistance.toFixed(3)} physical pixels from the nearest analytic contour`,
            );
        }
      }
    }
  }

  if (stableFailureCount > MAX_REPORTED_FAILURES)
    failures.push(
      `${stableFailureCount - MAX_REPORTED_FAILURES} additional stable RGBA failures omitted`,
    );
  if (edgeFailureCount > MAX_REPORTED_FAILURES)
    failures.push(
      `${edgeFailureCount - MAX_REPORTED_FAILURES} additional edge displacement failures omitted`,
    );
  if (stableSampleCount === 0 && edgeBandSampleCount === 0)
    failures.push('oracle found no eligible stable or edge-band samples');
  if (expectedPaintedSampleCount > 0 && observedPaintedSampleCount === 0)
    failures.push('visible geometry has sampled binary coverage but the image is entirely clear');

  return {
    pass: failures.length === 0,
    failures,
    samples: [
      ...failureSamples,
      ...representativeSamples.slice(0, MAX_REPORTED_SAMPLES - failureSamples.length),
    ],
    edgeMaximumError,
    checkedPixelCount: candidates.length,
    stableSampleCount,
    edgeBandSampleCount,
    expectedPaintedSampleCount,
    observedPaintedSampleCount,
    edgeComparisons,
  };
}
