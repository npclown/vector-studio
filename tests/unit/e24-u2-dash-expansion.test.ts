import type { SceneDash, ScenePathVerb, StrokeMeshRequest } from '@vector-studio/contracts';
import { PATH_VERB_CODES } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import type { PathMeshNotice } from '../../packages/renderer-core/src/path-mesh-pipeline.js';
import { DASH_LIMIT, expandDash } from '../../packages/renderer-core/src/stroke-dash.js';
import { createCountingPort, target } from '../support/v3a-path-harness.js';
import {
  RED,
  ScriptedStrokeMeshPort,
  createStrokeHarness,
  pathStroke,
  strokedNode,
} from '../support/st-u6-stroke-harness.js';

// E24 contract (docs/plans/d9-e24-dash-contract.md), unit U2: E24-A02 (dash geometry of
// stroke-dash.ts under E24-K1 to K7), E24-A03 (the dash-limit state failure, O1), the unit part
// of E24-A04 (invalidation by port-call and dash-expansion counters; GPU geometry builds are
// U3's) and the unit part of E24-A06 (undashed stroke requests unchanged).

type Path = Readonly<{ verbs: readonly ScenePathVerb[]; points: readonly number[] }>;

function dash(pattern: readonly number[], phase = 0): SceneDash {
  return { pattern, phase };
}

function expand(path: Path, value: SceneDash, limit?: number) {
  return expandDash(path.verbs, path.points, value, limit);
}

function ok(path: Path, value: SceneDash): Path {
  const result = expand(path, value);
  if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
  return result.path;
}

/** The emitted subpaths, as their verbs and points. */
function subpaths(path: Path): Path[] {
  const out: Array<{ verbs: ScenePathVerb[]; points: number[] }> = [];
  let p = 0;
  for (const verb of path.verbs) {
    if (verb === 'move') out.push({ verbs: [], points: [] });
    const current = out[out.length - 1]!;
    current.verbs.push(verb);
    const count = verb === 'move' || verb === 'line' ? 2 : verb === 'cubic' ? 6 : 0;
    current.points.push(...path.points.slice(p, p + count));
    p += count;
  }
  return out;
}

function ends(path: Path): Array<[number, number, number, number]> {
  return subpaths(path).map(({ points }) => [
    points[0]!,
    points[1]!,
    points[points.length - 2]!,
    points[points.length - 1]!,
  ]);
}

const LINE: Path = { verbs: ['move', 'line'], points: [0, 0, 300, 0] };
// D3: L = 640, P = 60.
const RECT: Path = {
  verbs: ['move', 'line', 'line', 'line', 'close'],
  points: [0, 0, 200, 0, 200, 120, 0, 120],
};

// ---------------------------------------------------------------------------------------------
// A compensated (double-double) reference for cubic arc length. The sum of the quadrature terms
// is carried as a binary64 pair (Knuth's two-sum), over 2,048 uniform cells per piece with an
// 8-point Gauss–Legendre rule; pieces break at known cusps, so every cell's integrand is smooth.
// ---------------------------------------------------------------------------------------------

const GL_X = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498,
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363,
];
const GL_W = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362, 0.362683783378362,
  0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
];

type Cubic = readonly [number, number, number, number, number, number, number, number];

function speed(c: Cubic, t: number): number {
  const u = 1 - t;
  const dx = 3 * (u * u * (c[2] - c[0]) + 2 * u * t * (c[4] - c[2]) + t * t * (c[6] - c[4]));
  const dy = 3 * (u * u * (c[3] - c[1]) + 2 * u * t * (c[5] - c[3]) + t * t * (c[7] - c[5]));
  return Math.sqrt(dx * dx + dy * dy);
}

function at(c: Cubic, t: number): [number, number] {
  const u = 1 - t;
  const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [
    b[0]! * c[0] + b[1]! * c[2] + b[2]! * c[4] + b[3]! * c[6],
    b[0]! * c[1] + b[1]! * c[3] + b[2]! * c[5] + b[3]! * c[7],
  ];
}

function referenceLength(c: Cubic, t1: number, breaks: readonly number[]): number {
  const cuts = [0, ...breaks.filter((b) => b > 0 && b < t1), t1];
  let hi = 0;
  let lo = 0;
  const add = (value: number) => {
    const s = hi + value;
    const v = s - hi;
    lo += hi - (s - v) + (value - v);
    hi = s;
  };
  for (let piece = 0; piece + 1 < cuts.length; piece += 1) {
    const a0 = cuts[piece]!;
    const h = (cuts[piece + 1]! - a0) / 2048;
    for (let cell = 0; cell < 2048; cell += 1) {
      const a = a0 + cell * h;
      for (let k = 0; k < 8; k += 1)
        add((h / 2) * GL_W[k]! * speed(c, a + (h / 2) * (GL_X[k]! + 1)));
    }
  }
  return hi + lo;
}

/** The reference point at arc length s, by bisection on the reference length. */
function referencePoint(c: Cubic, s: number, breaks: readonly number[]): [number, number] {
  let a = 0;
  let b = 1;
  for (let step = 0; step < 56; step += 1) {
    const m = (a + b) / 2;
    if (referenceLength(c, m, breaks) < s) a = m;
    else b = m;
  }
  return at(c, (a + b) / 2);
}

/** Checks every dash end of one open cubic against the reference (E24-K7's cubic bound). */
function checkCubic(c: Cubic, value: SceneDash, breaks: readonly number[] = []) {
  const length = referenceLength(c, 1, breaks);
  const out = ok({ verbs: ['move', 'cubic'], points: c }, value);
  const pattern =
    value.pattern.length % 2 === 1 ? [...value.pattern, ...value.pattern] : value.pattern;
  const period = pattern.reduce((sum, entry) => sum + entry, 0);
  // Expected intervals: dash k of period m is [mP − φ + a_k, mP − φ + a_k + d_k] ∩ [0, L], with
  // touching intervals merged (the fixtures have no zero gaps and no closed subpath).
  const phase = ((value.phase % period) + period) % period;
  const expected: Array<[number, number]> = [];
  for (let m = -1; m * period - phase <= length; m += 1) {
    let offset = 0;
    for (let k = 0; k < pattern.length; k += 2) {
      const lo = m * period - phase + offset;
      const hi = lo + pattern[k]!;
      offset += pattern[k]! + pattern[k + 1]!;
      if (hi < 0 || lo > length) continue;
      const last = expected[expected.length - 1];
      if (last !== undefined && Math.max(lo, 0) <= last[1]) last[1] = Math.min(hi, length);
      else expected.push([Math.max(lo, 0), Math.min(hi, length)]);
    }
  }
  const actual = ends(out);
  expect(actual.length).toBe(expected.length);
  const bound = 2 ** -24 * length + 2 ** -40 * length;
  expected.forEach(([s0, s1], index) => {
    const [x0, y0, x1, y1] = actual[index]!;
    const p0 = referencePoint(c, s0, breaks);
    const p1 = referencePoint(c, s1, breaks);
    expect(Math.hypot(x0 - p0[0], y0 - p0[1]), `dash ${index} start`).toBeLessThanOrEqual(bound);
    expect(Math.hypot(x1 - p1[0], y1 - p1[1]), `dash ${index} end`).toBeLessThanOrEqual(bound);
  });
  return out;
}

/** A cubic whose derivative is (t − c)(u + v t): a cusp at t = c (up to rounding). */
function cuspCubic(c: number, u: readonly [number, number], v: readonly [number, number]): Cubic {
  const q0 = [-c * u[0], -c * u[1]];
  const q1 = [q0[0]! + (u[0] - c * v[0]) / 2, q0[1]! + (u[1] - c * v[1]) / 2];
  const q2 = [(1 - c) * (u[0] + v[0]), (1 - c) * (u[1] + v[1])];
  const p1 = [q0[0]! / 3, q0[1]! / 3];
  const p2 = [p1[0]! + q1[0]! / 3, p1[1]! + q1[1]! / 3];
  const p3 = [p2[0]! + q2[0]! / 3, p2[1]! + q2[1]! / 3];
  return [0, 0, p1[0]!, p1[1]!, p2[0]!, p2[1]!, p3[0]!, p3[1]!];
}

describe('E24-A02 dash geometry (stroke-dash.ts)', () => {
  it('K1-K3 on a line: closed intervals, a zero-length dash at s = L, bounds within 2^-40 L', () => {
    const out = ok(LINE, dash([30, 20]));
    expect(out.verbs).toEqual(Array(7).fill(['move', 'line']).flat());
    const expected = [0, 30, 50, 80, 100, 130, 150, 180, 200, 230, 250, 280, 300, 300];
    expect(
      ends(out)
        .map(([x0, , x1]) => [x0, x1])
        .flat(),
    ).toHaveLength(expected.length);
    ends(out).forEach(([x0, y0, x1, y1], index) => {
      expect(Math.abs(x0 - expected[2 * index]!)).toBeLessThanOrEqual(2 ** -40 * 300);
      expect(Math.abs(x1 - expected[2 * index + 1]!)).toBeLessThanOrEqual(2 ** -40 * 300);
      expect([y0, y1]).toEqual([0, 0]);
    });
    // The source endpoints are copied exactly.
    expect(out.points.slice(0, 2)).toEqual([0, 0]);
    expect(out.points.slice(-2)).toEqual([300, 0]);
  });

  it('K1: an odd pattern is doubled', () => {
    expect(ok(LINE, dash([24, 12, 6], 5))).toEqual(ok(LINE, dash([24, 12, 6, 24, 12, 6], 5)));
    expect(ok(LINE, dash([40], 0))).toEqual(ok(LINE, dash([40, 40], 0)));
  });

  it('K1: phase reduction (negative, beyond a period, 2^40, rounding to P)', () => {
    expect(ok(LINE, dash([30, 20], -10))).toEqual(ok(LINE, dash([30, 20], 40)));
    expect(ok(LINE, dash([30, 20], 130))).toEqual(ok(LINE, dash([30, 20], 30)));
    // 2^40 = 21,990,232,555 · 50 + 26, exactly.
    expect(ok(LINE, dash([30, 20], 2 ** 40))).toEqual(ok(LINE, dash([30, 20], 26)));
    // -1e-17 % 50 + 50 rounds to 50, so φ is 0.
    expect(ok(LINE, dash([30, 20], -1e-17))).toEqual(ok(LINE, dash([30, 20], 0)));
  });

  it('K4: one dash through the seam corner (D3), with a join and no caps there', () => {
    const out = ok(RECT, dash([40, 20], 25));
    const parts = subpaths(out);
    const last = parts[parts.length - 1]!;
    // u(s) = (s + 25) mod 60 is on for s in [635, 640] and [0, 15]: one 20-unit open subpath from
    // (0, 5) through the corner (0, 0) to (15, 0).
    expect(last.verbs).toEqual(['move', 'line', 'line']);
    expect(last.points).toEqual([0, 5, 0, 0, 15, 0]);
    // The first dash of the result is the next one, at s = 35, not the one at s = 0.
    expect(parts[0]!.points.slice(0, 2)).toEqual([35, 0]);
    expect(out.verbs.includes('close')).toBe(false);
  });

  it('K4: no seam on an open subpath, and a dash ending at L while a gap starts at 0', () => {
    const open: Path = {
      verbs: ['move', 'line', 'line', 'line', 'line'],
      points: [...RECT.points, 0, 0],
    };
    const parts = subpaths(ok(open, dash([40, 20], 25)));
    expect(parts[0]!.points).toEqual([0, 0, 15, 0]);
    expect(parts[parts.length - 1]!.points).toEqual([0, 5, 0, 0]);
    // A closed 10 × 10 square, L = 40: u(s) = (s + 30) mod 50 is on for s in [20, 40] only.
    const square: Path = {
      verbs: ['move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 10, 0, 10, 10, 0, 10],
    };
    const single = ok(square, dash([20, 30], 30));
    expect(single).toEqual({ verbs: ['move', 'line', 'line'], points: [10, 10, 0, 10, 0, 0] });
  });

  it('K3/K4: a fully on closed subpath is emitted closed and unchanged', () => {
    const square: Path = {
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 10, 0, 10, 10],
    };
    expect(ok(square, dash([100]))).toEqual(square);
    // L = 20 + 10√2 ≈ 34.14: a first dash of 35 covers it.
    expect(ok(square, dash([35, 1], 0))).toEqual(square);
  });

  it('K5: zero-length dashes, at s = 0, inside and at s = L', () => {
    const line: Path = { verbs: ['move', 'line'], points: [0, 0, 10, 0] };
    expect(ok(line, dash([0, 5]))).toEqual({
      verbs: ['move', 'line', 'move', 'line', 'move', 'line'],
      points: [0, 0, 0, 0, 5, 0, 5, 0, 10, 0, 10, 0],
    });
  });

  it('K5: a zero-length subpath passes when u(0) is on and is dropped otherwise', () => {
    const point: Path = { verbs: ['move', 'line'], points: [5, 5, 5, 5] };
    expect(ok(point, dash([10, 5], 0))).toEqual(point);
    expect(ok(point, dash([10, 5], 10))).toEqual(point);
    expect(ok(point, dash([10, 5], 12))).toEqual({ verbs: [], points: [] });
  });

  it('K2: the pattern restarts at every subpath', () => {
    const two: Path = {
      verbs: ['move', 'line', 'move', 'line'],
      points: [0, 0, 70, 0, 0, 10, 70, 10],
    };
    expect(subpaths(ok(two, dash([30, 20], 10))).map((part) => part.points)).toEqual([
      [0, 0, 20, 0],
      [40, 0, 70, 0],
      [0, 10, 20, 10],
      [40, 10, 70, 10],
    ]);
  });

  it('K2: zero-length segments are removed before measuring (ST-S1)', () => {
    const withRepeat: Path = { verbs: ['move', 'line', 'line'], points: [0, 0, 0, 0, 100, 0] };
    const plain: Path = { verbs: ['move', 'line'], points: [0, 0, 100, 0] };
    expect(ok(withRepeat, dash([30, 20]))).toEqual(ok(plain, dash([30, 20])));
  });

  it('K7: a smooth cubic, a cusp, a near-cusp and a depth-limit cusp meet the cubic bound', () => {
    checkCubic([0, 0, 100, 100, 200, -100, 300, 0], dash([30, 20]));
    // x′ = 900 (1 − 2t)², y = 0: a cusp in speed at t = 1/2, where a dash starts.
    checkCubic([0, 0, 300, 0, 0, 0, 300, 0], dash([100, 50]), [0.5]);
    // A real cusp (B′ = 0, the direction reverses) at the dyadic t = 3/8.
    checkCubic(cuspCubic(0.375, [400, 100], [-200, 600]), dash([7, 3]), [0.375]);
    // A near-cusp: the same curve with one control point moved by 2^-20.
    const near = [...cuspCubic(0.375, [400, 100], [-200, 600])] as number[];
    near[4] = near[4]! + 2 ** -20;
    checkCubic(near as unknown as Cubic, dash([7, 3]), [0.375]);
    // A cusp at t = 0.3, not dyadic: its cell refines to depth 24.
    checkCubic(cuspCubic(0.3, [500, -150], [100, 700]), dash([11, 4, 0, 4]), [0.3]);
    // The arc-length reference is slow (about 2 s here, over 5 s on loaded CI runners).
  }, 30_000);

  it('K3: cubic dashes keep the source endpoints and split by de Casteljau', () => {
    const c: Cubic = [0, 0, 100, 100, 200, -100, 300, 0];
    const out = checkCubic(c, dash([30, 20]));
    expect(out.points.slice(0, 2)).toEqual([0, 0]);
    expect(subpaths(out).every((part) => part.verbs.join() === 'move,cubic')).toBe(true);
    // A dash past the end of the open subpath ends exactly at the source end point.
    expect(out.points.slice(-2)).toEqual([300, 0]);
  });

  it('K1/K3: zero gaps join dashes by structure, and all-zero gaps are solid', () => {
    const long: Path = { verbs: ['move', 'line'], points: [0, 0, 10000, 0] };
    // 0.1 is not dyadic: the periods' ends and starts round apart, yet the path is on throughout.
    expect(expand(long, dash([0.1, 0]))).toEqual({ status: 'ok', path: long, dashes: 1 });
    expect(expand(RECT, dash([7, 0, 3, 0], 1.5))).toEqual({ status: 'ok', path: RECT, dashes: 1 });
    // A zero gap inside a pattern with a positive gap: [3, 0, 0.1, 2] is [3.1, 2] structurally.
    expect(ends(ok(long, dash([3, 0, 0.1, 2]))).length).toBe(ends(ok(long, dash([3.1, 2]))).length);
    const joined = ends(ok(LINE, dash([0.3, 0, 0.7, 1])));
    expect(joined).toHaveLength(151);
  });

  it('K8: the work is bounded by the dash limit, even for gaps binary64 cannot resolve', () => {
    const far: Path = { verbs: ['move', 'line'], points: [0, 0, 1e9, 0] };
    const started = performance.now();
    expect(expand(far, dash([0.25, 1e-20])).status).toBe('dash-limit');
    expect(expand(far, dash([0.25, 0]))).toMatchObject({ status: 'ok', dashes: 1 });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('K3: source vertices and path ends are copied exactly at non-integer coordinates', () => {
    const polyline: Path = {
      verbs: ['move', 'line', 'line', 'line', 'line'],
      points: [
        5.970560554414988, 2.992647886276245, 5.422919988632202, 9.870918989181519,
        6.721854209899902, 5.29202938079834, 8.698935508728027, 9.153265953063965,
        0.7455968856811523, 9.973731338977814,
      ],
    };
    const fullyInside = ok(polyline, dash([1000, 1], 1000.5));
    // One dash from s = 0.5 to the end: every later vertex and the end point are the source's.
    expect(fullyInside.points.slice(2)).toEqual(polyline.points.slice(2));
    // Many short dashes: every emitted point that equals a source vertex up to 1e-9 is exact.
    const random = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 10;
    for (const seed of [1, 7, 42]) {
      const next = random(seed);
      const points = Array.from({ length: 24 }, next);
      const verbs: ScenePathVerb[] = ['move', 'line', 'cubic', 'line', 'cubic', 'line', 'line'];
      const path: Path = { verbs: [...verbs, 'close'], points: points.slice(0, 22) };
      const out = ok(path, dash([1.7, 0.3], 0.2));
      for (let i = 0; i < out.points.length; i += 2) {
        for (let j = 0; j < path.points.length; j += 2) {
          const close =
            Math.abs(out.points[i]! - path.points[j]!) < 1e-9 &&
            Math.abs(out.points[i + 1]! - path.points[j + 1]!) < 1e-9;
          if (close)
            expect([out.points[i], out.points[i + 1]]).toEqual([
              path.points[j],
              path.points[j + 1],
            ]);
        }
      }
    }
  });

  it('K7: a cubic with a non-zero phase meets the cubic bound', () => {
    checkCubic([0, 0, 100, 100, 200, -100, 300, 0], dash([30, 20], 20));
    checkCubic(cuspCubic(0.3, [500, -150], [100, 700]), dash([11, 4], -7.25), [0.3]);
  }, 30_000);

  it('K7: equal inputs give bit-identical output', () => {
    const c = [0, 0, 100, 100, 200, -100, 300, 0];
    const first = ok(
      { verbs: ['move', 'cubic', 'line', 'close'], points: [...c, 300, 80] },
      dash([13, 7], 3.5),
    );
    const second = ok(
      { verbs: ['move', 'cubic', 'line', 'close'], points: [...c, 300, 80] },
      dash([13, 7], 3.5),
    );
    expect(second.verbs).toEqual(first.verbs);
    expect(second.points.every((value, index) => Object.is(value, first.points[index]))).toBe(true);
  });
});

describe('E24-A03 dash limit (expansion)', () => {
  const long = (length: number): Path => ({ verbs: ['move', 'line'], points: [0, 0, length, 0] });

  it('4,096 dashes expand and 4,097 are dash-limit, summed over subpaths', () => {
    // [1, 1] on [0, L]: dashes start at 0, 2, ..., so floor(L / 2) + 1 of them.
    expect(expand(long(8190), dash([1, 1]))).toMatchObject({ status: 'ok', dashes: DASH_LIMIT });
    expect(expand(long(8192), dash([1, 1])).status).toBe('dash-limit');
    const halves: Path = {
      verbs: ['move', 'line', 'move', 'line'],
      points: [0, 0, 4094, 0, 0, 5, 4094, 5],
    };
    expect(expand(halves, dash([1, 1]))).toMatchObject({ status: 'ok', dashes: 4096 });
    const over: Path = {
      verbs: ['move', 'line', 'move', 'line'],
      points: [0, 0, 4094, 0, 0, 5, 4096, 5],
    };
    expect(expand(over, dash([1, 1])).status).toBe('dash-limit');
  });

  it('a seam-joined dash counts once', () => {
    // A closed 2 × 2 square, L = 8, [1, 1] phase 0: dashes [0,1], [2,3], [4,5], [6,7], [8,8]
    // with [8,8] joined to [0,1]: four dashes.
    const square: Path = {
      verbs: ['move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 2, 0, 2, 2, 0, 2],
    };
    expect(expand(square, dash([1, 1]), 4)).toMatchObject({ status: 'ok', dashes: 4 });
    expect(expand(square, dash([1, 1]), 3).status).toBe('dash-limit');
  });
});

// ---------------------------------------------------------------------------------------------
// The pipeline (E24 section 4): key, request, dash cache, state failure and counters.
// ---------------------------------------------------------------------------------------------

/** A stroke port that records full requests beside the scripted double's records. */
function recordingStrokePort() {
  const port = new ScriptedStrokeMeshPort();
  const requests: StrokeMeshRequest[] = [];
  const build = port.buildStrokeMeshes.bind(port);
  port.buildStrokeMeshes = (batch) => (requests.push(...batch), build(batch));
  return { port, requests };
}

function lineNode(id: string, tag: number, value: SceneDash | null | undefined, extra = {}) {
  return strokedNode(id, tag, {
    fill: null,
    verbs: ['move', 'line'],
    points: [tag, 0, tag + 300, 0],
    stroke: pathStroke(value === undefined ? {} : { dash: value }),
    ...extra,
  });
}

function notice(nodeId: string, failureCode: PathMeshNotice['failureCode']): PathMeshNotice {
  return {
    nodeId,
    failureScope: 'renderer',
    failureCode,
    toleranceExponent: null,
    paint: 'stroke',
  };
}

describe('E24 section 4 pipeline: requests and keys', () => {
  it('a dashed request strokes the dashed path with the other fields unchanged', () => {
    const { port, requests } = recordingStrokePort();
    const h = createStrokeHarness({ strokePort: port, nodes: [lineNode('a', 0, dash([30, 20]))] });
    expect(h.drawn()).toEqual(['a:stroke']);
    const dashed = ok(LINE, dash([30, 20]));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ width: 2, cap: 'butt', join: 'miter', miterLimit: 4 });
    expect([...requests[0]!.verbs]).toEqual(dashed.verbs.map((verb) => PATH_VERB_CODES[verb]));
    expect([...requests[0]!.points]).toEqual(dashed.points);
  });

  it('E24-A06 unit part: without a dash (absent or null) requests are built from the geometry as before', () => {
    const { port, requests } = recordingStrokePort();
    const nodes = [
      lineNode('absent', 0, undefined),
      lineNode('null', 20, null),
      strokedNode('closed', 40, {
        stroke: pathStroke({ width: 1.5, cap: 'round', join: 'bevel' }),
      }),
      strokedNode('cubic', 60, {
        verbs: ['move', 'cubic', 'close'],
        points: [60, 0, 100, 50, 150, -50, 200, 0],
        stroke: pathStroke({ dash: null }),
      }),
    ];
    const h = createStrokeHarness({ fillPort: createCountingPort(), strokePort: port, nodes });
    h.prepare();
    expect(requests).toHaveLength(4);
    // Every request field, exactly the B2 request built from the node as before E24.
    requests.forEach((request, index) => {
      const { geometry, style } = nodes[index]!;
      const stroke = style.stroke!;
      expect(request).toStrictEqual({
        requestId: index,
        verbs: Uint8Array.from(geometry.verbs, (verb) => PATH_VERB_CODES[verb]),
        points: Float64Array.from(geometry.points),
        width: stroke.width,
        cap: stroke.cap,
        join: stroke.join,
        miterLimit: stroke.miterLimit,
        // Identity transforms at zoom 1 and DPR 1: the B2 stroke bucket of the ST-U6 fixtures.
        toleranceExponent: -3,
      });
    });
    expect(h.pipeline.getDashExpansionCount()).toBe(0);
  });

  it('a pattern off over the whole path strokes to nothing without a port call', () => {
    const { port } = recordingStrokePort();
    const fill = createCountingPort();
    const h = createStrokeHarness({
      fillPort: fill,
      strokePort: port,
      nodes: [
        lineNode('off', 0, dash([1, 1000], 500)),
        strokedNode('filled', 400, { stroke: pathStroke({ dash: dash([1, 1000], 500) }) }),
      ],
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => `${draw.nodeId}:${draw.paint ?? 'fill'}`)).toEqual([
      'filled:fill',
    ]);
    expect(frame.notices).toEqual([]);
    expect(port.callCount).toBe(0);
    expect(fill.callCount).toBe(1);
  });
});

describe('E24-A03 dash limit (pipeline)', () => {
  const over = dash([0.5, 0.5]);

  it('a stroke-only path fails with dash-limit: no port call, one notice, O1, others draw', () => {
    const { port } = recordingStrokePort();
    const h = createStrokeHarness({
      strokePort: port,
      nodes: [
        strokedNode('a', 0, {
          fill: null,
          verbs: ['move', 'line'],
          points: [0, 0, 8192, 0],
          stroke: pathStroke({ dash: dash([1, 1]) }),
        }),
        lineNode('b', 0, dash([30, 20])),
      ],
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => draw.nodeId)).toEqual(['b']);
    expect(frame.notices).toEqual([notice('a', 'dash-limit')]);
    expect(port.calls.map((call) => call.length)).toEqual([1]);
    // The state holds: no further notice, no call, no new expansion.
    const again = h.prepare();
    expect(again.notices).toEqual([]);
    expect(again.draws.map((draw) => draw.nodeId)).toEqual(['b']);
    expect(port.callCount).toBe(1);
    expect(h.pipeline.getDashExpansionCount()).toBe(2);
  });

  it('exactly 4,096 dashes are requested', () => {
    const { port, requests } = recordingStrokePort();
    const h = createStrokeHarness({
      strokePort: port,
      nodes: [
        strokedNode('a', 0, {
          fill: null,
          verbs: ['move', 'line'],
          points: [0, 0, 8190, 0],
          stroke: pathStroke({ dash: dash([1, 1]) }),
        }),
      ],
    });
    expect(h.drawn()).toEqual(['a:stroke']);
    expect(requests[0]!.verbs.filter((verb) => verb === PATH_VERB_CODES.move)).toHaveLength(4096);
  });

  it('O1 for a filled path and a joint path: neither paint draws and no port is called', () => {
    const fill = createCountingPort();
    const { port } = recordingStrokePort();
    const big = {
      verbs: ['move', 'line', 'line', 'close'] as ScenePathVerb[],
      points: [0, 0, 4000, 0, 4000, 10],
    };
    const h = createStrokeHarness({
      fillPort: fill,
      strokePort: port,
      nodes: [
        strokedNode('filled', 0, { ...big, stroke: pathStroke({ dash: over }) }),
        strokedNode('joint', 0, { ...big, opacity: 0.5, stroke: pathStroke({ dash: over }) }),
        strokedNode('other', 100),
      ],
    });
    const frame = h.prepare();
    expect(frame.draws.map((draw) => `${draw.nodeId}:${draw.paint ?? 'fill'}`)).toEqual([
      'other:fill',
      'other:stroke',
    ]);
    expect(frame.notices).toEqual([notice('filled', 'dash-limit'), notice('joint', 'dash-limit')]);
    expect(fill.calls.map((call) => call.map((request) => request.tag))).toEqual([[100]]);
    expect(port.calls.map((call) => call.map((request) => request.tag))).toEqual([[100]]);
    // Dropping the dash clears the state with no notice and draws both paints.
    h.replace([
      strokedNode('filled', 0, big),
      strokedNode('joint', 0, { ...big, opacity: 0.5 }),
      strokedNode('other', 100),
    ]);
    const cleared = h.prepare();
    expect(cleared.notices).toEqual([]);
    expect(cleared.draws.map((draw) => draw.nodeId)).toEqual([
      'filled',
      'filled',
      'joint',
      'joint',
      'other',
      'other',
    ]);
  });
});

describe('E24-A04 unit part: invalidation counters', () => {
  function setup(value: SceneDash | null = dash([30, 20])) {
    const fill = createCountingPort();
    const { port, requests } = recordingStrokePort();
    const node = (stroke = pathStroke({ dash: value }), extra = {}) =>
      strokedNode('a', 0, {
        verbs: ['move', 'line', 'line', 'close'],
        points: [0, 0, 300, 0, 300, 80],
        stroke,
        ...extra,
      });
    const h = createStrokeHarness({ fillPort: fill, strokePort: port, nodes: [node()] });
    h.prepare();
    const counts = () => [fill.callCount, port.callCount, h.pipeline.getDashExpansionCount()];
    return { h, fill, port, requests, node, counts };
  }

  it('a dash edit makes one stroke call and one expansion, no fill call', () => {
    const { h, node, counts } = setup();
    expect(counts()).toEqual([1, 1, 1]);
    h.replace([node(pathStroke({ dash: dash([30, 21]) }))]);
    h.prepare();
    expect(counts()).toEqual([1, 2, 2]);
    h.replace([node(pathStroke({ dash: dash([30, 21], 4) }))]);
    h.prepare();
    expect(counts()).toEqual([1, 3, 3]);
  });

  it('dashed to solid and back: stroke calls only, no expansion for the solid stroke', () => {
    const { h, node, counts, requests } = setup();
    h.replace([node(pathStroke())]);
    h.prepare();
    expect(counts()).toEqual([1, 2, 1]);
    expect([...requests[1]!.points]).toEqual([0, 0, 300, 0, 300, 80]);
    h.replace([node(pathStroke({ dash: dash([30, 20]) }))]);
    h.prepare();
    expect(counts()).toEqual([1, 3, 2]);
    // A stroke colour edit and a node opacity edit make no port call and no expansion.
    h.replace([node(pathStroke({ dash: dash([30, 20]), color: RED }), { opacity: 0.5 })]);
    h.prepare();
    expect(counts()).toEqual([1, 3, 2]);
  });

  it('a pan runs no expansion; a zoom re-requests with the cached dashed path', () => {
    const { h, counts, requests } = setup();
    h.setZoom(1, { x: 40, y: -10 });
    h.prepare();
    expect(counts()).toEqual([1, 1, 1]);
    h.setZoom(8);
    h.prepare();
    expect(counts()).toEqual([2, 2, 1]);
    expect(requests[1]!.toleranceExponent).toBeLessThan(requests[0]!.toleranceExponent);
    expect(requests[1]!.points).toEqual(requests[0]!.points);
    expect(requests[1]!.verbs).toEqual(requests[0]!.verbs);
  });

  it('a pending request resumed in a later prepare uses the cached dashed path', () => {
    const { port, requests } = recordingStrokePort();
    let failFirst = true;
    port.script = {
      batch: () => {
        if (!failFirst) return undefined;
        failFirst = false;
        return { status: 'batch-failed', code: 'internal-error' };
      },
    };
    const h = createStrokeHarness({
      strokePort: port,
      limits: { callsPerPrepare: 2 },
      nodes: [
        lineNode('a', 0, dash([30, 20])),
        lineNode('b', 0, dash([10, 10]), { points: [0, 20, 300, 20] }),
      ],
    });
    // Call 1 fails as a batch and splits; call 2 serves a; b stays on the stack.
    expect(h.drawn()).toEqual(['a:stroke']);
    expect(port.calls.map((call) => call.length)).toEqual([2, 1]);
    expect(h.drawn()).toEqual(['a:stroke', 'b:stroke']);
    expect(port.calls.map((call) => call.length)).toEqual([2, 1, 1]);
    expect(h.pipeline.getDashExpansionCount()).toBe(2);
    expect([...requests[3]!.points]).toEqual(
      ok({ verbs: ['move', 'line'], points: [0, 20, 300, 20] }, dash([10, 10])).points,
    );
  });

  it('dash cache bytes count in the statistics and leave with the dash', () => {
    const { h, node } = setup(null);
    const solid = h.statistics().bytes;
    h.replace([node(pathStroke({ dash: dash([30, 20]) }))]);
    h.prepare();
    const dashed = ok(
      { verbs: ['move', 'line', 'line', 'close'], points: [0, 0, 300, 0, 300, 80] },
      dash([30, 20]),
    );
    expect(h.statistics().bytes - solid).toBe(dashed.verbs.length + 8 * dashed.points.length);
    h.replace([node(pathStroke())]);
    h.prepare();
    expect(h.statistics().bytes).toBe(solid);
  });

  it('the render target does not enter the dash key', () => {
    const { h, counts } = setup();
    h.prepare({ ...target, devicePixelRatio: 2, width: 1280, height: 720 });
    expect(counts()[2]).toBe(1);
  });
});
