import type { BandLayoutGrid, Command, LayoutGrid, NodeV8 } from '@vector-studio/react';
import { numberText, parseHex, parseNumber } from './appearance-model.js';

// V-38 contract, V38-U1: the property panel's "Layout grid" section. It shows for exactly one
// selected frame or symbol; every edit writes the node's whole `layoutGrids` list with one
// `setNodeProps` (one undo step), and text that cannot be a value sends nothing.

/** A frame or symbol node, the only types with layout grids (V38-S2). */
export type GridHolder = Extract<NodeV8, { type: 'frame' | 'symbol' }>;

/** The one selected frame or symbol, or null (several nodes or another type show no section). */
export function layoutGridTarget(nodes: readonly NodeV8[]): GridHolder | null {
  if (nodes.length !== 1) return null;
  const node = nodes[0]!;
  return node.type === 'frame' || node.type === 'symbol' ? node : null;
}

/** The default grid colour: red at 10 % (V38-Q6). */
export const GRID_COLOUR = Object.freeze({ r: 1, g: 0, b: 0, a: 0.1 });

/** A new grid of `type` with the defaults of V38-U1. */
export function newLayoutGrid(type: LayoutGrid['type']): LayoutGrid {
  if (type === 'grid') return { type, size: 10, color: GRID_COLOUR, visible: true };
  return {
    type,
    count: 5,
    align: 'stretch',
    size: 100,
    gutter: 20,
    offset: 20,
    color: GRID_COLOUR,
    visible: true,
  };
}

const gridsOf = (node: GridHolder): readonly LayoutGrid[] => node.layoutGrids ?? [];

const write = (node: GridHolder, layoutGrids: readonly LayoutGrid[]): Command => ({
  type: 'setNodeProps',
  id: node.id,
  props: { layoutGrids },
});

const replace = (node: GridHolder, index: number, grid: LayoutGrid): Command =>
  write(
    node,
    gridsOf(node).map((entry, at) => (at === index ? grid : entry)),
  );

export const addGridCommand = (node: GridHolder, type: LayoutGrid['type']): Command =>
  write(node, [...gridsOf(node), newLayoutGrid(type)]);

export const removeGridCommand = (node: GridHolder, index: number): Command =>
  write(
    node,
    gridsOf(node).filter((_, at) => at !== index),
  );

export function toggleGridCommand(node: GridHolder, index: number): Command | null {
  const grid = gridsOf(node)[index];
  return grid === undefined ? null : replace(node, index, { ...grid, visible: !grid.visible });
}

/**
 * Changes a grid's type: between columns and rows the fields are kept; to or from a uniform grid
 * the new type's defaults are taken, with the colour and visibility kept.
 */
export function gridTypeCommand(
  node: GridHolder,
  index: number,
  type: LayoutGrid['type'],
): Command | null {
  const grid = gridsOf(node)[index];
  if (grid === undefined || grid.type === type) return null;
  if (grid.type !== 'grid' && type !== 'grid') return replace(node, index, { ...grid, type });
  return replace(node, index, { ...newLayoutGrid(type), color: grid.color, visible: grid.visible });
}

export function gridAlignCommand(
  node: GridHolder,
  index: number,
  align: BandLayoutGrid['align'],
): Command | null {
  const grid = gridsOf(node)[index];
  if (grid === undefined || grid.type === 'grid') return null;
  return replace(node, index, { ...grid, align });
}

/** A number field of a grid. */
export type GridNumberKey = 'size' | 'count' | 'gutter' | 'offset';

/** Which number fields a grid shows (V38-U1). */
export function gridNumberKeys(grid: LayoutGrid): readonly GridNumberKey[] {
  if (grid.type === 'grid') return ['size'];
  const keys: GridNumberKey[] = ['count'];
  if (grid.align !== 'stretch') keys.push('size');
  keys.push('gutter');
  if (grid.align !== 'center') keys.push('offset');
  return keys;
}

export const GRID_NUMBER_LABELS: Readonly<Record<GridNumberKey, string>> = {
  size: 'Size',
  count: 'Count',
  gutter: 'Gutter',
  offset: 'Margin',
};

export function gridNumberText(grid: LayoutGrid, key: GridNumberKey): string {
  return grid.type === 'grid' ? numberText(grid.size) : numberText(grid[key]);
}

/** One number field's edit, or null when the text cannot be a value (S2's bounds). */
export function gridNumberCommand(
  node: GridHolder,
  index: number,
  key: GridNumberKey,
  text: string,
): Command | null {
  const grid = gridsOf(node)[index];
  if (grid === undefined) return null;
  const value = parseNumber(text, 0, grid.type === 'grid' ? 1e4 : key === 'count' ? 1000 : 1e7);
  if (value === null) return null;
  if ((key === 'size' || key === 'count') && value === 0) return null;
  if (key === 'count' && !Number.isInteger(value)) return null;
  if (grid.type === 'grid')
    return key === 'size' ? replace(node, index, { ...grid, size: value }) : null;
  return replace(node, index, { ...grid, [key]: value });
}

export function gridColorCommand(node: GridHolder, index: number, hex: string): Command | null {
  const grid = gridsOf(node)[index];
  if (grid === undefined) return null;
  const color = parseHex(hex, grid.color.a);
  return color === null ? null : replace(node, index, { ...grid, color });
}

/** The grid colour's opacity as a percentage text. */
export const gridOpacityText = (grid: LayoutGrid): string =>
  numberText(Math.round(grid.color.a * 1000) / 10);

export function gridOpacityCommand(node: GridHolder, index: number, text: string): Command | null {
  const grid = gridsOf(node)[index];
  if (grid === undefined) return null;
  const percent = parseNumber(text.replace(/%$/u, ''), 0, 100);
  if (percent === null) return null;
  return replace(node, index, { ...grid, color: { ...grid.color, a: percent / 100 } });
}

/** The type and alignment choices, as their stored values. */
export const GRID_TYPES: readonly LayoutGrid['type'][] = ['grid', 'columns', 'rows'];
export const GRID_ALIGNS: readonly BandLayoutGrid['align'][] = [
  'stretch',
  'start',
  'center',
  'end',
];
