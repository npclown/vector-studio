import type { LayoutGrid } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { MAX_GRID_LINES, layoutGridLines } from '../../packages/editor-core/src/index.js';

// V-38 contract, V38-A02 (V38-S3): a layout grid's lines and bands in the frame's local space.

const RED = { r: 1, g: 0, b: 0, a: 0.1 };
const bands = (
  over: { count: number; align: 'stretch' | 'start' | 'center' | 'end' } & Partial<
    Record<'size' | 'gutter' | 'offset', number>
  >,
  type: 'columns' | 'rows' = 'columns',
): LayoutGrid => ({
  type,
  size: 10,
  gutter: 0,
  offset: 0,
  color: RED,
  visible: true,
  ...over,
});
const values = (grid: LayoutGrid, width = 100, height = 50) =>
  layoutGridLines(width, height, grid).lines.map((line) => `${line.axis}${line.value}`);

describe('V38-A02 layout grid geometry', () => {
  it('a uniform grid has its inner lines on both axes', () => {
    const grid: LayoutGrid = { type: 'grid', size: 20, color: RED, visible: true };
    expect(values(grid, 100, 50)).toEqual(['x20', 'x40', 'x60', 'x80', 'y20', 'y40']);
    expect(layoutGridLines(100, 50, grid).bands).toEqual([]);
    // A line on the far edge is not repeated: 30 into 90 gives 30 and 60 only.
    expect(values({ ...grid, size: 30 }, 90, 10)).toEqual(['x30', 'x60']);
  });

  it('drops only the axis past the line cap', () => {
    const grid: LayoutGrid = { type: 'grid', size: 1, color: RED, visible: true };
    const geometry = layoutGridLines(MAX_GRID_LINES + 2, 10, grid);
    expect(geometry.lines.filter((line) => line.axis === 'x')).toEqual([]);
    expect(geometry.lines.filter((line) => line.axis === 'y')).toHaveLength(9);
    expect(layoutGridLines(MAX_GRID_LINES + 1, 1, grid).lines).toHaveLength(MAX_GRID_LINES);
  });

  it('stretch columns share the width after margins and gutters', () => {
    const grid = bands({ count: 3, align: 'stretch', gutter: 10, offset: 5 });
    // (100 − 10 − 20) / 3 = 70 / 3 per column.
    const w = 70 / 3;
    const got = layoutGridLines(100, 50, grid).bands;
    const want = [5, 5 + w + 10, 5 + 2 * (w + 10)].map((low) => [low, low + w]);
    expect(got.map((band) => band.axis)).toEqual(['x', 'x', 'x']);
    got.forEach((band, index) => {
      expect(band.low).toBeCloseTo(want[index]![0]!, 12);
      expect(band.high).toBeCloseTo(want[index]![1]!, 12);
    });
    // Over-full: no room left for the columns.
    expect(layoutGridLines(100, 50, bands({ count: 5, align: 'stretch', gutter: 30 }))).toEqual({
      lines: [],
      bands: [],
    });
  });

  it('start, end and center place fixed-size bands; touching bands share a line', () => {
    expect(values(bands({ count: 3, align: 'start', offset: 10, gutter: 5 }))).toEqual([
      'x10',
      'x20',
      'x25',
      'x35',
      'x40',
      'x50',
    ]);
    expect(values(bands({ count: 2, align: 'end', offset: 10, gutter: 5 }))).toEqual([
      'x65',
      'x75',
      'x80',
      'x90',
    ]);
    expect(values(bands({ count: 2, align: 'center', gutter: 0 }))).toEqual(['x40', 'x50', 'x60']);
  });

  it('rows run down the height; bands are clipped and dropped outside', () => {
    expect(values(bands({ count: 2, align: 'start', size: 20 }, 'rows'), 100, 30)).toEqual([
      'y0',
      'y20',
      'y30',
    ]);
    const clipped = layoutGridLines(100, 30, bands({ count: 3, align: 'start', size: 20 }, 'rows'));
    expect(clipped.bands).toEqual([
      { axis: 'y', low: 0, high: 20 },
      { axis: 'y', low: 20, high: 30 },
    ]);
  });
});
