import type { Crop } from '../geometry/coverage-oracle/crop.js';
import type { CoverageRowGeometry } from '../geometry/coverage-oracle/positions.js';

/**
 * P3.1o O01 Primary builder (docs/plans/p3-o01-coverage-experiment-contract.md): outward edge
 * coefficients relative to the crop origin, the interior triangle soup and the fringe quads, each
 * vertex a 64-byte record [ndc.x, ndc.y, 0, 0, e0, e1, e2] with e = (n.x, n.y, c, flag).
 */

const f = Math.fround;
const RECORD_FLOATS = 16;

export type BuiltEdge = Readonly<{
  a: number;
  b: number;
  third: number;
  /** Unrounded binary64 outward unit normal (used for the fringe outer vertices). */
  normal64: readonly [number, number];
  /** binary32 coefficient values (n.x, n.y, c). */
  n: readonly [number, number];
  c: number;
}>;

export type BuiltRow = Readonly<{
  origin: readonly [number, number];
  edges: readonly BuiltEdge[];
  soup: Uint8Array;
  fringe: Uint8Array;
}>;

const f32Word = (value: number) => {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
};

/** binary64 preimage (ndc + 1)·W/2, (1 - ndc)·H/2, asserted equal to the oracle's exact preimage. */
function preimagePoint(geometry: CoverageRowGeometry, index: number): readonly [number, number] {
  const [nx, ny] = geometry.ndc[index]!;
  const point = [((nx + 1) * geometry.width) / 2, ((1 - ny) * geometry.height) / 2] as const;
  const scale = 2 ** geometry.scaleExponent;
  const exact = geometry.scaled[index]!;
  for (const axis of [0, 1] as const)
    if (!Number.isFinite(point[axis] * scale) || BigInt(point[axis] * scale) !== exact[axis])
      throw new Error(`preimage-not-binary64:${index}:${axis}`);
  return point;
}

export function wordsOf(edge: BuiltEdge): {
  a: number;
  b: number;
  third: number;
  n: [number, number];
  c: number;
} {
  return {
    a: edge.a,
    b: edge.b,
    third: edge.third,
    n: [f32Word(edge.n[0]), f32Word(edge.n[1])],
    c: f32Word(edge.c),
  };
}

export function buildRow(geometry: CoverageRowGeometry, crop: Crop): BuiltRow {
  const origin = [crop.x, crop.y] as const;
  const point = (index: number) => preimagePoint(geometry, index);
  const edges: BuiltEdge[] = geometry.boundaryEdges.map(({ a, b, third }) => {
    const p0 = point(a);
    const p1 = point(b);
    const t = point(third);
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const length = Math.hypot(dx, dy);
    let nx = dy / length;
    let ny = -dx / length;
    if (nx * (t[0] - p0[0]) + ny * (t[1] - p0[1]) > 0) {
      nx = -nx;
      ny = -ny;
    }
    const c = -(nx * (p0[0] - origin[0]) + ny * (p0[1] - origin[1]));
    return { a, b, third, normal64: [nx, ny], n: [f(nx), f(ny)], c: f(c) };
  });
  const edgeKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const byKey = new Map(edges.map((edge) => [edgeKey(edge.a, edge.b), edge]));

  const soupFloats = new Float32Array(geometry.triangles.length * 3 * RECORD_FLOATS);
  geometry.triangles.forEach((triangle, t) => {
    const slots = [
      byKey.get(edgeKey(triangle[0], triangle[1])),
      byKey.get(edgeKey(triangle[1], triangle[2])),
      byKey.get(edgeKey(triangle[2], triangle[0])),
    ];
    triangle.forEach((vertex, corner) => {
      const base = (t * 3 + corner) * RECORD_FLOATS;
      soupFloats[base] = geometry.ndc[vertex]![0];
      soupFloats[base + 1] = geometry.ndc[vertex]![1];
      slots.forEach((edge, slot) => {
        if (edge === undefined) return;
        const offset = base + 4 + slot * 4;
        soupFloats[offset] = edge.n[0];
        soupFloats[offset + 1] = edge.n[1];
        soupFloats[offset + 2] = edge.c;
        soupFloats[offset + 3] = 1;
      });
    });
  });

  const fringeFloats = new Float32Array(edges.length * 6 * RECORD_FLOATS);
  edges.forEach((edge, e) => {
    const p0 = point(edge.a);
    const p1 = point(edge.b);
    const outer = (p: readonly [number, number]) =>
      [
        f((2 * (p[0] + edge.normal64[0])) / geometry.width - 1),
        f(1 - (2 * (p[1] + edge.normal64[1])) / geometry.height),
      ] as const;
    const P0 = geometry.ndc[edge.a]!;
    const P1 = geometry.ndc[edge.b]!;
    const Q0 = outer(p0);
    const Q1 = outer(p1);
    [P0, P1, Q1, P0, Q1, Q0].forEach((vertex, corner) => {
      const base = (e * 6 + corner) * RECORD_FLOATS;
      fringeFloats[base] = vertex[0];
      fringeFloats[base + 1] = vertex[1];
      fringeFloats[base + 4] = edge.n[0];
      fringeFloats[base + 5] = edge.n[1];
      fringeFloats[base + 6] = edge.c;
      fringeFloats[base + 7] = 1;
    });
  });
  return {
    origin,
    edges,
    soup: new Uint8Array(soupFloats.buffer),
    fringe: new Uint8Array(fringeFloats.buffer),
  };
}
