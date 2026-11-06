import type { JsonValue, KeyBinding, ToolId } from '@vector-studio/react';

// V-25 (editor UI usability, slice 1): the pure parts of `EditorToolbar` and `ZoomMenu`. Names,
// shortcut hints and groups only; the commands and enable rules are toolbar-model.ts's.

/** The display names of the built-in tools; an extension tool shows its ID. */
export const TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  select: 'Select',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  frame: 'Frame',
  path: 'Pen',
  text: 'Text',
});

/** The display names of the action buttons, by test ID. */
export const ACTION_NAMES: Readonly<Record<string, string>> = Object.freeze({
  group: 'Group selection',
  mask: 'Use as mask',
  ungroup: 'Ungroup',
  undo: 'Undo',
  redo: 'Redo',
  delete: 'Delete',
  'toggle-closed': 'Open or close path',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  'zoom-fit': 'Zoom to fit',
  'zoom-selection': 'Zoom to selection',
  'zoom-actual': 'Zoom to 100%',
  'create-symbol': 'Create symbol',
  'create-instance': 'Create instance',
  detach: 'Detach instance',
});

/** The keymap action each action button runs the same command as, by test ID. */
export const ACTION_KEYS: Readonly<Record<string, string>> = Object.freeze({
  group: 'group',
  mask: 'maskGroup',
  ungroup: 'ungroup',
  undo: 'undo',
  redo: 'redo',
  delete: 'delete',
  'toggle-closed': 'togglePathClosed',
  'zoom-in': 'zoomIn',
  'zoom-out': 'zoomOut',
  'zoom-fit': 'zoomToFit',
  'zoom-selection': 'zoomToSelection',
  'zoom-actual': 'zoomTo100',
});

const KEY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  Meta: '⌘',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift',
  Delete: 'Del',
  Backspace: '⌫',
  Escape: 'Esc',
  Enter: 'Enter',
  Space: 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
});

/**
 * A canonical chord (the `keymap` query's form, e.g. `Ctrl+Shift+KeyZ`) as a person reads it:
 * `Ctrl+Shift+Z`; `Meta` shows as ⌘. A `+` key token is the chord's last part (`Shift++`).
 */
export function chordLabel(chord: string): string {
  const parts =
    chord === '+'
      ? ['+']
      : chord.endsWith('++')
        ? [...chord.slice(0, -2).split('+'), '+']
        : chord.split('+');
  return parts
    .map((part) => {
      const named = KEY_NAMES[part];
      if (named !== undefined) return named;
      const letter = /^Key([A-Z])$/u.exec(part);
      if (letter !== null) return letter[1]!;
      const digit = /^Digit([0-9])$/u.exec(part);
      return digit === null ? part : digit[1]!;
    })
    .join('+');
}

/** Whether `args` holds every entry of `wanted` (shallow, JSON values compared as text). */
function argsMatch(
  args: JsonValue | undefined,
  wanted: Readonly<Record<string, JsonValue>>,
): boolean {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return Object.keys(wanted).length === 0;
  }
  const record = args as Readonly<Record<string, JsonValue>>;
  return Object.entries(wanted).every(
    ([key, value]) => JSON.stringify(record[key]) === JSON.stringify(value),
  );
}

/**
 * The first binding (in the keymap's chord order) of `action` whose args hold `args`, as a
 * label, or null when the action has no chord.
 */
export function shortcutFor(
  bindings: readonly KeyBinding[],
  action: string,
  args: Readonly<Record<string, JsonValue>> = {},
): string | null {
  const binding = bindings.find((entry) => entry.action === action && argsMatch(entry.args, args));
  return binding === undefined ? null : chordLabel(binding.chord);
}

/** A tooltip: the name, then the shortcut in parentheses when there is one. */
export function withShortcut(name: string, shortcut: string | null): string {
  return shortcut === null ? name : `${name} (${shortcut})`;
}

/** A tool's tooltip: its name (an extension tool its ID) and its `setTool` chord. */
export function toolTitle(tool: ToolId, bindings: readonly KeyBinding[]): string {
  return withShortcut(TOOL_NAMES[tool] ?? tool, shortcutFor(bindings, 'setTool', { tool }));
}

/** An action button's name, by test ID (the test ID when it has none). */
export function actionName(testId: string): string {
  return ACTION_NAMES[testId] ?? testId;
}

/** The chord of the keymap action an action button mirrors, as a label, or null. */
export function actionShortcut(testId: string, bindings: readonly KeyBinding[]): string | null {
  const key = ACTION_KEYS[testId];
  return key === undefined ? null : shortcutFor(bindings, key);
}

/** An action button's tooltip: its name and the chord of the keymap action it mirrors. */
export function actionTitle(testId: string, bindings: readonly KeyBinding[]): string {
  return withShortcut(actionName(testId), actionShortcut(testId, bindings));
}

/** The zoom as a whole percentage, for the zoom menu's button (`zoomLabel` keeps decimals). */
export function zoomPercent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
