import { parseDocument, serializeDocument, type Frame } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  DEFAULT_PATH_STROKE,
  DEFAULT_RECTANGLE_FILL,
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
  type Modifiers,
  type ToolName,
} from '../../packages/editor-core/src/index.js';
// Source imports: the draft, the gesture API and the resize functions are package-internal.
import { Draft } from '../../packages/editor-core/src/draft.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { boundsOf } from '../../packages/editor-core/src/hit-test.js';
import { mapNodeInPageSpace, scaleAbout } from '../../packages/editor-core/src/resize.js';

// MVP M1-U4, M1-A11 (M1 contract, section 7): the ellipse, line and frame tools, and the select
// tool's move and resize of nested and rotated selections (section 4.4), all through `input`.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const shift: Modifiers = { ...none, shift: true };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });

type Loose = Record<string, unknown> & { id: string };

function base(id: string, parent: string, frame: Frame, rotation = 0) {
  return { id, name: id, parent, frame, rotation, constraints: START, opacity: 1, visible: true };
}

function rect(id: string, parent: string, frame: Frame, rotation = 0, extra: object = {}): Loose {
  return {
    ...base(id, parent, frame, rotation),
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
    ...extra,
  };
}

function triangle(id: string, parent: string, frame: Frame, rotation = 0): Loose {
  return {
    ...base(id, parent, frame, rotation),
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

function container(
  type: 'group' | 'frame',
  id: string,
  parent: string,
  children: string[],
  frame: Frame,
  rotation = 0,
): Loose {
  const node: Loose = { ...base(id, parent, frame, rotation), type, children };
  return type === 'frame' ? { ...node, fill: DEFAULT_FRAME_FILL, stroke: null } : node;
}

function doc(pages: [string, string[]][], nodes: Loose[]) {
  return {
    schemaVersion: 2,
    id: 'doc',
    pages: pages.map(([id, children]) => ({ id, name: id, children })),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

function editor(document?: unknown): Editor {
  return createEditor({ ids: createCounterIdSource('n'), document });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  [x, y]: readonly [number, number],
  modifiers = none,
) {
  ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers } });
}

function drag(
  target: Editor,
  from: readonly [number, number],
  to: readonly [number, number],
  modifiers = none,
) {
  pointer(target, 'pointerdown', from, modifiers);
  const steps = 5;
  for (let i = 1; i <= steps; i += 1) {
    const at = [
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
    ] as const;
    pointer(target, 'pointermove', at, modifiers);
  }
  pointer(target, 'pointerup', to, modifiers);
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const nodeOf = (target: Editor, id: string) => target.query({ type: 'node', id })!;
const roots = (target: Editor) => target.query({ type: 'document' }).pages[0]!.children;
const history = (target: Editor) => target.query({ type: 'history' });

function near(actual: number, expected: number) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(expected)));
}

function nearFrame(actual: Frame, expected: Frame) {
  near(actual.x, expected.x);
  near(actual.y, expected.y);
  near(actual.width, expected.width);
  near(actual.height, expected.height);
}

describe('M1-A11 ellipse and frame tools', () => {
  for (const [tool, type, fill] of [
    ['ellipse', 'ellipse', DEFAULT_RECTANGLE_FILL],
    ['frame', 'frame', DEFAULT_FRAME_FILL],
  ] as const) {
    it(`the ${tool} tool drags a box from a to b as one step and selects it`, () => {
      const target = editor();
      ok(target, { type: 'setTool', tool });
      const seen: EditorEvent[] = [];
      target.subscribe((event) => seen.push(event));
      drag(target, [50, 10], [20, 40]);
      const [id] = roots(target);
      const node = nodeOf(target, id!);
      expect(node).toMatchObject({
        type,
        frame: f(20, 10, 30, 30),
        rotation: 0,
        fill,
        stroke: null,
      });
      expect(history(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
      expect(target.query({ type: 'selection' })).toEqual([id]);
      expect(seen.filter((event) => event.type === 'document').at(-1)).toMatchObject({
        cause: 'gesture-commit',
      });
      ok(target, { type: 'undo' });
      expect(roots(target)).toEqual([]);
    });

    it(`the ${tool} tool: a click creates nothing, Escape cancels`, () => {
      const target = editor();
      ok(target, { type: 'setTool', tool });
      const before = target.getSnapshot();
      pointer(target, 'pointerdown', [5, 5]);
      pointer(target, 'pointerup', [5, 5]);
      expect(target.getSnapshot()).toBe(before);
      pointer(target, 'pointerdown', [5, 5]);
      pointer(target, 'pointermove', [25, 25]);
      expect(roots(target)).toHaveLength(1);
      ok(target, { type: 'input', event: { kind: 'keydown', key: 'Escape', modifiers: none } });
      pointer(target, 'pointerup', [25, 25]);
      expect(roots(target)).toEqual([]);
      expect(history(target).undoDepth).toBe(0);
    });
  }

  it('drawing tools create at the page root over a top-level frame, which adopts nothing', () => {
    const target = editor(
      doc(
        [['p', ['F', 'x']]],
        [container('frame', 'F', 'p', [], f(0, 0, 200, 200)), rect('x', 'p', f(10, 10, 20, 20))],
      ),
    );
    for (const tool of ['rectangle', 'ellipse', 'frame', 'line'] as ToolName[]) {
      ok(target, { type: 'setTool', tool });
      drag(target, [5, 5], [50, 60]);
    }
    const children = roots(target);
    expect(children).toHaveLength(6);
    expect(children.slice(0, 2)).toEqual(['F', 'x']);
    for (const id of children.slice(2)) expect(nodeOf(target, id).parent).toBe('p');
    expect(nodeOf(target, 'F')).toMatchObject({ children: [] });
    const drawn = nodeOf(target, children[4]!);
    expect(drawn).toMatchObject({ type: 'frame', frame: f(5, 5, 45, 55), children: [] });
    expect(nodeOf(target, 'x').parent).toBe('p');
  });
});

describe('M1-A11 line tool', () => {
  function lineTool() {
    const target = editor();
    ok(target, { type: 'setTool', tool: 'line' });
    return target;
  }

  it('drags from start to end as one step, with the default stroke and no arrows', () => {
    const target = lineTool();
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    drag(target, [50, 10], [20, 40]);
    const [id] = roots(target);
    // The empty document drew n1 and n2; the line keeps the one ID its first update drew.
    expect(id).toBe('n3');
    expect(nodeOf(target, id!)).toMatchObject({
      type: 'line',
      frame: f(20, 10, 30, 30),
      points: [1, 0, 0, 1],
      rotation: 0,
      stroke: DEFAULT_PATH_STROKE,
      startArrow: 'none',
      endArrow: 'none',
    });
    expect(history(target)).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(target.query({ type: 'selection' })).toEqual([id]);
    const documents = seen.filter((event) => event.type === 'document');
    expect(documents.map((event) => event.type === 'document' && event.cause)).toEqual([
      ...Array<string>(6).fill('gesture-update'),
      'gesture-commit',
    ]);
    ok(target, { type: 'undo' });
    expect(roots(target)).toEqual([]);
    ok(target, { type: 'redo' });
    expect(nodeOf(target, 'n3')).toMatchObject({ points: [1, 0, 0, 1] });
  });

  it('follows the end through every quadrant, and through the start point', () => {
    const target = lineTool();
    pointer(target, 'pointerdown', [10, 10]);
    pointer(target, 'pointermove', [20, 30]);
    expect(nodeOf(target, 'n3')).toMatchObject({ frame: f(10, 10, 10, 20), points: [0, 0, 1, 1] });
    pointer(target, 'pointermove', [10, 10]);
    expect(nodeOf(target, 'n3')).toMatchObject({ frame: f(10, 10, 0, 0), points: [0, 0, 0, 0] });
    pointer(target, 'pointermove', [0, 30]);
    expect(nodeOf(target, 'n3')).toMatchObject({ frame: f(0, 10, 10, 20), points: [1, 0, 0, 1] });
    pointer(target, 'pointerup', [-10, 0]);
    expect(nodeOf(target, 'n3')).toMatchObject({ frame: f(-10, 0, 20, 10), points: [1, 1, 0, 0] });
    expect(history(target).undoDepth).toBe(1);
  });

  it('Shift constrains the end to 45° steps, keeping the drag length', () => {
    const target = lineTool();
    drag(target, [0, 0], [10, 3], shift);
    const length = Math.hypot(10, 3);
    expect(nodeOf(target, 'n3')).toMatchObject({ frame: f(0, 0, length, 0), points: [0, 0, 1, 0] });
    drag(target, [0, 0], [-1, 20], shift);
    expect(nodeOf(target, 'n4')).toMatchObject({
      frame: f(0, 0, 0, Math.hypot(1, 20)),
      points: [0, 0, 0, 1],
    });
    drag(target, [0, 0], [-10, -9], shift);
    const side = Math.hypot(10, 9) * Math.SQRT1_2;
    expect(nodeOf(target, 'n5')).toMatchObject({
      frame: f(-side, -side, side, side),
      points: [1, 1, 0, 0],
    });
  });

  it('a click creates nothing; Escape cancels', () => {
    const target = lineTool();
    const before = target.getSnapshot();
    pointer(target, 'pointerdown', [5, 5]);
    pointer(target, 'pointerup', [5, 5]);
    expect(target.getSnapshot()).toBe(before);
    pointer(target, 'pointerdown', [5, 5]);
    pointer(target, 'pointermove', [25, 5]);
    pointer(target, 'pointermove', [25, 25]);
    ok(target, { type: 'input', event: { kind: 'keydown', key: 'Escape', modifiers: none } });
    pointer(target, 'pointerup', [25, 25]);
    expect(roots(target)).toEqual([]);
    expect(history(target).undoDepth).toBe(0);
  });

  it('the gesture edit fails outside a gesture and for a node that is not a line', () => {
    const target = editor(doc([['p', ['x']]], [rect('x', 'p', f(0, 0, 10, 10))]));
    const { gesture } = internalsOf(target);
    const edit = { kind: 'line', id: 'x', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } as const;
    expect(gesture.edit(edit)).toMatchObject({ ok: false, code: 'editor.invalid-command' });
    gesture.begin();
    expect(gesture.edit(edit)).toMatchObject({ ok: false, code: 'editor.invalid-command' });
    expect(gesture.edit({ ...edit, id: 'missing' })).toMatchObject({
      ok: false,
      code: 'editor.unknown-node',
    });
    gesture.cancel();
  });
});

describe('M1-A11 select tool: move', () => {
  it('converts the page delta into a nested node parent space; its group refits at commit', () => {
    // a in G, G turned by π/2 about (150, 150).
    const value = doc(
      [['p', ['G']]],
      [
        container('group', 'G', 'p', ['a', 'b'], f(100, 100, 100, 100), Math.PI / 2),
        rect('a', 'G', f(0, 0, 50, 50)),
        rect('b', 'G', f(50, 50, 50, 50)),
      ],
    );
    const target = editor(value);
    ok(target, { type: 'setSelection', ids: ['a'] });
    const before = boundsOf(target.query({ type: 'document' }), ['a'])!;
    const original = text(target);
    // a covers page (150..200, 100..150); press inside it, away from the handles.
    drag(target, [175, 140], [185, 160]);
    const after = boundsOf(target.query({ type: 'document' }), ['a'])!;
    nearFrame(after, { ...before, x: before.x + 10, y: before.y + 20 });
    // b did not move on the page, and the step undoes byte-identically.
    nearFrame(boundsOf(target.query({ type: 'document' }), ['b'])!, f(100, 150, 50, 50));
    expect(history(target).undoDepth).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(original);
  });

  it('moves a rotated top-level frame and keeps its children in place relative to it', () => {
    const value = doc(
      [['p', ['F']]],
      [
        { ...container('frame', 'F', 'p', ['c'], f(0, 0, 100, 100)), rotation: Math.PI / 4 },
        rect('c', 'F', f(10, 10, 10, 10)),
      ],
    );
    const target = editor(value);
    drag(target, [50, 50], [60, 45]);
    expect(nodeOf(target, 'F')).toMatchObject({
      frame: f(10, -5, 100, 100),
      rotation: Math.PI / 4,
    });
    expect(nodeOf(target, 'c').frame).toEqual(f(10, 10, 10, 10));
  });
});

describe('M1-A11 select tool: resize', () => {
  it('a single rotated node resizes in its own axes about the opposite handle', () => {
    // 100 × 50 turned by π/2 about (50, 25): local (100, 50) is at page (25, 75) and local
    // (0, 0) at page (75, -25).
    const target = editor(doc([['p', ['r']]], [rect('r', 'p', f(0, 0, 100, 50), Math.PI / 2)]));
    ok(target, { type: 'setSelection', ids: ['r'] });
    // A page delta (-10, 20) is (20, 10) in the node's axes: both scales are 1.2.
    drag(target, [25, 75], [15, 95]);
    const node = nodeOf(target, 'r');
    expect(node.rotation).toBe(Math.PI / 2);
    nearFrame(node.frame, f(-15, 5, 120, 60));
    expect(history(target).undoDepth).toBe(1);
  });

  it('an edge handle of a rotated node scales one of its own axes', () => {
    const target = editor(doc([['p', ['r']]], [rect('r', 'p', f(0, 0, 100, 50), Math.PI / 2)]));
    ok(target, { type: 'setSelection', ids: ['r'] });
    // The handle at local (50, 50) is at page (25, 25); moving it 30 page units to the left
    // moves it 30 along the node's own y axis.
    drag(target, [25, 25], [-5, 25]);
    const node = nodeOf(target, 'r');
    // Height 80 about local y = 0 (page x = 75): the box spans page x -5..75.
    nearFrame(node.frame, f(-15, -15, 100, 80));
  });

  it('a nested node resizes through its parent chain; its rotated group refits', () => {
    const value = doc(
      [['p', ['G']]],
      [
        container('group', 'G', 'p', ['a', 'b'], f(100, 100, 100, 100), Math.PI / 2),
        rect('a', 'G', f(0, 0, 50, 50)),
        rect('b', 'G', f(50, 50, 50, 50)),
      ],
    );
    const target = editor(value);
    ok(target, { type: 'setSelection', ids: ['a'] });
    // a's local (0, 0) is at page (200, 100) and its local (50, 50) at (150, 150). Dragging
    // the latter by (-50, 50) is (50, 50) in a's axes: a doubles about page (200, 100).
    drag(target, [150, 150], [100, 200]);
    nearFrame(boundsOf(target.query({ type: 'document' }), ['a'])!, f(100, 100, 100, 100));
    nearFrame(boundsOf(target.query({ type: 'document' }), ['b'])!, f(100, 150, 50, 50));
    nearFrame(boundsOf(target.query({ type: 'document' }), ['G'])!, f(100, 100, 100, 100));
    expect(nodeOf(target, 'a').rotation).toBe(0);
  });

  /** The tool's map for a drag of the right edge handle of the selection box by `dx`. */
  function oracle(value: unknown, ids: string[], dx: number): string {
    const parsed = parseDocument(JSON.stringify(value));
    if (!parsed.ok) throw new Error(parsed.code);
    const box = boundsOf(parsed.document, ids)!;
    const from = box.x + box.width;
    const scale = Math.max(0, (from + dx - box.x) / (from - box.x));
    const draft = new Draft(parsed.document);
    for (const id of ids)
      mapNodeInPageSpace(draft, id, scaleAbout(scale, 1, { x: box.x, y: box.y }));
    const done = draft.finish(() => null, { refit: true });
    if ('ok' in done) throw new Error(done.code);
    return serializeDocument(done);
  }

  function rightHandle(target: Editor, ids: string[]): [number, number] {
    const box = boundsOf(target.query({ type: 'document' }), ids)!;
    return [box.x + box.width, box.y + 0.5 * box.height];
  }

  it('a multi-selection maps each node by the box scale from the gesture start (mapNodeInPageSpace)', () => {
    const value = doc(
      [['p', ['r', 'P']]],
      [
        rect('r', 'p', f(0, 0, 40, 20), Math.PI / 6),
        triangle('P', 'p', f(60, 40, 40, 40), Math.PI / 4),
      ],
    );
    const target = editor(value);
    ok(target, { type: 'setSelection', ids: ['r', 'P'] });
    const original = text(target);
    const handle = rightHandle(target, ['r', 'P']);
    // Five moves, then the up point: the result is that of the last point alone.
    drag(target, handle, [handle[0] + 30, handle[1]]);
    expect(text(target)).toBe(oracle(value, ['r', 'P'], 30));
    // The rotated path under sx ≠ sy maps its points exactly: its unit points changed.
    const path = nodeOf(target, 'P');
    expect(path.type === 'path' && path.path.points).not.toEqual([0, 0, 1, 0, 1, 1]);
    expect(path.rotation).toBe(Math.PI / 4);
    expect(nodeOf(target, 'r').rotation).toBe(Math.PI / 6);
    expect(history(target).undoDepth).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(original);
  });

  it('a drag back to the start leaves a multi-selection where it began', () => {
    const value = doc(
      [['p', ['r', 'P']]],
      [
        rect('r', 'p', f(0, 0, 40, 20), Math.PI / 6),
        triangle('P', 'p', f(60, 40, 40, 40), Math.PI / 4),
      ],
    );
    const target = editor(value);
    ok(target, { type: 'setSelection', ids: ['r', 'P'] });
    const original = text(target);
    const handle = rightHandle(target, ['r', 'P']);
    pointer(target, 'pointerdown', handle);
    pointer(target, 'pointermove', [handle[0] + 25, handle[1]]);
    pointer(target, 'pointermove', [handle[0] - 20, handle[1]]);
    pointer(target, 'pointerup', handle);
    expect(text(target)).toBe(original);
  });

  it('a nested multi-selection maps through each parent chain; groups refit at commit', () => {
    const value = doc(
      [['p', ['G', 'r', 'F']]],
      [
        container('group', 'G', 'p', ['a', 'b'], f(100, 0, 100, 100), 0.3),
        rect('a', 'G', f(0, 0, 50, 50)),
        rect('b', 'G', f(50, 50, 50, 50), 0.2),
        rect('r', 'p', f(0, 200, 30, 30)),
        container('frame', 'F', 'p', ['c'], f(300, 0, 100, 100)),
        {
          ...rect('c', 'F', f(80, 10, 10, 10)),
          constraints: { horizontal: 'end', vertical: 'start' },
        },
      ],
    );
    const target = editor(value);
    ok(target, { type: 'setSelection', ids: ['a', 'r', 'F'] });
    const handle = rightHandle(target, ['a', 'r', 'F']);
    drag(target, handle, [handle[0] + 40, handle[1]]);
    expect(text(target)).toBe(oracle(value, ['a', 'r', 'F'], 40));
    // The frame mapped like a leaf and its end-constrained child kept its right offset.
    const frame = nodeOf(target, 'F').frame;
    expect(nodeOf(target, 'c').frame.x).toBeCloseTo(frame.width - 20, 9);
  });

  it('a page-root multi-selection with rotation 0 keeps the P5 frames exactly', () => {
    const target = editor(
      doc(
        [['p', ['a', 'b']]],
        [rect('a', 'p', f(0, 0, 10, 10)), rect('b', 'p', f(30, 10, 10, 30))],
      ),
    );
    ok(target, { type: 'setSelection', ids: ['a', 'b'] });
    drag(target, [40, 40], [80, 60]);
    expect(nodeOf(target, 'a').frame).toEqual(f(0, 0, 20, 15));
    expect(nodeOf(target, 'b').frame).toEqual(f(60, 15, 20, 45));
  });

  it('a top-level frame resize applies its children constraints', () => {
    const value = doc(
      [['p', ['F']]],
      [
        container('frame', 'F', 'p', ['s', 'e', 'x'], f(0, 0, 100, 100)),
        rect('s', 'F', f(10, 10, 10, 10)),
        {
          ...rect('e', 'F', f(80, 10, 10, 10)),
          constraints: { horizontal: 'end', vertical: 'start' },
        },
        {
          ...rect('x', 'F', f(10, 40, 80, 10)),
          constraints: { horizontal: 'startEnd', vertical: 'scale' },
        },
      ],
    );
    const target = editor(value);
    ok(target, { type: 'setSelection', ids: ['F'] });
    drag(target, [100, 100], [150, 200]);
    expect(nodeOf(target, 'F').frame).toEqual(f(0, 0, 150, 200));
    expect(nodeOf(target, 's').frame).toEqual(f(10, 10, 10, 10));
    expect(nodeOf(target, 'e').frame).toEqual(f(130, 10, 10, 10));
    expect(nodeOf(target, 'x').frame).toEqual(f(10, 80, 130, 20));
  });

  it('Escape cancels a multi-selection resize', () => {
    const value = doc(
      [['p', ['r', 'P']]],
      [
        rect('r', 'p', f(0, 0, 40, 20), Math.PI / 6),
        triangle('P', 'p', f(60, 40, 40, 40), Math.PI / 4),
      ],
    );
    const target = editor(value);
    ok(target, { type: 'setSelection', ids: ['r', 'P'] });
    const original = text(target);
    const handle = rightHandle(target, ['r', 'P']);
    pointer(target, 'pointerdown', handle);
    pointer(target, 'pointermove', [handle[0] + 25, handle[1]]);
    expect(text(target)).not.toBe(original);
    ok(target, { type: 'input', event: { kind: 'keydown', key: 'Escape', modifiers: none } });
    pointer(target, 'pointerup', [handle[0] + 25, handle[1]]);
    expect(text(target)).toBe(original);
    expect(history(target).undoDepth).toBe(0);
  });
});
