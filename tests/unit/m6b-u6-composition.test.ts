import path from 'node:path';
import {
  MAX_TEXT_LENGTH,
  type Color,
  type DocumentV6,
  type Frame,
  type PersistenceEnvelope,
  type TextRun,
} from '@vector-studio/model';
import { createAutosave, type DocumentStore } from '@vector-studio/persistence-idb';
import { describe, expect, it } from 'vitest';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type Modifiers,
  type PagePoint,
  type TextEditState,
} from '../../packages/editor-core/src/index.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// MVP M6b-U6, M6b-A09 (docs/plans/mvp-m6b-text-editing-contract.md, sections 5.3, 7 and 8):
// the composition input kinds and the text gesture (start, update, end, a differing end, the
// empty end over an empty and a non-empty range), the forced end of section 7.3 by each path
// it lists (a host document command, undo, redo, loadDocument, pointercancel, setTool,
// setSelection, setScope, enterTextEdit, enterPathEdit, exitTextEdit, endComposition and
// setActivePage, also to the current page) and the pointer case of 7.2, plus the acting
// edit-mode keys (Escape, Mod+Z, a movement, an edit action) and a `textinput`; the inert
// `GestureControl`, `editor.gesture-active`, update and end without a gesture, an update over
// the bound; the merge of composition commits with typing (section 8.2) and the caret entries
// undo and redo restore; a pending node's first composition (appendix A case 9: commit creates,
// cancel leaves none and restores `pending`); causes, step counts, no autosave write on updates
// (M6-A07); and composition steps under the E26-A09 scoped-projection oracle (the setup check
// runs on every command). Layouts come from the fake port: `a` to `z` advance 0.5 em, a space
// 0.25 em, Hangul 1 em.

const root = path.resolve(import.meta.dirname, '../..');
const persistence = (await import(path.join(root, 'apps/next-host/src/m5-persistence.ts'))) as {
  schedulesWrite: (event: EditorEvent) => boolean;
  persistenceEnvelope: (editor: Editor) => PersistenceEnvelope;
};

const START = { horizontal: 'start', vertical: 'start' } as const;
const black: Color = { r: 0, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const ctrl: Modifiers = { ...none, ctrl: true };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });

type Loose = Record<string, unknown> & { id: string };

function run(text: string, size = 10): TextRun {
  return { text, family: 'Test', size, color: black };
}

function base(id: string, frame: Frame) {
  return {
    id,
    name: id,
    parent: 'p1',
    frame,
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
  };
}

function text(id: string, frame: Frame, runs: TextRun[]): Loose {
  return {
    ...base(id, frame),
    type: 'text',
    runs,
    sizing: 'autoWidth',
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1.2,
  };
}

/**
 * Page `p1`: `t` "ab cd" at (10, 20), `h` "안녕" at (100, 20), a rectangle `r`, an empty frame
 * `fr` at (300, 300) and a path `pa`; page `p2` is empty. `extra` nodes join `p1`.
 */
function fixture(extra: Loose[] = []): DocumentV6 {
  const nodes: Loose[] = [
    text('t', f(10, 20, 22.5, 12), [run('ab cd')]),
    text('h', f(100, 20, 20, 12), [run('안녕')]),
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
      children: [],
      fill: black,
      stroke: null,
    },
    {
      ...base('pa', f(600, 600, 10, 10)),
      type: 'path',
      path: {
        verbs: ['move', 'line', 'line', 'close'],
        points: [0, 0, 1, 0, 1, 1],
        fillRule: 'nonzero',
      },
      fill: black,
      stroke: null,
    },
    ...extra,
  ];
  return {
    schemaVersion: 6,
    id: 'doc',
    pages: [
      { id: 'p1', name: 'Page 1', children: nodes.map((node) => node.id) },
      { id: 'p2', name: 'Page 2', children: [] },
    ],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  } as unknown as DocumentV6;
}

function editor(options: { port?: null; extra?: Loose[] } = {}): Editor {
  return createEditor({
    document: fixture(options.extra),
    ids: createCounterIdSource('n'),
    ...(options.port === null ? {} : { textLayout: createFakeTextLayout() }),
  });
}

function editing(id: string, anchor: number, focus = anchor, extra: Loose[] = []): Editor {
  const target = editor({ extra });
  expect(target.execute({ type: 'enterTextEdit', id, anchor, focus })).toEqual({
    ok: true,
    ids: [],
  });
  return target;
}

const input = (target: Editor, event: unknown) =>
  target.execute({ type: 'input', event } as Command);
const type = (target: Editor, value: string) => input(target, { kind: 'textinput', text: value });
const key = (target: Editor, value: string, modifiers = none, code?: string) =>
  input(target, {
    kind: 'keydown',
    key: value,
    modifiers,
    ...(code === undefined ? {} : { code }),
  });
const start = (target: Editor) => input(target, { kind: 'compositionstart' });
const update = (target: Editor, data: string) => input(target, { kind: 'compositionupdate', data });
const end = (target: Editor, data: string) => input(target, { kind: 'compositionend', data });
/** Starts a composition and updates it to `data`, still composing. */
function compose(target: Editor, data: string) {
  expect(start(target)).toEqual(consumed);
  expect(update(target, data)).toEqual(consumed);
}

const consumed: CommandResult = { ok: true, ids: [], consumed: true };
const ok: CommandResult = { ok: true, ids: [] };

function caret(
  id: string,
  anchor: number,
  focus = anchor,
  composition: TextEditState['composition'] = null,
): TextEditState {
  return { id, pending: null, anchor, focus, affinity: 'downstream', composition };
}

function textOf(target: Editor, id: string): string {
  const node = target.query({ type: 'node', id });
  if (node?.type !== 'text') throw new Error(`not a text node: ${id}`);
  return node.runs.map((r) => r.text).join('');
}

const depth = (target: Editor) => target.getSnapshot().history;

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

describe('M6b-A09 composition kinds and the text gesture (section 7.1)', () => {
  it('start, update and a differing end: one step, causes and events', () => {
    const target = editing('t', 5);
    const before = target.getSnapshot().document;
    expect(events(target, () => expect(start(target)).toEqual(consumed))).toEqual(['textEdit']);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5, 5, { start: 5, end: 5 }));
    expect(target.getSnapshot().document).toBe(before);
    expect(events(target, () => expect(update(target, 'ㄱ')).toEqual(consumed))).toEqual([
      'document:gesture-update',
      'textEdit',
    ]);
    expect(textOf(target, 't')).toBe('ab cdㄱ');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6, 6, { start: 5, end: 6 }));
    // The committed document (M5-S3) is still the pre-gesture one; no step yet.
    expect(target.query({ type: 'committedDocument' })).toBe(before);
    expect(depth(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
    // The underline follows the composition range.
    expect(target.query({ type: 'textEditOverlay' })!.composition).toHaveLength(1);
    update(target, '가');
    expect(textOf(target, 't')).toBe('ab cd가');
    // The end replaces with its own data, which differs from the last update, then commits.
    expect(events(target, () => expect(end(target, '각')).toEqual(consumed))).toEqual([
      'document:gesture-update',
      'document:gesture-commit',
      'textEdit',
    ]);
    expect(textOf(target, 't')).toBe('ab cd각');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
    expect(depth(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(target.query({ type: 'textEditOverlay' })!.composition).toEqual([]);
    // The step carries its caret entry (section 8.1): undo and redo restore it.
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().document).toBe(before);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
    target.execute({ type: 'redo' });
    expect(textOf(target, 't')).toBe('ab cd각');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
  });

  it('a composition in the middle of the text keeps the text after it', () => {
    const target = editing('t', 2);
    compose(target, '가');
    expect(textOf(target, 't')).toBe('ab가 cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 3, 3, { start: 2, end: 3 }));
    update(target, '갈');
    expect(textOf(target, 't')).toBe('ab갈 cd');
    end(target, '갈');
    expect(textOf(target, 't')).toBe('ab갈 cd');
    expect(depth(target).undoDepth).toBe(1);
  });

  it('an empty end over an empty range cancels: no step, the document as before', () => {
    const target = editing('t', 5);
    const before = target.getSnapshot().document;
    compose(target, 'ㄱ');
    // The empty end cancels at once, with no replace of its own.
    expect(events(target, () => expect(end(target, '')).toEqual(consumed))).toEqual([
      'document:gesture-cancel',
      'textEdit',
    ]);
    expect(target.getSnapshot().document).toBe(before);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
    expect(depth(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
    // Also a start followed at once by an empty end.
    expect(start(target)).toEqual(consumed);
    expect(end(target, '')).toEqual(consumed);
    expect(target.getSnapshot().document).toBe(before);
    expect(depth(target).undoDepth).toBe(0);
  });

  it('an empty end over a non-empty range commits its deletion as its own step', () => {
    const target = editing('t', 0, 2);
    expect(start(target)).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 2, { start: 0, end: 2 }));
    expect(end(target, '')).toEqual(consumed);
    expect(textOf(target, 't')).toBe(' cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0));
    expect(depth(target).undoDepth).toBe(1);
    // A deletion of a range is its own step: the next insertion does not merge into it.
    type(target, 'x');
    expect(depth(target).undoDepth).toBe(2);
    target.execute({ type: 'undo' });
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 2));
  });

  it('a composition over a non-empty selection is a replacement that later typing merges into', () => {
    const target = editing('t', 3, 5);
    compose(target, '가');
    expect(textOf(target, 't')).toBe('ab 가');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 4, 4, { start: 3, end: 4 }));
    end(target, '가');
    type(target, 'x');
    expect(textOf(target, 't')).toBe('ab 가x');
    expect(depth(target).undoDepth).toBe(1);
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 3, 5));
  });

  it('a start and end with no update over a selection records nothing', () => {
    const target = editing('t', 0, 2);
    const before = target.getSnapshot().document;
    start(target);
    end(target, 'ab');
    expect(textOf(target, 't')).toBe('ab cd');
    // `setText` writes the same text again, which commits no step (byte-identical).
    expect(depth(target).undoDepth).toBe(0);
    expect(target.getSnapshot().document.nodes['t']).toEqual(before.nodes['t']);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2));
  });

  it('composition data is normalized as text input is (section 9.1)', () => {
    const target = editing('t', 5);
    compose(target, 'x\u0001‮y');
    expect(textOf(target, 't')).toBe('ab cdxy');
    expect(target.getSnapshot().textEdit!.composition).toEqual({ start: 5, end: 7 });
    end(target, 'x\u0001y');
    expect(textOf(target, 't')).toBe('ab cdxy');
  });

  it('a composed LF is its own step', () => {
    const target = editing('t', 5);
    type(target, 'x');
    compose(target, 'a\r\nb');
    end(target, 'a\r\nb');
    expect(textOf(target, 't')).toBe('ab cdxa\nb');
    expect(depth(target).undoDepth).toBe(2);
  });

  it('a start during a composition (a missed end) commits that one first', () => {
    const target = editing('t', 5);
    compose(target, '가');
    expect(start(target)).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6, 6, { start: 6, end: 6 }));
    update(target, '나');
    end(target, '나');
    expect(textOf(target, 't')).toBe('ab cd가나');
    // Both commits are insertions at the caret, so they merge.
    expect(depth(target).undoDepth).toBe(1);
  });

  it('a start ends a selection drag at its current caret', () => {
    const target = editing('t', 5);
    // A press inside places the caret at 0 and starts a selection drag.
    input(target, { kind: 'pointerdown', point: at(10, 26), modifiers: none });
    input(target, { kind: 'pointermove', point: at(20, 26), modifiers: none });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 2));
    expect(start(target)).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 2, { start: 0, end: 2 }));
    // The drag has ended: a move changes nothing, and the release is not a drag release.
    input(target, { kind: 'pointermove', point: at(32, 26), modifiers: none });
    input(target, { kind: 'pointerup', point: at(32, 26), modifiers: none });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 2, { start: 0, end: 2 }));
    end(target, '가');
    expect(textOf(target, 't')).toBe('가 cd');
  });
});

describe('M6b-A09 merge with typing (section 8.2)', () => {
  it('typing and composition commits merge into one insertion step', () => {
    const target = editing('h', 2);
    type(target, 'a');
    compose(target, '하');
    end(target, '한');
    compose(target, '그');
    end(target, '글');
    type(target, 'b');
    expect(textOf(target, 'h')).toBe('안녕a한글b');
    expect(depth(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    target.execute({ type: 'undo' });
    expect(textOf(target, 'h')).toBe('안녕');
    expect(target.getSnapshot().textEdit).toEqual(caret('h', 2));
    target.execute({ type: 'redo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('h', 6));
  });

  it('a final consonant moving to the next syllable: end then start merge (M6-E4)', () => {
    const target = editing('h', 2);
    compose(target, '각');
    update(target, '가');
    end(target, '가');
    compose(target, '기');
    end(target, '기');
    expect(textOf(target, 'h')).toBe('안녕가기');
    expect(depth(target).undoDepth).toBe(1);
  });

  it('breaks: a caret move, a space after a word, and a composition after a break', () => {
    const target = editing('t', 5);
    compose(target, '가');
    end(target, '가');
    // A space after a non-space starts a new step.
    type(target, ' ');
    compose(target, '나');
    end(target, '나');
    expect(depth(target).undoDepth).toBe(2);
    // A caret move breaks the merge: the next composition is a new step.
    key(target, 'ArrowLeft');
    key(target, 'ArrowRight');
    compose(target, '다');
    end(target, '다');
    expect(textOf(target, 't')).toBe('ab cd가 나다');
    expect(depth(target).undoDepth).toBe(3);
    target.execute({ type: 'undo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 8));
    target.execute({ type: 'undo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
    expect(textOf(target, 't')).toBe('ab cd가');
  });

  it('a composition that starts with a space after a word does not merge', () => {
    const target = editing('t', 5);
    type(target, 'x');
    compose(target, ' 가');
    end(target, ' 가');
    expect(depth(target).undoDepth).toBe(2);
  });

  it('a cancelled composition leaves the merge open', () => {
    const target = editing('t', 5);
    type(target, 'x');
    compose(target, 'ㄱ');
    end(target, '');
    type(target, 'y');
    expect(textOf(target, 't')).toBe('ab cdxy');
    expect(depth(target).undoDepth).toBe(1);
  });
});

describe('M6b-A09 the forced end of section 7.3, by each path', () => {
  /** `t` at 5 with "가" composing; the check sees the commit and the composition ended. */
  function composing(): Editor {
    const target = editing('t', 5);
    compose(target, '가');
    return target;
  }

  function committed(target: Editor, undoDepth = 1) {
    expect(textOf(target, 't')).toBe('ab cd가');
    expect(target.getSnapshot().textEdit?.composition ?? null).toBeNull();
    expect(depth(target).undoDepth).toBe(undoDepth);
    // The commit's step is clean: no gesture is left open.
    expect(internalsOf(target).gesture.active).toBe(false);
  }

  it('a host document command commits first, then applies to the committed document', () => {
    const target = composing();
    const seen = events(target, () =>
      expect(target.execute({ type: 'setText', id: 't', start: 0, end: 0, text: 'Z' })).toEqual(ok),
    );
    // The caret (6) still holds after the host's change, so no further `textEdit` event.
    expect(seen).toEqual(['document:gesture-commit', 'textEdit', 'document:command']);
    expect(textOf(target, 't')).toBe('Zab cd가');
    expect(depth(target).undoDepth).toBe(2);
    target.execute({ type: 'undo' });
    committed(target, 1);
  });

  it('a host document command on another node, and one that fails, keep the commit', () => {
    const target = composing();
    expect(target.execute({ type: 'deleteNodes', ids: ['r'] })).toEqual(ok);
    committed(target, 2);
    expect(target.query({ type: 'node', id: 'r' })).toBeNull();
    const again = composing();
    expect(again.execute({ type: 'deleteNodes', ids: ['nope'] }).ok).toBe(false);
    committed(again);
  });

  it('undo commits and merges first, so it undoes the whole merged word', () => {
    const target = editing('t', 5);
    type(target, 'x');
    compose(target, '가');
    expect(target.execute({ type: 'undo' })).toEqual(ok);
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
    expect(depth(target)).toEqual({ undoDepth: 0, redoDepth: 1 });
    target.execute({ type: 'redo' });
    expect(textOf(target, 't')).toBe('ab cdx가');
  });

  it('redo commits first (which clears the redo stack), then has nothing to redo', () => {
    const target = editing('t', 5);
    type(target, 'x');
    target.execute({ type: 'undo' });
    compose(target, '가');
    expect(target.execute({ type: 'redo' })).toEqual({ ok: false, code: 'editor.nothing-to-redo' });
    committed(target);
  });

  it('loadDocument commits first, then loads', () => {
    const target = composing();
    const seen = events(target, () =>
      expect(target.execute({ type: 'loadDocument', document: fixture() })).toEqual(ok),
    );
    expect(seen.slice(0, 2)).toEqual(['document:gesture-commit', 'textEdit']);
    expect(seen).toContain('document:load');
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toBeNull();
    expect(depth(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
    // A failing load leaves the commit in place.
    const again = composing();
    expect(again.execute({ type: 'loadDocument', document: 1 }).ok).toBe(false);
    committed(again);
  });

  it('pointercancel commits and keeps edit mode; it is consumed', () => {
    const target = composing();
    expect(input(target, { kind: 'pointercancel', modifiers: none })).toEqual(consumed);
    committed(target);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
  });

  it('setTool commits, then ends edit mode', () => {
    const target = composing();
    expect(target.execute({ type: 'setTool', tool: 'rectangle' })).toEqual(ok);
    committed(target);
    expect(target.getSnapshot().textEdit).toBeNull();
    // Also a setTool to the active tool.
    const again = composing();
    again.execute({ type: 'setTool', tool: 'select' });
    committed(again);
    expect(again.getSnapshot().textEdit).toEqual(caret('t', 6));
  });

  it('setSelection commits; to [id] edit mode stays, to another value it ends', () => {
    const target = composing();
    target.execute({ type: 'setSelection', ids: ['t'] });
    committed(target);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
    const again = composing();
    again.execute({ type: 'setSelection', ids: [] });
    committed(again);
    expect(again.getSnapshot().textEdit).toBeNull();
  });

  it('setScope commits, then ends edit mode', () => {
    const target = composing();
    expect(target.execute({ type: 'setScope', id: 'fr' })).toEqual(ok);
    committed(target);
    expect(target.getSnapshot().textEdit).toBeNull();
  });

  it('enterTextEdit commits, on the edited node then sets the caret, on another enters it', () => {
    const target = composing();
    expect(target.execute({ type: 'enterTextEdit', id: 't', anchor: 0, focus: 0 })).toEqual(ok);
    committed(target);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0));
    const again = composing();
    again.execute({ type: 'enterTextEdit', id: 'h' });
    committed(again);
    expect(again.getSnapshot().textEdit).toEqual(caret('h', 0, 2));
  });

  it('enterPathEdit commits, then enters path edit mode', () => {
    const target = composing();
    expect(target.execute({ type: 'enterPathEdit', id: 'pa' })).toEqual(ok);
    committed(target);
    expect(target.getSnapshot().textEdit).toBeNull();
    expect(target.getSnapshot().pathEdit).toEqual({ id: 'pa', anchors: [] });
  });

  it('exitTextEdit commits, then exits with the node selected', () => {
    const target = composing();
    const seen = events(target, () => expect(target.execute({ type: 'exitTextEdit' })).toEqual(ok));
    expect(seen).toEqual(['document:gesture-commit', 'textEdit', 'textEdit']);
    committed(target);
    expect(target.getSnapshot().textEdit).toBeNull();
    expect(target.getSnapshot().selection).toEqual(['t']);
  });

  it('endComposition commits and keeps edit mode; a no-op without a composition', () => {
    const target = composing();
    expect(target.execute({ type: 'endComposition' })).toEqual(ok);
    committed(target);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
    const snapshot = target.getSnapshot();
    expect(events(target, () => target.execute({ type: 'endComposition' }))).toEqual([]);
    expect(target.getSnapshot()).toBe(snapshot);
    // Also outside edit mode.
    const idle = editor();
    expect(idle.execute({ type: 'endComposition' })).toEqual(ok);
  });

  it('setActivePage commits, also to the current page; another page ends edit mode', () => {
    const target = composing();
    expect(target.execute({ type: 'setActivePage', id: 'p1' })).toEqual(ok);
    committed(target);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
    const again = composing();
    again.execute({ type: 'setActivePage', id: 'p2' });
    committed(again);
    expect(again.getSnapshot().textEdit).toBeNull();
    // An unknown page still commits first.
    const third = composing();
    expect(third.execute({ type: 'setActivePage', id: 'nope' }).ok).toBe(false);
    committed(third);
  });

  it('a press inside commits, then places the caret (section 7.2)', () => {
    const target = composing();
    expect(input(target, { kind: 'pointerdown', point: at(10, 26), modifiers: none })).toEqual(
      consumed,
    );
    committed(target);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0));
    input(target, { kind: 'pointerup', point: at(10, 26), modifiers: none });
  });

  it('a press outside commits, then exits and acts in the same input', () => {
    const target = composing();
    input(target, { kind: 'pointerdown', point: at(405, 405), modifiers: none });
    input(target, { kind: 'pointerup', point: at(405, 405), modifiers: none });
    committed(target);
    expect(target.getSnapshot().textEdit).toBeNull();
    // The frame `fr` paints over `r` there, so the press selects it.
    expect(target.getSnapshot().selection).toEqual(['fr']);
  });

  it('a middle-button press commits, then pans; a double-click inside commits, then selects', () => {
    const target = composing();
    expect(
      input(target, { kind: 'pointerdown', point: at(10, 26), button: 1, modifiers: none }),
    ).toEqual(consumed);
    committed(target);
    input(target, { kind: 'pointerup', point: at(10, 26), modifiers: none });
    const again = composing();
    input(again, { kind: 'doubleclick', point: at(11, 26), modifiers: none });
    committed(again);
    expect(again.getSnapshot().textEdit).toEqual(caret('t', 0, 2));
  });

  it('Escape commits, then exits (rule 4)', () => {
    const target = composing();
    expect(key(target, 'Escape')).toEqual(consumed);
    committed(target);
    expect(target.getSnapshot().textEdit).toBeNull();
    expect(target.getSnapshot().selection).toEqual(['t']);
  });

  it('Mod+Z commits and merges, then undoes (rule 4); Mod+Y redoes it', () => {
    const target = editing('t', 5);
    type(target, 'x');
    compose(target, '가');
    expect(key(target, 'z', ctrl, 'KeyZ')).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
    expect(key(target, 'y', ctrl, 'KeyY')).toEqual(consumed);
    expect(textOf(target, 't')).toBe('ab cdx가');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 7));
  });

  it('a movement key, an edit action and a textinput commit first, then act', () => {
    const target = composing();
    expect(key(target, 'ArrowLeft')).toEqual(consumed);
    committed(target);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
    const again = composing();
    expect(key(again, 'Backspace')).toEqual(consumed);
    expect(textOf(again, 't')).toBe('ab cd');
    expect(depth(again).undoDepth).toBe(2);
    const third = composing();
    expect(type(third, 'x')).toEqual(consumed);
    expect(textOf(third, 't')).toBe('ab cd가x');
    expect(depth(third).undoDepth).toBe(1);
  });

  it('a composing key is passed through and does not end the composition (rule 1)', () => {
    const target = composing();
    expect(
      input(target, { kind: 'keydown', key: 'Process', code: 'KeyR', modifiers: none }),
    ).toEqual({ ok: true, ids: [], consumed: false, passThrough: true });
    expect(target.getSnapshot().textEdit!.composition).toEqual({ start: 5, end: 6 });
    // A bound chord is a consumed no-op (rule 6) and does not end it either.
    expect(key(target, 'd', ctrl, 'KeyD')).toEqual(consumed);
    expect(target.getSnapshot().textEdit!.composition).toEqual({ start: 5, end: 6 });
  });

  it('commands that do not end edit mode or change the caret leave the composition alone', () => {
    const target = composing();
    target.execute({ type: 'setViewport', camera: { position: { x: 5, y: 5 }, zoom: 2 } });
    target.execute({ type: 'setSnapping', enabled: false });
    target.execute({
      type: 'setTextToolStyle',
      style: { family: 'Test', size: 12, color: black },
    });
    input(target, { kind: 'wheel', point: at(0, 0), deltaX: 0, deltaY: 10, modifiers: none });
    expect(target.getSnapshot().textEdit!.composition).toEqual({ start: 5, end: 6 });
    expect(depth(target).undoDepth).toBe(0);
    end(target, '가');
    committed(target);
  });

  it('a forced end of an empty composition over an empty range records nothing', () => {
    const target = editing('t', 5);
    const before = target.getSnapshot().document;
    compose(target, '');
    target.execute({ type: 'exitTextEdit' });
    expect(target.getSnapshot().document).toBe(before);
    expect(depth(target).undoDepth).toBe(0);
  });
});

describe('M6b-A09 editor.gesture-active, the inert gesture API and failures', () => {
  const refused = (code: string): CommandResult =>
    ({ ok: false, code, consumed: false }) as CommandResult;

  it('setTextSelection fails with editor.gesture-active during a composition', () => {
    const target = editing('t', 5);
    compose(target, '가');
    const snapshot = target.getSnapshot();
    expect(target.execute({ type: 'setTextSelection', anchor: 0, focus: 0 })).toEqual({
      ok: false,
      code: 'editor.gesture-active',
    });
    expect(target.getSnapshot()).toBe(snapshot);
    // The 3.1 order: a malformed affinity first.
    expect(
      target.execute({
        type: 'setTextSelection',
        anchor: 0,
        focus: 0,
        affinity: 'x',
      } as unknown as Command),
    ).toEqual({ ok: false, code: 'editor.invalid-command', path: '/affinity' });
  });

  it('the public GestureControl methods are inert while composing', () => {
    const target = editing('t', 5);
    compose(target, '가');
    const snapshot = target.getSnapshot();
    const gesture = internalsOf(target).gesture;
    expect(gesture.active).toBe(true);
    expect(gesture.begin()).toBe(false);
    expect(
      gesture.update({ type: 'setFrames', frames: [{ id: 'r', frame: f(0, 0, 1, 1) }] }),
    ).toEqual({ ok: false, code: 'editor.gesture-active' });
    expect(gesture.replace([])).toEqual({ ok: false, code: 'editor.gesture-active' });
    gesture.commit();
    gesture.cancel();
    expect(target.getSnapshot()).toBe(snapshot);
    end(target, '가');
    expect(textOf(target, 't')).toBe('ab cd가');
  });

  it('a start during another document gesture fails with editor.gesture-active', () => {
    const target = editing('t', 5);
    const gesture = internalsOf(target).gesture;
    expect(gesture.begin()).toBe(true);
    const snapshot = target.getSnapshot();
    expect(start(target)).toEqual(refused('editor.gesture-active'));
    expect(target.getSnapshot()).toBe(snapshot);
    expect(update(target, 'ㄱ')).toEqual(refused('editor.gesture-active'));
    gesture.cancel();
  });

  it('an update or end with no composition fails; outside edit mode with no-text-edit', () => {
    const target = editing('t', 5);
    const snapshot = target.getSnapshot();
    expect(update(target, 'ㄱ')).toEqual(refused('editor.gesture-active'));
    expect(end(target, '가')).toEqual(refused('editor.gesture-active'));
    expect(target.getSnapshot()).toBe(snapshot);
    const idle = editor();
    for (const event of [start, (e: Editor) => update(e, 'a'), (e: Editor) => end(e, 'a')]) {
      expect(event(idle)).toEqual(refused('editor.no-text-edit'));
    }
    const portless = editor({ port: null });
    expect(start(portless)).toEqual(refused('editor.no-text-layout'));
    expect(end(portless, 'a')).toEqual(refused('editor.no-text-layout'));
    // A malformed event is an invalid command.
    expect(input(target, { kind: 'compositionupdate' })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/event',
    });
  });

  it('an update over the bound fails and commits the last accepted state', () => {
    const long = text('long', f(0, 200, 0, 12), [run('a'.repeat(MAX_TEXT_LENGTH - 2))]);
    const target = editing('long', 0, 0, [long]);
    compose(target, '가');
    update(target, '가나');
    expect(textOf(target, 'long')).toHaveLength(MAX_TEXT_LENGTH);
    expect(update(target, '가나다')).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/long/runs',
      consumed: false,
    });
    expect(textOf(target, 'long').slice(0, 2)).toBe('가나');
    expect(target.getSnapshot().textEdit).toEqual(caret('long', 2));
    expect(depth(target).undoDepth).toBe(1);
    expect(internalsOf(target).gesture.active).toBe(false);
    // The host's late end then has no composition (M6b-H5 drops it; sent anyway it fails).
    expect(end(target, '가나다')).toEqual(refused('editor.gesture-active'));
  });

  it('an end over the bound fails and commits the last accepted update', () => {
    const long = text('long', f(0, 200, 0, 12), [run('a'.repeat(MAX_TEXT_LENGTH - 1))]);
    const target = editing('long', 0, 0, [long]);
    compose(target, '가');
    expect(end(target, '가나').ok).toBe(false);
    expect(textOf(target, 'long').slice(0, 1)).toBe('가');
    expect(depth(target).undoDepth).toBe(1);
  });
});

describe('M6b-A09 a first composition on a pending node (appendix A case 9)', () => {
  function pending(): Editor {
    const target = editor();
    target.execute({ type: 'setTool', tool: 'text' });
    input(target, { kind: 'pointerdown', point: at(50, 60), modifiers: none });
    input(target, { kind: 'pointerup', point: at(50, 60), modifiers: none });
    expect(target.getSnapshot().textEdit?.pending).not.toBeNull();
    return target;
  }

  it('the commit creates the node in one step; IDs drawn by discarded replaces are skipped', () => {
    const target = pending();
    const state = target.getSnapshot().textEdit!;
    expect(start(target)).toEqual(consumed);
    expect(target.getSnapshot().textEdit).toEqual({ ...state, composition: { start: 0, end: 0 } });
    expect(events(target, () => update(target, 'ㄱ'))).toEqual([
      'document:gesture-update',
      'selection',
      'textEdit',
    ]);
    expect(textOf(target, 'n1')).toBe('ㄱ');
    expect(target.getSnapshot().selection).toEqual(['n1']);
    expect(target.getSnapshot().textEdit).toEqual(caret('n1', 1, 1, { start: 0, end: 1 }));
    expect(target.query({ type: 'committedDocument' }).nodes['n1']).toBeUndefined();
    update(target, '가');
    // The replace drew a new ID; the discarded one is gone.
    expect(target.query({ type: 'node', id: 'n1' })).toBeNull();
    expect(textOf(target, 'n2')).toBe('가');
    expect(target.getSnapshot().selection).toEqual(['n2']);
    expect(target.getSnapshot().textEdit).toEqual(caret('n2', 1, 1, { start: 0, end: 1 }));
    expect(events(target, () => end(target, '각'))).toEqual([
      'document:gesture-update',
      'selection',
      'textEdit',
      'document:gesture-commit',
      'textEdit',
    ]);
    expect(textOf(target, 'n3')).toBe('각');
    expect(target.query({ type: 'node', id: 'n3' })).toMatchObject({
      parent: 'p1',
      sizing: 'autoWidth',
      runs: [{ text: '각', family: 'Arial', size: 16 }],
    });
    expect(target.getSnapshot().textEdit).toEqual(caret('n3', 1));
    expect(depth(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    // Typing merges into the creating step; one undo removes the node and ends edit mode.
    type(target, 'x');
    expect(depth(target).undoDepth).toBe(1);
    target.execute({ type: 'undo' });
    expect(target.query({ type: 'node', id: 'n3' })).toBeNull();
    expect(target.getSnapshot().textEdit).toBeNull();
    target.execute({ type: 'redo' });
    expect(textOf(target, 'n3')).toBe('각x');
  });

  it('a cancel leaves no node, no step, and restores the pending state', () => {
    const target = pending();
    const state = target.getSnapshot().textEdit!;
    const before = target.getSnapshot().document;
    compose(target, 'ㄱ');
    expect(events(target, () => end(target, ''))).toEqual([
      'document:gesture-cancel',
      'selection',
      'textEdit',
    ]);
    expect(target.getSnapshot().document).toBe(before);
    expect(target.getSnapshot().textEdit).toEqual(state);
    expect(target.getSnapshot().selection).toEqual([]);
    expect(depth(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
    // An update back to empty brings the pending node back while composing.
    compose(target, 'ㄱ');
    update(target, '');
    expect(target.getSnapshot().textEdit).toEqual({ ...state, composition: { start: 0, end: 0 } });
    expect(target.getSnapshot().selection).toEqual([]);
    // A forced end of that empty composition records nothing and keeps the pending node.
    target.execute({ type: 'endComposition' });
    expect(target.getSnapshot().textEdit).toEqual(state);
    expect(target.getSnapshot().document).toBe(before);
    // A later textinput still creates the node in one command.
    type(target, 'a');
    expect(depth(target).undoDepth).toBe(1);
  });

  it('a forced end creates the node with the composing text', () => {
    const target = pending();
    compose(target, '가');
    input(target, { kind: 'pointercancel', modifiers: none });
    expect(textOf(target, 'n1')).toBe('가');
    expect(target.getSnapshot().textEdit).toEqual(caret('n1', 1));
    expect(depth(target).undoDepth).toBe(1);
    const again = pending();
    compose(again, '가');
    again.execute({ type: 'exitTextEdit' });
    expect(again.query({ type: 'node', id: 'n1' })).toMatchObject({ runs: [{ text: '가' }] });
    expect(again.getSnapshot().textEdit).toBeNull();
    expect(again.getSnapshot().selection).toEqual(['n1']);
  });

  it('a pending node in a frame scope is created in the frame', () => {
    const target = editor();
    target.execute({ type: 'setScope', id: 'fr' });
    target.execute({ type: 'setTool', tool: 'text' });
    input(target, { kind: 'pointerdown', point: at(350, 350), modifiers: none });
    input(target, { kind: 'pointerup', point: at(350, 350), modifiers: none });
    compose(target, '가');
    end(target, '가');
    // The start's update drew `n1`, the end's replace `n2`.
    expect(target.query({ type: 'node', id: 'n1' })).toBeNull();
    expect(target.query({ type: 'node', id: 'n2' })).toMatchObject({ parent: 'fr' });
    expect(target.getSnapshot().scope).toBe('fr');
  });
});

describe('M6b-A09 autosave and the E26-A09 oracle', () => {
  it('updates write nothing to autosave; the commit writes once', async () => {
    const writes: DocumentV6[] = [];
    const store: DocumentStore = {
      read: () => Promise.resolve({ ok: true, envelope: null }),
      write: (envelope) => {
        writes.push(envelope.document);
        return Promise.resolve({ ok: true, written: true });
      },
      clear: () => Promise.resolve({ ok: true }),
      close: () => undefined,
    };
    const timers = { set: () => 0, clear: () => undefined };
    const target = editing('t', 5);
    const autosave = createAutosave({
      store,
      timers,
      envelope: () => persistence.persistenceEnvelope(target),
    });
    const scheduled: EditorEvent[] = [];
    target.subscribe((event) => {
      if (persistence.schedulesWrite(event)) {
        scheduled.push(event);
        autosave.schedule();
      }
    });
    compose(target, 'ㄱ');
    update(target, '가');
    update(target, '각');
    await autosave.flush();
    expect(scheduled).toEqual([]);
    expect(writes).toEqual([]);
    // A cancelled composition writes nothing either.
    end(target, '');
    await autosave.flush();
    expect(writes).toEqual([]);
    compose(target, '가');
    end(target, '가');
    await autosave.flush();
    expect(scheduled).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.nodes['t']).toMatchObject({ runs: [{ text: 'ab cd가' }] });
  });

  const FEATURES = {
    pathFills: 'supported',
    paints: 'gradient',
    dashes: 'supported',
    groupOpacity: 'supported',
    textNodes: 'supported',
  } as const;

  type Entry = {
    before: DocumentV6;
    after: DocumentV6;
    touched: readonly string[];
    projected?: readonly string[];
    caret: unknown;
  };
  const stackOf = (target: Editor) => (target as unknown as { undoStack: Entry[] }).undoStack;

  it('composition steps, merged and on a pending node, undo and redo cleanly', () => {
    const target = editor();
    const renderer = new RecordingRenderer('supported', FEATURES);
    const diagnostics: EditorEvent[] = [];
    target.subscribe((event) => {
      if (event.type === 'diagnostic') diagnostics.push(event);
    });
    target.attachRenderer(renderer);
    // A pending node in the frame, created by a composition, with typing merged in.
    target.execute({ type: 'setScope', id: 'fr' });
    target.execute({ type: 'setTool', tool: 'text' });
    input(target, { kind: 'pointerdown', point: at(350, 350), modifiers: none });
    input(target, { kind: 'pointerup', point: at(350, 350), modifiers: none });
    compose(target, 'ㅎ');
    update(target, '하');
    end(target, '한');
    type(target, 'x');
    // A merged run on `t`, a replacement, and a cancelled composition.
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 5, focus: 5 });
    type(target, 'y');
    compose(target, '가');
    end(target, '가');
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 0, focus: 2 });
    compose(target, '나');
    end(target, '나');
    compose(target, 'ㄷ');
    end(target, '');
    expect(depth(target)).toEqual({ undoDepth: 3, redoDepth: 0 });
    for (const entry of stackOf(target)) {
      const ids = new Set([...Object.keys(entry.before.nodes), ...Object.keys(entry.after.nodes)]);
      const differing = [...ids].filter((id) => entry.before.nodes[id] !== entry.after.nodes[id]);
      expect(differing.length).toBeGreaterThan(0);
      expect(entry.projected ?? entry.touched).toEqual(expect.arrayContaining(differing));
      expect(entry.caret).not.toBeNull();
    }
    // The setup oracle throws E26-A09 on any mismatch; undo and redo all the way, twice.
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < 3; i += 1) expect(target.execute({ type: 'undo' }).ok).toBe(true);
      expect(target.query({ type: 'node', id: 'n3' })).toBeNull();
      expect(textOf(target, 't')).toBe('ab cd');
      for (let i = 0; i < 3; i += 1) expect(target.execute({ type: 'redo' }).ok).toBe(true);
      expect(textOf(target, 'n3')).toBe('한x');
      expect(textOf(target, 't')).toBe('나 cdy가');
    }
    expect(diagnostics).toEqual([]);
    const scene = renderer.calls.filter((call) => call.method !== 'setCamera');
    expect(scene.every((call) => call.result.status === 'applied')).toBe(true);
  });
});
