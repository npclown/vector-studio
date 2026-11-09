import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '@vector-studio/editor-core';
import { serializeDocument, type NodeV7 } from '@vector-studio/model';
import { EditorProvider, PropertySections } from '@vector-studio/ui';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  boxText,
  selectedNodes,
  targetCommand,
  targetEditable,
  targetText,
  transformTarget,
  type TransformKey,
  type TransformTarget,
} from '../../packages/ui/src/property-model.js';

// V-25 slice 9 (amends MVP M8 contract M8-R2): the property panel's X, Y, W and H show the
// selection box the canvas draws (the `handles` box: a path's curve, not its Bézier handles,
// V-26), edit it as one command each, and for several nodes show and edit the box around them
// all, the rotation showing "mixed" when it differs.

function editor(): Editor {
  const target = createEditor({ ids: createCounterIdSource('n') });
  ok(target, { type: 'setSnapping', enabled: false });
  return target;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function target(editor: Editor): TransformTarget {
  const document = editor.query({ type: 'document' });
  const nodes = selectedNodes(document, editor.query({ type: 'selection' }));
  const found = transformTarget(
    nodes,
    editor.query({ type: 'handles' }),
    editor.query({ type: 'activePage' }),
  );
  if (found === null) throw new Error('no target');
  return found;
}

/** Commits `value` into field `key` as the panel does: one command, one undo step. */
function commit(editor: Editor, key: TransformKey, value: number): void {
  const command = targetCommand(target(editor), key, value);
  if (command === null) throw new Error(`no command for ${key}`);
  const before = serializeDocument(editor.query({ type: 'document' }));
  const depth = editor.getSnapshot().history.undoDepth;
  ok(editor, command);
  expect(editor.getSnapshot().history.undoDepth).toBe(depth + 1);
  editor.execute({ type: 'undo' });
  expect(serializeDocument(editor.query({ type: 'document' }))).toBe(before);
  editor.execute({ type: 'redo' });
}

/** The handle box's top-left corner and its sizes along its own axes. */
function handleBox(editor: Editor) {
  const [tl, tr, , bl] = editor.query({ type: 'handles' })!.corners;
  return {
    x: tl.x,
    y: tl.y,
    width: Math.hypot(tr.x - tl.x, tr.y - tl.y),
    height: Math.hypot(bl.x - tl.x, bl.y - tl.y),
  };
}

function expectBox(actual: { x: number; y: number; width: number; height: number }, b: number[]) {
  expect(actual.x).toBeCloseTo(b[0]!, 9);
  expect(actual.y).toBeCloseTo(b[1]!, 9);
  expect(actual.width).toBeCloseTo(b[2]!, 9);
  expect(actual.height).toBeCloseTo(b[3]!, 9);
}

const node = (editor: Editor, id: string): NodeV7 => editor.query({ type: 'node', id })!;

/** An arch from (0, 0) to (100, 0) whose handles reach y = 100; the curve peaks at y = 75. */
function arch(editor: Editor, dx = 0, dy = 0): string {
  return ok(editor, {
    type: 'createPath',
    verbs: ['move', 'cubic'],
    points: [dx, dy, dx, dy + 100, dx + 100, dy + 100, dx + 100, dy],
  })[0]!;
}

function rectangle(editor: Editor, x: number, y: number, width: number, height: number): string {
  return ok(editor, { type: 'createRectangle', frame: { x, y, width, height } })[0]!;
}

describe('V-25 slice 9: one node', () => {
  it('shows a path’s curve box, the box the canvas draws, not its frame', () => {
    const e = editor();
    const id = arch(e, 20, 30);
    ok(e, { type: 'setSelection', ids: [id] });
    expect(node(e, id).frame.height).toBe(100);
    const t = target(e);
    expectBox(t.box, [20, 30, 100, 75]);
    expectBox(t.box, Object.values(handleBox(e)));
    expect((['x', 'y', 'width', 'height'] as const).map((k) => targetText(t, k))).toEqual([
      '20',
      '30',
      '100',
      '75',
    ]);
  });

  it('moves and resizes the curve box, its top-left corner staying put', () => {
    const e = editor();
    const id = arch(e, 20, 30);
    ok(e, { type: 'setSelection', ids: [id] });
    commit(e, 'x', 50);
    expectBox(handleBox(e), [50, 30, 100, 75]);
    commit(e, 'height', 150);
    expectBox(handleBox(e), [50, 30, 100, 150]);
    expect(node(e, id).frame.height).toBeCloseTo(200, 9);
    commit(e, 'width', 40);
    expectBox(handleBox(e), [50, 30, 40, 150]);
    commit(e, 'y', -10);
    expectBox(handleBox(e), [50, -10, 40, 150]);
  });

  it('shows and keeps a rotated node’s turned top-left corner', () => {
    const e = editor();
    const id = rectangle(e, 10, 20, 100, 50);
    ok(e, { type: 'setSelection', ids: [id] });
    commit(e, 'rotation', 30);
    expect(targetText(target(e), 'rotation')).toBe('30');
    const before = handleBox(e);
    expectBox(target(e).box, Object.values(before));
    commit(e, 'width', 160);
    expectBox(handleBox(e), [before.x, before.y, 160, 50]);
    commit(e, 'height', 20);
    expectBox(handleBox(e), [before.x, before.y, 160, 20]);
    commit(e, 'x', before.x + 7);
    expectBox(handleBox(e), [before.x + 7, before.y, 160, 20]);
    expect(targetText(target(e), 'rotation')).toBe('30');
  });

  it('shows a child in its parent’s space and resizes a zero-height line by its frame', () => {
    const e = editor();
    const frame = ok(e, {
      type: 'createFrame',
      frame: { x: 100, y: 100, width: 300, height: 300 },
    })[0]!;
    const child = ok(e, {
      type: 'createRectangle',
      // Page-space frame: the child stores (10, 20) in the frame's space.
      frame: { x: 110, y: 120, width: 30, height: 40 },
      parent: frame,
    })[0]!;
    ok(e, { type: 'setSelection', ids: [child] });
    expect(targetText(target(e), 'x')).toBe('10');
    commit(e, 'x', 15);
    expect(node(e, child).frame.x).toBe(15);
    const line = ok(e, { type: 'createLine', start: { x: 0, y: 500 }, end: { x: 80, y: 500 } })[0]!;
    ok(e, { type: 'setSelection', ids: [line] });
    expect(targetText(target(e), 'height')).toBe('0');
    commit(e, 'height', 20);
    expect(node(e, line).frame.height).toBe(20);
  });
});

describe('V-25 slice 9: several nodes', () => {
  it('shows and edits the box around unrotated page-root nodes', () => {
    const e = editor();
    const a = rectangle(e, 10, 80, 100, 60);
    const b = arch(e, 10, 160);
    ok(e, { type: 'setSelection', ids: [a, b] });
    expectBox(target(e).box, [10, 80, 100, 155]);
    expect(targetText(target(e), 'rotation')).toBe('0');
    commit(e, 'x', 30);
    expectBox(handleBox(e), [30, 80, 100, 155]);
    commit(e, 'width', 200);
    expectBox(handleBox(e), [30, 80, 200, 155]);
    expect(node(e, a).frame).toEqual({ x: 30, y: 80, width: 200, height: 60 });
    commit(e, 'height', 310);
    expectBox(handleBox(e), [30, 80, 200, 310]);
    commit(e, 'y', 0);
    expectBox(handleBox(e), [30, 0, 200, 310]);
  });

  it('shows "mixed" rotation, sets it on each, and keeps W and H read-only once rotated', () => {
    const e = editor();
    const a = rectangle(e, 0, 0, 100, 50);
    const b = rectangle(e, 200, 0, 100, 50);
    ok(e, { type: 'setSelection', ids: [a] });
    commit(e, 'rotation', 45);
    ok(e, { type: 'setSelection', ids: [a, b] });
    let t = target(e);
    expect(targetText(t, 'rotation')).toBeNull();
    expect(targetEditable(t, 'width')).toBe(false);
    expect(targetEditable(t, 'height')).toBe(false);
    expect(targetCommand(t, 'width', 10)).toBeNull();
    expect(targetEditable(t, 'x')).toBe(true);
    const box = t.box;
    commit(e, 'x', box.x + 10);
    expectBox(handleBox(e), [box.x + 10, box.y, box.width, box.height]);
    commit(e, 'rotation', 90);
    t = target(e);
    expect(targetText(t, 'rotation')).toBe('90');
  });

  it('renders a two-column grid with visible labels, and W and H read-only when unscalable', () => {
    const e = editor();
    const a = rectangle(e, 0, 0, 100, 50);
    const b = rectangle(e, 200, 0, 100, 50);
    ok(e, { type: 'setSelection', ids: [a, b] });
    let html = renderToString(
      createElement(EditorProvider, { editor: e }, createElement(PropertySections)),
    );
    expect(html).toContain('data-testid="transform-grid"');
    expect(html).toMatch(/<input[^>]*aria-label="W"[^>]*value="300"/u);
    expect(html).not.toMatch(/<input[^>]*aria-label="W"[^>]*disabled/u);
    ok(e, { type: 'setSelection', ids: [a] });
    ok(e, { type: 'setFrames', frames: [{ id: a, frame: node(e, a).frame, rotation: 1 }] });
    ok(e, { type: 'setSelection', ids: [a, b] });
    html = renderToString(
      createElement(EditorProvider, { editor: e }, createElement(PropertySections)),
    );
    expect(html).toMatch(/<input[^>]*aria-label="W"[^>]*disabled/u);
  });
});

describe('V-25 slice 9: zero-size multi box', () => {
  it('keeps W read-only for several vertical lines', () => {
    const e = editor();
    const a = ok(e, { type: 'createLine', start: { x: 0, y: 0 }, end: { x: 0, y: 80 } })[0]!;
    const b = ok(e, { type: 'createLine', start: { x: 0, y: 100 }, end: { x: 0, y: 160 } })[0]!;
    ok(e, { type: 'setSelection', ids: [a, b] });
    const t = target(e);
    expect(targetText(t, 'width')).toBe('0');
    expect(targetEditable(t, 'width')).toBe(false);
    expect(targetEditable(t, 'height')).toBe(true);
  });
});

describe('V-25 slice 9: display', () => {
  it('rounds to two decimals without a negative zero', () => {
    expect(boxText(12.3456)).toBe('12.35');
    expect(boxText(-0.001)).toBe('0');
    expect(boxText(100)).toBe('100');
  });
});
