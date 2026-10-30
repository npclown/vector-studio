import { isRejectedRunTextUnit } from '@vector-studio/model';
import { eventChord, eventToken } from './keymap.js';
import { textEditKeyAction, type TextEditKeyAction } from './text-caret.js';
import type { InputEvent, Modifiers, Platform } from './types.js';

// Text input in edit mode (MVP M6b contract, sections 5 and 9.1): the key routing of rules 1 to
// 6, which decides what a keydown does while `textEdit` is set before navigation, the tool and
// the keymap see it, and the normalization of text that enters a text node. Pure: the editor
// runs the route this returns.

type KeyDown = Extract<InputEvent, { kind: 'keydown' }>;

/**
 * What a text edit mode keydown does (section 5.1), by the first rule that matches:
 * `passThrough` (rules 1 and 2: left to text input), `edit` (rule 3: an edit action of the
 * section 4.2 table, consumed), `caret` (rule 4: a movement or Mod+A, consumed), `exit`, `undo`
 * and `redo` (rule 4, consumed), `consume` (rules 5 and 6: a consumed no-op) and `ignore` (rule
 * 6: not consumed, not passed through).
 */
export type TextKeyRoute =
  | Readonly<{ type: 'passThrough'; rule: 1 | 2 }>
  | Readonly<{ type: 'edit'; action: Extract<TextEditKeyAction, { type: 'delete' | 'lineBreak' }> }>
  | Readonly<{ type: 'caret'; action: Extract<TextEditKeyAction, { type: 'move' | 'selectAll' }> }>
  | Readonly<{ type: 'exit' | 'undo' | 'redo' }>
  | Readonly<{ type: 'consume'; rule: 5 | 6 }>
  | Readonly<{ type: 'ignore' }>;

const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });

/** Whether `key` is exactly one grapheme (rule 2): a character key, Space included. */
function isOneGrapheme(key: string): boolean {
  if (key.length === 0) return false;
  const iterator = graphemes.segment(key)[Symbol.iterator]();
  iterator.next();
  return iterator.next().done === true;
}

/**
 * Rule 2's modifiers: none of Ctrl, Meta and Alt (Shift is free); on `mac` Alt alone, since
 * Option produces characters; on `other` Ctrl+Alt without Meta (AltGr).
 */
function characterModifiers(modifiers: Modifiers, platform: Platform): boolean {
  const { ctrl, meta, alt } = modifiers;
  if (!ctrl && !meta && !alt) return true;
  if (platform === 'mac') return alt && !ctrl && !meta;
  return ctrl && alt && !meta;
}

/** Exactly `Mod` (Meta on `mac`, Ctrl elsewhere) among Ctrl, Meta and Alt; Shift is read apart. */
function onlyMod(modifiers: Modifiers, platform: Platform): boolean {
  const { ctrl, meta, alt } = modifiers;
  if (alt) return false;
  return platform === 'mac' ? meta && !ctrl : ctrl && !meta;
}

function plain(modifiers: Modifiers): boolean {
  return !modifiers.ctrl && !modifiers.meta && !modifiers.alt && !modifiers.shift;
}

/**
 * The route of a keydown in text edit mode (section 5.1). `bound` gives the action of a
 * canonical chord in the effective keymap, undefined when the chord is unbound.
 *
 * Readings: Escape exits only without modifiers; Tab and Shift+Tab are rule 5 only without
 * Ctrl, Meta and Alt; Mod+Z, Mod+Shift+Z and Mod+Y match the keymap token (`KeyZ`, `KeyY`), so
 * a non-Latin layout undoes as Mod+A selects all (M6b-U1 note 6).
 */
export function textKeyRoute(
  event: KeyDown,
  platform: Platform,
  bound: (chord: string) => string | undefined,
): TextKeyRoute {
  const { key, modifiers } = event;
  // (1) Composing: `Process`, `isComposing` or keyCode 229.
  if (key === 'Process' || event.composing === true || event.ime === true) {
    return { type: 'passThrough', rule: 1 };
  }
  // (2) Character keys, left to `beforeinput`.
  if (characterModifiers(modifiers, platform) && isOneGrapheme(key)) {
    return { type: 'passThrough', rule: 2 };
  }
  const action = textEditKeyAction(event, platform);
  // (3) Edit actions.
  if (action?.type === 'delete' || action?.type === 'lineBreak') return { type: 'edit', action };
  // (4) Edit-state keys.
  if (action?.type === 'move' || action?.type === 'selectAll') return { type: 'caret', action };
  if (key === 'Escape' && plain(modifiers)) return { type: 'exit' };
  if (onlyMod(modifiers, platform)) {
    const token = eventToken(event);
    if (token === 'KeyZ') return { type: modifiers.shift ? 'redo' : 'undo' };
    if (token === 'KeyY' && !modifiers.shift) return { type: 'redo' };
  }
  // (5) Tab and Shift+Tab.
  if (key === 'Tab' && !modifiers.ctrl && !modifiers.meta && !modifiers.alt) {
    return { type: 'consume', rule: 5 };
  }
  // (6) A bound chord is a consumed no-op, except the clipboard actions, whose DOM events
  // must still fire (section 9); anything else is left to the browser.
  const chord = eventChord(event, modifiers);
  const binding = chord === null ? undefined : bound(chord);
  if (binding === undefined || binding === 'copy' || binding === 'cut' || binding === 'paste') {
    return { type: 'ignore' };
  }
  return { type: 'consume', rule: 6 };
}

function isSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdfff;
}

/**
 * The normalization of section 9.1, for `textinput`, composition data and pasted text: CRLF,
 * CR, U+0085, U+2028 and U+2029 become LF, a tab becomes one space, and every other character
 * M6a-S1 rejects (C0 and C1 controls, the bidi controls, lone surrogates) is dropped.
 */
export function normalizeInputText(text: string): string {
  const unified = text.replace(/\r\n?|[\u0085\u2028\u2029]/gu, '\n').replace(/\t/gu, ' ');
  let out = '';
  // Code points: a pair is one string of length 2, a lone surrogate one of length 1.
  for (const character of unified) {
    const unit = character.charCodeAt(0);
    if (character.length === 1 && isSurrogate(unit)) continue;
    // M6a-S1's own check of one unit; a pair's high surrogate is never rejected by it.
    if (isRejectedRunTextUnit(unit)) continue;
    out += character;
  }
  return out;
}
