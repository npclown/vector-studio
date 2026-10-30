import {
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
  type PagePoint,
  type TextEditState,
} from '../../packages/editor-core/src/index.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// MVP M6b-U8, M6b-A11 (docs/plans/mvp-m6b-text-editing-contract.md, section 9; M6-A09): paste,
// copy and cut in text edit mode (9.2) and plain-text paste outside it (9.3), the in-memory
// clipboard without text (9.4), the normalization of 9.1, the forced end of a composition by
// each of the three commands (7.3), the merge breaks and caret entries of their steps (8.1,
// 8.2) with undo and redo, the length bound, the `pointer` placement and every code. Layouts
// come from the fake port: `a` to `z` advance 0.5 em, a space 0.25 em, Hangul 1 em, lines
// 1.2 em.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black: Color = { r: 0, g: 0, b: 0, a: 1 };
const red: Color = { r: 1, g: 0, b: 0, a: 1 };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });

type Loose = Record<string, unknown> & { id: string };

function run(text: string, size = 10, color = black): TextRun {
  return { text, family: 'Test', size, color };
}

function base(id: string, frame: Frame, parent = 'p1'): Loose {
  return {
    id,
    name: id,
    parent,
    frame,
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
  };
}

function text(id: string, frame: Frame, runs: TextRun[], parent = 'p1'): Loose {
  return {
    ...base(id, frame, parent),
    type: 'text',
    runs,
    sizing: 'autoWidth',
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1.2,
  };
}

/**
 * Page `p1`: `t` "ab cd" at (10, 20), `m` "ab" (size 10) + "cd" (size 20, red) at (10, 100), a
 * rectangle `r`, and a frame `fr` at (300, 300) holding the text `ft` "hi" and a rectangle `fr2`.
 */
function fixture(): DocumentV6 {
  const nodes: Loose[] = [
    text('t', f(10, 20, 22.5, 12), [run('ab cd')]),
    text('m', f(10, 100, 30, 24), [run('ab'), run('cd', 20, red)]),
    {
      ...base('r', f(400, 400, 10, 10)),
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: black,
      stroke: null,
    },
    {
      ...base('fr', f(300, 300, 200, 200)),
      type: 'frame',
      children: ['fr2', 'ft'],
      fill: black,
      stroke: null,
    },
    {
      ...base('fr2', f(10, 10, 10, 10), 'fr'),
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: black,
      stroke: null,
    },
    text('ft', f(20, 20, 10, 12), [run('hi')], 'fr'),
  ];
  return {
    schemaVersion: 6,
    id: 'doc',
    pages: [{ id: 'p1', name: 'Page 1', children: ['t', 'm', 'r', 'fr'] }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  } as unknown as DocumentV6;
}

function editor(
  options: { port?: boolean; viewport?: boolean; document?: DocumentV6 } = {},
): Editor {
  const target = createEditor({
    document: options.document ?? fixture(),
    ids: createCounterIdSource('n'),
    ...(options.port === false ? {} : { textLayout: createFakeTextLayout() }),
  });
  if (options.viewport !== false) {
    target.execute({ type: 'setViewportSize', width: 600, height: 400 });
  }
  return target;
}

function editing(id: string, anchor: number, focus = anchor, target = editor()): Editor {
  expect(target.execute({ type: 'enterTextEdit', id, anchor, focus })).toEqual({
    ok: true,
    ids: [],
  });
  return target;
}

const input = (target: Editor, event: unknown) =>
  target.execute({ type: 'input', event } as Command);
const type = (target: Editor, value: string) => input(target, { kind: 'textinput', text: value });
const consumed: CommandResult = { ok: true, ids: [], consumed: true };

function caret(id: string, anchor: number, focus = anchor): TextEditState {
  return { id, pending: null, anchor, focus, affinity: 'downstream', composition: null };
}

function textOf(target: Editor, id: string): string {
  const node = target.query({ type: 'node', id });
  if (node?.type !== 'text') throw new Error(`not a text node: ${id}`);
  return node.runs.map((r) => r.text).join('');
}

const depth = (target: Editor) => target.getSnapshot().history;
const clipboard = (target: Editor) => target.query({ type: 'clipboard' });
/** The carried-source link set of M7 rule (1), private session state. */
const links = (target: Editor) =>
  (target as unknown as { clipboardLinks: ReadonlySet<string> }).clipboardLinks;

/** The events `action` raises: session fields and `document:<cause>`. */
function events(target: Editor, action: () => void): string[] {
  const seen: string[] = [];
  const stop = target.subscribe((event) => {
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

/** Starts a composition and updates it to `data`, still composing. */
function compose(target: Editor, data: string) {
  expect(input(target, { kind: 'compositionstart' })).toEqual(consumed);
  expect(input(target, { kind: 'compositionupdate', data })).toEqual(consumed);
}

describe('M6b-A11 copy and cut in edit mode (section 9.2)', () => {
  it('copy of a selection sets the in-memory clipboard to its plain text and returns [id]', () => {
    const target = editing('t', 1, 4);
    const before = target.query({ type: 'document' });
    expect(
      events(target, () => {
        expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: ['t'] });
      }),
    ).toEqual([]);
    expect(clipboard(target)).toBe('b c');
    expect(target.query({ type: 'document' })).toBe(before);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 4));
    expect(depth(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
    // A backward selection copies the same range.
    target.execute({ type: 'setTextSelection', anchor: 5, focus: 3 });
    expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: ['t'] });
    expect(clipboard(target)).toBe('cd');
  });

  it('copy and cut with a collapsed caret do nothing and return no IDs', () => {
    const target = editor();
    target.execute({ type: 'setSelection', ids: ['r'] });
    expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: ['r'] });
    const fragment = clipboard(target);
    editing('t', 2, 2, target);
    const snapshot = target.getSnapshot();
    expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: [] });
    expect(target.execute({ type: 'cut' })).toEqual({ ok: true, ids: [] });
    expect(target.getSnapshot()).toBe(snapshot);
    expect(clipboard(target)).toBe(fragment);
  });

  it('copy and cut in edit mode do not read ids', () => {
    const target = editing('t', 0, 2);
    expect(target.execute({ type: 'copy', ids: ['r'] })).toEqual({ ok: true, ids: ['t'] });
    expect(clipboard(target)).toBe('ab');
    expect(target.execute({ type: 'cut', ids: ['r'] })).toEqual({ ok: true, ids: ['t'] });
    expect(target.query({ type: 'node', id: 'r' })).not.toBeNull();
    expect(textOf(target, 't')).toBe(' cd');
    // Not even a malformed `ids` is checked.
    target.execute({ type: 'setTextSelection', anchor: 0, focus: 1 });
    expect(target.execute({ type: 'copy', ids: null } as unknown as Command)).toEqual({
      ok: true,
      ids: ['t'],
    });
  });

  it('cut deletes the selection as one step with its caret entry; undo and redo restore it', () => {
    const target = editing('t', 1, 4);
    expect(
      events(target, () => {
        expect(target.execute({ type: 'cut' })).toEqual({ ok: true, ids: ['t'] });
      }),
    ).toEqual(['document:command', 'textEdit']);
    expect(textOf(target, 't')).toBe('ad');
    expect(clipboard(target)).toBe('b c');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1));
    expect(depth(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 4));
    target.execute({ type: 'redo' });
    expect(textOf(target, 't')).toBe('ad');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1));
    // The clipboard is session state: undo and redo leave it.
    expect(clipboard(target)).toBe('b c');
  });

  it('copy and cut clear the carried-source link set (M7 rule (1))', () => {
    // The default ID source: with a host one, rule (1) links nothing anyway.
    const target = createEditor({ document: fixture(), textLayout: createFakeTextLayout() });
    expect(target.execute({ type: 'createSymbol', ids: ['fr'] })).toEqual({
      ok: true,
      ids: ['fr'],
    });
    const instance = target.execute({ type: 'createInstance', symbol: 'fr' });
    if (!instance.ok) throw new Error(instance.code);
    const id = instance.ids[0]!;
    expect(target.execute({ type: 'copy', ids: [id] })).toEqual({ ok: true, ids: [id] });
    expect([...links(target)]).toEqual(['fr']);
    editing('t', 0, 1, target);
    target.execute({ type: 'copy' });
    expect([...links(target)]).toEqual([]);
    expect(clipboard(target)).toBe('a');
    target.execute({ type: 'exitTextEdit' });
    target.execute({ type: 'copy', ids: [id] });
    expect([...links(target)]).toEqual(['fr']);
    editing('t', 0, 1, target);
    target.execute({ type: 'cut' });
    expect([...links(target)]).toEqual([]);
  });

  it('on a pending node copy and cut return no IDs', () => {
    const target = editor();
    target.execute({ type: 'setTool', tool: 'text' });
    input(target, { kind: 'pointerdown', point: at(50, 300), button: 0, modifiers: none });
    input(target, { kind: 'pointerup', point: at(50, 300), modifiers: none });
    expect(target.getSnapshot().textEdit?.pending).not.toBeNull();
    expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: [] });
    expect(target.execute({ type: 'cut' })).toEqual({ ok: true, ids: [] });
    expect(clipboard(target)).toBeNull();
  });
});

const none = { shift: false, alt: false, meta: false, ctrl: false };

describe('M6b-A11 paste in edit mode (sections 9.1, 9.2 and 9.4)', () => {
  it('unmarked text replaces the selection, normalized, as one step returning [id]', () => {
    const target = editing('t', 1, 4);
    expect(
      events(target, () => {
        expect(target.execute({ type: 'paste', text: 'X\r\nY\tZ\u0007' })).toEqual({
          ok: true,
          ids: ['t'],
        });
      }),
    ).toEqual(['document:command', 'textEdit']);
    expect(textOf(target, 't')).toBe('aX\nY Zd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
    expect(depth(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    // The selection is kept as `[t]`; edit mode stays.
    expect(target.getSnapshot().selection).toEqual(['t']);
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 4));
    target.execute({ type: 'redo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
  });

  it('every 9.1 rule: CRLF, CR, U+0085, U+2028, U+2029, tab, controls and lone surrogates', () => {
    const target = editing('t', 0);
    target.execute({
      type: 'paste',
      text: 'a\r\nb\rc\u0085d e f\tg\u0000\u001f\u0090‮⁦\ud800h😀',
    });
    expect(textOf(target, 't')).toBe('a\nb\nc\nd\ne\nf gh😀ab cd');
  });

  it('pastes in the style of the character before the selection start', () => {
    const target = editing('m', 2, 4);
    target.execute({ type: 'paste', text: 'xy' });
    const node = target.query({ type: 'node', id: 'm' });
    expect(node?.type === 'text' ? node.runs : null).toEqual([run('abxy')]);
    // At offset 0 the first character's style (M6a `styleBefore`).
    const other = editing('m', 2, 2);
    other.execute({ type: 'setTextSelection', anchor: 3, focus: 3 });
    other.execute({ type: 'paste', text: 'z' });
    const after = other.query({ type: 'node', id: 'm' });
    expect(after?.type === 'text' ? after.runs : null).toEqual([run('ab'), run('czd', 20, red)]);
  });

  it('a paste is its own step and breaks the merge before and after it (8.2)', () => {
    const target = editing('t', 5);
    type(target, 'x');
    type(target, 'y');
    expect(depth(target).undoDepth).toBe(1);
    target.execute({ type: 'paste', text: 'P' });
    expect(depth(target).undoDepth).toBe(2);
    type(target, 'z');
    type(target, 'w');
    expect(depth(target).undoDepth).toBe(3);
    expect(textOf(target, 't')).toBe('ab cdxyPzw');
    // Undo goes back step by step, each restoring its caret.
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cdxyP');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 8));
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cdxy');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 7));
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
  });

  it('two pastes in a row are two steps', () => {
    const target = editing('t', 5);
    target.execute({ type: 'paste', text: 'x' });
    target.execute({ type: 'paste', text: 'y' });
    expect(depth(target).undoDepth).toBe(2);
  });

  it('a cut is its own step and breaks the merge', () => {
    const target = editing('t', 5);
    type(target, 'x');
    input(target, { kind: 'keydown', key: 'Backspace', modifiers: none });
    input(target, { kind: 'keydown', key: 'Backspace', modifiers: none });
    expect(depth(target).undoDepth).toBe(2);
    target.execute({ type: 'setTextSelection', anchor: 0, focus: 1 });
    target.execute({ type: 'cut' });
    expect(depth(target).undoDepth).toBe(3);
    type(target, 'q');
    type(target, 'r');
    expect(depth(target).undoDepth).toBe(4);
    expect(textOf(target, 't')).toBe('qrb c');
    // A Backspace after a cut does not merge into it either.
    const other = editing('t', 1, 3);
    other.execute({ type: 'cut' });
    input(other, { kind: 'keydown', key: 'Backspace', modifiers: none });
    expect(depth(other).undoDepth).toBe(2);
  });

  it('copy does not break the merge', () => {
    const target = editing('t', 5);
    type(target, 'x');
    target.execute({ type: 'copy' });
    type(target, 'y');
    expect(depth(target).undoDepth).toBe(1);
  });

  it('paste {} inserts the plain text of an edit-mode copy (9.4)', () => {
    const target = editing('t', 0, 2);
    target.execute({ type: 'copy' });
    target.execute({ type: 'setTextSelection', anchor: 5, focus: 5 });
    expect(target.execute({ type: 'paste' })).toEqual({ ok: true, ids: ['t'] });
    expect(textOf(target, 't')).toBe('ab cdab');
  });

  it('a fragment pastes the texts of its text nodes in paint order joined by LF (M6b-Q8 (a))', () => {
    const target = editor();
    // `ft` inside `fr`, then `t`, by paint order: `t` is below `fr` on the page.
    target.execute({ type: 'copy', ids: ['fr', 't', 'r'] });
    editing('m', 4, 4, target);
    expect(target.execute({ type: 'paste' })).toEqual({ ok: true, ids: ['m'] });
    expect(textOf(target, 'm')).toBe('abcdab cd\nhi');
    // The same text as `text`.
    const fragment = target.query({ type: 'clipboard' })!;
    const other = editing('t', 0);
    other.execute({ type: 'paste', text: fragment });
    expect(textOf(other, 't')).toBe('ab cd\nhiab cd');
  });

  it('a fragment with no text node is editor.unsupported-clipboard; an invalid one keeps its code', () => {
    const target = editor();
    target.execute({ type: 'copy', ids: ['r'] });
    editing('t', 0, 2, target);
    const snapshot = target.getSnapshot();
    expect(target.execute({ type: 'paste' })).toEqual({
      ok: false,
      code: 'editor.unsupported-clipboard',
    });
    expect(target.execute({ type: 'paste', text: 'vector-studio/fragment' })).toEqual({
      ok: false,
      code: 'editor.invalid-clipboard',
      path: '',
    });
    expect(target.execute({ type: 'paste', text: 'vector-studio/fragment\n{' })).toMatchObject({
      ok: false,
      code: 'document.malformed-json',
    });
    expect(target.getSnapshot()).toBe(snapshot);
  });

  it('codes: field checks, an empty clipboard, empty text after normalization', () => {
    const target = editing('t', 1, 3);
    const snapshot = target.getSnapshot();
    const cases: [Command, CommandResult][] = [
      [
        { type: 'paste', text: 5 } as unknown as Command,
        { ok: false, code: 'editor.invalid-command', path: '/text' },
      ],
      [
        { type: 'paste', text: 'x', at: at(Number.NaN, 0) },
        { ok: false, code: 'editor.invalid-command', path: '/at' },
      ],
      [
        { type: 'paste', text: 'x', pointer: { x: 0 } } as unknown as Command,
        { ok: false, code: 'editor.invalid-command', path: '/pointer' },
      ],
      [{ type: 'paste' }, { ok: false, code: 'editor.empty-clipboard' }],
      [
        { type: 'paste', text: '' },
        { ok: false, code: 'editor.unsupported-clipboard' },
      ],
      [
        { type: 'paste', text: '\u0000‮\ud800' },
        { ok: false, code: 'editor.unsupported-clipboard' },
      ],
    ];
    for (const [command, result] of cases) expect(target.execute(command)).toEqual(result);
    expect(target.getSnapshot()).toBe(snapshot);
    // `at` and `pointer` are not used in edit mode.
    expect(target.execute({ type: 'paste', text: 'Q', at: at(0, 0), pointer: at(9, 9) })).toEqual({
      ok: true,
      ids: ['t'],
    });
    expect(textOf(target, 't')).toBe('aQcd');
  });

  it('a paste over MAX_TEXT_LENGTH fails at the setText path and changes nothing', () => {
    const target = editing('t', 1, 2);
    // "ab cd" less one selected unit plus `long` is MAX_TEXT_LENGTH.
    const long = 'x'.repeat(MAX_TEXT_LENGTH - 4);
    const snapshot = target.getSnapshot();
    // The same failure `setText` reports for the same edit.
    const reference = editor().execute({
      type: 'setText',
      id: 't',
      start: 1,
      end: 2,
      text: `${long}y`,
    });
    expect(reference.ok).toBe(false);
    expect(target.execute({ type: 'paste', text: `${long}y` })).toEqual(reference);
    expect(target.getSnapshot()).toBe(snapshot);
    // At the bound exactly it succeeds.
    expect(target.execute({ type: 'paste', text: long })).toEqual({ ok: true, ids: ['t'] });
    expect(textOf(target, 't').length).toBe(MAX_TEXT_LENGTH);
  });

  it('on a pending node a paste creates the node in one step of its own', () => {
    const target = editor();
    target.execute({ type: 'setTextToolStyle', style: { family: 'Test', size: 10, color: red } });
    target.execute({ type: 'setTool', tool: 'text' });
    input(target, { kind: 'pointerdown', point: at(50, 300), button: 0, modifiers: none });
    input(target, { kind: 'pointerup', point: at(50, 300), modifiers: none });
    expect(target.execute({ type: 'paste', text: 'hi\r\n' })).toEqual({ ok: true, ids: ['n1'] });
    expect(textOf(target, 'n1')).toBe('hi\n');
    expect(target.getSnapshot().textEdit).toEqual(caret('n1', 3));
    expect(target.getSnapshot().selection).toEqual(['n1']);
    type(target, 'a');
    expect(depth(target).undoDepth).toBe(2);
    target.execute({ type: 'undo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('n1', 3));
    target.execute({ type: 'undo' });
    expect(target.query({ type: 'node', id: 'n1' })).toBeNull();
    expect(target.getSnapshot().textEdit).toBeNull();
  });

  it('a paste over the bound on a pending node fails and keeps the pending node', () => {
    const target = editor();
    target.execute({ type: 'setTool', tool: 'text' });
    input(target, { kind: 'pointerdown', point: at(50, 300), button: 0, modifiers: none });
    input(target, { kind: 'pointerup', point: at(50, 300), modifiers: none });
    const snapshot = target.getSnapshot();
    const result = target.execute({ type: 'paste', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) });
    expect(result).toMatchObject({ ok: false, code: 'document.invalid-field' });
    expect(target.getSnapshot()).toBe(snapshot);
  });
});

describe('M6b-A11 the forced end of a composition (section 7.3)', () => {
  it('copy commits the composition first, then copies nothing from the collapsed caret', () => {
    const target = editing('t', 5);
    compose(target, '한');
    const seen = events(target, () => {
      expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: [] });
    });
    expect(seen).toEqual(['document:gesture-commit', 'textEdit']);
    expect(textOf(target, 't')).toBe('ab cd한');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
    expect(depth(target).undoDepth).toBe(1);
    expect(clipboard(target)).toBeNull();
  });

  it('cut commits the composition first; the caret is then collapsed, so nothing is cut', () => {
    const target = editing('t', 1, 3);
    compose(target, '가');
    expect(target.execute({ type: 'cut' })).toEqual({ ok: true, ids: [] });
    expect(textOf(target, 't')).toBe('a가cd');
    expect(depth(target).undoDepth).toBe(1);
  });

  it('paste commits the composition first and pastes after it as its own step', () => {
    const target = editing('t', 5);
    type(target, 'x');
    compose(target, '한');
    const seen = events(target, () => {
      expect(target.execute({ type: 'paste', text: 'P' })).toEqual({ ok: true, ids: ['t'] });
    });
    expect(seen).toEqual(['document:gesture-commit', 'textEdit', 'document:command', 'textEdit']);
    expect(textOf(target, 't')).toBe('ab cdx한P');
    // The commit merged into the typed `x`; the paste is a step of its own.
    expect(depth(target).undoDepth).toBe(2);
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cdx한');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 7));
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
  });

  it('a paste that then fails keeps the commit', () => {
    const target = editing('t', 5);
    compose(target, '한');
    expect(target.execute({ type: 'paste', text: '' })).toEqual({
      ok: false,
      code: 'editor.unsupported-clipboard',
    });
    expect(textOf(target, 't')).toBe('ab cd한');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
    expect(depth(target).undoDepth).toBe(1);
  });

  it('an empty composition over an empty range is cancelled, and the paste follows', () => {
    const target = editing('t', 5);
    expect(input(target, { kind: 'compositionstart' })).toEqual(consumed);
    target.execute({ type: 'paste', text: 'P' });
    expect(textOf(target, 't')).toBe('ab cdP');
    expect(depth(target).undoDepth).toBe(1);
    expect(target.getSnapshot().textEdit?.composition).toBeNull();
  });
});

describe('M6b-A11 plain-text paste outside edit mode (sections 9.3 and 9.4)', () => {
  /** The created node's page frame centre. */
  const centreOf = (target: Editor, id: string) => {
    const node = target.query({ type: 'node', id })!;
    return at(node.frame.x + node.frame.width / 2, node.frame.y + node.frame.height / 2);
  };

  it('creates an autoWidth node in the text tool style centred on pointer, selected, one step', () => {
    const target = editor();
    const style = { family: 'Test', size: 10, color: red };
    target.execute({ type: 'setTextToolStyle', style });
    const seen = events(target, () => {
      expect(
        target.execute({ type: 'paste', text: 'hello\r\nab', at: at(0, 0), pointer: at(100, 50) }),
      ).toEqual({ ok: true, ids: ['n1'] });
    });
    expect(seen).toEqual(['document:command', 'selection']);
    const node = target.query({ type: 'node', id: 'n1' });
    expect(node).toMatchObject({
      type: 'text',
      parent: 'p1',
      sizing: 'autoWidth',
      align: 'left',
      letterSpacing: 0,
      lineHeight: 1.2,
      rotation: 0,
      runs: [{ text: 'hello\nab', family: 'Test', size: 10, color: red }],
      // "hello" is 5 × 5 wide; two lines of 12.
      frame: f(87.5, 38, 25, 24),
    });
    expect(centreOf(target, 'n1')).toEqual(at(100, 50));
    expect(target.getSnapshot().selection).toEqual(['n1']);
    expect(target.getSnapshot().textEdit).toBeNull();
    expect(target.getSnapshot().document.pages[0]!.children.at(-1)).toBe('n1');
    expect(depth(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    target.execute({ type: 'undo' });
    expect(target.query({ type: 'node', id: 'n1' })).toBeNull();
  });

  it('without pointer the centre is at, else the viewport centre', () => {
    const target = editor();
    target.execute({ type: 'paste', text: 'ab', at: at(-40, 7) });
    expect(centreOf(target, 'n1')).toEqual(at(-40, 7));
    target.execute({ type: 'setViewport', camera: { position: at(100, 200), zoom: 2 } });
    target.execute({ type: 'paste', text: 'ab' });
    expect(centreOf(target, 'n2')).toEqual(at(250, 300));
  });

  it('uses the default text tool style', () => {
    const target = editor();
    target.execute({ type: 'paste', text: 'x', pointer: at(0, 0) });
    expect(target.query({ type: 'node', id: 'n1' })).toMatchObject({
      runs: [{ text: 'x', family: 'Arial', size: 16, color: black }],
    });
  });

  it('goes into the paste target: the scope, else a selected frame', () => {
    const target = editor();
    target.execute({ type: 'setSelection', ids: ['fr'] });
    target.execute({ type: 'paste', text: 'ab', pointer: at(350, 350) });
    expect(target.query({ type: 'node', id: 'n1' })).toMatchObject({ parent: 'fr' });
    // Its local frame in `fr`, which sits at (300, 300).
    const centre = centreOf(target, 'n1');
    expect(centre.x).toBeCloseTo(50, 9);
    expect(centre.y).toBeCloseTo(50, 9);
    expect(target.getSnapshot().selection).toEqual(['n1']);
    const scoped = editor();
    scoped.execute({ type: 'setScope', id: 'fr' });
    scoped.execute({ type: 'paste', text: 'ab', pointer: at(310, 320) });
    const node = scoped.query({ type: 'node', id: 'n1' })!;
    expect(node.parent).toBe('fr');
    // Arial 16 by default: "ab" is 16 wide and 19.2 high, centred on page (310, 320).
    expect(node.frame.x).toBeCloseTo(2, 9);
    expect(node.frame.y).toBeCloseTo(10.4, 9);
    expect(node.frame.width).toBeCloseTo(16, 9);
    expect(node.frame.height).toBeCloseTo(19.2, 9);
  });

  it('into a rotated frame the box centre lands at the pointer page point', () => {
    const angle = Math.PI / 6;
    const document = fixture();
    const rotated = {
      ...document,
      nodes: { ...document.nodes, fr: { ...document.nodes.fr!, rotation: angle } },
    } as DocumentV6;
    const target = editor({ document: rotated });
    target.execute({ type: 'setSelection', ids: ['fr'] });
    expect(target.execute({ type: 'paste', text: 'abc', pointer: at(380, 330) })).toEqual({
      ok: true,
      ids: ['n1'],
    });
    const node = target.query({ type: 'node', id: 'n1' })!;
    expect(node.parent).toBe('fr');
    // `fr` (300, 300, 200, 200) turns about its centre (400, 400): local to page.
    const local = centreOf(target, 'n1');
    const dx = local.x - 100;
    const dy = local.y - 100;
    const page = at(
      400 + dx * Math.cos(angle) - dy * Math.sin(angle),
      400 + dx * Math.sin(angle) + dy * Math.cos(angle),
    );
    expect(page.x).toBeCloseTo(380, 9);
    expect(page.y).toBeCloseTo(330, 9);
    // Upright on the page: its local rotation undoes the frame's, and its size is the layout's.
    expect(Math.cos(node.rotation + angle)).toBeCloseTo(1, 9);
    expect(node.frame.width).toBeCloseTo(24, 9);
    expect(node.frame.height).toBeCloseTo(19.2, 9);
  });

  it('an edit-mode copy of text that starts with the fragment marker pastes as plain text', () => {
    const marker = 'vector-studio/fragment\n{';
    const target = editor();
    target.execute({ type: 'setText', id: 't', start: 0, end: 0, text: marker });
    editing('t', 0, 0, target);
    expect(textOf(target, 't')).toBe(`${marker}ab cd`);
    target.execute({ type: 'setTextSelection', anchor: 0, focus: marker.length });
    expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: ['t'] });
    expect(clipboard(target)).toBe(marker);
    // In edit mode, `paste {}` inserts it (9.4).
    target.execute({
      type: 'setTextSelection',
      anchor: marker.length + 5,
      focus: marker.length + 5,
    });
    expect(target.execute({ type: 'paste' })).toEqual({ ok: true, ids: ['t'] });
    expect(textOf(target, 't')).toBe(`${marker}ab cd${marker}`);
    // As `text`, the same string is read as a fragment.
    expect(target.execute({ type: 'paste', text: marker })).toMatchObject({
      ok: false,
      code: 'document.malformed-json',
    });
    // A cut keeps it plain too; outside edit mode `paste {}` creates a node from it.
    target.execute({ type: 'setTextSelection', anchor: 0, focus: marker.length });
    expect(target.execute({ type: 'cut' })).toEqual({ ok: true, ids: ['t'] });
    target.execute({ type: 'exitTextEdit' });
    expect(target.execute({ type: 'paste', pointer: at(0, 0) })).toEqual({ ok: true, ids: ['n1'] });
    expect(textOf(target, 'n1')).toBe(marker);
    // A later fragment copy clears the flag: `paste {}` pastes the fragment again.
    target.execute({ type: 'copy', ids: ['r'] });
    const pasted = target.execute({ type: 'paste' });
    expect(pasted.ok && target.query({ type: 'node', id: pasted.ids[0]! })?.type).toBe('rectangle');
  });

  it('paste {} with the plain text of an edit-mode copy creates a node (9.4)', () => {
    const target = editing('t', 0, 2);
    target.execute({ type: 'copy' });
    target.execute({ type: 'exitTextEdit' });
    expect(target.execute({ type: 'paste', pointer: at(5, 5) })).toEqual({
      ok: true,
      ids: ['n1'],
    });
    expect(textOf(target, 'n1')).toBe('ab');
  });

  it('a fragment pastes as M2 and M7 say, pointer ignored', () => {
    const without = editor();
    without.execute({ type: 'copy', ids: ['r'] });
    const fragment = without.query({ type: 'clipboard' })!;
    const plain = without.execute({ type: 'paste', text: fragment });
    const target = editor();
    const result = target.execute({ type: 'paste', text: fragment, pointer: at(0, 0) });
    expect(result).toEqual(plain);
    expect(target.query({ type: 'document' })).toEqual(without.query({ type: 'document' }));
  });

  it('codes, in order, and no change on failure', () => {
    const target = editor();
    const snapshot = target.getSnapshot();
    const cases: [Command, CommandResult][] = [
      [
        { type: 'paste', text: 'x', pointer: at(1, Number.POSITIVE_INFINITY) },
        { ok: false, code: 'editor.invalid-command', path: '/pointer' },
      ],
      [{ type: 'paste' }, { ok: false, code: 'editor.empty-clipboard' }],
      [
        { type: 'paste', text: '' },
        { ok: false, code: 'editor.unsupported-clipboard' },
      ],
      [
        { type: 'paste', text: '\u0000\u2066' },
        { ok: false, code: 'editor.unsupported-clipboard' },
      ],
    ];
    for (const [command, result] of cases) expect(target.execute(command)).toEqual(result);
    // Over the bound: the `createText` failure, and no ID drawn.
    expect(target.execute({ type: 'paste', text: 'x'.repeat(MAX_TEXT_LENGTH + 1) })).toMatchObject({
      ok: false,
      code: 'document.invalid-field',
    });
    expect(target.getSnapshot()).toBe(snapshot);
    expect(target.execute({ type: 'paste', text: 'x'.repeat(MAX_TEXT_LENGTH) })).toEqual({
      ok: true,
      ids: ['n1'],
    });
    // A tab alone normalizes to a space: not empty.
    expect(target.execute({ type: 'paste', text: '\t' })).toEqual({ ok: true, ids: ['n2'] });
    expect(textOf(target, 'n2')).toBe(' ');
  });

  it('without a port editor.no-text-layout, after the empty check', () => {
    const target = editor({ port: false });
    expect(target.execute({ type: 'paste', text: '' })).toEqual({
      ok: false,
      code: 'editor.unsupported-clipboard',
    });
    expect(target.execute({ type: 'paste', text: 'x', pointer: at(0, 0) })).toEqual({
      ok: false,
      code: 'editor.no-text-layout',
    });
  });

  it('without a viewport size and no point editor.no-viewport-size', () => {
    const target = editor({ viewport: false });
    expect(target.execute({ type: 'paste', text: 'x' })).toEqual({
      ok: false,
      code: 'editor.no-viewport-size',
    });
    expect(target.execute({ type: 'paste', text: 'x', at: at(0, 0) })).toEqual({
      ok: true,
      ids: ['n1'],
    });
  });

  it('the keymap paste action outside edit mode creates the node from the in-memory text', () => {
    const target = editing('t', 0, 2);
    target.execute({ type: 'copy' });
    target.execute({ type: 'exitTextEdit' });
    target.execute({ type: 'setKeymap', bindings: [{ chord: 'Ctrl+V', action: 'paste' }] });
    target.execute({ type: 'setSelection', ids: [] });
    expect(
      input(target, {
        kind: 'keydown',
        key: 'v',
        code: 'KeyV',
        modifiers: { ...none, ctrl: true },
      }),
    ).toMatchObject({ ok: true, ids: ['n1'] });
    expect(textOf(target, 'n1')).toBe('ab');
    expect(centreOf(target, 'n1')).toEqual(at(300, 200));
  });
});
