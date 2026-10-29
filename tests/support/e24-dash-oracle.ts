import type { SceneDash, ScenePaint, ScenePathVerb } from '@vector-studio/contracts';

import { paintAt, type Premultiplied } from './e23-gradient-oracle.js';
import { invert, transformPoint, type Affine } from './p4-clip-oracle.js';

// E24 contract (docs/plans/d9-e24-dash-contract.md), section 6: the CPU oracle of dashed strokes
// for the U3 headed spec. It dashes each path on its own, without stroke-dash.ts: cubics are
// flattened into pieces no longer than 2^-12 local units, lines stay exact, and arc length is
// accumulated along the pieces. Dash intervals follow E24-K1 to K5 from their definitions. The
// dashes are then resampled at 1/4 unit for the coverage queries (the chord error is far below
// the 2 physical px margin). A probe is classified by its distance to the dash polylines with
// the stroke's cap; probes within 2 physical px of any boundary, or near a miter corner, are
// left out. Composition is E23's: the joint stroke-over-fill source scaled by node opacity,
// over black.

type Point = readonly [number, number];
type Polyline = readonly Point[];
/** A dash: its resampled polyline (one point for a zero-length dash); a closed one has no caps. */
export type OracleDash = Readonly<{ points: Polyline; closed?: boolean }>;

const PIECE = 2 ** -12;
const RESAMPLE = 0.25;

/** One subpath as its flattened vertices with their arc length, and whether it is closed. */
type Measured = Readonly<{ vertices: Point[]; s: number[]; closed: boolean }>;

function measure(verbs: readonly ScenePathVerb[], points: readonly number[]): Measured[] {
  const out: Measured[] = [];
  let current: { vertices: Point[]; s: number[]; closed: boolean } | null = null;
  let start: Point = [0, 0];
  let cursor = 0;
  const push = (p: Point) => {
    const list = current!;
    const last = list.vertices[list.vertices.length - 1]!;
    const length = Math.hypot(p[0] - last[0], p[1] - last[1]);
    if (length === 0) return;
    list.vertices.push(p);
    list.s.push(list.s[list.s.length - 1]! + length);
  };
  for (const verb of verbs) {
    if (verb === 'move') {
      if (current !== null) out.push(current);
      start = [points[cursor]!, points[cursor + 1]!];
      current = { vertices: [start], s: [0], closed: false };
      cursor += 2;
    } else if (verb === 'line') {
      push([points[cursor]!, points[cursor + 1]!]);
      cursor += 2;
    } else if (verb === 'cubic') {
      const p0 = current!.vertices[current!.vertices.length - 1]!;
      const [x1, y1, x2, y2, x3, y3] = points.slice(cursor, cursor + 6) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      // A bound on the length: the control polygon; pieces no longer than 2^-12.
      const polygon =
        Math.hypot(x1 - p0[0], y1 - p0[1]) +
        Math.hypot(x2 - x1, y2 - y1) +
        Math.hypot(x3 - x2, y3 - y2);
      const steps = Math.max(1, Math.ceil(polygon / PIECE));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const u = 1 - t;
        push([
          u * u * u * p0[0] + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * p0[1] + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
      cursor += 6;
    } else {
      push(start);
      current!.closed = true;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/** The point at arc length `s` of a measured subpath (binary search, then linear). */
function pointAt(path: Measured, s: number): Point {
  const { vertices, s: lengths } = path;
  let lo = 0;
  let hi = lengths.length - 1;
  if (s <= 0) return vertices[0]!;
  if (s >= lengths[hi]!) return vertices[hi]!;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const f = (s - lengths[lo]!) / (lengths[hi]! - lengths[lo]!);
  const a = vertices[lo]!;
  const b = vertices[hi]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** The polyline of [s0, s1], resampled, with every source vertex between kept. */
function slice(path: Measured, s0: number, s1: number): Point[] {
  if (s1 === s0) return [pointAt(path, s0)];
  const out: Point[] = [pointAt(path, s0)];
  let next = s0 + RESAMPLE;
  for (let index = 0; index < path.s.length; index += 1) {
    const s = path.s[index]!;
    if (s <= s0) continue;
    if (s >= s1) break;
    while (next < s) {
      out.push(pointAt(path, next));
      next += RESAMPLE;
    }
    // Keep corners exactly: a vertex where the direction turns by more than 1e-3 rad.
    const before = path.vertices[index - 1]!;
    const at = path.vertices[index]!;
    const after = path.vertices[index + 1];
    if (after !== undefined) {
      const turn = Math.abs(
        Math.atan2(
          (at[0] - before[0]) * (after[1] - at[1]) - (at[1] - before[1]) * (after[0] - at[0]),
          (at[0] - before[0]) * (after[0] - at[0]) + (at[1] - before[1]) * (after[1] - at[1]),
        ),
      );
      if (turn > 1e-3) out.push(at);
    }
  }
  while (next < s1) {
    out.push(pointAt(path, next));
    next += RESAMPLE;
  }
  out.push(pointAt(path, s1));
  return out.filter(
    (point, index) =>
      index === 0 || point[0] !== out[index - 1]![0] || point[1] !== out[index - 1]![1],
  );
}

/** E24-K1 to K5: the dashes of a path, from their definitions. */
export function dashPath(
  verbs: readonly ScenePathVerb[],
  points: readonly number[],
  dash: SceneDash,
): OracleDash[] {
  const pattern = dash.pattern.length % 2 === 1 ? [...dash.pattern, ...dash.pattern] : dash.pattern;
  const period = pattern.reduce((sum, entry) => sum + entry, 0);
  let phase = dash.phase % period;
  if (phase < 0) phase += period;
  if (phase >= period) phase = 0;
  // On intervals of one period, with zero gaps joined.
  const on: Array<[number, number]> = [];
  let position = 0;
  for (let index = 0; index < pattern.length; index += 2) {
    const interval: [number, number] = [position, position + pattern[index]!];
    const last = on[on.length - 1];
    if (last !== undefined && last[1] === interval[0]) last[1] = interval[1];
    else on.push(interval);
    position += pattern[index]! + pattern[index + 1]!;
  }
  const dashes: OracleDash[] = [];
  for (const path of measure(verbs, points)) {
    const length = path.s[path.s.length - 1]!;
    const intervals: Array<[number, number]> = [];
    for (let m = -1; m * period - phase <= length; m += 1) {
      for (const [a, b] of on) {
        const lo = m * period - phase + a;
        const hi = m * period - phase + b;
        if (hi < 0 || lo > length) continue;
        const s0 = Math.max(0, lo);
        const s1 = Math.min(length, hi);
        const last = intervals[intervals.length - 1];
        if (last !== undefined && s0 <= last[1]) last[1] = Math.max(last[1], s1);
        else intervals.push([s0, s1]);
      }
    }
    if (length === 0) {
      if (intervals.length > 0) dashes.push({ points: [path.vertices[0]!] });
      continue;
    }
    if (intervals.length === 1 && intervals[0]![0] === 0 && intervals[0]![1] === length) {
      // A fully on subpath: the source, closed or open.
      dashes.push({ points: slice(path, 0, length), closed: path.closed });
      continue;
    }
    const seam =
      path.closed &&
      intervals.length >= 2 &&
      intervals[0]![0] === 0 &&
      intervals[intervals.length - 1]![1] === length;
    const first = seam ? 1 : 0;
    const last = seam ? intervals.length - 1 : intervals.length;
    for (let index = first; index < last; index += 1) {
      const [s0, s1] = intervals[index]!;
      dashes.push({ points: slice(path, s0, s1) });
    }
    if (seam) {
      const [a0] = intervals[intervals.length - 1]!;
      const [, b1] = intervals[0]!;
      dashes.push({ points: [...slice(path, a0, length), ...slice(path, 0, b1).slice(1)] });
    }
  }
  return dashes;
}

export type DashedStroke = Readonly<{
  paint: ScenePaint;
  width: number;
  cap: 'butt' | 'round' | 'square';
  dashes: readonly OracleDash[];
}>;

export type DashElement = Readonly<{
  world: Affine;
  /** Closed fill polygons (nonzero and evenodd agree on the fixtures), or null. */
  fill: Readonly<{ paint: ScenePaint; polygons: readonly (readonly number[])[] }> | null;
  stroke: DashedStroke | null;
  opacity: number;
}>;

type Coverage = 0 | 1 | null;

/** Coverage of one dash at local (x, y): 1 inside by more than `m`, 0 outside, else null. */
function dashCoverage(dash: OracleDash, stroke: DashedStroke, x: number, y: number, m: number) {
  const r = stroke.width / 2;
  const points = dash.points;
  const cap = dash.closed === true ? 'round' : stroke.cap;
  if (points.length === 1) {
    const [px, py] = points[0]!;
    if (stroke.cap === 'butt') return 0;
    // E24-K5: a disk of radius r, or a local-axis-aligned square of side w.
    const d =
      stroke.cap === 'round'
        ? Math.hypot(x - px, y - py)
        : Math.max(Math.abs(x - px), Math.abs(y - py));
    return d < r - m ? 1 : d > r + m ? 0 : null;
  }
  // The stroke of a polyline: a band of half-width r along each segment (no caps between
  // segments), a disk at each interior vertex (the round-join part of any join; a miter's extra
  // reach is left to nearCorner), and the cap at each end. A probe within the margin of an end's
  // cap plane is undecided.
  let best = Infinity;
  let undecided = false;
  let outsidePlanes = false;
  const last = points.length - 2;
  for (let index = 0; index <= last; index += 1) {
    const [ax, ay] = points[index]!;
    const [bx, by] = points[index + 1]!;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    const along = ((x - ax) * dx + (y - ay) * dy) / length;
    const across = Math.abs((-(x - ax) * dy + (y - ay) * dx) / length);
    const low = index === 0 && cap === 'square' ? -r : 0;
    const high = index === last && cap === 'square' ? length + r : length;
    if (along >= low && along <= high) best = Math.min(best, across);
    if (cap !== 'round' && ((index === 0 && along < low) || (index === last && along > high)))
      outsidePlanes = true;
    if (cap !== 'round' && across < r + m) {
      if (index === 0 && Math.abs(along - low) <= m) undecided = true;
      if (index === last && Math.abs(along - high) <= m) undecided = true;
    }
  }
  const first = cap === 'round' ? 0 : 1;
  const final = cap === 'round' ? points.length - 1 : points.length - 2;
  // Behind a butt or square end plane, the join disks near that end do not reach.
  for (let index = first; index <= final && !outsidePlanes; index += 1) {
    const [px, py] = points[index]!;
    best = Math.min(best, Math.hypot(x - px, y - py));
  }
  if (undecided) return null;
  return best < r - m ? 1 : best > r + m ? 0 : null;
}

/** True within `reach` of a corner whose miter could extend the stroke past distance r. */
function nearCorner(dash: OracleDash, x: number, y: number, reach: number): boolean {
  const points = dash.points;
  for (let index = 1; index + 1 < points.length; index += 1) {
    const [ax, ay] = points[index - 1]!;
    const [px, py] = points[index]!;
    const [bx, by] = points[index + 1]!;
    const cross = (px - ax) * (by - py) - (py - ay) * (bx - px);
    const dot = (px - ax) * (bx - px) + (py - ay) * (by - py);
    if (Math.abs(Math.atan2(cross, dot)) > 0.05 && Math.hypot(x - px, y - py) < reach) return true;
  }
  return false;
}

function evenOdd(polygons: readonly (readonly number[])[], x: number, y: number): boolean {
  let inside = false;
  for (const points of polygons) {
    const count = points.length / 2;
    for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
      const xi = points[index * 2]!;
      const yi = points[index * 2 + 1]!;
      const xj = points[previous * 2]!;
      const yj = points[previous * 2 + 1]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function edgeDistance(polygons: readonly (readonly number[])[], x: number, y: number): number {
  let best = Infinity;
  for (const points of polygons) {
    const count = points.length / 2;
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      const ax = points[index * 2]!;
      const ay = points[index * 2 + 1]!;
      const dx = points[next * 2]! - ax;
      const dy = points[next * 2 + 1]! - ay;
      const length = dx * dx + dy * dy;
      const t =
        length === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length));
      best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
  }
  return best;
}

function strokeCover(stroke: DashedStroke, x: number, y: number, m: number): Coverage {
  let result: Coverage = 0;
  for (const dash of stroke.dashes) {
    const coverage = dashCoverage(dash, stroke, x, y, m);
    if (coverage === 1) return 1;
    if (coverage === null) result = null;
    // A miter at a corner reaches up to r·√2 for the fixtures' right angles; leave it out.
    else if (nearCorner(dash, x, y, (stroke.width / 2) * Math.SQRT2 + m)) result = null;
  }
  return result;
}

/**
 * The expected 8-bit-scale RGB at world point (wx, wy) over black, in element order, or null
 * when the probe is within 2 physical px of any boundary. `pixelSize` is world units per
 * physical pixel.
 */
export function expectedDashAt(
  elements: readonly DashElement[],
  wx: number,
  wy: number,
  pixelSize: number,
): readonly [number, number, number] | null {
  let out: Premultiplied = [0, 0, 0, 1];
  for (const element of elements) {
    const inverse = invert(element.world);
    const [x, y] = transformPoint(inverse, wx, wy);
    const m = 2 * pixelSize * Math.hypot(inverse[0], inverse[1], inverse[2], inverse[3]);
    let fillCoverage: Coverage = 0;
    if (element.fill !== null) {
      fillCoverage =
        edgeDistance(element.fill.polygons, x, y) <= m
          ? null
          : evenOdd(element.fill.polygons, x, y)
            ? 1
            : 0;
    }
    const strokeCoverage = element.stroke === null ? 0 : strokeCover(element.stroke, x, y, m);
    if (fillCoverage === null || strokeCoverage === null) return null;
    if (fillCoverage === 0 && strokeCoverage === 0) continue;
    const fill = fillCoverage === 0 ? [0, 0, 0, 0] : paintAt(element.fill!.paint, x, y);
    const stroke = strokeCoverage === 0 ? [0, 0, 0, 0] : paintAt(element.stroke!.paint, x, y);
    const source = [0, 1, 2, 3].map(
      (lane) => (stroke[lane]! + fill[lane]! * (1 - stroke[3])) * element.opacity,
    );
    out = [0, 1, 2, 3].map(
      (lane) => source[lane]! + out[lane]! * (1 - source[3]!),
    ) as unknown as Premultiplied;
  }
  return [out[0] * 255, out[1] * 255, out[2] * 255];
}
