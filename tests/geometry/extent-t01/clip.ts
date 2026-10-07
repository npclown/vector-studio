import { add, compare, div, mul, sign, sub, ZERO, type Rational } from '../rounded-fill/exact.js';

/**
 * P3.1p T01 K1 exact clipping (docs/plans/p3-t01-extent-experiment-contract.md, "Clipping" and
 * "Ear rule"). Test-only, exact rational arithmetic, no tolerance.
 */

export type Q2 = readonly [Rational, Rational];

export type Cell = Readonly<{ x0: Rational; x1: Rational; y0: Rational; y1: Rational }>;

export function samePoint(left: Q2, right: Q2): boolean {
  return compare(left[0], right[0]) === 0 && compare(left[1], right[1]) === 0;
}

/** Twice the signed area of the ring (shoelace), exact. */
export function doubleArea(ring: readonly Q2[]): Rational {
  let total = ZERO;
  for (let index = 0; index < ring.length; index += 1) {
    const a = ring[index]!;
    const b = ring[(index + 1) % ring.length]!;
    total = add(total, sub(mul(a[0], b[1]), mul(a[1], b[0])));
  }
  return total;
}

export function cross3(a: Q2, b: Q2, c: Q2): Rational {
  return sub(mul(sub(b[0], a[0]), sub(c[1], a[1])), mul(sub(b[1], a[1]), sub(c[0], a[0])));
}

type Plane = Readonly<{ axis: 0 | 1; bound: Rational; keep: 1 | -1 }>;

function inside(point: Q2, plane: Plane): boolean {
  const order = compare(point[plane.axis], plane.bound);
  return plane.keep === 1 ? order >= 0 : order <= 0;
}

function crossing(from: Q2, to: Q2, plane: Plane): Q2 {
  const axis = plane.axis;
  const other = axis === 0 ? 1 : 0;
  const t = div(sub(plane.bound, from[axis]), sub(to[axis], from[axis]));
  const value = add(from[other], mul(t, sub(to[other], from[other])));
  return axis === 0 ? [plane.bound, value] : [value, plane.bound];
}

/** One Sutherland-Hodgman stage; the walk starts at the first vertex of `ring`. */
function clipStage(ring: readonly Q2[], plane: Plane): Q2[] {
  const output: Q2[] = [];
  if (ring.length === 0) return output;
  let previous = ring[ring.length - 1]!;
  let previousInside = inside(previous, plane);
  for (const current of ring) {
    const currentInside = inside(current, plane);
    if (currentInside) {
      if (!previousInside) output.push(crossing(previous, current, plane));
      output.push(current);
    } else if (previousInside) {
      output.push(crossing(previous, current, plane));
    }
    previous = current;
    previousInside = currentInside;
  }
  return output;
}

function removeConsecutiveDuplicates(ring: readonly Q2[]): Q2[] {
  const output: Q2[] = [];
  for (const point of ring)
    if (output.length === 0 || !samePoint(output[output.length - 1]!, point)) output.push(point);
  while (output.length > 1 && samePoint(output[0]!, output[output.length - 1]!)) output.pop();
  return output;
}

/**
 * Sutherland-Hodgman against x ≥ x0, x ≤ x1, y ≥ y0, y ≤ y1, in that order, starting from the
 * source triangle's first vertex. Winding is preserved, consecutive (and cyclic) duplicates are
 * removed, and fewer than 3 vertices or zero exact area yields [].
 */
export function exactClip(triangle: readonly [Q2, Q2, Q2], cell: Cell): Q2[] {
  const planes: readonly Plane[] = [
    { axis: 0, bound: cell.x0, keep: 1 },
    { axis: 0, bound: cell.x1, keep: -1 },
    { axis: 1, bound: cell.y0, keep: 1 },
    { axis: 1, bound: cell.y1, keep: -1 },
  ];
  let ring: Q2[] = [...triangle];
  for (const plane of planes) ring = clipStage(ring, plane);
  ring = removeConsecutiveDuplicates(ring);
  if (ring.length < 3 || sign(doubleArea(ring)) === 0) return [];
  return ring;
}

/**
 * Contract ear rule over a convex ring: repeatedly take the ear at the lowest ring position whose
 * triangle has strictly positive exact area (in the ring's winding), and whose removal leaves a
 * ring with area greater than 0 (in that winding) or a single triangle. Ear triangles are emitted
 * as (previous, position, next), in the ring's winding. Indices are local ring indices; every
 * vertex is kept. Throws if no ear qualifies (the ring is not a valid convex piece).
 */
export function earClip(ring: readonly Q2[]): [number, number, number][] {
  const orientation = sign(doubleArea(ring));
  if (ring.length < 3 || orientation === 0) return [];
  const positive = (value: Rational) => sign(value) === orientation;
  const live = ring.map((_, index) => index);
  const triangles: [number, number, number][] = [];
  while (live.length > 3) {
    let chosen = -1;
    for (let position = 0; position < live.length; position += 1) {
      const previous = live[(position + live.length - 1) % live.length]!;
      const current = live[position]!;
      const next = live[(position + 1) % live.length]!;
      if (!positive(cross3(ring[previous]!, ring[current]!, ring[next]!))) continue;
      const rest = live.filter((_, index) => index !== position).map((index) => ring[index]!);
      if (!positive(doubleArea(rest))) continue;
      chosen = position;
      triangles.push([previous, current, next]);
      break;
    }
    if (chosen < 0) throw new Error('earClip: no ear qualifies');
    live.splice(chosen, 1);
  }
  const [a, b, c] = live as [number, number, number];
  if (!positive(cross3(ring[a]!, ring[b]!, ring[c]!)))
    throw new Error('earClip: final triangle has no positive area');
  triangles.push([a, b, c]);
  return triangles;
}
