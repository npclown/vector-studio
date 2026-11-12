import type {
  AutoLayout,
  AxisSizing,
  Command,
  CommandResult,
  DocumentV8,
  LayoutSizing,
  NodeV8,
} from '@vector-studio/react';
import { parseNumber, type Common } from './appearance-model.js';

// V-34 U3 (docs/plans/viz-v34-auto-layout-contract.md, section 6): the property panel's "Auto
// layout" section and "Resizing" selects, and the context menu's add or remove item. Every edit
// is one `setLayout` over the selected nodes (one undo step); add and remove are
// `addAutoLayout` and `removeAutoLayout`.

type LayoutNode = NodeV8 & { autoLayout?: AutoLayout; layoutSizing?: LayoutSizing };

const FIXED: LayoutSizing = { horizontal: 'fixed', vertical: 'fixed' };

export const autoLayoutOf = (node: NodeV8 | undefined): AutoLayout | null =>
  node?.type === 'frame' ? ((node as LayoutNode).autoLayout ?? null) : null;

export const layoutSizingOf = (node: NodeV8): LayoutSizing =>
  (node as LayoutNode).layoutSizing ?? FIXED;

function parentOf(document: DocumentV8, node: NodeV8): NodeV8 | undefined {
  return Object.hasOwn(document.nodes, node.parent) ? document.nodes[node.parent] : undefined;
}

/** Whether `node` is a child of an auto-layout frame (its X/Y are the layout's). */
export function inAutoLayout(document: DocumentV8, node: NodeV8): boolean {
  return autoLayoutOf(parentOf(document, node)) !== null;
}

function commonOf<N, T>(values: readonly N[], read: (value: N) => T): Common<T> {
  let found: { value: T; text: string } | null = null;
  for (const value of values) {
    const next = read(value);
    const text = JSON.stringify(next);
    if (found === null) found = { value: next, text };
    else if (found.text !== text) return { state: 'mixed' };
  }
  return found === null ? { state: 'none' } : { state: 'one', value: found.value };
}

/** The "Auto layout" section's state for the selected frames, or null without frames. */
export type AutoLayoutSection = Readonly<{
  frames: readonly NodeV8[];
  /** The selected frames that have auto layout. */
  holders: readonly NodeV8[];
  direction: Common<AutoLayout['direction']>;
  gap: Common<number>;
  padding: readonly Common<number>[];
  primaryAlign: Common<AutoLayout['primaryAlign']>;
  counterAlign: Common<AutoLayout['counterAlign']>;
}>;

export function autoLayoutSection(nodes: readonly NodeV8[]): AutoLayoutSection | null {
  const frames = nodes.filter((node) => node.type === 'frame');
  if (frames.length === 0) return null;
  const holders = frames.filter((node) => autoLayoutOf(node) !== null);
  const layouts = holders.map((node) => autoLayoutOf(node)!);
  return {
    frames,
    holders,
    direction: commonOf(layouts, (l) => l.direction),
    gap: commonOf(layouts, (l) => l.gap),
    padding: [0, 1, 2, 3].map((i) => commonOf(layouts, (l) => l.padding[i]!)),
    primaryAlign: commonOf(layouts, (l) => l.primaryAlign),
    counterAlign: commonOf(layouts, (l) => l.counterAlign),
  };
}

export const PRIMARY_ALIGNS: readonly AutoLayout['primaryAlign'][] = Object.freeze([
  'start',
  'center',
  'end',
  'spaceBetween',
]);
export const COUNTER_ALIGNS: readonly AutoLayout['counterAlign'][] = Object.freeze([
  'start',
  'center',
  'end',
]);
export const PADDING_SIDES = Object.freeze(['top', 'right', 'bottom', 'left'] as const);
export const ALIGN_LABELS: Readonly<Record<string, string>> = {
  start: 'Start',
  center: 'Centre',
  end: 'End',
  spaceBetween: 'Space between',
};

/** `setLayout` of an auto layout patch on the frames that have it. */
export function layoutPatchCommand(
  section: AutoLayoutSection,
  patch: Partial<AutoLayout>,
): Command {
  return { type: 'setLayout', ids: section.holders.map((n) => n.id), autoLayout: patch };
}

/** A gap edit, or null when the text is not a number (the model checks the range). */
export function gapCommand(section: AutoLayoutSection, text: string): Command | null {
  const value = parseNumber(text);
  return value === null ? null : layoutPatchCommand(section, { gap: value });
}

/**
 * A padding edit of one side: each holder keeps its other sides. Holders that differ get one
 * command each would be several steps, so the command patches the side per holder through one
 * `setLayout` only when they share the other sides; otherwise null (the field is "mixed").
 */
export function paddingCommand(
  section: AutoLayoutSection,
  side: number,
  text: string,
): Command | null {
  const value = parseNumber(text);
  if (value === null) return null;
  const padding = section.padding.map((common) => (common.state === 'one' ? common.value : null));
  if (padding.some((entry, i) => i !== side && entry === null)) return null;
  const next = padding.map((entry, i) => (i === side ? value : entry!)) as [
    number,
    number,
    number,
    number,
  ];
  return layoutPatchCommand(section, { padding: next });
}

/** The sizing choices a node offers on an axis: Hug for auto-layout frames, Fill for children. */
export type SizingChoice = Readonly<{ value: AxisSizing; enabled: boolean }>;

/** Whether `node` counts as fixed under fill (section 3.3): group, rotated, zero-size path. */
function fillDisabled(node: NodeV8, axis: 'horizontal' | 'vertical'): boolean {
  if (node.type === 'group' || node.type === 'maskGroup') return true;
  if (node.rotation !== 0 && node.rotation !== Math.PI) return true;
  const size = axis === 'horizontal' ? node.frame.width : node.frame.height;
  return (node.type === 'path' || node.type === 'line' || node.type === 'custom') && size === 0;
}

/** The "Resizing" section: per axis, the common value and the choices; null when only Fixed. */
export type ResizingSection = Readonly<{
  nodes: readonly NodeV8[];
  horizontal: Readonly<{ value: Common<AxisSizing>; choices: readonly SizingChoice[] }>;
  vertical: Readonly<{ value: Common<AxisSizing>; choices: readonly SizingChoice[] }>;
}>;

export function resizingSection(
  document: DocumentV8,
  nodes: readonly NodeV8[],
): ResizingSection | null {
  const hug = nodes.every((node) => autoLayoutOf(node) !== null);
  const fill = nodes.every((node) => inAutoLayout(document, node));
  if (!hug && !fill) return null;
  const axis = (key: 'horizontal' | 'vertical') => {
    const choices: SizingChoice[] = [{ value: 'fixed', enabled: true }];
    if (hug) choices.push({ value: 'hug', enabled: true });
    if (fill) {
      choices.push({ value: 'fill', enabled: !nodes.some((node) => fillDisabled(node, key)) });
    }
    return { value: commonOf(nodes, (node) => layoutSizingOf(node)[key]), choices };
  };
  return { nodes, horizontal: axis('horizontal'), vertical: axis('vertical') };
}

export const SIZING_LABELS: Readonly<Record<AxisSizing, string>> = {
  fixed: 'Fixed',
  hug: 'Hug',
  fill: 'Fill',
};

export function sizingCommand(
  nodes: readonly NodeV8[],
  axis: 'horizontal' | 'vertical',
  value: AxisSizing,
): Command {
  return { type: 'setLayout', ids: nodes.map((n) => n.id), layoutSizing: { [axis]: value } };
}

/** The context menu's auto layout item: remove when a selected frame has it, else add. */
export function autoLayoutMenuAction(
  nodes: readonly (NodeV8 | undefined)[],
): Readonly<{ kind: 'add' | 'remove'; label: string; action: string }> {
  return nodes.some((node) => autoLayoutOf(node) !== null)
    ? { kind: 'remove', label: 'Remove auto layout', action: 'removeAutoLayout' }
    : { kind: 'add', label: 'Add auto layout', action: 'addAutoLayout' };
}

/** `addAutoLayout`, then the selection of a wrapping frame (section 5, rule 2). */
export function runAddAutoLayout(
  execute: (command: Command) => CommandResult,
  ids: readonly string[],
): CommandResult {
  const result = execute({ type: 'addAutoLayout', ids });
  if (result.ok && result.ids.length > 0) execute({ type: 'setSelection', ids: result.ids });
  return result;
}
