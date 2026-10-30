import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Color, DocumentV6, Frame, TextRun } from '@vector-studio/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
  type Modifiers,
  type PagePoint,
  type TextEditState,
} from '../../packages/editor-core/src/index.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// MVP M6b-U5, M6b-A06 (docs/plans/mvp-m6b-text-editing-contract.md, section 8): the caret
// entries of text steps, the merge rules and breaks of section 8.2 (M6b-Q13 (a)), and the caret
// restore of undo and redo (section 8.3), from the committed history scripts in
// tests/fixtures/m6-text/history/merge.json and the cases the scripts cannot express: the
// pending node's creating step, the restore only in edit mode, byte-identical undo and redo,
// a host change, no timer, the event shape M5 autosave reads, and merged entries clean under
// the E26-A09 scoped-projection oracle with a renderer attached. Layouts come from the fake
// port: `a` to `z` advance 0.5 em, a space 0.25 em, Hangul 1 em.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black: Color = { r: 0, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });

type Loose = Record<string, unknown> & { id: string };

function run(text: string, size = 10): TextRun {
  return { text, family: 'Test', size, color: black };
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
 * Page `p1`: `t` "ab cd" at (10, 20), `h` "안녕" at (100, 20), a rectangle `r` and an empty frame
 * `fr` at (300, 300).
 */
function fixture(): DocumentV6 {
  const nodes: Loose[] = [
    text('t', f(10, 20, 22.5, 12), [run('ab cd')]),
    text('h', f(100, 20, 20, 12), [run('안녕')]),
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
    {
      id: 'fr',
      name: 'fr',
      parent: 'p1',
      frame: f(300, 300, 200, 200),
      rotation: 0,
      constraints: START,
      opacity: 1,
      visible: true,
      type: 'frame',
      children: [],
      fill: black,
      stroke: null,
    },
  ];
  return {
    schemaVersion: 6,
    id: 'doc',
    pages: [{ id: 'p1', name: 'Page 1', children: nodes.map((node) => node.id) }],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  } as unknown as DocumentV6;
}

function editor(): Editor {
  return createEditor({
    document: fixture(),
    ids: createCounterIdSource('n'),
    textLayout: createFakeTextLayout(),
  });
}

function editing(id: string, anchor: number, focus = anchor): Editor {
  const target = editor();
  expect(target.execute({ type: 'enterTextEdit', id, anchor, focus })).toEqual({
    ok: true,
    ids: [],
  });
  return target;
}

const input = (target: Editor, event: unknown) =>
  target.execute({ type: 'input', event } as Command);
const type = (target: Editor, value: string) => input(target, { kind: 'textinput', text: value });
const key = (target: Editor, value: string, modifiers = none) =>
  input(target, { kind: 'keydown', key: value, modifiers });
const press = (target: Editor, point: PagePoint) => {
  input(target, { kind: 'pointerdown', point, modifiers: none });
  input(target, { kind: 'pointerup', point, modifiers: none });
};

function caret(id: string, anchor: number, focus = anchor): TextEditState {
  return { id, pending: null, anchor, focus, affinity: 'downstream', composition: null };
}

function textOf(target: Editor, id: string): string {
  const node = target.query({ type: 'node', id });
  if (node?.type !== 'text') throw new Error(`not a text node: ${id}`);
  return node.runs.map((r) => r.text).join('');
}

const depth = (target: Editor) => target.getSnapshot().history;

type Step =
  | { type: string }
  | { key: string; mods?: ('ctrl' | 'shift')[] }
  | { select: [number, number] }
  | { press: [number, number] }
  | { exit: true }
  | { enter: [number, number] };

type State = { text: string; caret: [number, number] };

type Script = {
  name: string;
  node: string;
  caret: [number, number];
  steps: Step[];
  text: string;
  depth: number;
  undo: State[];
  redo: State[];
};

const SCRIPTS = (
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, '../fixtures/m6-text/history/merge.json'),
      'utf8',
    ),
  ) as { scripts: Script[] }
).scripts;

function step(target: Editor, id: string, item: Step) {
  if ('type' in item) {
    expect(type(target, item.type)).toMatchObject({ ok: true, consumed: true });
  } else if ('key' in item) {
    const mods = item.mods ?? [];
    const modifiers = { ...none, ctrl: mods.includes('ctrl'), shift: mods.includes('shift') };
    expect(key(target, item.key, modifiers)).toMatchObject({ ok: true, consumed: true });
  } else if ('select' in item) {
    const [anchor, focus] = item.select;
    expect(target.execute({ type: 'setTextSelection', anchor, focus }).ok).toBe(true);
  } else if ('press' in item) {
    press(target, at(...item.press));
  } else if ('exit' in item) {
    target.execute({ type: 'exitTextEdit' });
  } else {
    const [anchor, focus] = item.enter;
    expect(target.execute({ type: 'enterTextEdit', id, anchor, focus }).ok).toBe(true);
  }
}

function state(target: Editor, id: string): State {
  const edit = target.getSnapshot().textEdit;
  expect(edit?.id).toBe(id);
  return { text: textOf(target, id), caret: [edit!.anchor, edit!.focus] };
}

describe('M6b-A06 history scripts (section 8.2, M6b-Q13 (a))', () => {
  it('the fixture holds scripts', () => {
    expect(SCRIPTS.length).toBeGreaterThan(15);
  });

  for (const script of SCRIPTS) {
    it(script.name, () => {
      const target = editing(script.node, ...script.caret);
      for (const item of script.steps) step(target, script.node, item);
      expect(textOf(target, script.node)).toBe(script.text);
      expect(depth(target)).toEqual({ undoDepth: script.depth, redoDepth: 0 });
      expect(script.undo).toHaveLength(script.depth);
      expect(script.redo).toHaveLength(script.depth);
      // Each undo restores the text and its caret entry's `before` caret (section 8.3).
      const undone = script.undo.map(() => {
        expect(target.execute({ type: 'undo' })).toEqual({ ok: true, ids: [] });
        return state(target, script.node);
      });
      expect(undone).toEqual(script.undo);
      expect(depth(target)).toEqual({ undoDepth: 0, redoDepth: script.depth });
      // Each redo restores the text and its caret entry's `after` caret.
      const redone = script.redo.map(() => {
        expect(target.execute({ type: 'redo' })).toEqual({ ok: true, ids: [] });
        return state(target, script.node);
      });
      expect(redone).toEqual(script.redo);
    });
  }
});

describe('M6b-A06 merge and its breaks (section 8.2)', () => {
  it('a merged step raises its own document event with its touched list (M5 autosave)', () => {
    const target = editing('t', 5);
    type(target, 'x');
    const seen: EditorEvent[] = [];
    const stop = target.subscribe((event) => seen.push(event));
    type(target, 'y');
    stop();
    expect(depth(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(seen).toEqual([
      { type: 'document', cause: 'command', revision: 2, touched: ['t'] },
      { type: 'session', field: 'textEdit' },
    ]);
  });

  it('any other document change breaks the merge', () => {
    const target = editing('t', 5);
    type(target, 'x');
    expect(target.execute({ type: 'setText', id: 'h', start: 0, end: 0, text: 'z' }).ok).toBe(true);
    type(target, 'y');
    expect(textOf(target, 't')).toBe('ab cdxy');
    expect(depth(target)).toEqual({ undoDepth: 3, redoDepth: 0 });
  });

  it('a host change of the edited node breaks the merge', () => {
    const target = editing('t', 5);
    type(target, 'x');
    target.execute({ type: 'setText', id: 't', start: 0, end: 0, text: '' });
    type(target, 'y');
    expect(depth(target)).toEqual({ undoDepth: 3, redoDepth: 0 });
  });

  it('a style change of the edited node breaks the merge', () => {
    const target = editing('t', 5);
    type(target, 'x');
    expect(target.execute({ type: 'setStyle', ids: ['t'], style: { opacity: 0.5 } }).ok).toBe(true);
    type(target, 'y');
    expect(textOf(target, 't')).toBe('ab cdxy');
    expect(depth(target)).toEqual({ undoDepth: 3, redoDepth: 0 });
  });

  it('an undo breaks the merge: typing after it starts a new step and clears redo', () => {
    const target = editing('t', 5);
    type(target, 'x');
    key(target, 'Enter');
    type(target, 'y');
    target.execute({ type: 'undo' });
    target.execute({ type: 'undo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 6));
    type(target, 'z');
    expect(textOf(target, 't')).toBe('ab cdxz');
    expect(depth(target)).toEqual({ undoDepth: 2, redoDepth: 0 });
    type(target, 'w');
    expect(depth(target)).toEqual({ undoDepth: 2, redoDepth: 0 });
  });

  it('a double-click inside (word selection) breaks the merge', () => {
    const target = editing('t', 5);
    type(target, 'x');
    // The word "cdx" at local x 20, then a click back at the end.
    input(target, { kind: 'doubleclick', point: at(30, 25), modifiers: none });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 3, 6));
    key(target, 'End');
    type(target, 'y');
    expect(textOf(target, 't')).toBe('ab cdxy');
    expect(depth(target)).toEqual({ undoDepth: 2, redoDepth: 0 });
  });

  it('there is no timer: steps far apart in time still merge', () => {
    vi.useFakeTimers();
    const target = editing('t', 5);
    type(target, 'x');
    vi.advanceTimersByTime(10 * 60 * 1000);
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    type(target, 'y');
    expect(depth(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
  });

  it('a failed step changes nothing and keeps the merge', () => {
    const target = editing('t', 5);
    type(target, 'x');
    expect(type(target, 'y'.repeat(16_384)).ok).toBe(false);
    type(target, 'y');
    expect(depth(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});

describe('M6b-A06 caret restore (section 8.3)', () => {
  it('undo and redo are byte-identical to the documents before and after the merged step', () => {
    const target = editing('t', 5);
    const before = target.getSnapshot().document;
    type(target, 'x');
    type(target, 'y');
    key(target, 'Backspace');
    key(target, 'Backspace');
    const after = target.getSnapshot().document;
    target.execute({ type: 'undo' });
    target.execute({ type: 'undo' });
    expect(target.getSnapshot().document).toBe(before);
    target.execute({ type: 'redo' });
    target.execute({ type: 'redo' });
    expect(target.getSnapshot().document).toBe(after);
  });

  it('outside edit mode undo and redo touch no caret and never enter edit mode', () => {
    const target = editing('t', 5);
    type(target, 'x');
    type(target, 'y');
    target.execute({ type: 'exitTextEdit' });
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toBeNull();
    expect(target.getSnapshot().selection).toEqual(['t']);
    target.execute({ type: 'redo' });
    expect(target.getSnapshot().textEdit).toBeNull();
    // Edit mode entered again on the node: the caret comes back (section 8.3 asks only that
    // edit mode is active on the entry's node).
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 0, focus: 0 });
    target.execute({ type: 'undo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
    target.execute({ type: 'redo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 7));
  });

  it('edit mode on another node keeps its caret, clamped only', () => {
    const target = editing('t', 5);
    type(target, 'x');
    target.execute({ type: 'enterTextEdit', id: 'h', anchor: 1, focus: 1 });
    target.execute({ type: 'undo' });
    expect(textOf(target, 't')).toBe('ab cd');
    expect(target.getSnapshot().textEdit).toEqual(caret('h', 1));
  });

  it('a host step has no caret entry: its undo clamps the caret only', () => {
    const target = editing('t', 5);
    target.execute({ type: 'setText', id: 't', start: 5, end: 5, text: 'xyz' });
    target.execute({ type: 'setTextSelection', anchor: 8, focus: 8 });
    target.execute({ type: 'undo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
    target.execute({ type: 'setTextSelection', anchor: 1, focus: 1 });
    target.execute({ type: 'redo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1));
  });

  it('undo raises the document event, then one textEdit event for the restored caret', () => {
    const target = editing('t', 1, 4);
    type(target, 'Q');
    const seen: string[] = [];
    const stop = target.subscribe((event) => {
      if (event.type === 'session') seen.push(event.field);
      if (event.type === 'document') seen.push(`document:${event.cause}`);
    });
    target.execute({ type: 'undo' });
    stop();
    expect(seen).toEqual(['document:undo', 'textEdit']);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 4));
  });

  it('keyboard undo and redo in edit mode restore the caret', () => {
    const target = editing('t', 5);
    type(target, 'x');
    type(target, 'y');
    const ctrl = { ...none, ctrl: true };
    expect(input(target, { kind: 'keydown', key: 'z', code: 'KeyZ', modifiers: ctrl })).toEqual({
      ok: true,
      ids: [],
      consumed: true,
    });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5));
    input(target, { kind: 'keydown', key: 'y', code: 'KeyY', modifiers: ctrl });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 7));
  });
});

describe('M6b-A06 the pending node creating step (section 8.2)', () => {
  function pending(): Editor {
    const target = editor();
    target.execute({ type: 'setTool', tool: 'text' });
    input(target, { kind: 'pointerdown', point: at(50, 60), modifiers: none });
    input(target, { kind: 'pointerup', point: at(50, 60), modifiers: none });
    expect(target.getSnapshot().textEdit?.pending).not.toBeNull();
    return target;
  }

  it('following insertions merge into the creating step; undo removes the node', () => {
    const target = pending();
    type(target, 'a');
    type(target, 'b');
    type(target, 'c');
    expect(textOf(target, 'n1')).toBe('abc');
    expect(depth(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    target.execute({ type: 'undo' });
    expect(target.query({ type: 'node', id: 'n1' })).toBeNull();
    expect(target.getSnapshot().textEdit).toBeNull();
    // Redo brings the whole text back and does not enter edit mode.
    target.execute({ type: 'redo' });
    expect(textOf(target, 'n1')).toBe('abc');
    expect(target.getSnapshot().textEdit).toBeNull();
  });

  it('the merge rules hold after the creating step: a space starts a new step', () => {
    const target = pending();
    type(target, 'a');
    type(target, 'b');
    type(target, ' ');
    type(target, 'c');
    expect(depth(target)).toEqual({ undoDepth: 2, redoDepth: 0 });
    target.execute({ type: 'undo' });
    expect(textOf(target, 'n1')).toBe('ab');
    expect(target.getSnapshot().textEdit).toEqual(caret('n1', 2));
    target.execute({ type: 'redo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('n1', 4));
  });

  it('an LF that creates the node is its own step', () => {
    const target = pending();
    key(target, 'Enter');
    type(target, 'a');
    type(target, 'b');
    expect(textOf(target, 'n1')).toBe('\nab');
    expect(depth(target)).toEqual({ undoDepth: 2, redoDepth: 0 });
    target.execute({ type: 'undo' });
    expect(textOf(target, 'n1')).toBe('\n');
    expect(target.getSnapshot().textEdit).toEqual(caret('n1', 1));
  });

  it('a caret move breaks the merge into the creating step', () => {
    const target = pending();
    type(target, 'a');
    key(target, 'ArrowLeft');
    type(target, 'b');
    expect(textOf(target, 'n1')).toBe('ba');
    expect(depth(target)).toEqual({ undoDepth: 2, redoDepth: 0 });
    target.execute({ type: 'undo' });
    expect(textOf(target, 'n1')).toBe('a');
    expect(target.getSnapshot().textEdit).toEqual(caret('n1', 0));
  });
});

describe('M6b-A06 merged entries under the E26-A09 scoped-projection oracle', () => {
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
  };
  const stackOf = (target: Editor) => (target as unknown as { undoStack: Entry[] }).undoStack;

  /** Every ID whose node object differs between the entry's documents is projected. */
  function complete(entry: Entry) {
    const ids = new Set([...Object.keys(entry.before.nodes), ...Object.keys(entry.after.nodes)]);
    const differing = [...ids].filter((id) => entry.before.nodes[id] !== entry.after.nodes[id]);
    expect(differing.length).toBeGreaterThan(0);
    expect(entry.projected ?? entry.touched).toEqual(expect.arrayContaining(differing));
    expect(entry.projected ?? entry.touched).toEqual(expect.arrayContaining([...entry.touched]));
  }

  it('merged typing, deletion and the creating step undo and redo cleanly', () => {
    const target = editor();
    const renderer = new RecordingRenderer('supported', FEATURES);
    const diagnostics: EditorEvent[] = [];
    target.subscribe((event) => {
      if (event.type === 'diagnostic') diagnostics.push(event);
    });
    target.attachRenderer(renderer);
    // A creating step with merged insertions, inside the frame, so the merged entry also holds
    // the frame whose child list the creating step changes. Text units are not projected until
    // M6c, so the scene sets the oracle compares stay empty here; `complete` checks the lists
    // the projector is given, which is what the oracle would catch once text is projected.
    target.execute({ type: 'setScope', id: 'fr' });
    target.execute({ type: 'setTool', tool: 'text' });
    input(target, { kind: 'pointerdown', point: at(350, 350), modifiers: none });
    input(target, { kind: 'pointerup', point: at(350, 350), modifiers: none });
    for (const ch of 'hello') type(target, ch);
    expect(target.query({ type: 'node', id: 'n1' })).toMatchObject({ parent: 'fr' });
    // A merged run on an existing node, and a Backspace run.
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 5, focus: 5 });
    for (const ch of 'xyz') type(target, ch);
    for (let i = 0; i < 3; i += 1) key(target, 'Backspace');
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 0, focus: 0 });
    key(target, 'Delete');
    key(target, 'Delete');
    expect(depth(target)).toEqual({ undoDepth: 4, redoDepth: 0 });
    stackOf(target).forEach(complete);
    const top = stackOf(target)[0]!;
    expect(top.projected ?? top.touched).toContain('fr');
    // The setup oracle throws E26-A09 on any mismatch; undo and redo all the way, twice.
    for (let round = 0; round < 2; round += 1) {
      for (let i = 0; i < 4; i += 1) expect(target.execute({ type: 'undo' }).ok).toBe(true);
      expect(target.query({ type: 'node', id: 'n1' })).toBeNull();
      expect(textOf(target, 't')).toBe('ab cd');
      for (let i = 0; i < 4; i += 1) expect(target.execute({ type: 'redo' }).ok).toBe(true);
      expect(textOf(target, 'n1')).toBe('hello');
      expect(textOf(target, 't')).toBe(' cd');
    }
    expect(diagnostics).toEqual([]);
    const scene = renderer.calls.filter((call) => call.method !== 'setCamera');
    expect(scene.every((call) => call.result.status === 'applied')).toBe(true);
  });
});
