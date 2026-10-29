import type { SceneDash, ScenePathVerb } from '@vector-studio/contracts';

// E24 contract (docs/plans/d9-e24-dash-contract.md), sections 3 and 4: dash expansion ahead of
// the unchanged stroke port. The output is an ordinary multi-subpath path that the B2 stroke
// contract strokes as it stands. Only +, −, ×, ÷, %, sqrt and floor in binary64 are used, in a
// fixed order, so equal inputs give bit-identical output in every engine (E24-K7). Nothing here
// depends on the camera, zoom, DPR or tolerance exponent.

/** E24-K8 (E24-Q4 (a)): more dashes than this, summed over all subpaths, is `dash-limit`. */
export const DASH_LIMIT = 4_096;

export type DashedPath = Readonly<{
  verbs: readonly ScenePathVerb[];
  points: readonly number[];
}>;

export type DashExpansion =
  | Readonly<{ status: 'ok'; path: DashedPath; dashes: number }>
  | Readonly<{ status: 'dash-limit'; dashes: number }>;

type Point = Readonly<{ x: number; y: number }>;
type Line = Readonly<{ kind: 'line'; p0: Point; p1: Point; length: number }>;
type Cubic = Readonly<{
  kind: 'cubic';
  p0: Point;
  p1: Point;
  p2: Point;
  p3: Point;
  length: number;
  /** Adaptive quadrature cells in t, left to right; each value is its 8-point estimate. */
  cells: readonly Cell[];
}>;
type Segment = Line | Cubic;
type Cell = Readonly<{ a: number; b: number; value: number }>;
type Subpath = Readonly<{
  /** The source verbs and points of this subpath, emitted unchanged when it is fully on. */
  verbs: readonly ScenePathVerb[];
  points: readonly number[];
  start: Point;
  closed: boolean;
  /** Drawing segments after ST-S1 (zero-length segments removed), with the closing line. */
  segments: readonly Segment[];
}>;
type Dash = { s0: number; s1: number };

// 8-point Gauss–Legendre nodes and weights on [−1, 1], as binary64 literals (section 4).
const GL_NODES = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498,
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363,
] as const;
const GL_WEIGHTS = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362, 0.362683783378362,
  0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
] as const;
const SPLIT_TOLERANCE = 2 ** -30;
const MAX_DEPTH = 24;
const NEWTON_STEPS = 64;
const T_EPSILON = 2 ** -52;

/**
 * Expands `dash` over the path (E24-K1 to K5). A subpath with no dash on it disappears; the
 * result can have no subpath at all, which strokes to nothing.
 */
export function expandDash(
  verbs: readonly ScenePathVerb[],
  points: readonly number[],
  dash: SceneDash,
  limit = DASH_LIMIT,
): DashExpansion {
  const pattern =
    dash.pattern.length % 2 === 1 ? [...dash.pattern, ...dash.pattern] : [...dash.pattern];
  let period = 0;
  for (const entry of pattern) period += entry;
  // E24-K1: the exact remainder, then into [0, P).
  let phase = dash.phase % period;
  if (phase < 0) phase += period;
  if (phase >= period) phase = 0;

  const outVerbs: ScenePathVerb[] = [];
  const outPoints: number[] = [];
  let count = 0;
  for (const subpath of decode(verbs, points)) {
    let length = 0;
    for (const segment of subpath.segments) length += segment.length;
    if (subpath.segments.length === 0 || length === 0) {
      // E24-K5: a zero-length subpath passes unchanged when the pattern is on at s = 0.
      if (!isOnAt(0, pattern, period, phase)) continue;
      count += 1;
      if (count > limit) return Object.freeze({ status: 'dash-limit', dashes: count });
      outVerbs.push(...subpath.verbs);
      outPoints.push(...subpath.points);
      continue;
    }
    const dashes = dashesOf(length, pattern, period, phase, limit - count);
    if (dashes === null) return Object.freeze({ status: 'dash-limit', dashes: limit + 1 });
    if (dashes.length === 0) continue;
    // E24-K3 and K4: a single dash over the whole subpath is the subpath itself.
    if (dashes.length === 1 && dashes[0]!.s0 === 0 && dashes[0]!.s1 === length) {
      count += 1;
      outVerbs.push(...subpath.verbs);
      outPoints.push(...subpath.points);
      continue;
    }
    // E24-K4: in a closed subpath, a dash ending at L and one starting at 0 become one dash.
    const seam =
      subpath.closed &&
      dashes.length >= 2 &&
      dashes[0]!.s0 === 0 &&
      dashes[dashes.length - 1]!.s1 === length;
    count += seam ? dashes.length - 1 : dashes.length;
    if (count > limit) return Object.freeze({ status: 'dash-limit', dashes: count });
    const first = seam ? 1 : 0;
    const last = seam ? dashes.length - 1 : dashes.length;
    for (let index = first; index < last; index += 1) {
      emitDash(subpath.segments, dashes[index]!, length, outVerbs, outPoints, true);
    }
    if (seam) {
      emitDash(subpath.segments, dashes[dashes.length - 1]!, length, outVerbs, outPoints, true);
      emitDash(subpath.segments, dashes[0]!, length, outVerbs, outPoints, false);
    }
  }
  return Object.freeze({
    status: 'ok',
    path: Object.freeze({ verbs: Object.freeze(outVerbs), points: Object.freeze(outPoints) }),
    dashes: count,
  });
}

/** E24-K2: whether the pattern position at arc length s lies in a closed on-interval. */
function isOnAt(s: number, pattern: readonly number[], period: number, phase: number): boolean {
  let u = (s + phase) % period;
  if (u < 0) u += period;
  let start = 0;
  for (let index = 0; index < pattern.length; index += 2) {
    const end = start + pattern[index]!;
    if (u >= start && u <= end) return true;
    start = end + pattern[index + 1]!;
  }
  // The end of the last gap is the start of the next period's first dash.
  return u >= start;
}

/**
 * E24-K3: the maximal on intervals of [0, L], left to right, merging closed intervals that
 * touch. Null when there are more than `budget` of them.
 */
function dashesOf(
  length: number,
  pattern: readonly number[],
  period: number,
  phase: number,
  budget: number,
): Dash[] | null {
  const dashes: Dash[] = [];
  // Period m starts at m·P − φ; m = −1 covers an on-interval that ends exactly at s = 0.
  for (let m = -1; ; m += 1) {
    const base = m * period - phase;
    if (base > length) break;
    let offset = 0;
    for (let index = 0; index < pattern.length; index += 2) {
      const lo = base + offset;
      const hi = lo + pattern[index]!;
      offset += pattern[index]! + pattern[index + 1]!;
      if (hi < 0 || lo > length) continue;
      const s0 = lo < 0 ? 0 : lo;
      const s1 = hi > length ? length : hi;
      const previous = dashes[dashes.length - 1];
      if (previous !== undefined && s0 <= previous.s1) {
        if (s1 > previous.s1) previous.s1 = s1;
        continue;
      }
      dashes.push({ s0, s1 });
      // The seam can merge two dashes into one, so allow one more before giving up.
      if (dashes.length > budget + 1) return null;
    }
  }
  return dashes;
}

function decode(verbs: readonly ScenePathVerb[], points: readonly number[]): Subpath[] {
  const subpaths: Subpath[] = [];
  let pointIndex = 0;
  let verbIndex = 0;
  while (verbIndex < verbs.length) {
    // Validated geometry starts every subpath with a move (P3 path data rules).
    const verbStart = verbIndex;
    const pointStart = pointIndex;
    const start = { x: points[pointIndex]!, y: points[pointIndex + 1]! };
    pointIndex += 2;
    verbIndex += 1;
    let current: Point = start;
    const segments: Segment[] = [];
    let closed = false;
    while (verbIndex < verbs.length && verbs[verbIndex] !== 'move') {
      const verb = verbs[verbIndex]!;
      verbIndex += 1;
      if (verb === 'close') {
        closed = true;
        break;
      }
      if (verb === 'line') {
        const p1 = { x: points[pointIndex]!, y: points[pointIndex + 1]! };
        pointIndex += 2;
        if (!samePoint(current, p1)) segments.push(line(current, p1));
        current = p1;
        continue;
      }
      const p1 = { x: points[pointIndex]!, y: points[pointIndex + 1]! };
      const p2 = { x: points[pointIndex + 2]!, y: points[pointIndex + 3]! };
      const p3 = { x: points[pointIndex + 4]!, y: points[pointIndex + 5]! };
      pointIndex += 6;
      if (!(samePoint(current, p1) && samePoint(p1, p2) && samePoint(p2, p3))) {
        segments.push(cubic(current, p1, p2, p3));
      }
      current = p3;
    }
    if (closed && !samePoint(current, start)) segments.push(line(current, start));
    subpaths.push(
      Object.freeze({
        verbs: verbs.slice(verbStart, verbIndex),
        points: points.slice(pointStart, pointIndex),
        start,
        closed,
        segments,
      }),
    );
  }
  return subpaths;
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function line(p0: Point, p1: Point): Line {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  return Object.freeze({ kind: 'line', p0, p1, length: Math.sqrt(dx * dx + dy * dy) });
}

function cubic(p0: Point, p1: Point, p2: Point, p3: Point): Cubic {
  const cells: Cell[] = [];
  const speed = speedOf(p0, p1, p2, p3);
  refine(speed, 0, 1, gauss(speed, 0, 1), 0, cells);
  let length = 0;
  for (const cell of cells) length += cell.value;
  return Object.freeze({ kind: 'cubic', p0, p1, p2, p3, length, cells: Object.freeze(cells) });
}

/** |B′(t)| of the cubic. */
function speedOf(p0: Point, p1: Point, p2: Point, p3: Point): (t: number) => number {
  const ax = p1.x - p0.x;
  const ay = p1.y - p0.y;
  const bx = p2.x - p1.x;
  const by = p2.y - p1.y;
  const cx = p3.x - p2.x;
  const cy = p3.y - p2.y;
  return (t) => {
    const u = 1 - t;
    const dx = 3 * (u * u * ax + 2 * u * t * bx + t * t * cx);
    const dy = 3 * (u * u * ay + 2 * u * t * by + t * t * cy);
    return Math.sqrt(dx * dx + dy * dy);
  };
}

function gauss(speed: (t: number) => number, a: number, b: number): number {
  const half = (b - a) / 2;
  const middle = (a + b) / 2;
  let sum = 0;
  for (let index = 0; index < 8; index += 1) {
    sum += GL_WEIGHTS[index]! * speed(middle + half * GL_NODES[index]!);
  }
  return sum * half;
}

/** Section 4: split while the halves disagree by more than 2^-30 of the cell, to depth 24. */
function refine(
  speed: (t: number) => number,
  a: number,
  b: number,
  whole: number,
  depth: number,
  cells: Cell[],
): void {
  const middle = (a + b) / 2;
  const left = gauss(speed, a, middle);
  const right = gauss(speed, middle, b);
  if (depth >= MAX_DEPTH || Math.abs(whole - (left + right)) <= SPLIT_TOLERANCE * whole) {
    cells.push(Object.freeze({ a, b: middle, value: left }));
    cells.push(Object.freeze({ a: middle, b, value: right }));
    return;
  }
  refine(speed, a, middle, left, depth + 1, cells);
  refine(speed, middle, b, right, depth + 1, cells);
}

/** The parameter of a cubic at arc length `target` from its start (0 ≤ target ≤ length). */
function cubicParameter(segment: Cubic, target: number): number {
  if (target <= 0) return 0;
  if (target >= segment.length) return 1;
  const speed = speedOf(segment.p0, segment.p1, segment.p2, segment.p3);
  let before = 0;
  for (const cell of segment.cells) {
    if (before + cell.value < target) {
      before += cell.value;
      continue;
    }
    const remaining = target - before;
    let lo = cell.a;
    let hi = cell.b;
    let t = cell.value > 0 ? cell.a + (cell.b - cell.a) * (remaining / cell.value) : cell.a;
    for (let step = 0; step < NEWTON_STEPS; step += 1) {
      const error = gauss(speed, cell.a, t) - remaining;
      if (error > 0) hi = t;
      else lo = t;
      const derivative = speed(t);
      let next = derivative > 0 ? t - error / derivative : (lo + hi) / 2;
      if (!(next > lo && next < hi)) next = (lo + hi) / 2;
      const moved = Math.abs(next - t);
      t = next;
      if (moved < T_EPSILON) break;
    }
    return t;
  }
  return 1;
}

/** Emits one dash [s0, s1] as an open subpath; `move` is false to continue the previous one. */
function emitDash(
  segments: readonly Segment[],
  dash: Dash,
  length: number,
  verbs: ScenePathVerb[],
  points: number[],
  move: boolean,
): void {
  let before = 0;
  let started = !move;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const segmentStart = before;
    const segmentEnd = index === segments.length - 1 ? length : before + segment.length;
    before = segmentEnd;
    if (segmentEnd < dash.s0) continue;
    if (!started) {
      // The dash starts in this segment, or at its end when the dash starts at a vertex.
      const start = pointAt(segment, dash.s0 - segmentStart);
      verbs.push('move');
      points.push(start.x, start.y);
      started = true;
      if (dash.s1 === dash.s0) {
        // E24-K5: a zero-length dash is a zero-length open subpath (ST-S10).
        verbs.push('line');
        points.push(start.x, start.y);
        return;
      }
    }
    const from = Math.max(dash.s0, segmentStart) - segmentStart;
    const to = Math.min(dash.s1, segmentEnd) - segmentStart;
    // A dash starting at a segment's end has no piece there; it continues in the next segment.
    if (to > from) emitPiece(segment, from, to, verbs, points);
    if (dash.s1 <= segmentEnd) return;
  }
}

function pointAt(segment: Segment, s: number): Point {
  if (s <= 0) return segment.p0;
  if (segment.kind === 'line') {
    if (s >= segment.length) return segment.p1;
    const f = s / segment.length;
    return {
      x: segment.p0.x + (segment.p1.x - segment.p0.x) * f,
      y: segment.p0.y + (segment.p1.y - segment.p0.y) * f,
    };
  }
  if (s >= segment.length) return segment.p3;
  return evaluate(segment, cubicParameter(segment, s));
}

/** The part of a segment between arc lengths `from` and `to` from its start, without a move. */
function emitPiece(
  segment: Segment,
  from: number,
  to: number,
  verbs: ScenePathVerb[],
  points: number[],
): void {
  if (segment.kind === 'line') {
    const end = pointAt(segment, to);
    verbs.push('line');
    points.push(end.x, end.y);
    return;
  }
  const t0 = cubicParameter(segment, from);
  const t1 = cubicParameter(segment, to);
  const [, c1, c2, c3] = subCubic(segment, t0, t1);
  verbs.push('cubic');
  points.push(c1.x, c1.y, c2.x, c2.y, c3.x, c3.y);
}

function evaluate(segment: Cubic, t: number): Point {
  return split(segment.p0, segment.p1, segment.p2, segment.p3, t)[0][3];
}

type Quad = readonly [Point, Point, Point, Point];

/** De Casteljau at t: the left and right parts. The shared endpoint is exact at t = 0 or 1. */
function split(p0: Point, p1: Point, p2: Point, p3: Point, t: number): readonly [Quad, Quad] {
  if (t <= 0)
    return [
      [p0, p0, p0, p0],
      [p0, p1, p2, p3],
    ];
  if (t >= 1)
    return [
      [p0, p1, p2, p3],
      [p3, p3, p3, p3],
    ];
  const lerp = (a: Point, b: Point): Point => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  const q0 = lerp(p0, p1);
  const q1 = lerp(p1, p2);
  const q2 = lerp(p2, p3);
  const r0 = lerp(q0, q1);
  const r1 = lerp(q1, q2);
  const s = lerp(r0, r1);
  return [
    [p0, q0, r0, s],
    [s, r1, q2, p3],
  ];
}

/** The cubic between parameters t0 < t1; source endpoints are kept exactly at 0 and 1. */
function subCubic(segment: Cubic, t0: number, t1: number): Quad {
  const { p0, p1, p2, p3 } = segment;
  const left: Quad = t1 >= 1 ? [p0, p1, p2, p3] : split(p0, p1, p2, p3, t1)[0];
  if (t0 <= 0) return left;
  const [a, b, c, d] = left;
  return split(a, b, c, d, t0 / t1)[1];
}
