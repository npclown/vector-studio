import { rational, type Rational } from '../rounded-fill/exact.js';
import { inSweep, type P, type SectorsResult } from './exterior.js';
import type { CoverageRowGeometry } from './positions.js';

/**
 * P3.1o O02 exact rule oracle (docs/plans/p3-o02-a5-coverage-contract.md, "Coverage rule"). For a
 * point p, q is the nearest point of the reference boundary over all boundary edges (closed
 * segments) and boundary vertices, v = p - q and
 *
 *   s / w = +-|v|^2 / (|v.x| + |v.y|)   (negative inside),   c = clamp(1/2 - s / w, 0, 1),
 *
 * with c = 1/2 when |v| = 0. The sign comes from the edge's line when q is taken from an edge and
 * from the vertex's region sectors when q is taken from a vertex. Ties are broken by edges before
 * vertices, then the lower global id (edges in (a, b) order, vertices by index); the nearest
 * feature is replaced only on a strictly smaller exact distance.
 *
 * All arithmetic is on integers: the preimage scaled by 2^k (positions.ts) and the query point
 * scaled to the same grid. Pixel centers (i + 1/2, j + 1/2) are integral on that grid (k >= 1).
 */

type EdgeFeature = Readonly<{ a: P; ex: bigint; ey: bigint; length2: bigint; l1: bigint }>;
type VertexFeature = Readonly<{
  p: P;
  sectors: readonly Readonly<{ out: P; inward: P; reflex: boolean }>[];
}>;

export type RuleContext = Readonly<{
  geometry: CoverageRowGeometry;
  /** 2^k: preimage units per px. */
  scale: bigint;
  edges: readonly EdgeFeature[];
  vertices: readonly VertexFeature[];
}>;

export type Nearest = Readonly<{
  kind: 'edge' | 'vertex' | 'none';
  /** Index into geometry.boundaryEdges or the ascending boundary vertex list. */
  id: number;
  /** Exact squared distance num / den in (grid units)^2, den > 0. */
  num: bigint;
  den: bigint;
  /** +1 inside, -1 outside, 0 on the boundary. */
  side: -1 | 0 | 1;
  /** |s / w| as magNum / magDen in grid units, magDen > 0. */
  magNum: bigint;
  magDen: bigint;
}>;

/** Rule context of a row: oriented boundary edges and vertex sectors on the scaled preimage. */
export function ruleContext(geometry: CoverageRowGeometry, sectors: SectorsResult): RuleContext {
  if (sectors.status !== 'OK') throw new Error(`rule:${sectors.reason}`);
  const points = geometry.scaled;
  const edges = sectors.directed.map((edge): EdgeFeature => {
    const a = points[edge.from]!;
    const b = points[edge.to]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    return {
      a,
      ex,
      ey,
      length2: ex * ex + ey * ey,
      l1: (ex < 0n ? -ex : ex) + (ey < 0n ? -ey : ey),
    };
  });
  const direction = (from: number, to: number): P => [
    points[to]![0] - points[from]![0],
    points[to]![1] - points[from]![1],
  ];
  const vertices = sectors.vertices.map(({ vertex, sectors: list }): VertexFeature => ({
    p: points[vertex]!,
    sectors: list.map((sector) => ({
      out: direction(vertex, sector.rOut[1]),
      inward: direction(vertex, sector.rIn[0]),
      reflex: sector.reflex,
    })),
  }));
  return { geometry, scale: 1n << BigInt(geometry.scaleExponent), edges, vertices };
}

const abs = (value: bigint) => (value < 0n ? -value : value);

/**
 * Nearest boundary feature of the point (x, y) / m (grid units, m > 0): x, y and every feature
 * coordinate are compared as exact fractions.
 */
export function nearestFeature(context: RuleContext, x: bigint, y: bigint, m = 1n): Nearest {
  let best: Nearest = {
    kind: 'none',
    id: -1,
    num: 1n,
    den: 0n,
    side: 0,
    magNum: 0n,
    magDen: 1n,
  };
  const better = (num: bigint, den: bigint) => best.den === 0n || num * best.den < best.num * den;
  context.edges.forEach((edge, id) => {
    // w = p - a in units of 1/m.
    const wx = x - edge.a[0] * m;
    const wy = y - edge.a[1] * m;
    const dot = wx * edge.ex + wy * edge.ey;
    if (dot < 0n || dot > edge.length2 * m) return;
    const c = edge.ex * wy - edge.ey * wx;
    // distance^2 = c^2 / (length2 m^2) grid units^2.
    const num = c * c;
    const den = edge.length2 * m * m;
    if (!better(num, den)) return;
    best = {
      kind: 'edge',
      id,
      num,
      den,
      side: c > 0n ? 1 : c < 0n ? -1 : 0,
      magNum: abs(c),
      magDen: edge.l1 * m,
    };
  });
  context.vertices.forEach((vertex, id) => {
    const dx = x - vertex.p[0] * m;
    const dy = y - vertex.p[1] * m;
    const num = dx * dx + dy * dy;
    const den = m * m;
    if (!better(num, den)) return;
    let side: -1 | 0 | 1 = 0;
    if (num !== 0n) {
      const d: P = [dx, dy];
      side = vertex.sectors.some((sector) => inSweep(sector.out, sector.inward, d, sector.reflex))
        ? 1
        : -1;
    }
    best = {
      kind: 'vertex',
      id,
      num,
      den,
      side,
      magNum: num,
      magDen: num === 0n ? 1n : (abs(dx) + abs(dy)) * m,
    };
  });
  return best;
}

/** c from a nearest feature: clamp(1/2 + side * mag, 0, 1) with mag in px. */
export function coverageOf(nearest: Nearest, scale: bigint): Rational {
  if (nearest.kind === 'none' || nearest.side === 0) return rational(1n, 2n);
  const den = 2n * nearest.magDen * scale;
  const num = nearest.magDen * scale + BigInt(nearest.side) * 2n * nearest.magNum;
  if (num <= 0n) return rational(0n);
  if (num >= den) return rational(1n);
  return rational(num, den);
}

/** Exact rule coverage at the physical point (px, py). */
export function ruleCoverage(
  geometry: CoverageRowGeometry,
  sectors: SectorsResult,
  px: Rational,
  py: Rational,
): Rational {
  const context = ruleContext(geometry, sectors);
  const m = px.d * py.d;
  return coverageOf(
    nearestFeature(context, px.n * py.d * context.scale, py.n * px.d * context.scale, m),
    context.scale,
  );
}

/** Exact rule coverage at the center of pixel (i, j). */
export function ruleAtPixel(context: RuleContext, i: number, j: number): Rational {
  const half = context.scale >> 1n;
  return coverageOf(
    nearestFeature(context, BigInt(2 * i + 1) * half, BigInt(2 * j + 1) * half),
    context.scale,
  );
}

/**
 * Exact squared distance (px^2) from the physical point (px, py) to the reference boundary (closed
 * segments).
 */
export function boundaryDistanceSquared(
  geometry: CoverageRowGeometry,
  px: Rational,
  py: Rational,
): Rational {
  const S = 1n << BigInt(geometry.scaleExponent);
  const m = px.d * py.d;
  const [num, den] = segmentDistanceSquared(geometry, px.n * py.d * S, py.n * px.d * S, m);
  return rational(num, den * S * S);
}

/**
 * Exact squared distance from (x, y) / m (grid units) to the closed boundary segments of a row, as
 * [num, den] in grid units^2 (den > 0).
 */
export function segmentDistanceSquared(
  geometry: CoverageRowGeometry,
  x: bigint,
  y: bigint,
  m = 1n,
): [bigint, bigint] {
  let bestNum = -1n;
  let bestDen = 1n;
  const points = geometry.scaled;
  for (const edge of geometry.boundaryEdges) {
    const a = points[edge.a]!;
    const b = points[edge.b]!;
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const wx = x - a[0] * m;
    const wy = y - a[1] * m;
    const dot = wx * ex + wy * ey;
    const length2 = ex * ex + ey * ey;
    let num: bigint;
    let den: bigint;
    if (dot <= 0n) {
      num = wx * wx + wy * wy;
      den = m * m;
    } else if (dot >= length2 * m) {
      const vx = x - b[0] * m;
      const vy = y - b[1] * m;
      num = vx * vx + vy * vy;
      den = m * m;
    } else {
      const c = ex * wy - ey * wx;
      num = c * c;
      den = length2 * m * m;
    }
    if (bestNum < 0n || num * bestDen < bestNum * den) {
      bestNum = num;
      bestDen = den;
    }
  }
  return [bestNum, bestDen];
}
