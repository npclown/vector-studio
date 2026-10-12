import type { FillMesh } from '@vector-studio/contracts';
import { toDyadic } from './path-buckets.js';
import { meshFrameCorners } from './path-mesh-packet.js';

// The A5 coverage fringe of the P3 V3 contract, section e, unit V3c: the exterior triangulation
// of a frame around one port mesh, its EDGE and VERTEX features and the per-triangle feature
// lists, in node-local coordinates on the K4 carrier.
//
// D8-interim placement (V3-Q3 c): this exact BigInt builder runs in renderer-core as a
// time-bounded exception to ARCHITECTURE.md's geometry-contract ownership and to the P3 private
// contract's "Keep Rust as the production geometry owner". It is disposable under the C04
// carve-out and is removed or moved when the R2/K1 contract decides production placement (see
// docs/graphics-engine-architecture.md, Anti-aliasing).
//
// The algorithm is O02's (docs/plans/p3-o02-a5-coverage-contract.md, "Corners at a vertex" and
// "Drawn geometry and partition"), ported unchanged in its rules from the test-only
// tests/geometry/coverage-oracle/exterior.ts: boundary loops with sector pairing at pinch
// vertices, nesting by exact midpoint point-in-polygon, faces merged by bridges and ear-clipped,
// no Steiner points, and an exact partition check of region plus exterior triangles before
// publication. Every coordinate is the exact dyadic value of a Float64 port position or of a
// frame corner m + k, scaled by one common power of two to a BigInt grid, so no predicate
// rounds. Orientation: node-local, cross(a, b) = a.x b.y - a.y b.x, "counterclockwise" and
// "left" mean positive cross, as port rule 5 orients boundaryEdges.

/** A fringe variant's arrays (section f byte layouts); every array is owned by the variant. */
export type PathFringe = Readonly<{
  /**
   * Frame-corner offsets k from m, binary32 lanes x, y for the corners (x0, y0), (x1, y0),
   * (x1, y1), (x0, y1). They are the variant's vertices N to N + 3 after the N port vertices.
   */
  corners: Float32Array;
  /**
   * meshTriangles records, 8 u32 words each: i0, i1, i2 (variant-relative, counterclockwise),
   * listOffset, listCount (variant-relative), role (0 region, 1 exterior), two zero words.
   * Region triangles come first, then the exterior triangles whose list is nonempty.
   */
  triangles: Uint32Array;
  /** meshFeatureLists: variant-relative feature indices, each list sorted by (kind, global id). */
  lists: Uint32Array;
  /** meshFeatures: 16 words per feature, EDGE features in global order, then VERTEX features. */
  features: Uint32Array;
  regionTriangles: number;
  exteriorTriangles: number;
  /** Exterior triangles dropped because no feature lies within rho of them. */
  droppedExterior: number;
}>;

/** Fringe-builder seam of the path-mesh pipeline; tests may install doubles. */
export type PathFringeBuildResult =
  | Readonly<{ status: 'built'; fringe: PathFringe }>
  | Readonly<{ status: 'unsupported'; reason?: string }>
  | Readonly<{ status: 'range' }>;
export type PathFringeBuilder = (mesh: FillMesh, fringeBucket: number) => PathFringeBuildResult;

export const FRINGE_TRIANGLE_WORDS = 8;
export const FRINGE_FEATURE_WORDS = 16;
export const FRINGE_ROLE_REGION = 0;
export const FRINGE_ROLE_EXTERIOR = 1;
export const FRINGE_FEATURE_EDGE = 0;
export const FRINGE_FEATURE_VERTEX = 1;
const MAX_SECTORS = 3;
const REFLEX_SHIFT = 8;

type P = readonly [bigint, bigint];
export type Triangle = readonly [number, number, number];
type DirectedEdge = Readonly<{ from: number; to: number }>;
type Sector = Readonly<{
  rOut: readonly [number, number];
  rIn: readonly [number, number];
  reflex: boolean;
}>;
type VertexSectors = Readonly<{ vertex: number; sectors: readonly Sector[] }>;

class Unsupported extends Error {}
const unsupported = (reason: string): never => {
  throw new Unsupported(reason);
};

/**
 * The exact fringe builder for one mesh entry at fringe bucket f, so rho = 2^f local units.
 * Returns `range` when a frame corner is not a finite binary32 value (state failure
 * fringe-range), `unsupported` for a vertex with more than three sectors, duplicate
 * coordinates, a failed pairing, no ear or a failed partition check (fringe-unsupported).
 */
export const buildPathFringe: PathFringeBuilder = (mesh, fringeBucket) =>
  buildPathFringeDetailed(mesh, fringeBucket).result;

/**
 * @internal Tests only: the build result with every exterior triangle before empty-list
 * exterior triangles are dropped, so an independent oracle can re-check the exact partition.
 */
export function buildPathFringeDetailed(
  mesh: FillMesh,
  fringeBucket: number,
): Readonly<{ result: PathFringeBuildResult; exterior: readonly Triangle[] | null }> {
  const rho = 2 ** fringeBucket;
  if (!(rho > 0) || !Number.isFinite(rho)) return { result: { status: 'range' }, exterior: null };
  const midpoint = {
    x: mesh.bounds.minX / 2 + mesh.bounds.maxX / 2,
    y: mesh.bounds.minY / 2 + mesh.bounds.maxY / 2,
  };
  const corners = meshFrameCorners(mesh.bounds, midpoint, rho);
  if (corners === null) return { result: { status: 'range' }, exterior: null };
  try {
    const built = buildExact(mesh, midpoint, corners, rho);
    return { result: { status: 'built', fringe: built.fringe }, exterior: built.exterior };
  } catch (error) {
    if (error instanceof Unsupported) {
      return { result: { status: 'unsupported', reason: error.message }, exterior: null };
    }
    throw error;
  }
}

function buildExact(
  mesh: FillMesh,
  midpoint: Readonly<{ x: number; y: number }>,
  corners: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>,
  rho: number,
): Readonly<{ fringe: PathFringe; exterior: readonly Triangle[] }> {
  const vertexCount = mesh.positions.length / 2;
  const grid = new DyadicGrid([
    ...mesh.positions,
    midpoint.x,
    midpoint.y,
    corners.minX,
    corners.minY,
    corners.maxX,
    corners.maxY,
    rho,
  ]);
  const points: P[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    points.push([
      grid.scale(mesh.positions[2 * vertex]!),
      grid.scale(mesh.positions[2 * vertex + 1]!),
    ]);
  }
  // The triangulator and the partition check use the exact corner values m + k.
  const mx = grid.scale(midpoint.x);
  const my = grid.scale(midpoint.y);
  const x0 = mx + grid.scale(corners.minX);
  const y0 = my + grid.scale(corners.minY);
  const x1 = mx + grid.scale(corners.maxX);
  const y1 = my + grid.scale(corners.maxY);
  points.push([x0, y0], [x1, y0], [x1, y1], [x0, y1]);
  const frame = [vertexCount, vertexCount + 1, vertexCount + 2, vertexCount + 3] as const;
  const rhoScaled = grid.scale(rho);

  const directed: DirectedEdge[] = [];
  for (let slot = 0; slot < mesh.boundaryEdges.length; slot += 2) {
    directed.push({ from: mesh.boundaryEdges[slot]!, to: mesh.boundaryEdges[slot + 1]! });
  }
  const sectors = sectorsOf(points, directed);
  const exterior = triangulateComplement(points, directed, sectors, frame);
  const region: Triangle[] = [];
  for (let index = 0; index < mesh.indices.length; index += 3) {
    region.push([mesh.indices[index]!, mesh.indices[index + 1]!, mesh.indices[index + 2]!]);
  }
  // Exact partition check before publication.
  const partition = checkPartition(points, [...region, ...exterior], frame);
  if (partition !== null) unsupported(`partition:${partition}`);

  const fringe = encodeFringe(
    mesh,
    midpoint,
    corners,
    points,
    rhoScaled,
    directed,
    sectors,
    region,
    exterior,
  );
  return { fringe, exterior };
}

// ---------------------------------------------------------------------------------------------
// Exact dyadic grid.

class DyadicGrid {
  readonly #exponent: number;

  public constructor(values: readonly number[]) {
    let exponent = Number.POSITIVE_INFINITY;
    for (const value of values) {
      if (value === 0) continue;
      exponent = Math.min(exponent, toDyadic(value).e);
    }
    this.#exponent = Number.isFinite(exponent) ? exponent : 0;
  }

  /** The exact integer value * 2^-exponent. */
  public scale(value: number): bigint {
    if (value === 0) return 0n;
    const dyadic = toDyadic(value);
    return dyadic.n << BigInt(dyadic.e - this.#exponent);
  }
}

// ---------------------------------------------------------------------------------------------
// Exact integer predicates (O02 exterior.ts).

function cross(ax: bigint, ay: bigint, bx: bigint, by: bigint): bigint {
  return ax * by - ay * bx;
}

function orient(p: P, q: P, r: P): bigint {
  return cross(q[0] - p[0], q[1] - p[1], r[0] - p[0], r[1] - p[1]);
}

const same = (a: P, b: P) => a[0] === b[0] && a[1] === b[1];

/** 0 for angles in [0, 180) deg (y > 0, or y = 0 and x > 0), 1 for [180, 360). */
function halfPlane(d: P): number {
  return d[1] > 0n || (d[1] === 0n && d[0] > 0n) ? 0 : 1;
}

/** Exact angle order of nonzero directions; 0 only for equal directions. */
function compareAngle(a: P, b: P): number {
  const ha = halfPlane(a);
  const hb = halfPlane(b);
  if (ha !== hb) return ha - hb;
  const c = cross(a[0], a[1], b[0], b[1]);
  return c > 0n ? -1 : c < 0n ? 1 : 0;
}

/** True when the ccw sweep from direction a to direction b is 180 deg or more (b != a). */
function isReflex(a: P, b: P): boolean {
  const c = cross(a[0], a[1], b[0], b[1]);
  if (c !== 0n) return c < 0n;
  return a[0] * b[0] + a[1] * b[1] < 0n;
}

/** True when direction d lies strictly inside the ccw sweep from a to b (the sector test). */
function inSweep(a: P, b: P, d: P, reflex = isReflex(a, b)): boolean {
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
function segmentMeetsOutsideEndpoints(A: P, B: P, C: P, D: P): boolean {
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

/**
 * Sector pairing on the oriented boundary edges: rays at each boundary vertex sorted by exact
 * angle, every outgoing ray paired with the next counterclockwise ray, which must be a reversed
 * incoming edge. Fails on duplicate coordinates, more than three sectors or a failed pairing.
 */
function sectorsOf(points: readonly P[], directed: readonly DirectedEdge[]): VertexSectors[] {
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
      unsupported(`duplicate:${byCoordinate[i - 1]}:${byCoordinate[i]}`);
  for (const v of vertices) {
    const degree = rays.get(v)!.length;
    if (degree > 2 * MAX_SECTORS) unsupported(`degree:${v}:${degree}`);
  }
  const result: VertexSectors[] = [];
  for (const v of vertices) {
    const list = rays.get(v)!;
    for (const ray of list)
      if (ray.d[0] === 0n && ray.d[1] === 0n) unsupported(`sector-zero-ray:${v}`);
    const sorted = [...list].sort((a, b) => compareAngle(a.d, b.d));
    for (let i = 1; i < sorted.length; i += 1)
      if (compareAngle(sorted[i - 1]!.d, sorted[i]!.d) === 0) unsupported(`sector-ray-tie:${v}`);
    const sectors: Sector[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const ray = sorted[i]!;
      if (!ray.out) continue;
      const next = sorted[(i + 1) % sorted.length]!;
      if (next.out || next === ray) unsupported(`sector-pairing:${v}`);
      sectors.push({ rOut: [v, ray.other], rIn: [next.other, v], reflex: isReflex(ray.d, next.d) });
    }
    if (sectors.length * 2 !== sorted.length) unsupported(`sector-pairing:${v}`);
    result.push({ vertex: v, sectors });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Complement triangulation.

/** Trace boundary loops: each oriented edge continues with the rOut of the sector owning it. */
function traceLoops(
  directed: readonly DirectedEdge[],
  vertices: readonly VertexSectors[],
): number[][] {
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
      if (next === undefined) unsupported(`loop-successor:${edge.from}:${edge.to}`);
      const nextIndex = byKey.get(`${edge.to}:${next}`);
      if (nextIndex === undefined) unsupported(`loop-successor:${edge.to}:${next}`);
      index = nextIndex!;
    }
    if (index !== start) unsupported(`loop-open:${directed[start]!.from}`);
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
): number[] {
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
    if (merged === null) unsupported(`no-bridge:${order}`);
    chain = merged!;
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
 * continues with the outgoing half-edge met first when rotating clockwise from the reversed
 * incoming direction. Outgoing half-edges are indexed by tail in ascending edge order, which
 * gives O02's selection (first candidate in index order, replaced only by a strictly later
 * clockwise one) without scanning every edge.
 */
function traceWalks(points: readonly P[], edges: readonly HalfEdge[]): number[][] | null {
  const outgoing = new Map<number, number[]>();
  edges.forEach((edge, index) => {
    const list = outgoing.get(edge.from);
    if (list === undefined) outgoing.set(edge.from, [index]);
    else list.push(index);
  });
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
      for (const k of outgoing.get(edge.to) ?? []) {
        if (used[k] && k !== start) continue;
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
 * strictly inside the triangle's angle there.
 */
function entersCorner(
  points: readonly P[],
  edges: readonly HalfEdge[],
  own: ReadonlySet<number>,
  triangle: Triangle,
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
 * Ear clipping of a positively oriented weakly simple chain; triangles are positive. The open
 * boundary is kept as half-edges and re-traced into closed walks after every clip, so pinch
 * vertices may occur more than once. An ear has strictly positive exact area, no other boundary
 * vertex on the closed triangle except occurrences coincident with its corners, and no other
 * half-edge entering it at a corner. Fails with `no-ear` when no walk has an ear.
 */
function earClip(points: readonly P[], input: readonly number[]): Triangle[] {
  let edges: HalfEdge[] = input.map((v, i) => ({ from: v, to: input[(i + 1) % input.length]! }));
  const triangles: Triangle[] = [];
  while (edges.length > 0) {
    const walks = traceWalks(points, edges);
    if (walks === null) unsupported('walk');
    const vertices = [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))];
    let clipped = false;
    for (const walk of walks!) {
      const n = walk.length;
      if (n < 3) unsupported(`walk-length:${walk.join(',')}`);
      for (let i = 0; i < n && !clipped; i += 1) {
        const triangle = [walk[(i - 1 + n) % n]!, walk[i]!, walk[(i + 1) % n]!] as const;
        const a = points[triangle[0]]!;
        const b = points[triangle[1]]!;
        const c = points[triangle[2]]!;
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
        if (first < 0 || second < 0) unsupported('walk-edge');
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
    if (!clipped) unsupported('no-ear');
  }
  return triangles;
}

/**
 * Triangulate frame minus region: boundary loops, nesting by exact midpoint point-in-polygon,
 * faces (frame minus top-level loops; each pocket minus its islands) merged and ear-clipped.
 */
function triangulateComplement(
  points: readonly P[],
  directed: readonly DirectedEdge[],
  vertices: readonly VertexSectors[],
  frame: readonly [number, number, number, number],
): Triangle[] {
  const loops = traceLoops(directed, vertices);
  const areas = loops.map((loop) => twiceArea(points, loop));
  for (let i = 0; i < loops.length; i += 1)
    if (areas[i] === 0n) unsupported(`loop-area:${loops[i]![0]}`);
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
      if (where < 0) unsupported(`nesting-boundary:${i}:${j}`);
      if (where === 1) containers[i]!.push(j);
    }
  }
  const depth = containers.map((list) => list.length);
  const parent = containers.map((list) =>
    list.length === 0 ? -1 : list.reduce((best, j) => (depth[j]! > depth[best]! ? j : best)),
  );
  for (let i = 0; i < loops.length; i += 1) {
    const outer = areas[i]! > 0n;
    if (outer !== (depth[i]! % 2 === 0)) unsupported(`nesting-parity:${i}`);
    if (parent[i]! >= 0 && depth[parent[i]!] !== depth[i]! - 1) unsupported(`nesting-depth:${i}`);
  }
  const reversed = (loop: readonly number[]) => [...loop].reverse();
  const faces: { outer: number[]; holes: number[][] }[] = [
    { outer: [...frame], holes: loops.filter((_, i) => parent[i] === -1).map(reversed) },
  ];
  for (let i = 0; i < loops.length; i += 1)
    if (areas[i]! < 0n)
      faces.push({
        outer: reversed(loops[i]!),
        holes: loops.filter((_, j) => parent[j] === i).map(reversed),
      });
  const triangles: Triangle[] = [];
  for (const face of faces)
    triangles.push(...earClip(points, mergeHoles(points, face.outer, face.holes)));
  return triangles;
}

// ---------------------------------------------------------------------------------------------
// Partition check.

/**
 * Exact partition check over all drawn triangles: consistent nonzero orientation, no duplicate
 * vertex coordinate, every non-frame edge used exactly twice in opposite directions, every frame
 * side exactly once, no vertex in the interior of an edge, and the areas summing to the frame
 * area. Returns null or the failed check.
 */
function checkPartition(
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
// Features, lists and records (section f).

/** Exact: is the squared distance from p to the closed segment ab at most r2? */
function pointSegmentWithin(p: P, a: P, b: P, r2: bigint): boolean {
  const ex = b[0] - a[0];
  const ey = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const length2 = ex * ex + ey * ey;
  const t = wx * ex + wy * ey;
  if (length2 === 0n || t <= 0n) return wx * wx + wy * wy <= r2;
  if (t >= length2) {
    const vx = p[0] - b[0];
    const vy = p[1] - b[1];
    return vx * vx + vy * vy <= r2;
  }
  const c = ex * wy - ey * wx;
  return c * c <= r2 * length2;
}

function sign(value: bigint): number {
  return value > 0n ? 1 : value < 0n ? -1 : 0;
}

function insideClosed(p: P, triangle: readonly [P, P, P]): boolean {
  const [a, b, c] = triangle;
  const s = sign(orient(a, b, c));
  if (s === 0) return false;
  return (
    sign(orient(a, b, p)) * s >= 0 &&
    sign(orient(b, c, p)) * s >= 0 &&
    sign(orient(c, a, p)) * s >= 0
  );
}

/** Exact: is the distance from p to the closed triangle at most r? */
function pointTriangleWithin(p: P, triangle: readonly [P, P, P], r2: bigint): boolean {
  if (insideClosed(p, triangle)) return true;
  const [a, b, c] = triangle;
  return (
    pointSegmentWithin(p, a, b, r2) ||
    pointSegmentWithin(p, b, c, r2) ||
    pointSegmentWithin(p, c, a, r2)
  );
}

function segmentsIntersect(a: P, b: P, c: P, d: P): boolean {
  const o1 = sign(orient(a, b, c));
  const o2 = sign(orient(a, b, d));
  const o3 = sign(orient(c, d, a));
  const o4 = sign(orient(c, d, b));
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (
    (o1 === 0 && onSegment(a, b, c)) ||
    (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) ||
    (o4 === 0 && onSegment(c, d, b))
  );
}

/** Exact: is the distance between the closed segment ab and the closed triangle at most r? */
function segmentTriangleWithin(a: P, b: P, triangle: readonly [P, P, P], r2: bigint): boolean {
  const [p, q, s] = triangle;
  if (
    insideClosed(a, triangle) ||
    segmentsIntersect(a, b, p, q) ||
    segmentsIntersect(a, b, q, s) ||
    segmentsIntersect(a, b, s, p)
  )
    return true;
  return (
    pointTriangleWithin(a, triangle, r2) ||
    pointTriangleWithin(b, triangle, r2) ||
    pointSegmentWithin(p, a, b, r2) ||
    pointSegmentWithin(q, a, b, r2) ||
    pointSegmentWithin(s, a, b, r2)
  );
}

type Box = readonly [bigint, bigint, bigint, bigint];
function boxOf(points: readonly P[]): Box {
  let x0 = points[0]![0];
  let y0 = points[0]![1];
  let x1 = x0;
  let y1 = y0;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
/** Exact prefilter: false proves a distance above r in one axis, hence above r. */
function boxesWithin(left: Box, right: Box, r: bigint): boolean {
  return (
    left[0] - r <= right[2] &&
    right[0] - r <= left[2] &&
    left[1] - r <= right[3] &&
    right[1] - r <= left[3]
  );
}

const wordScratch = new DataView(new ArrayBuffer(4));
function float32Word(value: number): number {
  wordScratch.setFloat32(0, value);
  return wordScratch.getUint32(0);
}

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

/**
 * fround(c * 2^-shift), correctly rounded: c is first rounded to 53 bits with round-to-odd,
 * which makes the binary32 rounding of the Float64 value equal to the direct rounding.
 */
function scaledToFloat32(c: bigint, shift: number): number {
  if (c === 0n) return 0;
  const negative = c < 0n;
  let magnitude = negative ? -c : c;
  const length = bitLength(magnitude);
  let dropped = 0;
  if (length > 53) {
    dropped = length - 53;
    const truncated = magnitude >> BigInt(dropped);
    magnitude = truncated << BigInt(dropped) === magnitude ? truncated : truncated | 1n;
  }
  const value = Number(magnitude) * 2 ** (dropped - shift);
  return Math.fround(negative ? -value : value);
}

/**
 * A local direction as binary32 lanes: the exact difference scaled by one power of two so its
 * larger component lies in [1, 2), then rounded once. Only its direction is used by the shader's
 * sign tests, so the scale never overflows binary32.
 */
function direction(d: P): readonly [number, number] {
  const ax = d[0] < 0n ? -d[0] : d[0];
  const ay = d[1] < 0n ? -d[1] : d[1];
  const shift = bitLength(ax > ay ? ax : ay) - 1;
  return [scaledToFloat32(d[0], shift), scaledToFloat32(d[1], shift)];
}

function encodeFringe(
  mesh: FillMesh,
  midpoint: Readonly<{ x: number; y: number }>,
  corners: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>,
  points: readonly P[],
  rho: bigint,
  directed: readonly DirectedEdge[],
  sectors: readonly VertexSectors[],
  region: readonly Triangle[],
  exterior: readonly Triangle[],
): PathFringe {
  // Feature offsets are the K4 vertex offsets u = fround(v - m), the difference in Float64, so
  // features coincide with the drawn port vertices.
  const offset = (vertex: number): readonly [number, number] => [
    Math.fround(mesh.positions[2 * vertex]! - midpoint.x),
    Math.fround(mesh.positions[2 * vertex + 1]! - midpoint.y),
  ];
  // Global order: EDGE features by (from, to), VERTEX features by vertex index.
  const edges = [...directed].sort((left, right) => left.from - right.from || left.to - right.to);
  const featureCount = edges.length + sectors.length;
  const features = new Uint32Array(featureCount * FRINGE_FEATURE_WORDS);
  edges.forEach((edge, index) => {
    const at = index * FRINGE_FEATURE_WORDS;
    const a = offset(edge.from);
    const b = offset(edge.to);
    features[at] = FRINGE_FEATURE_EDGE;
    features[at + 1] = float32Word(a[0]);
    features[at + 2] = float32Word(a[1]);
    features[at + 3] = float32Word(b[0]);
    features[at + 4] = float32Word(b[1]);
  });
  sectors.forEach(({ vertex, sectors: list }, index) => {
    const at = (edges.length + index) * FRINGE_FEATURE_WORDS;
    const v = offset(vertex);
    const origin = points[vertex]!;
    let flags = list.length;
    features[at] = FRINGE_FEATURE_VERTEX;
    features[at + 2] = float32Word(v[0]);
    features[at + 3] = float32Word(v[1]);
    list.forEach((sector, sectorIndex) => {
      if (sector.reflex) flags |= 1 << (REFLEX_SHIFT + sectorIndex);
      const w = points[sector.rOut[1]]!;
      const u = points[sector.rIn[0]]!;
      const rOut = direction([w[0] - origin[0], w[1] - origin[1]]);
      const rIn = direction([u[0] - origin[0], u[1] - origin[1]]);
      const base = at + 4 + 4 * sectorIndex;
      features[base] = float32Word(rOut[0]);
      features[base + 1] = float32Word(rOut[1]);
      features[base + 2] = float32Word(rIn[0]);
      features[base + 3] = float32Word(rIn[1]);
    });
    features[at + 1] = flags >>> 0;
  });

  // Lists: every feature within exact local distance rho of the closed triangle.
  const r2 = rho * rho;
  const edgeBoxes = edges.map((edge) => boxOf([points[edge.from]!, points[edge.to]!]));
  const vertexBoxes = sectors.map(({ vertex }) => boxOf([points[vertex]!]));
  const listFor = (triangle: Triangle): number[] => {
    const corners3 = [points[triangle[0]]!, points[triangle[1]]!, points[triangle[2]]!] as const;
    const box = boxOf(corners3);
    const near: number[] = [];
    edges.forEach((edge, index) => {
      if (!boxesWithin(edgeBoxes[index]!, box, rho)) return;
      if (segmentTriangleWithin(points[edge.from]!, points[edge.to]!, corners3, r2))
        near.push(index);
    });
    sectors.forEach(({ vertex }, index) => {
      if (!boxesWithin(vertexBoxes[index]!, box, rho)) return;
      if (pointTriangleWithin(points[vertex]!, corners3, r2)) near.push(edges.length + index);
    });
    return near;
  };

  const records: Array<Readonly<{ triangle: Triangle; role: number; list: number[] }>> = [];
  for (const triangle of region)
    records.push({ triangle, role: FRINGE_ROLE_REGION, list: listFor(triangle) });
  let dropped = 0;
  for (const triangle of exterior) {
    const list = listFor(triangle);
    // An exterior triangle with an empty list is more than rho (2 px) from the boundary: c = 0.
    if (list.length === 0) {
      dropped += 1;
      continue;
    }
    records.push({ triangle, role: FRINGE_ROLE_EXTERIOR, list });
  }
  const listLength = records.reduce((sum, record) => sum + record.list.length, 0);
  const lists = new Uint32Array(listLength);
  const triangles = new Uint32Array(records.length * FRINGE_TRIANGLE_WORDS);
  let listOffset = 0;
  records.forEach((record, index) => {
    const at = index * FRINGE_TRIANGLE_WORDS;
    triangles[at] = record.triangle[0];
    triangles[at + 1] = record.triangle[1];
    triangles[at + 2] = record.triangle[2];
    triangles[at + 3] = listOffset;
    triangles[at + 4] = record.list.length;
    triangles[at + 5] = record.role;
    lists.set(record.list, listOffset);
    listOffset += record.list.length;
  });
  return Object.freeze({
    corners: Float32Array.of(
      corners.minX,
      corners.minY,
      corners.maxX,
      corners.minY,
      corners.maxX,
      corners.maxY,
      corners.minX,
      corners.maxY,
    ),
    triangles,
    lists,
    features,
    regionTriangles: region.length,
    exteriorTriangles: records.length - region.length,
    droppedExterior: dropped,
  });
}

/** Bytes owned by a fringe variant (section d): corners, triangle records, lists, features. */
export function pathFringeBytes(fringe: PathFringe): number {
  return (
    fringe.corners.byteLength +
    fringe.triangles.byteLength +
    fringe.lists.byteLength +
    fringe.features.byteLength
  );
}
