import { serializeDocument } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';

// P5-U3 (P5 editor-slice plan, section 4.4): P5-A02 and P5-A03, driven through `input`.

const black = { r: 0, g: 0, b: 0, a: 1 };
const red = { r: 1, g: 0, b: 0, a: 1 };
const none = { shift: false, alt: false, meta: false, ctrl: false };
const shift = { ...none, shift: true };

function editor(): Editor {
  return createEditor({ ids: createCounterIdSource('n') });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function rect(target: Editor, x: number, y: number, w: number, h: number, filled = true) {
  return ok(target, {
    type: 'createRectangle',
    frame: { x, y, width: w, height: h },
    fill: filled ? red : null,
    stroke: filled ? null : { color: black, width: 1 },
  })[0]!;
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  modifiers = none,
) {
  ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers } });
}

function click(target: Editor, x: number, y: number, modifiers = none) {
  pointer(target, 'pointerdown', x, y, modifiers);
  pointer(target, 'pointerup', x, y, modifiers);
}

function drag(target: Editor, from: [number, number], to: [number, number], modifiers = none) {
  pointer(target, 'pointerdown', from[0], from[1], modifiers);
  const steps = 5;
  for (let i = 1; i <= steps; i += 1) {
    pointer(
      target,
      'pointermove',
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
      modifiers,
    );
  }
  pointer(target, 'pointerup', to[0], to[1], modifiers);
}

function key(target: Editor, name: string) {
  ok(target, { type: 'input', event: { kind: 'keydown', key: name, modifiers: none } });
}

const selection = (target: Editor) => target.query({ type: 'selection' });
const frame = (target: Editor, id: string) => target.query({ type: 'node', id })?.frame;
const history = (target: Editor) => target.query({ type: 'history' });

describe('P5-A02 click selection', () => {
  it('selects the topmost node in reverse paint order', () => {
    const target = editor();
    const below = rect(target, 0, 0, 100, 100);
    const above = rect(target, 50, 50, 100, 100);
    click(target, 75, 75);
    expect(selection(target)).toEqual([above]);
    click(target, 25, 25);
    expect(selection(target)).toEqual([below]);
  });

  it('shift toggles a node in and out of the selection', () => {
    const target = editor();
    // Clicks stay clear of the selection's resize handles, which win over node hits.
    const a = rect(target, 0, 0, 40, 40);
    const b = rect(target, 60, 0, 40, 40);
    click(target, 20, 20);
    click(target, 80, 20, shift);
    expect(selection(target)).toEqual([a, b]);
    click(target, 20, 20, shift);
    expect(selection(target)).toEqual([b]);
  });

  it('a click on empty canvas clears the selection; shift keeps it', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    click(target, 5, 5);
    click(target, 500, 500, shift);
    expect(selection(target)).toEqual([a]);
    click(target, 500, 500);
    expect(selection(target)).toEqual([]);
  });

  it('hits an unfilled rectangle only within r of its outline, r = max(w / 2, 4 / zoom)', () => {
    const target = editor();
    const a = rect(target, 0, 0, 100, 100, false);
    // Each probe starts unselected, so no resize handle is in reach.
    const probe = (x: number, y: number) => {
      ok(target, { type: 'setSelection', ids: [] });
      click(target, x, y);
      return selection(target);
    };
    expect(probe(50, 50)).toEqual([]);
    expect(probe(50, 4)).toEqual([a]);
    expect(probe(50, 4.5)).toEqual([]);
    expect(probe(-4, 50)).toEqual([a]);
    ok(target, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 2 } });
    expect(probe(50, 2.5)).toEqual([]);
    expect(probe(50, 2)).toEqual([a]);
    ok(target, { type: 'setNodeProps', id: a, props: { stroke: { color: black, width: 20 } } });
    expect(probe(50, 10)).toEqual([a]);
    expect(probe(50, 10.5)).toEqual([]);
  });

  it('does not hit hidden nodes', () => {
    const target = editor();
    const below = rect(target, 0, 0, 10, 10);
    const above = rect(target, 0, 0, 10, 10);
    ok(target, { type: 'setNodeProps', id: above, props: { visible: false } });
    click(target, 5, 5);
    expect(selection(target)).toEqual([below]);
  });

  it('hits a filled path inside its fill region, with the fill rule', () => {
    const target = editor();
    // Two nested squares, the inner one wound the same way: a hole only under evenodd.
    const [id] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'line', 'close', 'move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 100, 0, 100, 100, 0, 100, 25, 25, 75, 25, 75, 75, 25, 75],
      fillRule: 'evenodd',
      fill: red,
      stroke: null,
    });
    click(target, 10, 50);
    expect(selection(target)).toEqual([id]);
    click(target, 50, 50);
    expect(selection(target)).toEqual([]);
    ok(target, { type: 'deleteNodes', ids: [id!] });
    const [nonzero] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'line', 'close', 'move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 100, 0, 100, 100, 0, 100, 25, 25, 75, 25, 75, 75, 25, 75],
      fill: red,
      stroke: null,
    });
    click(target, 50, 50);
    expect(selection(target)).toEqual([nonzero]);
  });

  it('hits an open unfilled curve near its flattened outline only', () => {
    const target = editor();
    // A cubic from (0, 0) to (100, 0) bulging to y = 75 at t = 1/2.
    const [id] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'cubic'],
      points: [0, 0, 0, 100, 100, 100, 100, 0],
    });
    click(target, 50, 75);
    expect(selection(target)).toEqual([id]);
    click(target, 50, 40);
    expect(selection(target)).toEqual([]);
    // The open path's implicit closing chord along y = 0 is not part of its outline.
    click(target, 50, 0);
    expect(selection(target)).toEqual([]);
  });
});

describe('P5-A02 marquee selection', () => {
  it('selects every visible node whose frame intersects the marquee; shift adds', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    const b = rect(target, 20, 0, 10, 10);
    const c = rect(target, 40, 0, 10, 10);
    const hidden = rect(target, 0, 0, 50, 10);
    ok(target, { type: 'setNodeProps', id: hidden, props: { visible: false } });
    drag(target, [5, 20], [25, 5]);
    expect(selection(target)).toEqual([a, b]);
    expect(target.query({ type: 'overlay' })).toBeNull();
    drag(target, [45, 20], [45, 9], shift);
    expect(selection(target)).toEqual([a, b, c]);
    drag(target, [60, 60], [70, 70]);
    expect(selection(target)).toEqual([]);
  });

  it('shows the marquee as overlay state while dragging, never in the document', () => {
    const target = editor();
    const before = serializeDocument(target.query({ type: 'document' }));
    pointer(target, 'pointerdown', 10, 10);
    pointer(target, 'pointermove', 4, 30);
    expect(target.query({ type: 'overlay' })).toEqual({
      kind: 'marquee',
      frame: { x: 4, y: 10, width: 6, height: 20 },
    });
    key(target, 'Escape');
    expect(target.query({ type: 'overlay' })).toBeNull();
    expect(serializeDocument(target.query({ type: 'document' }))).toBe(before);
  });

  it('can select a path through its control points (accepted in P5)', () => {
    const target = editor();
    const [id] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'cubic'],
      points: [0, 0, 0, 100, 100, 100, 100, 0],
    });
    drag(target, [40, 120], [60, 95]);
    expect(selection(target)).toEqual([id]);
  });
});

describe('P5-A03 move', () => {
  it('moves every selected frame by the same delta as one undo step', () => {
    const target = editor();
    const a = rect(target, 0, 0, 40, 40);
    const [p] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line'],
      points: [60, 0, 70, 40],
    });
    ok(target, { type: 'setSelection', ids: [a, p!] });
    const points = target.query({ type: 'node', id: p! });
    const depth = history(target).undoDepth;
    drag(target, [20, 20], [27, 12]);
    expect(frame(target, a)).toEqual({ x: 7, y: -8, width: 40, height: 40 });
    expect(frame(target, p!)).toEqual({ x: 67, y: -8, width: 10, height: 40 });
    const moved = target.query({ type: 'node', id: p! });
    expect(moved?.type === 'path' && moved.path).toEqual(points?.type === 'path' && points.path);
    expect(history(target).undoDepth).toBe(depth + 1);
    ok(target, { type: 'undo' });
    expect(frame(target, a)).toEqual({ x: 0, y: 0, width: 40, height: 40 });
  });

  it('a click on a node selects it without a step; Escape cancels a drag', () => {
    const target = editor();
    const a = rect(target, 0, 0, 40, 40);
    const depth = history(target).undoDepth;
    click(target, 20, 20);
    expect(selection(target)).toEqual([a]);
    expect(history(target).undoDepth).toBe(depth);
    pointer(target, 'pointerdown', 20, 20);
    pointer(target, 'pointermove', 50, 50);
    key(target, 'Escape');
    pointer(target, 'pointerup', 50, 50);
    expect(frame(target, a)).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    expect(history(target).undoDepth).toBe(depth);
  });

  it('ignores a second pointerdown during a drag', () => {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    pointer(target, 'pointerdown', 5, 5);
    pointer(target, 'pointermove', 8, 5);
    pointer(target, 'pointerdown', 500, 500);
    pointer(target, 'pointermove', 9, 5);
    pointer(target, 'pointerup', 9, 5);
    expect(frame(target, a)).toEqual({ x: 4, y: 0, width: 10, height: 10 });
    expect(selection(target)).toEqual([a]);
  });
});

describe('P5-A03 resize', () => {
  function twoSelected() {
    const target = editor();
    const a = rect(target, 0, 0, 10, 10);
    const b = rect(target, 30, 10, 10, 30);
    ok(target, { type: 'setSelection', ids: [a, b] });
    // Selection box: (0, 0) to (40, 40).
    return { target, a, b };
  }

  it('scales the box about the opposite handle and maps every frame by the same affine', () => {
    const { target, a, b } = twoSelected();
    const depth = history(target).undoDepth;
    drag(target, [40, 40], [80, 60]);
    expect(frame(target, a)).toEqual({ x: 0, y: 0, width: 20, height: 15 });
    expect(frame(target, b)).toEqual({ x: 60, y: 15, width: 20, height: 45 });
    expect(history(target).undoDepth).toBe(depth + 1);
  });

  it('an edge handle scales one axis', () => {
    const { target, a, b } = twoSelected();
    drag(target, [0, 20], [20, 20]);
    expect(frame(target, a)).toEqual({ x: 20, y: 0, width: 5, height: 10 });
    expect(frame(target, b)).toEqual({ x: 35, y: 10, width: 5, height: 30 });
  });

  it('clamps sizes at 0 when dragged past the opposite handle', () => {
    const { target, a, b } = twoSelected();
    drag(target, [40, 20], [-50, 20]);
    expect(frame(target, a)).toEqual({ x: 0, y: 0, width: 0, height: 10 });
    expect(frame(target, b)).toEqual({ x: 0, y: 10, width: 0, height: 30 });
    ok(target, { type: 'undo' });
    expect(frame(target, b)).toEqual({ x: 30, y: 10, width: 10, height: 30 });
  });

  it('keeps unit-box path points and stroke width unchanged', () => {
    const target = editor();
    const [p] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 10, 0, 10, 10],
      fill: red,
    });
    ok(target, { type: 'setSelection', ids: [p!] });
    const before = target.query({ type: 'node', id: p! });
    drag(target, [10, 10], [30, 50]);
    const after = target.query({ type: 'node', id: p! });
    expect(after?.frame).toEqual({ x: 0, y: 0, width: 30, height: 50 });
    expect(after?.type === 'path' && [after.path, after.stroke]).toEqual(
      before?.type === 'path' && [before.path, before.stroke],
    );
  });

  it('does not scale an axis where the box has size 0', () => {
    const target = editor();
    const [line] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line'],
      points: [10, 0, 10, 40],
    });
    ok(target, { type: 'setSelection', ids: [line!] });
    // The corner handle at (10, 40) scales y only.
    drag(target, [10, 40], [30, 80]);
    expect(frame(target, line!)).toEqual({ x: 10, y: 0, width: 0, height: 80 });
  });
});

describe('Rectangle tool', () => {
  it('a drag from a to b creates the rectangle min(a, b) to max(a, b) as one step', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    drag(target, [50, 10], [20, 40]);
    const [id] = target.query({ type: 'document' }).pages[0].children;
    expect(frame(target, id!)).toEqual({ x: 20, y: 10, width: 30, height: 30 });
    expect(history(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(selection(target)).toEqual([id]);
    expect(seen.filter((e) => e.type === 'document').at(-1)).toMatchObject({
      cause: 'gesture-commit',
    });
    ok(target, { type: 'undo' });
    expect(target.query({ type: 'document' }).pages[0].children).toEqual([]);
  });

  it('a click without movement creates nothing', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    const before = target.getSnapshot();
    click(target, 5, 5);
    expect(target.getSnapshot()).toBe(before);
  });
});

describe('Path tool', () => {
  function pathTool() {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'path' });
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    return { target, seen };
  }

  const created = (target: Editor) => {
    const [id] = target.query({ type: 'document' }).pages[0].children;
    return target.query({ type: 'node', id: id! });
  };

  it('clicks add line anchors; Enter ends an open path as one transaction', () => {
    const { target, seen } = pathTool();
    click(target, 0, 0);
    click(target, 10, 0);
    click(target, 10, 20);
    expect(seen.filter((event) => event.type === 'document')).toEqual([]);
    expect(target.query({ type: 'overlay' })).toEqual({
      kind: 'path',
      anchors: [
        { point: { x: 0, y: 0 }, in: null, out: null },
        { point: { x: 10, y: 0 }, in: null, out: null },
        { point: { x: 10, y: 20 }, in: null, out: null },
      ],
    });
    key(target, 'Enter');
    const node = created(target);
    expect(node?.frame).toEqual({ x: 0, y: 0, width: 10, height: 20 });
    expect(node?.type === 'path' && node.path).toEqual({
      verbs: ['move', 'line', 'line'],
      points: [0, 0, 1, 0, 1, 1],
      fillRule: 'nonzero',
    });
    expect(history(target).undoDepth).toBe(1);
    expect(selection(target)).toEqual([node?.id]);
    expect(target.query({ type: 'overlay' })).toBeNull();
  });

  it('a click on the first anchor closes the path', () => {
    const { target } = pathTool();
    click(target, 0, 0);
    click(target, 10, 0);
    click(target, 10, 10);
    click(target, 1, 1);
    const node = created(target);
    expect(node?.type === 'path' && node.path.verbs).toEqual([
      'move',
      'line',
      'line',
      'line',
      'close',
    ]);
  });

  it('press-and-drag adds a cubic anchor with symmetric handles', () => {
    const { target } = pathTool();
    click(target, 0, 0);
    pointer(target, 'pointerdown', 20, 0);
    pointer(target, 'pointermove', 30, 10);
    pointer(target, 'pointerup', 30, 10);
    click(target, 40, 0);
    key(target, 'Enter');
    const node = created(target);
    // Segment 1: in-handle (10, -10); segment 2: out-handle (30, 10). Box (0, -10) to (40, 10).
    expect(node?.frame).toEqual({ x: 0, y: -10, width: 40, height: 20 });
    expect(node?.type === 'path' && node.path).toEqual({
      verbs: ['move', 'cubic', 'cubic'],
      points: [0, 0.5, 0, 0.5, 0.25, 0, 0.5, 0.5, 0.75, 1, 1, 0.5, 1, 0.5],
      fillRule: 'nonzero',
    });
  });

  it('Escape cancels without a document change; Enter with one anchor does nothing', () => {
    const { target, seen } = pathTool();
    click(target, 0, 0);
    key(target, 'Enter');
    click(target, 10, 0);
    key(target, 'Escape');
    expect(seen.filter((event) => event.type === 'document')).toEqual([]);
    expect(target.query({ type: 'overlay' })).toBeNull();
  });

  it('a tool switch drops the overlay', () => {
    const { target } = pathTool();
    click(target, 0, 0);
    ok(target, { type: 'setTool', tool: 'select' });
    ok(target, { type: 'setTool', tool: 'path' });
    expect(target.query({ type: 'overlay' })).toBeNull();
  });
});

describe('P5-U3 review follow-ups', () => {
  it('uses the pointerup point as the drag end', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    pointer(target, 'pointerdown', 0, 0);
    pointer(target, 'pointermove', 5, 5);
    pointer(target, 'pointerup', 10, 10);
    const [id] = target.query({ type: 'document' }).pages[0].children;
    expect(frame(target, id!)).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    ok(target, { type: 'setTool', tool: 'select' });
    pointer(target, 'pointerdown', 5, 5);
    pointer(target, 'pointermove', 6, 5);
    pointer(target, 'pointerup', 25, 5);
    expect(frame(target, id!)).toEqual({ x: 20, y: 0, width: 10, height: 10 });
  });

  it('a click on a node inside a multi-selection selects only that node', () => {
    const target = editor();
    const a = rect(target, 0, 0, 40, 40);
    const b = rect(target, 60, 0, 40, 40);
    ok(target, { type: 'setSelection', ids: [a, b] });
    const depth = history(target).undoDepth;
    click(target, 20, 20);
    expect(selection(target)).toEqual([a]);
    expect(history(target).undoDepth).toBe(depth);
  });

  it('moves a selected node too small to keep its handles apart', () => {
    const target = editor();
    const a = rect(target, 0, 0, 4, 4);
    ok(target, { type: 'setSelection', ids: [a] });
    drag(target, [2, 2], [12, 2]);
    expect(frame(target, a)).toEqual({ x: 10, y: 0, width: 4, height: 4 });
    // From outside the box, the nearest handle still resizes.
    drag(target, [15, 5], [20, 10]);
    expect(frame(target, a)).toEqual({ x: 10, y: 0, width: 9, height: 9 });
  });

  it('copies host points, so a reused event object does not move the drag start', () => {
    const target = editor();
    const a = rect(target, 0, 0, 40, 40);
    const point = { x: 20, y: 20 };
    ok(target, { type: 'input', event: { kind: 'pointerdown', point, modifiers: none } });
    point.x = 30;
    ok(target, { type: 'input', event: { kind: 'pointermove', point, modifiers: none } });
    ok(target, { type: 'input', event: { kind: 'pointerup', point, modifiers: none } });
    expect(frame(target, a)).toEqual({ x: 10, y: 0, width: 40, height: 40 });
  });

  it('resizes about the opposite handle with a non-zero origin and a top handle', () => {
    const target = editor();
    const a = rect(target, 100, 200, 40, 20);
    ok(target, { type: 'setSelection', ids: [a] });
    // The top-left handle at (100, 200) scales about (140, 220).
    drag(target, [100, 200], [60, 180]);
    expect(frame(target, a)).toEqual({ x: 60, y: 180, width: 80, height: 40 });
    // The top edge handle at (100, 180) scales y only.
    drag(target, [100, 180], [100, 200]);
    expect(frame(target, a)).toEqual({ x: 60, y: 200, width: 80, height: 20 });
  });

  it('an edge handle on a zero-size axis is not a handle', () => {
    const target = editor();
    const [line] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line'],
      points: [10, 0, 10, 40],
    });
    ok(target, { type: 'setSelection', ids: [line!] });
    // (10, 20) is the east and west edge handle of a zero-width box: the press moves the line.
    drag(target, [10, 20], [30, 20]);
    expect(frame(target, line!)).toEqual({ x: 30, y: 0, width: 0, height: 40 });
  });

  it('Escape cancels a resize and a rectangle drag; a second press during a resize is ignored', () => {
    const target = editor();
    const a = rect(target, 0, 0, 40, 40);
    ok(target, { type: 'setSelection', ids: [a] });
    const depth = history(target).undoDepth;
    pointer(target, 'pointerdown', 40, 40);
    pointer(target, 'pointermove', 60, 60);
    pointer(target, 'pointerdown', 0, 0);
    pointer(target, 'pointermove', 80, 80);
    expect(frame(target, a)).toEqual({ x: 0, y: 0, width: 80, height: 80 });
    key(target, 'Escape');
    pointer(target, 'pointerup', 80, 80);
    expect(frame(target, a)).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    ok(target, { type: 'setTool', tool: 'rectangle' });
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 120, 120);
    key(target, 'Escape');
    pointer(target, 'pointerup', 120, 120);
    expect(target.query({ type: 'document' }).pages[0].children).toEqual([a]);
    expect(history(target).undoDepth).toBe(depth);
  });

  it('undo, loadDocument and setTool during a real drag leave no stale tool state', () => {
    const target = editor();
    const a = rect(target, 0, 0, 40, 40);
    const empty = createEditor({ ids: createCounterIdSource('m') }).query({ type: 'document' });
    for (const interrupt of [
      { type: 'undo' },
      { type: 'loadDocument', document: target.query({ type: 'document' }) },
      { type: 'setTool', tool: 'rectangle' },
    ] as Command[]) {
      if (interrupt.type === 'undo')
        ok(target, { type: 'createRectangle', frame: { x: 0, y: 60, width: 1, height: 1 } });
      ok(target, { type: 'setTool', tool: 'select' });
      pointer(target, 'pointerdown', 20, 20);
      pointer(target, 'pointermove', 30, 20);
      ok(target, interrupt);
      pointer(target, 'pointermove', 50, 20);
      pointer(target, 'pointerup', 50, 20);
      expect(frame(target, a)).toEqual({ x: 0, y: 0, width: 40, height: 40 });
    }
    ok(target, { type: 'loadDocument', document: empty });
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 0, redoDepth: 0 });
  });

  it('hits the closing chord of an unfilled closed path, and flattens by zoom', () => {
    const target = editor();
    const [triangle] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 100, 0, 50, 100],
    });
    const probe = (x: number, y: number) => {
      ok(target, { type: 'setSelection', ids: [] });
      click(target, x, y);
      return selection(target);
    };
    expect(probe(25, 50)).toEqual([triangle]);
    ok(target, { type: 'deleteNodes', ids: [triangle!] });
    // A cubic reaching y = 75 at t = 1/2, without a stroke: at zoom 64 the pick radius is 1/16
    // page unit, so the flattened outline must lie within 0.25 / 64 of the curve at the apex.
    const [curve] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'cubic'],
      points: [0, 0, 0, 100, 100, 100, 100, 0],
      stroke: null,
    });
    ok(target, { type: 'setViewport', camera: { position: { x: 0, y: 0 }, zoom: 64 } });
    expect(probe(50, 75)).toEqual([curve]);
    expect(probe(50, 74.9)).toEqual([]);
  });

  it('a double click adds no second anchor at the same point', () => {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'path' });
    click(target, 0, 0);
    click(target, 0, 0);
    key(target, 'Enter');
    expect(target.query({ type: 'document' }).pages[0].children).toEqual([]);
    const overlay = target.query({ type: 'overlay' });
    expect(overlay?.kind === 'path' && overlay.anchors).toHaveLength(1);
    expect(Object.isFrozen(overlay)).toBe(true);
  });

  it('a click on a resize handle records no step and no change', () => {
    const target = editor();
    const a = rect(target, 0, 0, 40, 40);
    ok(target, { type: 'setSelection', ids: [a] });
    const before = target.getSnapshot();
    click(target, 40, 40);
    expect(target.getSnapshot()).toBe(before);
  });
});
