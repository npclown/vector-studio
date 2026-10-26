import { describe, expect, it } from 'vitest';
import {
  FLIP_TOLERANT_RHO_MAX,
  flipTolerantBound,
  mapPoint,
  noFlip,
  type Mapped,
  type ShaderLanes,
} from './e3-a04/harness.js';

// D9 E3 unit E3-U6 (docs/plans/d9-e3-b4-precision-contract.md, section 20): the flip-tolerant
// bound on synthetic mapped meshes, its preconditions, and a sampled check that a perturbation
// of the vertices by β changes membership only within ρ of the boundary.

const lanes: ShaderLanes = {
  linear: [1, 0, 0, 1],
  anchor: [0, 0],
  frame: { originMinusCamera: [0, 0], zoom: 1, dpr: 1, width: 640, height: 360 },
};
const mapped = (pts: readonly (readonly [number, number])[], indices: number[]): Mapped => ({
  points: pts.map(([x, y]) => mapPoint(x, y, lanes)),
  indices,
  width: 640,
  height: 360,
});
const BETA = 1e-3;

// The square [10, 20]² as a fan around a vertex 1e-5 px above its bottom edge: the bottom
// triangle is a sliver that a β move flips.
const SLIVER_POINTS = [
  [10, 10],
  [20, 10],
  [20, 20],
  [10, 20],
  [15, 10.00001],
] as const;
const SLIVER_INDICES = [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4];

describe('flip-tolerant bound (section 20)', () => {
  it('bounds a mesh with an interior sliver that the no-flip certificate fails', () => {
    const m = mapped(SLIVER_POINTS, SLIVER_INDICES);
    expect(noFlip(m, BETA).failed).toBe(1);
    const r = flipTolerantBound(m, BETA);
    expect(r.reason).toBeNull();
    expect(r.edges).toBe(4);
    expect(r.rho).toBeGreaterThan(BETA);
    expect(r.rho).toBeLessThan(1.1 * BETA);
  });

  it('bounds a reflex corner with a larger offset', () => {
    // An L: [10, 30] × [10, 20] and [10, 20] × [20, 30], reflex at (20, 20).
    const r = flipTolerantBound(
      mapped(
        [
          [10, 10],
          [30, 10],
          [30, 20],
          [20, 20],
          [20, 30],
          [10, 30],
          [10, 20],
        ],
        [0, 1, 2, 0, 2, 3, 0, 3, 6, 6, 3, 4, 6, 4, 5],
      ),
      BETA,
    );
    expect(r.reason).toBeNull();
    expect(r.rho).toBeLessThan(10 * BETA);
  });

  it('refuses a dangling zero-area triangle, mixed orientation and a boundary that is not ∂M*', () => {
    const square = [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
    ] as const;
    expect(
      flipTolerantBound(mapped([...square, [30, 10]], [0, 1, 2, 0, 2, 3, 0, 1, 4]), BETA).reason,
    ).toBe('zero-area triangle off M*');
    expect(flipTolerantBound(mapped(square, [0, 1, 2, 0, 2, 1]), BETA).reason).toBe(
      'mixed orientation',
    );
    // A triangle outside the bottom edge touching it at (15, 10) only: still ∂M*, so covered.
    expect(
      flipTolerantBound(
        mapped([...square, [15, 10], [14, 5], [16, 5]], [0, 1, 2, 0, 2, 3, 4, 5, 6]),
        BETA,
      ).reason,
    ).toBeNull();
    // A triangle outside the bottom edge along part of it: that part is interior to M*.
    expect(
      flipTolerantBound(
        mapped([...square, [12, 10], [16, 10], [14, 5]], [0, 1, 2, 0, 2, 3, 4, 6, 5]),
        BETA,
      ).reason,
    ).toBe('edge with triangles on both sides');
    // A triangle across the bottom edge.
    expect(
      flipTolerantBound(
        mapped([...square, [15, 8], [16, 12], [14, 12]], [0, 1, 2, 0, 2, 3, 4, 5, 6]),
        BETA,
      ).reason,
    ).toBe('triangle across a boundary edge');
    // The bottom edge twice on one side and once on the other.
    expect(
      flipTolerantBound(mapped([...square, [15, 5]], [0, 1, 2, 0, 2, 3, 0, 1, 2, 1, 0, 4]), BETA)
        .reason,
    ).toBe('edge with triangles on both sides');
  });

  it('keeps a zero-area triangle that closes a T-junction in the chain', () => {
    // [10, 20] × [10, 30]: the top half's edge (10, 20)–(20, 20) meets the bottom half's vertex
    // (15, 20). The zero-area triangle P → Q → v cancels both sides of the T exactly.
    const pts = [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [15, 20],
      [20, 30],
      [10, 30],
    ] as const;
    const halves = [0, 1, 2, 0, 2, 3, 3, 4, 6, 4, 5, 6, 4, 2, 5];
    expect(flipTolerantBound(mapped(pts, halves), BETA).reason).toBe(
      'edge with triangles on both sides',
    );
    const closed = flipTolerantBound(mapped(pts, [...halves, 3, 2, 4]), BETA);
    expect(closed.reason).toBeNull();
    expect(closed.edges).toBe(6);
    expect(closed.rho).toBeLessThan(1.1 * BETA);
  });

  it('covers a zero-area triangle folded onto a boundary edge, either way round', () => {
    // The kernel emits these: three collinear points on a boundary edge of a real triangle.
    const pts = [
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [15, 10],
    ] as const;
    for (const fold of [
      [0, 4, 1],
      [0, 1, 4],
    ]) {
      const r = flipTolerantBound(mapped(pts, [0, 1, 2, 0, 2, 3, ...fold]), BETA);
      expect(r.reason).toBeNull();
      expect(r.rho).toBeLessThan(1.1 * BETA);
    }
  });

  it('gives up when the outside next to the boundary is narrower than 2β', () => {
    // Two squares 1e-4 px apart.
    const r = flipTolerantBound(
      mapped(
        [
          [10, 10],
          [20, 10],
          [20, 20],
          [10, 20],
          [20.0001, 10],
          [30, 10],
          [30, 20],
          [20.0001, 20],
        ],
        [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
      ),
      BETA,
    );
    expect(r.rho).toBeNull();
    expect(r.reason).toBe('boundary offset');
    expect(FLIP_TOLERANT_RHO_MAX).toBeLessThan(1);
  });

  it('keeps membership off ρ of the boundary under random β moves that flip the sliver', () => {
    const m = mapped(SLIVER_POINTS, SLIVER_INDICES);
    const rho = flipTolerantBound(m, BETA).rho!;
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
    const inTriangle = (p: number[], q: number[], r: number[], x: number, y: number) => {
      const c = (a: number[], b: number[]) =>
        (b[0]! - a[0]!) * (y - a[1]!) - (b[1]! - a[1]!) * (x - a[0]!);
      const s = [c(p, q), c(q, r), c(r, p)];
      return s.every((v) => v >= 0) || s.every((v) => v <= 0);
    };
    const inMesh = (pts: number[][], x: number, y: number) => {
      for (let t = 0; t < SLIVER_INDICES.length; t += 3)
        if (
          inTriangle(
            pts[SLIVER_INDICES[t]!]!,
            pts[SLIVER_INDICES[t + 1]!]!,
            pts[SLIVER_INDICES[t + 2]!]!,
            x,
            y,
          )
        )
          return true;
      return false;
    };
    const exact = SLIVER_POINTS.map(([x, y]) => [x, y]);
    const toBoundary = (x: number, y: number) =>
      Math.min(Math.abs(x - 10), Math.abs(x - 20), Math.abs(y - 10), Math.abs(y - 20));
    let flipped = 0;
    for (let trial = 0; trial < 50; trial += 1) {
      const moved = exact.map(([x, y]) => {
        const a = random() * Math.PI;
        const r = Math.abs(random()) * BETA * 0.999;
        return [x! + r * Math.cos(a), y! + r * Math.sin(a)];
      });
      // Force the sliver's apex below the bottom edge in half the trials.
      if (trial % 2 === 0) moved[4]![1] = 10 - 0.5 * BETA;
      const [a, b, v] = [moved[0]!, moved[1]!, moved[4]!];
      if ((b[0]! - a[0]!) * (v[1]! - a[1]!) - (b[1]! - a[1]!) * (v[0]! - a[0]!) < 0) flipped += 1;
      for (let k = 0; k < 400; k += 1) {
        const x = 15 + random() * 6;
        const y = 10 + random() * 0.01;
        if (inMesh(moved, x, y) !== inMesh(exact, x, y))
          expect(toBoundary(x, y)).toBeLessThanOrEqual(rho);
      }
    }
    expect(flipped).toBeGreaterThan(0);
  });
});
