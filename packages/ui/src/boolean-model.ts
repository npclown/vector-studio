import type { Command, CommandResult, DocumentV7, KeyBinding } from '@vector-studio/react';
import { shortcutFor } from './editor-toolbar-model.js';

// E41-U3b (E41 contract, section 6): the boolean actions the context menu and the property
// panel show when the selection qualifies (section 2.1), and the notice copy for the four
// boolean refusals. Each action runs `booleanNodes`, which selects its result (E41-B3).

export type BooleanOpName = 'union' | 'subtract' | 'intersect' | 'exclude';

/** One boolean action: `op`, its label, test ID suffix and shortcut as a person reads it. */
export type BooleanAction = Readonly<{
  op: BooleanOpName;
  label: string;
  shortcut: string | null;
  command: Command;
}>;

const OPS: readonly (readonly [BooleanOpName, string])[] = [
  ['union', 'Union'],
  ['subtract', 'Subtract'],
  ['intersect', 'Intersect'],
  ['exclude', 'Exclude'],
];

const INPUT_TYPES: ReadonlySet<string> = new Set(['rectangle', 'ellipse', 'path', 'custom']);

/**
 * Whether `selection` qualifies for a boolean (section 2.1): two or more visible rectangles,
 * ellipses, paths or custom nodes with one parent, none a mask group's source. A custom node
 * without a path still reaches the command, which refuses it with `editor.boolean-unsupported`.
 */
export function booleanQualifies(document: DocumentV7, selection: readonly string[]): boolean {
  if (selection.length < 2) return false;
  const nodes = selection.map((id) => document.nodes[id]);
  const parent = nodes[0]?.parent;
  if (parent === undefined) return false;
  if (
    !nodes.every(
      (node) =>
        node !== undefined && node.parent === parent && node.visible && INPUT_TYPES.has(node.type),
    )
  ) {
    return false;
  }
  const owner = document.nodes[parent];
  return !(owner?.type === 'maskGroup' && selection.includes(owner.children[0]!));
}

/** The four boolean actions for `selection`, or none when it does not qualify. */
export function booleanActions(
  document: DocumentV7,
  selection: readonly string[],
  keymap: readonly KeyBinding[],
): readonly BooleanAction[] {
  if (!booleanQualifies(document, selection)) return [];
  return OPS.map(([op, label]) => ({
    op,
    label,
    shortcut: shortcutFor(keymap, 'boolean', { op }),
    command: { type: 'booleanNodes', ids: selection, op },
  }));
}

const NOTICES: Readonly<Record<string, string>> = {
  'editor.boolean-unsupported':
    'Boolean needs two or more visible shapes (rectangle, ellipse, path, star) in one group',
  'editor.boolean-empty': 'The boolean result is empty, so nothing changed',
  'editor.boolean-too-large': 'Too complex for a boolean (over 4,096 segments)',
  'editor.boolean-failed': 'The boolean operation failed, so nothing changed',
};

/** The notice for a refused boolean, or null for any other result. */
export function booleanNotice(result: CommandResult | null): string | null {
  return result === null || result.ok ? null : (NOTICES[result.code] ?? null);
}
