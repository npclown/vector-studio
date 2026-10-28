import type { JsonValue } from '@vector-studio/model';
import { deepFreeze } from './freeze.js';
import type { InputEvent, KeyBinding, Modifiers, Platform, ToolName } from './types.js';

// The keymap core (MVP M2 contract, section 7): canonical chords, key matching, binding
// validation and the defaults, extensions and host layers. No browser global is read; `Mod`
// resolves through the editor's `platform` option.

export const TOOL_NAMES: readonly ToolName[] = [
  'select',
  'rectangle',
  'ellipse',
  'line',
  'frame',
  'path',
];

/**
 * The built-in actions this editor runs. M2-U1 implements the actions of existing commands;
 * later M2 units add `duplicate`, `nudge`, `reorder`, `align`, `distribute`, `enterScope`,
 * `exitScope`, `copy`, `cut` and `paste` with their commands.
 */
export const BUILTIN_ACTIONS: ReadonlySet<string> = new Set([
  'setTool',
  'undo',
  'redo',
  'delete',
  'selectAll',
  'group',
  'ungroup',
  'maskGroup',
  'zoomIn',
  'zoomOut',
  'zoomToFit',
  'zoomToSelection',
  'zoomTo100',
]);

/**
 * The default layer, with chords as written in the contract (section 7). Bindings whose actions
 * later units add are not listed yet.
 */
export const DEFAULT_KEYMAP: readonly KeyBinding[] = deepFreeze([
  { chord: 'V', action: 'setTool', args: { tool: 'select' } },
  { chord: 'R', action: 'setTool', args: { tool: 'rectangle' } },
  { chord: 'O', action: 'setTool', args: { tool: 'ellipse' } },
  { chord: 'L', action: 'setTool', args: { tool: 'line' } },
  { chord: 'F', action: 'setTool', args: { tool: 'frame' } },
  { chord: 'P', action: 'setTool', args: { tool: 'path' } },
  { chord: 'Delete', action: 'delete' },
  { chord: 'Backspace', action: 'delete' },
  { chord: 'Mod+Z', action: 'undo' },
  { chord: 'Mod+Shift+Z', action: 'redo' },
  { chord: 'Mod+Y', action: 'redo' },
  { chord: 'Mod+A', action: 'selectAll' },
  { chord: 'Mod+G', action: 'group' },
  { chord: 'Mod+Shift+G', action: 'ungroup' },
  { chord: 'Mod+Alt+M', action: 'maskGroup' },
  { chord: '=', action: 'zoomIn' },
  { chord: '-', action: 'zoomOut' },
  { chord: 'Shift+!', action: 'zoomToFit' },
  { chord: 'Shift+@', action: 'zoomToSelection' },
  { chord: 'Shift+)', action: 'zoomTo100' },
]);

const MODIFIER_ORDER = ['Ctrl', 'Meta', 'Alt', 'Shift'] as const;
type ModifierName = (typeof MODIFIER_ORDER)[number];

/** A key token in canonical form: letters `KeyX`, digits `DigitN`, space `Space`, else as is. */
export function canonicalToken(token: string): string {
  if (/^[A-Za-z]$/u.test(token)) return `Key${token.toUpperCase()}`;
  if (/^[0-9]$/u.test(token)) return `Digit${token}`;
  if (token === ' ') return 'Space';
  return token;
}

/**
 * The canonical form of a chord, or null when it is malformed: an unknown or repeated modifier
 * (also after `Mod` resolves), or an empty key token. A key token `+` is written last, as in
 * `Shift++`.
 */
export function canonicalChord(chord: string, platform: Platform): string | null {
  if (typeof chord !== 'string' || chord.length === 0) return null;
  let parts: string[];
  if (chord === '+') parts = ['+'];
  else if (chord.endsWith('++')) parts = [...chord.slice(0, -2).split('+'), '+'];
  else parts = chord.split('+');
  const key = parts.pop()!;
  if (key.length === 0) return null;
  const modifiers = new Set<ModifierName>();
  const names = new Set<string>();
  for (const part of parts) {
    if (names.has(part)) return null;
    names.add(part);
    const name: string = part === 'Mod' ? (platform === 'mac' ? 'Meta' : 'Ctrl') : part;
    if (!(MODIFIER_ORDER as readonly string[]).includes(name)) return null;
    if (modifiers.has(name as ModifierName)) return null;
    modifiers.add(name as ModifierName);
  }
  return [...MODIFIER_ORDER.filter((name) => modifiers.has(name)), canonicalToken(key)].join('+');
}

function isNonAsciiCharacter(key: string): boolean {
  const characters = [...key];
  return characters.length === 1 && characters[0]!.codePointAt(0)! > 0x7f;
}

/**
 * The canonical chord of a key event (M2-Q3): the token is `key`, so the layout is respected;
 * only for `Process`, `Unidentified`, a single non-ASCII character or a composing key is it
 * `code` (no token without one).
 */
export function eventChord(
  event: Extract<InputEvent, { kind: 'keydown' }>,
  modifiers: Modifiers,
): string | null {
  const fromCode =
    event.composing === true ||
    event.key === 'Process' ||
    event.key === 'Unidentified' ||
    isNonAsciiCharacter(event.key);
  const token = fromCode ? event.code : event.key;
  if (token === undefined || token.length === 0) return null;
  const names: string[] = [];
  if (modifiers.ctrl) names.push('Ctrl');
  if (modifiers.meta) names.push('Meta');
  if (modifiers.alt) names.push('Alt');
  if (modifiers.shift) names.push('Shift');
  return [...names, canonicalToken(token)].join('+');
}

/** A frozen JSON copy, or undefined when the value is not JSON (bounded depth). */
function jsonCopy(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 64) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value + 0 : undefined;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value as unknown[]) {
      const copy = jsonCopy(item, depth + 1);
      if (copy === undefined) return undefined;
      items.push(copy);
    }
    return items;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const entries: [string, JsonValue][] = [];
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const copy = jsonCopy(item, depth + 1);
      if (copy === undefined) return undefined;
      entries.push([key, copy]);
    }
    return Object.fromEntries(entries);
  }
  return undefined;
}

/** A binding in canonical form, as the effective keymap holds it. */
export type CanonicalBinding = Readonly<{ chord: string; action: string | null; args?: JsonValue }>;

export type LayerResult =
  | Readonly<{ ok: true; bindings: readonly CanonicalBinding[] }>
  | Readonly<{ ok: false; path: string }>;

/**
 * Validates one layer. `command(id)` says whether an action that is not built-in names a command
 * the layer may run. A failure gives the path of the first malformed field, relative to the
 * layer (`/0/chord`); a second binding of one canonical chord fails at its `chord`.
 */
export function validateLayer(
  value: unknown,
  platform: Platform,
  command: (id: string) => boolean,
): LayerResult {
  if (!Array.isArray(value)) return { ok: false, path: '' };
  const seen = new Set<string>();
  const bindings: CanonicalBinding[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i] as Record<string, unknown> | null;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, path: `/${i}` };
    }
    const chord = typeof entry.chord === 'string' ? canonicalChord(entry.chord, platform) : null;
    if (chord === null) return { ok: false, path: `/${i}/chord` };
    if (seen.has(chord)) return { ok: false, path: `/${i}/chord` };
    seen.add(chord);
    const { action } = entry;
    if (
      action !== null &&
      (typeof action !== 'string' || !(BUILTIN_ACTIONS.has(action) || command(action)))
    ) {
      return { ok: false, path: `/${i}/action` };
    }
    let args: JsonValue | undefined;
    if (entry.args !== undefined) {
      args = jsonCopy(entry.args);
      if (args === undefined) return { ok: false, path: `/${i}/args` };
    }
    if (action === 'setTool') {
      const tool = (args as Record<string, unknown> | undefined)?.tool;
      if (
        typeof args !== 'object' ||
        args === null ||
        Array.isArray(args) ||
        !TOOL_NAMES.includes(tool as ToolName)
      ) {
        return { ok: false, path: `/${i}/args` };
      }
    }
    bindings.push(args === undefined ? { chord, action: action } : { chord, action, args });
  }
  return { ok: true, bindings: deepFreeze(bindings) };
}

/**
 * The effective keymap: the layers in order, the later binding of a canonical chord winning and
 * `action: null` unbinding it; frozen and sorted by chord.
 */
export function effectiveKeymap(
  layers: readonly (readonly CanonicalBinding[])[],
): readonly CanonicalBinding[] {
  const map = new Map<string, CanonicalBinding>();
  for (const layer of layers) {
    for (const binding of layer) {
      if (binding.action === null) map.delete(binding.chord);
      else map.set(binding.chord, binding);
    }
  }
  const chords = [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return deepFreeze(chords.map((chord) => map.get(chord)!));
}
