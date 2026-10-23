// D9 E3 unit E3-U2: tests of the independent A04 oracle
// (docs/plans/d9-e3-b4-precision-contract.md sections 4, 8 and 9, with the section 14 annex).
// Each proof obligation (a) to (g) of section 4.5 has its paired test below, and each control and
// seeded defect that the contract assigns to E3-U2 is applied here, never in the committed
// source. No kernel, port or renderer is loaded: U2 is oracle-only (section 5.5).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  A04_ORACLE_PARAMETERS,
  type A04Hooks,
  type A04Interval,
  type A04Mesh,
  type A04Scalar,
  a04BoundaryDistance,
  a04Contains,
  a04ContainsWith,
  a04FillPortions,
  a04FreezeCheck,
  a04IntervalSelfTest,
  a04Measure,
  a04NextDown,
  a04NextUp,
  a04StorageCracks,
  a04Winding,
} from '../../packages/geometry-reference/src/a04-region.js';
import { KAPPA, dyadic, iterateA04Corpus } from './e3-a04/corpus.js';
import {
  EMPTY_MESH,
  fanMesh,
  fill,
  makeCase,
  meshOf,
  polygon,
  polygons,
  rect,
  stroke,
} from './e3-a04/oracle-cases.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN: readonly [number, number] = [-100, -100]; // Φ(x) = x + 100 at T0, z = 1, d = 1
const shift = (points: readonly (readonly [number, number])[]): [number, number][] =>
  points.map(([x, y]) => [x + 100, y + 100]);

const contains = (i: A04Interval, v: number, slack = 0): boolean =>
  i.lo <= v + slack && v - slack <= i.hi;

/** Exact rational helpers for closed-form points (BigInt). */
type R = { num: bigint; den: bigint };
const rat = (n: bigint, d: bigint): R => (d < 0n ? { num: -n, den: -d } : { num: n, den: d });
/** Intersection of lines AB and CD with integer coordinates, as exact rationals. */
function intersect(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
): [R, R] {
  const [ax, ay, bx, by, cx, cy, dx, dy] = [...a, ...b, ...c, ...d].map((v) => BigInt(v));
  const rx = bx! - ax!;
  const ry = by! - ay!;
  const sx = dx! - cx!;
  const sy = dy! - cy!;
  const den = rx * sy - ry * sx;
  const num = (cx! - ax!) * sy - (cy! - ay!) * sx;
  return [rat(ax! * den + num * rx, den), rat(ay! * den + num * ry, den)];
}
const ratShift = (p: [R, R]): [R, R] => [
  { num: p[0].num + 100n * p[0].den, den: p[0].den },
  { num: p[1].num + 100n * p[1].den, den: p[1].den },
];

/** circle(cx, cy, r) of the corpus page helpers: four cubics from (cx + r, cy). */
function circlePath(
  cx: number,
  cy: number,
  r: number,
  sx = 1,
  sy = 1,
): { verbs: string; points: number[] } {
  const k = r * KAPPA;
  const pts = [
    [cx + r, cy],
    [cx + r, cy + k],
    [cx + k, cy + r],
    [cx, cy + r],
    [cx - k, cy + r],
    [cx - r, cy + k],
    [cx - r, cy],
    [cx - r, cy - k],
    [cx - k, cy - r],
    [cx, cy - r],
    [cx + k, cy - r],
    [cx + r, cy - k],
    [cx + r, cy],
  ].map(([x, y]) => [x! * sx, y! * sy]);
  return { verbs: 'MCCCCZ', points: pts.flat() };
}

/** E3-D12: drops every record of the first crossing interior to its curve. */
const dropOneCrossing: A04Hooks = {
  crossings: (list) => {
    const first = list.find((c) => c.lo.n > 0n && c.lo.n < c.lo.d);
    return first === undefined ? list : list.filter((c) => c.id !== first.id);
  },
};

const PENTAGRAM: [number, number][] = [
  [0, -10],
  [6, 8],
  [-10, -3],
  [10, -3],
  [-6, 8],
];

// =============================================================================================
// E3-A2: independence

describe('E3-A2: the oracle is independent of the kernel and the renderer', () => {
  it('imports only the stroke-region semantics of geometry-reference', () => {
    const source = readFileSync(
      path.resolve(here, '../../packages/geometry-reference/src/a04-region.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((m) => m[1]);
    expect(imports).toEqual(['./stroke-region.js']);
    for (const banned of ['geometry-wasm', 'renderer-core', 'renderer-webgpu'])
      expect(source.includes(banned) && /from '[^']*(geometry-wasm|renderer-)/u.test(source)).toBe(
        false,
      );
  });
});

// =============================================================================================
// Obligation (g): outward-rounded intervals

describe('obligation (g): outward-rounded binary64 intervals', () => {
  it('every interval operation contains the exact BigInt value at random dyadic inputs', () => {
    let state = 0x2545f491;
    const next = () => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state;
    };
    const samples: [number, number][] = [];
    for (let i = 0; i < 4000; i += 1) {
      const a = ((next() / 2 ** 32) * 2 - 1) * 2 ** ((next() % 80) - 40);
      const b = ((next() / 2 ** 32) * 2 - 1) * 2 ** ((next() % 80) - 40);
      samples.push([a, b]);
    }
    samples.push([0.1, 0.2], [1, 3], [2 ** -1074, 2 ** -1074], [1e300, 1e-300], [-0.5, 0]);
    expect(a04IntervalSelfTest(samples)).toEqual([]);
  });
  it('steps by exactly one binary64', () => {
    expect(a04NextUp(1)).toBe(1 + 2 ** -52);
    expect(a04NextDown(1)).toBe(1 - 2 ** -53);
    expect(a04NextUp(0)).toBe(Number.MIN_VALUE);
    expect(a04NextDown(-1)).toBe(-1 - 2 ** -52);
  });
});

// =============================================================================================
// Obligation (a): exact windings and closure membership

describe('obligation (a): exact winding numbers and membership on vertices and curves', () => {
  it('gives the closed-form windings of the E3-C1 star and nested contours', () => {
    const star = makeCase({ ...polygon(PENTAGRAM), paint: fill(), c: ORIGIN });
    const center = a04Winding(star, [100, 100]);
    expect(Math.abs(center)).toBe(2);
    expect(a04Winding(star, [100, 91])).toBe(center / 2); // the upper tip
    expect(a04Winding(star, [100, 95.5])).toBe(center / 2); // ray through the tip vertex row
    expect(a04Winding(star, [130, 130])).toBe(0);
    const nested = makeCase({
      ...polygons([rect(-12, -12, 12, 12), [...rect(-8, -8, 8, 8)].reverse(), rect(-4, -4, 4, 4)]),
      paint: fill(),
      c: ORIGIN,
    });
    const outer = a04Winding(nested, [110, 100]);
    expect(Math.abs(outer)).toBe(1);
    expect(a04Winding(nested, [106, 100])).toBe(0);
    expect(a04Winding(nested, [100, 100])).toBe(outer);
  });
  it('counts roots at t = 0 and t = 1 and tangential rays of cubics', () => {
    const circle = makeCase({ ...circlePath(0, 0, 8), paint: fill(), c: ORIGIN });
    const w = a04Winding(circle, [100, 100]); // ray through the anchor (108, 100): a root at t = 0, 1
    expect(Math.abs(w)).toBe(1);
    expect(a04Winding(circle, [80, 100])).toBe(0); // ray through both side anchors
    expect(a04Winding(circle, [80, 108])).toBe(0); // ray tangent to the top anchor
    expect(a04Winding(circle, [80, 92])).toBe(0); // ray tangent to the bottom anchor
    // Self-intersecting loop (E3-C3 c04): the two lobes wind in opposite senses.
    const loop = makeCase({
      verbs: 'MCZ',
      points: [0, 0, 12, 12, -4, 12, 8, 0],
      paint: fill(),
      c: ORIGIN,
    });
    // y(t) = 36t(1 − t), so the crossing has s + t = 1; solve x(s) = x(1 − s) by bisection.
    const x = (t: number) => 36 * t - 84 * t * t + 56 * t * t * t;
    let lo = 0.01;
    let hi = 0.49;
    for (let k = 0; k < 80; k += 1) {
      const m = (lo + hi) / 2;
      if ((x(m) - x(1 - m)) * (x(lo) - x(1 - lo)) > 0) lo = m;
      else hi = m;
    }
    const cx = x(lo);
    const cy = 36 * lo * (1 - lo);
    const top = a04Winding(loop, [100 + cx, 100 + cy + 1.5]);
    const bottom = a04Winding(loop, [100 + cx, 100 + cy / 2]);
    expect(Math.abs(top)).toBe(1);
    expect(bottom).toBe(-top);
  });
  it('decides points on vertices, edges and cubics as members of the closed region', () => {
    const r = makeCase({ ...polygon(rect(0, 0, 16, 8)), paint: fill(), c: ORIGIN });
    expect(a04Contains(r, [100, 100])).toBe(true); // vertex
    expect(a04Contains(r, [108, 100])).toBe(true); // edge
    expect(a04Contains(r, [100 - 2 ** -30, 104])).toBe(false);
    const star = makeCase({ ...polygon(PENTAGRAM), paint: fill(), c: ORIGIN });
    expect(a04Contains(star, [100, 90])).toBe(true); // tip vertex
    const pinch = makeCase({
      ...polygon([
        [0, 0],
        [8, 8],
        [16, 0],
        [16, 16],
        [8, 8],
        [0, 16],
      ]),
      paint: fill(),
      c: ORIGIN,
    });
    expect(a04Contains(pinch, [108, 108])).toBe(true); // pinch vertex
    const circle = makeCase({ ...circlePath(0, 0, 8), paint: fill(), c: ORIGIN });
    // C(1/2) of the first quarter arc, exact: (P0 + 3·P1 + 3·P2 + P3) / 8.
    // Both coordinates are 104 + 3κ, exactly, as rationals.
    const kd = dyadic(KAPPA);
    const den = 2n ** BigInt(-kd.e);
    const at = (delta: bigint): A04Scalar => ({ num: 104n * den + 3n * kd.n + delta, den });
    const tiny = den >> 20n;
    expect(a04Contains(circle, [at(0n), at(0n)])).toBe(true);
    expect(a04Contains(circle, [at(tiny), at(tiny)])).toBe(false);
    expect(a04Contains(circle, [at(-tiny), at(-tiny)])).toBe(true);
    // Coincident opposite edges cancel (s10): the shared side is interior.
    const s10 = makeCase({
      ...polygons([rect(0, 0, 16, 8), rect(16, 0, 32, 8)]),
      paint: fill(),
      c: ORIGIN,
    });
    expect(a04Contains(s10, [116, 104])).toBe(true);
    // A zero-area contour (s11) adds nothing.
    const s11 = makeCase({
      ...polygons([
        rect(0, 0, 16, 8),
        [
          [20, 0],
          [28, 0],
          [20, 0],
        ],
      ]),
      paint: fill(),
      c: ORIGIN,
    });
    expect(a04Contains(s11, [124, 100])).toBe(false);
    const portions = a04FillPortions(s10).filter((p) => p.boundary === true);
    expect(portions.every((p) => !(p.start[0] === 116 && p.end[0] === 116))).toBe(true);
  });
});

// =============================================================================================
// Obligation (b): sweep membership at stationary parameters

describe('obligation (b): sweeps over regular parameters, limit normals and cusp disks', () => {
  const f16 = makeCase({
    verbs: 'MC',
    points: [0, 0, 1, 1, 0, 1, 1, 0],
    paint: stroke(0.125),
    c: ORIGIN,
  });
  const at = (x: number, y: number): [number, number] => [100 + x, 100 + y];
  it('ST-F16: the cusp contributes its disk, not a sweep normal', () => {
    expect(a04Contains(f16, at(0.5, 0.8))).toBe(true);
    expect(a04Contains(f16, at(0.5, 0.8125 - 2 ** -20))).toBe(true);
    expect(a04Contains(f16, at(0.5, 0.8125 + 2 ** -20))).toBe(false);
    expect(a04Contains(f16, at(0.5625, 0.75))).toBe(true); // end of the limit normal, on the disk
    // Without the disk, the sweep reaches x = 0.5 only at the cusp itself (y = 0.75): the point
    // 0.03 above it is covered by the cusp disk alone.
    const noDisk: A04Hooks = { dropStrokePiece: (role) => role === 'cusp-disk' };
    expect(a04ContainsWith(f16, at(0.5, 0.78), noDisk)).toBe(false);
    expect(a04ContainsWith(f16, at(0.5, 0.75), noDisk)).toBe(true);
    expect(a04ContainsWith(f16, at(0.5, 0.74), noDisk)).toBe(true);
  });
  it('ST-F19: a collinear continuation adds no disk; the region is [−1, 1]²', () => {
    const f19 = makeCase({
      verbs: 'MC',
      points: [-1, 0, 1, 0, -1, 0, 1, 0],
      paint: stroke(2),
      c: ORIGIN,
    });
    expect(a04Contains(f19, at(0, 0))).toBe(true);
    expect(a04Contains(f19, at(1, 1))).toBe(true);
    expect(a04Contains(f19, at(1 + 2 ** -30, 0))).toBe(false);
    expect(a04Contains(f19, at(0, 1 + 2 ** -30))).toBe(false);
    expect(a04Contains(f19, at(-1 - 2 ** -30, 0.5))).toBe(false);
  });
  it('ST-F18 at a butt cap: a stationary start has its limit normal, no disk behind it', () => {
    const f18 = makeCase({
      verbs: 'MC',
      points: [0, 0, 0, 0, 1, 0, 3, 1],
      paint: stroke(2),
      c: ORIGIN,
    });
    expect(a04Contains(f18, at(-0.5, 0.5))).toBe(false);
    expect(a04Contains(f18, at(-(2 ** -30), 0))).toBe(false);
    expect(a04Contains(f18, at(0, 0.999))).toBe(true);
    expect(a04Contains(f18, at(0.25, 0.9))).toBe(true);
  });
});

// =============================================================================================
// Obligation (c): completeness of the ∂R portions (E3-PC6, E3-PC10, E3-D12)

describe('obligation (c): every boundary portion of R is found', () => {
  it('E3-PC6: a ring meshed without its 0.4 px hole fails on B_R at the closed form', () => {
    const ring = makeCase({
      ...polygons([rect(-8, -8, 8, 8), [...rect(-0.2, -4, 0.2, 4)].reverse()]),
      paint: fill(),
      c: ORIGIN,
    });
    const portions = a04FillPortions(ring).filter((p) => p.boundary === true);
    expect(portions).toHaveLength(8);
    const m = a04Measure(ring, fanMesh(shift(rect(-8, -8, 8, 8))), { separateTerms: true });
    expect(m.status).toBe('fail');
    expect(contains(m.bR!, 8 - 0.2)).toBe(true);
    expect(m.bR!.hi - m.bR!.lo).toBeLessThanOrEqual(A04_ORACLE_PARAMETERS.resolution);
  });
  it('E3-D12: the star portions match the closed-form outline; dropping a crossing is caught', () => {
    const star = makeCase({ ...polygon(PENTAGRAM), paint: fill(), c: ORIGIN });
    // Closed form: each outline portion runs from a tip to the crossing on its edge nearest to
    // it, with the crossings computed exactly from the integer vertices.
    const v = PENTAGRAM;
    const crossings = [0, 1, 2, 3, 4].map((i) => {
      const p = intersect(v[i]!, v[(i + 1) % 5]!, v[(i + 2) % 5]!, v[(i + 3) % 5]!);
      return [
        Number(p[0].num) / Number(p[0].den) + 100,
        Number(p[1].num) / Number(p[1].den) + 100,
      ] as const;
    });
    const expected: (readonly [readonly [number, number], readonly [number, number]])[] = [];
    for (let i = 0; i < 5; i += 1) {
      const a = shift([v[i]!])[0]!;
      const b = shift([v[(i + 1) % 5]!])[0]!;
      const onEdge = [crossings[i]!, crossings[(i + 3) % 5]!];
      for (const tip of [a, b]) {
        const near = [...onEdge].sort(
          (p, q) =>
            Math.hypot(p[0] - tip[0], p[1] - tip[1]) - Math.hypot(q[0] - tip[0], q[1] - tip[1]),
        )[0]!;
        expected.push([tip, near]);
      }
    }
    const same = (p: readonly [number, number], q: readonly [number, number]) =>
      Math.abs(p[0] - q[0]) < 1e-12 && Math.abs(p[1] - q[1]) < 1e-12;
    const check = (hooks: A04Hooks) => {
      const b = a04FillPortions(star, hooks).filter((p) => p.boundary === true && p.certain);
      if (b.length !== expected.length) return false;
      return expected.every(([s, e]) =>
        b.some((p) => (same(p.start, s) && same(p.end, e)) || (same(p.start, e) && same(p.end, s))),
      );
    };
    expect(check({})).toBe(true);
    expect(check(dropOneCrossing)).toBe(false);
  });
  it('E3-D12: the crossing ellipses have bits at the closed-form crossings; dropping one is caught', () => {
    const e1 = circlePath(0, 0, 1, 12, 4);
    const e2 = circlePath(0, 0, 1, 4, 12);
    const kase = makeCase({
      verbs: e1.verbs + e2.verbs,
      points: [...e1.points, ...e2.points],
      paint: fill(),
      c: ORIGIN,
    });
    // Closed form: the crossings lie on y = ±x by symmetry; on the first quarter arc of e1,
    // (12, 0) (12, 4κ) (12κ, 4) (0, 4), solve x(t) = y(t) by bisection.
    const k = KAPPA;
    const bez = (a: number, b: number, c: number, d: number, t: number) =>
      (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 100; i += 1) {
      const m = (lo + hi) / 2;
      if (bez(12, 12, 12 * k, 0, m) - bez(0, 4 * k, 4, 4, m) > 0) lo = m;
      else hi = m;
    }
    const q = bez(12, 12, 12 * k, 0, lo);
    const crossings = [
      [q, q],
      [-q, q],
      [-q, -q],
      [q, -q],
    ].map(([x, y]) => [x! + 100, y! + 100] as const);
    const near = (p: { start: readonly [number, number] }) =>
      crossings.some(([x, y]) => Math.hypot(p.start[0] - x, p.start[1] - y) < 1e-6);
    const run = (hooks: A04Hooks) => {
      const portions = a04FillPortions(kase, hooks);
      const bits = portions.filter((p) => p.bitClass !== null);
      const outline = portions.filter((p) => p.certain && p.boundary === true);
      return { bits, outline };
    };
    const ok = run({});
    expect(ok.bits).toHaveLength(8);
    expect(ok.bits.every((b) => b.bitClass === 'partial' && near(b))).toBe(true);
    expect(ok.outline).toHaveLength(8);
    const bad = run(dropOneCrossing);
    expect(bad.bits.length === 8 && bad.outline.length === 8).toBe(false);
  });
});

// =============================================================================================
// Obligation (d): offset-curve crossings (strokes)

describe('fill boundary distance', () => {
  it('S1: a boundary edge clipped from the index still bounds the distance from below', () => {
    // A tall rectangle at T0, z = 1, d = 1: from (−3, 180) the nearest edge is x = −100, at 97 px,
    // and lies outside the window the index search visits first (review S1 of PR #212).
    const tall = makeCase({ ...polygon(rect(-100, -1000, 700, 2000)), paint: fill() });
    const d = a04BoundaryDistance(tall, [-3, 180], 2 ** -10);
    expect(d.lo).toBeLessThanOrEqual(97);
    expect(d.hi).toBeGreaterThanOrEqual(97);
  });
});

describe('obligation (d): stroke boundary at closed-form offset crossings', () => {
  it('a folded band: the parabola stroke closes its fold exactly at (0, 2.5)', () => {
    // y = x²/2 on x ∈ [−3, 3] as an elevated quadratic; w = 4. The inner offset folds and the
    // covered axis ends at y = 1 + 3/2 = 2.5 (normals from x² = 3 reach (0, x²/2 + 1)).
    const band = makeCase({
      verbs: 'MC',
      points: [-3, 4.5, -1, -1.5, 1, -1.5, 3, 4.5],
      paint: stroke(4),
      c: ORIGIN,
    });
    expect(a04Contains(band, [100, 102.5])).toBe(true);
    expect(a04Contains(band, [100, 102.5 + 2 ** -20])).toBe(false);
    expect(a04Contains(band, [100, 102.5 - 2 ** -20])).toBe(true);
    const d = a04BoundaryDistance(band, [100, 102.5], 2 ** -12);
    expect(d.lo).toBe(0);
    expect(d.hi).toBeLessThanOrEqual(2 ** -10);
    expect(a04FreezeCheck(band).status).toBe('ok');
  });
  it('a wide turn: the inner offsets cross at (0, 2√2)', () => {
    const turn = makeCase({
      verbs: 'MLL',
      points: [-10, 10, 0, 0, 10, 10],
      paint: stroke(4, 'butt', 'miter'),
      c: ORIGIN,
    });
    const y = 2 * Math.SQRT2;
    expect(a04Contains(turn, [100, 100 + y - 1e-9])).toBe(true);
    expect(a04Contains(turn, [100, 100 + y + 1e-9])).toBe(false);
    const d = a04BoundaryDistance(turn, [100, 100 + y], 2 ** -14);
    expect(d.lo).toBeLessThanOrEqual(1e-12);
    expect(d.hi).toBeLessThanOrEqual(2 ** -12);
    expect(a04FreezeCheck(turn).status).toBe('ok');
  });
  it('E3-D4: nearest-point sweep membership is caught on the folded band', () => {
    const band = makeCase({
      verbs: 'MC',
      points: [-3, 4.5, -1, -1.5, 1, -1.5, 3, 4.5],
      paint: stroke(4),
      c: ORIGIN,
    });
    // Beyond the butt end along the end tangent (1, 3), 0.5 from the end point (3, 4.5): no
    // normal foot reaches it (f(t) = (P − C(t))·C′(t) > 0 on [0, 1]), but it is 0.5 < r from C.
    const p: [number, number] = [100 + 3 + 0.5 / Math.sqrt(10), 100 + 4.5 + 1.5 / Math.sqrt(10)];
    expect(a04Contains(band, p)).toBe(false);
    const nearest: A04Hooks = {
      sweepContains: (sweep) => {
        const [p0, p1, p2, p3] = sweep.controls as [
          readonly [number, number],
          readonly [number, number],
          readonly [number, number],
          readonly [number, number],
        ];
        let best = Infinity;
        for (let i = 0; i <= 20000; i += 1) {
          const t = i / 20000;
          const u = 1 - t;
          const x =
            u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
          const y =
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
          best = Math.min(best, Math.hypot(x - sweep.point[0], y - sweep.point[1]));
        }
        return best <= sweep.radius;
      },
    };
    expect(a04ContainsWith(band, p, nearest)).toBe(true);
  });
});

// =============================================================================================
// Obligation (e): ∂M from a non-conforming mesh (E3-PC13, E3-D11)

describe('obligation (e): ∂M extraction splits edges at T-vertices', () => {
  // T4 shear, f32-exact offsets with full 24-bit significands; zoom 64 so the square is large.
  const a = 1 - 2 ** -24;
  const ym = 0.5 - 2 ** -25;
  const T4: [number, number, number, number] = [1, 0.5, 0, 1];
  const kase = makeCase({
    ...polygon(rect(0, 0, 2 * a, a)),
    paint: fill(),
    l: T4,
    zoom: 64,
    c: [-1, -1],
  });
  // Φ(x, y) = 64·(x + 0.5·y + 1, y + 1), exact in binary64 here.
  const phi = (x: number, y: number): [number, number] => [64 * (x + 0.5 * y + 1), 64 * (y + 1)];
  const local: [number, number][][] = [
    [
      [0, 0],
      [a, 0],
      [a, a],
    ],
    [
      [0, 0],
      [a, a],
      [0, a],
    ],
    [
      [a, 0],
      [2 * a, 0],
      [a, ym],
    ],
    [
      [2 * a, 0],
      [2 * a, a],
      [a, ym],
    ],
    [
      [2 * a, a],
      [a, a],
      [a, ym],
    ],
  ];
  const mesh = meshOf(local.map((tri) => tri.map(([x, y]) => phi(x, y))));
  it('E3-PC13: in M* the T-junction mesh has no spurious inner boundary and E = 0', () => {
    const m = a04Measure(kase, mesh, { separateTerms: true, betaC: 2 ** -20 });
    expect(m.tJunctions).toBe(1);
    expect(m.crackBound).toBe(a04NextUp(2 ** -19));
    expect(m.status).toBe('pass');
    expect(m.e!.lo).toBe(0);
    expect(m.e!.hi).toBeLessThanOrEqual(A04_ORACLE_PARAMETERS.resolution);
    expect(m.boundaryEdges).toBe(6);
    const port = meshOf(local);
    expect(a04StorageCracks(port, mesh)).toEqual({ tJunctions: 1, storageCracks: 0 });
    // A mapped mesh that moves the T-vertex off its edge is a storage crack.
    const moved = meshOf(
      local.map((tri) =>
        tri.map(([x, y]) => (y === ym ? [phi(x, y)[0] + 2 ** -10, phi(x, y)[1]] : phi(x, y))),
      ),
    );
    expect(a04StorageCracks(port, moved)).toEqual({ tJunctions: 1, storageCracks: 1 });
  });
  it('E3-D11: without splitting, the shared side becomes a spurious boundary and B_M > 0', () => {
    const m = a04Measure(kase, mesh, { hooks: { splitAtTVertices: false }, separateTerms: true });
    expect(m.bM!.lo).toBeGreaterThan(0.25);
    expect(m.status).toBe('fail');
  });
});

// =============================================================================================
// Obligation (f): overlay faces for G (E3-PC4, E3-PC5, E3-D13), and E3-D1, E3-D3

/** Exact-area check of a triangle list against an expected area (twice the area, integers). */
function twiceArea(mesh: A04Mesh): number {
  const p = Array.from(mesh.positions) as number[];
  const ix = Array.from(mesh.indices);
  let total = 0;
  for (let k = 0; k < ix.length; k += 3) {
    const [a, b, c] = [ix[k]!, ix[k + 1]!, ix[k + 2]!];
    total += Math.abs(
      (p[2 * b]! - p[2 * a]!) * (p[2 * c + 1]! - p[2 * a + 1]!) -
        (p[2 * c]! - p[2 * a]!) * (p[2 * b + 1]! - p[2 * a + 1]!),
    );
  }
  return total;
}

describe('obligation (f): every overlay face is classified for G', () => {
  it('E3-PC4: a dropped interior triangle fails with G = 8 at the closed form; E3-D1 is caught', () => {
    const square = makeCase({ ...polygon(rect(0, 0, 16, 16)), paint: fill(), c: ORIGIN });
    const A: [number, number] = [0, 0];
    const B: [number, number] = [16, 0];
    const C: [number, number] = [16, 16];
    const D: [number, number] = [0, 16];
    const P: [number, number] = [6, 6];
    const Q: [number, number] = [10, 6];
    const S: [number, number] = [8, 10];
    const tris = [
      [A, B, Q],
      [A, Q, P],
      [B, C, Q],
      [Q, C, S],
      [C, D, S],
      [D, A, P],
      [D, P, S],
    ].map((t) => shift(t));
    const mesh = meshOf(tris);
    expect(twiceArea(mesh)).toBe(2 * (256 - 8));
    const m = a04Measure(square, mesh, { separateTerms: true });
    expect(m.status).toBe('fail');
    expect(contains(m.g!, 8)).toBe(true);
    expect(m.bM!.hi).toBeLessThan(8);
    expect(contains(m.e!, 8)).toBe(true);
    const d1 = a04Measure(square, mesh, {
      separateTerms: true,
      hooks: {
        combine: ({ bR, bM }) => ({ lo: Math.max(bR.lo, bM.lo), hi: Math.max(bR.hi, bM.hi) }),
      },
    });
    expect(contains(d1.e!, 8)).toBe(false);
  });
  it('E3-PC5: the star under the wrong rule fails on G; E3-D1 and E3-D3 are caught', () => {
    const star = makeCase({ ...polygon(PENTAGRAM), paint: fill('nonzero'), c: ORIGIN });
    // The evenodd mesh: the five tips without the inner pentagon, at exact rational vertices.
    const v = PENTAGRAM;
    const inner = [0, 1, 2, 3, 4].map((i) =>
      intersect(v[i]!, v[(i + 1) % 5]!, v[(i + 2) % 5]!, v[(i + 3) % 5]!),
    );
    // Inner vertex inner[i] = edge i ∩ edge i+2; the crossings on edge i are inner[i] and
    // inner[i+3]. Tip v[i+1] is cut off by the crossing on edge i nearest to it and the crossing
    // on edge i+1 nearest to it.
    const approx = (p: [R, R]): [number, number] => [
      Number(p[0].num) / Number(p[0].den),
      Number(p[1].num) / Number(p[1].den),
    ];
    const tips: (readonly [A04Scalar, A04Scalar])[][] = [];
    const segs: [[number, number], [number, number]][] = [];
    for (let i = 0; i < 5; i += 1) {
      const tip = v[(i + 1) % 5]!;
      const nearest = (a: number, b: number) => {
        const da = Math.hypot(approx(inner[a]!)[0] - tip[0], approx(inner[a]!)[1] - tip[1]);
        const db = Math.hypot(approx(inner[b]!)[0] - tip[0], approx(inner[b]!)[1] - tip[1]);
        return da < db ? inner[a]! : inner[b]!;
      };
      const p = nearest(i, (i + 3) % 5);
      const q = nearest((i + 1) % 5, (i + 4) % 5);
      tips.push([shift([tip])[0]!, ratShift(p), ratShift(q)]);
      segs.push([tip, approx(p)], [tip, approx(q)]);
    }
    const mesh = meshOf(tips);
    const m = a04Measure(star, mesh, { separateTerms: true });
    expect(m.status).toBe('fail');
    // Independent estimate of G: grid samples of the inner pentagon against the outline.
    // The inner pentagon is the intersection of the star edges' half-planes holding (0, 0).
    const inPentagon = (x: number, y: number) =>
      [0, 1, 2, 3, 4].every((i) => {
        const [ax, ay] = v[i]!;
        const [bx, by] = v[(i + 1) % 5]!;
        const side = (px: number, py: number) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        return side(x, y) * side(0, 0) > 0;
      });
    const segDist = (x: number, y: number, [p, q]: [[number, number], [number, number]]) => {
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (y - p[1]) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(x - p[0] - t * dx, y - p[1] - t * dy);
    };
    let best = 0;
    const h = 0.01;
    for (let x = -5; x <= 5; x += h)
      for (let y = -5; y <= 5; y += h)
        if (inPentagon(x, y)) best = Math.max(best, Math.min(...segs.map((s) => segDist(x, y, s))));
    expect(m.g!.lo).toBeLessThanOrEqual(best + h);
    expect(m.g!.hi).toBeGreaterThanOrEqual(best);
    expect(m.g!.lo).toBeGreaterThan(m.bM!.hi);
    const d1 = a04Measure(star, mesh, {
      separateTerms: true,
      hooks: {
        combine: ({ bR, bM }) => ({ lo: Math.max(bR.lo, bM.lo), hi: Math.max(bR.hi, bM.hi) }),
      },
    });
    expect(d1.e!.hi).toBeLessThan(m.g!.lo);
    // E3-D3: membership under the wrong rule flips the pentagon.
    expect(a04Contains(star, [100, 100])).toBe(true);
    const wrong: A04Hooks = { fillRule: (rule, w) => (rule === 'nonzero' ? w % 2 !== 0 : w !== 0) };
    expect(a04ContainsWith(star, [100, 100], wrong)).toBe(false);
    const evenodd = makeCase({ ...polygon(PENTAGRAM), paint: fill('evenodd'), c: ORIGIN });
    expect(a04Contains(evenodd, [100, 100])).toBe(false);
    expect(a04ContainsWith(evenodd, [100, 100], wrong)).toBe(true);
    const md3 = a04Measure(star, mesh, { hooks: wrong });
    expect(md3.status).toBe('pass');
  });
  it('E3-D13: an annular face of disagreement has G = 4 − 2√2 (closed form); skipping faces is caught', () => {
    const x09 = makeCase({
      ...polygons([rect(-8, -8, 8, 8), [...rect(-4, -4, 4, 4)].reverse(), rect(-2, -2, 2, 2)]),
      paint: fill(),
      c: ORIGIN,
    });
    // M is R plus H \ I: the whole outer square. The disagreeing face is the annulus H \ I
    // (|x|∞ in [2, 4]). Its farthest point from ∂H ∪ ∂I is on the diagonal, where 4 − t equals
    // √2·(t − 2): G = 4 − 2√2. B_R = 6, at ∂I.
    const mesh = fanMesh(shift(rect(-8, -8, 8, 8)));
    const m = a04Measure(x09, mesh, { separateTerms: true });
    expect(contains(m.g!, 4 - 2 * Math.SQRT2, 1e-12)).toBe(true);
    expect(m.g!.hi - m.g!.lo).toBeLessThanOrEqual(A04_ORACLE_PARAMETERS.resolution);
    expect(contains(m.bR!, 6)).toBe(true);
    expect(m.bM!.hi).toBeLessThanOrEqual(A04_ORACLE_PARAMETERS.resolution);
    const d13 = a04Measure(x09, mesh, {
      separateTerms: true,
      hooks: { gLeaf: (leaf) => !leaf.boundaryFree },
    });
    expect(contains(d13.g!, 4 - 2 * Math.SQRT2, 1e-12)).toBe(false);
  });
});

// =============================================================================================
// E3-PC10: closed-form controls, and E3-D6

/** The exact disk of radius 8 at the origin: an ST-S10 round point cap of width 16. */
const DISK = makeCase({ verbs: 'ML', points: [0, 0, 0, 0], paint: stroke(16, 'round'), c: ORIGIN });

/**
 * The inscribed n-gon as a fan from the center, each chord split at 0.3 of its length so that no
 * dyadic cell center falls on a chord midpoint (where the sagitta is attained).
 */
function ngon(n: number): { mesh: A04Mesh; known: number } {
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k += 1) {
    const t = (2 * Math.PI * k) / n;
    pts.push([
      n === 4 ? [8, 0, -8, 0][k]! : 8 * Math.cos(t),
      n === 4 ? [0, 8, 0, -8][k]! : 8 * Math.sin(t),
    ]);
  }
  let known = 0;
  const ring: [number, number][] = [];
  for (let k = 0; k < n; k += 1) {
    const [ax, ay] = pts[k]!;
    const [bx, by] = pts[(k + 1) % n]!;
    const h = Math.abs(ax * by - ay * bx) / Math.hypot(bx - ax, by - ay);
    known = Math.max(known, 8 - h);
    ring.push([ax, ay], [ax + 0.3 * (bx - ax), ay + 0.3 * (by - ay)]);
  }
  const tris: (readonly [number, number])[][] = [];
  for (let k = 0; k < ring.length; k += 1)
    tris.push(shift([[0, 0], ring[k]!, ring[(k + 1) % ring.length]!]));
  return { mesh: meshOf(tris), known };
}

describe('E3-PC10: closed-form controls', () => {
  it('the snapped rectangle has E = 0', () => {
    const r = rect(0, 0, 16, 8);
    const m = a04Measure(makeCase({ ...polygon(r), paint: fill(), c: ORIGIN }), fanMesh(shift(r)), {
      separateTerms: true,
    });
    expect(m.status).toBe('pass');
    expect(m.e!.lo).toBe(0);
    expect(m.e!.hi).toBeLessThanOrEqual(A04_ORACLE_PARAMETERS.resolution);
  });
  it('a dyadic polygon translated by (0, 2^-4) has E = 2^-4', () => {
    const x08: [number, number][] = [
      [0, 0],
      [16, 0],
      [12, 8],
      [4, 8],
    ];
    const kase = makeCase({ ...polygon(x08), paint: fill(), c: ORIGIN });
    const m = a04Measure(kase, fanMesh(shift(x08).map(([x, y]) => [x, y + 2 ** -4])), {
      separateTerms: true,
    });
    expect(contains(m.e!, 2 ** -4)).toBe(true);
    expect(m.e!.hi - m.e!.lo).toBeLessThanOrEqual(A04_ORACLE_PARAMETERS.resolution);
  });
  it('inscribed n-gons against the exact circle: E = the largest sagitta', () => {
    for (const n of [4, 16]) {
      const { mesh, known } = ngon(n);
      const m = a04Measure(DISK, mesh, { separateTerms: true, resolution: 2 ** -6 });
      expect(contains(m.e!, known, 1e-12)).toBe(true);
      // B_M is attained at the chord midpoints, which no dyadic cell center reaches.
      expect(contains(m.bM!, known, 1e-12)).toBe(true);
    }
  });
  it('E3-D6: an upper bound taken at cell centers only misses the n-gon value', () => {
    // R is the 16-gon, M the 8-gon on every other vertex, each chord split at 0.3 so that no
    // dyadic cell center falls on a chord midpoint. B_M is attained at the chord midpoints, at
    // the closed-form distance from a midpoint to the 16-gon edges on either side of it.
    const v: [number, number][] = [];
    for (let k = 0; k < 16; k += 1)
      v.push([8 * Math.cos((Math.PI * k) / 8), 8 * Math.sin((Math.PI * k) / 8)]);
    const kase = makeCase({ ...polygon(v), paint: fill(), c: ORIGIN });
    const segDist = (p: [number, number], a: [number, number], b: [number, number]) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const t = Math.max(
        0,
        Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)),
      );
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
    };
    let known = 0;
    const ring: [number, number][] = [];
    for (let k = 0; k < 16; k += 2) {
      const a = v[k]!;
      const b = v[(k + 2) % 16]!;
      const m: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      known = Math.max(known, Math.min(segDist(m, a, v[k + 1]!), segDist(m, v[k + 1]!, b)));
      ring.push(a, [a[0] + 0.3 * (b[0] - a[0]), a[1] + 0.3 * (b[1] - a[1])]);
    }
    const tris: (readonly [number, number])[][] = [];
    for (let k = 0; k < ring.length; k += 1)
      tris.push(shift([[0, 0], ring[k]!, ring[(k + 1) % ring.length]!]));
    const mesh = meshOf(tris);
    const ok = a04Measure(kase, mesh, { separateTerms: true });
    expect(contains(ok.bM!, known, 1e-12)).toBe(true);
    const d6 = a04Measure(kase, mesh, {
      separateTerms: true,
      hooks: { cellSupUpper: (_g, center, dist) => dist(center) },
    });
    expect(contains(d6.bM!, known, 1e-12)).toBe(false);
  });
});

// =============================================================================================
// Oracle-level controls of section 8.1 that need no harness (E3-PC1, PC2, PC3, PC11, PC14)

describe('oracle-level controls on synthetic meshes', () => {
  const base = rect(0, 0, 16, 8);
  const kase = makeCase({ ...polygon(base), paint: fill(), c: ORIGIN });
  it('E3-PC1 and E3-PC2: a boundary vertex moved 0.26 px fails, 0.24 px passes at its value', () => {
    for (const [offset, expected] of [
      [0.26, 'fail'],
      [0.24, 'pass'],
    ] as const) {
      const pts = shift(base);
      pts[1] = [116 + offset, 100];
      const realized = pts[1][0] - 116;
      const m = a04Measure(kase, fanMesh(pts), { separateTerms: true });
      expect(m.status).toBe(expected);
      expect(contains(m.e!, realized)).toBe(true);
      expect(Math.abs(realized - offset)).toBeLessThan(1e-14);
    }
  });
  it('E3-PC3: a coarse chord polygon of the exact circle fails with the sagitta inside [E_lo, E_hi]', () => {
    const big = makeCase({
      verbs: 'ML',
      points: [0, 0, 0, 0],
      paint: stroke(32, 'round'),
      c: [-150, -150],
    });
    const pts: [number, number][] = [];
    for (let k = 0; k < 14; k += 1) {
      const t = (2 * Math.PI * k) / 14;
      pts.push([150 + 16 * Math.cos(t), 150 + 16 * Math.sin(t)]);
    }
    let known = 0;
    for (let k = 0; k < 14; k += 1) {
      const [ax, ay] = [pts[k]![0] - 150, pts[k]![1] - 150];
      const [bx, by] = [pts[(k + 1) % 14]![0] - 150, pts[(k + 1) % 14]![1] - 150];
      known = Math.max(known, 16 - Math.abs(ax * by - ay * bx) / Math.hypot(bx - ax, by - ay));
    }
    expect(known).toBeGreaterThan(0.3);
    expect(known).toBeLessThan(1);
    const m = a04Measure(big, fanMesh(pts), { separateTerms: true, resolution: 2 ** -6 });
    expect(m.status).toBe('fail');
    expect(contains(m.e!, known, 1e-12)).toBe(true);
  });
  it('E3-PC11 and E3-D2: an empty result for a non-empty case fails with B_R = +∞', () => {
    const m = a04Measure(kase, EMPTY_MESH, { separateTerms: true });
    expect(m.status).toBe('fail');
    expect(m.bR!.lo).toBe(Infinity);
    const d2 = a04Measure(kase, EMPTY_MESH, {
      separateTerms: true,
      hooks: { combine: ({ bM, g }) => ({ lo: Math.max(bM.lo, g.lo), hi: Math.max(bM.hi, g.hi) }) },
    });
    expect(d2.e!.hi).toBeLessThan(Infinity);
    // E3-D2 on E3-PC6: without B_R, the closed hole passes.
    const ring = makeCase({
      ...polygons([rect(-8, -8, 8, 8), [...rect(-0.2, -4, 0.2, 4)].reverse()]),
      paint: fill(),
      c: ORIGIN,
    });
    const d2ring = a04Measure(ring, fanMesh(shift(rect(-8, -8, 8, 8))), {
      separateTerms: true,
      hooks: { combine: ({ bM, g }) => ({ lo: Math.max(bM.lo, g.lo), hi: Math.max(bM.hi, g.hi) }) },
    });
    expect(d2ring.status).toBe('pass');
  });
  it('E3-PC14: a missing mesh over a shape that covers Ω fails at the window point', () => {
    const cover = makeCase({ ...polygon(rect(-1000, -1000, 2000, 2000)), paint: fill() });
    const m = a04Measure(cover, EMPTY_MESH);
    expect(m.windowPoint).toEqual({ r: true, m: false });
    expect(m.status).toBe('fail');
    // Negative control: a shape away from Ω with no mesh is window-empty and agrees.
    const away = makeCase({ ...polygon(rect(5000, 5000, 5016, 5008)), paint: fill() });
    const w = a04Measure(away, EMPTY_MESH);
    expect(w.status).toBe('window-empty');
    expect(w.windowPoint).toEqual({ r: false, m: false });
  });
});

// =============================================================================================
// E3-D5: the cusp disk omitted, on a synthetic ST-F16 mesh built from the closed-form outline

/** Ear-clipping triangulation of a simple polygon (float coordinates). */
function earClip(poly: readonly [number, number][]): [number, number][][] {
  const pts = [...poly];
  let area = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % pts.length]!;
    area += ax * by - ay * bx;
  }
  if (area < 0) pts.reverse();
  const idx = pts.map((_, i) => i);
  const out: [number, number][][] = [];
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  let guard = 0;
  while (idx.length > 3 && guard < 1e7) {
    guard += 1;
    let clipped = false;
    for (let k = 0; k < idx.length; k += 1) {
      const a = pts[idx[(k + idx.length - 1) % idx.length]!]!;
      const b = pts[idx[k]!]!;
      const c = pts[idx[(k + 1) % idx.length]!]!;
      if (cross(a, b, c) <= 0) continue;
      let ear = true;
      for (const j of idx) {
        const p = pts[j]!;
        if (p === a || p === b || p === c) continue;
        if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('ear clipping failed');
  }
  out.push(idx.map((j) => pts[j]!));
  return out;
}

describe('E3-D5: the cusp disk omitted in the oracle', () => {
  it('a synthetic ST-F16 sweep mesh without the disk: the oracle fails, the mutant B_M falls below 0.25 (undecided under onlyTerms)', () => {
    // ST-F16 is (4s³, −3s²) + (0.5, 0.75), s ∈ [−1/2, 1/2], r = 1/16, n̂ = (1, 2s)/√(1 + 4s²).
    // Its curvature radius is ρ(s) = 3|s|(1 + 4s²)^(3/2); the sweep's outline is: the outer
    // offsets for |s| ≥ s_r (ρ = r), the evolute C ± ρn̂ for |s| ≤ s_r through the cusp, the butt
    // ends, and the inner offsets down to their crossing on x = 0.5.
    const r = 1 / 16;
    const C = (s: number): [number, number] => [0.5 + 4 * s ** 3, 0.75 - 3 * s * s];
    const N = (s: number): [number, number] => {
      const l = Math.sqrt(1 + 4 * s * s);
      return [1 / l, (2 * s) / l];
    };
    const rho = (s: number) => 3 * Math.abs(s) * (1 + 4 * s * s) ** 1.5;
    const solve = (f: (s: number) => number, lo0: number, hi0: number) => {
      let lo = lo0;
      let hi = hi0;
      for (let k = 0; k < 200; k += 1) {
        const m = (lo + hi) / 2;
        if (f(lo) * f(m) <= 0) hi = m;
        else lo = m;
      }
      return (lo + hi) / 2;
    };
    const sr = solve((s) => rho(s) - r, 0, 0.5);
    const sm = solve((s) => C(s)[0] - N(s)[0] * r - 0.5, 0.01, 0.5);
    const off = (s: number, k: number): [number, number] => [
      C(s)[0] + k * N(s)[0],
      C(s)[1] + k * N(s)[1],
    ];
    const span = (a: number, b: number, n: number, f: (s: number) => [number, number]) =>
      Array.from({ length: n }, (_, i) => f(a + ((b - a) * i) / n));
    const outline: [number, number][] = [
      ...span(-0.5, -sr, 60, (s) => off(s, -r)),
      ...span(-sr, 0, 30, (s) => off(s, -rho(s))),
      ...span(0, sr, 30, (s) => off(s, rho(s))),
      ...span(sr, 0.5, 60, (s) => off(s, r)),
      off(0.5, r),
      ...span(0.5, sm, 50, (s) => off(s, -r)),
      ...span(-sm, -0.5, 50, (s) => off(s, r)),
      off(-0.5, r),
    ];
    const k = 16; // zoom: r is 1 px
    const phys = outline.map(([x, y]): [number, number] => [k * x + 100, k * y + 100]);
    const mesh = meshOf(earClip(phys));
    const f16 = makeCase({
      verbs: 'MC',
      points: [0, 0, 1, 1, 0, 1, 1, 0],
      paint: stroke(0.125),
      zoom: k,
      c: [-100 / k, -100 / k],
    });
    // The oracle fails: ∂M runs inside the cusp disk, about r = 1 px from its circle.
    const m = a04Measure(f16, mesh);
    expect(m.status).toBe('fail');
    expect(m.e!.lo).toBeGreaterThan(0.25);
    // Without the disk, B_M (above 0.95 px in the oracle) falls below 0.25 px, so E3-D5 is caught.
    // Coarse and B_M only, for CI time: B_M is the term the disk decides here, and onlyTerms
    // leaves the mutant's status undecided rather than pass.
    const mutant = a04Measure(f16, mesh, {
      hooks: { dropStrokePiece: (role) => role === 'cusp-disk' },
      resolution: 2 ** -4,
      separateTerms: true,
      onlyTerms: ['bM'],
    });
    expect(m.bM!.lo).toBeGreaterThan(0.95);
    expect(mutant.bM!.hi).toBeLessThan(0.25);
    expect(mutant.status).toBe('undecided');
  });
});

// =============================================================================================
// E3-D8: the ideal map with fround(z)

describe('E3-D8: the ideal map with fround(z) instead of the binary64 z', () => {
  it('is caught on a z = 0.01 row of 8,192 px extent at resolution 2^-16 px', () => {
    const z = 0.01;
    const d = 3;
    const X = 273066; // 8,192 px / (d·z), local units
    const c: [number, number] = [-63333, -10000];
    const kase = makeCase({ ...polygon(rect(0, 0, X, X)), paint: fill(), zoom: z, dpr: d, c });
    // M* = Φ(rectangle) exactly, with the binary64 z, as exact rationals.
    const s = BigInt(Math.round(z * 2 ** 59)); // z = s·2^-59 exactly
    expect(Number(s) * 2 ** -59).toBe(z);
    const exact = (v: number, cv: number): A04Scalar => ({
      num: BigInt(d) * s * (BigInt(v) - BigInt(cv)),
      den: 2n ** 59n,
    });
    const corners = rect(0, 0, X, X).map(([x, y]) => [exact(x, c[0]), exact(y, c[1])] as const);
    const mesh = fanMesh(corners);
    const opts = { resolution: 2 ** -16 } as const;
    const ok = a04Measure(kase, mesh, opts);
    expect(ok.status).toBe('pass');
    expect(ok.e!.hi).toBeLessThanOrEqual(2 ** -16);
    const bad = a04Measure(kase, mesh, {
      ...opts,
      failAbove: 2 ** -15,
      hooks: { idealZoom: (zoom) => Math.fround(zoom) },
    });
    expect(bad.e!.lo).toBeGreaterThan(2 ** -15);
  });
});

// =============================================================================================
// The oracle-only freeze check on a small sample of the frozen corpus

describe('the oracle-only freeze check (section 5.5) on a corpus sample', () => {
  it('certifies one T0, z = 1, d = 1 case of each named stratum', () => {
    const wanted = new Set([
      'C1/s04-I/T0/z1-d1/center/k0',
      'C3/c11/T0/z1-d1/center/k0',
      'C3/c06/T0/z1-d1/center/k0',
      'C4/n12/T0/z1-d1/center/k0',
      'C5/l04/T0/z1-d1/center/k0',
      'C9/k07/T0/z1-d1/center/k0',
      'C9/k19/T0/z1-d1/center/k0',
      'C10/x01/T0/z1-d1/center/k0',
      'C11/f05/T0/z1-d1/center/k0',
      'C12/j01/T2/z1-d1/center/k0',
    ]);
    const results = [];
    for (const kase of iterateA04Corpus()) {
      if (!wanted.has(kase.id as string)) continue;
      results.push(a04FreezeCheck(kase));
      if (results.length === wanted.size) break;
    }
    expect(results.map((r) => r.id).sort()).toEqual([...wanted].sort());
    for (const r of results)
      expect([r.id, r.status, r.detail]).toEqual([
        r.id,
        r.id.startsWith('C10/x01') ? 'not-drawable' : 'ok',
        r.id.startsWith('C10/x01') ? 'det L = 0' : null,
      ]);
  });
});
