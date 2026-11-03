import { describe, expect, it } from 'vitest';
import {
  assessPrimitivePacking,
  primitivePackingBoundOver,
  primitivePackingWithinBudget,
} from '../../packages/renderer-core/src/primitive-packing.js';
import { localBounds, primitive, random } from '../support/packing-primitives.js';

// E30 contract, U3b: `primitivePackingBoundOver` bounds the packing assessment over a camera
// range. Over seeded primitives (rectangles, ellipses and lines, with and without strokes,
// rotated, skewed and scaled), ranges around cameras near and far from the origin, zooms from
// 1/64 to 4096 and DPR 1 to 3: at the range's eight corner cameras and at sampled cameras inside
// it, both measures of the assessment stay within the bound; where the assessment throws at a
// sampled camera, the bound declines. The bound decides within the real budget most ranges whose
// sampled cameras the per-camera sufficient check (`primitivePackingWithinBudget`) decides: those
// are the ones the scene source can skip today, and a range the bound declines falls back to it.

const BUDGET = 0.125;

describe('E30-U3b packing range bound', () => {
  it('bounds the assessment at every sampled camera of the range', () => {
    const rng = random(0xe30b3);
    let bounded = 0;
    let declined = 0;
    let decided = 0;
    let quick = 0;
    let worstRatio = 0;
    for (let index = 0; index < 4_000; index += 1) {
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
      const extreme = rng();
      if (extreme < 0.01) world[0] = world[1] = world[2] = world[3] = 0;
      else if (extreme < 0.02) world[4] = 1e39;
      const node = primitive(rng, world);
      const bounds = localBounds(node);
      const zoom = 2 ** (rng() * 18 - 6);
      const dpr = [1, 1.25, 1.5, 2, 3][Math.floor(rng() * 5)]!;
      const width = Math.round(320 + rng() * 3520);
      const height = Math.round(240 + rng() * 2000);
      const camera =
        rng() < 0.7
          ? {
              x: world[4] - (rng() * width) / (zoom * dpr),
              y: world[5] - (rng() * height) / (zoom * dpr),
            }
          : { x: (rng() - 0.5) * reach, y: (rng() - 0.5) * reach };
      const origin =
        rng() < 0.8
          ? { x: 256 * Math.floor(camera.x / 256), y: 256 * Math.floor(camera.y / 256) }
          : { x: camera.x + (rng() - 0.5) * 2048, y: camera.y + (rng() - 0.5) * 2048 };
      // The range the scene source asks for: a zoom ratio and a quarter of the viewport.
      const ratio = [1 / 16, 1 / 256, 1 / 4096, 0][Math.floor(rng() * 4)]!;
      const spanX = (width / zoom) * (rng() < 0.5 ? 0.25 : 0);
      const spanY = (height / zoom) * (rng() < 0.5 ? 0.25 : 0);
      const range = {
        zoomMin: zoom / (1 + ratio),
        zoomMax: zoom * (1 + ratio),
        minX: camera.x - spanX,
        maxX: camera.x + spanX,
        minY: camera.y - spanY,
        maxY: camera.y + spanY,
      };
      const physical = [width * dpr, height * dpr] as const;
      const bound = primitivePackingBoundOver(world, bounds, origin, range, dpr, ...physical, node);
      const cameras: { x: number; y: number; zoom: number }[] = [];
      for (let corner = 0; corner < 8; corner += 1) {
        cameras.push({
          x: corner & 1 ? range.maxX : range.minX,
          y: corner & 2 ? range.maxY : range.minY,
          zoom: corner & 4 ? range.zoomMax : range.zoomMin,
        });
      }
      for (let sample = 0; sample < 8; sample += 1) {
        cameras.push({
          x: range.minX + rng() * (range.maxX - range.minX),
          y: range.minY + rng() * (range.maxY - range.minY),
          zoom: range.zoomMin * (range.zoomMax / range.zoomMin) ** rng(),
        });
      }
      let allQuick = true;
      for (const sampled of cameras) {
        let assessment: ReturnType<typeof assessPrimitivePacking>;
        try {
          assessment = assessPrimitivePacking(
            world,
            bounds,
            origin,
            sampled,
            sampled.zoom,
            dpr,
            ...physical,
            node,
          );
        } catch {
          expect(bound).toBeNull();
          allQuick = false;
          continue;
        }
        const args = [world, bounds, origin, sampled, sampled.zoom, dpr, ...physical] as const;
        if (!primitivePackingWithinBudget(...args, BUDGET, node)) allQuick = false;
        if (bound === null) continue;
        expect(assessment.quantizationPhysicalPixels).toBeLessThanOrEqual(bound.quantization);
        expect(assessment.arithmeticPhysicalPixels).toBeLessThanOrEqual(bound.arithmetic);
        worstRatio = Math.max(
          worstRatio,
          assessment.quantizationPhysicalPixels / bound.quantization,
          assessment.arithmeticPhysicalPixels / bound.arithmetic,
        );
      }
      if (bound === null) declined += 1;
      else bounded += 1;
      if (allQuick) {
        quick += 1;
        if (bound !== null && Math.max(bound.quantization, bound.arithmetic) <= BUDGET) {
          decided += 1;
        }
      }
    }
    // The cases cover declines, and the bound decides most ranges the per-camera check decides.
    expect(declined).toBeGreaterThan(40);
    expect(bounded).toBeGreaterThan(3_000);
    expect(worstRatio).toBeLessThanOrEqual(1);
    expect(quick).toBeGreaterThan(1_500);
    // Measured 2802 of 3280; the analytic bound is worst-case, the per-camera check is not.
    expect(decided / quick).toBeGreaterThan(0.8);
  }, 30_000);

  it('decides an ordinary primitive in view over a pan range', () => {
    const node = primitive(random(7), [1, 0, 0, 1, 1200, 800]);
    const bound = primitivePackingBoundOver(
      node.transform,
      localBounds(node),
      { x: 1024, y: 768 },
      {
        zoomMin: 1.5 / (1 + 1 / 16),
        zoomMax: 1.5 * (1 + 1 / 16),
        minX: 900,
        maxX: 1300,
        minY: 500,
        maxY: 900,
      },
      2,
      2560,
      1440,
      node,
    );
    expect(bound).not.toBeNull();
    expect(Math.max(bound!.quantization, bound!.arithmetic)).toBeLessThanOrEqual(BUDGET);
  });

  it('declines where the vertex chain overflows float32 at a tiny zoom', () => {
    // Physical pixels stay small while the world-unit values pass float32's maximum.
    const node = primitive(random(3), [1e10, 0, 0, 1e10, 0, 0]);
    const bounds = { minX: 0, minY: 0, maxX: 1e30, maxY: 1e30 };
    const zoom = 1e-35;
    const camera = { x: 0, y: 0 };
    expect(() =>
      assessPrimitivePacking(node.transform, bounds, camera, camera, zoom, 1, 800, 600),
    ).toThrow();
    const span = 800 / zoom / 4;
    const bound = primitivePackingBoundOver(
      node.transform,
      bounds,
      camera,
      {
        zoomMin: zoom / (1 + 1 / 16),
        zoomMax: zoom * (1 + 1 / 16),
        minX: -span,
        maxX: span,
        minY: -span,
        maxY: span,
      },
      1,
      800,
      600,
    );
    expect(bound).toBeNull();
  });
});
