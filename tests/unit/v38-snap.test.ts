import { type Frame, type LayoutGrid } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type Modifiers,
  type PagePoint,
} from '../../packages/editor-core/src/index.js';
import { MAX_SNAP_GRID_LINES, snapSet } from '../../packages/editor-core/src/snap.js';

// V-38 contract, V38-A04 (V38-N1, amending MVP M2 section 4.2): moves, resizes and draws snap to
// page guides and to the lines of visible layout grids of frames the gesture meets; not to hidden
// grids, a moving frame's own grid, a rotated frame's grid, nor with snapping off.

const SCHEMA = 8;
const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const RED = { r: 1, g: 0, b: 0, a: 0.1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const ctrl: Modifiers = { ...none, ctrl: true };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });
const seg = (ax: number, ay: number, bx: number, by: number) => ({ a: at(ax, ay), b: at(bx, by) });

type Loose = Record<string, unknown> & { id: string };

const base = (id: string, parent: string, frame: Frame, rotation = 0) => ({
  id,
  name: id,
  parent,
  frame,
  rotation,
  constraints: START,
  opacity: 1,
  visible: true,
  effects: [],
});

const rect = (id: string, parent: string, frame: Frame): Loose => ({
  ...base(id, parent, frame),
  type: 'rectangle',
  cornerRadii: [0, 0, 0, 0],
  fill: black,
  stroke: null,
});

const frameNode = (
  id: string,
  frame: Frame,
  children: string[],
  layoutGrids: LayoutGrid[],
  rotation = 0,
): Loose => ({
  ...base(id, 'p1', frame, rotation),
  type: 'frame',
  children,
  fill: DEFAULT_FRAME_FILL,
  stroke: null,
  layoutGrids,
});

/** Two stretch columns of 90 with a gutter of 20 on a 200 wide frame: lines 0, 90, 110, 200. */
const COLUMNS: LayoutGrid = {
  type: 'columns',
  count: 2,
  align: 'stretch',
  size: 100,
  gutter: 20,
  offset: 0,
  color: RED,
  visible: true,
};

function documentOf(nodes: Loose[], guides: unknown[] = []) {
  return {
    schemaVersion: SCHEMA,
    id: 'doc',
    pages: [
      {
        id: 'p1',
        name: 'p1',
        children: nodes.filter((n) => n.parent === 'p1').map((n) => n.id),
        ...(guides.length > 0 ? { guides } : {}),
      },
    ],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

function editor(document: unknown, selection: string[] = []): Editor {
  const target = createEditor({ ids: createCounterIdSource('n'), document });
  if (selection.length > 0) ok(target, { type: 'setSelection', ids: selection });
  return target;
}

function ok(target: Editor, command: Command): void {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
}

function drag(target: Editor, from: PagePoint, to: PagePoint, modifiers = none, release = true) {
  const send = (kind: 'pointerdown' | 'pointermove' | 'pointerup', point: PagePoint) =>
    target.execute({ type: 'input', event: { kind, point, modifiers } });
  send('pointerdown', from);
  send('pointermove', to);
  if (release) send('pointerup', to);
}

const frameOf = (target: Editor, id: string) => target.query({ type: 'node', id })!.frame;

describe('V38-A04 snapping to guides', () => {
  const GUIDED = documentOf([rect('m', 'p1', f(0, 0, 10, 10))], [{ axis: 'x', value: 50 }]);

  it('moves onto a guide (rulers hidden) and draws it across the snapped box', () => {
    const target = editor(GUIDED, ['m']);
    expect(target.query({ type: 'rulersVisible' })).toBe(false);
    drag(target, at(5, 5), at(47, 5), none, false);
    expect(frameOf(target, 'm')).toEqual(f(40, 0, 10, 10));
    expect(target.query({ type: 'snap' })).toEqual({
      guides: [seg(50, 0, 50, 10)],
      gaps: [],
      angle: null,
    });
  });

  it('does not snap with snapping off or Ctrl held', () => {
    const off = editor(GUIDED, ['m']);
    ok(off, { type: 'setSnapping', enabled: false });
    drag(off, at(5, 5), at(47, 5));
    expect(frameOf(off, 'm')).toEqual(f(42, 0, 10, 10));
    const held = editor(GUIDED, ['m']);
    drag(held, at(5, 5), at(47, 5), ctrl);
    expect(frameOf(held, 'm')).toEqual(f(42, 0, 10, 10));
  });

  it('resizes and draws onto a guide', () => {
    const resized = editor(GUIDED, ['m']);
    drag(resized, at(10, 10), at(47, 10));
    expect(frameOf(resized, 'm')).toEqual(f(0, 0, 50, 10));
    const drawn = editor(GUIDED);
    ok(drawn, { type: 'setTool', tool: 'rectangle' });
    drag(drawn, at(0, 100), at(48, 130));
    const created = drawn.query({ type: 'selection' })[0]!;
    expect(frameOf(drawn, created)).toEqual(f(0, 100, 50, 30));
  });

  it('a node edge and a guide at one value give one segment over both', () => {
    const target = editor(
      documentOf(
        [rect('a', 'p1', f(50, 40, 10, 60)), rect('m', 'p1', f(0, 0, 10, 10))],
        [{ axis: 'x', value: 50 }],
      ),
      ['m'],
    );
    drag(target, at(5, 5), at(47, 5), none, false);
    expect(frameOf(target, 'm')).toEqual(f(40, 0, 10, 10));
    expect(target.query({ type: 'snap' })?.guides).toEqual([seg(50, 0, 50, 100)]);
  });
});

describe('V38-A04 snapping to layout grids', () => {
  // A margin of 30: columns [30, 90] and [110, 170].
  const MARGIN: LayoutGrid = { ...COLUMNS, offset: 30 };
  const GRIDDED = documentOf([
    frameNode('F', f(0, 0, 200, 200), ['c'], [MARGIN]),
    rect('c', 'F', f(20, 20, 10, 10)),
    rect('o', 'p1', f(300, 300, 10, 10)),
  ]);

  it('moves a child onto a column edge and draws the line across the frame', () => {
    const target = editor(GRIDDED, ['c']);
    drag(target, at(25, 25), at(118, 25), none, false);
    expect(frameOf(target, 'c')).toEqual(f(110, 20, 10, 10));
    expect(target.query({ type: 'snap' })?.guides).toEqual([seg(110, 0, 110, 200)]);
  });

  it('does not snap to hidden grids, an invisible grid or outside the frame', () => {
    const hidden = editor(GRIDDED, ['c']);
    ok(hidden, { type: 'setLayoutGridsVisible', visible: false });
    drag(hidden, at(25, 25), at(118, 25));
    expect(frameOf(hidden, 'c')).toEqual(f(113, 20, 10, 10));

    const invisible = editor(
      documentOf([
        frameNode('F', f(0, 0, 200, 200), ['c'], [{ ...MARGIN, visible: false }]),
        rect('c', 'F', f(20, 20, 10, 10)),
      ]),
      ['c'],
    );
    drag(invisible, at(25, 25), at(118, 25));
    expect(frameOf(invisible, 'c')).toEqual(f(113, 20, 10, 10));

    // `o` moves to x = 113 at y = 300: the column edge 110 is in reach but the frame is not met.
    const outside = editor(GRIDDED, ['o']);
    drag(outside, at(305, 305), at(118, 305));
    expect(frameOf(outside, 'o')).toEqual(f(113, 300, 10, 10));
  });

  it('resizes a child onto a column edge even when the pointer drifts out of the frame', () => {
    const target = editor(
      documentOf([
        frameNode('F', f(0, 0, 200, 200), ['c'], [MARGIN]),
        rect('c', 'F', f(20, 150, 10, 10)),
      ]),
      ['c'],
    );
    // The right edge handle at (30, 155) to x = 88, 100 units below: a side handle ignores dy,
    // so the resized box stays inside F and its right edge snaps to the column edge 90.
    drag(target, at(30, 155), at(88, 255));
    expect(frameOf(target, 'c')).toEqual(f(20, 150, 70, 10));
  });

  it('draws onto a column edge inside the frame', () => {
    const target = editor(GRIDDED);
    ok(target, { type: 'setTool', tool: 'rectangle' });
    drag(target, at(40, 60), at(108, 80));
    const created = target.query({ type: 'selection' })[0]!;
    expect(target.query({ type: 'node', id: created })!.frame.width).toBe(110 - 40);
  });

  it('a moving frame does not snap to its own grid', () => {
    // COLUMNS has a line at the frame's own left edge, x = 0, within reach of the moved box.
    const target = editor(documentOf([frameNode('F', f(0, 0, 200, 200), [], [COLUMNS])]), ['F']);
    drag(target, at(100, 150), at(103, 150));
    expect(frameOf(target, 'F')).toEqual(f(3, 0, 200, 200));
  });

  it('a rotated frame offers no grid lines', () => {
    const rotated = documentOf([
      frameNode('R', f(0, 0, 200, 200), ['c'], [COLUMNS], 0.3),
      rect('c', 'R', f(20, 20, 10, 10)),
    ]);
    const set = snapSet(
      createEditor({ document: rotated }).query({ type: 'document' }),
      'p1',
      null,
      ['c'],
    );
    expect(set.lines).toEqual([]);
  });

  it('lists guides then grid lines after the node candidates, and caps the grid lines', () => {
    const document = createEditor({
      document: documentOf(
        [frameNode('F', f(10, 0, 200, 200), [], [COLUMNS])],
        [{ axis: 'y', value: 5 }],
      ),
    }).query({ type: 'document' });
    const set = snapSet(document, 'p1', null, []);
    expect(set.candidates.map((c) => c.order)).toEqual([0]);
    expect(set.lines!.map((line) => [line.axis, line.value, line.order])).toEqual([
      ['y', 5, 1],
      ['x', 10, 2],
      ['x', 100, 3],
      ['x', 120, 4],
      ['x', 210, 5],
    ]);
    expect(snapSet(document, 'p1', null, [], { layoutGrids: false }).lines).toHaveLength(1);

    // A 1-unit grid on a 4,000 square frame has 3,999 lines per axis; three such frames pass
    // MAX_SNAP_GRID_LINES at the third, so the walk stops there.
    const fine: LayoutGrid = { type: 'grid', size: 1, color: RED, visible: true };
    const many = createEditor({
      document: documentOf(
        ['A', 'B', 'C'].map((id, index) =>
          frameNode(id, f(index * 5000, 0, 4000, 4000), [], [fine]),
        ),
      ),
    }).query({ type: 'document' });
    const lines = snapSet(many, 'p1', null, []).lines!;
    expect(lines.length).toBe(2 * 2 * 3999);
    expect(lines.length).toBeLessThanOrEqual(MAX_SNAP_GRID_LINES);
  });
});
