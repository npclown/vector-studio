import { roundExact32, roundExact64 } from '../mesh-projection/audit.js';
import type { ProjectionInput } from '../mesh-projection/model.js';
import { add, compare, div, mul, rational, sub, type Rational } from '../rounded-fill/exact.js';
import { ceilDiv, dyadicExponent, f32Bits, floorDiv, q32Bits, q64 } from './numeric.js';
import { referencePositions, type CoverageRowGeometry, type Q2 } from './positions.js';

/**
 * P3.1o O02 exterior geometry (docs/plans/p3-o02-a5-coverage-contract.md, "Corners at a vertex",
 * "Drawn geometry and partition"). Test-only exact arithmetic on the preimage of the submitted f32
 * NDC words. Coordinates are physical px, y down; cross(a, b) = a.x b.y - a.y b.x and "left" or
 * "counterclockwise" means positive cross.
 *
 * - vertexSectors: boundary edges oriented with the region on the left (decided by the owning
 *   triangle's third vertex), rays at each boundary vertex sorted by exact angle, every outgoing ray
 *   paired with the next counterclockwise ray, which must be a reversed incoming edge.
 * - frameFor: the boundary's physical bounding box +-2 px rounded outward to integer px, mapped to
 *   local space by the exact inverse of K and rounded to binary64, then projected exactly like the
 *   region vertices (positions.ts). checkFrame: exact non-inverted and 1.5-px containment checks.
 * - triangulateComplement: boundary loops traced with sector pairing, nested by midpoint
 *   point-in-polygon, faces (frame minus top-level loops; pocket minus islands) merged by bridges
 *   (holes in descending max x; the visible pair (hole vertex, chain vertex) of distinct coordinates
 *   at minimal exact distance, ties to the lower hole then chain index) and ear-clipped.
 * - checkPartition: the exact partition check over region and exterior triangles.
 *
 * Status precedence inside exteriorMesh: FRAME_DEFERRED, VERTEX_UNSUPPORTED, then
 * EXTERIOR_NONCONFORMING (sectors, frame checks, triangulation, partition, in that order).
 */

export type P = readonly [bigint, bigint];
export type Triangle = readonly [number, number, number];

export type ExteriorStatus = 'FRAME_DEFERRED' | 'VERTEX_UNSUPPORTED' | 'EXTERIOR_NONCONFORMING';
export type ExteriorFailure = Readonly<{ status: ExteriorStatus; reason: string }>;

/** A boundary edge oriented with the region on its left; `edge` indexes geometry.boundaryEdges. */
export type DirectedEdge = Readonly<{ from: number; to: number; edge: number }>;

/**
 * One region sector at a vertex v: the counterclockwise sweep from the outgoing ray rOut = [v, w]
 * to the reversed incoming ray of rIn = [u, v]. `reflex` is true when the sweep is 180 deg or more.
 */
export type Sector = Readonly<{
  rOut: readonly [number, number];
  rIn: readonly [number, number];
  reflex: boolean;
}>;
export type VertexSectors = Readonly<{ vertex: number; sectors: readonly Sector[] }>;

export type SectorsResult =
  | Readonly<{
      status: 'OK';
      /** Oriented boundary edges, in geometry.boundaryEdges order. */
      directed: readonly DirectedEdge[];
      /** Boundary vertices ascending; sectors in angle order of rOut (from angle 0, ccw). */
      vertices: readonly VertexSectors[];
    }>
  | ExteriorFailure;

const MAX_SECTORS = 3;
export const FRAME_MARGIN = 2;
export const FRAME_DEFERRED_LIMIT = 1024;

const fail = (status: ExteriorStatus, reason: string): ExteriorFailure => ({
  status,
  reason: `${status}:${reason}`,
});
const nonconforming = (reason: string) => fail('EXTERIOR_NONCONFORMING', reason);

// ---------------------------------------------------------------------------------------------
// Exact integer predicates.

export function cross(ax: bigint, ay: bigint, bx: bigint, by: bigint): bigint {
  return ax * by - ay * bx;
}

export function orient(p: P, q: P, r: P): bigint {
  return cross(q[0] - p[0], q[1] - p[1], r[0] - p[0], r[1] - p[1]);
}

const same = (a: P, b: P) => a[0] === b[0] && a[1] === b[1];

/** 0 for angles in [0, 180) deg (y > 0, or y = 0 and x > 0), 1 for [180, 360). */
function halfPlane(d: P): number {
  return d[1] > 0n || (d[1] === 0n && d[0] > 0n) ? 0 : 1;
}

/** Exact angle order of nonzero directions; 0 only for equal directions. */
export function compareAngle(a: P, b: P): number {
  const ha = halfPlane(a);
  const hb = halfPlane(b);
  if (ha !== hb) return ha - hb;
  const c = cross(a[0], a[1], b[0], b[1]);
  return c > 0n ? -1 : c < 0n ? 1 : 0;
}

/** True when the ccw sweep from direction a to direction b is 180 deg or more (b != a). */
export function isReflex(a: P, b: P): boolean {
  const c = cross(a[0], a[1], b[0], b[1]);
  if (c !== 0n) return c < 0n;
  return a[0] * b[0] + a[1] * b[1] < 0n;
}

/**
 * True when direction d lies strictly inside the ccw sweep from a to b: below 180 deg both strict
 * cross tests hold; at 180 deg or more NOT (both cross tests are <= 0). The contract's sector test.
 */
export function inSweep(a: P, b: P, d: P, reflex = isReflex(a, b)): boolean {
  const c1 = cross(a[0], a[1], d[0], d[1]);
  const c2 = cross(d[0], d[1], b[0], b[1]);
  if (!reflex) return c1 > 0n && c2 > 0n;
  const ab = cross(a[0], a[1], b[0], b[1]);
  if (ab === 0n && a[0] * b[0] + a[1] * b[1] > 0n)
    // A full 360 deg sweep (a and b coincide): everything but the ray itself.
    return !(c1 === 0n && a[0] * d[0] + a[1] * d[1] > 0n);
  return !(c1 <= 0n && c2 <= 0n);
}

/** For p collinear with a and b: true when p lies on the closed segment ab. */
function onSegment(a: P, b: P, p: P): boolean {
  return (
    p[0] >= (a[0] < b[0] ? a[0] : b[0]) &&
    p[0] <= (a[0] < b[0] ? b[0] : a[0]) &&
    p[1] >= (a[1] < b[1] ? a[1] : b[1]) &&
    p[1] <= (a[1] < b[1] ? b[1] : a[1])
  );
}

/** True when the closed segments AB and CD share a point other than A and B. */
export function segmentMeetsOutsideEndpoints(A: P, B: P, C: P, D: P): boolean {
  const o1 = orient(A, B, C);
  const o2 = orient(A, B, D);
  const o3 = orient(C, D, A);
  const o4 = orient(C, D, B);
  if (o1 === 0n && o2 === 0n) {
    // Collinear: parametrize along the dominant axis of AB.
    const axis =
      (A[0] > B[0] ? A[0] - B[0] : B[0] - A[0]) >= (A[1] > B[1] ? A[1] - B[1] : B[1] - A[1])
        ? 0
        : 1;
    const a0 = A[axis] < B[axis] ? A[axis] : B[axis];
    const a1 = A[axis] < B[axis] ? B[axis] : A[axis];
    const c0 = C[axis] < D[axis] ? C[axis] : D[axis];
    const c1 = C[axis] < D[axis] ? D[axis] : C[axis];
    const low = a0 > c0 ? a0 : c0;
    const high = a1 < c1 ? a1 : c1;
    if (low > high) return false;
    if (low < high) return true;
    const point = [C, D].find((q) => q[axis] === low) ?? (A[axis] === low ? A : B);
    return !same(point, A) && !same(point, B);
  }
  if (
    ((o1 > 0n && o2 < 0n) || (o1 < 0n && o2 > 0n)) &&
    ((o3 > 0n && o4 < 0n) || (o3 < 0n && o4 > 0n))
  )
    return true;
  if (o1 === 0n && onSegment(A, B, C) && !same(C, A) && !same(C, B)) return true;
  if (o2 === 0n && onSegment(A, B, D) && !same(D, A) && !same(D, B)) return true;
  return false;
}

/** Closed point-in-triangle for a positively oriented triangle. */
function inClosedTriangle(q: P, a: P, b: P, c: P): boolean {
  return orient(a, b, q) >= 0n && orient(b, c, q) >= 0n && orient(c, a, q) >= 0n;
}

function twiceArea(points: readonly P[], chain: readonly number[]): bigint {
  let sum = 0n;
  for (let i = 0; i < chain.length; i += 1) {
    const p = points[chain[i]!]!;
    const q = points[chain[(i + 1) % chain.length]!]!;
    sum += p[0] * q[1] - p[1] * q[0];
  }
  return sum;
}

// ---------------------------------------------------------------------------------------------
// Sectors.

/** Orient each boundary edge so that the owning triangle's third vertex is on its left. */
export function orientBoundary(
  points: readonly P[],
  edges: readonly Readonly<{ a: number; b: number; third: number }>[],
): DirectedEdge[] | ExteriorFailure {
  const directed: DirectedEdge[] = [];
  for (let index = 0; index < edges.length; index += 1) {
    const { a, b, third } = edges[index]!;
    const o = orient(points[a]!, points[b]!, points[third]!);
    if (o === 0n) return nonconforming(`edge-orientation:${a}:${b}`);
    directed.push(o > 0n ? { from: a, to: b, edge: index } : { from: b, to: a, edge: index });
  }
  return directed;
}

/** Sector pairing on oriented boundary edges over arbitrary exact integer points. */
export function sectorsOf(points: readonly P[], directed: readonly DirectedEdge[]): SectorsResult {
  const rays = new Map<number, { other: number; out: boolean; d: P }[]>();
  const push = (v: number, other: number, out: boolean) => {
    const p = points[v]!;
    const q = points[other]!;
    const list = rays.get(v) ?? [];
    list.push({ other, out, d: [q[0] - p[0], q[1] - p[1]] });
    rays.set(v, list);
  };
  for (const edge of directed) {
    push(edge.from, edge.to, true);
    push(edge.to, edge.from, false);
  }
  const vertices = [...rays.keys()].sort((a, b) => a - b);
  const byCoordinate = [...vertices].sort((a, b) => {
    const p = points[a]!;
    const q = points[b]!;
    return p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : a - b;
  });
  for (let i = 1; i < byCoordinate.length; i += 1)
    if (same(points[byCoordinate[i - 1]!]!, points[byCoordinate[i]!]!))
      return fail('VERTEX_UNSUPPORTED', `duplicate:${byCoordinate[i - 1]}:${byCoordinate[i]}`);
  for (const v of vertices) {
    const degree = rays.get(v)!.length;
    if (degree > 2 * MAX_SECTORS) return fail('VERTEX_UNSUPPORTED', `degree:${v}:${degree}`);
  }
  const result: VertexSectors[] = [];
  for (const v of vertices) {
    const list = rays.get(v)!;
    for (const ray of list)
      if (ray.d[0] === 0n && ray.d[1] === 0n) return nonconforming(`sector-zero-ray:${v}`);
    const sorted = [...list].sort((a, b) => compareAngle(a.d, b.d));
    for (let i = 1; i < sorted.length; i += 1)
      if (compareAngle(sorted[i - 1]!.d, sorted[i]!.d) === 0)
        return nonconforming(`sector-ray-tie:${v}`);
    const sectors: Sector[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const ray = sorted[i]!;
      if (!ray.out) continue;
      const next = sorted[(i + 1) % sorted.length]!;
      if (next.out || next === ray) return nonconforming(`sector-pairing:${v}`);
      sectors.push({ rOut: [v, ray.other], rIn: [next.other, v], reflex: isReflex(ray.d, next.d) });
    }
    if (sectors.length * 2 !== sorted.length) return nonconforming(`sector-pairing:${v}`);
    result.push({ vertex: v, sectors });
  }
  return { status: 'OK', directed, vertices: result };
}

/** Region sectors of every boundary vertex of a coverage row (exact, on the preimage). */
export function vertexSectors(geometry: CoverageRowGeometry): SectorsResult {
  const directed = orientBoundary(geometry.scaled, geometry.boundaryEdges);
  if (!Array.isArray(directed)) return directed;
  return sectorsOf(geometry.scaled, directed);
}

// ---------------------------------------------------------------------------------------------
// Frame.

export type ProjectedVertices = Readonly<{
  ndc: readonly (readonly [number, number])[];
  ndcBits: readonly (readonly [number, number])[];
  preimage: readonly Q2[];
}>;

const ONE = rational(1n);
const TWO = rational(2n);

/**
 * The positions.ts NDC path for arbitrary local binary64 vertices: exact K reference, once-rounded
 * binary32 NDC words and their exact preimage. Non-finite NDC values give a [0, 0] preimage.
 */
export function projectLocalVertices(
  input: ProjectionInput,
  vertices: readonly (readonly [number, number])[],
): ProjectedVertices {
  const reference = referencePositions({ ...input, mesh: { vertices, indices: [] } });
  const W = rational(BigInt(input.width));
  const H = rational(BigInt(input.height));
  const ndc: [number, number][] = [];
  const ndcBits: [number, number][] = [];
  const preimage: Q2[] = [];
  for (const [rx, ry] of reference) {
    const x = roundExact32(sub(mul(TWO, mul(rx, rational(1n, BigInt(input.width)))), ONE));
    const y = roundExact32(sub(ONE, mul(TWO, mul(ry, rational(1n, BigInt(input.height))))));
    const bits: [number, number] = [f32Bits(x), f32Bits(y)];
    ndc.push([x, y]);
    ndcBits.push(bits);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      preimage.push([rational(0n), rational(0n)]);
      continue;
    }
    preimage.push([
      mul(add(q32Bits(bits[0]), ONE), mul(W, rational(1n, 2n))),
      mul(sub(ONE, q32Bits(bits[1])), mul(H, rational(1n, 2n))),
    ]);
  }
  return { ndc, ndcBits, preimage };
}

/** Exact local point whose K reference position is the physical point (x, y). */
export function inverseReference(input: ProjectionInput, x: Rational, y: Rational): Q2 | null {
  const [a, b, c, d, e, f] = input.affine.map(q64) as [
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
    Rational,
  ];
  const scale = mul(q64(input.zoom), q64(input.dpr));
  const det = sub(mul(a, d), mul(b, c));
  if (det.n === 0n || scale.n === 0n) return null;
  const u = sub(add(div(x, scale), q64(input.camera[0])), e);
  const w = sub(add(div(y, scale), q64(input.camera[1])), f);
  return [div(sub(mul(d, u), mul(c, w)), det), div(sub(mul(a, w), mul(b, u)), det)];
}

export type Frame = Readonly<{
  status: 'OK';
  /** Integer physical box [x0, y0, x1, y1] of the boundary preimage expanded by 2 px. */
  box: readonly [number, number, number, number];
  /** Local binary64 corners (x0,y0), (x1,y0), (x1,y1), (x0,y1): positive orientation. */
  local: readonly (readonly [number, number])[];
  ndc: readonly (readonly [number, number])[];
  ndcBits: readonly (readonly [number, number])[];
  preimage: readonly Q2[];
  /** Maximum |NDC| over the corner words (binary32 values). */
  maxNdcMagnitude: number;
}>;

export type FrameResult = Frame | ExteriorFailure;

function boundaryVertices(geometry: CoverageRowGeometry): number[] {
  return [...new Set(geometry.boundaryEdges.flatMap((edge) => [edge.a, edge.b]))].sort(
    (a, b) => a - b,
  );
}

/**
 * The frame of a coverage row. Returns FRAME_DEFERRED when a corner's NDC magnitude exceeds 2^10.
 * The containment checks (non-inverted, every boundary vertex >= 1.5 px inside every side) run in
 * checkFrame on the exact preimage.
 */
export function frameFor(geometry: CoverageRowGeometry, input: ProjectionInput): FrameResult {
  const S = 1n << BigInt(geometry.scaleExponent);
  const vertices = boundaryVertices(geometry);
  if (vertices.length === 0) return nonconforming('frame-no-boundary');
  const xs = vertices.map((v) => geometry.scaled[v]![0]);
  const ys = vertices.map((v) => geometry.scaled[v]![1]);
  const min = (values: bigint[]) => values.reduce((a, b) => (b < a ? b : a));
  const max = (values: bigint[]) => values.reduce((a, b) => (b > a ? b : a));
  const margin = BigInt(FRAME_MARGIN) * S;
  const x0 = floorDiv(min(xs) - margin, S);
  const y0 = floorDiv(min(ys) - margin, S);
  const x1 = ceilDiv(max(xs) + margin, S);
  const y1 = ceilDiv(max(ys) + margin, S);
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as const;
  const local: [number, number][] = [];
  for (const [x, y] of corners) {
    const point = inverseReference(input, rational(x), rational(y));
    if (point === null) return nonconforming('frame-singular');
    const lx = roundExact64(point[0]);
    const ly = roundExact64(point[1]);
    if (!Number.isFinite(lx) || !Number.isFinite(ly)) return nonconforming('frame-local-overflow');
    local.push([lx, ly]);
  }
  const projected = projectLocalVertices(input, local);
  let maxNdcMagnitude = 0;
  for (const [x, y] of projected.ndc) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return fail('FRAME_DEFERRED', 'ndc-nonfinite');
    maxNdcMagnitude = Math.max(maxNdcMagnitude, Math.abs(x), Math.abs(y));
  }
  if (maxNdcMagnitude > FRAME_DEFERRED_LIMIT)
    return fail('FRAME_DEFERRED', `ndc:${maxNdcMagnitude}`);
  return {
    status: 'OK',
    box: [Number(x0), Number(y0), Number(x1), Number(y1)],
    local,
    ndc: projected.ndc,
    ndcBits: projected.ndcBits,
    preimage: projected.preimage,
    maxNdcMagnitude,
  };
}

/**
 * Exact frame checks on scaled points (unit 2^-k px): the corners form a convex quadrilateral of
 * positive orientation, and every listed point is at least 1.5 px inside every side. Returns the
 * failure reason or null.
 */
export function checkFrame(
  points: readonly P[],
  frame: readonly [number, number, number, number],
  inner: readonly number[],
  scale: bigint,
): string | null {
  for (let i = 0; i < 4; i += 1) {
    const o = orient(
      points[frame[i]!]!,
      points[frame[(i + 1) % 4]!]!,
      points[frame[(i + 2) % 4]!]!,
    );
    if (o <= 0n) return `frame-inverted:${i}`;
  }
  for (let i = 0; i < 4; i += 1) {
    const a = points[frame[i]!]!;
    const b = points[frame[(i + 1) % 4]!]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const length2 = ex * ex + ey * ey;
    for (const v of inner) {
      const c = orient(a, b, points[v]!);
      // distance = c / |e| >= 3/2 px  <=>  c > 0 and 4 c^2 >= 9 |e|^2 S^2.
      if (c <= 0n || 4n * c * c < 9n * length2 * scale * scale) return `frame-margin:${i}:${v}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Complement triangulation.

/** Trace boundary loops: each oriented edge continues with the rOut of the sector owning it. */
export function traceLoops(
  directed: readonly DirectedEdge[],
  vertices: readonly VertexSectors[],
): number[][] | ExteriorFailure {
  const successor = new Map<string, number>();
  for (const { vertex, sectors } of vertices)
    for (const sector of sectors) successor.set(`${sector.rIn[0]}:${vertex}`, sector.rOut[1]);
  const byKey = new Map(directed.map((edge, index) => [`${edge.from}:${edge.to}`, index]));
  const used = new Uint8Array(directed.length);
  const loops: number[][] = [];
  for (let start = 0; start < directed.length; start += 1) {
    if (used[start]) continue;
    const loop: number[] = [];
    let index = start;
    while (!used[index]) {
      used[index] = 1;
      const edge = directed[index]!;
      loop.push(edge.from);
      const next = successor.get(`${edge.from}:${edge.to}`);
      if (next === undefined) return nonconforming(`loop-successor:${edge.from}:${edge.to}`);
      const nextIndex = byKey.get(`${edge.to}:${next}`);
      if (nextIndex === undefined) return nonconforming(`loop-successor:${edge.to}:${next}`);
      index = nextIndex;
    }
    if (index !== start) return nonconforming(`loop-open:${directed[start]!.from}`);
    loops.push(loop);
  }
  return loops;
}

/** Crossing-number point-in-polygon on doubled coordinates: 1 inside, 0 outside, -1 on boundary. */
function pointInLoop(points: readonly P[], loop: readonly number[], m: P): -1 | 0 | 1 {
  let inside = false;
  for (let i = 0; i < loop.length; i += 1) {
    const u0 = points[loop[i]!]!;
    const v0 = points[loop[(i + 1) % loop.length]!]!;
    const u: P = [2n * u0[0], 2n * u0[1]];
    const v: P = [2n * v0[0], 2n * v0[1]];
    const o = orient(u, v, m);
    if (o === 0n && onSegment(u, v, m)) return -1;
    if (u[1] > m[1] !== v[1] > m[1] && (v[1] > u[1] ? o > 0n : o < 0n)) inside = !inside;
  }
  return inside ? 1 : 0;
}

function wedgeContains(points: readonly P[], chain: readonly number[], position: number, d: P) {
  const n = chain.length;
  const v = points[chain[position]!]!;
  const prev = points[chain[(position - 1 + n) % n]!]!;
  const next = points[chain[(position + 1) % n]!]!;
  const a: P = [next[0] - v[0], next[1] - v[1]];
  const b: P = [prev[0] - v[0], prev[1] - v[1]];
  return inSweep(a, b, d);
}

function chainEdges(chain: readonly number[]): [number, number][] {
  return chain.map((v, i) => [v, chain[(i + 1) % chain.length]!] as [number, number]);
}

/** Merge holes into the outer chain by bridges (descending max x), then the merged chain. */
function mergeHoles(
  points: readonly P[],
  outer: readonly number[],
  holes: readonly (readonly number[])[],
): number[] | ExteriorFailure {
  const starts = holes.map((hole, order) => {
    let best = 0;
    for (let i = 1; i < hole.length; i += 1) {
      const p = points[hole[i]!]!;
      const q = points[hole[best]!]!;
      if (p[0] > q[0] || (p[0] === q[0] && hole[i]! < hole[best]!)) best = i;
    }
    return { order, vertex: hole[best]! };
  });
  starts.sort((a, b) => {
    const pa = points[a.vertex]![0];
    const pb = points[b.vertex]![0];
    return pa > pb ? -1 : pa < pb ? 1 : a.vertex - b.vertex || a.order - b.order;
  });
  let chain = [...outer];
  const pending = new Set(holes.map((_, index) => index));
  for (const { order } of starts) {
    const hole = holes[order]!;
    pending.delete(order);
    const edges = [
      ...chainEdges(chain),
      ...chainEdges(hole),
      ...[...pending].flatMap((index) => chainEdges(holes[index]!)),
    ];
    // Bridge pairs (hole vertex h, chain vertex b) with distinct coordinates, by exact distance,
    // then lower hole index, then lower chain index.
    const candidates: { h: number; b: number; distance: bigint }[] = [];
    for (const h of new Set(hole))
      for (const b of new Set(chain)) {
        if (same(points[b]!, points[h]!)) continue;
        const dx = points[b]![0] - points[h]![0];
        const dy = points[b]![1] - points[h]![1];
        candidates.push({ h, b, distance: dx * dx + dy * dy });
      }
    candidates.sort((x, y) =>
      x.distance < y.distance ? -1 : x.distance > y.distance ? 1 : x.h - y.h || x.b - y.b,
    );
    let merged: number[] | null = null;
    for (const { h, b } of candidates) {
      const H = points[h]!;
      const B = points[b]!;
      if (edges.some(([p, q]) => segmentMeetsOutsideEndpoints(H, B, points[p]!, points[q]!)))
        continue;
      const toH: P = [H[0] - B[0], H[1] - B[1]];
      const toB: P = [B[0] - H[0], B[1] - H[1]];
      const at = chain.findIndex((v, i) => v === b && wedgeContains(points, chain, i, toH));
      const from = hole.findIndex((v, i) => v === h && wedgeContains(points, hole, i, toB));
      if (at < 0 || from < 0) continue;
      const rotated = [...hole.slice(from), ...hole.slice(0, from)];
      merged = [...chain.slice(0, at + 1), ...rotated, h, ...chain.slice(at)];
      break;
    }
    if (merged === null) return nonconforming(`no-bridge:${order}`);
    chain = merged;
  }
  return chain;
}

/**
 * Counterclockwise angle order relative to the reference direction r: -1 when d1 comes first in
 * [0, 360) measured from r, 1 when d2 does, 0 when they coincide.
 */
function compareFrom(r: P, d1: P, d2: P): number {
  const half = (d: P) => {
    const c = cross(r[0], r[1], d[0], d[1]);
    return c > 0n || (c === 0n && r[0] * d[0] + r[1] * d[1] > 0n) ? 0 : 1;
  };
  const h1 = half(d1);
  const h2 = half(d2);
  if (h1 !== h2) return h1 - h2;
  const c = cross(d1[0], d1[1], d2[0], d2[1]);
  return c > 0n ? -1 : c < 0n ? 1 : 0;
}

type HalfEdge = { from: number; to: number };

/**
 * Trace the open boundary half-edges (face on the left) into closed walks. At a vertex the walk
 * continues with the outgoing half-edge met first when rotating clockwise from the reversed incoming
 * direction (the face sector adjacent to the incoming edge; an exactly reversed edge comes last).
 */
function traceWalks(points: readonly P[], edges: readonly HalfEdge[]): number[][] | null {
  const used = new Uint8Array(edges.length);
  const walks: number[][] = [];
  for (let start = 0; start < edges.length; start += 1) {
    if (used[start]) continue;
    const walk: number[] = [];
    let index = start;
    while (!used[index]) {
      used[index] = 1;
      const edge = edges[index]!;
      walk.push(edge.to);
      const v = points[edge.to]!;
      const u = points[edge.from]!;
      const back: P = [u[0] - v[0], u[1] - v[1]];
      let best = -1;
      for (let k = 0; k < edges.length; k += 1) {
        if (used[k] && k !== start) continue;
        if (edges[k]!.from !== edge.to) continue;
        if (best < 0) {
          best = k;
          continue;
        }
        const w = points[edges[k]!.to]!;
        const b = points[edges[best]!.to]!;
        // Clockwise first = largest counterclockwise angle from `back`.
        if (compareFrom(back, [w[0] - v[0], w[1] - v[1]], [b[0] - v[0], b[1] - v[1]]) > 0) best = k;
      }
      if (best < 0) return null;
      index = best;
    }
    if (index !== start) return null;
    // walk lists the head of each half-edge; rotate so it starts at the first tail.
    walks.push([walk[walk.length - 1]!, ...walk.slice(0, -1)]);
  }
  return walks;
}

/**
 * True when a half-edge other than the ear's own leaves corner `corner` of the positive triangle
 * strictly inside the triangle's angle there: it would enter the candidate ear (another sector of a
 * pinch vertex).
 */
function entersCorner(
  points: readonly P[],
  edges: readonly HalfEdge[],
  own: ReadonlySet<number>,
  triangle: readonly [number, number, number],
  corner: number,
): boolean {
  const vertex = triangle[corner]!;
  const x = points[vertex]!;
  const u = points[triangle[(corner + 1) % 3]!]!;
  const w = points[triangle[(corner + 2) % 3]!]!;
  const a: P = [u[0] - x[0], u[1] - x[1]];
  const b: P = [w[0] - x[0], w[1] - x[1]];
  for (let k = 0; k < edges.length; k += 1) {
    if (own.has(k)) continue;
    const edge = edges[k]!;
    const other = edge.from === vertex ? edge.to : edge.to === vertex ? edge.from : -1;
    if (other < 0) continue;
    const r = points[other]!;
    const d: P = [r[0] - x[0], r[1] - x[1]];
    if (cross(a[0], a[1], d[0], d[1]) > 0n && cross(d[0], d[1], b[0], b[1]) > 0n) return true;
  }
  return false;
}

/**
 * Ear clipping of a positively oriented weakly simple chain; triangles are positive.
 *
 * The open boundary is kept as half-edges with the face on their left and re-traced into closed
 * walks after every clip, so pinch vertices may occur more than once. An ear (p, c, n) is three
 * consecutive walk vertices with strictly positive exact area such that (closed test) no boundary
 * vertex other than one coincident with a corner lies on the closed triangle, and no other boundary
 * half-edge at a corner leaves it strictly inside the triangle's angle. Clipping removes p->c and
 * c->n and adds the diagonal p->n, or cancels n->p when that half-edge is open (the segment is then
 * covered on both sides). Fails with `no-ear` when no walk has an ear.
 */
export function earClip(
  points: readonly P[],
  input: readonly number[],
): Triangle[] | ExteriorFailure {
  let edges: HalfEdge[] = input.map((v, i) => ({ from: v, to: input[(i + 1) % input.length]! }));
  const triangles: Triangle[] = [];
  while (edges.length > 0) {
    const walks = traceWalks(points, edges);
    if (walks === null) return nonconforming('walk');
    const vertices = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
    let clipped = false;
    for (const walk of walks) {
      const n = walk.length;
      if (n < 3) return nonconforming(`walk-length:${walk.join(',')}`);
      for (let i = 0; i < n && !clipped; i += 1) {
        const triangle = [walk[(i - 1 + n) % n]!, walk[i]!, walk[(i + 1) % n]!] as const;
        const [a, b, c] = triangle.map((v) => points[v]!) as [P, P, P];
        if (orient(a, b, c) <= 0n) continue;
        if (
          vertices.some((v) => {
            const q = points[v]!;
            return !same(q, a) && !same(q, b) && !same(q, c) && inClosedTriangle(q, a, b, c);
          })
        )
          continue;
        const first = edges.findIndex((e) => e.from === triangle[0] && e.to === triangle[1]);
        const second = edges.findIndex((e) => e.from === triangle[1] && e.to === triangle[2]);
        if (first < 0 || second < 0) return nonconforming('walk-edge');
        const own = new Set([first, second]);
        const closing = edges.findIndex((e) => e.from === triangle[2] && e.to === triangle[0]);
        if (closing >= 0) own.add(closing);
        if ([0, 1, 2].some((corner) => entersCorner(points, edges, own, triangle, corner)))
          continue;
        triangles.push(triangle);
        const remove = new Set([first, second]);
        if (closing >= 0) remove.add(closing);
        edges = edges.filter((_, k) => !remove.has(k));
        if (closing < 0) edges.push({ from: triangle[0], to: triangle[2] });
        clipped = true;
      }
      if (clipped) break;
    }
    if (!clipped) return nonconforming('no-ear');
  }
  return triangles;
}

export type ComplementResult =
  | Readonly<{
      status: 'OK';
      /** Region loops (region on the left), in trace order. */
      loops: readonly (readonly number[])[];
      /** Positively oriented complement triangles. */
      triangles: readonly Triangle[];
      faces: number;
    }>
  | ExteriorFailure;

/**
 * Triangulate frame minus region over exact integer points. `frame` is positively oriented and
 * strictly encloses every loop.
 */
export function triangulateComplement(
  points: readonly P[],
  directed: readonly DirectedEdge[],
  vertices: readonly VertexSectors[],
  frame: readonly [number, number, number, number],
): ComplementResult {
  const traced = traceLoops(directed, vertices);
  if (!Array.isArray(traced)) return traced;
  const loops = traced;
  const areas = loops.map((loop) => twiceArea(points, loop));
  for (let i = 0; i < loops.length; i += 1)
    if (areas[i] === 0n) return nonconforming(`loop-area:${loops[i]![0]}`);
  // Containment: loop j contains loop i when the midpoint of i's first edge is inside j.
  const containers: number[][] = loops.map(() => []);
  for (let i = 0; i < loops.length; i += 1) {
    const loop = loops[i]!;
    const p = points[loop[0]!]!;
    const q = points[loop[1 % loop.length]!]!;
    const m: P = [p[0] + q[0], p[1] + q[1]];
    for (let j = 0; j < loops.length; j += 1) {
      if (i === j) continue;
      const where = pointInLoop(points, loops[j]!, m);
      if (where < 0) return nonconforming(`nesting-boundary:${i}:${j}`);
      if (where === 1) containers[i]!.push(j);
    }
  }
  const depth = containers.map((list) => list.length);
  const parent = containers.map((list) =>
    list.length === 0 ? -1 : list.reduce((best, j) => (depth[j]! > depth[best]! ? j : best)),
  );
  for (let i = 0; i < loops.length; i += 1) {
    const outer = areas[i]! > 0n;
    if (outer !== (depth[i]! % 2 === 0)) return nonconforming(`nesting-parity:${i}`);
    if (parent[i]! >= 0 && depth[parent[i]!] !== depth[i]! - 1)
      return nonconforming(`nesting-depth:${i}`);
  }
  const reversed = (loop: readonly number[]) => [...loop].reverse();
  const faces: { outer: number[]; holes: number[][] }[] = [
    {
      outer: [...frame],
      holes: loops.filter((_, i) => parent[i] === -1).map(reversed),
    },
  ];
  for (let i = 0; i < loops.length; i += 1)
    if (areas[i]! < 0n)
      faces.push({
        outer: reversed(loops[i]!),
        holes: loops.filter((_, j) => parent[j] === i).map(reversed),
      });
  const triangles: Triangle[] = [];
  for (const face of faces) {
    const chain = mergeHoles(points, face.outer, face.holes);
    if (!Array.isArray(chain)) return chain;
    const clipped = earClip(points, chain);
    if (!Array.isArray(clipped)) return clipped;
    triangles.push(...clipped);
  }
  return { status: 'OK', loops, triangles, faces: faces.length };
}

// ---------------------------------------------------------------------------------------------
// Partition check.

/**
 * Exact partition check over all drawn triangles: consistent nonzero orientation, no duplicate
 * vertex coordinate, every non-frame edge used exactly twice in opposite directions, every frame side
 * exactly once, no vertex in the interior of an edge, and the areas summing to the frame area.
 * Returns null or the failed check.
 */
export function checkPartition(
  points: readonly P[],
  triangles: readonly Triangle[],
  frame: readonly [number, number, number, number],
): string | null {
  let sign = 0n;
  let total = 0n;
  for (let t = 0; t < triangles.length; t += 1) {
    const [a, b, c] = triangles[t]!;
    const o = orient(points[a]!, points[b]!, points[c]!);
    const s = o > 0n ? 1n : o < 0n ? -1n : 0n;
    if (s === 0n || (sign !== 0n && s !== sign)) return `orientation:${t}`;
    sign = s;
    total += o;
  }
  const used = [...new Set(triangles.flat())].sort((a, b) => a - b);
  const byCoordinate = [...used].sort((a, b) => {
    const p = points[a]!;
    const q = points[b]!;
    return p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : a - b;
  });
  for (let i = 1; i < byCoordinate.length; i += 1)
    if (same(points[byCoordinate[i - 1]!]!, points[byCoordinate[i]!]!))
      return `duplicate-vertex:${byCoordinate[i - 1]}:${byCoordinate[i]}`;
  const uses = new Map<string, { a: number; b: number; forward: number; backward: number }>();
  for (const triangle of triangles)
    for (let side = 0; side < 3; side += 1) {
      const p = triangle[side]!;
      const q = triangle[(side + 1) % 3]!;
      const a = Math.min(p, q);
      const b = Math.max(p, q);
      const key = `${a}:${b}`;
      const entry = uses.get(key) ?? { a, b, forward: 0, backward: 0 };
      if (p === a) entry.forward += 1;
      else entry.backward += 1;
      uses.set(key, entry);
    }
  const frameKeys = new Set(
    frame.map((v, i) => {
      const w = frame[(i + 1) % 4]!;
      return `${Math.min(v, w)}:${Math.max(v, w)}`;
    }),
  );
  for (const key of frameKeys) if (!uses.has(key)) return `frame-edge:${key}`;
  for (const [key, entry] of [...uses.entries()].sort()) {
    if (frameKeys.has(key)) {
      if (entry.forward + entry.backward !== 1) return `frame-edge:${key}`;
    } else if (entry.forward !== 1 || entry.backward !== 1) return `edge-use:${key}`;
  }
  for (const entry of uses.values()) {
    const A = points[entry.a]!;
    const B = points[entry.b]!;
    for (const v of used) {
      if (v === entry.a || v === entry.b) continue;
      const p = points[v]!;
      if (orient(A, B, p) === 0n && onSegment(A, B, p))
        return `t-junction:${v}:${entry.a}:${entry.b}`;
    }
  }
  const frameArea = twiceArea(points, frame);
  if ((total < 0n ? -total : total) !== (frameArea < 0n ? -frameArea : frameArea)) return 'area';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Exterior mesh.

export type ExteriorMesh = Readonly<{
  status: 'OK';
  /** Local binary64 vertices: the original mesh vertices, then the 4 frame corners. */
  vertices: readonly (readonly [number, number])[];
  /** binary32 NDC words of `vertices`. */
  ndcBits: readonly (readonly [number, number])[];
  /** Exact preimage (physical px) of `vertices`. */
  preimage: readonly Q2[];
  /** k with preimage * 2^k integral for referenced and frame vertices; `scaled` = preimage * 2^k. */
  scaleExponent: number;
  scaled: readonly P[];
  /** The region triangles (geometry.triangles). */
  regionTriangles: readonly Triangle[];
  /** Complement triangles, oriented like the region triangles. */
  exteriorTriangles: readonly Triangle[];
  frameIndices: readonly [number, number, number, number];
  frame: Frame;
  sectors: Extract<SectorsResult, { status: 'OK' }>;
  /**
   * Per exterior triangle: exact squared minimum altitude (px^2) and whether the orientation
   * survives a 1/16-px displacement of every vertex (minimum altitude > 1/8 px). Reported only.
   */
  orientationSlack: readonly Readonly<{ minAltitudeSquared: Rational; snapSafe: boolean }>[];
}>;

export type ExteriorMeshResult = ExteriorMesh | ExteriorFailure;

const SNAP_LIMIT_SQUARED = rational(1n, 64n);

function minAltitudeSquared(points: readonly Q2[], triangle: Triangle): Rational {
  let best: Rational | null = null;
  const [p, q, r] = triangle.map((index) => points[index]!) as [Q2, Q2, Q2];
  const area2 = sub(mul(sub(q[0], p[0]), sub(r[1], p[1])), mul(sub(q[1], p[1]), sub(r[0], p[0])));
  for (const [a, b] of [
    [p, q],
    [q, r],
    [r, p],
  ] as const) {
    const dx = sub(b[0], a[0]);
    const dy = sub(b[1], a[1]);
    const value = div(mul(area2, area2), add(mul(dx, dx), mul(dy, dy)));
    if (best === null || compare(value, best) < 0) best = value;
  }
  return best!;
}

/** The complete O02 drawn geometry of a coverage row, or its exterior status. */
export function exteriorMesh(
  input: ProjectionInput,
  geometry: CoverageRowGeometry,
): ExteriorMeshResult {
  const frame = frameFor(geometry, input);
  if (frame.status === 'FRAME_DEFERRED') return frame;
  const sectors = vertexSectors(geometry);
  if (sectors.status === 'VERTEX_UNSUPPORTED') return sectors;
  if (frame.status !== 'OK') return frame;
  if (sectors.status !== 'OK') return sectors;

  const base = input.mesh.vertices.length;
  const frameIndices = [base, base + 1, base + 2, base + 3] as const;
  const preimage = [...geometry.preimage, ...frame.preimage];
  const exponents = [...geometry.referenced, ...frameIndices].map((v) =>
    Math.max(dyadicExponent(preimage[v]![0]), dyadicExponent(preimage[v]![1])),
  );
  const k = Math.max(geometry.scaleExponent, ...exponents);
  const scaleOf = (value: Rational) => value.n * (1n << BigInt(k - dyadicExponent(value)));
  const used = new Set([...geometry.referenced, ...frameIndices]);
  const scaled: P[] = preimage.map((point, v) =>
    used.has(v) ? [scaleOf(point[0]), scaleOf(point[1])] : [0n, 0n],
  );
  const S = 1n << BigInt(k);

  const frameCheck = checkFrame(scaled, frameIndices, boundaryVertices(geometry), S);
  if (frameCheck !== null) return nonconforming(frameCheck);

  const complement = triangulateComplement(
    scaled,
    sectors.directed,
    sectors.vertices,
    frameIndices,
  );
  if (complement.status !== 'OK') return complement;

  const [p, q, r] = geometry.triangles[0]!;
  const regionSign = orient(scaled[p]!, scaled[q]!, scaled[r]!) > 0n;
  const exteriorTriangles: Triangle[] = complement.triangles.map(([a, b, c]) =>
    regionSign ? [a, b, c] : [a, c, b],
  );
  const partition = checkPartition(
    scaled,
    [...geometry.triangles, ...exteriorTriangles],
    frameIndices,
  );
  if (partition !== null) return nonconforming(`partition:${partition}`);

  return {
    status: 'OK',
    vertices: [...input.mesh.vertices, ...frame.local],
    ndcBits: [...geometry.ndcBits, ...frame.ndcBits],
    preimage,
    scaleExponent: k,
    scaled,
    regionTriangles: geometry.triangles,
    exteriorTriangles,
    frameIndices,
    frame,
    sectors,
    orientationSlack: exteriorTriangles.map((triangle) => {
      const value = minAltitudeSquared(preimage, triangle);
      return { minAltitudeSquared: value, snapSafe: compare(value, SNAP_LIMIT_SQUARED) > 0 };
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Exact distances for feature reach (Rational, physical px).

function dot2(ax: Rational, ay: Rational, bx: Rational, by: Rational): Rational {
  return add(mul(ax, bx), mul(ay, by));
}

/** Exact squared distance from point p to the closed segment ab. */
export function pointSegmentDistanceSquared(p: Q2, a: Q2, b: Q2): Rational {
  const ex = sub(b[0], a[0]);
  const ey = sub(b[1], a[1]);
  const wx = sub(p[0], a[0]);
  const wy = sub(p[1], a[1]);
  const length2 = dot2(ex, ey, ex, ey);
  const t = dot2(wx, wy, ex, ey);
  if (length2.n === 0n || t.n <= 0n) return dot2(wx, wy, wx, wy);
  if (compare(t, length2) >= 0) {
    const vx = sub(p[0], b[0]);
    const vy = sub(p[1], b[1]);
    return dot2(vx, vy, vx, vy);
  }
  const c = sub(mul(ex, wy), mul(ey, wx));
  return div(mul(c, c), length2);
}

function orientQ(p: Q2, q: Q2, r: Q2): number {
  const value = sub(mul(sub(q[0], p[0]), sub(r[1], p[1])), mul(sub(q[1], p[1]), sub(r[0], p[0])));
  return value.n > 0n ? 1 : value.n < 0n ? -1 : 0;
}

/** Exact squared distance from point p to the closed triangle (0 when inside or on it). */
export function pointTriangleDistanceSquared(p: Q2, triangle: readonly [Q2, Q2, Q2]): Rational {
  const [a, b, c] = triangle;
  const s = orientQ(a, b, c);
  const o1 = orientQ(a, b, p) * s;
  const o2 = orientQ(b, c, p) * s;
  const o3 = orientQ(c, a, p) * s;
  if (s !== 0 && o1 >= 0 && o2 >= 0 && o3 >= 0) return rational(0n);
  let best = pointSegmentDistanceSquared(p, a, b);
  for (const [u, v] of [
    [b, c],
    [c, a],
  ] as const) {
    const value = pointSegmentDistanceSquared(p, u, v);
    if (compare(value, best) < 0) best = value;
  }
  return best;
}

function segmentsIntersectQ(a: Q2, b: Q2, c: Q2, d: Q2): boolean {
  const o1 = orientQ(a, b, c);
  const o2 = orientQ(a, b, d);
  const o3 = orientQ(c, d, a);
  const o4 = orientQ(c, d, b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  const within = (p: Q2, q: Q2, r: Q2) =>
    compare(r[0], p[0]) * compare(r[0], q[0]) <= 0 &&
    compare(r[1], p[1]) * compare(r[1], q[1]) <= 0;
  return (
    (o1 === 0 && within(a, b, c)) ||
    (o2 === 0 && within(a, b, d)) ||
    (o3 === 0 && within(c, d, a)) ||
    (o4 === 0 && within(c, d, b))
  );
}

/** Exact squared distance between the closed segment ab and the closed triangle. */
export function segmentTriangleDistanceSquared(
  a: Q2,
  b: Q2,
  triangle: readonly [Q2, Q2, Q2],
): Rational {
  const [p, q, r] = triangle;
  if (
    compare(pointTriangleDistanceSquared(a, triangle), rational(0n)) === 0 ||
    segmentsIntersectQ(a, b, p, q) ||
    segmentsIntersectQ(a, b, q, r) ||
    segmentsIntersectQ(a, b, r, p)
  )
    return rational(0n);
  let best = pointTriangleDistanceSquared(a, triangle);
  for (const value of [
    pointTriangleDistanceSquared(b, triangle),
    pointSegmentDistanceSquared(p, a, b),
    pointSegmentDistanceSquared(q, a, b),
    pointSegmentDistanceSquared(r, a, b),
  ])
    if (compare(value, best) < 0) best = value;
  return best;
}
