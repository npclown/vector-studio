import type { SceneColor, SceneGradient, ScenePaint } from '@vector-studio/contracts';

import { invert, transformPoint, type Affine } from './p4-clip-oracle.js';

// E23 contract (docs/plans/d9-e23-gradient-paint-contract.md), unit U4: the CPU oracle of
// section 3. E23-K1 to K3 are evaluated in binary64 from the scene; K4 composes the paint into
// P1's local composition and over the page's opaque black background. Geometry is classified
// with a physical-pixel margin, so a probe is either interior (every coverage is 0 or 1, and no
// hard stop or seam within 1 px) or skipped: the oracle claims nothing on a coverage ramp. Edge probes are placed by the spec
// where the analytic coverage is exactly 0.5.

export type Premultiplied = readonly [number, number, number, number];

const isGradient = (paint: ScenePaint): paint is SceneGradient => 'kind' in paint;

const premultiply = (color: SceneColor): Premultiplied => [
  color.r * color.a,
  color.g * color.a,
  color.b * color.a,
  color.a,
];

/** E23-K2: the spread of `t`. */
export function spread(t: number, mode: SceneGradient['spread']): number {
  if (mode === 'pad') return Math.min(1, Math.max(0, t));
  if (mode === 'repeat') return t - Math.floor(t);
  const u = t - 2 * Math.floor(t / 2);
  return 1 - Math.abs(u - 1);
}

/** E23-K3: the premultiplied stop lookup at `t'`. */
export function stopLookup(stops: SceneGradient['stops'], t: number): Premultiplied {
  const first = stops[0]!;
  const last = stops.at(-1)!;
  if (t < first.offset) return premultiply(first.color);
  if (t >= last.offset) return premultiply(last.color);
  let index = 0;
  for (const [candidate, stop] of stops.entries()) if (stop.offset <= t) index = candidate;
  const lower = stops[index]!;
  const upper = stops[index + 1]!;
  const weight = (t - lower.offset) / (upper.offset - lower.offset);
  const a = premultiply(lower.color);
  const b = premultiply(upper.color);
  return [0, 1, 2, 3].map(
    (lane) => a[lane]! + weight * (b[lane]! - a[lane]!),
  ) as unknown as Premultiplied;
}

/** E23-K1 to K3: a paint's premultiplied value at local point `(x, y)` of its node. */
export function paintAt(paint: ScenePaint, x: number, y: number): Premultiplied {
  if (!isGradient(paint)) return premultiply(paint);
  const [gx, gy] = transformPoint(invert(paint.transform), x, y);
  const t = paint.kind === 'radial' ? Math.hypot(gx, gy) : gx;
  return stopLookup(paint.stops, spread(t, paint.spread));
}

/** A gradient's raw `t` at local point `(x, y)` (E23-K1). */
function rawT(gradient: SceneGradient, x: number, y: number): number {
  const [gx, gy] = transformPoint(invert(gradient.transform), x, y);
  return gradient.kind === 'radial' ? Math.hypot(gx, gy) : gx;
}

/**
 * True when a hard stop, or a `repeat` or `reflect` seam, lies within 1 physical pixel of the
 * probe: the contract's interior probes keep that distance (section 6).
 */
function nearDiscontinuity(
  paint: ScenePaint,
  world: Affine,
  wx: number,
  wy: number,
  pixelSize: number,
): boolean {
  if (!isGradient(paint)) return false;
  const local = invert(world);
  const values = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].map(([dx, dy]) => {
    const [x, y] = transformPoint(local, wx + dx! * pixelSize, wy + dy! * pixelSize);
    return rawT(paint, x, y);
  });
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (paint.spread !== 'pad' && Math.floor(low) !== Math.floor(high)) return true;
  if (paint.spread !== 'pad' && Number.isInteger(low)) return true;
  const ends = [spread(low, paint.spread), spread(high, paint.spread)];
  const lower = Math.min(...ends);
  const upper = Math.max(...ends);
  return paint.stops.some(
    (stop, index) =>
      index > 0 &&
      stop.offset === paint.stops[index - 1]!.offset &&
      stop.offset >= lower &&
      stop.offset <= upper,
  );
}

export type OracleShape =
  | Readonly<{ kind: 'rectangle'; width: number; height: number }>
  | Readonly<{ kind: 'ellipse'; width: number; height: number }>
  | Readonly<{ kind: 'line'; x1: number; y1: number; x2: number; y2: number }>
  /** Closed polygons (cubics flattened by the caller), filled `evenodd`. */
  | Readonly<{ kind: 'path'; polygons: readonly (readonly number[])[] }>;

/** A region in some frame: a coverage of 1 inside, 0 outside. */
export type OracleRegion = Readonly<{ world: Affine; shape: OracleShape }>;

export type OracleElement = Readonly<{
  world: Affine;
  shape: OracleShape;
  fill: ScenePaint | null;
  stroke: Readonly<{ paint: ScenePaint; width: number }> | null;
  opacity: number;
  /** Clip rects and mask sources the element is drawn under (P4), each 1 inside and 0 outside. */
  under?: readonly OracleRegion[];
}>;

/** 1 inside, 0 outside, null within `margin` of the boundary (local units). */
type Coverage = 0 | 1 | null;

const band = (distance: number, half: number, margin: number): Coverage =>
  distance < half - margin ? 1 : distance > half + margin ? 0 : null;

function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / length));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function polygonsDistance(polygons: readonly (readonly number[])[], x: number, y: number) {
  let best = Infinity;
  for (const points of polygons) {
    const count = points.length / 2;
    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count;
      best = Math.min(
        best,
        segmentDistance(
          x,
          y,
          points[index * 2]!,
          points[index * 2 + 1]!,
          points[next * 2]!,
          points[next * 2 + 1]!,
        ),
      );
    }
  }
  return best;
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

/** Area coverage (fill) of a shape at local `(x, y)`. */
function areaCoverage(shape: OracleShape, x: number, y: number, margin: number): Coverage {
  switch (shape.kind) {
    case 'rectangle': {
      const inside = Math.min(x, y, shape.width - x, shape.height - y);
      return inside > margin ? 1 : inside < -margin ? 0 : null;
    }
    case 'ellipse': {
      const rx = shape.width / 2;
      const ry = shape.height / 2;
      const at = (grow: number) => ((x - rx) / (rx + grow)) ** 2 + ((y - ry) / (ry + grow)) ** 2;
      return at(-margin) < 1 ? 1 : at(margin) > 1 ? 0 : null;
    }
    case 'line':
      return 0;
    case 'path': {
      if (polygonsDistance(shape.polygons, x, y) <= margin) return null;
      return evenOdd(shape.polygons, x, y) ? 1 : 0;
    }
  }
}

/** Centred stroke coverage of width `width` at local `(x, y)`. */
function strokeCoverage(shape: OracleShape, width: number, x: number, y: number, margin: number) {
  switch (shape.kind) {
    case 'rectangle': {
      const outline = [0, 0, shape.width, 0, shape.width, shape.height, 0, shape.height];
      return band(polygonsDistance([outline], x, y), width / 2, margin);
    }
    case 'line': {
      // P1 line: a box of the segment's length and the stroke width (butt ends).
      const dx = shape.x2 - shape.x1;
      const dy = shape.y2 - shape.y1;
      const length = Math.hypot(dx, dy);
      const along = ((x - shape.x1) * dx + (y - shape.y1) * dy) / length;
      const across = Math.abs((-(x - shape.x1) * dy + (y - shape.y1) * dx) / length);
      const box = Math.max(Math.max(-along, along - length), across - width / 2);
      return box < -margin ? 1 : box > margin ? 0 : null;
    }
    case 'path':
      return band(polygonsDistance(shape.polygons, x, y), width / 2, margin);
    case 'ellipse':
      throw new Error('The E23 fixtures stroke no ellipse.');
  }
}

/** The local margin of `pixels` physical pixels: a bound through the inverse's linear part. */
function localMargin(world: Affine, pixels: number, pixelSize: number): number {
  const [a, b, c, d] = invert(world);
  return pixels * pixelSize * Math.hypot(a, b, c, d);
}

function regionCoverage(region: OracleRegion, wx: number, wy: number, pixelSize: number) {
  const [x, y] = transformPoint(invert(region.world), wx, wy);
  return areaCoverage(region.shape, x, y, localMargin(region.world, 2, pixelSize));
}

/**
 * The expected 8-bit-scale RGB at world point `(wx, wy)` over black, in element order, or null
 * when any coverage is within 2 physical px of a boundary. `pixelSize` is world units per
 * physical pixel, `1 / (zoom · DPR)`.
 */
export function expectedAt(
  elements: readonly OracleElement[],
  wx: number,
  wy: number,
  pixelSize: number,
): readonly [number, number, number] | null {
  let out: Premultiplied = [0, 0, 0, 1];
  for (const element of elements) {
    let gate = 1;
    for (const region of element.under ?? []) {
      const coverage = regionCoverage(region, wx, wy, pixelSize);
      if (coverage === null) return null;
      gate *= coverage;
    }
    const [x, y] = transformPoint(invert(element.world), wx, wy);
    const margin = localMargin(element.world, 2, pixelSize);
    const fillCoverage = element.fill === null ? 0 : areaCoverage(element.shape, x, y, margin);
    const strokeCover =
      element.stroke === null
        ? 0
        : strokeCoverage(element.shape, element.stroke.width, x, y, margin);
    if (gate === 0) continue;
    if (fillCoverage === null || strokeCover === null) return null;
    if (fillCoverage === 0 && strokeCover === 0) continue;
    if (
      (fillCoverage === 1 && nearDiscontinuity(element.fill!, element.world, wx, wy, pixelSize)) ||
      (strokeCover === 1 &&
        nearDiscontinuity(element.stroke!.paint, element.world, wx, wy, pixelSize))
    ) {
      return null;
    }
    const fill = fillCoverage === 0 ? [0, 0, 0, 0] : paintAt(element.fill!, x, y);
    const stroke = strokeCover === 0 ? [0, 0, 0, 0] : paintAt(element.stroke!.paint, x, y);
    const source = [0, 1, 2, 3].map(
      (lane) => (stroke[lane]! + fill[lane]! * (1 - stroke[3])) * element.opacity,
    );
    out = [0, 1, 2, 3].map(
      (lane) => source[lane]! + out[lane]! * (1 - source[3]!),
    ) as unknown as Premultiplied;
  }
  return [out[0] * 255, out[1] * 255, out[2] * 255];
}

/** Flattens `move`, `line`, `cubic` and `close` verbs into closed polygons. */
export function flattenPath(
  verbs: readonly string[],
  points: readonly number[],
  steps = 64,
): number[][] {
  const polygons: number[][] = [];
  let current: number[] = [];
  let cursor = 0;
  for (const verb of verbs) {
    if (verb === 'move') {
      if (current.length > 0) polygons.push(current);
      current = [points[cursor]!, points[cursor + 1]!];
      cursor += 2;
    } else if (verb === 'line') {
      current.push(points[cursor]!, points[cursor + 1]!);
      cursor += 2;
    } else if (verb === 'cubic') {
      const x0 = current.at(-2)!;
      const y0 = current.at(-1)!;
      const [x1, y1, x2, y2, x3, y3] = points.slice(cursor, cursor + 6) as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const u = 1 - t;
        current.push(
          u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        );
      }
      cursor += 6;
    } else if (verb === 'close') {
      polygons.push(current);
      current = [];
    }
  }
  if (current.length > 0) polygons.push(current);
  return polygons;
}
