import type { TextLayoutPort } from '@vector-studio/contracts';
import {
  isValidRunText,
  MAX_TEXT_LENGTH,
  type Color,
  type DocumentV6,
  type Frame,
  type TextRun,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type Modifiers,
  type Platform,
  type TextEditState,
} from '../../packages/editor-core/src/index.js';
// Source imports: the key routing and the normalization are internal.
import { normalizeInputText, textKeyRoute } from '../../packages/editor-core/src/text-input.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// MVP M6b-U4, M6b-A05 and M6b-A07 (docs/plans/mvp-m6b-text-editing-contract.md, sections 4.2,
// 5 and 9.1): typing, LF and deletion through `input` with the M6a style rules and the length
// bound, the normalization of section 9.1, and the key routing rules 1 to 6 with their results,
// `passThrough` and the goal x of M6b-S3. Layouts come from the fake port: `a` to `z` advance
// 0.5 em, a space 0.25 em, Hangul and emoji 1 em, a line is 1.2 times its size. At size 10,
// "ab cd" has its stops 0 to 5 at x 0, 5, 10, 12.5, 17.5 and 22.5 on one line.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black: Color = { r: 0, g: 0, b: 0, a: 1 };
const red: Color = { r: 1, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const shift: Modifiers = { ...none, shift: true };
const ctrl: Modifiers = { ...none, ctrl: true };
const alt: Modifiers = { ...none, alt: true };
const meta: Modifiers = { ...none, meta: true };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });

type Loose = Record<string, unknown> & { id: string };

function run(text: string, size = 10, color = black): TextRun {
  return { text, family: 'Test', size, color };
}

function text(id: string, frame: Frame, runs: TextRun[]): Loose {
  return {
    id,
    name: id,
    parent: 'p1',
    frame,
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type: 'text',
    runs,
    sizing: 'autoWidth',
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1.2,
  };
}

/**
 * Page `p1`: `t` "ab cd" at (10, 20); `m` "abcd" LF "ab" LF "abcd" (lines from 0, 5 and 8);
 * `s` two runs, "ab" at size 10 and "cd" red at size 20; `c` a lone U+0301; `r` a rectangle.
 */
function fixture(extra: Loose[] = []): DocumentV6 {
  const nodes: Loose[] = [
    text('t', f(10, 20, 22.5, 12), [run('ab cd')]),
    text('m', f(100, 20, 20, 36), [run('abcd\nab\nabcd')]),
    text('s', f(200, 20, 30, 24), [run('ab'), run('cd', 20, red)]),
    text('c', f(300, 20, 0, 12), [run('́')]),
    {
      id: 'r',
      name: 'r',
      parent: 'p1',
      frame: f(400, 400, 10, 10),
      rotation: 0,
      constraints: START,
      opacity: 1,
      visible: true,
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: black,
      stroke: null,
    },
    ...extra,
  ];
  return {
    schemaVersion: 6,
    id: 'doc',
    pages: [{ id: 'p1', name: 'Page 1', children: nodes.map((node) => node.id) }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  } as unknown as DocumentV6;
}

function editor(
  options: { port?: TextLayoutPort | null; platform?: Platform; extra?: Loose[] } = {},
): Editor {
  const port = options.port === undefined ? createFakeTextLayout() : options.port;
  return createEditor({
    document: fixture(options.extra),
    ids: createCounterIdSource('n'),
    ...(port === null ? {} : { textLayout: port }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
}

/** An editor in edit mode on `id` with the caret `anchor` to `focus` (collapsed by default). */
function editing(
  id = 't',
  anchor = 5,
  focus = anchor,
  options: Parameters<typeof editor>[0] = {},
): Editor {
  const target = editor(options);
  expect(target.execute({ type: 'enterTextEdit', id, anchor, focus })).toEqual({
    ok: true,
    ids: [],
  });
  return target;
}

const input = (target: Editor, event: unknown) =>
  target.execute({ type: 'input', event } as Command);
const type = (target: Editor, value: unknown) => input(target, { kind: 'textinput', text: value });
const key = (
  target: Editor,
  value: string,
  modifiers = none,
  extra: { code?: string; composing?: boolean; ime?: boolean } = {},
) => input(target, { kind: 'keydown', key: value, ...extra, modifiers });

function caret(id: string, anchor: number, focus = anchor, affinity = 'downstream') {
  return { id, pending: null, anchor, focus, affinity, composition: null } as TextEditState;
}

function textOf(target: Editor, id: string): string {
  const node = target.query({ type: 'node', id });
  if (node?.type !== 'text') throw new Error(`not a text node: ${id}`);
  return node.runs.map((r) => r.text).join('');
}

function runsOf(target: Editor, id: string): readonly TextRun[] {
  const node = target.query({ type: 'node', id });
  if (node?.type !== 'text') throw new Error(`not a text node: ${id}`);
  return node.runs;
}

/** The session fields and document causes raised while `action` runs, in order. */
function events(target: Editor, action: () => void): string[] {
  const seen: string[] = [];
  const stop = target.subscribe((event: EditorEvent) => {
    if (event.type === 'session') seen.push(event.field);
    if (event.type === 'document') seen.push(`document:${event.cause}`);
  });
  try {
    action();
  } finally {
    stop();
  }
  return seen;
}

const consumed: CommandResult = { ok: true, ids: [], consumed: true };
const unconsumed: CommandResult = { ok: true, ids: [], consumed: false };
const passThrough: CommandResult = { ok: true, ids: [], consumed: false, passThrough: true };

/** The snapshot fields no routed key may change, apart from the caret. */
function untouched(target: Editor) {
  const { document, selection, tool, viewport, history, scope } = target.getSnapshot();
  return { document, selection, tool, viewport, history, scope };
}

describe('M6b-A05 textinput (section 5.3)', () => {
  it('inserts at the caret as one step, the caret after it, document event first', () => {
    const target = editing('t', 2);
    expect(events(target, () => expect(type(target, 'x')).toEqual(consumed))).toEqual([
      'document:command',
      'textEdit',
    ]);
    expect(textOf(target, 't')).toBe('abx cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 3));
    expect(target.getSnapshot().history).toEqual({ undoDepth: 1, redoDepth: 0 });
    type(target, 'yz');
    expect(textOf(target, 't')).toBe('abxyz cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
    // The second insertion merges into the first (M6b-U5, section 8.2).
    expect(target.getSnapshot().history).toEqual({ undoDepth: 1, redoDepth: 0 });
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
  });

  it('replaces a selection, in either direction, with the caret at its end', () => {
    const all = editor();
    all.execute({ type: 'enterTextEdit', id: 't' });
    expect(type(all, 'z')).toEqual(consumed);
    expect(textOf(all, 't')).toBe('z');
    expect(all.getSnapshot().textEdit).toEqual(caret('t', 1));
    const backward = editing('t', 5, 3);
    type(backward, 'QR');
    expect(textOf(backward, 't')).toBe('ab QR');
    expect(backward.getSnapshot().textEdit).toEqual(caret('t', 5));
  });

  it('a text replaced by itself is a step (M6a setText) and moves the caret', () => {
    const target = editing('t', 0, 1);
    expect(type(target, 'a')).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1));
    expect(target.getSnapshot().history.undoDepth).toBe(1);
  });

  it('takes the style of the character before the selection start (M6a styleBefore)', () => {
    const target = editing('s', 2);
    type(target, 'x');
    expect(runsOf(target, 's')).toEqual([run('abx'), run('cd', 20, red)]);
    const atStart = editing('s', 0);
    type(atStart, 'y');
    expect(runsOf(atStart, 's')).toEqual([run('yab'), run('cd', 20, red)]);
    // A selection from inside the second run: the style of the character before its start.
    const inside = editing('s', 3, 4);
    type(inside, 'z');
    expect(runsOf(inside, 's')).toEqual([run('ab'), run('cz', 20, red)]);
  });

  it('Hangul syllables insert and delete as one cluster each', () => {
    const target = editing('t', 5);
    type(target, ' 한');
    type(target, '글');
    expect(textOf(target, 't')).toBe('ab cd 한글');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 8));
    expect(key(target, 'ArrowLeft')).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 7));
    expect(key(target, 'Backspace')).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab cd 글');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
    expect(key(target, 'Delete')).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab cd ');
  });

  it('a surrogate pair is one stop: inserted, moved over and deleted whole', () => {
    const target = editing('t', 2);
    type(target, '\u{1F600}');
    expect(textOf(target, 't')).toBe('ab\u{1F600} cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 4));
    key(target, 'ArrowLeft');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2));
    key(target, 'ArrowRight');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 4));
    key(target, 'Backspace');
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2));
    // A lone surrogate is dropped (section 9.1), leaving nothing: a consumed no-op.
    expect(type(target, '\uD83D')).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab cd');
  });

  it('the caret after an insertion moves up to the next stop (section 4.1)', () => {
    // "e" before an existing U+0301 makes one cluster, so the caret goes after the accent.
    const target = editing('c', 0);
    type(target, 'e');
    expect(textOf(target, 'c')).toBe('é');
    expect(target.getSnapshot().textEdit).toEqual(caret('c', 2));
  });

  it('normalizes the text by section 9.1', () => {
    const target = editing('t', 0, 5);
    type(target, 'a\r\nb\rc\u0085d e f\tg');
    expect(textOf(target, 't')).toBe('a\nb\nc\nd\ne\nf g');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 13));
    const dropped = editing('t', 0);
    type(dropped, 'x\u0000\u0007\u001b\u007f\u0080\u009f‎‏؜‪‮⁦⁩y');
    // DEL (U+007F) is not a control under M6a-S1, so it stays.
    expect(textOf(dropped, 't')).toBe('x\u007fyab cd');
  });

  it('text empty after normalization is a consumed no-op with no step or event', () => {
    const target = editing('t', 1, 3);
    const before = target.getSnapshot();
    expect(events(target, () => expect(type(target, '\u0001‮')).toEqual(consumed))).toEqual([]);
    expect(type(target, '')).toEqual(consumed);
    expect(target.getSnapshot()).toBe(before);
  });

  it('a result over MAX_TEXT_LENGTH fails at the setText path and changes nothing', () => {
    const long = text('long', f(0, 200, 0, 12), [run('a'.repeat(MAX_TEXT_LENGTH - 1))]);
    const target = editing('long', 0, 0, { extra: [long] });
    const before = target.getSnapshot();
    const failed = {
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/long/runs',
    };
    expect(type(target, 'bc')).toEqual({ ...failed, consumed: false });
    expect(target.getSnapshot()).toBe(before);
    // Exactly the bound is accepted.
    expect(type(target, 'b')).toEqual(consumed);
    expect(textOf(target, 'long')).toHaveLength(MAX_TEXT_LENGTH);
    // An edit action over the bound is still consumed (rule 3), with the code.
    const full = target.getSnapshot();
    expect(key(target, 'Enter')).toEqual({ ...failed, consumed: true });
    expect(target.getSnapshot()).toBe(full);
    // A replacement that keeps the length is accepted.
    target.execute({ type: 'setTextSelection', anchor: 0, focus: 1 });
    expect(type(target, 'c')).toEqual(consumed);
  });

  it('outside edit mode fails with editor.no-text-edit; without a port, no-text-layout', () => {
    const target = editor();
    const before = target.getSnapshot();
    expect(type(target, 'x')).toEqual({ ok: false, code: 'editor.no-text-edit', consumed: false });
    expect(target.getSnapshot()).toBe(before);
    expect(type(editor({ port: null }), 'x')).toEqual({
      ok: false,
      code: 'editor.no-text-layout',
      consumed: false,
    });
  });

  it('a malformed textinput is editor.invalid-command at /event', () => {
    const target = editing();
    expect(type(target, 5)).toEqual({ ok: false, code: 'editor.invalid-command', path: '/event' });
    expect(input(target, { kind: 'textinput' })).toMatchObject({ code: 'editor.invalid-command' });
  });
});

describe('M6b-A05 line breaks and deletion (section 4.2, rule 3)', () => {
  it('Enter and Shift+Enter insert LF; over a selection it replaces it', () => {
    const target = editing('t', 2);
    expect(key(target, 'Enter')).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab\n cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 3));
    expect(key(target, 'Enter', shift)).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab\n\n cd');
    // The layout has the new lines: three lines of height 12.
    expect(target.query({ type: 'node', id: 't' })!.frame.height).toBe(36);
    const selected = editing('t', 1, 4);
    key(selected, 'Enter');
    expect(textOf(selected, 't')).toBe('a\nd');
    expect(selected.getSnapshot().textEdit).toEqual(caret('t', 2));
    expect(selected.getSnapshot().history.undoDepth).toBe(1);
  });

  it('Backspace and Delete remove a cluster; Shift+Backspace is Backspace', () => {
    const target = editing('t', 3);
    expect(key(target, 'Backspace')).toEqual(consumed);
    expect(textOf(target, 't')).toBe('abcd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2));
    expect(key(target, 'Delete')).toEqual(consumed);
    expect(textOf(target, 't')).toBe('abd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2));
    expect(key(target, 'Backspace', shift)).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ad');
    expect(target.getSnapshot().history.undoDepth).toBe(3);
  });

  it('Shift+Delete is not an edit action: unbound, so not consumed and nothing changes', () => {
    const target = editing('t', 3);
    const before = target.getSnapshot();
    expect(key(target, 'Delete', shift)).toEqual(unconsumed);
    expect(target.getSnapshot()).toBe(before);
  });

  it('a selection is deleted by Backspace and Delete alike', () => {
    const back = editing('t', 1, 4);
    key(back, 'Backspace');
    expect(textOf(back, 't')).toBe('ad');
    expect(back.getSnapshot().textEdit).toEqual(caret('t', 1));
    const forward = editing('t', 4, 1);
    key(forward, 'Delete');
    expect(textOf(forward, 't')).toBe('ad');
    expect(forward.getSnapshot().textEdit).toEqual(caret('t', 1));
    const word = editing('t', 4, 1);
    key(word, 'Backspace', ctrl);
    expect(textOf(word, 't')).toBe('ad');
  });

  it('Backspace at 0 and Delete at the length are consumed no-ops', () => {
    const start = editing('t', 0);
    const before = start.getSnapshot();
    expect(events(start, () => expect(key(start, 'Backspace')).toEqual(consumed))).toEqual([]);
    expect(key(start, 'Backspace', ctrl)).toEqual(consumed);
    expect(start.getSnapshot()).toBe(before);
    const end = editing('t', 5);
    const after = end.getSnapshot();
    expect(key(end, 'Delete')).toEqual(consumed);
    expect(key(end, 'Delete', ctrl)).toEqual(consumed);
    expect(end.getSnapshot()).toBe(after);
  });

  it('word deletion on other: Ctrl+Backspace to the previous, Ctrl+Delete to the next start', () => {
    const back = editing('t', 5);
    expect(key(back, 'Backspace', ctrl)).toEqual(consumed);
    expect(textOf(back, 't')).toBe('ab ');
    expect(back.getSnapshot().textEdit).toEqual(caret('t', 3));
    expect(key(back, 'Backspace', ctrl)).toEqual(consumed);
    expect(textOf(back, 't')).toBe('');
    const forward = editing('t', 0);
    expect(key(forward, 'Delete', ctrl)).toEqual(consumed);
    expect(textOf(forward, 't')).toBe('cd');
    expect(forward.getSnapshot().textEdit).toEqual(caret('t', 0));
    // Shift with a word deletion is not an edit action, and unbound.
    expect(key(forward, 'Backspace', { ...ctrl, shift: true })).toEqual(unconsumed);
    expect(textOf(forward, 't')).toBe('cd');
  });

  it('deleting all text keeps the node with one empty run in its style', () => {
    const target = editing('s', 0, 4);
    key(target, 'Delete');
    expect(runsOf(target, 's')).toEqual([run('')]);
    expect(target.getSnapshot().textEdit).toEqual(caret('s', 0));
  });
});

describe('M6b-A05 macOS mappings (M6b-Q12 (a), section 4.2)', () => {
  const mac = (anchor: number, focus = anchor, id = 't') =>
    editing(id, anchor, focus, { platform: 'mac' });

  it('Alt moves by word: to the previous start and the next end', () => {
    const target = mac(5);
    expect(key(target, 'ArrowLeft', alt)).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 3));
    key(target, 'ArrowLeft', alt);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0));
    key(target, 'ArrowRight', alt);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2));
    key(target, 'ArrowRight', { ...alt, shift: true });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2, 5));
  });

  it('Meta+Left and Right go to the line ends, Meta+Up and Down to the text ends', () => {
    const target = mac(6, 6, 'm');
    key(target, 'ArrowLeft', meta);
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 5));
    key(target, 'ArrowRight', meta);
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 7));
    key(target, 'ArrowUp', meta);
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 0));
    key(target, 'ArrowDown', meta);
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 12));
  });

  it('Alt+Backspace and Alt+Delete delete by word, Meta+Backspace to the line start', () => {
    const back = mac(5);
    expect(key(back, 'Backspace', alt)).toEqual(consumed);
    expect(textOf(back, 't')).toBe('ab ');
    const forward = mac(0);
    expect(key(forward, 'Delete', alt)).toEqual(consumed);
    expect(textOf(forward, 't')).toBe(' cd');
    const line = mac(7, 7, 'm');
    expect(key(line, 'Backspace', meta)).toEqual(consumed);
    expect(textOf(line, 'm')).toBe('abcd\n\nabcd');
    expect(line.getSnapshot().textEdit).toEqual(caret('m', 5));
  });

  it('Meta is Mod: Meta+A selects all, Meta+Z undoes; Ctrl+A is not bound on mac', () => {
    const target = mac(2);
    type(target, 'x');
    expect(key(target, 'a', meta, { code: 'KeyA' })).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 6));
    expect(key(target, 'z', meta, { code: 'KeyZ' })).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab cd');
    expect(key(target, 'z', { ...meta, shift: true }, { code: 'KeyZ' })).toEqual(consumed);
    expect(textOf(target, 't')).toBe('abx cd');
    const caretBefore = target.getSnapshot().textEdit;
    expect(key(target, 'a', ctrl, { code: 'KeyA' })).toEqual(unconsumed);
    expect(target.getSnapshot().textEdit).toEqual(caretBefore);
    // Ctrl+Backspace is no edit action on mac.
    expect(key(target, 'Backspace', ctrl)).toEqual(unconsumed);
  });

  it('Option characters pass through on mac; Alt+letter on other does not', () => {
    const target = mac(2);
    expect(key(target, 'å', alt, { code: 'KeyA' })).toEqual(passThrough);
    expect(key(editing(), 'a', alt, { code: 'KeyA' })).toEqual(unconsumed);
  });
});

describe('M6b-A07 key routing rule 1: composing keys pass through', () => {
  it('the first Process keydown no longer resolves to KeyR: no tool switch', () => {
    const target = editing('t', 2);
    const before = untouched(target);
    expect(key(target, 'Process', none, { code: 'KeyR' })).toEqual(passThrough);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2));
    expect(untouched(target)).toEqual(before);
  });

  it('isComposing and keyCode 229 pass through any key, edit and movement keys included', () => {
    const target = editing('t', 2);
    const before = target.getSnapshot();
    for (const value of ['Enter', 'Backspace', 'Delete', 'ArrowLeft', 'Escape', 'Tab', 'z']) {
      expect(key(target, value, none, { composing: true })).toEqual(passThrough);
      expect(key(target, value, none, { ime: true })).toEqual(passThrough);
    }
    expect(key(target, 'z', ctrl, { code: 'KeyZ', ime: true })).toEqual(passThrough);
    // Space under an IME (`code` Space) reaches neither navigation nor text.
    expect(key(target, 'Process', none, { code: 'Space' })).toEqual(passThrough);
    expect(target.getSnapshot()).toBe(before);
    // A following non-229 key acts by rules 3 and 4.
    expect(key(target, 'ArrowLeft')).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1));
  });

  it('a malformed ime flag is editor.invalid-command at /event', () => {
    expect(key(editing(), 'a', none, { ime: 1 as unknown as boolean })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/event',
    });
  });
});

describe('M6b-A07 key routing rule 2: character keys pass through', () => {
  it('letters, digits, Space and bound single keys never reach the tool or the keymap', () => {
    const target = editing('t', 2);
    const before = untouched(target);
    const keys: [string, string][] = [
      ['r', 'KeyR'],
      ['v', 'KeyV'],
      ['p', 'KeyP'],
      ['R', 'KeyR'],
      ['=', 'Equal'],
      ['-', 'Minus'],
      ['1', 'Digit1'],
      [' ', 'Space'],
      ['ㅎ', 'KeyG'],
      ['é', 'KeyE'],
    ];
    for (const [value, code] of keys) {
      expect(key(target, value, none, { code })).toEqual(passThrough);
    }
    expect(key(target, '!', shift, { code: 'Digit1' })).toEqual(passThrough);
    expect(key(target, ')', shift, { code: 'Digit0' })).toEqual(passThrough);
    expect(untouched(target)).toEqual(before);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2));
  });

  it('Space passes through and does not start a pan', () => {
    const target = editing('t', 2);
    expect(key(target, ' ', none, { code: 'Space' })).toEqual(passThrough);
    const viewport = target.getSnapshot().viewport;
    // A press inside the box places the caret instead of grabbing the canvas.
    input(target, { kind: 'pointerdown', point: { x: 15, y: 25 }, modifiers: none });
    input(target, { kind: 'pointermove', point: { x: 40, y: 60 }, modifiers: none });
    input(target, { kind: 'pointerup', point: { x: 40, y: 60 }, modifiers: none });
    expect(target.getSnapshot().viewport).toBe(viewport);
    expect(target.getSnapshot().textEdit).toMatchObject({ anchor: 1 });
    expect(key(target, ' ', none, { code: 'Space' })).toEqual(passThrough);
    expect(input(target, { kind: 'keyup', key: ' ', code: 'Space', modifiers: none })).toEqual(
      unconsumed,
    );
  });

  it('AltGr (Ctrl+Alt) characters pass through on other', () => {
    const target = editing();
    expect(key(target, '@', { ...ctrl, alt: true }, { code: 'KeyQ' })).toEqual(passThrough);
    expect(key(target, '€', { ...ctrl, alt: true }, { code: 'KeyE' })).toEqual(passThrough);
    // So is Mod+Alt+M (maskGroup) with a character key: rule 2 comes before rule 6.
    const before = target.getSnapshot();
    expect(key(target, 'm', { ...ctrl, alt: true }, { code: 'KeyM' })).toEqual(passThrough);
    expect(target.getSnapshot()).toBe(before);
  });

  it('a non-character key is not rule 2: a dead key is left alone, not passed through', () => {
    const target = editing();
    expect(key(target, 'Dead', none, { code: 'Quote' })).toEqual(unconsumed);
    expect(key(target, 'F5', none, { code: 'F5' })).toEqual(unconsumed);
  });
});

describe('M6b-A07 key routing rules 3 and 4: edit actions and edit-state keys', () => {
  it('arrows move the caret instead of nudging the node', () => {
    const target = editing('t', 2);
    const before = untouched(target);
    expect(key(target, 'ArrowRight')).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 3));
    expect(key(target, 'ArrowLeft', shift)).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 3, 2));
    expect(key(target, 'ArrowLeft')).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2));
    expect(key(target, 'ArrowUp')).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0));
    expect(key(target, 'ArrowDown')).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
    expect(key(target, 'Home')).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0));
    expect(key(target, 'End', shift)).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 5));
    expect(untouched(target)).toEqual(before);
  });

  it('Ctrl moves by word and to the text ends on other', () => {
    const target = editing('m', 6);
    key(target, 'ArrowRight', ctrl);
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 8));
    key(target, 'ArrowLeft', ctrl);
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 5));
    key(target, 'End', ctrl);
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 12));
    key(target, 'Home', { ...ctrl, shift: true });
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 12, 0));
    // Ctrl+Up is not in the table and not bound: left to the browser.
    expect(key(target, 'ArrowUp', ctrl)).toEqual(unconsumed);
  });

  it('a movement that changes nothing is a consumed no-op with no event', () => {
    const target = editing('t', 0);
    expect(events(target, () => expect(key(target, 'ArrowLeft')).toEqual(consumed))).toEqual([]);
    expect(events(target, () => expect(key(target, 'Home', ctrl)).toEqual(consumed))).toEqual([]);
  });

  it('Mod+A selects all text, by code on a non-Latin layout, not the page nodes', () => {
    const target = editing('t', 2);
    const before = untouched(target);
    expect(key(target, 'a', ctrl, { code: 'KeyA' })).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 5));
    target.execute({ type: 'setTextSelection', anchor: 1, focus: 1 });
    expect(key(target, 'ㅁ', ctrl, { code: 'KeyA' })).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 5));
    expect(untouched(target)).toEqual(before);
  });

  it('Backspace and Delete edit the text and never delete the node', () => {
    const target = editing('t', 2);
    key(target, 'Backspace');
    key(target, 'Delete');
    expect(target.query({ type: 'node', id: 't' })).not.toBeNull();
    expect(textOf(target, 't')).toBe('acd');
    expect(target.getSnapshot().selection).toEqual(['t']);
  });

  it('Mod+Z undoes, Mod+Shift+Z and Mod+Y redo, also by code', () => {
    const target = editing('t', 2);
    type(target, 'x');
    expect(key(target, 'z', ctrl, { code: 'KeyZ' })).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab cd');
    expect(key(target, 'Z', { ...ctrl, shift: true }, { code: 'KeyZ' })).toEqual(consumed);
    expect(textOf(target, 't')).toBe('abx cd');
    expect(key(target, 'ㅋ', ctrl, { code: 'KeyZ' })).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab cd');
    expect(key(target, 'y', ctrl, { code: 'KeyY' })).toEqual(consumed);
    expect(textOf(target, 't')).toBe('abx cd');
    // Nothing to redo: the code, still consumed.
    expect(key(target, 'y', ctrl, { code: 'KeyY' })).toEqual({
      ok: false,
      code: 'editor.nothing-to-redo',
      consumed: true,
    });
    // Mod+Shift+Y is no redo.
    expect(key(target, 'Y', { ...ctrl, shift: true }, { code: 'KeyY' })).toEqual(unconsumed);
  });

  it('Escape exits with the node selected; Shift+Escape is not rule 4', () => {
    const target = editing('t', 2);
    expect(key(target, 'Escape', shift)).toEqual(unconsumed);
    expect(target.getSnapshot().textEdit).not.toBeNull();
    expect(events(target, () => expect(key(target, 'Escape')).toEqual(consumed))).toEqual([
      'textEdit',
    ]);
    expect(target.getSnapshot()).toMatchObject({ textEdit: null, selection: ['t'] });
  });
});

describe('M6b-A07 key routing rules 5 and 6', () => {
  it('Tab and Shift+Tab are consumed no-ops', () => {
    const target = editing('t', 2);
    const before = target.getSnapshot();
    expect(key(target, 'Tab')).toEqual(consumed);
    expect(key(target, 'Tab', shift)).toEqual(consumed);
    expect(target.getSnapshot()).toBe(before);
  });

  it('a bound chord is a consumed no-op: Mod+D, Mod+G, Mod+], a host binding', () => {
    const target = editing('t', 2);
    target.execute({ type: 'setKeymap', bindings: [{ chord: 'Mod+K', action: 'group' }] });
    const before = target.getSnapshot();
    const chords: [string, Modifiers, string][] = [
      ['d', ctrl, 'KeyD'],
      ['g', ctrl, 'KeyG'],
      ['G', { ...ctrl, shift: true }, 'KeyG'],
      [']', ctrl, 'BracketRight'],
      ['k', ctrl, 'KeyK'],
    ];
    for (const [value, modifiers, code] of chords) {
      expect(key(target, value, modifiers, { code })).toEqual(consumed);
    }
    expect(target.getSnapshot()).toBe(before);
  });

  const clipboardKeys: [string, string][] = [
    ['c', 'KeyC'],
    ['x', 'KeyX'],
    ['v', 'KeyV'],
  ];

  it('Mod+C, X and V are not prevented, unbound or bound to the clipboard actions', () => {
    const target = editing('t', 1, 3);
    for (const [value, code] of clipboardKeys) {
      expect(key(target, value, ctrl, { code })).toEqual(unconsumed);
    }
    target.execute({
      type: 'setKeymap',
      bindings: [
        { chord: 'Mod+C', action: 'copy' },
        { chord: 'Mod+X', action: 'cut' },
        { chord: 'Mod+V', action: 'paste' },
      ],
    });
    const before = target.getSnapshot();
    for (const [value, code] of clipboardKeys) {
      expect(key(target, value, ctrl, { code })).toEqual(unconsumed);
    }
    expect(target.getSnapshot()).toBe(before);
  });

  it('an unbound key is consumed: false, never passThrough', () => {
    const target = editing();
    expect(key(target, 'F2', none, { code: 'F2' })).toEqual(unconsumed);
    expect(key(target, 'k', ctrl, { code: 'KeyK' })).toEqual(unconsumed);
    expect(key(target, 'Enter', ctrl)).toEqual(unconsumed);
    expect(key(target, 'Tab', ctrl)).toEqual(unconsumed);
  });
});

describe('M6b-A07 keyup and Space in edit mode', () => {
  it('a keyup is never consumed', () => {
    const target = editing();
    for (const value of ['a', 'Backspace', 'Escape', 'Control', 'Process']) {
      expect(input(target, { kind: 'keyup', key: value, modifiers: none })).toEqual(unconsumed);
    }
  });

  it('a keydown repeat of a Space held before edit mode is consumed, not typed', () => {
    const target = editor();
    key(target, ' ', none, { code: 'Space' });
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 2 });
    const before = target.getSnapshot();
    expect(key(target, ' ', none, { code: 'Space' })).toEqual(consumed);
    expect(
      input(target, { kind: 'keydown', key: ' ', code: 'Space', repeat: true, modifiers: none }),
    ).toEqual(consumed);
    expect(target.getSnapshot()).toBe(before);
    input(target, { kind: 'keyup', key: ' ', code: 'Space', modifiers: none });
    // Released: the next Space is a character again.
    expect(key(target, ' ', none, { code: 'Space' })).toEqual(passThrough);
  });

  it('a Space held before edit mode still releases the pan on keyup', () => {
    const target = editor();
    expect(key(target, ' ', none, { code: 'Space' })).toEqual(consumed);
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 2 });
    expect(input(target, { kind: 'keyup', key: ' ', code: 'Space', modifiers: none })).toEqual(
      consumed,
    );
    // Released: a press inside the box places the caret instead of panning.
    const viewport = target.getSnapshot().viewport;
    input(target, { kind: 'pointerdown', point: { x: 25, y: 25 }, modifiers: none });
    input(target, { kind: 'pointermove', point: { x: 60, y: 60 }, modifiers: none });
    input(target, { kind: 'pointerup', point: { x: 60, y: 60 }, modifiers: none });
    expect(target.getSnapshot().viewport).toBe(viewport);
    expect(input(target, { kind: 'keyup', key: ' ', code: 'Space', modifiers: none })).toEqual(
      unconsumed,
    );
  });
});

describe('M6b-A07 nothing reaches navigation, the tool or the keymap (M6-A08)', () => {
  it('a run of keys leaves the tool, the node, the viewport and the selection alone', () => {
    const target = editing('t', 2);
    const node = target.query({ type: 'node', id: 't' })!;
    const { tool, viewport, selection } = target.getSnapshot();
    const keys: [string, Modifiers, { code?: string; ime?: boolean }][] = [
      ['Process', none, { code: 'KeyR', ime: true }],
      [' ', none, { code: 'Space' }],
      ['r', none, { code: 'KeyR' }],
      ['f', none, { code: 'KeyF' }],
      ['ArrowRight', none, {}],
      ['ArrowRight', shift, {}],
      ['ArrowDown', none, {}],
      ['Backspace', none, {}],
      ['Delete', none, {}],
      ['=', none, { code: 'Equal' }],
    ];
    for (const [value, modifiers, extra] of keys) key(target, value, modifiers, extra);
    const after = target.getSnapshot();
    expect(after.tool).toBe(tool);
    expect(after.viewport).toBe(viewport);
    expect(after.selection).toEqual(selection);
    // Not moved (no nudge); only its auto width follows the text.
    expect(target.query({ type: 'node', id: 't' })!.frame).toMatchObject({
      x: node.frame.x,
      y: node.frame.y,
    });
    expect(textOf(target, 't')).toBe('ab c');
  });

  it('outside edit mode the same keys keep their M2 meaning', () => {
    const target = editor();
    target.execute({ type: 'setSelection', ids: ['t'] });
    expect(key(target, 'ArrowRight')).toEqual(consumed);
    expect(target.query({ type: 'node', id: 't' })!.frame.x).toBe(11);
    expect(key(target, 'r', none, { code: 'KeyR' })).toEqual(consumed);
    expect(target.getSnapshot().tool).toBe('rectangle');
    // `ime` is read in edit mode only.
    expect(key(target, 'v', none, { code: 'KeyV', ime: true })).toEqual(consumed);
    expect(target.getSnapshot().tool).toBe('select');
  });
});

describe('the clipboard commands in edit mode (interim until M6b-U8)', () => {
  it('copy, cut and paste return no IDs and change nothing', () => {
    const target = editor();
    target.execute({ type: 'setSelection', ids: ['r'] });
    // An earlier copy outside edit mode fills the in-memory clipboard.
    expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: ['r'] });
    const clipboard = target.query({ type: 'clipboard' });
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 1, focus: 3 });
    const before = target.getSnapshot();
    const commands: Command[] = [
      { type: 'copy' },
      { type: 'cut' },
      { type: 'copy', ids: ['t'] },
      { type: 'cut', ids: ['r'] },
      { type: 'paste' },
      { type: 'paste', text: 'xyz' },
    ];
    for (const command of commands) {
      expect(target.execute(command)).toEqual({ ok: true, ids: [] });
    }
    const after = target.getSnapshot();
    expect(after).toBe(before);
    expect(after.textEdit).toEqual(caret('t', 1, 3));
    expect(after.history).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.query({ type: 'node', id: 'r' })).not.toBeNull();
    expect(target.query({ type: 'clipboard' })).toEqual(clipboard);
  });
});

describe('M6b-S3 goal x', () => {
  // "abcd" LF "ab" LF "abcd": caret x 15 at offset 3; line 1 ends at 7 (x 10).
  it('Up and Down keep the goal x across a shorter line', () => {
    const target = editing('m', 3);
    key(target, 'ArrowDown');
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 7));
    key(target, 'ArrowDown');
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 11));
    key(target, 'ArrowUp');
    key(target, 'ArrowUp');
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 3));
    // Shift+Down extends and keeps it too.
    key(target, 'ArrowDown', shift);
    key(target, 'ArrowDown', shift);
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 3, 11));
  });

  it('a horizontal move clears it', () => {
    const target = editing('m', 3);
    key(target, 'ArrowDown');
    key(target, 'ArrowLeft');
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 6));
    key(target, 'ArrowDown');
    // From x 5, not the old goal x 15.
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 9));
  });

  it('an edit clears it, even one that leaves the caret offset in place', () => {
    const target = editing('m', 3);
    key(target, 'ArrowDown');
    key(target, 'Backspace');
    expect(textOf(target, 'm')).toBe('abcd\na\nabcd');
    key(target, 'ArrowDown');
    // From x 5 of offset 6, not 15.
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 8));
    const forward = editing('m', 3);
    key(forward, 'ArrowDown');
    key(forward, 'ArrowLeft');
    key(forward, 'ArrowDown');
    key(forward, 'ArrowUp');
    // Goal x 5 now; a Delete at 6 keeps the offset and clears the goal x.
    key(forward, 'Delete');
    expect(textOf(forward, 'm')).toBe('abcd\na\nabcd');
    expect(forward.getSnapshot().textEdit).toEqual(caret('m', 6));
  });

  it('setTextSelection, Mod+A and the host clear it', () => {
    const target = editing('m', 3);
    key(target, 'ArrowDown');
    target.execute({ type: 'setTextSelection', anchor: 7, focus: 7 });
    key(target, 'ArrowDown');
    // From x 10 of offset 7.
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 10));
    key(target, 'ArrowUp');
    key(target, 'a', ctrl, { code: 'KeyA' });
    key(target, 'ArrowDown');
    // Collapsed to the end, then below the last line: the length.
    expect(target.getSnapshot().textEdit).toEqual(caret('m', 12));
    const reentered = editing('m', 3);
    key(reentered, 'ArrowDown');
    reentered.execute({ type: 'enterTextEdit', id: 'm', anchor: 7 });
    key(reentered, 'ArrowDown');
    expect(reentered.getSnapshot().textEdit).toEqual(caret('m', 10));
  });
});

describe('textKeyRoute and normalizeInputText', () => {
  const route = (
    value: string,
    modifiers = none,
    platform: Platform = 'other',
    extra: { code?: string; composing?: boolean; ime?: boolean } = {},
  ) =>
    textKeyRoute({ kind: 'keydown', key: value, modifiers, ...extra }, platform, (chord) =>
      chord === 'Ctrl+KeyD' ? 'duplicate' : chord === 'Ctrl+KeyC' ? 'copy' : undefined,
    );

  it('names the rule of each route', () => {
    expect(route('Process')).toEqual({ type: 'passThrough', rule: 1 });
    expect(route('a', none, 'other', { composing: true })).toEqual({
      type: 'passThrough',
      rule: 1,
    });
    expect(route('a')).toEqual({ type: 'passThrough', rule: 2 });
    expect(route('\u{1F468}‍\u{1F469}')).toEqual({ type: 'passThrough', rule: 2 });
    expect(route('ab')).toEqual({ type: 'ignore' });
    expect(route('Enter')).toEqual({ type: 'edit', action: { type: 'lineBreak' } });
    expect(route('Backspace', ctrl)).toEqual({
      type: 'edit',
      action: { type: 'delete', movement: 'previousWordStart' },
    });
    expect(route('ArrowUp')).toEqual({
      type: 'caret',
      action: { type: 'move', movement: 'up', extend: false },
    });
    expect(route('Escape')).toEqual({ type: 'exit' });
    expect(route('z', ctrl)).toEqual({ type: 'undo' });
    expect(route('z', meta, 'mac')).toEqual({ type: 'undo' });
    expect(route('z', meta)).toEqual({ type: 'ignore' });
    expect(route('Tab', shift)).toEqual({ type: 'consume', rule: 5 });
    expect(route('d', ctrl)).toEqual({ type: 'consume', rule: 6 });
    expect(route('c', ctrl)).toEqual({ type: 'ignore' });
  });

  it('normalizes line ends, tabs and rejected characters', () => {
    expect(normalizeInputText('a\r\n\r\nb')).toBe('a\n\nb');
    expect(normalizeInputText('\n\r')).toBe('\n\n');
    expect(normalizeInputText('\t\t')).toBe('  ');
    expect(normalizeInputText('\uDC00a\uD800')).toBe('a');
    expect(normalizeInputText('\u{1F600}')).toBe('\u{1F600}');
    expect(normalizeInputText('한글')).toBe('한글');
  });

  it('every code unit and every surrogate pair normalizes to text the model accepts', () => {
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const character = String.fromCharCode(unit);
      const normalized = normalizeInputText(`a${character}b`);
      expect(isValidRunText(normalized)).toBe(true);
      // Exactly the rejected units go, except those mapped to LF or a space.
      if (isValidRunText(character)) expect(normalized).toBe(`a${character}b`);
    }
    for (let high = 0xd800; high <= 0xdbff; high += 1) {
      for (const low of [0xdc00, 0xde00, 0xdfff]) {
        const pair = String.fromCharCode(high, low);
        expect(normalizeInputText(pair)).toBe(pair);
      }
    }
  });
});
