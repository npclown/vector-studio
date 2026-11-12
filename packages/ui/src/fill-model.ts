import type {
  BlendMode,
  Command,
  ContainerBlendMode,
  Fill,
  NodeV8,
  Paint,
} from '@vector-studio/react';
import { parseNumber, type Common } from './appearance-model.js';

// V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-C2 and V35-C3: the pure side of
// the appearance panel's Fill list and Layer blend menu, unit tested without a DOM. The model
// stores fills bottom first; the panel lists them top first, so a row's display position `p` is
// the model index `n - 1 - p`. Each committed change is one public command (`addFill`,
// `setFill`, `removeFill`, `moveFill`, or `setStyle` for the mixed replace and the node mode),
// so it is one undo step.

/** The most fills a node holds (V35-S3, `MAX_FILLS`). */
export const PANEL_MAX_FILLS = 16;

/** The fill `+` replaces a mixed selection's fills with: the editor's default paint (V35-C1). */
export const PANEL_DEFAULT_FILL: Paint = Object.freeze({ r: 0.8, g: 0.8, b: 0.8, a: 1 });

/** The fills the selected nodes share, or that they differ. */
export type FillView =
  | Readonly<{ state: 'list'; fills: readonly Fill[] }>
  | Readonly<{ state: 'single' }>
  | Readonly<{ state: 'mixed' }>;

/** The selected nodes that take fills (shapes, paths, custom nodes, frames and symbols). */
export const fillHolders = (
  nodes: readonly NodeV8[],
): readonly Extract<NodeV8, { fills: unknown }>[] =>
  nodes.filter((node): node is Extract<NodeV8, { fills: unknown }> => 'fills' in node);

/**
 * The shared list when every holder has the same fills (compared as JSON); `single` when they
 * differ but each holder has at most one fill, which edits as M4's one Fill row with mixed values
 * (and V-39's `fill` binding); else mixed (C2: "Mixed", since the index-based commands would
 * otherwise edit different rows).
 */
export function fillView(
  holders: readonly Pick<NodeV8 & { fills: readonly Fill[] }, 'fills'>[],
): FillView {
  const first = holders[0];
  if (first === undefined) return { state: 'list', fills: [] };
  const text = JSON.stringify(first.fills);
  for (const holder of holders) {
    if (JSON.stringify(holder.fills) !== text) {
      return holders.every((entry) => entry.fills.length <= 1)
        ? { state: 'single' }
        : { state: 'mixed' };
    }
  }
  return { state: 'list', fills: first.fills };
}

/** Display position `position` (0 is the top row) as the model index of `count` fills. */
export const modelIndex = (count: number, position: number): number => count - 1 - position;

/** The label prefix of the row at display position `position`: "Fill", "Fill 2", "Fill 3"... */
export const rowPrefix = (position: number): string =>
  position === 0 ? 'Fill' : `Fill ${position + 1}`;

const ids = (nodes: readonly { id: string }[]): string[] => nodes.map((node) => node.id);

export const addFillCommand = (nodes: readonly { id: string }[]): Command => ({
  type: 'addFill',
  ids: ids(nodes),
});

/** C2's mixed `+`: every selected holder's fills become one default fill. */
export const replaceFillsCommand = (nodes: readonly { id: string }[]): Command => ({
  type: 'setStyle',
  ids: ids(nodes),
  style: { fill: PANEL_DEFAULT_FILL },
});

export const setFillCommand = (
  nodes: readonly { id: string }[],
  index: number,
  patch: Readonly<{ paint?: Paint; visible?: boolean; opacity?: number; blendMode?: BlendMode }>,
): Command => ({ type: 'setFill', ids: ids(nodes), index, patch });

export const removeFillCommand = (nodes: readonly { id: string }[], index: number): Command => ({
  type: 'removeFill',
  ids: ids(nodes),
  index,
});

/**
 * The command that moves the row at display position `position` one place `up` or down, or null
 * at the end of the list (up is toward the top, a higher model index).
 */
export function moveFillCommand(
  nodes: readonly { id: string }[],
  count: number,
  position: number,
  direction: 'up' | 'down',
): Command | null {
  const to = position + (direction === 'up' ? -1 : 1);
  if (to < 0 || to >= count) return null;
  return {
    type: 'moveFill',
    ids: ids(nodes),
    from: modelIndex(count, position),
    to: modelIndex(count, to),
  };
}

/** A fill opacity as the percent field shows it: 0.5 is "50". */
export const percentText = (opacity: number): string => String(Number((opacity * 100).toFixed(4)));

/** A percent field's text (an optional trailing `%`) as an opacity in [0, 1], or null. */
export function parsePercent(text: string): number | null {
  const percent = parseNumber(text.trim().replace(/%$/u, ''), 0, 100);
  return percent === null ? null : percent / 100;
}

// V35-C3: the blend menu. `Pass through` first (containers only), `Normal`, then the 15 modes in
// Figma's groups: darken, lighten, contrast, inversion, component.

export const BLEND_GROUPS: readonly Readonly<{
  label: string;
  modes: readonly BlendMode[];
}>[] = Object.freeze([
  { label: 'Normal', modes: ['normal'] },
  { label: 'Darken', modes: ['darken', 'multiply', 'colorBurn'] },
  { label: 'Lighten', modes: ['lighten', 'screen', 'colorDodge'] },
  { label: 'Contrast', modes: ['overlay', 'softLight', 'hardLight'] },
  { label: 'Inversion', modes: ['difference', 'exclusion'] },
  { label: 'Component', modes: ['hue', 'saturation', 'color', 'luminosity'] },
]);

const BLEND_LABELS: Readonly<Record<ContainerBlendMode, string>> = {
  passThrough: 'Pass through',
  normal: 'Normal',
  darken: 'Darken',
  multiply: 'Multiply',
  colorBurn: 'Color burn',
  lighten: 'Lighten',
  screen: 'Screen',
  colorDodge: 'Color dodge',
  overlay: 'Overlay',
  softLight: 'Soft light',
  hardLight: 'Hard light',
  difference: 'Difference',
  exclusion: 'Exclusion',
  hue: 'Hue',
  saturation: 'Saturation',
  color: 'Color',
  luminosity: 'Luminosity',
};

export const blendLabel = (mode: ContainerBlendMode): string => BLEND_LABELS[mode];

/** Every mode the menu can show, in menu order, with `passThrough` first. */
export const BLEND_MENU: readonly ContainerBlendMode[] = Object.freeze([
  'passThrough',
  ...BLEND_GROUPS.flatMap((group) => group.modes),
]);

/** The node types that take `passThrough` (S1: containers and instances). */
const CONTAINER_TYPES: ReadonlySet<NodeV8['type']> = new Set([
  'group',
  'maskGroup',
  'frame',
  'symbol',
  'instance',
]);

/** Whether `Pass through` is offered: every selected node is a container or instance. */
export const offersPassThrough = (nodes: readonly NodeV8[]): boolean =>
  nodes.length > 0 && nodes.every((node) => CONTAINER_TYPES.has(node.type));

/** The node mode over the selection, one value or mixed. */
export function blendCommon(nodes: readonly NodeV8[]): Common<ContainerBlendMode> {
  let found: ContainerBlendMode | null = null;
  for (const node of nodes) {
    if (found === null) found = node.blendMode;
    else if (found !== node.blendMode) return { state: 'mixed' };
  }
  return found === null ? { state: 'none' } : { state: 'one', value: found };
}

/** The Layer section's blend menu choice as its one `setStyle` command. */
export const blendCommand = (
  nodes: readonly { id: string }[],
  mode: ContainerBlendMode,
): Command => ({ type: 'setStyle', ids: ids(nodes), style: { blendMode: mode } });
