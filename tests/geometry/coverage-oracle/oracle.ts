import { sqrtUp } from '../position-certificate/certificate.js';
import { sqrtDown } from '../position-certificate/wedge.js';
import { add, compare, rational, type Rational } from '../rounded-fill/exact.js';
import type { Crop } from './crop.js';
import { ceilDiv, floorDiv } from './numeric.js';
import type { CoverageRowGeometry } from './positions.js';

/**
 * P3.1o O01 exact per-pixel reference coverage, pixel classes and boundary length
 * (docs/plans/p3-o01-coverage-experiment-contract.md, "Crop, oracle and metrics").
 *
 * All coordinates are the row's preimage scaled by S = 2^k to integers (positions.ts), so pixel
 * boundaries are multiples of S and pixel centers are odd multiples of S / 2.
 *
 * 1. Crossing pixels: every pixel whose closed square touches a boundary segment, by exact segment
 *    traversal over the crop (a superset of pixels whose open square the boundary crosses).
 * 2. Every other pixel takes inside/outside from exact row-span parity at the row center with the
 *    half-open rule min(y) <= yc < max(y); horizontal edges never count.
 * 3. Crossing pixels get the exact area of the union by clipping each overlapping triangle to the
 *    pixel square. Overlapping triangles are found by traversing every mesh edge (internal edges
 *    included) and attaching the edge's triangles to every pixel the edge touches.
 *
 * The reference coverage is an exact rational. It is dyadic only when every clipped vertex is (an
 * edge with a non-dyadic slope gives non-dyadic intersection coordinates).
 */

export const CLASS_INTERIOR = 0;
export const CLASS_EXTERIOR = 1;
export const CLASS_BAND = 2;

export type LengthBound = Readonly<{ lower: Rational; upper: Rational }>;

export type CoverageOracle = Readonly<{
  crop: Crop;
  /** Parity inside flag of every crop pixel (meaningful for non-crossing pixels). */
  inside: Uint8Array;
  /** Exact reference coverage of crossing pixels, keyed by row-major crop index. */
  crossing: ReadonlyMap<number, Rational>;
  /** CLASS_INTERIOR / CLASS_EXTERIOR / CLASS_BAND per crop pixel. */
  classes: Uint8Array;
  /** 1 for band pixels within 2 px (squared distance < 4) of a boundary vertex. */
  corner: Uint8Array;
  /** 1 for interior pixels whose closed square meets an internal edge. */
  seam: Uint8Array;
  /**
   * Length of boundary within V' (viewport inset by 3 px): sum over boundary segments of
   * sqrtDown / sqrtUp (2^-64 resolution) of the exact squared clipped length.
   */
  boundaryLength: LengthBound;
  /** True when some boundary segment has a positive-length part inside V'. */
  boundaryInInset: boolean;
}>;

type P = readonly [bigint, bigint];

/** Visit every crop pixel within Chebyshev distance r (pixels) of the closed segment AB. */
export function traverseSegment(
  start: P,
  end: P,
  S: bigint,
  crop: Crop,
  r: number,
  visit: (i: number, j: number) => void,
): void {
  const [A, B] = start[0] <= end[0] ? [start, end] : [end, start];
  const rS = BigInt(r) * S;
  const cx0 = BigInt(crop.x);
  const cx1 = BigInt(crop.x + crop.w - 1);
  const cy0 = BigInt(crop.y);
  const cy1 = BigInt(crop.y + crop.h - 1);
  let iLo = ceilDiv(A[0] - rS, S) - 1n;
  let iHi = floorDiv(B[0] + rS, S);
  if (iLo < cx0) iLo = cx0;
  if (iHi > cx1) iHi = cx1;
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  for (let i = iLo; i <= iHi; i += 1n) {
    let yLow: bigint;
    let yHigh: bigint;
    let den: bigint;
    if (dx === 0n) {
      den = 1n;
      yLow = A[1] < B[1] ? A[1] : B[1];
      yHigh = A[1] < B[1] ? B[1] : A[1];
    } else {
      const left = (i - BigInt(r)) * S;
      const right = (i + 1n + BigInt(r)) * S;
      const xa = A[0] > left ? A[0] : left;
      const xb = B[0] < right ? B[0] : right;
      if (xa > xb) continue;
      den = dx;
      const ya = A[1] * dx + dy * (xa - A[0]);
      const yb = A[1] * dx + dy * (xb - A[0]);
      yLow = ya < yb ? ya : yb;
      yHigh = ya < yb ? yb : ya;
    }
    let jLo = ceilDiv(yLow - rS * den, S * den) - 1n;
    let jHi = floorDiv(yHigh + rS * den, S * den);
    if (jLo < cy0) jLo = cy0;
    if (jHi > cy1) jHi = cy1;
    for (let j = jLo; j <= jHi; j += 1n) visit(Number(i), Number(j));
  }
}

// ---------------------------------------------------------------------------------------------
// Exact clipping of a triangle to an axis-aligned square with line-labelled edges, so every
// intersection is computed from an original segment (no denominator growth).

type HP = Readonly<{ x: bigint; y: bigint; w: bigint }>;
type Label =
  | Readonly<{ kind: 'seg'; a: P; b: P }>
  | Readonly<{ kind: 'v'; at: bigint }>
  | Readonly<{ kind: 'h'; at: bigint }>;
type Plane = Readonly<{ axis: 'x' | 'y'; at: bigint; keepAbove: boolean }>;

function side(point: HP, plane: Plane): number {
  const coordinate = plane.axis === 'x' ? point.x : point.y;
  const value = coordinate - plane.at * point.w;
  const signed = plane.keepAbove ? value : -value;
  return signed > 0n ? 1 : signed < 0n ? -1 : 0;
}

function intersect(label: Label, plane: Plane): HP {
  if (label.kind === 'v') return { x: label.at, y: plane.at, w: 1n };
  if (label.kind === 'h') return { x: plane.at, y: label.at, w: 1n };
  const { a, b } = label;
  let point: HP;
  if (plane.axis === 'x') {
    const w = b[0] - a[0];
    point = { x: plane.at * w, y: a[1] * w + (b[1] - a[1]) * (plane.at - a[0]), w };
  } else {
    const w = b[1] - a[1];
    point = { x: a[0] * w + (b[0] - a[0]) * (plane.at - a[1]), y: plane.at * w, w };
  }
  return point.w < 0n ? { x: -point.x, y: -point.y, w: -point.w } : point;
}

function clipPlane(points: HP[], labels: Label[], plane: Plane): [HP[], Label[]] {
  const outPoints: HP[] = [];
  const outLabels: Label[] = [];
  const planeLabel: Label =
    plane.axis === 'x' ? { kind: 'v', at: plane.at } : { kind: 'h', at: plane.at };
  for (let index = 0; index < points.length; index += 1) {
    const p = points[index]!;
    const q = points[(index + 1) % points.length]!;
    const label = labels[index]!;
    const sp = side(p, plane);
    const sq = side(q, plane);
    if (sp >= 0) {
      outPoints.push(p);
      outLabels.push(sp === 0 && sq < 0 ? planeLabel : label);
    }
    if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
      outPoints.push(intersect(label, plane));
      outLabels.push(sp > 0 ? planeLabel : label);
    }
  }
  return [outPoints, outLabels];
}

/** Twice the absolute area of triangle (a, b, c) clipped to [x0,x1] x [y0,y1], exact. */
export function clippedTwiceArea(
  a: P,
  b: P,
  c: P,
  x0: bigint,
  x1: bigint,
  y0: bigint,
  y1: bigint,
): Rational {
  let points: HP[] = [a, b, c].map(([x, y]) => ({ x, y, w: 1n }));
  let labels: Label[] = [
    { kind: 'seg', a, b },
    { kind: 'seg', a: b, b: c },
    { kind: 'seg', a: c, b: a },
  ];
  for (const plane of [
    { axis: 'x', at: x0, keepAbove: true },
    { axis: 'x', at: x1, keepAbove: false },
    { axis: 'y', at: y0, keepAbove: true },
    { axis: 'y', at: y1, keepAbove: false },
  ] as const) {
    [points, labels] = clipPlane(points, labels, plane);
    if (points.length < 3) return rational(0n);
  }
  let n = 0n;
  let d = 1n;
  for (let index = 0; index < points.length; index += 1) {
    const p = points[index]!;
    const q = points[(index + 1) % points.length]!;
    const termN = p.x * q.y - q.x * p.y;
    const termD = p.w * q.w;
    if (termN === 0n) continue;
    if (termD === d) n += termN;
    else {
      n = n * termD + termN * d;
      d *= termD;
    }
  }
  return rational(n < 0n ? -n : n, d);
}

// ---------------------------------------------------------------------------------------------
// Exact squared distances in scaled units.

function pointBoxSquared(p: P, x0: bigint, x1: bigint, y0: bigint, y1: bigint): bigint {
  const dx = p[0] < x0 ? x0 - p[0] : p[0] > x1 ? p[0] - x1 : 0n;
  const dy = p[1] < y0 ? y0 - p[1] : p[1] > y1 ? p[1] - y1 : 0n;
  return dx * dx + dy * dy;
}

/** True when dist(p, segment ab)^2 < limit (all scaled units). */
function pointSegmentBelow(p: P, a: P, b: P, limit: bigint): boolean {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = p[0] - a[0];
  const vy = p[1] - a[1];
  const dot = vx * ux + vy * uy;
  const length2 = ux * ux + uy * uy;
  if (dot <= 0n) return vx * vx + vy * vy < limit;
  if (dot >= length2) {
    const wx = p[0] - b[0];
    const wy = p[1] - b[1];
    return wx * wx + wy * wy < limit;
  }
  return (vx * vx + vy * vy) * length2 - dot * dot < limit * length2;
}

/**
 * True when the squared distance between the closed square and the closed segment is < limit,
 * given that the segment does not touch the square.
 */
function boxSegmentBelowDisjoint(
  a: P,
  b: P,
  x0: bigint,
  x1: bigint,
  y0: bigint,
  y1: bigint,
  limit: bigint,
): boolean {
  if (pointBoxSquared(a, x0, x1, y0, y1) < limit) return true;
  if (pointBoxSquared(b, x0, x1, y0, y1) < limit) return true;
  for (const corner of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as const)
    if (pointSegmentBelow(corner, a, b, limit)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------
// Boundary length inside V'.

const ZERO = rational(0n);
const ONE = rational(1n);

function clipParameter(a: P, b: P, x0: bigint, x1: bigint, y0: bigint, y1: bigint) {
  let t0 = ZERO;
  let t1 = ONE;
  for (const [start, delta, low, high] of [
    [a[0], b[0] - a[0], x0, x1],
    [a[1], b[1] - a[1], y0, y1],
  ] as const) {
    if (delta === 0n) {
      if (start < low || start > high) return null;
      continue;
    }
    let ta = rational(low - start, delta);
    let tb = rational(high - start, delta);
    if (compare(ta, tb) > 0) [ta, tb] = [tb, ta];
    if (compare(ta, t0) > 0) t0 = ta;
    if (compare(tb, t1) < 0) t1 = tb;
  }
  return compare(t0, t1) < 0 ? ([t0, t1] as const) : null;
}

export function boundaryLengthInInset(
  geometry: CoverageRowGeometry,
  inset = 3,
): { bound: LengthBound; positive: boolean } {
  const S = 1n << BigInt(geometry.scaleExponent);
  const x0 = BigInt(inset) * S;
  const x1 = BigInt(geometry.width - inset) * S;
  const y0 = BigInt(inset) * S;
  const y1 = BigInt(geometry.height - inset) * S;
  let lower = ZERO;
  let upper = ZERO;
  let positive = false;
  if (x0 > x1 || y0 > y1) return { bound: { lower, upper }, positive };
  for (const edge of geometry.boundaryEdges) {
    const a = geometry.scaled[edge.a]!;
    const b = geometry.scaled[edge.b]!;
    const range = clipParameter(a, b, x0, x1, y0, y1);
    if (range === null) continue;
    positive = true;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const span = rational(
      range[1].n * range[0].d - range[0].n * range[1].d,
      range[0].d * range[1].d,
    );
    const squared = rational(span.n * span.n * (dx * dx + dy * dy), span.d * span.d * S * S);
    lower = add(lower, sqrtDown(squared));
    upper = add(upper, sqrtUp(squared));
  }
  return { bound: { lower, upper }, positive };
}

// ---------------------------------------------------------------------------------------------

export function coverageOracle(geometry: CoverageRowGeometry, crop: Crop): CoverageOracle {
  const S = 1n << BigInt(geometry.scaleExponent);
  const half = S >> 1n;
  const { w, h } = crop;
  const total = w * h;
  const at = (i: number, j: number) => (j - crop.y) * w + (i - crop.x);
  const points = geometry.scaled;
  const boundary = geometry.boundaryEdges.map(
    (edge) => [points[edge.a]!, points[edge.b]!] as const,
  );

  // 1. Crossing pixels.
  const crossingTriangles = new Map<number, Set<number>>();
  for (const [a, b] of boundary)
    traverseSegment(a, b, S, crop, 0, (i, j) => {
      const index = at(i, j);
      if (!crossingTriangles.has(index)) crossingTriangles.set(index, new Set());
    });

  // 2. Parity spans at row centers.
  const inside = new Uint8Array(total);
  const toggles = new Int32Array(w + 1);
  for (let j = crop.y; j < crop.y + h; j += 1) {
    toggles.fill(0);
    let initial = 0;
    const yc = BigInt(2 * j + 1) * half;
    for (const [a, b] of boundary) {
      const low = a[1] < b[1] ? a[1] : b[1];
      const high = a[1] < b[1] ? b[1] : a[1];
      if (!(low <= yc && yc < high)) continue;
      let den = b[1] - a[1];
      let xNum = a[0] * den + (b[0] - a[0]) * (yc - a[1]);
      if (den < 0n) {
        den = -den;
        xNum = -xNum;
      }
      // The crossing counts for pixel i when x < i + 1/2, i.e. i >= floor(x - 1/2) + 1.
      const first = floorDiv(2n * xNum - S * den, 2n * S * den) + 1n;
      if (first <= BigInt(crop.x)) initial ^= 1;
      else if (first < BigInt(crop.x + w)) toggles[Number(first) - crop.x]! ^= 1;
    }
    let parity = initial;
    const row = (j - crop.y) * w;
    for (let i = 0; i < w; i += 1) {
      parity ^= toggles[i]!;
      inside[row + i] = parity;
    }
  }

  // 3. Overlapping triangles of crossing pixels by traversing every mesh edge, then exact areas.
  const attach = (p: number, q: number, triangles: readonly number[]) =>
    traverseSegment(points[p]!, points[q]!, S, crop, 0, (i, j) => {
      const set = crossingTriangles.get(at(i, j));
      if (set) for (const triangle of triangles) set.add(triangle);
    });
  for (const edge of geometry.boundaryEdges) attach(edge.a, edge.b, [edge.triangle]);
  for (const edge of geometry.internalEdges) attach(edge.a, edge.b, edge.triangles);
  const crossing = new Map<number, Rational>();
  const pixelArea = S * S * 2n;
  for (const index of [...crossingTriangles.keys()].sort((x, y) => x - y)) {
    const i = BigInt(crop.x + (index % w));
    const j = BigInt(crop.y + Math.floor(index / w));
    let sum = ZERO;
    for (const t of [...crossingTriangles.get(index)!].sort((x, y) => x - y)) {
      const [p, q, r] = geometry.triangles[t]!;
      sum = add(
        sum,
        clippedTwiceArea(
          points[p]!,
          points[q]!,
          points[r]!,
          i * S,
          (i + 1n) * S,
          j * S,
          (j + 1n) * S,
        ),
      );
    }
    crossing.set(index, rational(sum.n, sum.d * pixelArea));
  }

  // Classes.
  const classes = new Uint8Array(total);
  for (let index = 0; index < total; index += 1)
    classes[index] = inside[index] ? CLASS_INTERIOR : CLASS_EXTERIOR;
  for (const index of crossing.keys()) classes[index] = CLASS_BAND;
  const limit = 4n * S * S;
  for (const [a, b] of boundary)
    traverseSegment(a, b, S, crop, 2, (i, j) => {
      const index = at(i, j);
      if (classes[index] === CLASS_BAND) return;
      const x0 = BigInt(i) * S;
      const y0 = BigInt(j) * S;
      if (boxSegmentBelowDisjoint(a, b, x0, x0 + S, y0, y0 + S, limit)) classes[index] = CLASS_BAND;
    });
  const corner = new Uint8Array(total);
  const boundaryVertices = [...new Set(geometry.boundaryEdges.flatMap((edge) => [edge.a, edge.b]))];
  for (const vertex of boundaryVertices) {
    const p = points[vertex]!;
    traverseSegment(p, p, S, crop, 2, (i, j) => {
      const index = at(i, j);
      const x0 = BigInt(i) * S;
      const y0 = BigInt(j) * S;
      if (classes[index] === CLASS_BAND && pointBoxSquared(p, x0, x0 + S, y0, y0 + S) < limit)
        corner[index] = 1;
    });
  }
  const seam = new Uint8Array(total);
  for (const edge of geometry.internalEdges)
    traverseSegment(points[edge.a]!, points[edge.b]!, S, crop, 0, (i, j) => {
      const index = at(i, j);
      if (classes[index] === CLASS_INTERIOR) seam[index] = 1;
    });

  const length = boundaryLengthInInset(geometry);
  return {
    crop,
    inside,
    crossing,
    classes,
    corner,
    seam,
    boundaryLength: length.bound,
    boundaryInInset: length.positive,
  };
}

/** Exact reference coverage of crop pixel `index`. */
export function referenceAt(oracle: CoverageOracle, index: number): Rational {
  return oracle.crossing.get(index) ?? (oracle.inside[index] ? ONE : ZERO);
}
