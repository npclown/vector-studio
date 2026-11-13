import type { Color, Command, PageGrid, PageV8 } from '@vector-studio/react';
import { colorHex, numberText, parseHex, parseNumber } from './appearance-model.js';

// V-41 contract (docs/plans/viz-v41-canvas-background-grid-contract.md), V41-U1: the pure part
// of the property panel's Canvas section, the page's background and canvas grid.

/** V41-S1's default page background (the model's `DEFAULT_PAGE_BACKGROUND`). */
export const PAGE_BACKGROUND_DEFAULT: Color = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });

/** V41-S2's default canvas grid (the model's `DEFAULT_PAGE_GRID`). */
export const PAGE_GRID_DEFAULT: PageGrid = Object.freeze({
  size: 10,
  color: Object.freeze({ r: 0.5, g: 0.5, b: 0.5, a: 0.35 }),
});

/** What the Canvas section shows for `page`, defaults filled in. */
export type CanvasFields = Readonly<{
  background: string;
  gridColor: string;
  gridOpacity: string;
  gridSize: string;
}>;

export function canvasFields(page: PageV8): CanvasFields {
  const background = page.background ?? PAGE_BACKGROUND_DEFAULT;
  const grid = page.grid ?? PAGE_GRID_DEFAULT;
  return {
    background: colorHex(background),
    gridColor: colorHex(grid.color),
    gridOpacity: numberText(Math.round(grid.color.a * 1000) / 10),
    gridSize: numberText(grid.size),
  };
}

/** The background field's or picker's commit: opaque `#rrggbb`; null when not a colour. */
export function backgroundCommand(page: PageV8, hex: string): Command | null {
  const background = parseHex(hex, 1);
  return background === null ? null : { type: 'setPageCanvas', page: page.id, background };
}

/** The grid colour's commit, keeping the grid's opacity and size; null when not a colour. */
export function gridColorCommand(page: PageV8, hex: string): Command | null {
  const grid = page.grid ?? PAGE_GRID_DEFAULT;
  const color = parseHex(hex, grid.color.a);
  return color === null ? null : { type: 'setPageCanvas', page: page.id, grid: { ...grid, color } };
}

/** The grid opacity's commit (0 to 100 %), keeping its colour and size; null when not a value. */
export function gridOpacityCommand(page: PageV8, text: string): Command | null {
  const percent = parseNumber(text, 0, 100);
  if (percent === null) return null;
  const grid = page.grid ?? PAGE_GRID_DEFAULT;
  return {
    type: 'setPageCanvas',
    page: page.id,
    grid: { ...grid, color: { ...grid.color, a: percent / 100 } },
  };
}

/** The grid size's commit (page units, > 0), keeping its colour; null when not a value. */
export function gridSizeCommand(page: PageV8, text: string): Command | null {
  const size = parseNumber(text, 0);
  if (size === null || size === 0) return null;
  const grid = page.grid ?? PAGE_GRID_DEFAULT;
  return { type: 'setPageCanvas', page: page.id, grid: { ...grid, size } };
}
