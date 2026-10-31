import type { RenderNodeSnapshot, SceneAffine } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import {
  assessPrimitivePacking,
  primitivePackingWithinBudget,
} from '../../packages/renderer-core/src/primitive-packing.js';

// E26 contract, U5d-1: `primitivePackingWithinBudget` is a sufficient condition for the packing
// assessment. Over seeded primitives (rectangles, ellipses and lines, with and without strokes,
// rotated, skewed and scaled), cameras near and far from the origin, zooms from 1/64 to 4096 and
// DPR 1 to 3: whenever the bound says yes under a budget, the assessment stays within that budget
// on both measures, including budgets just below the assessment's own values; whenever the
// assessment throws, the bound declines. The bound also decides the ordinary cases.

type PrimitiveNode = Extract<RenderNodeSnapshot, { kind: 'primitive' }>;

/** mulberry32. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function primitive(rng: () => number, world: SceneAffine): PrimitiveNode {
  const width = 10 ** (rng() * 6 - 2);
  const height = 10 ** (rng() * 6 - 2);
  const stroke = rng() < 0.5 ? null : { color: { r: 0, g: 0, b: 0, a: 1 }, width: rng() * 20 };
  const kind = rng();
  const geometry: PrimitiveNode['geometry'] =
    kind < 0.4
      ? {
          kind: 'rectangle',
          width,
          height,
          cornerRadii: [rng() * width, rng() * width, rng() * height, rng() * height],
        }
      : kind < 0.7
        ? { kind: 'ellipse', width, height }
        : {
            kind: 'line',
            start: { x: (rng() - 0.5) * width, y: (rng() - 0.5) * height },
            end: { x: (rng() - 0.5) * width, y: (rng() - 0.5) * height },
          };
  return {
    id: 'p',
    parentId: null,
    transform: world,
    visible: true,
    opacity: 1,
    kind: 'primitive',
    geometry,
    style: { fill: { r: 1, g: 1, b: 1, a: 1 }, stroke },
  };
}

function localBounds(node: PrimitiveNode) {
  const half = (node.style.stroke?.width ?? 0) / 2;
  const geometry = node.geometry;
  if (geometry.kind === 'line') {
    return {
      minX: Math.min(geometry.start.x, geometry.end.x) - half,
      minY: Math.min(geometry.start.y, geometry.end.y) - half,
      maxX: Math.max(geometry.start.x, geometry.end.x) + half,
      maxY: Math.max(geometry.start.y, geometry.end.y) + half,
    };
  }
  return { minX: -half, minY: -half, maxX: geometry.width + half, maxY: geometry.height + half };
}

describe('E26-U5d packing bound', () => {
  it('says yes only when the assessment stays within the budget', () => {
    const rng = random(0xe26d1);
    let decided = 0;
    let declinedThrows = 0;
    let tight = 0;
    for (let index = 0; index < 20_000; index += 1) {
      const angle = rng() * 2 * Math.PI;
      const scale = 10 ** (rng() * 4 - 2);
      const skew = rng() < 0.3 ? (rng() - 0.5) * 4 : 0;
      const reach = 10 ** (rng() * 9 - 2);
      const world: [number, number, number, number, number, number] = [
        scale * Math.cos(angle),
        scale * Math.sin(angle),
        scale * (skew - Math.sin(angle)),
        scale * Math.cos(angle),
        (rng() - 0.5) * reach,
        (rng() - 0.5) * reach,
      ];
      // A few singular transforms and translations past float32's range, which throw.
      const extreme = rng();
      if (extreme < 0.01) world[0] = world[1] = world[2] = world[3] = 0;
      else if (extreme < 0.02) world[4] = 1e39;
      const node = primitive(rng, world);
      const bounds = localBounds(node);
      const zoom = 2 ** (rng() * 18 - 6);
      const dpr = [1, 1.25, 1.5, 2, 3][Math.floor(rng() * 5)]!;
      const width = Math.round(320 + rng() * 3520);
      const height = Math.round(240 + rng() * 2000);
      // Cameras near the primitive, so it is in view on most draws, or anywhere in its reach.
      const camera =
        rng() < 0.7
          ? {
              x: world[4] - (rng() * width) / (zoom * dpr),
              y: world[5] - (rng() * height) / (zoom * dpr),
            }
          : { x: (rng() - 0.5) * reach, y: (rng() - 0.5) * reach };
      const near = rng() < 0.8;
      const origin = near
        ? { x: 256 * Math.floor(camera.x / 256), y: 256 * Math.floor(camera.y / 256) }
        : { x: camera.x + (rng() - 0.5) * 2048, y: camera.y + (rng() - 0.5) * 2048 };
      const args = [world, bounds, origin, camera, zoom, dpr, width * dpr, height * dpr] as const;
      let assessment: ReturnType<typeof assessPrimitivePacking>;
      try {
        assessment = assessPrimitivePacking(...args, node);
      } catch {
        expect(primitivePackingWithinBudget(...args, 0.125, node)).toBe(false);
        declinedThrows += 1;
        continue;
      }
      const worst = Math.max(
        assessment.quantizationPhysicalPixels,
        assessment.arithmeticPhysicalPixels,
      );
      for (const budget of [0.125, worst, worst * (1 - 1e-12), worst * 2, worst / 2]) {
        if (primitivePackingWithinBudget(...args, budget, node)) {
          expect(assessment.quantizationPhysicalPixels).toBeLessThanOrEqual(budget);
          expect(assessment.arithmeticPhysicalPixels).toBeLessThanOrEqual(budget);
          if (budget === 0.125) decided += 1;
          if (budget <= worst * 1.0001) tight += 1;
        }
      }
    }
    // The cases cover throws, and the bound decides most assessments within the real budget.
    expect(declinedThrows).toBeGreaterThan(200);
    expect(decided).toBeGreaterThan(10_000);
    expect(tight).toBe(0);
  });

  it('decides an ordinary primitive in view', () => {
    const node = primitive(random(7), [1, 0, 0, 1, 1200, 800]);
    const args = [
      node.transform,
      localBounds(node),
      { x: 1024, y: 768 },
      { x: 1100, y: 700 },
      1.5,
      2,
      2560,
      1440,
    ] as const;
    expect(primitivePackingWithinBudget(...args, 0.125, node)).toBe(true);
  });
});
