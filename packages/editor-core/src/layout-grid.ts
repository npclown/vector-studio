import type { LayoutGrid } from '@vector-studio/model';

// V-38 contract, V38-S3: a frame's layout grid as lines and bands in the frame's local space
// (origin at its top-left, `[0, width] × [0, height]`). Pure; used by snapping (V38-N1) and the
// host's grid overlay (V38-H3).

/** The most lines of a uniform grid per axis; a finer grid has none (V38-Q5). */
export const MAX_GRID_LINES = 4096;

/** A grid line: `axis: 'x'` is a vertical line at x = `value`, `'y'` a horizontal one. */
export type LayoutGridLine = Readonly<{ axis: 'x' | 'y'; value: number }>;

/** A column (`axis: 'x'`, from x = `low` to `high`) or a row (`axis: 'y'`). */
export type LayoutGridBand = Readonly<{ axis: 'x' | 'y'; low: number; high: number }>;

/** A layout grid's lines and bands in the frame's local space. */
export type LayoutGridGeometry = Readonly<{
  lines: readonly LayoutGridLine[];
  bands: readonly LayoutGridBand[];
}>;

function uniformLines(axis: 'x' | 'y', extent: number, size: number): LayoutGridLine[] {
  // The lines strictly inside (0, extent); the frame edges are not repeated.
  const count = Math.ceil(extent / size) - 1;
  if (!(count > 0) || count > MAX_GRID_LINES) return [];
  const lines: LayoutGridLine[] = [];
  for (let k = 1; k <= count; k += 1) {
    const value = k * size;
    if (value < extent) lines.push({ axis, value });
  }
  return lines;
}

/** The band starts of columns or rows over `extent` before clipping, with the band width. */
function bandStarts(
  grid: Extract<LayoutGrid, { type: 'columns' | 'rows' }>,
  extent: number,
): { starts: number[]; width: number } {
  const { count, gutter, offset, size } = grid;
  const starts: number[] = [];
  switch (grid.align) {
    case 'stretch': {
      const width = (extent - 2 * offset - (count - 1) * gutter) / count;
      if (!(width > 0)) return { starts, width: 0 };
      for (let i = 0; i < count; i += 1) starts.push(offset + i * (width + gutter));
      return { starts, width };
    }
    case 'start':
      for (let i = 0; i < count; i += 1) starts.push(offset + i * (size + gutter));
      return { starts, width: size };
    case 'end':
      for (let i = count - 1; i >= 0; i -= 1)
        starts.push(extent - offset - size - i * (size + gutter));
      return { starts, width: size };
    case 'center': {
      const first = (extent - (count * size + (count - 1) * gutter)) / 2;
      for (let i = 0; i < count; i += 1) starts.push(first + i * (size + gutter));
      return { starts, width: size };
    }
  }
}

/**
 * The lines and bands of `grid` on a frame of `width` × `height` (V38-S3), in local space: a
 * uniform grid's lines strictly inside the frame on both axes (none past `MAX_GRID_LINES` on an
 * axis); columns or rows as bands clipped to the frame (a band wholly outside is dropped), with
 * each band's two edges as lines, in band order and without repeats.
 */
export function layoutGridLines(
  width: number,
  height: number,
  grid: LayoutGrid,
): LayoutGridGeometry {
  if (grid.type === 'grid') {
    return {
      lines: [...uniformLines('x', width, grid.size), ...uniformLines('y', height, grid.size)],
      bands: [],
    };
  }
  const axis = grid.type === 'columns' ? 'x' : 'y';
  const extent = axis === 'x' ? width : height;
  const { starts, width: band } = bandStarts(grid, extent);
  const bands: LayoutGridBand[] = [];
  const lines: LayoutGridLine[] = [];
  const seen = new Set<number>();
  const line = (value: number) => {
    if (seen.has(value)) return;
    seen.add(value);
    lines.push({ axis, value });
  };
  for (const start of starts) {
    const low = Math.max(0, start);
    const high = Math.min(extent, start + band);
    if (!(high > low)) continue;
    bands.push({ axis, low, high });
    line(low);
    line(high);
  }
  return { lines, bands };
}
