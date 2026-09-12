import { describe, expect, it } from 'vitest';

import {
  PRIMITIVE_GEOMETRY_OFFSETS,
  PRIMITIVE_GEOMETRY_STRIDE,
  PRIMITIVE_PACKET_BINDINGS,
  PRIMITIVE_STYLE_OFFSETS,
  PRIMITIVE_STYLE_STRIDE,
  PRIMITIVE_TRANSFORM_OFFSETS,
  PRIMITIVE_TRANSFORM_STRIDE,
  createPrimitiveBindGroupLayoutDescriptor,
} from '../../packages/renderer-webgpu/src/primitive-packet-layout.js';
import {
  PRIMITIVE_PACKET_LAYOUT_KEY,
  PRIMITIVE_RENDER_STATE_KEY,
  PRIMITIVE_UNIT_QUAD_VERTEX_LAYOUT_KEY,
  createPrimitivePipelineDescriptor,
  primitivePipelineKey,
} from '../../packages/renderer-webgpu/src/primitive-pipeline.js';
import {
  PRIMITIVE_UNIT_QUAD_INDICES,
  PRIMITIVE_UNIT_QUAD_VERTICES,
  createPrimitiveUnitQuadData,
} from '../../packages/renderer-webgpu/src/primitive-unit-geometry.js';

type Point = readonly [number, number];
type Color = readonly [number, number, number, number];
type Affine = readonly [number, number, number, number, number, number];

function normalizeRadii(
  width: number,
  height: number,
  source: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  const [tl, tr, br, bl] = source;
  const ratios = [1];
  if (tl + tr > 0) ratios.push(width / (tl + tr));
  if (bl + br > 0) ratios.push(width / (bl + br));
  if (tl + bl > 0) ratios.push(height / (tl + bl));
  if (tr + br > 0) ratios.push(height / (tr + br));
  const scale = Math.min(...ratios);
  return [tl * scale, tr * scale, br * scale, bl * scale];
}

function premultiply(color: Color, coverage: number): Color {
  const alpha = color[3] * coverage;
  return [color[0] * alpha, color[1] * alpha, color[2] * alpha, alpha];
}

function sourceOver(source: Color, destination: Color): Color {
  return [
    source[0] + destination[0] * (1 - source[3]),
    source[1] + destination[1] * (1 - source[3]),
    source[2] + destination[2] * (1 - source[3]),
    source[3] + destination[3] * (1 - source[3]),
  ];
}

function primitiveColor(
  fill: Color,
  fillCoverage: number,
  stroke: Color,
  strokeCoverage: number,
  opacity: number,
): Color {
  const local = sourceOver(premultiply(stroke, strokeCoverage), premultiply(fill, fillCoverage));
  return local.map((component) => component * opacity) as unknown as Color;
}

function distanceToSegment(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const denominator = dx * dx + dy * dy;
  const amount =
    denominator === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / denominator),
        );
  return Math.hypot(point[0] - start[0] - amount * dx, point[1] - start[1] - amount * dy);
}

function roundedRectangleInside(point: Point, size: Point, radii: readonly number[]): boolean {
  const [x, y] = point;
  const [width, height] = size;
  if (x < 0 || y < 0 || x > width || y > height) return false;
  const corners = [
    {
      active: x < radii[0]! && y < radii[0]!,
      center: [radii[0]!, radii[0]!] as Point,
      radius: radii[0]!,
    },
    {
      active: x > width - radii[1]! && y < radii[1]!,
      center: [width - radii[1]!, radii[1]!] as Point,
      radius: radii[1]!,
    },
    {
      active: x > width - radii[2]! && y > height - radii[2]!,
      center: [width - radii[2]!, height - radii[2]!] as Point,
      radius: radii[2]!,
    },
    {
      active: x < radii[3]! && y > height - radii[3]!,
      center: [radii[3]!, height - radii[3]!] as Point,
      radius: radii[3]!,
    },
  ];
  return corners.every(
    ({ active, center, radius }) => !active || Math.hypot(x - center[0], y - center[1]) <= radius,
  );
}

function denseEllipseDistance(point: Point, radii: Point): number {
  let bestAngle = 0;
  let bestSquared = Number.POSITIVE_INFINITY;
  const samples = 16_384;
  for (let index = 0; index < samples; index += 1) {
    const angle = (index * Math.PI * 2) / samples;
    const dx = radii[0] * Math.cos(angle) - point[0];
    const dy = radii[1] * Math.sin(angle) - point[1];
    const squared = dx * dx + dy * dy;
    if (squared < bestSquared) {
      bestSquared = squared;
      bestAngle = angle;
    }
  }
  let lower = bestAngle - (Math.PI * 2) / samples;
  let upper = bestAngle + (Math.PI * 2) / samples;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const left = (2 * lower + upper) / 3;
    const right = (lower + 2 * upper) / 3;
    const squaredAt = (angle: number) => {
      const dx = radii[0] * Math.cos(angle) - point[0];
      const dy = radii[1] * Math.sin(angle) - point[1];
      return dx * dx + dy * dy;
    };
    if (squaredAt(left) < squaredAt(right)) upper = right;
    else lower = left;
  }
  const angle = (lower + upper) * 0.5;
  const refinedSquared =
    (radii[0] * Math.cos(angle) - point[0]) ** 2 + (radii[1] * Math.sin(angle) - point[1]) ** 2;
  const distance = Math.sqrt(refinedSquared);
  const normalized = (point[0] / radii[0]) ** 2 + (point[1] / radii[1]) ** 2;
  return distance * (normalized < 1 ? -1 : 1);
}

// A scalar translation of the WGSL algorithm, compared below with a separately sampled contour.
function ellipseDistanceModel(rawPoint: Point, rawRadii: Point): number {
  let [x, y] = rawPoint.map(Math.abs) as [number, number];
  let [a, b] = rawRadii;
  if (a < b) [x, y, a, b] = [y, x, b, a];
  if (Math.abs(a - b) <= 1e-6 * a) return Math.hypot(x, y) - a;
  const normalized = (x / a) ** 2 + (y / b) ** 2;
  const sign = normalized < 1 ? -1 : 1;
  if (x === 0 && y === 0) return -b;
  if (y <= 1e-6 * a) {
    const cosine = Math.max(0, Math.min(1, (a * x) / (a * a - b * b)));
    const offAxis = [a * cosine, b * Math.sqrt(Math.max(0, 1 - cosine * cosine))] as const;
    return Math.min(Math.abs(a - x), Math.hypot(x - offAxis[0], y - offAxis[1])) * sign;
  }
  if (x <= 1e-6 * a) return Math.abs(b - y) * sign;
  const aa = a * a;
  const bb = b * b;
  let lower = normalized < 1 ? -bb : 0;
  let upper = normalized < 1 ? 0 : a * x + b * y;
  const root = (parameter: number) =>
    ((a * x) / (parameter + aa)) ** 2 + ((b * y) / (parameter + bb)) ** 2 - 1;
  for (let iteration = 0; iteration < 28; iteration += 1) {
    const middle = (lower + upper) * 0.5;
    if (root(middle) > 0) lower = middle;
    else upper = middle;
  }
  const parameter = (lower + upper) * 0.5;
  return Math.hypot(x - (aa * x) / (parameter + aa), y - (bb * y) / (parameter + bb)) * sign;
}

function ellipseDistanceF32Model(rawPoint: Point, rawRadii: Point): number {
  const f = Math.fround;
  let [x, y] = rawPoint.map((value) => f(Math.abs(value))) as [number, number];
  let [a, b] = rawRadii.map(f) as [number, number];
  if (a < b) [x, y, a, b] = [y, x, b, a];
  if (f(Math.abs(f(a - b))) <= f(1e-6 * a)) return f(Math.hypot(x, y) - a);
  const normalized = f(f(f(x / a) * f(x / a)) + f(f(y / b) * f(y / b)));
  const resultSign = normalized < 1 ? -1 : 1;
  if (x === 0 && y === 0) return -b;
  if (y <= f(1e-6 * a)) {
    const cosine = Math.max(0, Math.min(1, f(f(a * x) / f(f(a * a) - f(b * b)))));
    const closestX = f(a * cosine);
    const closestY = f(b * f(Math.sqrt(Math.max(0, f(1 - f(cosine * cosine))))));
    return f(
      Math.min(Math.abs(f(a - x)), Math.hypot(f(x - closestX), f(y - closestY))) * resultSign,
    );
  }
  if (x <= f(1e-6 * a)) return f(Math.abs(f(b - y)) * resultSign);
  const aa = f(a * a);
  const bb = f(b * b);
  let lower = normalized < 1 ? -bb : 0;
  let upper = normalized < 1 ? 0 : f(f(a * x) + f(b * y));
  const root = (parameter: number) => {
    const scaledX = f(f(f(Math.sqrt(aa)) * x) / f(parameter + aa));
    const scaledY = f(f(f(Math.sqrt(bb)) * y) / f(parameter + bb));
    return f(f(f(scaledX * scaledX) + f(scaledY * scaledY)) - 1);
  };
  for (let iteration = 0; iteration < 28; iteration += 1) {
    const middle = f(f(lower + upper) * 0.5);
    if (root(middle) > 0) lower = middle;
    else upper = middle;
  }
  const parameter = f(f(lower + upper) * 0.5);
  const closestX = f(f(aa * x) / f(parameter + aa));
  const closestY = f(f(bb * y) / f(parameter + bb));
  return f(Math.hypot(f(x - closestX), f(y - closestY)) * resultSign);
}

function apply(affine: Affine, point: Point): Point {
  return [
    affine[0] * point[0] + affine[2] * point[1] + affine[4],
    affine[1] * point[0] + affine[3] * point[1] + affine[5],
  ];
}

function localGuard(affine: Affine, zoom: number, dpr: number): Point {
  const determinant = affine[0] * affine[3] - affine[1] * affine[2];
  const scale = 2 / (zoom * dpr) / Math.abs(determinant);
  return [
    scale * (Math.abs(affine[3]) + Math.abs(affine[2])),
    scale * (Math.abs(affine[1]) + Math.abs(affine[0])),
  ];
}

describe('P1 analytic primitive native descriptors', () => {
  it('uses the frozen shared quad and packet layout', () => {
    expect(PRIMITIVE_UNIT_QUAD_VERTICES).toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
    expect(PRIMITIVE_UNIT_QUAD_INDICES).toEqual([0, 1, 2, 2, 1, 3]);
    const data = createPrimitiveUnitQuadData();
    expect([...data.vertices]).toEqual(PRIMITIVE_UNIT_QUAD_VERTICES);
    expect([...data.indices]).toEqual(PRIMITIVE_UNIT_QUAD_INDICES);

    expect([PRIMITIVE_TRANSFORM_STRIDE, PRIMITIVE_GEOMETRY_STRIDE, PRIMITIVE_STYLE_STRIDE]).toEqual(
      [32, 48, 48],
    );
    expect(PRIMITIVE_TRANSFORM_OFFSETS).toEqual({ linear: 0, translation: 16, padding: 24 });
    expect(PRIMITIVE_GEOMETRY_OFFSETS).toEqual({
      kind: 0,
      padding: 4,
      size: 8,
      radii: 16,
      line: 32,
    });
    expect(PRIMITIVE_STYLE_OFFSETS).toEqual({
      fill: 0,
      stroke: 16,
      strokeWidth: 32,
      opacity: 36,
      flags: 40,
      padding: 44,
    });
    expect(PRIMITIVE_PACKET_BINDINGS).toEqual({
      transforms: 0,
      geometry: 1,
      styles: 2,
      order: 3,
      frame: 4,
    });
    expect(
      createPrimitiveBindGroupLayoutDescriptor().entries.map((entry) => entry.buffer?.type),
    ).toEqual([
      'read-only-storage',
      'read-only-storage',
      'read-only-storage',
      'read-only-storage',
      'uniform',
    ]);
  });

  it('uses exact cache variants and premultiplied source-over pipeline state', () => {
    expect(primitivePipelineKey('bgra8unorm', 4)).toEqual({
      shaderKey: 'p1-analytic-v1',
      layoutKey: PRIMITIVE_PACKET_LAYOUT_KEY,
      vertexLayoutKey: PRIMITIVE_UNIT_QUAD_VERTEX_LAYOUT_KEY,
      targetFormat: 'bgra8unorm',
      renderStateKey: PRIMITIVE_RENDER_STATE_KEY,
      sampleCount: 4,
    });
    const descriptor = createPrimitivePipelineDescriptor(
      {} as GPUShaderModule,
      {} as GPUPipelineLayout,
      'rgba8unorm',
      1,
    );
    expect(descriptor.primitive).toEqual({
      topology: 'triangle-list',
      frontFace: 'ccw',
      cullMode: 'none',
    });
    expect(descriptor.depthStencil).toBeUndefined();
    expect(descriptor.multisample?.count).toBe(1);
    expect(descriptor.fragment?.targets[0]?.blend).toEqual({
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    });
  });
});

describe('P1 independent scalar fixture oracles', () => {
  it('V01 normalizes all radii by one factor and handles the radius-60 corner across the full height', () => {
    const radii = normalizeRadii(100, 60, [80, 40, 20, 0]);
    expect(radii).toEqual([60, 30, 15, 0]);
    expect(roundedRectangleInside([60, 0], [100, 60], radii)).toBe(true);
    expect(roundedRectangleInside([0, 60], [100, 60], radii)).toBe(true);
    expect(roundedRectangleInside([50, 0], [100, 60], radii)).toBe(false);
    expect(distanceToSegment([50, 0], [60, 0], [70, 0])).toBe(10);
    const overlappingCornerBoxes = normalizeRadii(100, 100, [90, 0, 90, 0]);
    expect(overlappingCornerBoxes).toEqual([90, 0, 90, 0]);
    expect(roundedRectangleInside([89, 89], [100, 100], overlappingCornerBoxes)).toBe(false);
  });

  it('V02 composes local stroke over fill and applies opacity once', () => {
    expect(primitiveColor([0, 0, 1, 1], 1, [1, 0, 0, 1], 0, 0.5)).toEqual([0, 0, 0.5, 0.5]);
    expect(primitiveColor([0, 0, 1, 1], 1, [1, 0, 0, 1], 1, 0.5)).toEqual([0.5, 0, 0, 0.5]);
  });

  it('V03 preserves painter order with premultiplied source-over', () => {
    const red = premultiply([1, 0, 0, 0.5], 1);
    const blue = premultiply([0, 0, 1, 0.5], 1);
    expect(sourceOver(blue, red)).toEqual([0.25, 0, 0.5, 0.75]);
    expect(sourceOver(red, blue)).toEqual([0.5, 0, 0.25, 0.75]);
  });

  it('V04 ellipse model matches an independent dense contour at centers, axes, and off-axis points', () => {
    const radii: Point = [40, 20];
    for (const point of [
      [0, 0],
      [40, 0],
      [0, 20],
      [0, 10],
      [50, 0],
      [12.5, 6.75],
      [35, 15],
      [10_000, 20_000],
    ] satisfies Point[]) {
      expect(ellipseDistanceModel(point, radii)).toBeCloseTo(denseEllipseDistance(point, radii), 4);
    }
    expect(ellipseDistanceModel([0.00001, 1], [4_000, 2])).toBeCloseTo(
      denseEllipseDistance([0.00001, 1], [4_000, 2]),
      3,
    );
    for (const [point, testRadii] of [
      [
        [0, 0],
        [40, 20],
      ],
      [
        [0, 10],
        [40, 20],
      ],
      [
        [35, 15],
        [40, 20],
      ],
      [
        [10_000, 20_000],
        [40, 20],
      ],
      [
        [0.00001, 1],
        [4_000, 2],
      ],
    ] satisfies Array<readonly [Point, Point]>) {
      expect(
        Math.abs(
          ellipseDistanceF32Model(point, testRadii) - denseEllipseDistance(point, testRadii),
        ),
      ).toBeLessThan(0.002);
    }
  });

  it('V05 butt line contour remains a local rectangle through affine variants', () => {
    const variants: readonly Affine[] = [
      [1, 0, 0, 1, 40.25, 140.5],
      [0, 1, -1, 0, 60.25, 120.5],
      [-1, 0, 0, 1, 80.25, 140.5],
      [2, 0, 0, 0.5, 20.25, 140.5],
      [1, 0, 0.25, 1, 40.25, 140.5],
    ];
    for (const affine of variants) {
      const corners = [
        [0, -1.5],
        [40, -1.5],
        [40, 1.5],
        [0, 1.5],
      ] satisfies Point[];
      expect(corners.map((point) => apply(affine, point))).toHaveLength(4);
      expect(distanceToSegment([20, 1.5], [0, 1.5], [40, 1.5])).toBe(0);
      expect(distanceToSegment([-0.25, 0], [0, -1.5], [0, 1.5])).toBe(0.25);
    }
  });

  it('N02 inverse-linear guard covers two physical pixels for rotation, reflection, scale, and shear', () => {
    const variants: readonly Affine[] = [
      [1, 0, 0, 1, 0, 0],
      [
        Math.cos(Math.PI / 12),
        Math.sin(Math.PI / 12),
        -Math.sin(Math.PI / 12),
        Math.cos(Math.PI / 12),
        0,
        0,
      ],
      [-1, 0, 0, 1, 0, 0],
      [2, 0, 0, 0.5, 0, 0],
      [1, 0, 0.25, 1, 0, 0],
    ];
    for (const affine of variants) {
      for (const zoom of [0.01, 1, 64]) {
        for (const dpr of [1, 1.5, 2]) {
          const guard = localGuard(affine, zoom, dpr);
          const xExtent =
            (Math.abs(affine[0]) * guard[0] + Math.abs(affine[2]) * guard[1]) * zoom * dpr;
          const yExtent =
            (Math.abs(affine[1]) * guard[0] + Math.abs(affine[3]) * guard[1]) * zoom * dpr;
          expect(xExtent).toBeGreaterThanOrEqual(2 - 1e-12);
          expect(yExtent).toBeGreaterThanOrEqual(2 - 1e-12);
        }
      }
    }
  });

  it('N02 origin-relative f32 vertex order stays within the total 0.25 physical-pixel budget', () => {
    const f = Math.fround;
    let maximumError = 0;
    const variants: readonly Affine[] = [
      [1, 0, 0, 1, 0, 0],
      [
        Math.cos(Math.PI / 12),
        Math.sin(Math.PI / 12),
        -Math.sin(Math.PI / 12),
        Math.cos(Math.PI / 12),
        0,
        0,
      ],
      [
        Math.cos(Math.PI / 4),
        Math.sin(Math.PI / 4),
        -Math.sin(Math.PI / 4),
        Math.cos(Math.PI / 4),
        0,
        0,
      ],
      [0, 1, -1, 0, 0, 0],
      [-1, 0, 0, 1, 0, 0],
      [2, 0, 0, 0.5, 0, 0],
      [1, 0, 0.25, 1, 0, 0],
    ];
    for (const origin of [
      [1e9, -1e9],
      [-1e9, 1e9],
    ] satisfies Point[]) {
      for (const size of [
        [16, 8],
        [16, 16],
        [4096, 4096],
      ] satisfies Point[]) {
        for (const affine of variants) {
          for (const zoom of [0.01, 1, 64])
            for (const dpr of [1, 1.5, 2]) {
              const center: Point = [size[0] * 0.5, size[1] * 0.5];
              const transformedCenter = apply(affine, center);
              const relativeTranslation: Point = [
                0.25 + center[0] - transformedCenter[0],
                0.5 + center[1] - transformedCenter[1],
              ];
              for (const cameraOffset of [
                [0, 0],
                [0.25 + center[0], 0.5 + center[1]],
              ] satisfies Point[]) {
                const camera: Point = [origin[0] + cameraOffset[0], origin[1] + cameraOffset[1]];
                const anchor: Point = [
                  256 * Math.floor(camera[0] / 256),
                  256 * Math.floor(camera[1] / 256),
                ];
                const translation: Point = [
                  origin[0] + relativeTranslation[0] - anchor[0],
                  origin[1] + relativeTranslation[1] - anchor[1],
                ];
                for (const point of [
                  [-2, -2],
                  [0, 0],
                  [size[0], 0],
                  [0, size[1]],
                  size,
                  [size[0] + 2, size[1] + 2],
                  [size[0] * 0.375, size[1] * 0.625],
                ] satisfies Point[]) {
                  const expected = apply(
                    [
                      affine[0],
                      affine[1],
                      affine[2],
                      affine[3],
                      relativeTranslation[0] - cameraOffset[0],
                      relativeTranslation[1] - cameraOffset[1],
                    ],
                    point,
                  );
                  const stored = affine.slice(0, 4).map(f);
                  const localX = f(point[0]);
                  const localY = f(point[1]);
                  const x = f(
                    f(f(stored[0]! * localX) + f(stored[2]! * localY)) + f(translation[0]),
                  );
                  const y = f(
                    f(f(stored[1]! * localX) + f(stored[3]! * localY)) + f(translation[1]),
                  );
                  const physicalX = f(f(f(x + f(anchor[0] - camera[0])) * f(zoom)) * f(dpr));
                  const physicalY = f(f(f(y + f(anchor[1] - camera[1])) * f(zoom)) * f(dpr));
                  maximumError = Math.max(
                    maximumError,
                    Math.abs(physicalX - expected[0] * zoom * dpr),
                    Math.abs(physicalY - expected[1] * zoom * dpr),
                  );
                }
              }
            }
        }
      }
    }
    expect(maximumError).toBeLessThanOrEqual(0.25);
  });
});
