import path from 'node:path';
import type { TextLayoutPort } from '@vector-studio/contracts';
import {
  MAX_TEXT_LENGTH,
  type Color,
  type DocumentV6,
  type Frame,
  type PersistenceEnvelope,
} from '@vector-studio/model';
import { createAutosave, type DocumentStore } from '@vector-studio/persistence-idb';
import { describe, expect, it, vi } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  DEFAULT_KEYMAP,
  type Command,
  type Editor,
  type EditorEvent,
  type Modifiers,
  type PagePoint,
  type TextEditPending,
  type TextEditState,
} from '../../packages/editor-core/src/index.js';
import { TOOL_NAMES } from '../../packages/editor-core/src/keymap.js';
import { samePending } from '../../packages/editor-core/src/text-edit.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// MVP M6b-U3, M6b-A04 (docs/plans/mvp-m6b-text-editing-contract.md, sections 3.2, 3.3 and
// 7.1): the text tool's click and drag pending nodes, its press on a text node, the first
// `textinput` or Enter creating the node in one step, an abandoned pending node leaving no node,
// no history entry and no autosave write (the M5 autosave double with the next-host M5-S2 event
// mapping), the tool being `select` after entry (M6b-Q5 (a)), the session `textStyle`
// (M6b-Q7 (a)) and the `T` binding. Also the items M6b-U2 left to this unit: a press on a
// pending node through the editor and the pending exit rule (`pendingParentHolds` and the empty
// selection) for a deleted parent, a parent undone away, a page switch and a non-empty
// selection; and a selection drag noticing a switch from one pending node to another. Layouts
// come from the fake port: `a` to `z` advance 0.5 em, a space 0.25 em, a line is 1.2 times its
// size, so an empty Arial 16 layout is 19.2 high.

const root = path.resolve(import.meta.dirname, '../..');
const persistence = (await import(path.join(root, 'apps/next-host/src/m5-persistence.ts'))) as {
  schedulesWrite: (event: EditorEvent) => boolean;
  persistenceEnvelope: (editor: Editor) => PersistenceEnvelope;
};

const START = { horizontal: 'start', vertical: 'start' } as const;
const black: Color = { r: 0, g: 0, b: 0, a: 1 };
const red: Color = { r: 1, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });
const ARIAL = { family: 'Arial', size: 16, color: black } as const;

type Loose = Record<string, unknown> & { id: string };

function base(id: string, parent: string, frame: Frame) {
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

function text(id: string, parent: string, frame: Frame, content = 'ab cd'): Loose {
  return {
    ...base(id, parent, frame),
    type: 'text',
    runs: [{ text: content, family: 'Test', size: 10, color: black }],
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

/**
 * Page `p1`: `t` "ab cd" at (10, 20), stops 0 to 5 at x 10, 15, 20, 22.5, 27.5 and 32.5; `r` a
 * rectangle at (100, 100); group `g` holding `tg` at (0, 80); frame `fr` at (200, 0), empty.
 * Page `p2`: rectangle `r2`.
 */
function fixture(): DocumentV6 {
  const nodes: Loose[] = [
    text('t', 'p1', f(10, 20, 22.5, 12)),
    rect('r', 'p1', f(100, 100, 10, 10)),
    { ...base('g', 'p1', f(0, 80, 22.5, 12)), type: 'group', children: ['tg'] },
    text('tg', 'g', f(0, 0, 22.5, 12)),
    {
      ...base('fr', 'p1', f(200, 0, 100, 100)),
      type: 'frame',
      children: [],
      fill: black,
      stroke: null,
    },
    rect('r2', 'p2', f(0, 0, 10, 10)),
  ];
  return {
    schemaVersion: 6,
    id: 'doc',
    pages: [
      { id: 'p1', name: 'Page 1', children: ['t', 'r', 'g', 'fr'] },
      { id: 'p2', name: 'Page 2', children: ['r2'] },
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

const input = (target: Editor, event: unknown) =>
  target.execute({ type: 'input', event } as Command);
const down = (target: Editor, point: PagePoint, modifiers = none) =>
  input(target, { kind: 'pointerdown', point, modifiers });
const move = (target: Editor, point: PagePoint, modifiers = none) =>
  input(target, { kind: 'pointermove', point, modifiers });
const up = (target: Editor, point: PagePoint, modifiers = none) =>
  input(target, { kind: 'pointerup', point, modifiers });
const key = (target: Editor, value: string, modifiers = none) =>
  input(target, { kind: 'keydown', key: value, modifiers });
const type = (target: Editor, value: string) => input(target, { kind: 'textinput', text: value });

/** A text tool click at `point`. */
function click(target: Editor, point: PagePoint) {
  target.execute({ type: 'setTool', tool: 'text' });
  down(target, point);
  return up(target, point);
}

function pendingState(pending: TextEditPending): TextEditState {
  return { id: null, pending, anchor: 0, focus: 0, affinity: 'downstream', composition: null };
}

function caret(id: string, anchor: number, focus = anchor): TextEditState {
  return { id, pending: null, anchor, focus, affinity: 'downstream', composition: null };
}

const history = (target: Editor) => target.query({ type: 'history' });
const pageChildren = (target: Editor, page = 'p1') =>
  target.query({ type: 'pages' }).find((entry) => entry.id === page)!.children;

describe('M6b-A04 the text tool and its binding', () => {
  it('is a built-in tool bound to T', () => {
    expect(TOOL_NAMES).toContain('text');
    expect(DEFAULT_KEYMAP).toContainEqual({
      chord: 'T',
      action: 'setTool',
      args: { tool: 'text' },
    });
    const target = editor();
    expect(key(target, 't')).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'tool' })).toBe('text');
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(key(target, 'v')).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'tool' })).toBe('select');
  });

  it('without a port its press fails with editor.no-text-layout and changes nothing', () => {
    const target = editor(null);
    expect(target.execute({ type: 'setTool', tool: 'text' })).toEqual({ ok: true, ids: [] });
    const before = target.getSnapshot();
    expect(down(target, at(50, 60))).toEqual({
      ok: false,
      code: 'editor.no-text-layout',
      consumed: false,
    });
    expect(up(target, at(50, 60))).toEqual({ ok: true, ids: [], consumed: false });
    // Also on a text node, and navigation still pans.
    expect(down(target, at(15, 25)).ok).toBe(false);
    expect(target.getSnapshot()).toBe(before);
    expect(
      input(target, { kind: 'pointerdown', point: at(0, 0), modifiers: none, button: 1 }),
    ).toMatchObject({ ok: true, consumed: true });
  });
});

describe('M6b-A04 click and drag pending nodes (section 3.2)', () => {
  it('a click makes a pending autoWidth node with a zero-width frame at the point', () => {
    const target = editor();
    target.execute({ type: 'setSelection', ids: ['r'] });
    target.execute({ type: 'setTool', tool: 'text' });
    const document = target.query({ type: 'document' });
    expect(down(target, at(50, 60))).toEqual({ ok: true, ids: [], consumed: true });
    // The press alone is not edit mode yet: the press ends at release.
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(target.query({ type: 'tool' })).toBe('text');
    let result: unknown;
    expect(events(target, () => (result = up(target, at(50, 60))))).toEqual([
      'tool',
      'selection',
      'textEdit',
    ]);
    expect(result).toEqual({ ok: true, ids: [], consumed: true });
    const pending: TextEditPending = {
      parent: 'p1',
      index: 4,
      frame: f(50, 60, 0, 19.2),
      sizing: 'autoWidth',
      style: ARIAL,
    };
    expect(target.query({ type: 'textEdit' })).toEqual(pendingState(pending));
    expect(Object.isFrozen(target.query({ type: 'textEdit' })!.pending)).toBe(true);
    expect(target.getSnapshot().textEdit).toEqual(pendingState(pending));
    // One-shot (M6b-Q5 (a)); the selection is empty while pending (M6b-S1); nothing created.
    expect(target.query({ type: 'tool' })).toBe('select');
    expect(target.query({ type: 'selection' })).toEqual([]);
    expect(target.query({ type: 'handles' })).toBeNull();
    expect(target.query({ type: 'document' })).toBe(document);
    expect(history(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
    // The caret is drawn from the empty layout in `textStyle` (section 4.3).
    expect(target.query({ type: 'textEditOverlay' })).toEqual({
      id: null,
      caret: [at(50, 60), at(50, 60 + 19.2)],
      selection: [],
      composition: [],
      inputRect: { x: 50, y: 60, height: 60 + 19.2 - 60 },
    });
  });

  it('a drag makes a pending autoHeight node of the box width at its top-left', () => {
    const target = editor();
    target.execute({ type: 'setSnapping', enabled: false });
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(50, 60));
    expect(move(target, at(70, 80))).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'textEdit' })).toBeNull();
    // The up point is the box's other corner: the box is (50, 50) to (90, 60).
    up(target, at(90, 50));
    expect(target.query({ type: 'textEdit' })).toEqual(
      pendingState({
        parent: 'p1',
        index: 4,
        frame: f(50, 50, 40, 19.2),
        sizing: 'autoHeight',
        style: ARIAL,
      }),
    );
    expect(target.query({ type: 'tool' })).toBe('select');
    expect(history(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it('a raw movement under SNAP_PX / zoom is a click, also beside a snap candidate', () => {
    const target = editor();
    // Hand jitter of 0.5 makes no 0.5-wide autoHeight node.
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(50, 60));
    move(target, at(50.5, 60.5));
    up(target, at(50.5, 60.5));
    expect(target.query({ type: 'textEdit' })!.pending).toMatchObject({
      frame: f(50, 60, 0, 19.2),
      sizing: 'autoWidth',
    });
    key(target, 'Escape');
    // 5.9 of the 6 page units at zoom 1 is a click; 6 is a drag.
    target.execute({ type: 'setSnapping', enabled: false });
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(50, 60));
    up(target, at(55.9, 60));
    expect(target.query({ type: 'textEdit' })!.pending!.sizing).toBe('autoWidth');
    key(target, 'Escape');
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(50, 60));
    up(target, at(56, 60));
    expect(target.query({ type: 'textEdit' })!.pending).toMatchObject({
      frame: f(50, 60, 6, 19.2),
      sizing: 'autoHeight',
    });
    key(target, 'Escape');
    // At zoom 2 the threshold is 3 page units.
    target.execute({ type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 2 } });
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(50, 60));
    up(target, at(53, 60));
    expect(target.query({ type: 'textEdit' })!.pending!.sizing).toBe('autoHeight');
  });

  it('a click with snapping on beside a candidate makes an autoWidth node at the point', () => {
    const target = editor();
    expect(target.query({ type: 'snapping' })).toBe(true);
    // 3 page units left of the rectangle's edge at x 100, inside the snap threshold.
    click(target, at(97, 50));
    expect(target.query({ type: 'snap' })).toBeNull();
    type(target, 'hello');
    expect(target.query({ type: 'node', id: 'n1' })).toMatchObject({
      frame: f(97, 50, 40, 19.2),
      sizing: 'autoWidth',
    });
  });

  it('a drag of width 0 is a click at the press point', () => {
    const target = editor();
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(50, 60));
    move(target, at(50, 90));
    up(target, at(50, 90));
    expect(target.query({ type: 'textEdit' })!.pending).toEqual({
      parent: 'p1',
      index: 4,
      frame: f(50, 60, 0, 19.2),
      sizing: 'autoWidth',
      style: ARIAL,
    });
  });

  it("the dragged corner snaps as the box tools' does, and the overlay clears at release", () => {
    const target = editor();
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(50, 60));
    // Within 6 page units of the rectangle's left edge at x 100.
    move(target, at(97, 140));
    expect(target.query({ type: 'snap' })).not.toBeNull();
    up(target, at(97, 140));
    expect(target.query({ type: 'snap' })).toBeNull();
    expect(target.query({ type: 'textEdit' })!.pending!.frame).toEqual(f(50, 60, 50, 19.2));
  });

  it('takes the session textStyle (M6b-Q7 (a))', () => {
    const target = editor();
    const style = { family: 'Noto', size: 20, color: red };
    target.execute({ type: 'setTextToolStyle', style });
    click(target, at(50, 60));
    expect(target.query({ type: 'textEdit' })!.pending).toEqual({
      parent: 'p1',
      index: 4,
      frame: f(50, 60, 0, 24),
      sizing: 'autoWidth',
      style,
    });
    type(target, 'ab');
    const id = target.query({ type: 'selection' })[0]!;
    const node = target.query({ type: 'node', id });
    expect(node).toMatchObject({ type: 'text', runs: [{ text: 'ab', ...style }] });
  });

  it('in a scope the parent is the scope and the index its top', () => {
    const target = editor();
    target.execute({ type: 'setScope', id: 'fr' });
    click(target, at(210, 10));
    expect(target.query({ type: 'textEdit' })!.pending).toMatchObject({
      parent: 'fr',
      index: 0,
      frame: f(210, 10, 0, 19.2),
    });
    expect(target.query({ type: 'scope' })).toBe('fr');
    type(target, 'ab');
    const id = target.query({ type: 'selection' })[0]!;
    // The page-space frame is mapped into the frame's space (M1 section 4.1).
    expect(target.query({ type: 'node', id })).toMatchObject({
      parent: 'fr',
      frame: f(10, 10, 16, 19.2),
    });
    expect(target.query({ type: 'scope' })).toBe('fr');
    expect(target.query({ type: 'textEdit' })).toEqual(caret(id, 2));
  });

  it('Escape or pointercancel during the press drops it, and the tool stays text', () => {
    const target = editor();
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(50, 60));
    expect(key(target, 'Escape')).toEqual({ ok: true, ids: [], consumed: true });
    expect(up(target, at(50, 60))).toEqual({ ok: true, ids: [], consumed: false });
    down(target, at(50, 60));
    input(target, { kind: 'pointercancel', modifiers: none });
    up(target, at(50, 60));
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(target.query({ type: 'tool' })).toBe('text');
  });
});

describe('M6b-A04 the press on a text node (section 3.2)', () => {
  it('enters edit mode at the point and drag-selects; the tool becomes select', () => {
    const target = editor();
    target.execute({ type: 'setTool', tool: 'text' });
    const document = target.query({ type: 'document' });
    let result: unknown;
    expect(events(target, () => (result = down(target, at(15.5, 25))))).toEqual([
      'tool',
      'selection',
      'textEdit',
    ]);
    expect(result).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'tool' })).toBe('select');
    expect(target.query({ type: 'selection' })).toEqual(['t']);
    expect(target.query({ type: 'textEdit' })).toEqual(caret('t', 1));
    // The rest of the press is the select tool's selection drag (section 4.4).
    move(target, at(27, 25));
    up(target, at(27, 25));
    expect(target.query({ type: 'textEdit' })).toEqual(caret('t', 1, 4));
    expect(target.query({ type: 'document' })).toBe(document);
    expect(history(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it('a hit in the stroke tolerance outside the box enters, clamped into the box', () => {
    const target = editor();
    target.execute({ type: 'setTool', tool: 'text' });
    const document = target.query({ type: 'document' });
    // 2 page units left of `t` (x 10), inside the hit tolerance of 4 / zoom.
    down(target, at(8, 25));
    expect(target.query({ type: 'textEdit' })).toEqual(caret('t', 0));
    move(target, at(40, 60));
    up(target, at(40, 60));
    // The select tool drag-selected; it neither left edit mode nor moved the node.
    expect(target.query({ type: 'textEdit' })).toEqual(caret('t', 0, 5));
    expect(target.query({ type: 'document' })).toBe(document);
    expect(target.query({ type: 'node', id: 't' })).toMatchObject({ frame: f(10, 20, 22.5, 12) });
    expect(history(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it.each([0.3, -0.7, 1])(
    'on a node rotated by %s, a hit in the tolerance band on each edge stays inside',
    async (angle) => {
      const { nodePlacement } = await import('../../packages/editor-core/src/path-edit.js');
      const target = editor();
      target.execute({ type: 'rotateNodes', ids: ['t'], angle });
      const node = target.query({ type: 'node', id: 't' })!;
      const depth = history(target);
      const { toPage } = nodePlacement(target.query({ type: 'document' }), node);
      // Node-local points 2 units outside the top, left, right and bottom edges and a corner,
      // inside the hit tolerance of 4 / zoom; the probes the review found rounding outside.
      for (const local of [at(11, -2), at(-2, 6), at(24.5, 6), at(11, 14), at(23.5, 13)]) {
        const point = toPage(local);
        target.execute({ type: 'setTool', tool: 'text' });
        down(target, point);
        up(target, point);
        expect(target.query({ type: 'textEdit' })?.id).toBe('t');
        expect(target.query({ type: 'node', id: 't' })).toBe(node);
        expect(history(target)).toEqual(depth);
        target.execute({ type: 'exitTextEdit' });
      }
    },
  );

  it('enters a text node inside a group directly, leaving a scope it is outside of', () => {
    const target = editor();
    target.execute({ type: 'setScope', id: 'fr' });
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(1, 85));
    up(target, at(1, 85));
    expect(target.query({ type: 'scope' })).toBeNull();
    expect(target.query({ type: 'textEdit' })).toEqual(caret('tg', 0));
  });
});

describe('M6b-A04 the first text creates the node in one step (section 7.1)', () => {
  it('a textinput runs createText in the pending style; undo removes the node', () => {
    const target = editor();
    click(target, at(50, 60));
    let result: unknown;
    expect(events(target, () => (result = type(target, 'ab')))).toEqual([
      'document:command',
      'selection',
      'textEdit',
    ]);
    expect(result).toEqual({ ok: true, ids: ['n1'], consumed: true });
    expect(target.query({ type: 'node', id: 'n1' })).toEqual({
      id: 'n1',
      name: 'Text',
      parent: 'p1',
      frame: f(50, 60, 16, 19.2),
      rotation: 0,
      constraints: START,
      opacity: 1,
      visible: true,
      type: 'text',
      runs: [{ text: 'ab', ...ARIAL }],
      sizing: 'autoWidth',
      align: 'left',
      letterSpacing: 0,
      lineHeight: 1.2,
    });
    expect(pageChildren(target)).toEqual(['t', 'r', 'g', 'fr', 'n1']);
    expect(history(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(target.query({ type: 'selection' })).toEqual(['n1']);
    expect(target.query({ type: 'textEdit' })).toEqual(caret('n1', 2));
    expect(target.query({ type: 'tool' })).toBe('select');
    // Typing goes on in the created node (merging is M6b-U5's).
    type(target, 'c');
    expect(target.query({ type: 'node', id: 'n1' })).toMatchObject({
      runs: [{ text: 'abc', ...ARIAL }],
    });
    expect(target.query({ type: 'textEdit' })).toEqual(caret('n1', 3));
    target.execute({ type: 'undo' });
    target.execute({ type: 'undo' });
    expect(target.query({ type: 'node', id: 'n1' })).toBeNull();
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(history(target)).toEqual({ undoDepth: 0, redoDepth: 2 });
    // Redo brings the node back without entering edit mode (section 8.3).
    target.execute({ type: 'redo' });
    expect(target.query({ type: 'node', id: 'n1' })).not.toBeNull();
    expect(target.query({ type: 'textEdit' })).toBeNull();
  });

  it('a drag pending node is created autoHeight at its width', () => {
    const target = editor();
    target.execute({ type: 'setSnapping', enabled: false });
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(50, 50));
    up(target, at(90, 70));
    // "ab ab " fills 36 of the 40 units, so the last "ab" wraps to a second line.
    type(target, 'ab ab ab');
    expect(target.query({ type: 'node', id: 'n1' })).toMatchObject({
      frame: f(50, 50, 40, 38.4),
      sizing: 'autoHeight',
      runs: [{ text: 'ab ab ab' }],
    });
    expect(target.query({ type: 'textEdit' })).toEqual(caret('n1', 8));
    expect(history(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
  });

  it('Enter creates the node with an LF; Backspace and Delete are consumed no-ops', () => {
    const target = editor();
    click(target, at(50, 60));
    const pending = target.query({ type: 'textEdit' });
    expect(key(target, 'Backspace')).toEqual({ ok: true, ids: [], consumed: true });
    expect(key(target, 'Delete')).toEqual({ ok: true, ids: [], consumed: true });
    // An input that is empty after normalization is a consumed no-op too.
    expect(type(target, '\u0000')).toEqual({ ok: true, ids: [], consumed: true });
    expect(target.query({ type: 'textEdit' })).toBe(pending);
    expect(history(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(key(target, 'Enter')).toEqual({ ok: true, ids: ['n1'], consumed: true });
    expect(target.query({ type: 'node', id: 'n1' })).toMatchObject({
      runs: [{ text: '\n', ...ARIAL }],
      frame: f(50, 60, 0, 38.4),
    });
    expect(target.query({ type: 'textEdit' })).toEqual(caret('n1', 1));
    expect(history(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
  });

  it('normalizes the first text (section 9.1)', () => {
    const target = editor();
    click(target, at(50, 60));
    type(target, 'a\tb\r\n');
    expect(target.query({ type: 'node', id: 'n1' })).toMatchObject({
      runs: [{ text: 'a b\n' }],
    });
    expect(target.query({ type: 'textEdit' })).toEqual(caret('n1', 4));
  });

  it('a first text over the length bound fails and keeps the pending node', () => {
    const target = editor();
    click(target, at(50, 60));
    const pending = target.query({ type: 'textEdit' });
    const document = target.query({ type: 'document' });
    const result = type(target, 'a'.repeat(MAX_TEXT_LENGTH + 1));
    expect(result).toMatchObject({ ok: false, code: 'document.invalid-field', consumed: false });
    expect(target.query({ type: 'textEdit' })).toBe(pending);
    expect(target.query({ type: 'document' })).toBe(document);
    expect(history(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it('the index is clamped when the parent lost children since the press', () => {
    const target = editor();
    click(target, at(50, 60));
    expect(target.query({ type: 'textEdit' })!.pending!.index).toBe(4);
    // A host command that changes no selection keeps edit mode.
    target.execute({ type: 'deleteNodes', ids: ['r'] });
    expect(target.query({ type: 'textEdit' })).not.toBeNull();
    type(target, 'a');
    expect(pageChildren(target)).toEqual(['t', 'g', 'fr', 'n1']);
  });
});

describe('M6b-A04 an abandoned pending node leaves nothing (section 3.3, M6-Q19 (a))', () => {
  it.each<[string, (target: Editor) => void, readonly string[]]>([
    ['Escape', (target) => key(target, 'Escape'), []],
    ['exitTextEdit', (target) => target.execute({ type: 'exitTextEdit' }), []],
    ['setTool', (target) => target.execute({ type: 'setTool', tool: 'rectangle' }), []],
    // The press outside then runs the select tool's rules in the same input (M6b-Q6 (a)).
    [
      'a press outside',
      (target) => {
        down(target, at(105, 105));
        up(target, at(105, 105));
      },
      ['r'],
    ],
  ])('on %s', (_, leave, selection) => {
    const target = editor();
    const document = target.query({ type: 'document' });
    click(target, at(50, 60));
    leave(target);
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(target.query({ type: 'document' })).toBe(document);
    expect(target.query({ type: 'revision' })).toBe(0);
    expect(history(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(target.query({ type: 'selection' })).toEqual(selection);
  });

  it('a press inside the grown box keeps the pending node (section 4.4)', () => {
    const target = editor();
    click(target, at(50, 60));
    const pending = target.query({ type: 'textEdit' });
    // The box (50, 60) to (50, 79.2) grown by HANDLE_RADIUS / zoom = 6.
    expect(down(target, at(45, 70))).toEqual({ ok: true, ids: [], consumed: true });
    move(target, at(70, 70));
    up(target, at(70, 70));
    expect(target.query({ type: 'textEdit' })).toBe(pending);
    target.execute({ type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 2 } });
    // At zoom 2 the box grows by 3 only.
    down(target, at(46, 70));
    expect(target.query({ type: 'textEdit' })).toBeNull();
  });

  it('writes nothing to autosave; the creating text writes once', async () => {
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
    const target = editor();
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
    const empty = { undoDepth: 0, redoDepth: 0 };
    click(target, at(50, 60));
    key(target, 'Escape');
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(history(target)).toEqual(empty);
    // Also with a drag, a press inside and an outside press.
    target.execute({ type: 'setTool', tool: 'text' });
    down(target, at(50, 60));
    up(target, at(90, 70));
    expect(target.query({ type: 'textEdit' })!.pending!.sizing).toBe('autoHeight');
    expect(history(target)).toEqual(empty);
    down(target, at(60, 65));
    up(target, at(60, 65));
    expect(target.query({ type: 'textEdit' })).not.toBeNull();
    down(target, at(400, 400));
    up(target, at(400, 400));
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(history(target)).toEqual(empty);
    await autosave.flush();
    expect(scheduled).toEqual([]);
    expect(writes).toEqual([]);
    click(target, at(50, 60));
    type(target, 'ab');
    await autosave.flush();
    expect(scheduled).toHaveLength(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.nodes['n1']).toMatchObject({ runs: [{ text: 'ab' }] });
  });
});

describe('M6b-A03 the pending exit rule through the editor (section 3.3, owed by M6b-U2)', () => {
  /** A pending node in frame `fr`'s scope. */
  function inFrame(target: Editor) {
    target.execute({ type: 'setScope', id: 'fr' });
    click(target, at(210, 10));
    expect(target.query({ type: 'textEdit' })!.pending!.parent).toBe('fr');
  }

  it('ends when its parent is deleted', () => {
    const target = editor();
    inFrame(target);
    expect(events(target, () => target.execute({ type: 'deleteNodes', ids: ['fr'] }))).toEqual([
      'document:command',
      'scope',
      'textEdit',
    ]);
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(Object.values(target.query({ type: 'document' }).nodes).map((n) => n.id)).not.toContain(
      'n1',
    );
    expect(history(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
  });

  it('ends when its parent is undone away', () => {
    const target = editor();
    const created = target.execute({ type: 'createFrame', frame: f(400, 0, 50, 50) });
    const id = created.ok ? created.ids[0]! : '';
    target.execute({ type: 'setScope', id });
    click(target, at(410, 10));
    expect(target.query({ type: 'textEdit' })!.pending!.parent).toBe(id);
    target.execute({ type: 'undo' });
    expect(target.query({ type: 'node', id })).toBeNull();
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(history(target)).toEqual({ undoDepth: 0, redoDepth: 1 });
    // Redo brings the frame back, not the pending node.
    target.execute({ type: 'redo' });
    expect(target.query({ type: 'textEdit' })).toBeNull();
  });

  it('stays through a document change that keeps its parent', () => {
    // The deletion above clears the scope itself (not through `setScope`), so the parent rule
    // is what ends edit mode there.
    const target = editor();
    inFrame(target);
    target.execute({ type: 'setNodeProps', id: 'fr', props: { name: 'renamed' } });
    expect(target.query({ type: 'textEdit' })!.pending!.parent).toBe('fr');
  });

  it('ends on a page switch', () => {
    const target = editor();
    click(target, at(50, 60));
    expect(events(target, () => target.execute({ type: 'setActivePage', id: 'p2' }))).toContain(
      'textEdit',
    );
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(target.query({ type: 'activePage' })).toBe('p2');
    expect(history(target)).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it('ends on a non-empty selection, which it keeps', () => {
    const target = editor();
    click(target, at(50, 60));
    expect(events(target, () => target.execute({ type: 'setSelection', ids: ['r'] }))).toEqual([
      'selection',
      'textEdit',
    ]);
    expect(target.query({ type: 'textEdit' })).toBeNull();
    expect(target.query({ type: 'selection' })).toEqual(['r']);
    // An empty selection keeps it.
    click(target, at(50, 60));
    target.execute({ type: 'setSelection', ids: [] });
    expect(target.query({ type: 'textEdit' })).not.toBeNull();
  });
});

describe('the selection drag and a switch between pending nodes (owed by M6b-U2)', () => {
  it('compares pending nodes by their fields', () => {
    const a: TextEditPending = {
      parent: 'p1',
      index: 4,
      frame: f(50, 60, 0, 19.2),
      sizing: 'autoWidth',
      style: ARIAL,
    };
    expect(samePending(a, { ...a, frame: { ...a.frame } })).toBe(true);
    expect(samePending(a, { ...a, frame: f(51, 60, 0, 19.2) })).toBe(false);
    expect(samePending(a, null)).toBe(false);
    expect(samePending(null, null)).toBe(true);
  });

  it('stops when edit mode moves to another pending node during the drag', async () => {
    const { internalsOf } = await import('../../packages/editor-core/src/editor.js');
    const target = editor();
    click(target, at(50, 60));
    // A selection drag on the first pending node.
    down(target, at(50, 65));
    const internals = internalsOf(target) as unknown as {
      tools: Map<string, { input(event: unknown, context: unknown): boolean }>;
      gesture: unknown;
    };
    // The text tool starts a second pending node while the select tool still drags: no public
    // path does this (a tool switch resets the select tool), so the text tool runs directly.
    const context = {
      execute: (command: Command) => target.execute(command),
      query: (query: Parameters<Editor['query']>[0]) => target.query(query),
      gesture: internals.gesture,
      snap: () => undefined,
    };
    const tool = internals.tools.get('text')!;
    tool.input({ kind: 'pointerdown', point: at(150, 150), modifiers: none }, context);
    tool.input({ kind: 'pointerup', point: at(150, 150), modifiers: none }, context);
    expect(target.query({ type: 'textEdit' })!.pending!.frame).toEqual(f(150, 150, 0, 19.2));
    const spy = vi.spyOn(target, 'execute');
    move(target, at(150, 155));
    up(target, at(150, 155));
    const selections = spy.mock.calls.filter(([command]) => command.type === 'setTextSelection');
    expect(selections).toEqual([]);
    spy.mockRestore();
  });
});
