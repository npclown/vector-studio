import { compare, mul, sign, sub, type Rational } from '../rounded-fill/exact.js';
import { doubleArea, type Cell, type Q2 } from '../extent-t01/clip.js';
import {
  cross,
  earClip as earClipO02,
  inSweep,
  orient,
  segmentMeetsOutsideEndpoints,
  type P,
  type Triangle,
} from '../coverage-oracle/exterior.js';

/**
 * P3.1p T02 exterior fringe per cell (docs/plans/p3-r2-tiling-contract.md, "P3. Exterior fringe
 * per cell" and "Mechanism" 4). Test-only and exact.
 *
 * The cell's exact rational points are translated to the cell's lower-left corner and scaled to
 * integers by the LCM of their denominators (a positive similarity, so every O02 orientation, angle
 * and distance tie is unchanged). The pinned O02 `exterior.ts` stays unchanged: its exported
 * `earClip`, `orient`, `cross`, `inSweep` and `segmentMeetsOutsideEndpoints` are imported, and the
 * unexported `traceWalks`, `mergeHoles` (with `wedgeContains` and `chainEdges`), `twiceArea` and
 * `pointInLoop` are copied verbatim below, apart from returning a reason string instead of an
 * `ExteriorFailure`.
 *
 * Faces are traced in positive orientation (positive shoelace area): region rings of negative
 * winding are reversed first, and exterior triangles are emitted in the region's winding.
 */

export type FringeResult =
  | Readonly<{
      status: 'OK';
      /** Exterior triangles, in the region's winding. */
      exterior: readonly (readonly [Q2, Q2, Q2])[];
      /** Exterior faces traced (outer walks). */
      faces: number;
    }>
  | Readonly<{ status: 'FAIL'; reason: string }>;

// ---------------------------------------------------------------------------------------------
// Copied O02 routines (tests/geometry/coverage-oracle/exterior.ts, pinned, not exported there).

const same = (a: P, b: P) => a[0] === b[0] && a[1] === b[1];

/** For p collinear with a and b: true when p lies on the closed segment ab. */
function onSegmentP(a: P, b: P, p: P): boolean {
  return (
    p[0] >= (a[0] < b[0] ? a[0] : b[0]) &&
    p[0] <= (a[0] < b[0] ? b[0] : a[0]) &&
    p[1] >= (a[1] < b[1] ? a[1] : b[1]) &&
    p[1] <= (a[1] < b[1] ? b[1] : a[1])
  );
}

export function twiceArea(points: readonly P[], chain: readonly number[]): bigint {
  let sum = 0n;
  for (let i = 0; i < chain.length; i += 1) {
    const p = points[chain[i]!]!;
    const q = points[chain[(i + 1) % chain.length]!]!;
    sum += p[0] * q[1] - p[1] * q[0];
  }
  return sum;
}

/** Crossing-number point-in-polygon on doubled coordinates: 1 inside, 0 outside, -1 on boundary. */
export function pointInLoop(points: readonly P[], loop: readonly number[], m: P): -1 | 0 | 1 {
  let inside = false;
  for (let i = 0; i < loop.length; i += 1) {
    const u0 = points[loop[i]!]!;
    const v0 = points[loop[(i + 1) % loop.length]!]!;
    const u: P = [2n * u0[0], 2n * u0[1]];
    const v: P = [2n * v0[0], 2n * v0[1]];
    const o = orient(u, v, m);
    if (o === 0n && onSegmentP(u, v, m)) return -1;
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
export function mergeHoles(
  points: readonly P[],
  outer: readonly number[],
  holes: readonly (readonly number[])[],
): number[] | string {
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
    if (merged === null) return `no-bridge:${order}`;
    chain = merged;
  }
  return chain;
}

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

export type HalfEdge = { from: number; to: number };

/**
 * Trace the open boundary half-edges (face on the left) into closed walks. At a vertex the walk
 * continues with the outgoing half-edge met first when rotating clockwise from the reversed incoming
 * direction (the face sector adjacent to the incoming edge; an exactly reversed edge comes last).
 */
export function traceWalks(points: readonly P[], edges: readonly HalfEdge[]): number[][] | null {
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

// ---------------------------------------------------------------------------------------------
// Exact helpers.

export const pointKey = (point: Q2): string =>
  `${point[0].n}/${point[0].d},${point[1].n}/${point[1].d}`;

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function comparePoints(left: Q2, right: Q2): number {
  return compare(left[0], right[0]) || compare(left[1], right[1]);
}

/** True when p lies on the closed segment ab (exact). */
export function onClosedSegment(p: Q2, a: Q2, b: Q2): boolean {
  const c = sub(mul(sub(b[0], a[0]), sub(p[1], a[1])), mul(sub(b[1], a[1]), sub(p[0], a[0])));
  if (sign(c) !== 0) return false;
  const within = (value: Rational, s: Rational, t: Rational) =>
    compare(value, compare(s, t) <= 0 ? s : t) >= 0 &&
    compare(value, compare(s, t) <= 0 ? t : s) <= 0;
  return within(p[0], a[0], b[0]) && within(p[1], a[1], b[1]);
}

/** Integer image of exact points: (v − origin) · lcm(denominators). */
function scaleToIntegers(points: readonly Q2[], origin: Q2): P[] {
  const shifted = points.map((point) => [sub(point[0], origin[0]), sub(point[1], origin[1])]);
  let lcm = 1n;
  for (const [x, y] of shifted)
    for (const value of [x!, y!]) lcm = (lcm / gcd(lcm, value.d)) * value.d;
  return shifted.map(([x, y]) => [x!.n * (lcm / x!.d), y!.n * (lcm / y!.d)] as const);
}

// ---------------------------------------------------------------------------------------------
// fringeFaces.

/**
 * Partition a fringe cell into its region pieces and exterior triangles (contract P3):
 *
 * 1. The cell's convex region rings are unioned into half-edges (positive orientation), each
 *    subdivided at every cell point strictly inside it, and opposite pairs cancel.
 * 2. Every side point (the cell's own grid-line crossings, its corners, and every region vertex on a
 *    side) subdivides the square's sides; the exterior half-edges are the reversed region boundary
 *    plus the side segments, with opposite pairs cancelled (a side segment covered by region).
 * 3. Faces are traced with O02's clockwise-first rule (sector pairing at pinches), holes (negative
 *    walks) are nested in the innermost positive walk containing their first edge's midpoint (exact
 *    point-in-polygon), bridged by O02's `mergeHoles` and ear-clipped by O02's `earClip`.
 *
 * `winding` is the region's winding (+1 or −1); the exterior triangles take it.
 */
export function fringeFaces(
  cell: Cell,
  regionPieces: readonly (readonly Q2[])[],
  sidePoints: readonly Q2[],
  winding: 1 | -1 = 1,
): FringeResult {
  const fail = (reason: string): FringeResult => ({ status: 'FAIL', reason });
  const corners: Q2[] = [
    [cell.x0, cell.y0],
    [cell.x1, cell.y0],
    [cell.x1, cell.y1],
    [cell.x0, cell.y1],
  ];
  const rings = regionPieces.map((ring) =>
    sign(doubleArea(ring)) < 0 ? [...ring].reverse() : [...ring],
  );
  const byKey = new Map<string, Q2>();
  for (const point of [...corners, ...sidePoints, ...rings.flat()])
    byKey.set(pointKey(point), point);
  const exact = [...byKey.values()].sort(comparePoints);
  const index = new Map(exact.map((point, position) => [pointKey(point), position]));
  const points = scaleToIntegers(exact, corners[0]!);

  /** Directed segment a→b, subdivided at every cell point strictly inside it. */
  const subdivide = (a: number, b: number): [number, number][] => {
    const A = points[a]!;
    const B = points[b]!;
    const inner: { id: number; t: bigint }[] = [];
    const dx = B[0] - A[0];
    const dy = B[1] - A[1];
    for (let id = 0; id < points.length; id += 1) {
      if (id === a || id === b) continue;
      const p = points[id]!;
      if (orient(A, B, p) !== 0n || !onSegmentP(A, B, p)) continue;
      inner.push({ id, t: (p[0] - A[0]) * dx + (p[1] - A[1]) * dy });
    }
    inner.sort((left, right) => (left.t < right.t ? -1 : left.t > right.t ? 1 : 0));
    const chain = [a, ...inner.map((entry) => entry.id), b];
    return chain.slice(1).map((id, k) => [chain[k]!, id]);
  };

  const cancel = (edges: readonly [number, number][]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const [a, b] of edges) {
      const reverse = `${b}:${a}`;
      const existing = counts.get(reverse) ?? 0;
      if (existing > 0) {
        if (existing === 1) counts.delete(reverse);
        else counts.set(reverse, existing - 1);
      } else counts.set(`${a}:${b}`, (counts.get(`${a}:${b}`) ?? 0) + 1);
    }
    return counts;
  };

  const regionEdges: [number, number][] = [];
  for (const ring of rings) {
    const ids = ring.map((point) => index.get(pointKey(point))!);
    for (let k = 0; k < ids.length; k += 1)
      regionEdges.push(...subdivide(ids[k]!, ids[(k + 1) % ids.length]!));
  }
  const boundary = cancel(regionEdges);
  const exteriorEdges: [number, number][] = [];
  for (const [key, count] of boundary) {
    if (count !== 1) return fail(`region-overlap:${key}`);
    const [a, b] = key.split(':').map(Number) as [number, number];
    exteriorEdges.push([b, a]);
  }
  const cornerIds = corners.map((point) => index.get(pointKey(point))!);
  for (let k = 0; k < 4; k += 1)
    exteriorEdges.push(...subdivide(cornerIds[k]!, cornerIds[(k + 1) % 4]!));
  const open = cancel(exteriorEdges);
  const halfEdges: HalfEdge[] = [];
  for (const [key, count] of [...open.entries()].sort(([a], [b]) => compareKeys(a, b))) {
    if (count !== 1) return fail(`exterior-overlap:${key}`);
    const [from, to] = key.split(':').map(Number) as [number, number];
    halfEdges.push({ from, to });
  }
  if (halfEdges.length === 0) return { status: 'OK', exterior: [], faces: 0 };
  const balance = new Map<number, number>();
  for (const { from, to } of halfEdges) {
    balance.set(from, (balance.get(from) ?? 0) + 1);
    balance.set(to, (balance.get(to) ?? 0) - 1);
  }
  for (const [vertex, value] of balance) if (value !== 0) return fail(`degree:${vertex}`);

  const walks = traceWalks(points, halfEdges);
  if (walks === null) return fail('walk');
  const areas = walks.map((walk) => twiceArea(points, walk));
  const outers: number[] = [];
  const holes: number[] = [];
  for (let w = 0; w < walks.length; w += 1) {
    if (areas[w] === 0n) return fail(`walk-area:${w}`);
    (areas[w]! > 0n ? outers : holes).push(w);
  }
  const holesOf = new Map<number, number[][]>(outers.map((w) => [w, []]));
  for (const h of holes) {
    const walk = walks[h]!;
    const p = points[walk[0]!]!;
    const q = points[walk[1 % walk.length]!]!;
    const m: P = [p[0] + q[0], p[1] + q[1]];
    let best = -1;
    for (const w of outers) {
      const where = pointInLoop(points, walks[w]!, m);
      if (where < 0) return fail(`nesting-boundary:${h}:${w}`);
      if (where === 1 && (best < 0 || areas[w]! < areas[best]!)) best = w;
    }
    if (best < 0) return fail(`nesting-orphan:${h}`);
    holesOf.get(best)!.push(walk);
  }
  const triangles: Triangle[] = [];
  for (const w of outers) {
    const chain = mergeHoles(points, walks[w]!, holesOf.get(w)!);
    if (typeof chain === 'string') return fail(chain);
    const clipped = earClipO02(points, chain);
    if (!Array.isArray(clipped)) return fail(clipped.reason);
    triangles.push(...clipped);
  }
  const exterior = triangles.map(([a, b, c]) =>
    winding > 0
      ? ([exact[a]!, exact[b]!, exact[c]!] as const)
      : ([exact[a]!, exact[c]!, exact[b]!] as const),
  );
  return { status: 'OK', exterior, faces: outers.length };
}

function compareKeys(left: string, right: string): number {
  const [a0, a1] = left.split(':').map(Number) as [number, number];
  const [b0, b1] = right.split(':').map(Number) as [number, number];
  return a0 - b0 || a1 - b1;
}

/** Exact cell area 2^(2L) as a rational, for area checks. */
export function cellArea(cell: Cell): Rational {
  return mul(sub(cell.x1, cell.x0), sub(cell.y1, cell.y0));
}
