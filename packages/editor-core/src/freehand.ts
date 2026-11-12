import type { Frame, PathVerb } from '@vector-studio/model';
import type { PagePoint } from './types.js';

// V-40 (Figma gap item 10, contract docs/plans/viz-v40-pencil-polygon-contract.md): the pure
// geometry of the pencil and polygon tools. The pencil smooths its raw pointer samples and fits
// cubic Béziers to them within a tolerance (P. J. Schneider, "An Algorithm for Automatically
// Fitting Digitized Curves", Graphics Gems, 1990); the polygon tool inscribes a regular polygon
// in a drag box. Every output coordinate is snapped to the 2^-16 px grid, as `ext.star` does,
// so mirrored vertices stay exactly mirrored for the stroke kernel (V-25, #523).

const GRID = 65_536;
/** A coordinate on the 2^-16 grid. */
export const gridSnap = (value: number): number => Math.round(value * GRID) / GRID + 0;

/** The path data `createPath` takes: verbs and interleaved page-space points. */
export type PathData = Readonly<{ verbs: readonly PathVerb[]; points: readonly number[] }>;

type Vec = Readonly<{ x: number; y: number }>;

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
const length = (a: Vec): number => Math.hypot(a.x, a.y);
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);

function unit(a: Vec): Vec {
  const l = length(a);
  return l === 0 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** The samples with consecutive points closer than `minStep` dropped (the last one kept). */
export function dedupe(points: readonly PagePoint[], minStep: number): PagePoint[] {
  const out: PagePoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const last = out[out.length - 1];
    if (last === undefined || dist(last, point) >= minStep) out.push(point);
  }
  const final = points[points.length - 1];
  if (final !== undefined && out.length > 1 && out[out.length - 1] !== final) {
    // Keep the true end point: it replaces a last sample that is too close to it.
    if (Number.isFinite(final.x) && Number.isFinite(final.y)) out[out.length - 1] = final;
  }
  return out;
}

/**
 * A moving-average smoothing of the samples over a window measured in distance: each sample is
 * averaged with its neighbours while the window's two ends are within 2 × `reach` of each other, the same count
 * on both sides (so the window is symmetric), at most `maxRadius` each side. Dense, jittery
 * samples are averaged; sparse samples (a quick flick, spaced more than `reach` apart) are kept as
 * drawn, so a sparse loop is not pulled toward its centre (V-40 review B1). The end points of an
 * open stroke stay where they are; with `closed` the window wraps and covers at most a quarter of
 * the loop each side.
 */
export function smooth(
  points: readonly PagePoint[],
  reach: number,
  closed = false,
  maxRadius = 8,
): PagePoint[] {
  const n = points.length;
  if (n < 3 || !(reach > 0)) return points.slice();
  const at = (i: number) => points[((i % n) + n) % n]!;
  const out: PagePoint[] = [];
  for (let i = 0; i < n; i += 1) {
    if (!closed && (i === 0 || i === n - 1)) {
      out.push(points[i]!);
      continue;
    }
    const limit = closed
      ? Math.min(maxRadius, Math.floor((n - 1) / 4))
      : Math.min(maxRadius, i, n - 1 - i);
    // The window grows while its two ends are within 2 × `reach` of each other in a straight
    // line: jitter, which lengthens the path along the samples, barely changes that span, so it
    // does not shrink the window (V-40 review r3), while sparse samples stop it at once.
    let r = 0;
    while (r < limit && dist(at(i - r - 1), at(i + r + 1)) <= 2 * reach) r += 1;
    let sx = 0;
    let sy = 0;
    for (let k = -r; k <= r; k += 1) {
      const p = at(i + k);
      sx += p.x;
      sy += p.y;
    }
    out.push({ x: sx / (2 * r + 1), y: sy / (2 * r + 1) });
  }
  return out;
}

type Cubic = readonly [Vec, Vec, Vec, Vec];

function bezier(c: Cubic, t: number): Vec {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const d = 3 * mt * t * t;
  const e = t * t * t;
  return {
    x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x,
    y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y,
  };
}

/** One Newton-Raphson step improving the parameter `t` of `p` on `c`. */
function newton(c: Cubic, p: Vec, t: number): number {
  const mt = 1 - t;
  const q = bezier(c, t);
  const d1 = add(
    add(scale(sub(c[1], c[0]), 3 * mt * mt), scale(sub(c[2], c[1]), 6 * mt * t)),
    scale(sub(c[3], c[2]), 3 * t * t),
  );
  const d2 = add(
    scale(add(sub(c[2], scale(c[1], 2)), c[0]), 6 * mt),
    scale(add(sub(c[3], scale(c[2], 2)), c[1]), 6 * t),
  );
  const diff = sub(q, p);
  const numerator = dot(diff, d1);
  const denominator = dot(d1, d1) + dot(diff, d2);
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return t;
  const next = t - numerator / denominator;
  return Number.isFinite(next) ? Math.min(1, Math.max(0, next)) : t;
}

function chordParameters(points: readonly Vec[], first: number, last: number): number[] {
  const u = [0];
  for (let i = first + 1; i <= last; i += 1) {
    u.push(u[u.length - 1]! + dist(points[i]!, points[i - 1]!));
  }
  const total = u[u.length - 1]!;
  return total === 0 ? u.map((_, i) => i / Math.max(1, u.length - 1)) : u.map((v) => v / total);
}

/** The least-squares cubic through `points[first..last]` with the given end tangents. */
function generate(
  points: readonly Vec[],
  first: number,
  last: number,
  u: readonly number[],
  t1: Vec,
  t2: Vec,
): Cubic {
  const p0 = points[first]!;
  const p3 = points[last]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < u.length; i += 1) {
    const t = u[i]!;
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * t;
    const b2 = 3 * mt * t * t;
    const b3 = t * t * t;
    const a1 = scale(t1, b1);
    const a2 = scale(t2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(points[first + i]!, add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const chord = dist(p0, p3);
  let alpha1 = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let alpha2 = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const epsilon = 1e-6 * chord;
  if (!(alpha1 > epsilon) || !(alpha2 > epsilon) || alpha1 > 2 * chord || alpha2 > 2 * chord) {
    // The Wu and Barsky heuristic: a third of the chord on each tangent.
    alpha1 = chord / 3;
    alpha2 = chord / 3;
  }
  return [p0, add(p0, scale(t1, alpha1)), add(p3, scale(t2, alpha2)), p3];
}

function maxError(
  points: readonly Vec[],
  first: number,
  last: number,
  c: Cubic,
  u: readonly number[],
): { error: number; split: number } {
  let error = 0;
  let split = Math.floor((first + last) / 2);
  for (let i = first + 1; i < last; i += 1) {
    const d = dist(bezier(c, u[i - first]!), points[i]!);
    const squared = d * d;
    if (squared > error) {
      error = squared;
      split = i;
    }
  }
  return { error, split };
}

function fitRange(
  points: readonly Vec[],
  first: number,
  last: number,
  t1: Vec,
  t2: Vec,
  error: number,
  out: Cubic[],
  depth: number,
): void {
  const p0 = points[first]!;
  const p3 = points[last]!;
  if (last - first === 1) {
    const third = dist(p0, p3) / 3;
    out.push([p0, add(p0, scale(t1, third)), add(p3, scale(t2, third)), p3]);
    return;
  }
  let u = chordParameters(points, first, last);
  let curve = generate(points, first, last, u, t1, t2);
  let { error: worst, split } = maxError(points, first, last, curve, u);
  if (worst < error) {
    out.push(curve);
    return;
  }
  if (worst < error * 4) {
    for (let iteration = 0; iteration < 8; iteration += 1) {
      const c = curve;
      u = u.map((t, i) => newton(c, points[first + i]!, t));
      curve = generate(points, first, last, u, t1, t2);
      ({ error: worst, split } = maxError(points, first, last, curve, u));
      if (worst < error) {
        out.push(curve);
        return;
      }
    }
  }
  // A depth bound for pathological input: past it the tolerance is not guaranteed.
  if (depth > 64) {
    out.push(curve);
    return;
  }
  // Split at the worst point with a shared tangent there, so the joint stays smooth.
  split = Math.min(last - 1, Math.max(first + 1, split));
  let centre = unit(sub(points[split - 1]!, points[split + 1]!));
  if (length(centre) === 0) centre = unit(sub(points[split - 1]!, points[split]!));
  fitRange(points, first, split, t1, centre, error, out, depth + 1);
  fitRange(points, split, last, scale(centre, -1), t2, error, out, depth + 1);
}

function endTangent(points: readonly Vec[], from: number, step: 1 | -1): Vec {
  const origin = points[from]!;
  for (let i = from + step; i >= 0 && i < points.length; i += step) {
    const t = unit(sub(points[i]!, origin));
    if (length(t) > 0) return t;
  }
  return { x: 0, y: 0 };
}

/**
 * Cubic Béziers through `points` within `tolerance` (page units) of every sample (Schneider).
 * With `closed` the first and last points are the same joint and its tangent is shared.
 */
export function fitCubics(
  points: readonly PagePoint[],
  tolerance: number,
  closed = false,
): readonly Cubic[] {
  if (points.length < 2) return [];
  const error = tolerance * tolerance;
  const out: Cubic[] = [];
  let t1 = endTangent(points, 0, 1);
  let t2 = endTangent(points, points.length - 1, -1);
  if (closed && points.length > 3) {
    const shared = unit(sub(points[1]!, points[points.length - 2]!));
    if (length(shared) > 0) {
      t1 = shared;
      t2 = scale(shared, -1);
    }
  }
  fitRange(points, 0, points.length - 1, t1, t2, error, out, 0);
  return out;
}

/** The tuning of `freehandPath`, in CSS px (divided by the zoom). */
export const FREEHAND = Object.freeze({
  /** Samples closer than this to the previous one are dropped. */
  minStepPx: 1,
  /**
   * The moving-average window: neighbours within this straight-line distance. It takes out
   * jitter of about ±2 px at the 1 to 2 px sample spacing of an ordinary drag.
   */
  smoothPx: 6,
  /** The fit tolerance: every smoothed sample is within this distance of the curve. */
  tolerancePx: 2.5,
  /** A stroke that ends this close to its start closes the path. */
  closePx: 8,
  /** A stroke shorter than this (total length) makes no path: it is a click. */
  minLengthPx: 3,
});

function boxDiagonal(points: readonly Vec[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return points.length === 0 ? 0 : Math.hypot(maxX - minX, maxY - minY);
}

function polylineLength(points: readonly Vec[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += dist(points[i - 1]!, points[i]!);
  return total;
}

/**
 * The path the pencil makes from its raw samples at `zoom`: deduplicated, smoothed and fitted
 * with cubics (`FREEHAND`), open, or closed with a `close` verb when the stroke ends within
 * `closePx` of its start and is long enough to enclose something. Null for a click (shorter than
 * `minLengthPx`). Every coordinate is on the 2^-16 grid.
 */
export function freehandPath(samples: readonly PagePoint[], zoom: number): PathData | null {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const raw = dedupe(samples, FREEHAND.minStepPx / z);
  if (raw.length < 2 || polylineLength(raw) < FREEHAND.minLengthPx / z) return null;
  const first = raw[0]!;
  const last = raw[raw.length - 1]!;
  const closed =
    raw.length >= 4 &&
    dist(first, last) <= FREEHAND.closePx / z &&
    polylineLength(raw) > (4 * FREEHAND.closePx) / z;
  let points = raw;
  if (closed) {
    // The loop ends on its start: the last samples near the start are replaced by it.
    points = raw.slice(0, -1);
    while (points.length > 3 && dist(points[points.length - 1]!, first) < FREEHAND.minStepPx / z) {
      points.pop();
    }
  }
  let smoothed = smooth(points, FREEHAND.smoothPx / z, closed);
  // A stroke smaller than the window (a tiny scribble) would average away: it is fitted as drawn.
  if (boxDiagonal(smoothed) < 0.5 * boxDiagonal(points)) smoothed = points.slice();
  const loop = closed ? [...smoothed, smoothed[0]!] : smoothed;
  const curves = fitCubics(loop, FREEHAND.tolerancePx / z, closed);
  if (curves.length === 0) return null;
  const verbs: PathVerb[] = ['move'];
  const start = curves[0]![0];
  const out = [gridSnap(start.x), gridSnap(start.y)];
  for (const [, c1, c2, end] of curves) {
    verbs.push('cubic');
    out.push(
      gridSnap(c1.x),
      gridSnap(c1.y),
      gridSnap(c2.x),
      gridSnap(c2.y),
      gridSnap(end.x),
      gridSnap(end.y),
    );
  }
  // A result that collapsed below the click length (its box diagonal) makes no path.
  const xs = out.filter((_, i) => i % 2 === 0);
  const ys = out.filter((_, i) => i % 2 === 1);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!(diagonal >= FREEHAND.minLengthPx / z)) return null;
  if (closed) {
    // The last cubic ends exactly on the start point.
    out[out.length - 2] = out[0]!;
    out[out.length - 1] = out[1]!;
    verbs.push('close');
  }
  return { verbs, points: out };
}

/**
 * The live preview of a pencil stroke: the deduplicated, smoothed samples as a polyline, so the
 * drawn line does not shift while the stroke grows. Null while it is still a click.
 */
export function freehandPreview(samples: readonly PagePoint[], zoom: number): PathData | null {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const raw = dedupe(samples, FREEHAND.minStepPx / z);
  if (raw.length < 2 || polylineLength(raw) < FREEHAND.minLengthPx / z) return null;
  const points = smooth(raw, FREEHAND.smoothPx / z);
  const verbs: PathVerb[] = ['move'];
  const out: number[] = [];
  points.forEach((p, i) => {
    if (i > 0) verbs.push('line');
    out.push(gridSnap(p.x), gridSnap(p.y));
  });
  return { verbs, points: out };
}

/** The polygon tool's side count range and default (V-40). */
export const POLYGON_SIDES = Object.freeze({ min: 3, max: 60, default: 3 });

/** Whether `value` is a valid polygon side count. */
export function isPolygonSides(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= POLYGON_SIDES.min &&
    (value as number) <= POLYGON_SIDES.max
  );
}

/**
 * A regular polygon of `sides` sides with its first vertex at the top, stretched so that its
 * vertices touch all four sides of `frame` (Figma: the polygon fills its box), as a closed path
 * of lines. Coordinates are on the 2^-16 grid. Null for an empty frame.
 */
export function polygonPath(frame: Frame, sides: number): PathData | null {
  if (!isPolygonSides(sides) || !(frame.width > 0) || !(frame.height > 0)) return null;
  const unitPoints: Vec[] = [];
  for (let i = 0; i < sides; i += 1) {
    // Vertex i and its mirror sides - i take the same sine and cosine, x negated, so the
    // polygon is exactly symmetric about its vertical axis (cos and sin noise differs otherwise).
    const k = Math.min(i, sides - i);
    const angle = (2 * Math.PI * k) / sides;
    const x = k === 0 || 2 * k === sides ? 0 : Math.sin(angle);
    unitPoints.push({ x: i > sides / 2 ? -x : x, y: -Math.cos(angle) });
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of unitPoints) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const verbs: PathVerb[] = [];
  const points: number[] = [];
  unitPoints.forEach((p, i) => {
    verbs.push(i === 0 ? 'move' : 'line');
    const fx = (p.x - minX) / (maxX - minX);
    const fy = (p.y - minY) / (maxY - minY);
    points.push(gridSnap(frame.x + fx * frame.width), gridSnap(frame.y + fy * frame.height));
  });
  verbs.push('close');
  return { verbs, points };
}
