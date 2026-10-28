import { describe, expect, it } from 'vitest';
import { controlPorts, meshFromTriangles } from './e3-a04/controls.js';
import {
  boundaryDistanceFromWindow,
  FLIP_TOLERANT_RHO_MAX,
  flipTolerantBound,
  mapPoint,
  measureCase,
  noFlip,
  type Mapped,
  type ShaderLanes,
} from './e3-a04/harness.js';
import { fill, polygon, rect, stroke, type CasePaint } from './e3-a04/oracle-cases.js';
import { harnessCase } from './e3-a04/smoke.js';

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
      // B_R: every point of the bottom edge has points in and out of M_gpu within ρ.
      for (let k = 0; k < 50; k += 1) {
        const x = 15 + random() * 4.5;
        const ring = Array.from({ length: 16 }, (_, j) => {
          const a = (j * Math.PI) / 8;
          return inMesh(moved, x + rho * Math.cos(a), 10 + rho * Math.sin(a));
        });
        expect(ring.some((v) => v)).toBe(true);
        expect(ring.some((v) => !v)).toBe(true);
      }
    }
    expect(flipped).toBeGreaterThan(0);
  });

  it('checks edges that leave the grid', () => {
    // Two slabs 1e-5 px apart across a 64 px viewport, reaching far past the grid's box. Their
    // facing edges have no outside more than β from both, inside the window or outside it.
    const small: ShaderLanes = { ...lanes, frame: { ...lanes.frame, width: 64, height: 64 } };
    const pts = [
      [20, -3000],
      [32, -3000],
      [32, 1000],
      [20, 1000],
      [32.00001, -500],
      [44, -500],
      [44, 1005],
      [32.00001, 1005],
    ] as const;
    const r = flipTolerantBound(
      {
        points: pts.map(([x, y]) => mapPoint(x, y, small)),
        indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
        width: 64,
        height: 64,
      },
      BETA,
    );
    expect(r.rho).toBeNull();
    expect(r.reason).toBe('boundary offset');
  });

  it('ignores a zero-area triangle far outside the window', () => {
    const r = flipTolerantBound(
      mapped([...SLIVER_POINTS, [1000, 10], [1010, 10], [1020, 10]], [...SLIVER_INDICES, 5, 6, 7]),
      BETA,
    );
    expect(r.reason).toBeNull();
  });
});

// E20 (docs/plans/d9-e20-a04-remedies-contract.md): the remedies K1 to K4 and K6, which the
// harness tries only where the section-20 bound failed or could not run.
const E20 = { e20: true } as const;
type Xy = readonly [number, number];
const signedArea = (p: Xy, q: Xy, r: Xy) =>
  (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
/** Triangles listed in any order, turned to positive area (zero-area ones as given). */
const oriented = (pts: readonly Xy[], tris: readonly (readonly number[])[]) =>
  tris.flatMap(([a, b, c]) =>
    signedArea(pts[a!]!, pts[b!]!, pts[c!]!) < 0 ? [a!, c!, b!] : [a!, b!, c!],
  );
/** Points at multiples of 2^-60 px, given as integers in that unit, for edges below binary64. */
const U60 = 2n ** 60n;
const fine = (pts: readonly (readonly [bigint, bigint])[], indices: number[]): Mapped => ({
  points: pts.map(([x, y]) => ({
    x: { n: x, e: -60 },
    y: { n: y, e: -60 },
    betaVertex: 0,
    betaFeature: 0,
  })),
  indices,
  width: 640,
  height: 360,
});

/**
 * Section 20.4's sampled check: under random vertex moves of at most `beta` (and, with `clipX`,
 * the clip points of triangles crossing `x = clipX` displaced by at most `betaClip`, one per
 * shared edge, as K1's crack-closed region places them), membership changes only within `rho`
 * of ∂M*. The clipped triangles keep their pieces beyond the clip line, so the moved mesh stays
 * closed there as well.
 */
function sampledMoves(
  pts: readonly Xy[],
  indices: readonly number[],
  o: Readonly<{
    rho: number;
    beta: number;
    toBoundary: (x: number, y: number) => number;
    sample: (random: () => number) => Xy;
    clipX?: number;
    betaClip?: number;
    force?: (moved: [number, number][], trial: number) => void;
  }>,
): number {
  let seed = 11;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const inPolygon = (poly: readonly Xy[], x: number, y: number) => {
    let odd = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
    return odd;
  };
  const inTriangle = (p: Xy, q: Xy, r: Xy, x: number, y: number) => {
    const s = [signedArea(p, q, [x, y]), signedArea(q, r, [x, y]), signedArea(r, p, [x, y])];
    return s.every((v) => v >= 0) || s.every((v) => v <= 0);
  };
  const polygons = (at: readonly Xy[], shift: (i: number, j: number) => Xy) => {
    const out: Xy[][] = [];
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const tri = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      const xs = tri.map((i) => at[i]![0]);
      if (o.clipX === undefined || Math.max(...xs) <= o.clipX || Math.min(...xs) >= o.clipX) {
        out.push(tri.map((i) => at[i]!));
        continue;
      }
      const inner: Xy[] = [];
      const outer: Xy[] = [];
      for (let k = 0; k < 3; k += 1) {
        const [i, j] = [tri[k]!, tri[(k + 1) % 3]!];
        const [p, q] = [at[i]!, at[j]!];
        (p[0] <= o.clipX ? inner : outer).push(p);
        if (p[0] < o.clipX !== q[0] < o.clipX && p[0] !== o.clipX && q[0] !== o.clipX) {
          const l = (o.clipX - p[0]) / (q[0] - p[0]);
          const [dx, dy] = shift(Math.min(i, j), Math.max(i, j));
          const c: Xy = [p[0] + l * (q[0] - p[0]) + dx, p[1] + l * (q[1] - p[1]) + dy];
          inner.push(c);
          outer.push(c);
        }
      }
      out.push(inner, outer);
    }
    return out;
  };
  const covered = (polys: readonly Xy[][], x: number, y: number) =>
    polys.some((poly) =>
      poly.length === 3 ? inTriangle(poly[0]!, poly[1]!, poly[2]!, x, y) : inPolygon(poly, x, y),
    );
  const exact = polygons(pts, () => [0, 0]);
  let changed = 0;
  for (let trial = 0; trial < 40; trial += 1) {
    const moved = pts.map(([x, y]): [number, number] => {
      const a = random() * Math.PI;
      const r = Math.abs(random()) * o.beta * 0.999;
      return [x + r * Math.cos(a), y + r * Math.sin(a)];
    });
    o.force?.(moved, trial);
    const shifts = new Map<string, Xy>();
    const shift = (i: number, j: number): Xy => {
      const k = `${i},${j}`;
      if (!shifts.has(k)) {
        const a = random() * Math.PI;
        const r = Math.abs(random()) * (o.betaClip ?? 0) * 0.999;
        shifts.set(k, [r * Math.cos(a), r * Math.sin(a)]);
      }
      return shifts.get(k)!;
    };
    const polys = polygons(moved, shift);
    for (let k = 0; k < 400; k += 1) {
      const [x, y] = o.sample(random);
      if (covered(polys, x, y) !== covered(exact, x, y)) {
        changed += 1;
        expect(o.toBoundary(x, y)).toBeLessThanOrEqual(o.rho);
      }
    }
  }
  return changed;
}

describe('E20 remedies on the flip-tolerant bound', () => {
  const square = [
    [10, 10],
    [20, 10],
    [20, 20],
    [10, 20],
  ] as const;
  const toSquare = (x: number, y: number) =>
    Math.min(Math.abs(x - 10), Math.abs(x - 20), Math.abs(y - 10), Math.abs(y - 20));

  it('admits a zero-area triangle inside M* (E20-K2) and keeps moves within ρ', () => {
    const pts: Xy[] = [...square, [12, 15], [14, 15], [16, 15]];
    const indices = [
      ...oriented(pts, [
        [0, 1, 2],
        [0, 2, 3],
      ]),
      4,
      5,
      6,
    ];
    const m = mapped(pts, indices);
    expect(flipTolerantBound(m, BETA).reason).toBe('zero-area triangle off M*');
    const r = flipTolerantBound(m, BETA, E20);
    expect(r.reason).toBeNull();
    // K6 splits the triangle's long edge at (14, 15), so its edges cancel.
    expect(r.splitTVertices).toBe(1);
    expect(r.rho).toBeLessThan(1.1 * BETA);
    const changed = sampledMoves(pts, indices, {
      rho: r.rho!,
      beta: BETA,
      toBoundary: toSquare,
      sample: (random) => [15 + random() * 5.5, 15 + random() * 5.5],
      force: (moved, trial) => {
        // Open the zero-area triangle into a thin one, either way round.
        moved[5]![1] = 15 + (trial % 2 === 0 ? 0.5 : -0.5) * BETA;
      },
    });
    expect(changed).toBeGreaterThan(0);
  });

  it('refuses a zero-area triangle that pokes out of M* or dangles off it (E20-K2)', () => {
    // 2^-20 px (about 10^-6) past the left side, which is f32-exact at x = 10.
    const out = 10 - 2 ** -20;
    const poke: Xy[] = [...square, [out, 15], [13, 15], [16, 15]];
    expect(
      flipTolerantBound(
        mapped(poke, [
          ...oriented(poke, [
            [0, 1, 2],
            [0, 2, 3],
          ]),
          4,
          5,
          6,
        ]),
        BETA,
        E20,
      ).reason,
    ).toBe('zero-area triangle off M*');
    expect(
      flipTolerantBound(mapped([...square, [30, 10]], [0, 1, 2, 0, 2, 3, 0, 1, 4]), BETA, E20)
        .reason,
    ).toBe('zero-area triangle off M*');
  });

  it('splits a T-junction left open in the chain (E20-K6)', () => {
    // E3-PC13's shape: [10, 20] × [10, 20] fanned around a sliver apex, over [10, 20] × [20, 30]
    // whose node (15, 20) lies inside the shared side.
    const pts: Xy[] = [...square, [15, 10.00001], [15, 20], [20, 30], [10, 30]];
    const indices = oriented(pts, [
      [0, 1, 4],
      [1, 2, 4],
      [2, 3, 4],
      [3, 0, 4],
      [3, 5, 7],
      [5, 6, 7],
      [5, 2, 6],
    ]);
    const m = mapped(pts, indices);
    expect(noFlip(m, BETA).failed).toBeGreaterThan(0);
    expect(flipTolerantBound(m, BETA).reason).toBe('edge with triangles on both sides');
    const r = flipTolerantBound(m, BETA, E20);
    expect(r.reason).toBeNull();
    expect(r.splitTVertices).toBe(1);
    expect(r.rho).toBeLessThan(1.1 * BETA);
    // Triangles on both sides of an edge with no vertex on it stay refused.
    expect(
      flipTolerantBound(
        mapped([...square, [15, 5]], [0, 1, 2, 0, 2, 3, 0, 1, 2, 1, 0, 4]),
        BETA,
        E20,
      ).reason,
    ).toBe('edge with triangles on both sides');
  });

  it('keeps the smaller D of the old and refined searches (E20-K3)', () => {
    const shapes: [Xy[], number[]][] = [
      [[...SLIVER_POINTS], SLIVER_INDICES],
      [
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
      ],
    ];
    for (const [pts, indices] of shapes) {
      const old = flipTolerantBound(mapped(pts, indices), BETA);
      const refined = flipTolerantBound(mapped(pts, indices), BETA, { e20: true, refineAll: true });
      expect(old.rho).not.toBeNull();
      expect(refined.rho!).toBeLessThanOrEqual(old.rho!);
    }
  });

  it('tests an edge below binary64 exactly (E20-K3)', () => {
    const e = 1n;
    const at = (x: number, y: number, dx = 0n, dy = 0n): [bigint, bigint] => [
      BigInt(x) * U60 + dx,
      BigInt(y) * U60 + dy,
    ];
    // The square with its corner (10, 10) cut by a chamfer 2^-60 px long.
    const chamfer = fine(
      [at(10, 10, e), at(20, 10), at(20, 20), at(10, 20), at(10, 10, 0n, e)],
      [0, 1, 2, 0, 2, 3, 0, 3, 4],
    );
    expect(flipTolerantBound(chamfer, BETA).reason).toBe('edge below binary64');
    const r = flipTolerantBound(chamfer, BETA, E20);
    expect(r.reason).toBeNull();
    expect(r.exactEdges).toBe(1);
    expect(r.rho).toBeLessThan(1.1 * BETA);
  });

  it('refuses a hole below binary64, and catches D reported without the exact test (E20-A3)', () => {
    const e = 1n;
    const at = (x: number, y: number, dx = 0n, dy = 0n): [bigint, bigint] => [
      BigInt(x) * U60 + dx,
      BigInt(y) * U60 + dy,
    ];
    // A triangular hole 2^-60 px across in the square: its edges face only M* beyond the hole.
    const pts = [
      at(10, 10),
      at(20, 10),
      at(20, 20),
      at(10, 20),
      at(15, 15),
      at(15, 15, e),
      at(15, 15, 0n, e),
    ];
    // In y-down pixels these all have positive area (checked by the old path, which refuses
    // only at the offset step).
    const hole = fine(pts, [0, 1, 5, 0, 5, 4, 1, 2, 5, 2, 6, 5, 2, 3, 6, 3, 0, 4, 3, 4, 6]);
    expect(flipTolerantBound(hole, BETA).reason).toBe('edge below binary64');
    const r = flipTolerantBound(hole, BETA, E20);
    expect(r.rho).toBeNull();
    expect(r.reason).toBe('edge below binary64');
    expect(
      flipTolerantBound(hole, BETA, { e20: true, defect: 'no-exact-fallback' }).rho,
    ).not.toBeNull();
  });

  it('places the window-empty guard at β_c (E20-K4)', () => {
    const betaC = 0.01;
    // Ω's right side is x = 642. A square whose left side is 1.5β_c or 0.5β_c beyond it.
    for (const [gap, decided] of [
      [1.5, true],
      [0.5, false],
    ] as const) {
      const x0 = 642 + gap * betaC;
      const m = mapped(
        [
          [x0, 10],
          [x0 + 10, 10],
          [x0 + 10, 20],
          [x0, 20],
        ],
        [0, 1, 2, 0, 2, 3],
      );
      const distance = boundaryDistanceFromWindow(m);
      expect(distance).toBeLessThanOrEqual(gap * betaC);
      expect(distance > betaC).toBe(decided);
    }
    expect(
      boundaryDistanceFromWindow(
        mapped(
          square.map((p) => [...p] as Xy),
          [0, 1, 2],
        ),
      ),
    ).toBe(0);
  });

  it('keeps moves within ρ when clip points move within β_clip (E20-K1)', () => {
    // [600, 700] × [10, 20] across the viewport's right side x = 640, fanned around a vertex
    // 10^-5 px above its bottom edge. β = β_vertex + β_clip.
    const pts: Xy[] = [
      [600, 10],
      [700, 10],
      [700, 20],
      [600, 20],
      [650, 10.00001],
    ];
    const r = flipTolerantBound(mapped(pts, SLIVER_INDICES), BETA, E20);
    expect(r.reason).toBeNull();
    const toRect = (x: number, y: number) =>
      Math.min(Math.abs(x - 600), Math.abs(x - 700), Math.abs(y - 10), Math.abs(y - 20));
    const changed = sampledMoves(pts, SLIVER_INDICES, {
      rho: r.rho!,
      beta: BETA / 2,
      betaClip: BETA / 2,
      clipX: 640,
      toBoundary: toRect,
      sample: (random) =>
        random() > 0
          ? [650 + random() * 45, 10 + random() * 0.01]
          : [640 + random() * 0.01, 15 + random() * 4.5],
      force: (moved, trial) => {
        if (trial % 2 === 0) moved[4]![1] = 10 - 0.25 * BETA;
      },
    });
    expect(changed).toBeGreaterThan(0);
  });
});

describe('the flip-tolerant path through measureCase (section 20)', () => {
  // A 64 × 32 rectangle fanned around a vertex 1e-5 px above its bottom edge.
  const sliverFan = (x0: number, y0: number, x1: number, y1: number) => {
    const v: [number, number] = [(x0 + x1) / 2, y0 + 1e-5];
    return meshFromTriangles([
      [[x0, y0], [x1, y0], v],
      [[x1, y0], [x1, y1], v],
      [[x1, y1], [x0, y1], v],
      [[x0, y1], [x0, y0], v],
    ]);
  };

  it('measures with ρ in place of β_c in U and L', () => {
    const kase = harnessCase({ id: 'U6-1', ...polygon(rect(0, 0, 64, 32)), paint: fill() });
    const row = measureCase(kase, controlPorts({ status: 'ok', mesh: sliverFan(0, 0, 64, 32) }));
    expect(row.noFlip!.failed).toBeGreaterThan(0);
    expect(row.flipTolerant!.reason).toBeNull();
    const rho = row.flipTolerant!.rho!;
    expect(rho).toBeGreaterThan(row.betaC!);
    expect(row.status).toBe('pass');
    expect(row.u!).toBeGreaterThanOrEqual(row.eHi! + rho);
    expect(row.u! - row.eHi!).toBeLessThan(rho * (1 + 1e-9));
  });

  // E20-K1: the bound also runs when triangles cross the guard band, on M* unclipped.
  const clipped = (
    id: string,
    paint: CasePaint,
    path: Readonly<{ verbs: string; points: readonly number[] }>,
  ) => harnessCase({ id, ...path, paint, c: [0, 0] });
  const fanTriangles = (x0: number, y0: number, x1: number, y1: number) => {
    const v: [number, number] = [(x0 + x1) / 2, y0 + 1e-5];
    return [
      [[x0, y0], [x1, y0], v],
      [[x1, y0], [x1, y1], v],
      [[x1, y1], [x0, y1], v],
      [[x0, y1], [x0, y0], v],
    ] as [number, number][][];
  };

  it('decides a clipped sliver strip (E20-K1, fill)', () => {
    // The rectangle runs past the viewport's right side, so its triangles cross the guard band.
    const row = measureCase(
      clipped('E20-K1-fill', fill(), polygon(rect(0, 0, 900, 32))),
      controlPorts({ status: 'ok', mesh: sliverFan(0, 0, 900, 32) }),
    );
    expect(row.noFlip!.failed).toBeGreaterThan(0);
    expect(row.guard!.crossing).toBeGreaterThan(0);
    expect(row.flipTolerant!.reason).toBeNull();
    expect(row.flipTolerant!.clipped).toBe(true);
    expect(row.e20).toEqual([{ rule: 'flip-tolerant', former: null }]);
    expect(row.flipTolerant!.rho!).toBeLessThan(1.1 * row.betaC!);
    expect(row.status).toBe('pass');
  });

  it('bounds a clipped stroke strip (E20-K1, stroke)', () => {
    // The stroke oracle is slow on this sliver mesh, so a small work cap stops it: the bound is
    // what this checks.
    const row = measureCase(
      clipped('E20-K1-stroke', stroke(32), { verbs: 'ML', points: [0, 16, 900, 16] }),
      controlPorts({ status: 'ok', mesh: sliverFan(0, 0, 900, 32) }),
      { workCap: 1e6 },
    );
    expect(row.noFlip!.failed).toBeGreaterThan(0);
    expect(row.guard!.crossing).toBeGreaterThan(0);
    expect(row.flipTolerant!.reason).toBeNull();
    expect(row.flipTolerant!.clipped).toBe(true);
    expect(row.flipTolerant!.rho!).toBeLessThan(1.1 * row.betaC!);
    expect(row.e20).toEqual([{ rule: 'flip-tolerant', former: null }]);
    expect(row.reason).not.toBe('no-flip certificate');
  });

  it('keeps a clipped draw UNDECIDED when the bound fails (E20-K1)', () => {
    // Two clipped slabs 10^-5 px apart: no outside point more than β from both.
    const mesh = meshFromTriangles([
      ...fanTriangles(0, 0, 900, 32),
      ...fanTriangles(0, 32.00001, 900, 64),
    ]);
    const row = measureCase(
      clipped('E20-K1-gap', fill(), polygon(rect(0, 0, 900, 64))),
      controlPorts({ status: 'ok', mesh }),
    );
    expect(row.guard!.crossing).toBeGreaterThan(0);
    expect(row.status).toBe('undecided');
    expect(row.reason).toBe('no-flip certificate');
    expect(row.flipTolerant).toBeNull();
    expect(row.e20![0]!.rule).toBe('flip-tolerant');
    expect(row.e20![0]!.attempt!.reason).toBe('boundary offset');
  });

  it('decides window-empty through measureCase at β_c (E20-K4)', () => {
    // A triangle outside Ω whose long edge passes the corner (642, −2) at a set distance; its
    // box meets Ω ⊕ 1, so the 2026-10-27 guard refused it.
    const outside = (gap: number) => {
      const k = 644 + gap * Math.SQRT2;
      const tri: [number, number][] = [
        [600, 600 - k],
        [1000, 600 - k],
        [1000, 1000 - k],
      ];
      return measureCase(
        harnessCase({ id: `E20-K4-${gap}`, ...polygon(tri), paint: fill(), c: [0, 0] }),
        controlPorts({ status: 'ok', mesh: meshFromTriangles([tri]) }),
      );
    };
    const far = outside(0.0049);
    expect(far.status).toBe('window-empty');
    expect(far.e20![0]!.rule).toBe('window-empty-guard');
    expect(far.e20![0]!.distance!).toBeGreaterThan(1.4 * far.betaC!);
    const near = outside(0.0016);
    expect(near.status).toBe('undecided');
    expect(near.reason).toBe('window-empty within the guard');
    expect(near.e20![0]!.distance!).toBeLessThan(0.6 * near.betaC!);
  });

  it('leaves a row the section-20 bound decides without an E20 trace', () => {
    const kase = harnessCase({ id: 'E20-gate', ...polygon(rect(0, 0, 64, 32)), paint: fill() });
    const row = measureCase(kase, controlPorts({ status: 'ok', mesh: sliverFan(0, 0, 64, 32) }));
    expect(row.status).toBe('pass');
    expect('e20' in row).toBe(false);
    expect(Object.keys(row.flipTolerant!)).toEqual(['rho', 'reason', 'edges', 'pieces', 'work']);
  });
});
