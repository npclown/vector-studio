import type { TextLayoutPort } from '@vector-studio/contracts';
import type { Color, DocumentV6, Frame, TextRun } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
  type Modifiers,
  type PagePoint,
  type TextEditOverlay,
  type TextEditPending,
  type TextEditState,
} from '../../packages/editor-core/src/index.js';
// Source imports: the gesture API, the caret model and the pending-node geometry are internal.
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { createCaretModel } from '../../packages/editor-core/src/text-caret.js';
import {
  DEFAULT_TEXT_STYLE,
  insideTarget,
  pendingRequest,
  pendingTarget,
  textEditOverlay,
} from '../../packages/editor-core/src/text-edit.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// MVP M6b-U2, M6b-A03 (docs/plans/mvp-m6b-text-editing-contract.md, sections 2, 3, 4.4 and
// 4.5): text edit mode's session state and its section 3.1 commands with their codes, every
// entry and exit of section 3 with the session event order, the pointer rules of section 4.4,
// the press outside acting in the same input, scope unchanged, `handles` null, the
// `textEditOverlay` literal values for a page-root, a rotated, a nested and a pending node,
// `editor.no-text-layout` without a port, and the text tool style of M6b-S2. Layouts come from
// the fake port: `a` to `d` advance 0.5 em, a space 0.25 em, a line is 1.2 times its size. For
// "ab cd" at size 10 the stops 0 to 5 lie at x 0, 5, 10, 12.5, 17.5 and 22.5 on one line of
// top 0 and height 12.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black: Color = { r: 0, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const shift: Modifiers = { ...none, shift: true };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });

type Loose = Record<string, unknown> & { id: string };

function run(text: string, size = 10): TextRun {
  return { text, family: 'Test', size, color: black };
}

function base(id: string, parent: string, frame: Frame, rotation = 0, visible = true) {
  return { id, name: id, parent, frame, rotation, constraints: START, opacity: 1, visible };
}

function text(
  id: string,
  parent: string,
  frame: Frame,
  content = 'ab cd',
  options: { rotation?: number; visible?: boolean } = {},
): Loose {
  return {
    ...base(id, parent, frame, options.rotation ?? 0, options.visible ?? true),
    type: 'text',
    runs: [run(content)],
    sizing: 'autoWidth',
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1.2,
  };
}

function rect(id: string, parent: string, frame: Frame): Loose {
  return {
    ...base(id, parent, frame),
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
  };
}

function path(id: string, parent: string, frame: Frame): Loose {
  return {
    ...base(id, parent, frame),
    type: 'path',
    path: {
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 1, 0, 1, 1],
      fillRule: 'nonzero',
    },
    fill: black,
    stroke: null,
  };
}

/**
 * Page `p1`: `t` "ab cd" at (10, 20); `tr` rotated by π/2 at (50, 50); `r` a rectangle; `pa`
 * a path; group `g` holding `tg` at page (0, 80); frame `fr` at (200, 0) holding `tn` at
 * local (5, 6); hidden `th`; `tc` "e" + U+0301 + "😀"; `ro` a rectangle under `t`, overlapping
 * it at (12, 22) to (17, 27). Page `p2`: `t2`.
 */
function fixture(): DocumentV6 {
  const nodes: Loose[] = [
    text('t', 'p1', f(10, 20, 22.5, 12)),
    text('tr', 'p1', f(50, 50, 22.5, 12), 'ab cd', { rotation: Math.PI / 2 }),
    rect('r', 'p1', f(100, 100, 10, 10)),
    rect('ro', 'p1', f(12, 22, 5, 5)),
    path('pa', 'p1', f(300, 300, 10, 10)),
    { ...base('g', 'p1', f(0, 80, 22.5, 12)), type: 'group', children: ['tg'] },
    text('tg', 'g', f(0, 0, 22.5, 12)),
    {
      ...base('fr', 'p1', f(200, 0, 100, 100)),
      type: 'frame',
      children: ['tn'],
      fill: null,
      stroke: null,
    },
    text('tn', 'fr', f(5, 6, 22.5, 12)),
    text('th', 'p1', f(400, 400, 22.5, 12), 'ab cd', { visible: false }),
    text('tc', 'p1', f(500, 500, 10, 12), 'é\u{1F600}'),
    text('t2', 'p2', f(0, 0, 22.5, 12)),
  ];
  return {
    schemaVersion: 6,
    id: 'doc',
    pages: [
      { id: 'p1', name: 'Page 1', children: ['ro', 't', 'tr', 'r', 'pa', 'g', 'fr', 'th', 'tc'] },
      { id: 'p2', name: 'Page 2', children: ['t2'] },
    ],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  } as unknown as DocumentV6;
}

function editor(port: TextLayoutPort | null = createFakeTextLayout()): Editor {
  return createEditor({
    document: fixture(),
    ids: createCounterIdSource('n'),
    ...(port === null ? {} : { textLayout: port }),
  });
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

function caret(id: string, anchor: number, focus: number, affinity = 'downstream'): TextEditState {
  return { id, pending: null, anchor, focus, affinity, composition: null } as TextEditState;
}

const input = (target: Editor, event: unknown) =>
  target.execute({ type: 'input', event } as Command);
const down = (target: Editor, point: PagePoint, modifiers = none) =>
  input(target, { kind: 'pointerdown', point, modifiers });
const move = (target: Editor, point: PagePoint, modifiers = none) =>
  input(target, { kind: 'pointermove', point, modifiers });
const up = (target: Editor, point: PagePoint, modifiers = none) =>
  input(target, { kind: 'pointerup', point, modifiers });
const key = (target: Editor, value: string, modifiers = none, code?: string) =>
  input(target, {
    kind: 'keydown',
    key: value,
    ...(code === undefined ? {} : { code }),
    modifiers,
  });

function doubleClick(target: Editor, point: PagePoint) {
  down(target, point);
  up(target, point);
  down(target, point);
  up(target, point);
  return input(target, { kind: 'doubleclick', point, modifiers: none });
}

describe('M6b-A03 session state and the text tool style (M6b-S1, S2)', () => {
  it('starts outside edit mode with the default style in the snapshot', () => {
    const target = editor();
    expect(target.getSnapshot().textEdit).toBeNull();
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(target.query({ type: 'textEditOverlay' })).toBeNull();
    expect(target.getSnapshot().textStyle).toEqual({ family: 'Arial', size: 16, color: black });
    expect(Object.isFrozen(target.getSnapshot().textStyle)).toBe(true);
  });

  it('takes EditorOptions.textStyle and rejects an invalid one', () => {
    const style = { family: 'Noto', size: 12, color: { r: 1, g: 0, b: 0, a: 1 } };
    expect(createEditor({ textStyle: style }).getSnapshot().textStyle).toEqual(style);
    expect(() => createEditor({ textStyle: { ...style, size: 0.25 } })).toThrow(
      'createEditor: editor.invalid-command at /textStyle/size',
    );
    expect(() => createEditor({ textStyle: { ...style, family: '' } })).toThrow(
      /createEditor: document\.invalid-field at \/textStyle\/family/,
    );
  });

  it('sets the style with setTextToolStyle, raising textStyle once per change', () => {
    const target = editor();
    const style = { family: 'Noto', size: 12, color: { r: 0, g: 0, b: 1, a: 1 } };
    expect(
      events(target, () =>
        expect(target.execute({ type: 'setTextToolStyle', style })).toEqual({ ok: true, ids: [] }),
      ),
    ).toEqual(['textStyle']);
    expect(target.getSnapshot().textStyle).toEqual(style);
    expect(events(target, () => target.execute({ type: 'setTextToolStyle', style }))).toEqual([]);
    expect(target.getSnapshot().history).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it('checks the style: shape, the model run rules, then the size floor', () => {
    const target = editor();
    const style = { family: 'Noto', size: 12, color: black };
    const set = (value: unknown) =>
      target.execute({ type: 'setTextToolStyle', style: value } as Command);
    expect(set(null)).toEqual({ ok: false, code: 'editor.invalid-command', path: '/style' });
    expect(set({ family: 'Noto', size: 12 })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/style/color',
    });
    expect(set({ ...style, text: 'x' })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/style/text',
    });
    expect(set({ ...style, size: -1 })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/style/size',
    });
    expect(set({ ...style, color: { r: 2, g: 0, b: 0, a: 1 } })).toMatchObject({
      ok: false,
      code: 'document.invalid-field',
    });
    expect(set({ ...style, size: 0.4 })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/style/size',
    });
    expect(target.getSnapshot().textStyle).toEqual(DEFAULT_TEXT_STYLE);
  });
});

describe('M6b-A03 enterTextEdit and its codes (section 3.1)', () => {
  it('enters with all text selected: tool, selection, then textEdit', () => {
    const target = editor();
    target.execute({ type: 'setTool', tool: 'rectangle' });
    expect(
      events(target, () =>
        expect(target.execute({ type: 'enterTextEdit', id: 't' })).toEqual({ ok: true, ids: [] }),
      ),
    ).toEqual(['tool', 'selection', 'textEdit']);
    const snapshot = target.getSnapshot();
    expect(snapshot.textEdit).toEqual(caret('t', 0, 5));
    expect(target.query({ type: 'textEdit' })).toBe(snapshot.textEdit);
    expect(Object.isFrozen(snapshot.textEdit)).toBe(true);
    expect(snapshot.tool).toBe('select');
    expect(snapshot.selection).toEqual(['t']);
    expect(target.query({ type: 'handles' })).toBeNull();
    expect(snapshot.history).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it('takes offsets; one offset alone gives a collapsed caret there', () => {
    const target = editor();
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 4, focus: 1 });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 4, 1));
    target.execute({ type: 'exitTextEdit' });
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 3 });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 3, 3));
    target.execute({ type: 'exitTextEdit' });
    target.execute({ type: 'enterTextEdit', id: 't', focus: 2 });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2, 2));
  });

  it('entering the edited node again only sets the caret', () => {
    const target = editor();
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 1 });
    expect(
      events(target, () => target.execute({ type: 'enterTextEdit', id: 't', anchor: 2, focus: 3 })),
    ).toEqual(['textEdit']);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2, 3));
    expect(
      events(target, () => target.execute({ type: 'enterTextEdit', id: 't', anchor: 2, focus: 3 })),
    ).toEqual([]);
  });

  it('keeps the scope; enters a hidden node by command', () => {
    const target = editor();
    target.execute({ type: 'setScope', id: 'g' });
    target.execute({ type: 'enterTextEdit', id: 'tg' });
    expect(target.getSnapshot()).toMatchObject({ scope: 'g', selection: ['tg'] });
    expect(target.getSnapshot().textEdit).toEqual(caret('tg', 0, 5));
    target.execute({ type: 'enterTextEdit', id: 'th' });
    expect(target.getSnapshot().textEdit).toEqual(caret('th', 0, 5));
    expect(target.getSnapshot().scope).toBe('g');
  });

  it('ends an active gesture first (a drag is cancelled)', () => {
    const target = editor();
    const { gesture } = internalsOf(target);
    gesture.begin();
    gesture.update({ type: 'setFrames', frames: [{ id: 'r', frame: f(0, 0, 10, 10) }] });
    target.execute({ type: 'enterTextEdit', id: 't' });
    expect(gesture.active).toBe(false);
    expect(target.query({ type: 'node', id: 'r' })!.frame).toEqual(f(100, 100, 10, 10));
    expect(target.getSnapshot().history.undoDepth).toBe(0);
  });

  it('fails in the section 3.1 order and changes nothing', () => {
    const target = editor();
    const enter = (command: Record<string, unknown>) =>
      target.execute({ type: 'enterTextEdit', ...command } as Command);
    expect(enter({ id: 3 })).toEqual({ ok: false, code: 'editor.invalid-command', path: '/id' });
    expect(enter({ id: 'nope' })).toEqual({ ok: false, code: 'editor.unknown-node' });
    expect(enter({ id: 't2' })).toEqual({ ok: false, code: 'editor.unknown-node' });
    expect(enter({ id: 'r', anchor: 99 })).toEqual({
      ok: false,
      code: 'editor.not-a-text-node',
      path: '/id',
    });
    const range = (key: string) => ({
      ok: false,
      code: 'editor.invalid-text-range',
      path: `/${key}`,
    });
    expect(enter({ id: 't', anchor: 1.5 })).toEqual(range('anchor'));
    expect(enter({ id: 't', anchor: -1 })).toEqual(range('anchor'));
    expect(enter({ id: 't', focus: 6 })).toEqual(range('focus'));
    expect(enter({ id: 't', anchor: '1' })).toEqual(range('anchor'));
    // `tc` is "e" U+0301 U+1F600: 1 is inside the accented cluster, 3 splits the surrogate pair.
    expect(enter({ id: 'tc', anchor: 1 })).toEqual(range('anchor'));
    expect(enter({ id: 'tc', anchor: 2, focus: 3 })).toEqual(range('focus'));
    expect(target.getSnapshot()).toMatchObject({ textEdit: null, selection: [] });
    expect(enter({ id: 'tc', anchor: 2, focus: 4 })).toEqual({ ok: true, ids: [] });
  });

  it('without a port fails with editor.no-text-layout, after the range check', () => {
    const target = editor(null);
    expect(target.execute({ type: 'enterTextEdit', id: 't' })).toEqual({
      ok: false,
      code: 'editor.no-text-layout',
    });
    expect(target.execute({ type: 'enterTextEdit', id: 't', anchor: 9 })).toMatchObject({
      code: 'editor.invalid-text-range',
    });
    expect(target.getSnapshot()).toMatchObject({ textEdit: null, selection: [] });
  });
});

describe('M6b-A03 setTextSelection, exitTextEdit and endComposition (section 3.1)', () => {
  it('setTextSelection fails outside edit mode with editor.no-text-edit', () => {
    const target = editor();
    expect(target.execute({ type: 'setTextSelection', anchor: 0, focus: 0 })).toEqual({
      ok: false,
      code: 'editor.no-text-edit',
    });
  });

  it('sets the caret with an affinity and raises textEdit only', () => {
    const target = editor();
    target.execute({ type: 'enterTextEdit', id: 't' });
    expect(
      events(target, () =>
        expect(
          target.execute({ type: 'setTextSelection', anchor: 2, focus: 2, affinity: 'upstream' }),
        ).toEqual({ ok: true, ids: [] }),
      ),
    ).toEqual(['textEdit']);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2, 2, 'upstream'));
    target.execute({ type: 'setTextSelection', anchor: 1, focus: 4 });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 4));
  });

  it('checks the affinity first, then the offsets against the stops', () => {
    const target = editor();
    target.execute({ type: 'enterTextEdit', id: 'tc' });
    const set = (command: Record<string, unknown>) =>
      target.execute({ type: 'setTextSelection', ...command } as Command);
    expect(set({ anchor: 1, focus: 2 })).toEqual({
      ok: false,
      code: 'editor.invalid-text-range',
      path: '/anchor',
    });
    expect(set({ anchor: 0, focus: 3 })).toEqual({
      ok: false,
      code: 'editor.invalid-text-range',
      path: '/focus',
    });
    expect(set({ anchor: 0 })).toEqual({
      ok: false,
      code: 'editor.invalid-text-range',
      path: '/focus',
    });
    expect(set({ anchor: 1, focus: 2, affinity: 'left' })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/affinity',
    });
    expect(target.getSnapshot().textEdit).toEqual(caret('tc', 0, 4));
    target.execute({ type: 'exitTextEdit' });
    expect(set({ anchor: 0, focus: 0, affinity: 'left' })).toMatchObject({
      code: 'editor.invalid-command',
    });
  });

  it('exitTextEdit keeps the selection and is a no-op outside edit mode', () => {
    const target = editor();
    expect(target.execute({ type: 'exitTextEdit' })).toEqual({ ok: true, ids: [] });
    target.execute({ type: 'enterTextEdit', id: 't' });
    expect(events(target, () => target.execute({ type: 'exitTextEdit' }))).toEqual(['textEdit']);
    expect(target.getSnapshot()).toMatchObject({ textEdit: null, selection: ['t'] });
    expect(target.query({ type: 'handles' })).not.toBeNull();
  });

  it('endComposition is a no-op without a composition', () => {
    const target = editor();
    expect(target.execute({ type: 'endComposition' })).toEqual({ ok: true, ids: [] });
    target.execute({ type: 'enterTextEdit', id: 't' });
    expect(events(target, () => target.execute({ type: 'endComposition' }))).toEqual([]);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 5));
  });
});

describe('M6b-A03 entry by input (section 3.2)', () => {
  it('a double-click on a text node enters with the word at the point selected', () => {
    const target = editor();
    // Page x 16 is local 6, nearest stop 1, in the word "ab".
    expect(doubleClick(target, at(16, 25))).toMatchObject({ ok: true, consumed: true });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 2));
    expect(target.getSnapshot().selection).toEqual(['t']);
  });

  it('text in a group needs two double-clicks: scope entry first', () => {
    const target = editor();
    doubleClick(target, at(18, 85));
    expect(target.getSnapshot()).toMatchObject({ scope: 'g', selection: ['tg'], textEdit: null });
    doubleClick(target, at(18, 85));
    expect(target.getSnapshot().textEdit).toEqual(caret('tg', 3, 5));
    expect(target.getSnapshot().scope).toBe('g');
  });

  it('Enter on one selected text node selects all text', () => {
    const target = editor();
    target.execute({ type: 'setSelection', ids: ['t'] });
    expect(key(target, 'Enter')).toMatchObject({ ok: true, consumed: true });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 5));
  });

  it('without a port neither enters: no-text-layout, and the double-click is not consumed', () => {
    const target = editor(null);
    target.execute({ type: 'setSelection', ids: ['t'] });
    expect(key(target, 'Enter')).toEqual({
      ok: false,
      code: 'editor.no-text-layout',
      consumed: true,
    });
    expect(doubleClick(target, at(16, 25))).toMatchObject({ ok: true, consumed: false });
    expect(target.getSnapshot().textEdit).toBeNull();
  });
});

describe('M6b-A03 exit (section 3.3) with the event order', () => {
  function entered(id = 't'): Editor {
    const target = editor();
    target.execute({ type: 'enterTextEdit', id });
    return target;
  }

  it('other bindings are consumed no-ops until the key routing of section 5', () => {
    const target = entered();
    const before = target.getSnapshot();
    const ctrl = { ...none, ctrl: true };
    const keys: [string, Modifiers, string?][] = [
      ['Delete', none],
      ['Backspace', none],
      ['ArrowRight', none],
      ['a', ctrl, 'KeyA'],
      ['r', none, 'KeyR'],
      ['d', ctrl, 'KeyD'],
    ];
    for (const [value, modifiers, code] of keys) {
      expect(key(target, value, modifiers, code)).toEqual({ ok: true, ids: [], consumed: true });
    }
    const after = target.getSnapshot();
    expect(after.document).toBe(before.document);
    expect(after).toMatchObject({
      selection: before.selection,
      tool: before.tool,
      textEdit: before.textEdit,
      history: before.history,
    });
  });

  it('undo and redo still run in edit mode', () => {
    const target = entered();
    target.execute({ type: 'setNodeProps', id: 't', props: { name: 'renamed' } });
    expect(key(target, 'z', { ...none, ctrl: true }, 'KeyZ')).toMatchObject({ consumed: true });
    expect(target.query({ type: 'node', id: 't' })!.name).toBe('t');
    expect(key(target, 'y', { ...none, ctrl: true }, 'KeyY')).toMatchObject({ consumed: true });
    expect(target.query({ type: 'node', id: 't' })!.name).toBe('renamed');
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 5));
  });

  it('Escape exits with the node selected; a further Escape runs exitScope', () => {
    const target = entered();
    expect(
      events(target, () => expect(key(target, 'Escape')).toMatchObject({ consumed: true })),
    ).toEqual(['textEdit']);
    expect(target.getSnapshot()).toMatchObject({ textEdit: null, selection: ['t'] });
    key(target, 'Escape');
    expect(target.getSnapshot().selection).toEqual([]);
  });

  it('a selection change to another value: selection, then textEdit', () => {
    const target = entered();
    expect(events(target, () => target.execute({ type: 'setSelection', ids: ['r'] }))).toEqual([
      'selection',
      'textEdit',
    ]);
    expect(target.getSnapshot().textEdit).toBeNull();
    const again = entered();
    expect(events(again, () => again.execute({ type: 'setSelection', ids: ['t'] }))).toEqual([]);
    expect(again.getSnapshot().textEdit).not.toBeNull();
  });

  it('setTool to another tool, keeping the selection; setTool select keeps edit mode', () => {
    const target = entered();
    expect(events(target, () => target.execute({ type: 'setTool', tool: 'select' }))).toEqual([]);
    expect(target.getSnapshot().textEdit).not.toBeNull();
    expect(events(target, () => target.execute({ type: 'setTool', tool: 'ellipse' }))).toEqual([
      'tool',
      'textEdit',
    ]);
    expect(target.getSnapshot()).toMatchObject({ textEdit: null, selection: ['t'] });
  });

  it('setScope to a different value; the same value keeps edit mode', () => {
    const target = editor();
    target.execute({ type: 'setScope', id: 'g' });
    target.execute({ type: 'enterTextEdit', id: 'tg' });
    expect(events(target, () => target.execute({ type: 'setScope', id: 'g' }))).toEqual([]);
    expect(events(target, () => target.execute({ type: 'setScope', id: null }))).toEqual([
      'scope',
      'textEdit',
    ]);
    expect(target.getSnapshot()).toMatchObject({ textEdit: null, selection: ['tg'] });
  });

  it('a page switch: activePage, selection, then textEdit', () => {
    const target = entered();
    expect(events(target, () => target.execute({ type: 'setActivePage', id: 'p2' }))).toEqual([
      'activePage',
      'selection',
      'textEdit',
    ]);
    expect(target.getSnapshot().textEdit).toBeNull();
  });

  it('loadDocument, even of the same document', () => {
    const target = entered();
    const seen = events(target, () =>
      target.execute({ type: 'loadDocument', document: fixture() }),
    );
    expect(seen.at(-1)).toBe('textEdit');
    expect(target.getSnapshot().textEdit).toBeNull();
  });

  it('deleting the node: document, selection, then textEdit', () => {
    const target = entered();
    expect(events(target, () => target.execute({ type: 'deleteNodes', ids: ['t'] }))).toEqual([
      'document:command',
      'selection',
      'textEdit',
    ]);
    expect(target.getSnapshot().textEdit).toBeNull();
  });

  it('an undo that removes the node, and a redo never enters', () => {
    const target = editor();
    const created = target.execute({
      type: 'createText',
      frame: f(0, 300, 0, 0),
      runs: [run('xy')],
    });
    const id = (created as unknown as { ids: string[] }).ids[0]!;
    target.execute({ type: 'enterTextEdit', id });
    expect(events(target, () => target.execute({ type: 'undo' }))).toEqual([
      'document:undo',
      'selection',
      'textEdit',
    ]);
    target.execute({ type: 'redo' });
    expect(target.getSnapshot().textEdit).toBeNull();
  });

  it('entering path edit mode on another node', () => {
    const target = entered();
    expect(events(target, () => target.execute({ type: 'enterPathEdit', id: 'pa' }))).toEqual([
      'selection',
      'textEdit',
      'pathEdit',
    ]);
    expect(target.getSnapshot()).toMatchObject({ textEdit: null, pathEdit: { id: 'pa' } });
    expect(events(target, () => target.execute({ type: 'enterTextEdit', id: 't' }))).toEqual([
      'selection',
      'pathEdit',
      'textEdit',
    ]);
  });

  it('another document change keeps edit mode and clamps the caret down to stops', () => {
    const target = editor();
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 5 });
    expect(
      events(target, () =>
        target.execute({ type: 'setText', id: 't', start: 2, end: 5, text: '' }),
      ),
    ).toEqual(['document:command', 'textEdit']);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2, 2));
    target.execute({ type: 'setNodeProps', id: 't', props: { name: 'renamed' } });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2, 2));
    target.execute({ type: 'undo' });
    target.execute({ type: 'undo' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2, 2));
  });
});

describe('M6b-A03 pointer in edit mode (section 4.4)', () => {
  function entered(id = 't', anchor?: number): Editor {
    const target = editor();
    target.execute({
      type: 'enterTextEdit',
      id,
      ...(anchor === undefined ? {} : { anchor }),
    });
    return target;
  }

  it('a press inside places the caret and a drag selects, with no document step', () => {
    const target = entered();
    const revision = target.getSnapshot().revision;
    expect(down(target, at(16, 25))).toMatchObject({ ok: true, consumed: true });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 1));
    expect(internalsOf(target).gesture.active).toBe(false);
    move(target, at(21, 25));
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 2));
    up(target, at(28, 25));
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 4));
    move(target, at(10, 25));
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 4));
    expect(target.getSnapshot()).toMatchObject({ revision, selection: ['t'], tool: 'select' });
    expect(target.getSnapshot().history).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(target.query({ type: 'node', id: 't' })!.frame).toEqual(f(10, 20, 22.5, 12));
  });

  it('Shift+press moves the focus only and drags from the anchor', () => {
    const target = entered('t', 1);
    down(target, at(28, 25), shift);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 4));
    move(target, at(10, 25), shift);
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 0));
    up(target, at(10, 25), shift);
  });

  it('pointercancel ends the drag and keeps the caret', () => {
    const target = entered();
    down(target, at(16, 25));
    move(target, at(28, 25));
    input(target, { kind: 'pointercancel', modifiers: none });
    move(target, at(10, 25));
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 1, 4));
  });

  it('a double-click inside selects the word at the point', () => {
    const target = entered();
    expect(doubleClick(target, at(28, 25))).toMatchObject({ ok: true, consumed: true });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 3, 5));
    doubleClick(target, at(16, 25));
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 0, 2));
  });

  it('a press on a corner handle places the caret and never resizes', () => {
    const target = entered();
    down(target, at(32.5, 32));
    move(target, at(60, 60));
    up(target, at(60, 60));
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 5, 5));
    expect(target.query({ type: 'node', id: 't' })!.frame).toEqual(f(10, 20, 22.5, 12));
    expect(target.getSnapshot().history.undoDepth).toBe(0);
  });

  it('a press in the rotate zone is outside: it exits and starts no rotation', () => {
    const target = entered();
    down(target, at(37.5, 37));
    expect(target.getSnapshot().textEdit).toBeNull();
    expect(internalsOf(target).gesture.active).toBe(false);
    move(target, at(37.5, 60));
    up(target, at(37.5, 60));
    expect(target.query({ type: 'node', id: 't' })!.rotation).toBe(0);
  });

  it('a press outside on another node exits and acts in the same input', () => {
    const target = entered();
    const seen = events(target, () =>
      expect(down(target, at(105, 105))).toMatchObject({ ok: true, consumed: true }),
    );
    expect(seen).toEqual(['textEdit', 'selection']);
    expect(target.getSnapshot()).toMatchObject({ textEdit: null, selection: ['r'] });
    expect(internalsOf(target).gesture.active).toBe(true);
    move(target, at(115, 105));
    up(target, at(115, 105));
    expect(target.query({ type: 'node', id: 'r' })!.frame).toEqual(f(110, 100, 10, 10));
  });

  it('a press outside on empty canvas exits; the click clears the selection', () => {
    const target = entered();
    down(target, at(700, 700));
    expect(target.getSnapshot().textEdit).toBeNull();
    up(target, at(700, 700));
    expect(target.getSnapshot().selection).toEqual([]);
  });

  it('an Alt+press inside places the caret and duplicates nothing', () => {
    const target = entered();
    const nodes = Object.keys(target.getSnapshot().document.nodes).length;
    down(target, at(16, 25), { ...none, alt: true });
    expect(internalsOf(target).gesture.active).toBe(false);
    move(target, at(28, 25), { ...none, alt: true });
    up(target, at(28, 25), { ...none, alt: true });
    expect(Object.keys(target.getSnapshot().document.nodes)).toHaveLength(nodes);
    expect(target.getSnapshot()).toMatchObject({ selection: ['t'], textEdit: caret('t', 1, 4) });
    expect(target.getSnapshot().history.undoDepth).toBe(0);
  });

  it('a click inside over overlapping nodes does no overlap cycling', () => {
    const target = entered();
    // `ro` lies under `t` at (16, 25); an M2 Alt-click there would cycle the selection to it.
    for (const modifiers of [none, { ...none, alt: true }]) {
      down(target, at(16, 25), modifiers);
      up(target, at(16, 25), modifiers);
      expect(target.getSnapshot()).toMatchObject({ selection: ['t'], textEdit: caret('t', 1, 1) });
    }
  });

  it('a host setText during a drag: the drag goes on from the clamped anchor', () => {
    const target = entered();
    down(target, at(28, 25));
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 4, 4));
    target.execute({ type: 'setText', id: 't', start: 2, end: 5, text: '' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2, 2));
    move(target, at(10, 25));
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2, 0));
    up(target, at(16, 25));
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 2, 1));
  });

  it('a host enterTextEdit on another node during a drag stops the drag', () => {
    const target = entered();
    down(target, at(28, 25));
    target.execute({ type: 'enterTextEdit', id: 'tn', anchor: 1 });
    move(target, at(10, 25));
    up(target, at(10, 25));
    expect(target.getSnapshot().textEdit).toEqual(caret('tn', 1, 1));
    // The tool is idle again: a press inside `tn` places its caret.
    down(target, at(222.5, 10));
    up(target, at(222.5, 10));
    expect(target.getSnapshot().textEdit).toEqual(caret('tn', 4, 4));
  });

  it('the rotated node’s box is its own: inside it but outside its frame keeps edit mode', () => {
    const target = entered('tr');
    // Page (61.25, 66) is local (21.25, 6): inside the rotated box, below the stored frame.
    down(target, at(61.25, 66));
    up(target, at(61.25, 66));
    expect(target.getSnapshot().textEdit).toEqual(caret('tr', 5, 5));
  });
});

describe('M6b-A03 textEditOverlay literal values (section 4.5)', () => {
  function overlay(id: string, anchor: number, focus: number): TextEditOverlay | null {
    const target = editor();
    target.execute({ type: 'enterTextEdit', id, anchor, focus });
    return target.query({ type: 'textEditOverlay' });
  }

  it('a page-root node: collapsed caret, exact', () => {
    const value = overlay('t', 2, 2);
    expect(value).toEqual({
      id: 't',
      caret: [at(20, 20), at(20, 32)],
      selection: [],
      composition: [],
      inputRect: { x: 20, y: 20, height: 12 },
    });
    expect(Object.isFrozen(value)).toBe(true);
  });

  it('a page-root node: a selection gives quads and no caret', () => {
    expect(overlay('t', 4, 1)).toEqual({
      id: 't',
      caret: null,
      selection: [[at(15, 20), at(27.5, 20), at(27.5, 32), at(15, 32)]],
      composition: [],
      inputRect: { x: 15, y: 20, height: 12 },
    });
  });

  it('a nested node maps through its frame', () => {
    expect(overlay('tn', 1, 4)).toEqual({
      id: 'tn',
      caret: null,
      selection: [[at(210, 6), at(222.5, 6), at(222.5, 18), at(210, 18)]],
      composition: [],
      inputRect: { x: 222.5, y: 6, height: 12 },
    });
  });

  it('a rotated node maps about its centre', () => {
    const value = overlay('tr', 0, 5)!;
    const close = (p: PagePoint, x: number, y: number) => {
      expect(p.x).toBeCloseTo(x, 12);
      expect(p.y).toBeCloseTo(y, 12);
    };
    expect(value.caret).toBeNull();
    const [quad] = value.selection;
    close(quad![0], 67.25, 44.75);
    close(quad![1], 67.25, 67.25);
    close(quad![2], 55.25, 67.25);
    close(quad![3], 55.25, 44.75);
    // The focus caret at 5 runs from local (22.5, 0) to (22.5, 12).
    expect(value.inputRect.x).toBeCloseTo(55.25, 12);
    expect(value.inputRect.y).toBeCloseTo(67.25, 12);
    expect(value.inputRect.height).toBeCloseTo(0, 12);
    const collapsed = overlay('tr', 0, 0)!;
    close(collapsed.caret![0], 67.25, 44.75);
    close(collapsed.caret![1], 55.25, 44.75);
  });

  it('a pending node: its empty layout in its style at its frame', () => {
    const port = createFakeTextLayout();
    const pending: TextEditPending = {
      parent: 'p1',
      index: 0,
      frame: f(30, 40, 0, 19.2),
      sizing: 'autoWidth',
      style: DEFAULT_TEXT_STYLE,
    };
    const request = pendingRequest(pending);
    expect(request).toEqual({
      runs: [{ text: '', family: 'Arial', size: 16 }],
      width: null,
      align: 'left',
      letterSpacing: 0,
      lineHeight: 1.2,
    });
    const target = pendingTarget(pending, createCaretModel(request, port.layout(request)));
    const state: TextEditState = {
      id: null,
      pending,
      anchor: 0,
      focus: 0,
      affinity: 'downstream',
      composition: null,
    };
    expect(textEditOverlay(target, state)).toEqual({
      id: null,
      caret: [at(30, 40), at(30, 59.2)],
      selection: [],
      composition: [],
      // The height is taken in page space, from the segment's page ends.
      inputRect: { x: 30, y: 40, height: 59.2 - 40 },
    });
    // The pending box grows by the handle radius for presses (section 4.4).
    expect(insideTarget(target, at(25, 45), 0)).toBe(false);
    expect(insideTarget(target, at(25, 45), 6)).toBe(true);
    expect(insideTarget(target, at(37, 45), 6)).toBe(false);
  });

  it('follows the caret and the layout generation without a textEdit event', () => {
    const port = createFakeTextLayout();
    const target = editor(port);
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 1 });
    const first = target.query({ type: 'textEditOverlay' });
    expect(first!.caret).toEqual([at(15, 20), at(15, 32)]);
    expect(events(target, () => port.bump())).toEqual(['textLayout']);
    expect(target.query({ type: 'textEditOverlay' })).toEqual(first);
    expect(target.query({ type: 'textEditOverlay' })).not.toBe(first);
  });

  it('rebuilds the caret model when the layout changes', () => {
    const target = editor();
    target.execute({ type: 'enterTextEdit', id: 't', anchor: 4 });
    expect(target.query({ type: 'textEditOverlay' })!.caret).toEqual([at(27.5, 20), at(27.5, 32)]);
    // "xyab cd": offset 4 is now the space, at x 20.
    target.execute({ type: 'setText', id: 't', start: 0, end: 0, text: 'xy' });
    expect(target.getSnapshot().textEdit).toEqual(caret('t', 4, 4));
    expect(target.query({ type: 'textEditOverlay' })!.caret).toEqual([at(30, 20), at(30, 32)]);
    // 7, past the old length, is a stop of the new model.
    expect(target.execute({ type: 'setTextSelection', anchor: 7, focus: 7 })).toEqual({
      ok: true,
      ids: [],
    });
    expect(target.query({ type: 'textEditOverlay' })!.caret).toEqual([at(42.5, 20), at(42.5, 32)]);
  });
});
