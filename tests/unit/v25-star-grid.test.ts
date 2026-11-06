import { describe, expect, it } from 'vitest';
import { starExtension } from '../../packages/editor-core/src/star.js';

// V-25 (user report 2026-11-06): "Create star" drew nothing whatever its fill and stroke. The
// star's vertices carried cos/sin rounding noise (top vertex x = 60.00000000000001 in a 120 px
// frame) and the stroke kernel refused the outline as unsupported-geometry, hiding the fill too.
// The vertices are now snapped to a 2^-16 px grid; tests/geometry/v25-star-stroke.test.ts runs
// the real kernel on them.

const toScene = (starExtension.nodeTypes ?? [])[0]!.toScene;
const frame = (width: number, height: number) => ({ x: 0, y: 0, width, height });

describe('V-25 star vertices on a dyadic grid', () => {
  // The frames' half sizes are on the 2^-16 grid, so the top vertex lands exactly on the centre.
  it('snaps every vertex to 2^-16 px and makes the top vertex exactly centred', () => {
    for (const [points, innerRatio, width, height] of [
      [5, 0.5, 120, 120],
      [7, 0.3, 120, 120],
      [12, 0.6, 333, 222],
    ] as const) {
      const scene = toScene({ points, innerRatio }, frame(width, height));
      expect(scene.points).toHaveLength(4 * points);
      for (const value of scene.points) expect(value * 65_536).toBe(Math.round(value * 65_536));
      expect(scene.points[0]).toBe(width / 2);
      expect(scene.points[1]).toBe(0);
    }
  });

  it('moves no vertex by more than 2^-17 px', () => {
    const scene = toScene({ points: 5, innerRatio: 0.5 }, frame(120, 120));
    for (let i = 0; i < 10; i += 1) {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const scale = i % 2 === 0 ? 1 : 0.5;
      expect(
        Math.abs(scene.points[2 * i]! - (60 + Math.cos(angle) * 60 * scale)),
      ).toBeLessThanOrEqual(2 ** -17);
      expect(
        Math.abs(scene.points[2 * i + 1]! - (60 + Math.sin(angle) * 60 * scale)),
      ).toBeLessThanOrEqual(2 ** -17);
    }
  });
});
