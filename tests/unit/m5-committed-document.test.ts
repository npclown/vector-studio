import { serializeDocument, type DocumentV4, type Frame } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
  type ExtensionTool,
  type Modifiers,
  type PagePoint,
  type Query,
} from '@vector-studio/editor-core';

// MVP M5-U2, M5-A07 (M5 contract, section 4.3, M5-S3): the additive `committedDocument` query
// returns the active gesture's pre-gesture document while a gesture is active (through `update`,
// through `replace`, and a `replace` back to the base), the committed or current document once
// the gesture commits, cancels or a host command cancels it, and the current document outside a
// gesture. The value is frozen, the query raises no event, and every other query, the revision
// and the snapshot are unchanged by it. Through the package entry points only.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const red = { r: 1, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });

function rect(id: string, frame: Frame) {
  return {
    id,
    name: id,
    parent: 'p1',
    frame,
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
  };
}

/** Page p1 with the rectangles `a` (0, 0, 100, 100) and `b` (300, 0, 50, 50); page p2 empty. */
const FIXTURE = {
  schemaVersion: 2,
  id: 'doc',
  pages: [
    { id: 'p1', name: 'p1', children: ['a', 'b'] },
    { id: 'p2', name: 'p2', children: [] },
  ],
  nodes: { a: rect('a', f(0, 0, 100, 100)), b: rect('b', f(300, 0, 50, 50)) },
};

/**
 * `ext.slide`: on press it begins a gesture; each move `replace`s with `nudgeNodes` of `a` by
 * the offset from the press (an offset of zero replaces with no command, back to the base); a
 * release commits and Escape cancels.
 */
function slideTool(): ExtensionTool {
  let start: PagePoint | null = null;
  return {
    id: 'ext.slide',
    input(event, api) {
      if (event.kind === 'pointerdown') {
        if (!api.gesture.begin()) return false;
        start = event.point;
        return true;
      }
      if (start === null) return false;
      if (event.kind === 'pointermove') {
        const dx = event.point.x - start.x;
        const dy = event.point.y - start.y;
        api.gesture.replace(
          dx === 0 && dy === 0 ? [] : [{ type: 'nudgeNodes', ids: ['a'], dx, dy }],
        );
        return true;
      }
      if (event.kind === 'pointerup') {
        api.gesture.commit();
        start = null;
        return true;
      }
      if (event.kind === 'keydown' && event.key === 'Escape') {
        api.gesture.cancel();
        start = null;
        return true;
      }
      return false;
    },
    reset() {
      start = null;
    },
  };
}

function editor(): Editor {
  const target = createEditor({
    ids: createCounterIdSource('n'),
    document: FIXTURE,
    extensions: [{ id: 'ext.slide', tools: [slideTool()] }],
  });
  ok(target, { type: 'setSnapping', enabled: false });
  return target;
}

function ok(target: Editor, command: Command): void {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  point: PagePoint,
): void {
  ok(target, { type: 'input', event: { kind, point, modifiers: none } });
}

function committed(target: Editor): DocumentV4 {
  return target.query({ type: 'committedDocument' });
}

function frameOf(document: DocumentV4, id: string): Frame {
  return document.nodes[id]!.frame;
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

function record(target: Editor): EditorEvent[] {
  const events: EditorEvent[] = [];
  target.subscribe((event) => events.push(event));
  return events;
}

const ORIGIN = serializeDocument(createEditor({ document: FIXTURE }).query({ type: 'document' }));

describe('M5-A07 committedDocument outside a gesture', () => {
  it('is the current document, the same value as the document query and the snapshot', () => {
    const target = editor();
    const initial = target.query({ type: 'document' });
    expect(committed(target)).toBe(initial);
    expect(committed(target)).toBe(target.getSnapshot().document);
    expect(serializeDocument(committed(target))).toBe(ORIGIN);

    ok(target, { type: 'setNodeProps', id: 'b', props: { fill: red } });
    const after = target.query({ type: 'document' });
    expect(after).not.toBe(initial);
    expect(committed(target)).toBe(after);
    expect(committed(target).nodes.b).toMatchObject({ fill: red });

    ok(target, { type: 'undo' });
    expect(committed(target)).toBe(target.query({ type: 'document' }));
    expect(serializeDocument(committed(target))).toBe(ORIGIN);
    ok(target, { type: 'redo' });
    expect(committed(target)).toBe(after);
  });

  it('is deep frozen', () => {
    const target = editor();
    expect(isDeepFrozen(committed(target))).toBe(true);
    ok(target, { type: 'setNodeProps', id: 'a', props: { fill: red } });
    expect(isDeepFrozen(committed(target))).toBe(true);
  });
});

describe('M5-A07 committedDocument during a gesture', () => {
  it('a select-tool drag (update) holds the pre-gesture document until its commit', () => {
    const target = editor();
    const before = target.query({ type: 'document' });
    pointer(target, 'pointerdown', at(50, 50));
    expect(committed(target)).toBe(before);
    pointer(target, 'pointermove', at(60, 70));
    pointer(target, 'pointermove', at(80, 90));
    // The live document moved; the committed one did not.
    expect(frameOf(target.query({ type: 'document' }), 'a')).toEqual(f(30, 40, 100, 100));
    expect(frameOf(target.getSnapshot().document, 'a')).toEqual(f(30, 40, 100, 100));
    expect(committed(target)).toBe(before);
    expect(frameOf(committed(target), 'a')).toEqual(f(0, 0, 100, 100));
    expect(serializeDocument(committed(target))).toBe(ORIGIN);
    expect(isDeepFrozen(committed(target))).toBe(true);

    pointer(target, 'pointerup', at(80, 90));
    const after = target.query({ type: 'document' });
    expect(after).not.toBe(before);
    expect(committed(target)).toBe(after);
    expect(frameOf(committed(target), 'a')).toEqual(f(30, 40, 100, 100));
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
  });

  it('a cancelled drag returns the pre-gesture document, which it held throughout', () => {
    const target = editor();
    const before = target.query({ type: 'document' });
    pointer(target, 'pointerdown', at(50, 50));
    pointer(target, 'pointermove', at(70, 50));
    expect(frameOf(target.query({ type: 'document' }), 'a')).toEqual(f(20, 0, 100, 100));
    expect(committed(target)).toBe(before);
    ok(target, { type: 'input', event: { kind: 'keydown', key: 'Escape', modifiers: none } });
    expect(target.query({ type: 'document' })).toBe(before);
    expect(committed(target)).toBe(before);
  });

  it('a replace gesture holds the base, also after a replace back to it, and after commit', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'ext.slide' });
    const before = target.query({ type: 'document' });
    pointer(target, 'pointerdown', at(0, 0));
    pointer(target, 'pointermove', at(5, 7));
    expect(frameOf(target.query({ type: 'document' }), 'a')).toEqual(f(5, 7, 100, 100));
    expect(committed(target)).toBe(before);
    pointer(target, 'pointermove', at(-3, 2));
    expect(frameOf(target.query({ type: 'document' }), 'a')).toEqual(f(-3, 2, 100, 100));
    expect(committed(target)).toBe(before);

    // Replaced back to its base: the live document is the base again, the gesture still active.
    const events = record(target);
    pointer(target, 'pointermove', at(0, 0));
    expect(target.query({ type: 'document' })).toBe(before);
    expect(committed(target)).toBe(before);
    pointer(target, 'pointermove', at(10, 0));
    expect(frameOf(target.query({ type: 'document' }), 'a')).toEqual(f(10, 0, 100, 100));
    expect(committed(target)).toBe(before);
    pointer(target, 'pointermove', at(0, 0));
    // It ends with no event and no step; the committed document stays the base.
    pointer(target, 'pointerup', at(0, 0));
    expect(events.filter((event) => event.type === 'document').map((e) => e.cause)).toEqual([
      'gesture-update',
      'gesture-update',
      'gesture-update',
    ]);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(committed(target)).toBe(before);
    expect(target.query({ type: 'document' })).toBe(before);

    // No hold is left over from the eventless end: a host command is committed at once.
    ok(target, { type: 'setNodeProps', id: 'b', props: { fill: red } });
    const recolored = target.query({ type: 'document' });
    expect(recolored).not.toBe(before);
    expect(committed(target)).toBe(recolored);
    expect(recolored.nodes.b).toMatchObject({ fill: red });

    pointer(target, 'pointerdown', at(0, 0));
    pointer(target, 'pointermove', at(4, 6));
    expect(committed(target)).toBe(recolored);
    pointer(target, 'pointerup', at(4, 6));
    expect(committed(target)).toBe(target.query({ type: 'document' }));
    expect(frameOf(committed(target), 'a')).toEqual(f(4, 6, 100, 100));
    expect(committed(target).nodes.b).toMatchObject({ fill: red });
  });

  it('a host command right after a replace back to the base ends the gesture: its result', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'ext.slide' });
    const before = target.query({ type: 'document' });
    pointer(target, 'pointerdown', at(0, 0));
    pointer(target, 'pointermove', at(8, 9));
    pointer(target, 'pointermove', at(0, 0));
    expect(target.query({ type: 'document' })).toBe(before);
    expect(committed(target)).toBe(before);
    ok(target, { type: 'setNodeProps', id: 'b', props: { fill: red } });
    const after = target.query({ type: 'document' });
    expect(after).not.toBe(before);
    expect(committed(target)).toBe(after);
    expect(frameOf(after, 'a')).toEqual(f(0, 0, 100, 100));
    expect(after.nodes.b).toMatchObject({ fill: red });
    // The gesture is over: a later move changes nothing.
    pointer(target, 'pointermove', at(20, 0));
    expect(target.query({ type: 'document' })).toBe(after);
    expect(committed(target)).toBe(after);
  });

  it('a host command that cancels the drag: the command result on the pre-gesture document', () => {
    const target = editor();
    const before = target.query({ type: 'document' });
    pointer(target, 'pointerdown', at(50, 50));
    pointer(target, 'pointermove', at(90, 50));
    expect(frameOf(target.query({ type: 'document' }), 'a')).toEqual(f(40, 0, 100, 100));
    expect(committed(target)).toBe(before);

    ok(target, { type: 'setNodeProps', id: 'b', props: { fill: red } });
    const after = target.query({ type: 'document' });
    expect(committed(target)).toBe(after);
    expect(frameOf(after, 'a')).toEqual(f(0, 0, 100, 100));
    expect(after.nodes.b).toMatchObject({ fill: red, frame: f(300, 0, 50, 50) });
    // The drag is over: a later move changes nothing.
    pointer(target, 'pointermove', at(120, 50));
    expect(target.query({ type: 'document' })).toBe(after);
    expect(committed(target)).toBe(after);
  });

  it('a setTool during a drag cancels it: the pre-gesture document', () => {
    const target = editor();
    const before = target.query({ type: 'document' });
    pointer(target, 'pointerdown', at(50, 50));
    pointer(target, 'pointermove', at(50, 80));
    expect(committed(target)).toBe(before);
    ok(target, { type: 'setTool', tool: 'rectangle' });
    expect(target.query({ type: 'document' })).toBe(before);
    expect(committed(target)).toBe(before);
  });
});

describe('M5-A07 committedDocument when other commands end or skip a drag', () => {
  /** An editor with `a` dragged by (30, 40); returns the pre-gesture document. */
  function dragging(target: Editor): DocumentV4 {
    const before = target.query({ type: 'document' });
    pointer(target, 'pointerdown', at(50, 50));
    pointer(target, 'pointermove', at(80, 90));
    expect(frameOf(target.query({ type: 'document' }), 'a')).toEqual(f(30, 40, 100, 100));
    expect(committed(target)).toBe(before);
    return before;
  }

  it('undo during a drag ends it: the undone document', () => {
    const target = editor();
    ok(target, { type: 'setNodeProps', id: 'b', props: { fill: red } });
    dragging(target);
    ok(target, { type: 'undo' });
    expect(committed(target)).toBe(target.query({ type: 'document' }));
    expect(serializeDocument(committed(target))).toBe(ORIGIN);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 0, redoDepth: 1 });
    pointer(target, 'pointermove', at(120, 90));
    expect(serializeDocument(committed(target))).toBe(ORIGIN);
  });

  it('loadDocument during a drag ends it: the loaded document', () => {
    const target = editor();
    dragging(target);
    const loaded = {
      ...FIXTURE,
      pages: [{ id: 'p1', name: 'p1', children: ['b'] }],
      nodes: { b: rect('b', f(1, 2, 3, 4)) },
    };
    ok(target, { type: 'loadDocument', document: loaded });
    expect(committed(target)).toBe(target.query({ type: 'document' }));
    expect(committed(target).pages).toEqual([{ id: 'p1', name: 'p1', children: ['b'] }]);
    expect(frameOf(committed(target), 'b')).toEqual(f(1, 2, 3, 4));
    expect(Object.keys(committed(target).nodes)).toEqual(['b']);
    expect(isDeepFrozen(committed(target))).toBe(true);
  });

  it('cut during a drag ends it: the cut applied to the pre-gesture document', () => {
    const target = editor();
    const before = dragging(target);
    ok(target, { type: 'cut', ids: ['b'] });
    const after = target.query({ type: 'document' });
    expect(after).not.toBe(before);
    expect(committed(target)).toBe(after);
    expect(Object.keys(after.nodes)).toEqual(['a']);
    expect(frameOf(after, 'a')).toEqual(f(0, 0, 100, 100));
    expect(after.pages[0]!.children).toEqual(['a']);
  });

  it('a host command that fails during a drag leaves it going: still the pre-gesture document', () => {
    const target = editor();
    const before = dragging(target);
    const failed = target.execute({ type: 'setNodeProps', id: 'zz', props: { fill: red } });
    expect(failed.ok).toBe(false);
    expect(target.execute({ type: 'undo' })).toEqual({
      ok: false,
      code: 'editor.nothing-to-undo',
    });
    expect(committed(target)).toBe(before);
    pointer(target, 'pointermove', at(60, 60));
    expect(frameOf(target.query({ type: 'document' }), 'a')).toEqual(f(10, 10, 100, 100));
    expect(committed(target)).toBe(before);
    pointer(target, 'pointerup', at(60, 60));
    expect(committed(target)).toBe(target.query({ type: 'document' }));
    expect(frameOf(committed(target), 'a')).toEqual(f(10, 10, 100, 100));
  });

  it('an anchor drag in path edit mode: the pre-gesture document, then the committed one', () => {
    // The triangle `t` (0, 0), (1, 0), (1, 1) in the frame (100, 100, 100, 100); anchor 1 at
    // page (200, 100) is dragged by (10, 20).
    const triangle = {
      ...rect('t', f(100, 100, 100, 100)),
      type: 'path',
      path: {
        verbs: ['move', 'line', 'line', 'close'],
        points: [0, 0, 1, 0, 1, 1],
        fillRule: 'nonzero',
      },
    } as Record<string, unknown>;
    delete triangle.cornerRadii;
    const document = {
      ...FIXTURE,
      pages: [{ id: 'p1', name: 'p1', children: ['t'] }],
      nodes: { t: triangle },
    };
    const create = () => {
      const target = createEditor({ ids: createCounterIdSource('n'), document });
      ok(target, { type: 'setSnapping', enabled: false });
      ok(target, { type: 'enterPathEdit', id: 't' });
      return target;
    };
    const twin = create();
    ok(twin, {
      type: 'movePathAnchors',
      id: 't',
      anchors: [{ subpath: 0, anchor: 1 }],
      dx: 10,
      dy: 20,
    });
    const target = create();
    const before = target.query({ type: 'document' });
    pointer(target, 'pointerdown', at(200, 100));
    pointer(target, 'pointermove', at(205, 110));
    pointer(target, 'pointermove', at(210, 120));
    expect(target.query({ type: 'document' })).not.toBe(before);
    expect(committed(target)).toBe(before);
    expect(serializeDocument(committed(target))).toBe(serializeDocument(before));
    pointer(target, 'pointerup', at(210, 120));
    expect(committed(target)).toBe(target.query({ type: 'document' }));
    expect(serializeDocument(committed(target))).toBe(
      serializeDocument(twin.query({ type: 'document' })),
    );
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
  });
});

describe('M5-A07 committedDocument changes nothing else', () => {
  const OTHER: Query[] = [
    { type: 'document' },
    { type: 'node', id: 'a' },
    { type: 'selection' },
    { type: 'tool' },
    { type: 'viewport' },
    { type: 'history' },
    { type: 'revision' },
    { type: 'overlay' },
    { type: 'activePage' },
    { type: 'pages' },
    { type: 'handles' },
    { type: 'viewportSize' },
    { type: 'keymap' },
    { type: 'snap' },
    { type: 'snapping' },
    { type: 'scope' },
    { type: 'clipboard' },
    { type: 'pathEdit' },
    { type: 'pathOverlay' },
  ];

  function check(target: Editor): void {
    const events = record(target);
    const snapshot = target.getSnapshot();
    const values = OTHER.map((query) => JSON.stringify(target.query(query)));
    const document = target.query({ type: 'document' });
    const revision = target.query({ type: 'revision' });
    for (let i = 0; i < 3; i += 1) committed(target);
    expect(events).toEqual([]);
    expect(target.getSnapshot()).toBe(snapshot);
    expect(target.query({ type: 'document' })).toBe(document);
    expect(target.query({ type: 'revision' })).toBe(revision);
    expect(OTHER.map((query) => JSON.stringify(target.query(query)))).toEqual(values);
  }

  it('outside a gesture: no event, the same snapshot, revision and query values', () => {
    const target = editor();
    ok(target, { type: 'setSelection', ids: ['a'] });
    check(target);
    expect(target.query({ type: 'revision' })).toBe(0);
  });

  it('during a drag: no event, the same snapshot and the live document in it', () => {
    const target = editor();
    pointer(target, 'pointerdown', at(50, 50));
    pointer(target, 'pointermove', at(60, 70));
    check(target);
    expect(target.query({ type: 'revision' })).toBe(1);
    expect(target.getSnapshot().revision).toBe(1);
    expect(frameOf(target.getSnapshot().document, 'a')).toEqual(f(10, 20, 100, 100));
    // The drag goes on and commits as without the query: the release's last update (revision
    // 2), then the commit (revision 3).
    pointer(target, 'pointerup', at(60, 70));
    expect(target.query({ type: 'revision' })).toBe(3);
    expect(frameOf(committed(target), 'a')).toEqual(f(10, 20, 100, 100));
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
  });
});
