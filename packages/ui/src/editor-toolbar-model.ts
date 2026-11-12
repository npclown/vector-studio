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
  pencil: 'Pencil',
  polygon: 'Polygon',
  eyedropper: 'Eyedropper',
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
  Backspace: 'Backspace',
  Escape: 'Esc',
  Enter: 'Enter',
  Space: 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
});

/**
 * The key a shifted US-layout character is typed on: the keymap writes `Shift+!` for the key
 * a person reads as `Shift+1`.
 */
const SHIFTED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '~': '`',
});

/**
 * A canonical chord (the `keymap` query's form, e.g. `Ctrl+Shift+KeyZ`) as a person reads it:
 * `Ctrl+Shift+Z`; `Meta` shows as ⌘, and with Shift a shifted character shows as the key it is
 * typed on (`Shift+!` as `Shift+1`, `Ctrl+Shift+}` as `Ctrl+Shift+]`). A `+` key token is the
 * chord's last part (`Shift++` reads `Shift+=`); with `mac` true Backspace shows as ⌫.
 */
export function chordLabel(chord: string, mac = false): string {
  const parts =
    chord === '+'
      ? ['+']
      : chord.endsWith('++')
        ? [...chord.slice(0, -2).split('+'), '+']
        : chord.split('+');
  const shifted = parts.length > 1 && parts.slice(0, -1).includes('Shift');
  return parts
    .map((part, index) => {
      if (mac && part === 'Backspace') return '⌫';
      if (shifted && index === parts.length - 1 && SHIFTED_KEYS[part] !== undefined) {
        return SHIFTED_KEYS[part];
      }
      const named = KEY_NAMES[part];
      if (named !== undefined) return named;
      const letter = /^Key([A-Z])$/u.exec(part);
      if (letter !== null) return letter[1]!;
      const digit = /^Digit([0-9])$/u.exec(part);
      return digit === null ? part : digit[1]!;
    })
    .join('+');
}

/** Whether a keymap is a Mac one: its undo chord uses `Meta` (`Mod` resolves to it). */
export function macKeymap(bindings: readonly KeyBinding[]): boolean {
  const undo = bindings.find((binding) => binding.action === 'undo');
  return undo !== undefined && undo.chord.split('+').includes('Meta');
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
 * label, or null when the action has no chord. Off a Mac keymap a non-Backspace chord is
 * preferred, so delete reads `Del` on Windows and ⌫ on a Mac.
 */
export function shortcutFor(
  bindings: readonly KeyBinding[],
  action: string,
  args: Readonly<Record<string, JsonValue>> = {},
): string | null {
  const matches = bindings.filter(
    (entry) => entry.action === action && argsMatch(entry.args, args),
  );
  const mac = macKeymap(bindings);
  // Off a Mac, a Backspace chord shows only when the action has no other one (Delete reads Del).
  const binding =
    (mac ? undefined : matches.find((entry) => !entry.chord.endsWith('Backspace'))) ?? matches[0];
  return binding === undefined ? null : chordLabel(binding.chord, mac);
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

/**
 * The menu item a key moves focus to (WAI-ARIA menu pattern): ArrowDown and ArrowUp to the next
 * or previous enabled item, wrapping; Home and End to the first or last enabled one. Null for
 * another key or when no item is enabled. `current` is the focused index, -1 for none.
 */
export function nextMenuIndex(
  enabled: readonly boolean[],
  current: number,
  key: string,
): number | null {
  const indexes = enabled.flatMap((on, index) => (on ? [index] : []));
  if (indexes.length === 0) return null;
  switch (key) {
    case 'Home':
      return indexes[0]!;
    case 'End':
      return indexes[indexes.length - 1]!;
    case 'ArrowDown':
      return indexes.find((index) => index > current) ?? indexes[0]!;
    case 'ArrowUp':
      return (
        [...indexes].reverse().find((index) => index < current) ?? indexes[indexes.length - 1]!
      );
    default:
      return null;
  }
}

/**
 * V-40: the side count the polygon Sides field sends for typed `draft` text on Enter or blur, or
 * null to send nothing (no draft, empty text, or the current count). Out-of-range or fractional
 * values are sent, so `setPolygonSides` refuses them and the refusal shows.
 */
export function polygonSidesCommit(draft: string | null, sides: number): number | null {
  if (draft === null || draft.trim() === '') return null;
  const value = Number(draft);
  return value === sides ? null : value;
}

/** V-40: the count ArrowUp or ArrowDown in the Sides field steps to, or null outside 3 to 60. */
export function polygonSidesStep(sides: number, key: string): number | null {
  if (key !== 'ArrowUp' && key !== 'ArrowDown') return null;
  const next = sides + (key === 'ArrowUp' ? 1 : -1);
  return next >= 3 && next <= 60 ? next : null;
}
