import type { RenderNodeSnapshot, SceneAffine } from '@vector-studio/contracts';
import type { SceneBounds } from './scene-numeric.js';

export const PRIMITIVE_STRIDES = Object.freeze({
  transforms: 32,
  geometry: 48,
  styles: 48,
  order: 4,
  frame: 32,
});

export type PrimitivePackingAssessment = Readonly<{
  quantizationPhysicalPixels: number;
  arithmeticPhysicalPixels: number;
}>;

export class PrimitiveNumericPreparationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PrimitiveNumericPreparationError';
  }
}

export function normalizeRectangleRadii(
  width: number,
  height: number,
  radii: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  const [topLeft, topRight, bottomRight, bottomLeft] = radii;
  const factors = [1];
  addRatio(factors, width, topLeft + topRight);
  addRatio(factors, width, bottomLeft + bottomRight);
  addRatio(factors, height, topLeft + bottomLeft);
  addRatio(factors, height, topRight + bottomRight);
  const scale = Math.min(...factors);
  return Object.freeze([
    topLeft * scale,
    topRight * scale,
    bottomRight * scale,
    bottomLeft * scale,
  ]);
}

export function writePackedRecord(
  destination: Uint8Array,
  byteOffset: number,
  resource: 'transforms' | 'geometry' | 'styles',
  lanes: readonly number[],
): void {
  const view = new DataView(destination.buffer, destination.byteOffset + byteOffset);
  for (let index = 0; index < lanes.length; index += 1) {
    if ((resource === 'geometry' && index === 0) || (resource === 'styles' && index === 10)) {
      view.setUint32(index * 4, lanes[index]!, true);
    } else {
      view.setFloat32(index * 4, lanes[index]!, true);
    }
  }
}

type Point = readonly [number, number];
type PrimitiveNode = Extract<RenderNodeSnapshot, { kind: 'primitive' }>;
type ErrorVertex = { point: Point; reference: Point; quantization: Point; arithmetic: Point };
const f = Math.fround;

/**
 * Continuous bound for the ordered-f32 vertex model, not a native rasterizer proof.
 * All rounding is evaluated at the four fixed GPU vertices, including stroke/guard
 * construction and NDC. Once those vertices are fixed, each error field is affine
 * over its triangle. Clip the triangles to the guarded viewport and maximize each
 * affine field at the resulting polygon vertices: this encloses every contour
 * segment inside them, rather than sampling fround at arbitrary contour points.
 * Local coordinates and clip positions use the same rounded quad endpoints, so
 * guard construction reparameterizes that affine map; it does not alter geometry.
 * Native interpolation/compiler behavior still requires the P1.5 image fixtures.
 */
// E26-U5d-1: `primitivePackingWithinBudget` repeats this vertex arithmetic; keep the two in step.
export function assessPrimitivePacking(
  world: SceneAffine,
  localBounds: SceneBounds,
  origin: Readonly<{ x: number; y: number }>,
  camera: Readonly<{ x: number; y: number }>,
  zoom: number,
  devicePixelRatio: number,
  physicalWidth: number,
  physicalHeight: number,
  node?: PrimitiveNode,
): PrimitivePackingAssessment {
  const linear = world.slice(0, 4).map(f);
  const translation = [f(world[4] - origin.x), f(world[5] - origin.y)] as const;
  const offset = [f(origin.x - camera.x), f(origin.y - camera.y)] as const;
  const z = f(zoom),
    dpr = f(devicePixelRatio);
  const determinant = f(f(linear[0]! * linear[3]!) - f(linear[1]! * linear[2]!));
  assertFinite([...linear, ...translation, ...offset, z, dpr, determinant]);
  if (z <= 0 || dpr <= 0 || determinant === 0) {
    throw new PrimitiveNumericPreparationError(
      'singular transform or underflowed frame scale in packet v1',
    );
  }
  const documentGuard = f(2 / f(z * dpr));
  const guard: Point = [
    f(f(documentGuard * f(Math.abs(linear[3]!) + Math.abs(linear[2]!))) / Math.abs(determinant)),
    f(f(documentGuard * f(Math.abs(linear[1]!) + Math.abs(linear[0]!))) / Math.abs(determinant)),
  ];
  const storedBounds = storedLocalBounds(localBounds, node);
  const lower: Point = [f(storedBounds.minX - guard[0]), f(storedBounds.minY - guard[1])];
  const upper: Point = [f(storedBounds.maxX + guard[0]), f(storedBounds.maxY + guard[1])];
  assertFinite([...guard, ...lower, ...upper]);
  if (upper[0] <= lower[0] || upper[1] <= lower[1]) {
    throw new PrimitiveNumericPreparationError('quad collapses in packet v1');
  }
  const vertices: ErrorVertex[] = [];
  for (const point of [
    [lower[0], lower[1]],
    [upper[0], lower[1]],
    [lower[0], upper[1]],
    [upper[0], upper[1]],
  ] as const) {
    const reference: Point = [
      (world[0] * point[0] + world[2] * point[1] + (world[4] - camera.x)) * zoom * devicePixelRatio,
      (world[1] * point[0] + world[3] * point[1] + (world[5] - camera.y)) * zoom * devicePixelRatio,
    ];
    const stored: Point = [
      (linear[0]! * point[0] + linear[2]! * point[1] + translation[0] + offset[0]) * z * dpr,
      (linear[1]! * point[0] + linear[3]! * point[1] + translation[1] + offset[1]) * z * dpr,
    ];
    const physical: Point = [0, 1].map((axis) => {
      const sum = f(
        f(f(linear[axis]! * point[0]) + f(linear[axis + 2]! * point[1])) + translation[axis]!,
      );
      return f(f(f(sum + offset[axis]!) * z) * dpr);
    }) as unknown as Point;
    const ndc: Point = [
      f(f(f(physical[0] * 2) / f(physicalWidth)) - 1),
      f(1 - f(f(physical[1] * 2) / f(physicalHeight))),
    ];
    const recovered: Point = [
      ((ndc[0] + 1) * physicalWidth) / 2,
      ((1 - ndc[1]) * physicalHeight) / 2,
    ];
    assertFinite([...reference, ...stored, ...physical, ...ndc, ...recovered]);
    vertices.push({
      point,
      reference,
      quantization: [stored[0] - reference[0], stored[1] - reference[1]],
      arithmetic: [recovered[0] - stored[0], recovered[1] - stored[1]],
    });
  }
  let quantization = 0,
    arithmetic = 0;
  const localError = geometryStorageError(localBounds, node);
  const geometryError =
    Math.max(Math.abs(world[0]) + Math.abs(world[2]), Math.abs(world[1]) + Math.abs(world[3])) *
    localError *
    zoom *
    devicePixelRatio;
  for (const indices of [
    [0, 1, 2],
    [2, 1, 3],
  ]) {
    let polygon = indices.map((index) => vertices[index]!);
    for (const [axis, limit, direction] of [
      [0, -2, 1],
      [0, physicalWidth + 2, -1],
      [1, -2, 1],
      [1, physicalHeight + 2, -1],
    ] as const) {
      polygon = clipErrorPolygon(polygon, axis, limit, direction);
    }
    for (const vertex of polygon) {
      quantization = Math.max(
        quantization,
        Math.abs(vertex.quantization[0]) + geometryError,
        Math.abs(vertex.quantization[1]) + geometryError,
      );
      arithmetic = Math.max(
        arithmetic,
        Math.abs(vertex.arithmetic[0]),
        Math.abs(vertex.arithmetic[1]),
      );
    }
  }
  // Float64 bookkeeping (subtractions, four clipping passes and interpolation)
  // is outside the f32 model. Charge a 64-operation relative roundoff envelope.
  const bookkeeping =
    64 *
    Number.EPSILON *
    Math.max(1, ...vertices.flatMap((vertex) => [...vertex.reference.map(Math.abs)]));
  assertFinite([quantization, arithmetic, bookkeeping]);
  return Object.freeze({
    quantizationPhysicalPixels: quantization + bookkeeping,
    arithmeticPhysicalPixels: arithmetic + bookkeeping,
  });
}

/**
 * E26 contract, U5d: a sufficient condition for `assessPrimitivePacking` to stay within `budget`
 * on both measures, without its clipping. Each error field is affine over its triangle, so its
 * absolute value is convex and its maximum over the clipped polygon is at most its maximum over
 * the four unclipped vertices; the bookkeeping charge uses the same unclipped references as the
 * assessment. True means the assessment would pass; false means only that the caller must run
 * the assessment, which also throws whatever this check declines to decide (a singular transform,
 * a collapsed quad, non-finite arithmetic). The margin covers the float64 rounding of the
 * interpolation that the assessment does and this check does not. Its vertex arithmetic is the
 * assessment's, operation for operation: keep the two in step.
 */
export function primitivePackingWithinBudget(
  world: SceneAffine,
  localBounds: SceneBounds,
  origin: Readonly<{ x: number; y: number }>,
  camera: Readonly<{ x: number; y: number }>,
  zoom: number,
  devicePixelRatio: number,
  physicalWidth: number,
  physicalHeight: number,
  budget: number,
  node?: PrimitiveNode,
): boolean {
  const l0 = f(world[0]),
    l1 = f(world[1]),
    l2 = f(world[2]),
    l3 = f(world[3]);
  const t0 = f(world[4] - origin.x),
    t1 = f(world[5] - origin.y);
  const o0 = f(origin.x - camera.x),
    o1 = f(origin.y - camera.y);
  const z = f(zoom),
    dpr = f(devicePixelRatio);
  const determinant = f(f(l0 * l3) - f(l1 * l2));
  if (
    !Number.isFinite(l0 + l1 + l2 + l3 + t0 + t1 + o0 + o1 + z + dpr + determinant) ||
    z <= 0 ||
    dpr <= 0 ||
    determinant === 0
  ) {
    return false;
  }
  const documentGuard = f(2 / f(z * dpr));
  const g0 = f(f(documentGuard * f(Math.abs(l3) + Math.abs(l2))) / Math.abs(determinant));
  const g1 = f(f(documentGuard * f(Math.abs(l1) + Math.abs(l0))) / Math.abs(determinant));
  const stored = storedLocalBounds(localBounds, node);
  const lowerX = f(stored.minX - g0),
    lowerY = f(stored.minY - g1);
  const upperX = f(stored.maxX + g0),
    upperY = f(stored.maxY + g1);
  if (!Number.isFinite(g0 + g1 + lowerX + lowerY + upperX + upperY)) return false;
  if (upperX <= lowerX || upperY <= lowerY) return false;
  let quantization = 0,
    arithmetic = 0,
    reach = 1;
  for (let corner = 0; corner < 4; corner += 1) {
    const px = corner & 1 ? upperX : lowerX;
    const py = corner & 2 ? upperY : lowerY;
    const r0 = (world[0] * px + world[2] * py + (world[4] - camera.x)) * zoom * devicePixelRatio;
    const r1 = (world[1] * px + world[3] * py + (world[5] - camera.y)) * zoom * devicePixelRatio;
    const s0 = (l0 * px + l2 * py + t0 + o0) * z * dpr;
    const s1 = (l1 * px + l3 * py + t1 + o1) * z * dpr;
    const p0 = f(f(f(f(f(f(l0 * px) + f(l2 * py)) + t0) + o0) * z) * dpr);
    const p1 = f(f(f(f(f(f(l1 * px) + f(l3 * py)) + t1) + o1) * z) * dpr);
    const n0 = f(f(f(p0 * 2) / f(physicalWidth)) - 1);
    const n1 = f(1 - f(f(p1 * 2) / f(physicalHeight)));
    const v0 = ((n0 + 1) * physicalWidth) / 2;
    const v1 = ((1 - n1) * physicalHeight) / 2;
    if (!Number.isFinite(r0 + r1 + s0 + s1 + p0 + p1 + n0 + n1 + v0 + v1)) return false;
    quantization = Math.max(quantization, Math.abs(s0 - r0), Math.abs(s1 - r1));
    arithmetic = Math.max(arithmetic, Math.abs(v0 - s0), Math.abs(v1 - s1));
    reach = Math.max(reach, Math.abs(r0), Math.abs(r1));
  }
  const geometryError =
    Math.max(Math.abs(world[0]) + Math.abs(world[2]), Math.abs(world[1]) + Math.abs(world[3])) *
    geometryStorageError(localBounds, node) *
    zoom *
    devicePixelRatio;
  const bookkeeping = 64 * Number.EPSILON * reach;
  const limit = budget * (1 - 1e-9);
  return quantization + geometryError + bookkeeping <= limit && arithmetic + bookkeeping <= limit;
}

function clipErrorPolygon(
  polygon: readonly ErrorVertex[],
  axis: 0 | 1,
  limit: number,
  direction: number,
): ErrorVertex[] {
  const output: ErrorVertex[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!,
      b = polygon[(i + 1) % polygon.length]!;
    const da = direction * (a.reference[axis] - limit),
      db = direction * (b.reference[axis] - limit);
    if (da >= 0) output.push(a);
    if (da >= 0 === db >= 0) continue;
    const t = da / (da - db);
    const lerp = (left: Point, right: Point): Point => [
      left[0] + (right[0] - left[0]) * t,
      left[1] + (right[1] - left[1]) * t,
    ];
    output.push({
      point: lerp(a.point, b.point),
      reference: lerp(a.reference, b.reference),
      quantization: lerp(a.quantization, b.quantization),
      arithmetic: lerp(a.arithmetic, b.arithmetic),
    });
  }
  return output;
}

function storedLocalBounds(bounds: SceneBounds, node?: PrimitiveNode): SceneBounds {
  if (node === undefined)
    return {
      minX: f(bounds.minX),
      minY: f(bounds.minY),
      maxX: f(bounds.maxX),
      maxY: f(bounds.maxY),
    };
  const half = f(f(node.style.stroke?.width ?? 0) * 0.5);
  const geometry = node.geometry;
  if (geometry.kind === 'line')
    return {
      minX: f(Math.min(f(geometry.start.x), f(geometry.end.x)) - half),
      minY: f(Math.min(f(geometry.start.y), f(geometry.end.y)) - half),
      maxX: f(Math.max(f(geometry.start.x), f(geometry.end.x)) + half),
      maxY: f(Math.max(f(geometry.start.y), f(geometry.end.y)) + half),
    };
  return {
    minX: -half,
    minY: -half,
    maxX: f(f(geometry.width) + half),
    maxY: f(f(geometry.height) + half),
  };
}

function geometryStorageError(bounds: SceneBounds, node?: PrimitiveNode): number {
  if (node === undefined)
    return Math.max(...Object.values(bounds).map((value) => Math.abs(f(value) - value)));
  const geometry = node.geometry;
  const widthError =
    Math.abs(f(node.style.stroke?.width ?? 0) - (node.style.stroke?.width ?? 0)) / 2;
  if (geometry.kind === 'line')
    return (
      widthError +
      Math.max(
        ...[geometry.start.x, geometry.start.y, geometry.end.x, geometry.end.y].map((value) =>
          Math.abs(f(value) - value),
        ),
      )
    );
  const dimensionError = Math.max(
    Math.abs(f(geometry.width) - geometry.width),
    Math.abs(f(geometry.height) - geometry.height),
  );
  const radiusError =
    geometry.kind === 'rectangle'
      ? Math.max(
          ...normalizeRectangleRadii(geometry.width, geometry.height, geometry.cornerRadii).map(
            (value) => Math.abs(f(value) - value),
          ),
        )
      : 0;
  // A corner center and its radius can each shift by the radius quantization.
  return dimensionError + 2 * radiusError + widthError;
}

function addRatio(values: number[], numerator: number, denominator: number): void {
  if (denominator > 0) values.push(numerator / denominator);
}
function assertFinite(values: readonly number[]): void {
  if (values.some((value) => !Number.isFinite(value)))
    throw new PrimitiveNumericPreparationError('nonfinite packet v1 position arithmetic');
}
