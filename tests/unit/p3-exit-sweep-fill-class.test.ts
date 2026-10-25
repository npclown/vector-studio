// D9 E14-Q1 (a): the A01 sweep's class test "fill `work-limit` on a self-crossing path over E",
// without the WASM build. The kernel's own test of E14-F5 (`e14_f5_f6_scene_paths_stay_work_limit`)
// pins the same edge count and a crossing on its S1 polygon.
import { describe, expect, it } from 'vitest';

import {
  classifyFillRejection,
  E14_EXACT_EDGE_CAP,
  orient2dSign,
  p2FillContours,
  properCrossing,
} from '../geometry/p3-exit-sweep/fill-class.js';
import { fillRequest, stressPath } from '../geometry/p3-exit-sweep/scene.js';

/** A closed polygon of line verbs. */
function polygon(points: readonly (readonly [number, number])[], toleranceExponent = -3) {
  return {
    verbs: Uint8Array.from([0, ...points.slice(1).map(() => 1), 3]),
    points: Float64Array.from(points.flat()),
    toleranceExponent,
  };
}

/** A circle of radius r from four cubics (kappa 0.5523), closed. */
function circle(r: number, toleranceExponent: number) {
  const k = 0.5523 * r;
  return {
    verbs: Uint8Array.from([0, 2, 2, 2, 2, 3]),
    points: Float64Array.from([
      ...[r, 0],
      ...[r, k, k, r, 0, r],
      ...[-k, r, -r, k, -r, 0],
      ...[-r, -k, -k, -r, 0, -r],
      ...[k, -r, r, -k, r, 0],
    ]),
    toleranceExponent,
  };
}

describe('E14-Q1 class test', () => {
  it('puts E14-F5 (scene path 3) in the class with the kernel edge count', () => {
    const r = classifyFillRejection(fillRequest(stressPath(3), 0), 'failed:work-limit');
    expect(r.flatEdges).toBe(3_463);
    expect(r.crossing).not.toBeNull();
    expect(r.e14SelfCrossingOverE).toBe(true);
  });

  it('leaves a simple circle over E outside the class', () => {
    const request = circle(4_096, -3);
    const r = classifyFillRejection(request, 'failed:work-limit');
    expect(r.flatEdges).toBeGreaterThan(E14_EXACT_EDGE_CAP);
    expect(r.crossing).toBeNull();
    expect(r.e14SelfCrossingOverE).toBe(false);
  });

  it('needs more than E edges: a crossing at E edges or fewer is outside', () => {
    const figure8 = (n: number) =>
      Array.from({ length: n }, (_, i) => {
        const t = (2 * Math.PI * (i + 0.5)) / n;
        return [Math.sin(t) * 100, Math.sin(2 * t) * 50] as const;
      });
    const small = classifyFillRejection(polygon(figure8(E14_EXACT_EDGE_CAP)), 'failed:work-limit');
    expect(small.flatEdges).toBe(E14_EXACT_EDGE_CAP);
    expect(small.e14SelfCrossingOverE).toBe(false);
    const large = classifyFillRejection(
      polygon(figure8(E14_EXACT_EDGE_CAP + 2)),
      'failed:work-limit',
    );
    expect(large.flatEdges).toBe(E14_EXACT_EDGE_CAP + 2);
    expect(large.e14SelfCrossingOverE).toBe(true);
  });

  it('classifies only work-limit outcomes', () => {
    const r = classifyFillRejection(fillRequest(stressPath(3), 0), 'failed:unsupported-geometry');
    expect(r.e14SelfCrossingOverE).toBe(false);
    expect(r.flatEdges).toBeNull();
  });

  it('does not count touching or collinear edges as a proper crossing', () => {
    // Two triangles sharing one vertex, and an edge ending on another edge.
    expect(
      properCrossing([
        [
          [0, 0],
          [2, 0],
          [1, 1],
        ],
        [
          [1, 1],
          [2, 2],
          [0, 2],
        ],
      ]),
    ).toBeNull();
    expect(
      properCrossing([
        [
          [0, 0],
          [4, 0],
          [2, 2],
        ],
        [
          [2, 0],
          [3, -1],
          [1, -1],
        ],
      ]),
    ).toBeNull();
    expect(
      properCrossing([
        [
          [0, 0],
          [4, 0],
          [4, 1],
        ],
        [
          [2, -1],
          [2, 1],
          [1, 1],
        ],
      ]),
    ).not.toBeNull();
  });

  it('decides orient2d exactly where binary64 rounding would not', () => {
    const a = [0.5, 0.5] as const;
    const b = [12, 12] as const;
    const c = [24, 24] as const;
    expect(orient2dSign(a, b, c)).toBe(0);
    const up = [24, 24 + 24 * Number.EPSILON] as const;
    expect(orient2dSign(a, b, up)).toBe(1);
    expect(orient2dSign(b, a, up)).toBe(-1);
    // Shewchuk's classic near-degenerate case: the naive determinant has the wrong sign or 0.
    const p = [0.5 + 2 ** -52, 0.5] as const;
    expect(orient2dSign(p, [12, 12], [24, 24])).toBe(-1);
  });

  it('merges repeated points and the closing duplicate', () => {
    const contours = p2FillContours(
      polygon([
        [0, 0],
        [1, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ]),
    );
    expect(contours).toEqual([
      [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
    ]);
  });
});
