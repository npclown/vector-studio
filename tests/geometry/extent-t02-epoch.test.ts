import { describe, expect, it } from 'vitest';

import type { ProjectionInput } from './mesh-projection/model.js';
import { certifyWindow, q } from './position-certificate/certificate.js';
import { loadFixtureRows, prospectiveRows, termRows } from './position-certificate/corpus.js';
import { originPXTarget } from './position-certificate/r3-window.js';
import { add, compare, div, mul, rational, sub, type Rational } from './rounded-fill/exact.js';
import type { Q2 } from './extent-t01/clip.js';
import { bboxMidpoint } from './extent-t01/core.js';
import { syntheticRows } from './extent-t01/synthetic.js';
import { levelFor, pow2 } from './extent-t01/tile.js';
import {
  candidateCells,
  certifyEpochCore,
  epochOf,
  inverseRowBound,
  preimageQuad,
  type EpochRecord,
} from './extent-t02/epoch.js';

const f = Math.fround;

function recordsOf(input: ProjectionInput): EpochRecord[] {
  const m = bboxMidpoint(input.mesh.vertices);
  return input.mesh.vertices.map((vertex) => ({
    pos: [q(vertex[0]), q(vertex[1])] as Q2,
    v64: vertex,
    m,
  }));
}

function referenced(input: ProjectionInput): number[] {
  return [...new Set(input.mesh.indices)].sort((a, b) => a - b);
}

const exactLanes = (input: ProjectionInput) =>
  f(input.zoom) === input.zoom && f(input.dpr) === input.dpr;

function windowRows(): ProjectionInput[] {
  return [
    ...loadFixtureRows().map((row) => row.input),
    ...prospectiveRows().map((row) => row.input),
    ...termRows().map((row) => row.input),
    ...syntheticRows()
      .rows.filter((_, index) => index % 7 === 0)
      .map((row) => row.input),
  ];
}

describe('P3.1p T02 epoch position bound E_ep', () => {
  it('reduces to pinned certifyWindow when zq = s0, and bounds it otherwise', () => {
    let equal = 0;
    let bounded = 0;
    for (const input of windowRows()) {
      const epoch = epochOf(input);
      if (epoch === null) continue;
      const window = certifyWindow(input, epoch.origin, 2 * epoch.g);
      if (window.reason === 'lane-range' || window.reason === 'singular') continue;
      if (window.ewx.every((value) => value === null)) continue;
      const records = recordsOf(input);
      const full = certifyEpochCore(input, epoch, records);
      if (full.status !== 'OK') continue;
      if (exactLanes(input)) {
        const reduced = certifyEpochCore(input, epoch, records, { reduce: true });
        expect(reduced.status).toBe('OK');
        if (reduced.status !== 'OK') continue;
        for (const vertex of referenced(input)) {
          expect(compare(reduced.errors[vertex]!.ex, window.ewx[vertex]!)).toBe(0);
          expect(compare(reduced.errors[vertex]!.ey, window.ewy[vertex]!)).toBe(0);
          // The epoch bound stays within the zoom band factor (s_hi ≤ 2·(1 + 2^-22)·zq) of the pointwise one.
          expect(
            compare(full.errors[vertex]!.ex, mul(rational(3n), reduced.errors[vertex]!.ex)),
          ).toBeLessThanOrEqual(0);
          expect(
            compare(full.errors[vertex]!.ey, mul(rational(3n), reduced.errors[vertex]!.ey)),
          ).toBeLessThanOrEqual(0);
        }
        equal += 1;
      }
      for (const vertex of referenced(input)) {
        expect(compare(full.errors[vertex]!.ex, window.ewx[vertex]!)).toBeGreaterThanOrEqual(0);
        expect(compare(full.errors[vertex]!.ey, window.ewy[vertex]!)).toBeGreaterThanOrEqual(0);
      }
      bounded += 1;
    }
    expect(equal).toBeGreaterThan(40);
    expect(bounded).toBeGreaterThan(150);
  }, 60_000);
});

describe('P3.1p T02 reach and epoch constants', () => {
  it('n bounds the largest row 2-norm of A0⁻¹ on shear and non-uniform affines', () => {
    const affines: [number, number, number, number][] = [
      [1, 2, 3, 4],
      [1, 0, 5, 1],
      [1, 0, 0, 1e-3],
      [1e3, 0, 0, 1],
      [0.5, -0.25, 3, 0.125],
    ];
    for (const [a, b, c, d] of affines) {
      const n = inverseRowBound([a, b, c, d, 0, 0])!;
      const [qa, qb, qc, qd] = [a, b, c, d].map(q) as [Rational, Rational, Rational, Rational];
      const det = sub(mul(qa, qd), mul(qb, qc));
      const det2 = mul(det, det);
      const rows = [add(mul(qd, qd), mul(qc, qc)), add(mul(qb, qb), mul(qa, qa))];
      for (const row of rows) expect(compare(mul(n, n), div(row, det2))).toBeGreaterThanOrEqual(0);
    }
    expect(compare(inverseRowBound([1, 2, 3, 4, 0, 0])!, rational(5n, 2n))).toBeGreaterThanOrEqual(
      0,
    );
    expect(inverseRowBound([1, 2, 2, 4, 0, 0])).toBeNull();
  });

  it('the epoch lane interval matches brute-force g and L', () => {
    const base = syntheticRows().rows[3]!.input;
    for (const zoom of [2 ** -6, 0.3, 1, 1.7, 3, 64]) {
      for (const affine of [
        [1, 0, 0, 1, 0, 0],
        [0.9659258262890683, 0.25881904510252074, -0.25881904510252074, 0.9659258262890683, 0, 0],
      ] as const) {
        const input = { ...base, zoom, affine } as ProjectionInput;
        const epoch = epochOf(input)!;
        const probe = (zq: Rational) => {
          const z = Number(zq.n) / Number(zq.d);
          const g = originPXTarget([0, 0], z, 1, 128).g;
          const L = levelFor({ affine, zoom: z, dpr: 1 }, 256);
          return { g, L };
        };
        for (const t of [rational(1n, 64n), rational(1n, 2n), rational(63n, 64n), rational(1n)]) {
          const zq = add(epoch.zqLo, mul(t, sub(epoch.zqHi, epoch.zqLo)));
          const z = Number(zq.n) / Number(zq.d);
          if (f(z) !== z) continue;
          const { g, L } = probe(zq);
          expect(g).toBe(epoch.g);
          expect(L).toBe(epoch.L);
        }
        const below = mul(epoch.zqLo, rational(255n, 256n));
        const { g, L } = probe(below);
        expect(g !== epoch.g || L !== epoch.L).toBe(true);
      }
    }
  });
});

function quadMeetsCell(quad: readonly Q2[], L: number, i: bigint, j: bigint): boolean {
  const x0 = mul(rational(i), pow2(L));
  const x1 = mul(rational(i + 1n), pow2(L));
  const y0 = mul(rational(j), pow2(L));
  const y1 = mul(rational(j + 1n), pow2(L));
  const square: Q2[] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const separated = (axis: Q2, a: readonly Q2[], b: readonly Q2[]) => {
    const project = (points: readonly Q2[]) =>
      points.map((point) => add(mul(point[0], axis[0]), mul(point[1], axis[1])));
    const pa = project(a);
    const pb = project(b);
    const maxA = pa.reduce((m, v) => (compare(v, m) > 0 ? v : m));
    const minA = pa.reduce((m, v) => (compare(v, m) < 0 ? v : m));
    const maxB = pb.reduce((m, v) => (compare(v, m) > 0 ? v : m));
    const minB = pb.reduce((m, v) => (compare(v, m) < 0 ? v : m));
    return compare(maxA, minB) < 0 || compare(maxB, minA) < 0;
  };
  const axes: Q2[] = [
    [rational(1n), rational(0n)],
    [rational(0n), rational(1n)],
  ];
  for (let index = 0; index < quad.length; index += 1) {
    const a = quad[index]!;
    const b = quad[(index + 1) % quad.length]!;
    axes.push([sub(b[1], a[1]), sub(a[0], b[0])]);
  }
  return !axes.some((axis) => separated(axis, quad, square));
}

describe('P3.1p T02 candidate cells', () => {
  it('equal brute-force closed-square separating-axis tests on rotated, sheared and grid-aligned windows', () => {
    const affines = [
      [1, 0, 0, 1, 0.5, -3],
      [0.9659258262890683, 0.25881904510252074, -0.25881904510252074, 0.9659258262890683, 7, 2],
      [0.7071067811865476, 0.7071067811865476, -0.7071067811865476, 0.7071067811865476, 0, 0],
      [1, 0, 2, 1, 0, 0],
      [2, 0, 0, 0.5, -1, 1],
    ] as const;
    const rects = [
      { x0: rational(0n), y0: rational(0n), x1: rational(8n), y1: rational(4n) },
      { x0: rational(-3n, 2n), y0: rational(5n, 3n), x1: rational(7n), y1: rational(9n) },
    ];
    for (const affine of affines)
      for (const rect of rects)
        for (const L of [-1, 0, 1, 2]) {
          const quad = preimageQuad(affine, rect);
          const result = candidateCells(quad, L);
          expect(result.status).toBe('OK');
          if (result.status !== 'OK') continue;
          const xs = quad.map((point) => Number(point[0].n) / Number(point[0].d));
          const ys = quad.map((point) => Number(point[1].n) / Number(point[1].d));
          const side = 2 ** L;
          const expected: string[] = [];
          for (
            let j = BigInt(Math.floor(Math.min(...ys) / side) - 2);
            j <= BigInt(Math.floor(Math.max(...ys) / side) + 2);
            j += 1n
          )
            for (
              let i = BigInt(Math.floor(Math.min(...xs) / side) - 2);
              i <= BigInt(Math.floor(Math.max(...xs) / side) + 2);
              i += 1n
            )
              if (quadMeetsCell(quad, L, i, j)) expected.push(`${i},${j}`);
          expect(result.cells.map(([i, j]) => `${i},${j}`)).toEqual(expected);
        }
  });

  it('reports the cap', () => {
    const quad = preimageQuad([1, 0, 0, 1, 0, 0], {
      x0: rational(0n),
      y0: rational(0n),
      x1: rational(100n),
      y1: rational(100n),
    });
    expect(candidateCells(quad, 0).status).toBe('TILE_CAP_EXCEEDED');
  });
});
