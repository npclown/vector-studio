import { describe, expect, it } from 'vitest';

import { simulateMeshProjection, type ProjectionInput } from './mesh-projection/model.js';
import { q } from './position-certificate/certificate.js';
import { originPXTarget } from './position-certificate/r3-window.js';
import { compare, rational, type Rational } from './rounded-fill/exact.js';
import { type Q2 } from './extent-t01/clip.js';
import { GAMMA8 } from './extent-t01/core.js';
import { tileRow, type PxWindow } from './extent-t01/tile.js';
import {
  certifyTiles,
  roundToBinary64,
  simulateLanes,
  tileLanes,
  triangleBoxDistance2,
  triangleMeetsBox,
} from './extent-t01/tile-certificate.js';

const r = (value: number): Rational => q(value);
const pt = (x: number, y: number): Q2 => [r(x), r(y)];

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

function inputOf(
  vertices: readonly (readonly [number, number])[],
  indices: readonly number[],
  overrides: Partial<ProjectionInput> = {},
): ProjectionInput {
  return {
    id: 'extent-t01-tile-certificate',
    mesh: { vertices: vertices.map(([x, y]) => [x, y] as const), indices },
    affine: [1, 0, 0, 1, 0, 0],
    camera: [0, 0],
    origin: [0, 0],
    zoom: 1,
    dpr: 1,
    width: 1280,
    height: 720,
    ...overrides,
  };
}

const guarded = (input: ProjectionInput, gamma: number): PxWindow => ({
  x0: r(-gamma),
  y0: r(-gamma),
  x1: r(input.width + gamma),
  y1: r(input.height + gamma),
});

describe('P3.1p T01 tile certificate', () => {
  it('rounds rationals to nearest binary64, ties to even, including subnormals', () => {
    const random = mulberry32(0x64);
    for (let trial = 0; trial < 2000; trial += 1) {
      const n = BigInt(Math.floor(random() * 2 ** 53)) - (1n << 52n);
      const d = BigInt(Math.floor(random() * 2 ** 53)) + 1n;
      expect(roundToBinary64(rational(n, d))).toBe(Number(n) / Number(d));
    }
    const one = 1n << 1074n;
    expect(roundToBinary64(rational(1n, one * 2n))).toBe(0); // tie at 2^-1075 → even (0)
    expect(roundToBinary64(rational(3n, one * 2n))).toBe(2 * 2 ** -1074); // tie → even (2)
    expect(roundToBinary64(rational(3n, one * 4n))).toBe(2 ** -1074);
    expect(roundToBinary64(rational((1n << 53n) + 1n))).toBe(2 ** 53); // tie → even
    expect(roundToBinary64(rational((1n << 53n) + 3n))).toBe(2 ** 53 + 4);
    expect(roundToBinary64(rational(-5n, 2n))).toBe(-2.5);
    for (const value of [0.1, -1e-310, 2 ** 60, 123456.789])
      expect(roundToBinary64(q(value))).toBe(value);
  });

  it('simulateLanes equals simulateMeshProjection on a single tile centred on its cell', () => {
    // bbox midpoint (128, 128) equals the centre of cell (0, 0) at L = 8 (T = 256, zoom 1)
    const vertices: [number, number][] = [
      [16.25, 40.5],
      [239.75, 16.125],
      [239.75, 215.5],
      [33.5, 239.875],
    ];
    for (const [camera, zoom, dpr] of [
      [[0, 0], 1, 1],
      [[-200.5, 77.25], 1, 1],
      [[1e6 + 0.375, -3e5], 1, 1.5],
    ] as const) {
      const input = inputOf(vertices, [0, 1, 2, 0, 2, 3], { camera, zoom, dpr });
      const origin = originPXTarget(camera, zoom, dpr, 128).origin;
      const tiles = tileRow({ ...input, camera: [0, 0] }, 256 * zoom * dpr, {
        x0: r(0),
        y0: r(0),
        x1: r(1),
        y1: r(1),
      });
      expect(tiles.status).toBe('OK');
      expect(tiles.cells).toHaveLength(1);
      const cell = tiles.cells[0]!;
      expect(cell.m).toEqual([128, 128]);
      expect(cell.sourceIndex).toEqual([0, 1, 2, 3]);
      const carrier = tileLanes(input, cell, origin);
      const simulated = simulateLanes(carrier.lanes, input);
      const reference = simulateMeshProjection({ ...input, origin });
      expect(reference.ok).toBe(true);
      if (!reference.ok) return;
      expect(carrier.lanes.local).toEqual(reference.localOffsets);
      expect(simulated.physical).toEqual(reference.physical);
      expect(simulated.ndc).toEqual(reference.ndc);
      expect(simulated.recovered).toEqual(reference.recovered);
    }
  });

  it('tests closed triangle-box contact and distance exactly', () => {
    const box = { x0: r(0), y0: r(0), x1: r(10), y1: r(10) };
    expect(triangleMeetsBox([pt(10, 10), pt(20, 10), pt(20, 20)], box)).toBe(true);
    expect(triangleMeetsBox([pt(11, 0), pt(20, 0), pt(20, 5)], box)).toBe(false);
    // bboxes overlap but the hypotenuse separates
    const separated = [pt(5, 20), pt(20, 5), pt(20, 20)] as const;
    expect(triangleMeetsBox(separated, box)).toBe(false);
    expect(compare(triangleBoxDistance2(separated, box), rational(25n, 2n))).toBe(0);
    expect(compare(triangleBoxDistance2([pt(11, 0), pt(20, 0), pt(20, 5)], box), r(1))).toBe(0);
    expect(triangleBoxDistance2([pt(5, 5), pt(6, 5), pt(5, 6)], box).n).toBe(0n);
  });

  it('admits a simple in-viewport mesh with conforming seams and no inversions', () => {
    const input = inputOf(
      [
        [100.5, 100.25],
        [700.75, 130.5],
        [650.25, 600.125],
        [150.5, 500.75],
      ],
      [0, 1, 2, 0, 2, 3],
    );
    const origin = originPXTarget(input.camera, input.zoom, input.dpr, 128).origin;
    for (const T of [256, 1024]) {
      const tiles = tileRow(input, T, guarded(input, 4));
      const result = certifyTiles(input, tiles, origin, guarded(input, 4), GAMMA8);
      expect(result.outcome).toBe('ADMITTED');
      expect(result.inversions).toBe(0);
      expect(result.counts.tiles).toBe(tiles.cells.length);
      expect(result.seam?.conforming).toBe(true);
      expect(result.submesh.ok).toBe(true);
      expect(result.evaluated).toEqual({ position: true, c2: true });
      expect(result.c2Failures).toEqual({ vertex: 0, edge: 0, triangle: 0, wedge: 0 });
      if (T === 256) {
        expect(result.steiner).not.toBeNull();
        expect(result.seam!.count).toBeGreaterThan(0);
      }
    }
  });

  it('records a submesh violation for a drawn triangle within 1.5 px outside V', () => {
    // second triangle lies 1 px right of V, so it is not in-window when the window is V itself
    const input = inputOf(
      [
        [100, 100],
        [200, 100],
        [100, 200],
        [1281, 300],
        [1290, 300],
        [1281, 310],
      ],
      [0, 1, 2, 3, 4, 5],
    );
    const origin = originPXTarget(input.camera, input.zoom, input.dpr, 128).origin;
    const window = guarded(input, 0);
    const tiles = tileRow(input, 256, window);
    const result = certifyTiles(input, tiles, origin, window);
    expect(result.submesh.ok).toBe(false);
    expect(result.outcome).toMatch(/^NOT_ADMITTED:submesh:tile\(/);
    // with the 4 px guard it is in-window and the row is admitted
    const wide = certifyTiles(
      input,
      tileRow(input, 256, guarded(input, 4)),
      origin,
      guarded(input, 4),
    );
    expect(wide.outcome).toBe('ADMITTED');
  });

  it('maps tiling statuses to outcomes', () => {
    const input = inputOf(
      [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      [0, 1, 2],
    );
    const origin = originPXTarget(input.camera, input.zoom, input.dpr, 128).origin;
    const huge: PxWindow = { x0: r(0), y0: r(0), x1: r(256 * 80), y1: r(256 * 80) };
    expect(certifyTiles(input, tileRow(input, 256, huge), origin, huge).outcome).toBe(
      'TILE_CAP_EXCEEDED',
    );
    const flat = inputOf(
      [
        [0, 0],
        [1, 0],
        [0, 1],
      ],
      [0, 1, 2],
      { affine: [1e-50, 0, 0, 1e-50, 0, 0] },
    );
    expect(certifyTiles(flat, tileRow(flat, 256, huge), origin, huge).outcome).toBe(
      'NOT_ADMITTED:lane-range',
    );
    const away = inputOf(
      [
        [5000, 5000],
        [5001, 5000],
        [5000, 5001],
      ],
      [0, 1, 2],
    );
    const window = guarded(away, 4);
    expect(certifyTiles(away, tileRow(away, 256, window), origin, window).outcome).toBe(
      'NO_IN_WINDOW_TRIANGLES',
    );
  });
});
