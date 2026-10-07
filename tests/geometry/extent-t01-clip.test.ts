import { describe, expect, it } from 'vitest';

import type { ProjectionInput } from './mesh-projection/model.js';
import { q } from './position-certificate/certificate.js';
import {
  absolute,
  add,
  compare,
  div,
  mul,
  rational,
  sign,
  sub,
  ZERO,
  type Rational,
} from './rounded-fill/exact.js';
import { cross3, doubleArea, earClip, exactClip, samePoint, type Q2 } from './extent-t01/clip.js';
import {
  cellOf,
  levelFor,
  preimage,
  seamConformance,
  sidePx,
  tileRow,
  tJunctionFree,
  type PxWindow,
  type TileCell,
  type TileResult,
} from './extent-t01/tile.js';

const r = (value: number): Rational => q(value);
const pt = (x: number, y: number): Q2 => [r(x), r(y)];
const cell = (x0: number, x1: number, y0: number, y1: number) => ({
  x0: r(x0),
  x1: r(x1),
  y0: r(y0),
  y1: r(y1),
});
const key = (point: Q2) => `${point[0].n}/${point[0].d},${point[1].n}/${point[1].d}`;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random dyadic coordinate k/4 in [lo, hi]. */
function dyadic(random: () => number, lo: number, hi: number): number {
  const steps = (hi - lo) * 4;
  return lo + Math.floor(random() * (steps + 1)) / 4;
}

// ---------------------------------------------------------------------------------------------
// Independent reference: intersection of a triangle and a closed rectangle as the convex hull of
// (triangle vertices in the rectangle) ∪ (rectangle corners in the triangle) ∪ (edge crossings).

type Rect = ReturnType<typeof cell>;

function inRect(point: Q2, rect: Rect): boolean {
  return (
    compare(point[0], rect.x0) >= 0 &&
    compare(point[0], rect.x1) <= 0 &&
    compare(point[1], rect.y0) >= 0 &&
    compare(point[1], rect.y1) <= 0
  );
}

function inTriangle(point: Q2, tri: readonly [Q2, Q2, Q2]): boolean {
  const s = [
    cross3(tri[0], tri[1], point),
    cross3(tri[1], tri[2], point),
    cross3(tri[2], tri[0], point),
  ].map(sign);
  return !s.includes(1) || !s.includes(-1);
}

function segmentCrossings(a: Q2, b: Q2, rect: Rect): Q2[] {
  const out: Q2[] = [];
  for (const [axis, bound] of [
    [0, rect.x0],
    [0, rect.x1],
    [1, rect.y0],
    [1, rect.y1],
  ] as const) {
    const other = axis === 0 ? 1 : 0;
    const da = sub(a[axis], bound);
    const db = sub(b[axis], bound);
    if (sign(da) * sign(db) > 0 || compare(a[axis], b[axis]) === 0) continue;
    const t = div(sub(bound, a[axis]), sub(b[axis], a[axis]));
    const value = add(a[other], mul(t, sub(b[other], a[other])));
    out.push(axis === 0 ? [bound, value] : [value, bound]);
  }
  return out;
}

function hull(points: readonly Q2[]): Q2[] {
  const unique = [...new Map(points.map((point) => [key(point), point])).values()];
  unique.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
  if (unique.length < 3) return unique;
  const build = (list: Q2[]) => {
    const chain: Q2[] = [];
    for (const point of list) {
      while (
        chain.length >= 2 &&
        sign(cross3(chain[chain.length - 2]!, chain[chain.length - 1]!, point)) <= 0
      )
        chain.pop();
      chain.push(point);
    }
    return chain;
  };
  const lower = build(unique);
  const upper = build([...unique].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function referenceIntersection(tri: readonly [Q2, Q2, Q2], rect: Rect): Q2[] {
  const candidates: Q2[] = tri.filter((point) => inRect(point, rect));
  const corners: Q2[] = [
    [rect.x0, rect.y0],
    [rect.x1, rect.y0],
    [rect.x1, rect.y1],
    [rect.x0, rect.y1],
  ];
  candidates.push(...corners.filter((corner) => inTriangle(corner, tri)));
  for (let side = 0; side < 3; side += 1)
    for (const point of segmentCrossings(tri[side]!, tri[(side + 1) % 3]!, rect))
      if (inRect(point, rect) && inTriangle(point, tri)) candidates.push(point);
  return hull(candidates);
}

function checkClip(tri: readonly [Q2, Q2, Q2], rect: Rect): void {
  const clipped = exactClip(tri, rect);
  const reference = referenceIntersection(tri, rect);
  const referenceArea = reference.length < 3 ? ZERO : absolute(doubleArea(reference));
  if (sign(referenceArea) === 0) {
    expect(clipped).toEqual([]);
    return;
  }
  expect(clipped.length).toBeGreaterThanOrEqual(3);
  const area = doubleArea(clipped);
  expect(sign(area)).toBe(sign(doubleArea(tri)));
  expect(compare(absolute(area), referenceArea)).toBe(0);
  for (const point of clipped) {
    expect(inRect(point, rect)).toBe(true);
    expect(inTriangle(point, tri)).toBe(true);
  }
  const keys = new Set(clipped.map(key));
  for (const point of reference) expect(keys.has(key(point))).toBe(true);
  for (let index = 0; index < clipped.length; index += 1)
    expect(samePoint(clipped[index]!, clipped[(index + 1) % clipped.length]!)).toBe(false);
}

function checkEars(ring: readonly Q2[]): void {
  const triangles = earClip(ring);
  expect(triangles).toHaveLength(ring.length - 2);
  const orientation = sign(doubleArea(ring));
  let total = ZERO;
  const used = new Set<number>();
  for (const [a, b, c] of triangles) {
    const area = cross3(ring[a]!, ring[b]!, ring[c]!);
    expect(sign(area)).toBe(orientation);
    total = add(total, area);
    used.add(a).add(b).add(c);
  }
  expect(compare(total, doubleArea(ring))).toBe(0);
  expect(used.size).toBe(ring.length);
}

const stringify = (value: unknown) =>
  JSON.stringify(value, (_, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );

function inputOf(
  vertices: readonly (readonly [number, number])[],
  indices: readonly number[],
  overrides: Partial<ProjectionInput> = {},
): ProjectionInput {
  return {
    id: 'extent-t01-clip',
    mesh: { vertices: vertices.map(([x, y]) => [x, y] as const), indices },
    affine: [1, 0, 0, 1, 0, 0],
    camera: [0, 0],
    origin: [0, 0],
    zoom: 256,
    dpr: 1,
    width: 1024,
    height: 1024,
    ...overrides,
  };
}

const pxWindow = (x0: number, y0: number, x1: number, y1: number): PxWindow => ({
  x0: r(x0),
  y0: r(y0),
  x1: r(x1),
  y1: r(y1),
});

function tileTriangleArea(tile: TileCell): Rational {
  let total = ZERO;
  for (const [a, b, c] of tile.indices)
    total = add(total, absolute(cross3(tile.points[a]!, tile.points[b]!, tile.points[c]!)));
  return total;
}

function sourceArea(input: ProjectionInput): Rational {
  const { vertices, indices } = input.mesh;
  let total = ZERO;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => vertices[indices[offset + k]!]!);
    total = add(total, absolute(cross3(pt(...a!), pt(...b!), pt(...c!))));
  }
  return total;
}

/** A jittered n×n lattice, quads split along one diagonal, consistent winding. */
function latticeMesh(random: () => number, n: number, lo: number, step: number) {
  const vertices: [number, number][] = [];
  for (let j = 0; j <= n; j += 1)
    for (let i = 0; i <= n; i += 1)
      vertices.push([
        lo + i * step + (dyadic(random, -1, 1) * step) / 8,
        lo + j * step + (dyadic(random, -1, 1) * step) / 8,
      ]);
  const indices: number[] = [];
  const id = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j += 1)
    for (let i = 0; i < n; i += 1)
      indices.push(
        id(i, j),
        id(i + 1, j),
        id(i + 1, j + 1),
        id(i, j),
        id(i + 1, j + 1),
        id(i, j + 1),
      );
  return { vertices, indices };
}

describe('P3.1p T01 exact clip', () => {
  it('matches the convex-hull reference on random dyadic triangles and unit cells', () => {
    const random = mulberry32(0x7011);
    for (let trial = 0; trial < 400; trial += 1) {
      const tri = [0, 1, 2].map(() =>
        pt(dyadic(random, -3, 3), dyadic(random, -3, 3)),
      ) as unknown as [Q2, Q2, Q2];
      const i = Math.floor(random() * 6) - 3;
      const j = Math.floor(random() * 6) - 3;
      const size = random() < 0.5 ? 1 : 2;
      checkClip(tri, cell(i, i + size, j, j + size));
    }
  });

  it('handles edges through grid corners, along grid lines and degenerate cases', () => {
    const cases: [[number, number][], [number, number, number, number]][] = [
      // diagonal through corners (1,1) and (2,2)
      [
        [
          [0, 0],
          [3, 3],
          [0, 3],
        ],
        [1, 2, 1, 2],
      ],
      [
        [
          [0, 0],
          [3, 3],
          [3, 0],
        ],
        [1, 2, 1, 2],
      ],
      // edge along a grid line
      [
        [
          [0, 0],
          [3, 0],
          [0, 3],
        ],
        [0, 1, 0, 1],
      ],
      [
        [
          [1, 0],
          [1, 3],
          [3, 1],
        ],
        [0, 1, 0, 3],
      ],
      [
        [
          [1, 0],
          [1, 3],
          [3, 1],
        ],
        [1, 2, 0, 3],
      ],
      // vertex exactly on a corner, triangle outside except for that point
      [
        [
          [1, 1],
          [2, 1],
          [1, 2],
        ],
        [0, 1, 0, 1],
      ],
      // fully inside / fully containing
      [
        [
          [0.25, 0.25],
          [0.75, 0.25],
          [0.25, 0.75],
        ],
        [0, 1, 0, 1],
      ],
      [
        [
          [-5, -5],
          [5, -5],
          [-5, 5],
        ],
        [0, 1, 0, 1],
      ],
      // reversed winding
      [
        [
          [0, 0],
          [0, 3],
          [3, 3],
        ],
        [1, 2, 1, 2],
      ],
      // zero-area source
      [
        [
          [0, 0],
          [1, 1],
          [2, 2],
        ],
        [0, 3, 0, 3],
      ],
    ];
    for (const [vertices, rect] of cases)
      checkClip(vertices.map(([x, y]) => pt(x, y)) as unknown as [Q2, Q2, Q2], cell(...rect));
    // order: a contained triangle is returned unchanged, starting at the source's first vertex
    const inside = [pt(0.75, 0.25), pt(0.25, 0.75), pt(0.25, 0.25)] as const;
    expect(exactClip(inside, cell(0, 1, 0, 1))).toEqual([...inside]);
    expect(exactClip([pt(0, 0), pt(1, 1), pt(2, 2)], cell(0, 3, 0, 3))).toEqual([]);
  });

  it('ear-clips every clipped piece and collinear rings per the ear rule', () => {
    const random = mulberry32(0xea45);
    for (let trial = 0; trial < 300; trial += 1) {
      const tri = [0, 1, 2].map(() =>
        pt(dyadic(random, -2, 2), dyadic(random, -2, 2)),
      ) as unknown as [Q2, Q2, Q2];
      const ring = exactClip(tri, cell(-1, 1, -1, 1));
      if (ring.length > 0) checkEars(ring);
    }
    const collinear = [pt(0, 0), pt(1, 0), pt(2, 0), pt(2, 2), pt(1, 2), pt(0, 2), pt(0, 1)];
    checkEars(collinear);
    checkEars([...collinear].reverse());
    // lowest ear position first: (6, 0, 1) is the first emitted ear
    expect(earClip(collinear)[0]).toEqual([6, 0, 1]);
    expect(earClip([pt(0, 0), pt(1, 1), pt(2, 2)])).toEqual([]);
  });

  it('sums clipped areas over all cells to the triangle area exactly', () => {
    const random = mulberry32(0xa4ea);
    for (let trial = 0; trial < 60; trial += 1) {
      const tri = [0, 1, 2].map(() =>
        pt(dyadic(random, -2, 2), dyadic(random, -2, 2)),
      ) as unknown as [Q2, Q2, Q2];
      let total = ZERO;
      for (let j = -2n; j < 2n; j += 1n)
        for (let i = -2n; i < 2n; i += 1n)
          total = add(total, absolute(doubleArea(exactClip(tri, cellOf(0, i, j)))));
      expect(compare(total, absolute(doubleArea(tri)))).toBe(0);
    }
  });
});

describe('P3.1p T01 tiling', () => {
  it('indexes originals, then Steiner kinds 1, 2 and 3 (explicit case)', () => {
    const input = inputOf(
      [
        [0.5, 0.5],
        [2.5, 0.5],
        [0.5, 2.5],
      ],
      [0, 1, 2],
    );
    const result = tileRow(input, 256, pxWindow(0, 0, 1024, 1024));
    expect(result.status).toBe('OK');
    expect(result.L).toBe(0);
    const first = result.cells[0]!;
    expect([first.i, first.j]).toEqual([0n, 0n]);
    expect(first.m).toEqual([0.5, 0.5]);
    expect(first.points.map(key)).toEqual(
      [pt(0.5, 0.5), pt(1, 0.5), pt(0.5, 1), pt(1, 1)].map(key),
    );
    expect(first.sourceIndex).toEqual([0, null, null, null]);
    expect(first.steinerKind).toEqual([0, 1, 2, 3]);
    expect(first.indices).toEqual([
      [3, 2, 0],
      [0, 1, 3],
    ]);
    // tiles in row-major (j, i) order
    expect(result.cells.map((tile) => [tile.j, tile.i])).toEqual([
      [0n, 0n],
      [0n, 1n],
      [0n, 2n],
      [1n, 0n],
      [1n, 1n],
      [2n, 0n],
    ]);
  });

  it('preserves area, has no T-junctions and conforms across seams on random meshes', () => {
    const random = mulberry32(0x5ea3);
    for (let trial = 0; trial < 12; trial += 1) {
      const { vertices, indices } = latticeMesh(random, 3, 0.25, 1.125);
      const input = inputOf(vertices, indices);
      const result = tileRow(input, 256, pxWindow(-64, -64, 1088, 1088));
      expect(result.status).toBe('OK');
      let total = ZERO;
      for (const tile of result.cells) {
        expect(tJunctionFree(tile)).toBe(true);
        total = add(total, tileTriangleArea(tile));
        // invariants of the identity and indexing rule
        const kinds = tile.steinerKind;
        for (let index = 1; index < kinds.length; index += 1)
          expect(kinds[index]!).toBeGreaterThanOrEqual(kinds[index - 1]!);
        tile.sourceIndex.forEach((source, index) => {
          expect(source === null).toBe(kinds[index] !== 0);
          if (source !== null)
            expect(samePoint(tile.points[index]!, pt(...vertices[source]!))).toBe(true);
        });
        expect(new Set(tile.points.map(key)).size).toBe(tile.points.length);
        expect(new Set(tile.indices.flat()).size).toBe(tile.points.length);
      }
      expect(compare(total, sourceArea(input))).toBe(0);
      const seams = seamConformance(result);
      expect(seams.conforming).toBe(true);
      expect(seams.pairs).toBeGreaterThan(0);
    }
  });

  it('carries identical exact vertex sets on both sides of every covered grid line', () => {
    // two triangles covering [0, 3]² exactly, plus a fan vertex at (1.5, 1.5)
    const input = inputOf(
      [
        [0, 0],
        [3, 0],
        [3, 3],
        [0, 3],
        [1.5, 1.5],
      ],
      [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
    );
    const result = tileRow(input, 256, pxWindow(0, 0, 768, 768));
    expect(result.cells).toHaveLength(9);
    const byKey = new Map(result.cells.map((tile) => [`${tile.i},${tile.j}`, tile]));
    let pairs = 0;
    for (const tile of result.cells)
      for (const [di, dj, axis] of [
        [1n, 0n, 0],
        [0n, 1n, 1],
      ] as const) {
        const other = byKey.get(`${tile.i + di},${tile.j + dj}`);
        if (other === undefined) continue;
        const line = r(Number(axis === 0 ? tile.i + 1n : tile.j + 1n));
        const on = (t: TileCell) =>
          t.points
            .filter((point) => compare(point[axis], line) === 0)
            .map(key)
            .sort();
        expect(on(tile)).toEqual(on(other));
        pairs += 1;
      }
    expect(pairs).toBe(12);
    expect(seamConformance(result).conforming).toBe(true);
  });

  it('detects a seam mismatch and a T-junction when one is planted', () => {
    const input = inputOf(
      [
        [0, 0],
        [2, 0],
        [2, 1],
        [0, 1],
      ],
      [0, 1, 2, 0, 2, 3],
    );
    const result = tileRow(input, 256, pxWindow(0, 0, 512, 256));
    expect(result.cells).toHaveLength(2);
    expect(seamConformance(result).conforming).toBe(true);
    const [left, right] = result.cells as [TileCell, TileCell];
    // plant an extra seam vertex (1, 1/4) on the left side only
    const planted: TileCell = {
      ...left,
      points: [...left.points, pt(1, 0.25)],
      sourceIndex: [...left.sourceIndex, null],
      steinerKind: [...left.steinerKind, 1],
    };
    const broken: TileResult = { ...result, cells: [planted, right] };
    expect(seamConformance(broken).conforming).toBe(false);
    expect(tJunctionFree(planted)).toBe(false);
  });

  it('keeps the level invariant: side ≤ T and twice the side > T', () => {
    const random = mulberry32(0x1e7e);
    for (let trial = 0; trial < 300; trial += 1) {
      const scalar = () => (random() - 0.5) * 2 ** Math.floor(random() * 40 - 20);
      const input = {
        affine: [scalar(), scalar(), scalar(), scalar(), 0, 0] as const,
        zoom: 2 ** Math.floor(random() * 30 - 20) * (1 + random()),
        dpr: [1, 1.5, 2, 3][Math.floor(random() * 4)]!,
      };
      for (const T of [256, 1024]) {
        const L = levelFor(input, T);
        expect(L).not.toBeNull();
        const side = sidePx(input, L!);
        expect(compare(side, r(T))).toBeLessThanOrEqual(0);
        expect(compare(mul(rational(2n), side), r(T))).toBe(1);
      }
    }
    expect(levelFor({ affine: [1e-50, 0, 0, 1e-50, 0, 0], zoom: 1, dpr: 1 }, 256)).toBeNull();
    expect(
      tileRow(
        inputOf(
          [
            [0, 0],
            [1, 0],
            [0, 1],
          ],
          [0, 1, 2],
          { affine: [1e-50, 0, 0, 1e-50, 0, 0] },
        ),
        256,
        pxWindow(0, 0, 1, 1),
      ).status,
    ).toBe('LEVEL_NONE');
  });

  it('materializes exactly the cells meeting the preimage bbox under a rotated affine', () => {
    const input = inputOf(
      [
        [-3.5, -2.25],
        [4.75, -1.5],
        [0.25, 5.125],
        [-2, 3],
      ],
      [0, 1, 2, 0, 2, 3],
      {
        affine: [0.6, 0.8, -0.8, 0.6, 3, 5],
        camera: [2.5, 4.25],
        zoom: 64,
        dpr: 1.5,
        width: 640,
        height: 480,
      },
    );
    const window = pxWindow(-4, -4, 644, 484);
    const result = tileRow(input, 256, window);
    expect(result.status).toBe('OK');
    const L = result.L!;
    const side = sidePx(input, L);
    expect(compare(side, r(256))).toBeLessThanOrEqual(0);
    const corners = [
      preimage(input, [window.x0, window.y0]),
      preimage(input, [window.x1, window.y0]),
      preimage(input, [window.x0, window.y1]),
      preimage(input, [window.x1, window.y1]),
    ];
    const lo = (axis: 0 | 1) =>
      corners.map((p) => p[axis]).reduce((a, b) => (compare(a, b) <= 0 ? a : b));
    const hi = (axis: 0 | 1) =>
      corners.map((p) => p[axis]).reduce((a, b) => (compare(a, b) >= 0 ? a : b));
    // brute force: cells i with [i·s, (i+1)·s) ∩ [lo, hi] ≠ ∅, scanning a generous index range
    const s = r(2 ** L);
    const count = (axis: 0 | 1) => {
      let n = 0;
      for (let i = -400; i <= 400; i += 1) {
        const a = mul(rational(BigInt(i)), s);
        const b = add(a, s);
        if (compare(a, hi(axis)) <= 0 && compare(b, lo(axis)) > 0) n += 1;
      }
      return n;
    };
    expect(result.materializedCells).toBe(count(0) * count(1));
    // preimage really inverts the reference map
    const [a, b, c, d, e, g] = input.affine.map(r) as unknown as readonly [
      Rational,
      Rational,
      Rational,
      Rational,
      Rational,
      Rational,
    ];
    const scale = mul(r(input.zoom), r(input.dpr));
    const targets: Q2[] = [
      [window.x0, window.y0],
      [window.x1, window.y0],
      [window.x0, window.y1],
      [window.x1, window.y1],
    ];
    corners.forEach((corner, index) => {
      const px = mul(
        sub(add(add(mul(a, corner[0]), mul(c, corner[1])), e), r(input.camera[0])),
        scale,
      );
      const py = mul(
        sub(add(add(mul(b, corner[0]), mul(d, corner[1])), g), r(input.camera[1])),
        scale,
      );
      expect(samePoint([px, py], targets[index]!)).toBe(true);
    });
    for (const tile of result.cells) {
      expect(tJunctionFree(tile)).toBe(true);
      const box = cellOf(L, tile.i, tile.j);
      expect(compare(box.x0, hi(0)) <= 0 && compare(box.x1, lo(0)) > 0).toBe(true);
      expect(compare(box.y0, hi(1)) <= 0 && compare(box.y1, lo(1)) > 0).toBe(true);
      expect(r(tile.m[0])).toEqual(div(add(box.x0, box.x1), rational(2n)));
    }
    expect(seamConformance(result).conforming).toBe(true);
  });

  it('reports TILE_CAP_EXCEEDED beyond 4096 materialized cells', () => {
    const input = inputOf(
      [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      [0, 1, 2],
    );
    const result = tileRow(input, 256, pxWindow(0, 0, 256 * 64, 256 * 65));
    expect(result.status).toBe('TILE_CAP_EXCEEDED');
    expect(result.materializedCells).toBeGreaterThan(4096);
    expect(result.cells).toEqual([]);
    expect(tileRow(input, 256, pxWindow(0, 0, 256 * 63, 256 * 63)).status).toBe('OK');
  });

  it('is deterministic across repeated runs', () => {
    const random = mulberry32(0xde7);
    const { vertices, indices } = latticeMesh(random, 3, -1.5, 1);
    const input = inputOf(vertices, indices, {
      affine: [0.6, 0.8, -0.8, 0.6, 0.5, 0.25],
      zoom: 128,
    });
    const window = pxWindow(-64, -64, 1088, 1088);
    const first = stringify(tileRow(input, 256, window));
    expect(stringify(tileRow(input, 256, window))).toBe(first);
    expect(stringify(tileRow(input, 1024, window))).toBe(stringify(tileRow(input, 1024, window)));
  });
});
