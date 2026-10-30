import path from 'node:path';
import {
  DEFAULT_PATH_STROKE,
  DEFAULT_RECTANGLE_FILL,
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';
import { createEditor as createPackagedEditor } from '@vector-studio/editor-core';
import { serializeDocument, type DocumentV6 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
// Source imports: the gesture API is package-internal, so the test shares the source module.
import { internalsOf } from '../../packages/editor-core/src/editor.js';
// @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
import { boundaries, evaluatePackageBoundaries } from '../../tooling/boundary-policy.mjs';

// P5-U2 (P5 editor-slice plan, sections 4.1 to 4.3): P5-A01, P5-A04 and P5-A05.

const black = { r: 0, g: 0, b: 0, a: 1 };
/** The v6 keys a rectangle, ellipse or frame stroke adds to `{ color, width }` (M4-M1). */
const SHAPE = { cap: 'butt', join: 'round', miterLimit: 4, dash: null } as const;
const noModifiers = { shift: false, alt: false, meta: false, ctrl: false };

function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n') });
}

function text(target: Editor): string {
  return serializeDocument(target.query({ type: 'document' }));
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function events(target: Editor): EditorEvent[] {
  const seen: EditorEvent[] = [];
  target.subscribe((event) => seen.push(event));
  return seen;
}

/** Everything a failed command must leave unchanged. */
function state(target: Editor) {
  const snapshot = target.getSnapshot();
  return {
    text: text(target),
    revision: snapshot.revision,
    history: snapshot.history,
    selection: snapshot.selection,
  };
}

describe('P5-A01 creation through execute', () => {
  it('creates a rectangle with the literal expected document', () => {
    const target = editor();
    const seen = events(target);
    const ids = ok(target, {
      type: 'createRectangle',
      frame: { x: 10, y: 20, width: 30, height: 40 },
      fill: { r: 1, g: 0, b: 0, a: 1 },
      stroke: { color: black, width: 2, ...SHAPE },
    });
    expect(ids).toEqual(['n3']);
    const expected: DocumentV6 = {
      schemaVersion: 6,
      id: 'n1',
      pages: [{ id: 'n2', name: 'Page 1', children: ['n3'] }],
      nodes: {
        n3: {
          id: 'n3',
          name: 'Rectangle',
          parent: 'n2',
          frame: { x: 10, y: 20, width: 30, height: 40 },
          rotation: 0,
          constraints: { horizontal: 'start', vertical: 'start' },
          opacity: 1,
          visible: true,
          type: 'rectangle',
          cornerRadii: [0, 0, 0, 0],
          fill: { r: 1, g: 0, b: 0, a: 1 },
          stroke: { color: black, width: 2, ...SHAPE },
        },
      },
    };
    expect(target.query({ type: 'document' })).toEqual(expected);
    expect(seen).toEqual([{ type: 'document', cause: 'command', revision: 1, touched: ['n3'] }]);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
  });

  it('applies the default styles', () => {
    const target = editor();
    const [rect] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 1, height: 1 },
    });
    const [line] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line'],
      points: [0, 0, 1, 1],
    });
    const document = target.query({ type: 'document' });
    expect(document.nodes[rect!]).toMatchObject({
      fill: { r: 0.8, g: 0.8, b: 0.8, a: 1 },
      stroke: null,
    });
    expect(document.nodes[line!]).toMatchObject({
      name: 'Path',
      fill: null,
      stroke: { color: black, width: 1, cap: 'butt', join: 'miter', miterLimit: 4, dash: null },
    });
    expect(document.pages[0]!.children).toEqual([rect, line]);
  });

  it('creates a path whose frame is the bounding box of all points, control points included', () => {
    const target = editor();
    const [id] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'cubic', 'line', 'close'],
      // Control point (20, -10) lies above every anchor.
      points: [0, 0, 20, -10, 40, 10, 40, 30, 0, 30],
      fillRule: 'evenodd',
      fill: black,
      stroke: null,
      name: 'Curve',
    });
    expect(target.query({ type: 'node', id: id! })).toEqual({
      id,
      name: 'Curve',
      parent: 'n2',
      frame: { x: 0, y: -10, width: 40, height: 40 },
      rotation: 0,
      constraints: { horizontal: 'start', vertical: 'start' },
      opacity: 1,
      visible: true,
      type: 'path',
      path: {
        verbs: ['move', 'cubic', 'line', 'close'],
        points: [0, 0.25, 0.5, 0, 1, 0.5, 1, 1, 0, 1],
        fillRule: 'evenodd',
      },
      fill: black,
      stroke: null,
    });
  });

  it('maps a zero-size axis to unit coordinate 0 and normalizes negative zero', () => {
    const target = editor();
    const [id] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line'],
      points: [-0, 5, 10, 5],
    });
    const node = target.query({ type: 'node', id: id! });
    expect(node?.frame).toEqual({ x: 0, y: 5, width: 10, height: 0 });
    expect(Object.is(node?.frame.x, 0)).toBe(true);
    expect(node?.type === 'path' && node.path.points).toEqual([0, 0, 1, 0]);
  });

  it('skips IDs that already exist', () => {
    const target = createEditor({ ids: () => 'n' });
    // The empty document and its page both took ID "n"; every later "n" collides with the page.
    expect(
      target.execute({ type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } }),
    ).toEqual({ ok: false, code: 'editor.duplicate-id' });
  });

  it('edits and deletes nodes', () => {
    const target = editor();
    const [a] = ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } });
    const [b] = ok(target, { type: 'createRectangle', frame: { x: 5, y: 5, width: 1, height: 1 } });
    ok(target, {
      type: 'setNodeProps',
      id: a!,
      props: { name: 'A', opacity: 0.5, visible: false, fill: null },
    });
    expect(target.query({ type: 'node', id: a! })).toMatchObject({
      name: 'A',
      opacity: 0.5,
      visible: false,
      fill: null,
    });
    ok(target, { type: 'deleteNodes', ids: [a!] });
    expect(target.query({ type: 'document' }).pages[0]!.children).toEqual([b]);
    expect(target.query({ type: 'node', id: a! })).toBeNull();
  });
});

describe('P5-A04 gestures and history', () => {
  function withTwoRectangles() {
    const target = editor();
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    const [b] = ok(target, {
      type: 'createRectangle',
      frame: { x: 20, y: 0, width: 10, height: 10 },
    });
    return { target, a: a!, b: b!, gesture: internalsOf(target).gesture };
  }

  function drag(target: Editor, id: string, updates: number): void {
    const { gesture } = internalsOf(target);
    expect(gesture.begin()).toBe(true);
    for (let step = 1; step <= updates; step += 1) {
      const result = gesture.update({
        type: 'setFrames',
        frames: [{ id, frame: { x: step, y: step * 2, width: 10, height: 10 } }],
      });
      expect(result.ok).toBe(true);
    }
  }

  it('makes one undo step from a 50-update drag; undo and redo are byte-identical', () => {
    const { target, a } = withTwoRectangles();
    const before = text(target);
    const seen = events(target);
    drag(target, a, 50);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 2, redoDepth: 0 });
    internalsOf(target).gesture.commit();
    const after = text(target);
    expect(target.query({ type: 'node', id: a })?.frame).toEqual({
      x: 50,
      y: 100,
      width: 10,
      height: 10,
    });
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 3, redoDepth: 0 });
    expect(seen.filter((event) => event.type === 'document').map((event) => event.cause)).toEqual([
      ...Array<string>(50).fill('gesture-update'),
      'gesture-commit',
    ]);

    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 2, redoDepth: 1 });
    ok(target, { type: 'redo' });
    expect(text(target)).toBe(after);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 3, redoDepth: 0 });
  });

  it('cancel restores the pre-drag document and creates no step', () => {
    const { target, a, gesture } = withTwoRectangles();
    const before = state(target);
    drag(target, a, 50);
    gesture.cancel();
    expect(text(target)).toBe(before.text);
    expect(target.query({ type: 'history' })).toEqual(before.history);
    expect(gesture.active).toBe(false);
  });

  it('undo during a drag cancels the drag, then undoes the previous step', () => {
    const { target, a, b, gesture } = withTwoRectangles();
    const seen = events(target);
    drag(target, a, 50);
    ok(target, { type: 'undo' });
    expect(gesture.active).toBe(false);
    // The previous step was the creation of b; a is back at its pre-drag frame.
    expect(target.query({ type: 'node', id: b })).toBeNull();
    expect(target.query({ type: 'node', id: a })?.frame).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 1 });
    expect(seen.slice(-2).map((event) => event.type === 'document' && event.cause)).toEqual([
      'gesture-cancel',
      'undo',
    ]);
  });

  it.each<[string, Command]>([
    ['setTool', { type: 'setTool', tool: 'rectangle' }],
    ['setTool to the same tool', { type: 'setTool', tool: 'select' }],
    ['a document command', { type: 'setNodeProps', id: 'n3', props: { name: 'x' } }],
  ])('%s during a drag cancels the drag first and resets the tool', (label, command) => {
    const { target, a, gesture } = withTwoRectangles();
    const resets: string[] = [];
    internalsOf(target).tools.set('select', {
      input: () => false,
      reset: () => resets.push('reset'),
      overlay: () => null,
    });
    const before = text(target);
    drag(target, a, 3);
    ok(target, command);
    expect(gesture.active).toBe(false);
    expect(resets).toEqual(['reset']);
    if (label !== 'a document command') expect(text(target)).toBe(before);
    expect(target.query({ type: 'node', id: a })?.frame.x).toBe(0);
  });

  it('a host document command during a drag applies to the pre-drag document', () => {
    const { target, a, gesture } = withTwoRectangles();
    drag(target, a, 3);
    ok(target, { type: 'setNodeProps', id: a, props: { name: 'x' } });
    ok(target, { type: 'undo' });
    expect(target.query({ type: 'node', id: a })).toMatchObject({
      name: 'Rectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(gesture.active).toBe(false);
  });

  it('redo during a drag cancels it, then redoes', () => {
    const { target, a, b, gesture } = withTwoRectangles();
    ok(target, { type: 'undo' });
    drag(target, a, 3);
    ok(target, { type: 'redo' });
    expect(gesture.active).toBe(false);
    expect(target.query({ type: 'node', id: b })).not.toBeNull();
    expect(target.query({ type: 'node', id: a })?.frame.x).toBe(0);
  });

  it.each<[string, Command]>([
    ['an empty redo stack', { type: 'redo' }],
    ['an invalid loadDocument', { type: 'loadDocument', document: null }],
    ['a failing document command', { type: 'setNodeProps', id: 'n3', props: { opacity: 2 } }],
    ['an unknown tool', { type: 'setTool', tool: 'lasso' } as never],
  ])('%s during a drag changes nothing and the drag goes on', (_label, command) => {
    const { target, a, gesture } = withTwoRectangles();
    drag(target, a, 3);
    const before = state(target);
    const seen = events(target);
    expect(target.execute(command).ok).toBe(false);
    expect(gesture.active).toBe(true);
    expect(state(target)).toEqual(before);
    expect(seen).toEqual([]);
  });

  it('an empty undo stack during a drag changes nothing', () => {
    const target = editor();
    const { gesture } = internalsOf(target);
    gesture.begin();
    ok(target, { type: 'input', event: { kind: 'keydown', key: 'x', modifiers: noModifiers } });
    gesture.update({ type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } });
    const before = state(target);
    expect(target.execute({ type: 'undo' }).ok).toBe(false);
    expect(gesture.active).toBe(true);
    expect(state(target)).toEqual(before);
  });

  it('a successful loadDocument during a drag cancels it and clears history', () => {
    const { target, a, gesture } = withTwoRectangles();
    const replacement = createEditor({ ids: createCounterIdSource('m') }).query({
      type: 'document',
    });
    drag(target, a, 3);
    ok(target, { type: 'loadDocument', document: replacement });
    expect(gesture.active).toBe(false);
    expect(text(target)).toBe(serializeDocument(replacement));
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it('ignores a second begin while a gesture is active, and a commit without updates', () => {
    const { target, gesture } = withTwoRectangles();
    const before = state(target);
    expect(gesture.begin()).toBe(true);
    expect(gesture.begin()).toBe(false);
    gesture.commit();
    expect(state(target)).toEqual(before);
  });

  it('a new transaction after undo clears the redo stack', () => {
    const { target, a } = withTwoRectangles();
    ok(target, { type: 'undo' });
    ok(target, { type: 'setNodeProps', id: a, props: { name: 'renamed' } });
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 2, redoDepth: 0 });
    expect(target.execute({ type: 'redo' })).toEqual({ ok: false, code: 'editor.nothing-to-redo' });
  });

  it('undo and redo of create, edit and delete are byte-identical at every step', () => {
    const target = editor();
    const texts = [text(target)];
    const [a] = ok(target, { type: 'createRectangle', frame: { x: 1, y: 1, width: 2, height: 2 } });
    texts.push(text(target));
    ok(target, { type: 'createPath', verbs: ['move', 'line'], points: [0, 0, 3, 4] });
    texts.push(text(target));
    ok(target, {
      type: 'setNodeProps',
      id: a!,
      props: { stroke: { color: black, width: 3, ...SHAPE } },
    });
    texts.push(text(target));
    ok(target, { type: 'deleteNodes', ids: [a!] });
    texts.push(text(target));
    for (let i = texts.length - 2; i >= 0; i -= 1) {
      ok(target, { type: 'undo' });
      expect(text(target)).toBe(texts[i]);
    }
    for (let i = 1; i < texts.length; i += 1) {
      ok(target, { type: 'redo' });
      expect(text(target)).toBe(texts[i]);
    }
  });
});

describe('P5-A05 failed commands and session state', () => {
  function seeded() {
    const target = editor();
    const [a] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    ok(target, { type: 'setSelection', ids: [a!] });
    return { target, a: a! };
  }

  it.each<[string, (id: string) => Command, string]>([
    [
      'a negative width',
      () => ({ type: 'createRectangle', frame: { x: 0, y: 0, width: -1, height: 1 } }),
      'document.invalid-field',
    ],
    [
      'a NaN frame',
      (id) => ({
        type: 'setFrames',
        frames: [{ id, frame: { x: NaN, y: 0, width: 1, height: 1 } }],
      }),
      'document.invalid-field',
    ],
    [
      'an unknown node in setFrames',
      () => ({
        type: 'setFrames',
        frames: [{ id: 'zz', frame: { x: 0, y: 0, width: 1, height: 1 } }],
      }),
      'editor.unknown-node',
    ],
    [
      'a repeated node in setFrames',
      (id) => ({
        type: 'setFrames',
        frames: [
          { id, frame: { x: 0, y: 0, width: 1, height: 1 } },
          { id, frame: { x: 0, y: 0, width: 1, height: 1 } },
        ],
      }),
      'editor.invalid-command',
    ],
    [
      'an opacity above 1',
      (id) => ({ type: 'setNodeProps', id, props: { opacity: 2 } }),
      'document.invalid-field',
    ],
    [
      // A v5 path stroke, without the v6 `dash` (M4 contract, section 4.1).
      'a v5 path stroke on a rectangle',
      (id) =>
        ({
          type: 'setNodeProps',
          id,
          props: { stroke: { color: black, width: 1, cap: 'butt', join: 'miter', miterLimit: 4 } },
        }) as never,
      'document.invalid-field',
    ],
    [
      'data on a rectangle',
      (id) => ({ type: 'setNodeProps', id, props: { data: 1 } }),
      'editor.invalid-command',
    ],
    [
      'an unknown prop',
      (id) => ({ type: 'setNodeProps', id, props: { rotation: 1 } as never }),
      'editor.invalid-command',
    ],
    [
      'a path that breaks the grammar',
      () => ({ type: 'createPath', verbs: ['line'], points: [0, 0] }),
      'document.invalid-field',
    ],
    [
      'a path with a point count mismatch',
      () => ({ type: 'createPath', verbs: ['move'], points: [0, 0, 1, 1] }),
      'document.invalid-field',
    ],
    [
      'deleting an unknown node',
      () => ({ type: 'deleteNodes', ids: ['zz'] }),
      'editor.unknown-node',
    ],
    ['deleting nothing', () => ({ type: 'deleteNodes', ids: [] }), 'editor.invalid-command'],
    [
      'an invalid document',
      () => ({ type: 'loadDocument', document: { schemaVersion: 7 } }),
      'document.unsupported-version',
    ],
    ['an unknown command', () => ({ type: 'rotate' }) as never, 'editor.invalid-command'],
    ['an unknown tool', () => ({ type: 'setTool', tool: 'lasso' }) as never, 'editor.unknown-tool'],
    [
      'an invalid camera',
      () => ({ type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 0 } }),
      'editor.invalid-camera',
    ],
    [
      'selecting an unknown node',
      () => ({ type: 'setSelection', ids: ['zz'] }),
      'editor.unknown-node',
    ],
  ])('%s changes neither document nor history', (_label, command, code) => {
    const { target, a } = seeded();
    const before = state(target);
    const seen = events(target);
    const result = target.execute(command(a));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe(code);
    expect(state(target)).toEqual(before);
    expect(seen).toEqual([]);
  });

  it('undo and redo with empty stacks fail without change', () => {
    const target = editor();
    const before = state(target);
    expect(target.execute({ type: 'undo' })).toEqual({ ok: false, code: 'editor.nothing-to-undo' });
    expect(target.execute({ type: 'redo' })).toEqual({ ok: false, code: 'editor.nothing-to-redo' });
    expect(state(target)).toEqual(before);
  });

  it('keeps selection and viewport out of history and the document', () => {
    const { target, a } = seeded();
    const before = state(target);
    ok(target, { type: 'setSelection', ids: [] });
    ok(target, { type: 'setSelection', ids: [a, a] });
    ok(target, { type: 'setViewport', camera: { position: { x: 5, y: -3 }, zoom: 2 } });
    ok(target, { type: 'setTool', tool: 'path' });
    expect(target.query({ type: 'selection' })).toEqual([a]);
    expect(target.query({ type: 'viewport' })).toEqual({ position: { x: 5, y: -3 }, zoom: 2 });
    expect(target.query({ type: 'tool' })).toBe('path');
    expect(text(target)).toBe(before.text);
    expect(target.query({ type: 'history' })).toEqual(before.history);
    expect(target.query({ type: 'revision' })).toBe(before.revision);
  });

  it('drops deleted or undone-away nodes from the selection', () => {
    const { target, a } = seeded();
    const [b] = ok(target, { type: 'createRectangle', frame: { x: 1, y: 1, width: 1, height: 1 } });
    ok(target, { type: 'setSelection', ids: [a, b!] });
    ok(target, { type: 'undo' });
    expect(target.query({ type: 'selection' })).toEqual([a]);
    ok(target, { type: 'deleteNodes', ids: [a] });
    expect(target.query({ type: 'selection' })).toEqual([]);
  });

  it('replaces the snapshot on every change and keeps it otherwise', () => {
    const { target } = seeded();
    const first = target.getSnapshot();
    expect(target.getSnapshot()).toBe(first);
    target.execute({ type: 'undo' });
    const second = target.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.document.pages[0]!.children).toEqual([]);
    expect(second.history).toEqual({ undoDepth: 0, redoDepth: 1 });
  });

  it('forwards input to the active tool only when the event is well formed', () => {
    const target = editor();
    const received: string[] = [];
    internalsOf(target).tools.set('select', {
      input: (event) => received.push(event.kind) > 0,
      reset: () => received.push('reset'),
      overlay: () => null,
    });
    const modifiers = { shift: false, alt: false, meta: false, ctrl: false };
    ok(target, { type: 'input', event: { kind: 'pointerdown', point: { x: 1, y: 2 }, modifiers } });
    expect(
      target.execute({
        type: 'input',
        event: { kind: 'pointermove', point: { x: NaN, y: 0 }, modifiers },
      }),
    ).toEqual({ ok: false, code: 'editor.invalid-command', path: '/event' });
    ok(target, { type: 'setTool', tool: 'rectangle' });
    expect(received).toEqual(['pointerdown', 'reset']);
  });

  it('rejects an invalid initial document', () => {
    expect(() => createEditor({ document: { schemaVersion: 1 } })).toThrow(
      /document\.invalid-field/u,
    );
  });
});

describe('P5-U2 review round 1 cases', () => {
  it('delivers events in change order when a listener executes a command', () => {
    const target = editor();
    let nested = false;
    target.subscribe((event) => {
      if (event.type === 'document' && !nested) {
        nested = true;
        ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } });
      }
    });
    const revisions: number[] = [];
    target.subscribe((event) => {
      if (event.type === 'document') revisions.push(event.revision);
    });
    ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } });
    expect(revisions).toEqual([1, 2]);
  });

  it('runs a command raised on gesture-cancel only after the cancelling command commits', () => {
    const target = editor();
    const [a] = ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } });
    const { gesture } = internalsOf(target);
    let created: readonly string[] = [];
    target.subscribe((event) => {
      if (event.type === 'document' && event.cause === 'gesture-cancel') {
        created = ok(target, {
          type: 'createRectangle',
          frame: { x: 5, y: 5, width: 1, height: 1 },
        });
      }
    });
    gesture.begin();
    gesture.update({
      type: 'setFrames',
      frames: [{ id: a!, frame: { x: 2, y: 0, width: 1, height: 1 } }],
    });
    ok(target, { type: 'setNodeProps', id: a!, props: { name: 'X' } });
    expect(target.query({ type: 'document' }).pages[0]!.children).toEqual([a, ...created]);
    expect(target.query({ type: 'node', id: a! })?.name).toBe('X');
    ok(target, { type: 'undo' });
    expect(target.query({ type: 'node', id: created[0]! })).toBeNull();
    ok(target, { type: 'undo' });
    expect(target.query({ type: 'node', id: a! })?.name).toBe('Rectangle');
  });

  it('undo during a drag undoes the previous step even when a listener edits on cancel', () => {
    const target = editor();
    const [a] = ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } });
    const [b] = ok(target, { type: 'createRectangle', frame: { x: 5, y: 0, width: 1, height: 1 } });
    const { gesture } = internalsOf(target);
    target.subscribe((event) => {
      if (event.type === 'document' && event.cause === 'gesture-cancel') {
        ok(target, { type: 'setNodeProps', id: a!, props: { name: 'L' } });
      }
    });
    gesture.begin();
    gesture.update({
      type: 'setFrames',
      frames: [{ id: a!, frame: { x: 2, y: 0, width: 1, height: 1 } }],
    });
    ok(target, { type: 'undo' });
    // The undo took back b's creation; the listener's rename came after it.
    expect(target.query({ type: 'node', id: b! })).toBeNull();
    expect(target.query({ type: 'node', id: a! })?.name).toBe('L');
  });

  it('hands out frozen session state and defaults', () => {
    const target = editor();
    const [a] = ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } });
    ok(target, { type: 'setSelection', ids: [a!] });
    ok(target, { type: 'setViewport', camera: { position: { x: 1, y: 2 }, zoom: 3 } });
    const snapshot = target.getSnapshot();
    for (const value of [snapshot, snapshot.selection, snapshot.viewport, snapshot.history]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Object.isFrozen(target.query({ type: 'selection' }))).toBe(true);
    expect(Object.isFrozen(DEFAULT_RECTANGLE_FILL)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PATH_STROKE.color)).toBe(true);
  });

  it('rejects a null initial document', () => {
    expect(() => createEditor({ document: null })).toThrow(/document\.invalid-field/u);
  });

  it('keeps delivering when a listener throws, and rethrows asynchronously', async () => {
    const target = editor();
    const errors: unknown[] = [];
    const onError = (error: unknown) => errors.push(error);
    process.on('unhandledRejection', onError);
    try {
      target.subscribe(() => {
        throw new Error('boom');
      });
      const seen = events(target);
      ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } });
      expect(seen).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errors).toEqual([new Error('boom')]);
    } finally {
      process.off('unhandledRejection', onError);
    }
  });

  it('hands out frozen documents, so history cannot be corrupted', () => {
    const target = editor();
    const [a] = ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } });
    const document = target.query({ type: 'document' });
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.pages[0]!.children)).toBe(true);
    expect(Object.isFrozen(document.nodes[a!]?.frame)).toBe(true);
    expect(() => (document.pages[0]!.children as string[]).push('zz')).toThrow(TypeError);
    const loaded = createEditor({ document: JSON.parse(JSON.stringify(document)) as unknown });
    expect(Object.isFrozen(loaded.query({ type: 'document' }).nodes[a!])).toBe(true);
  });

  it.each<[string, Command, string]>([
    [
      'string points',
      { type: 'createPath', verbs: ['move', 'line'], points: ['0', 0, 1, 1] as never },
      '/points/0',
    ],
    [
      'null points',
      { type: 'createPath', verbs: ['move', 'line'], points: [0, null, 1, 1] as never },
      '/points/1',
    ],
    ['no frames', { type: 'setFrames', frames: [] }, '/frames'],
    ['no props', { type: 'setNodeProps', id: 'n3', props: {} }, '/props'],
    [
      'null modifiers',
      { type: 'input', event: { kind: 'keydown', key: 'a', modifiers: null as never } },
      '/event',
    ],
    [
      'a missing modifier',
      { type: 'input', event: { kind: 'keydown', key: 'a', modifiers: { shift: false } as never } },
      '/event',
    ],
  ])('rejects %s as editor.invalid-command', (_label, command, at) => {
    const target = editor();
    ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } });
    const before = state(target);
    expect(target.execute(command)).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: at,
    });
    expect(state(target)).toEqual(before);
  });

  it('reports create failures relative to the new node and draws no ID for them', () => {
    const target = editor();
    expect(
      target.execute({ type: 'createRectangle', frame: { x: 0, y: 0, width: -1, height: 1 } }),
    ).toEqual({ ok: false, code: 'document.invalid-field', path: '/frame/width' });
    expect(
      ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } }),
    ).toEqual(['n3']);
  });

  it('rejects an ID source that cannot build a valid empty document', () => {
    expect(() => createEditor({ ids: () => '' })).toThrow(/document\.invalid-field at \/id/u);
  });

  it('normalizes negative zero in the viewport', () => {
    const target = editor();
    ok(target, { type: 'setViewport', camera: { position: { x: -0, y: -0 }, zoom: 1 } });
    expect(Object.is(target.query({ type: 'viewport' }).position.x, 0)).toBe(true);
  });
});

describe('P5-U2 editor-core package boundary', () => {
  const policy = boundaries as Map<string, Set<string>>;
  const evaluate = evaluatePackageBoundaries as (input: {
    manifest: { name: string };
    sources: { path: string; text: string }[];
    packageRoots: Map<string, string>;
  }) => string[];
  const root = path.resolve(import.meta.dirname, '../..');

  it('exports createEditor from the built package', () => {
    const packaged = createPackagedEditor({ ids: createCounterIdSource('p') });
    expect(packaged.query({ type: 'document' }).id).toBe('p1');
  });

  it('allows only model and contracts', () => {
    expect([...policy.get('@vector-studio/editor-core')!].sort()).toEqual([
      '@vector-studio/contracts',
      '@vector-studio/model',
    ]);
  });

  it('rejects the seeded edge editor-core -> renderer-webgpu', () => {
    const source = {
      path: path.join(root, 'packages/editor-core/src/seeded.ts'),
      text: "import { createRenderer } from '@vector-studio/renderer-webgpu';\n",
    };
    expect(
      evaluate({
        manifest: { name: '@vector-studio/editor-core' },
        sources: [source],
        packageRoots: new Map([
          ['@vector-studio/editor-core', path.join(root, 'packages/editor-core')],
        ]),
      }),
    ).toEqual([`${source.path}: source import of @vector-studio/renderer-webgpu is forbidden`]);
  });
});
