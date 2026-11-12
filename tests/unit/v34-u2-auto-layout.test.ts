import {
  serializeDocument,
  validateAnyDocument,
  validateDocument,
  type AutoLayout,
  type DocumentV8,
  type LayoutSizing,
  type NodeV8,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
} from '../../packages/editor-core/src/index.js';
import {
  inferAutoLayout,
  layoutFrame,
  MIN_FILL_SIZE,
} from '../../packages/editor-core/src/auto-layout.js';
import { Draft } from '../../packages/editor-core/src/draft.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { rotatedBounds } from '../../packages/editor-core/src/geometry.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// V-34 U2 (docs/plans/viz-v34-auto-layout-contract.md): the layout of one frame (section 3,
// fixtures of section 8), the pass in the draft's `finish` (section 4), the commands (section 5)
// and the schema fields (section 2). V34-A01 to A04 and A08.

type Loose = Record<string, unknown> & { id: string; parent: string };
type Box = { x: number; y: number; width: number; height: number };

const START = { horizontal: 'start', vertical: 'start' } as const;
const grey = { r: 0.5, g: 0.5, b: 0.5, a: 1 };

function base(id: string, parent: string, frame: Box, extra: Record<string, unknown> = {}): Loose {
  return {
    id,
    name: id,
    parent,
    frame,
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    effects: [],
    ...extra,
  };
}

function rect(id: string, parent: string, frame: Box, extra: Record<string, unknown> = {}): Loose {
  return base(id, parent, frame, {
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: grey,
    stroke: null,
    ...extra,
  });
}

function al(patch: Partial<AutoLayout> = {}): AutoLayout {
  return {
    direction: 'horizontal',
    gap: 0,
    padding: [0, 0, 0, 0],
    primaryAlign: 'start',
    counterAlign: 'start',
    ...patch,
  };
}

function frame(
  id: string,
  parent: string,
  box: Box,
  children: string[],
  layout?: AutoLayout,
  sizing?: LayoutSizing,
  extra: Record<string, unknown> = {},
): Loose {
  return base(id, parent, box, {
    type: 'frame',
    children,
    fill: null,
    stroke: null,
    ...(layout === undefined ? {} : { autoLayout: layout }),
    ...(sizing === undefined ? {} : { layoutSizing: sizing }),
    ...extra,
  });
}

function textNode(id: string, parent: string, box: Box, text: string, extra = {}): Loose {
  return base(id, parent, box, {
    type: 'text',
    runs: [{ text, family: 'Inter', size: 20, color: grey }],
    sizing: 'autoWidth',
    align: 'left',
    letterSpacing: 0,
    lineHeight: 1,
    ...extra,
  });
}

const HUG: LayoutSizing = { horizontal: 'hug', vertical: 'hug' };
const FILL_W: LayoutSizing = { horizontal: 'fill', vertical: 'fixed' };
const FILL_H: LayoutSizing = { horizontal: 'fixed', vertical: 'fill' };

function doc(nodes: Loose[]): DocumentV8 {
  const roots = nodes.filter((n) => n.parent === 'p1').map((n) => n.id);
  const value = {
    schemaVersion: 8,
    id: 'doc',
    pages: [{ id: 'p1', name: 'Page 1', children: roots }],
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
  };
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`fixture: ${result.code} ${result.path}`);
  return result.document;
}

/** Lays out `id` once on a draft of the fixture and returns the draft. */
function run(nodes: Loose[], id: string): Draft {
  const draft = new Draft(doc(nodes));
  layoutFrame({ tree: draft, measure: undefined }, id);
  return draft;
}

const frameOf = (draft: Draft | Editor, id: string): Box =>
  draft instanceof Draft
    ? draft.node(id)!.frame
    : (draft.query({ type: 'node', id }) as NodeV8).frame;

/** A second pass on the result changes nothing (V34-A02). */
function expectStable(draft: Draft, id: string): void {
  const before = JSON.stringify(draft.document());
  layoutFrame({ tree: draft, measure: undefined }, id);
  expect(JSON.stringify(draft.document())).toBe(before);
}

describe('V34-A02 layout of one frame (section 3)', () => {
  const three = (parent: string) => [
    rect('a', parent, { x: 0, y: 0, width: 30, height: 40 }),
    rect('b', parent, { x: 100, y: 100, width: 50, height: 20 }),
    rect('c', parent, { x: 5, y: 5, width: 10, height: 60 }),
  ];

  it('L1 row, gap 10, padding 20, hug both', () => {
    const nodes = [
      frame(
        'f',
        'p1',
        { x: 7, y: 9, width: 10, height: 10 },
        ['a', 'b', 'c'],
        al({ gap: 10, padding: [20, 20, 20, 20] }),
        HUG,
      ),
      ...three('f'),
    ];
    const d = run(nodes, 'f');
    expect(frameOf(d, 'f')).toEqual({ x: 7, y: 9, width: 150, height: 100 });
    expect(frameOf(d, 'a')).toMatchObject({ x: 20, y: 20 });
    expect(frameOf(d, 'b')).toMatchObject({ x: 60, y: 20 });
    expect(frameOf(d, 'c')).toMatchObject({ x: 120, y: 20 });
    expectStable(d, 'f');
  });

  it('L2 the same as a column', () => {
    const nodes = [
      frame(
        'f',
        'p1',
        { x: 0, y: 0, width: 10, height: 10 },
        ['a', 'b', 'c'],
        al({ direction: 'vertical', gap: 10, padding: [20, 20, 20, 20] }),
        HUG,
      ),
      ...three('f'),
    ];
    const d = run(nodes, 'f');
    expect(frameOf(d, 'f')).toEqual({ x: 0, y: 0, width: 90, height: 180 });
    expect(frameOf(d, 'a')).toMatchObject({ x: 20, y: 20 });
    expect(frameOf(d, 'b')).toMatchObject({ x: 20, y: 70 });
    expect(frameOf(d, 'c')).toMatchObject({ x: 20, y: 100 });
  });

  const pair = (primaryAlign: AutoLayout['primaryAlign']) => [
    frame('f', 'p1', { x: 0, y: 0, width: 200, height: 100 }, ['a', 'b'], al({ primaryAlign })),
    rect('a', 'f', { x: 0, y: 0, width: 50, height: 10 }),
    rect('b', 'f', { x: 0, y: 0, width: 30, height: 10 }),
  ];

  it('L3 fixed frame, primaryAlign centre and end', () => {
    let d = run(pair('center'), 'f');
    expect([frameOf(d, 'a').x, frameOf(d, 'b').x]).toEqual([60, 110]);
    d = run(pair('end'), 'f');
    expect([frameOf(d, 'a').x, frameOf(d, 'b').x]).toEqual([120, 170]);
    expect(frameOf(d, 'f')).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it('L4 spaceBetween with three, one, and a fill child', () => {
    const between = al({ primaryAlign: 'spaceBetween', gap: 10 });
    let d = run(
      [
        frame('f', 'p1', { x: 0, y: 0, width: 200, height: 50 }, ['a', 'b', 'c'], between),
        rect('a', 'f', { x: 9, y: 0, width: 20, height: 10 }),
        rect('b', 'f', { x: 9, y: 0, width: 20, height: 10 }),
        rect('c', 'f', { x: 9, y: 0, width: 20, height: 10 }),
      ],
      'f',
    );
    expect(['a', 'b', 'c'].map((id) => frameOf(d, id).x)).toEqual([0, 90, 180]);
    d = run(
      [
        frame('f', 'p1', { x: 0, y: 0, width: 200, height: 50 }, ['a'], between),
        rect('a', 'f', { x: 9, y: 0, width: 20, height: 10 }),
      ],
      'f',
    );
    expect(frameOf(d, 'a').x).toBe(0);
    d = run(
      [
        frame('f', 'p1', { x: 0, y: 0, width: 200, height: 50 }, ['a', 'b'], between),
        rect('a', 'f', { x: 9, y: 0, width: 20, height: 10 }),
        rect('b', 'f', { x: 9, y: 0, width: 20, height: 10 }, { layoutSizing: FILL_W }),
      ],
      'f',
    );
    expect(frameOf(d, 'b')).toEqual({ x: 30, y: 0, width: 170, height: 10 });
  });

  it('L5 counterAlign start, centre and end', () => {
    const at = (counterAlign: AutoLayout['counterAlign']) => {
      const d = run(
        [
          frame(
            'f',
            'p1',
            { x: 0, y: 0, width: 200, height: 100 },
            ['a', 'b'],
            al({ counterAlign, padding: [10, 10, 10, 10] }),
          ),
          rect('a', 'f', { x: 0, y: 0, width: 20, height: 20 }),
          rect('b', 'f', { x: 0, y: 0, width: 20, height: 60 }),
        ],
        'f',
      );
      return [frameOf(d, 'a').y, frameOf(d, 'b').y];
    };
    expect(at('start')).toEqual([10, 10]);
    expect(at('center')).toEqual([40, 20]);
    expect(at('end')).toEqual([70, 30]);
  });

  it('L6 and L7 main fill shares, the floor of 1 and growing back', () => {
    const fills = (width: number) => [
      frame('f', 'p1', { x: 0, y: 0, width, height: 50 }, ['a', 'b', 'c'], al()),
      rect('a', 'f', { x: 0, y: 0, width: 80, height: 10 }),
      rect('b', 'f', { x: 0, y: 0, width: 33, height: 10 }, { layoutSizing: FILL_W }),
      frame('c', 'f', { x: 0, y: 0, width: 20, height: 10 }, ['k'], undefined, FILL_W),
      rect(
        'k',
        'c',
        { x: 0, y: 0, width: 20, height: 10 },
        { constraints: { horizontal: 'scale', vertical: 'start' } },
      ),
    ];
    let d = run(fills(100), 'f');
    expect(frameOf(d, 'b')).toEqual({ x: 80, y: 0, width: 10, height: 10 });
    expect(frameOf(d, 'c')).toEqual({ x: 90, y: 0, width: 10, height: 10 });
    expect(frameOf(d, 'k').width).toBe(10);
    d = run(fills(60), 'f');
    expect(frameOf(d, 'b').width).toBe(MIN_FILL_SIZE);
    expect(frameOf(d, 'c').width).toBe(MIN_FILL_SIZE);
    // Growing back from the floor: the frame's `scale` child comes back with it.
    d.set({ ...d.node('f')!, frame: { x: 0, y: 0, width: 280, height: 50 } });
    layoutFrame({ tree: d, measure: undefined }, 'f');
    expect(frameOf(d, 'b').width).toBe(100);
    expect(frameOf(d, 'c').width).toBe(100);
    expect(frameOf(d, 'k').width).toBeCloseTo(100, 9);
  });

  it('L7 a group never takes fill (counts as fixed)', () => {
    const d = run(
      [
        frame('f', 'p1', { x: 0, y: 0, width: 100, height: 50 }, ['g'], al()),
        base(
          'g',
          'f',
          { x: 5, y: 5, width: 20, height: 10 },
          { type: 'group', children: ['r'], layoutSizing: FILL_W },
        ),
        rect('r', 'g', { x: 0, y: 0, width: 20, height: 10 }),
      ],
      'f',
    );
    expect(frameOf(d, 'g')).toEqual({ x: 0, y: 0, width: 20, height: 10 });
  });

  it('L8 cross fill, and a line under cross fill stays a line', () => {
    const d = run(
      [
        frame(
          'f',
          'p1',
          { x: 0, y: 0, width: 200, height: 100 },
          ['a', 'l'],
          al({ padding: [10, 0, 10, 0] }),
        ),
        rect('a', 'f', { x: 0, y: 0, width: 20, height: 20 }, { layoutSizing: FILL_H }),
        base(
          'l',
          'f',
          { x: 0, y: 0, width: 40, height: 0 },
          {
            type: 'line',
            points: [0, 0, 1, 0],
            stroke: {
              color: grey,
              width: 1,
              cap: 'butt',
              join: 'miter',
              miterLimit: 4,
              dash: null,
            },
            startArrow: 'none',
            endArrow: 'none',
            layoutSizing: FILL_H,
          },
        ),
      ],
      'f',
    );
    expect(frameOf(d, 'a')).toEqual({ x: 0, y: 10, width: 20, height: 80 });
    expect(frameOf(d, 'l')).toEqual({ x: 20, y: 10, width: 40, height: 0 });
  });

  it('L9 fill under a hug axis acts as fixed; L10 hidden child skipped', () => {
    const d = run(
      [
        frame(
          'f',
          'p1',
          { x: 0, y: 0, width: 10, height: 10 },
          ['a', 'h', 'b'],
          al({ gap: 5 }),
          HUG,
        ),
        rect('a', 'f', { x: 0, y: 0, width: 20, height: 10 }, { layoutSizing: FILL_W }),
        rect('h', 'f', { x: 77, y: 77, width: 500, height: 500 }, { visible: false }),
        rect('b', 'f', { x: 0, y: 0, width: 30, height: 15 }),
      ],
      'f',
    );
    expect(frameOf(d, 'f')).toEqual({ x: 0, y: 0, width: 55, height: 15 });
    expect(frameOf(d, 'a')).toEqual({ x: 0, y: 0, width: 20, height: 10 });
    expect(frameOf(d, 'b')).toMatchObject({ x: 25, y: 0 });
    expect(frameOf(d, 'h')).toEqual({ x: 77, y: 77, width: 500, height: 500 });
  });

  it('L11 a child rotated 45° is placed by its box', () => {
    const d = run(
      [
        frame(
          'f',
          'p1',
          { x: 0, y: 0, width: 10, height: 10 },
          ['r'],
          al({ padding: [3, 3, 3, 3] }),
          HUG,
        ),
        rect(
          'r',
          'f',
          { x: 50, y: 50, width: 20, height: 20 },
          { rotation: Math.PI / 4, layoutSizing: FILL_W },
        ),
      ],
      'f',
    );
    const box = rotatedBounds(d.node('r')!);
    expect(box.x).toBeCloseTo(3, 12);
    expect(box.y).toBeCloseTo(3, 12);
    expect(frameOf(d, 'r').width).toBe(20);
    expect(frameOf(d, 'f').width).toBe(6 + box.width);
  });

  it('L12 a hug row inside a hug column (the draft pass, innermost first)', () => {
    const target = editorOf([
      frame(
        'col',
        'p1',
        { x: 0, y: 0, width: 1, height: 1 },
        ['row', 'z'],
        al({ direction: 'vertical', gap: 4 }),
        HUG,
      ),
      frame('row', 'col', { x: 0, y: 0, width: 1, height: 1 }, ['a', 'b'], al({ gap: 2 }), HUG),
      rect('a', 'row', { x: 0, y: 0, width: 10, height: 10 }),
      rect('b', 'row', { x: 0, y: 0, width: 10, height: 30 }),
      rect('z', 'col', { x: 0, y: 0, width: 5, height: 5 }),
    ]);
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 'b', frame: { x: 0, y: 0, width: 40, height: 30 } }],
    });
    expect(frameOf(target, 'row')).toEqual({ x: 0, y: 0, width: 52, height: 30 });
    expect(frameOf(target, 'z')).toMatchObject({ x: 0, y: 34 });
    expect(frameOf(target, 'col')).toEqual({ x: 0, y: 0, width: 52, height: 39 });
  });

  it('L13 a fill frame child follows constraints; a fill auto-layout child lays out again', () => {
    const d = run(
      [
        frame('f', 'p1', { x: 0, y: 0, width: 300, height: 50 }, ['g', 'h'], al()),
        frame('g', 'f', { x: 0, y: 0, width: 50, height: 50 }, ['k'], undefined, FILL_W),
        rect(
          'k',
          'g',
          { x: 0, y: 0, width: 10, height: 10 },
          { constraints: { horizontal: 'end', vertical: 'start' } },
        ),
        frame(
          'h',
          'f',
          { x: 0, y: 0, width: 50, height: 50 },
          ['m', 'n'],
          al({ primaryAlign: 'end' }),
          FILL_W,
        ),
        rect('m', 'h', { x: 0, y: 0, width: 10, height: 10 }),
        rect('n', 'h', { x: 0, y: 0, width: 10, height: 10 }, { layoutSizing: FILL_W }),
      ],
      'f',
    );
    expect(frameOf(d, 'g')).toEqual({ x: 0, y: 0, width: 150, height: 50 });
    expect(frameOf(d, 'k').x).toBe(100);
    expect(frameOf(d, 'h')).toEqual({ x: 150, y: 0, width: 150, height: 50 });
    expect(frameOf(d, 'n')).toEqual({ x: 10, y: 0, width: 140, height: 10 });
  });

  it('L16 a fill frame child holding a scale-constrained group: the group is refit', () => {
    const d = run(
      [
        frame('f', 'p1', { x: 0, y: 0, width: 200, height: 50 }, ['g'], al()),
        frame('g', 'f', { x: 0, y: 0, width: 100, height: 50 }, ['k'], undefined, FILL_W),
        base(
          'k',
          'g',
          { x: 10, y: 0, width: 40, height: 10 },
          {
            type: 'group',
            children: ['r1', 'r2'],
            constraints: { horizontal: 'scale', vertical: 'start' },
          },
        ),
        rect('r1', 'k', { x: 0, y: 0, width: 10, height: 10 }),
        rect('r2', 'k', { x: 30, y: 0, width: 10, height: 10 }),
      ],
      'f',
    );
    const k = frameOf(d, 'k');
    const r2 = frameOf(d, 'r2');
    expect(k.width).toBeCloseTo(r2.x + r2.width, 9);
    expect(k.width).toBeCloseTo(80, 9);
  });

  it('L17 no participants keeps the hug size; a negative gap overlaps', () => {
    let d = run(
      [
        frame(
          'f',
          'p1',
          { x: 0, y: 0, width: 33, height: 44 },
          [],
          al({ padding: [5, 5, 5, 5] }),
          HUG,
        ),
      ],
      'f',
    );
    expect(frameOf(d, 'f')).toEqual({ x: 0, y: 0, width: 33, height: 44 });
    d = run(
      [
        frame('f', 'p1', { x: 0, y: 0, width: 1, height: 1 }, ['a', 'b'], al({ gap: -5 }), HUG),
        rect('a', 'f', { x: 0, y: 0, width: 20, height: 10 }),
        rect('b', 'f', { x: 0, y: 0, width: 20, height: 10 }),
      ],
      'f',
    );
    expect(frameOf(d, 'b').x).toBe(15);
    expect(frameOf(d, 'f').width).toBe(35);
  });

  it('L18 a rotated hug frame grows with its top-left corner fixed', () => {
    const d = run(
      [
        frame('f', 'p1', { x: 100, y: 100, width: 20, height: 20 }, ['a'], al(), HUG, {
          rotation: Math.PI / 2,
        }),
        rect('a', 'f', { x: 0, y: 0, width: 60, height: 40 }),
      ],
      'f',
    );
    // At π/2 the own top-left corner of the 20 × 20 frame is at (120, 100).
    const f = frameOf(d, 'f');
    expect([f.width, f.height]).toEqual([60, 40]);
    const cx = f.x + f.width / 2;
    const cy = f.y + f.height / 2;
    // Corner = centre + R(π/2)·(−w/2, −h/2) = centre + (h/2, −w/2).
    expect(cx + f.height / 2).toBeCloseTo(120, 9);
    expect(cy - f.width / 2).toBeCloseTo(100, 9);
  });
});

// ---------------------------------------------------------------------------------------------
// The editor: the pass in `finish`, triggers, commands.

function editorOf(nodes: Loose[], layout = true): Editor {
  return createEditor({
    document: JSON.parse(JSON.stringify(doc(nodes))) as unknown,
    ids: createCounterIdSource('n'),
    ...(layout ? { textLayout: createFakeTextLayout() } : {}),
  });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

const nodeIn = (target: Editor, id: string) =>
  target.query({ type: 'node', id }) as NodeV8 & {
    autoLayout?: AutoLayout;
    layoutSizing?: LayoutSizing;
    children?: readonly string[];
  };
const serialized = (target: Editor) => serializeDocument(target.query({ type: 'document' }));

const row = (extra: Loose[] = []) => [
  frame(
    'f',
    'p1',
    { x: 0, y: 0, width: 80, height: 20 },
    ['a', 'b', 'c', ...extra.filter((n) => n.parent === 'f').map((n) => n.id)],
    al({ gap: 10 }),
    HUG,
  ),
  rect('a', 'f', { x: 0, y: 0, width: 20, height: 20 }),
  rect('b', 'f', { x: 30, y: 0, width: 20, height: 20 }),
  rect('c', 'f', { x: 60, y: 0, width: 20, height: 20 }),
  ...extra,
];
const xs = (target: Editor, ids: string[]) => ids.map((id) => frameOf(target, id).x);

describe('V34-A02 text fixtures through the editor', () => {
  it('L14 an autoWidth text child; L15 a main-fill autoHeight text in a hug-cross row', () => {
    const target = editorOf([
      frame('f', 'p1', { x: 0, y: 0, width: 1, height: 1 }, ['t', 'u'], al({ gap: 0 }), {
        horizontal: 'fixed',
        vertical: 'hug',
      }),
      textNode('t', 'f', { x: 0, y: 0, width: 30, height: 20 }, 'aaa'),
      textNode('u', 'f', { x: 0, y: 0, width: 50, height: 60 }, 'aa aa aa aa aa aa', {
        sizing: 'autoHeight',
        layoutSizing: FILL_W,
      }),
    ]);
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 'f', frame: { x: 0, y: 0, width: 230, height: 1 } }],
    });
    const t = frameOf(target, 't');
    const u = frameOf(target, 'u');
    expect(t.width).toBe(30);
    expect(u).toMatchObject({ x: 30, width: 200 });
    // The row's cross hug is measured after the fill: one line, not the stale 60.
    expect(u.height).toBe(20);
    expect(frameOf(target, 'f').height).toBe(20);
  });

  it('L19 a hug-height column with a fill-width autoHeight text', () => {
    const target = editorOf([
      frame(
        'f',
        'p1',
        { x: 0, y: 0, width: 200, height: 1 },
        ['t'],
        al({ direction: 'vertical' }),
        { horizontal: 'fixed', vertical: 'hug' },
      ),
      textNode('t', 'f', { x: 0, y: 0, width: 50, height: 60 }, 'aa aa aa aa aa', {
        sizing: 'autoHeight',
        layoutSizing: FILL_W,
      }),
    ]);
    ok(target, { type: 'setLayout', ids: ['f'], autoLayout: { gap: 1 } });
    expect(frameOf(target, 't')).toMatchObject({ width: 200, height: 20 });
    expect(frameOf(target, 'f').height).toBe(20);
  });

  it('L20 the settle step: a fill frame child holding a hug row and an autoHeight text', () => {
    const target = editorOf([
      frame(
        'f',
        'p1',
        { x: 0, y: 0, width: 100, height: 300 },
        ['g'],
        al({ direction: 'vertical' }),
      ),
      frame('g', 'f', { x: 0, y: 0, width: 100, height: 300 }, ['h', 't'], undefined, FILL_W),
      frame(
        'h',
        'g',
        { x: 0, y: 0, width: 100, height: 20 },
        ['n', 'v'],
        al(),
        { horizontal: 'fixed', vertical: 'hug' },
        {
          constraints: { horizontal: 'startEnd', vertical: 'start' },
        },
      ),
      rect('n', 'h', { x: 0, y: 0, width: 10, height: 20 }, { layoutSizing: FILL_W }),
      textNode('v', 'h', { x: 0, y: 0, width: 90, height: 20 }, 'aa aa aa aa aa aa', {
        sizing: 'autoHeight',
        layoutSizing: { horizontal: 'fixed', vertical: 'fixed' },
      }),
      textNode('t', 'g', { x: 0, y: 100, width: 100, height: 20 }, 'aa aa aa aa aa aa', {
        sizing: 'autoHeight',
        constraints: { horizontal: 'startEnd', vertical: 'start' },
      }),
    ]);
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 'f', frame: { x: 0, y: 0, width: 300, height: 300 } }],
    });
    expect(frameOf(target, 'g').width).toBe(300);
    expect(frameOf(target, 'h').width).toBe(300);
    expect(frameOf(target, 'n').width).toBe(210);
    const t = frameOf(target, 't');
    expect(t.width).toBe(300);
    expect(t.height).toBe(20);
    // Laying the document out again changes nothing.
    const before = serialized(target);
    ok(target, { type: 'setLayout', ids: ['f'], autoLayout: { gap: 1 } });
    ok(target, { type: 'setLayout', ids: ['f'], autoLayout: { gap: 0 } });
    expect(serialized(target)).toBe(before);
  });
});

describe('V34-A03 seeds, propagation and drop order (section 4)', () => {
  it('reflows on child resize, add, delete, hide, reorder and reparent; one undo step each', () => {
    const target = editorOf(row([rect('out', 'p1', { x: 500, y: 0, width: 5, height: 5 })]));
    ok(target, { type: 'setLayout', ids: ['f'], autoLayout: { gap: 10 } }); // no change: no step
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 'a', frame: { x: 0, y: 0, width: 40, height: 20 } }],
    });
    expect(xs(target, ['a', 'b', 'c'])).toEqual([0, 50, 80]);
    expect(frameOf(target, 'f').width).toBe(100);
    ok(target, { type: 'undo' });
    expect(xs(target, ['a', 'b', 'c'])).toEqual([0, 30, 60]);
    ok(target, { type: 'deleteNodes', ids: ['b'] });
    expect(xs(target, ['a', 'c'])).toEqual([0, 30]);
    ok(target, { type: 'undo' });
    ok(target, { type: 'setNodeProps', id: 'a', props: { visible: false } });
    expect(xs(target, ['b', 'c'])).toEqual([0, 30]);
    ok(target, { type: 'undo' });
    ok(target, { type: 'reorderNodes', ids: ['a'], op: 'front' });
    expect(nodeIn(target, 'f').children).toEqual(['b', 'c', 'a']);
    expect(xs(target, ['b', 'c', 'a'])).toEqual([0, 30, 60]);
    ok(target, { type: 'undo' });
    ok(target, { type: 'moveNodes', ids: ['out'], parent: 'f', index: 1 });
    // Moved in from another parent: a candidate, dropped by its centre (section 4.1).
    expect(nodeIn(target, 'f').children).toEqual(['a', 'b', 'c', 'out']);
    expect(xs(target, ['a', 'b', 'c', 'out'])).toEqual([0, 30, 60, 90]);
    ok(target, { type: 'moveNodes', ids: ['out'], parent: 'p1', index: 0 });
    expect(xs(target, ['a', 'b', 'c'])).toEqual([0, 30, 60]);
  });

  it('a moved child drops into the slot under its centre; a nudge snaps back', () => {
    const target = editorOf(row());
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 'a', frame: { x: 65, y: 7, width: 20, height: 20 } }],
    });
    expect(nodeIn(target, 'f').children).toEqual(['b', 'c', 'a']);
    expect(xs(target, ['b', 'c', 'a'])).toEqual([0, 30, 60]);
    expect(frameOf(target, 'a').y).toBe(0);
    ok(target, { type: 'nudgeNodes', ids: ['b'], dx: 1, dy: 0 });
    expect(nodeIn(target, 'f').children).toEqual(['b', 'c', 'a']);
    expect(frameOf(target, 'b').x).toBe(0);
    // Two candidates, in their old order, each by its centre.
    ok(target, {
      type: 'setFrames',
      frames: [
        { id: 'b', frame: { x: 100, y: 0, width: 20, height: 20 } },
        { id: 'c', frame: { x: -50, y: 0, width: 20, height: 20 } },
      ],
    });
    expect(nodeIn(target, 'f').children).toEqual(['c', 'a', 'b']);
  });

  it('a gesture: a moved child floats, then drops at commit; a resize lays out live', () => {
    const target = editorOf(row());
    const { gesture } = internalsOf(target);
    gesture.begin();
    gesture.update({
      type: 'setFrames',
      frames: [{ id: 'a', frame: { x: 40, y: 15, width: 20, height: 20 } }],
    });
    // Floating: the pointer's position, siblings unchanged.
    expect(frameOf(target, 'a')).toMatchObject({ x: 40, y: 15 });
    expect(xs(target, ['b', 'c'])).toEqual([30, 60]);
    gesture.update({
      type: 'setFrames',
      frames: [{ id: 'a', frame: { x: 45, y: 15, width: 20, height: 20 } }],
    });
    gesture.commit();
    expect(nodeIn(target, 'f').children).toEqual(['b', 'a', 'c']);
    expect(xs(target, ['b', 'a', 'c'])).toEqual([0, 30, 60]);
    expect(frameOf(target, 'a').y).toBe(0);
    ok(target, { type: 'undo' });
    expect(nodeIn(target, 'f').children).toEqual(['a', 'b', 'c']);
    // A resize gesture of a child lays out on every update, the hug frame stays hug.
    gesture.begin();
    gesture.update({
      type: 'setFrames',
      frames: [{ id: 'a', frame: { x: 0, y: 0, width: 30, height: 20 } }],
    });
    expect(xs(target, ['a', 'b', 'c'])).toEqual([0, 40, 70]);
    gesture.update({
      type: 'setFrames',
      frames: [{ id: 'a', frame: { x: 0, y: 0, width: 40, height: 20 } }],
    });
    expect(xs(target, ['a', 'b', 'c'])).toEqual([0, 50, 80]);
    gesture.commit();
    expect(nodeIn(target, 'f').layoutSizing).toEqual(HUG);
    expect(frameOf(target, 'f').width).toBe(100);
    expect(nodeIn(target, 'f').children).toEqual(['a', 'b', 'c']);
  });

  it('a resize gesture beside a fill sibling keeps the sibling fill', () => {
    const target = editorOf([
      frame('f', 'p1', { x: 0, y: 0, width: 200, height: 20 }, ['a', 'b'], al()),
      rect('a', 'f', { x: 0, y: 0, width: 50, height: 20 }),
      rect('b', 'f', { x: 50, y: 0, width: 150, height: 20 }, { layoutSizing: FILL_W }),
    ]);
    const { gesture } = internalsOf(target);
    gesture.begin();
    gesture.update({
      type: 'setFrames',
      frames: [{ id: 'a', frame: { x: 0, y: 0, width: 60, height: 20 } }],
    });
    gesture.update({
      type: 'setFrames',
      frames: [{ id: 'a', frame: { x: 0, y: 0, width: 70, height: 20 } }],
    });
    gesture.commit();
    expect(nodeIn(target, 'b').layoutSizing).toEqual(FILL_W);
    expect(frameOf(target, 'b')).toEqual({ x: 70, y: 0, width: 130, height: 20 });
  });

  it('resizing a hug frame makes that axis fixed; a group scale over a hug frame likewise', () => {
    const target = editorOf(row());
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 'f', frame: { x: 0, y: 0, width: 200, height: 20 } }],
    });
    expect(nodeIn(target, 'f').layoutSizing).toEqual({ horizontal: 'fixed', vertical: 'hug' });
    expect(frameOf(target, 'f').width).toBe(200);
    // A resize of a child keeps the hug axes that the pass changes.
    const other = editorOf(row());
    ok(other, {
      type: 'setFrames',
      frames: [{ id: 'c', frame: { x: 60, y: 0, width: 50, height: 20 } }],
    });
    expect(nodeIn(other, 'f').layoutSizing).toEqual(HUG);
    expect(frameOf(other, 'f').width).toBe(110);
  });

  it('a resize that shifts siblings does not reorder them', () => {
    const target = editorOf([
      frame('f', 'p1', { x: 0, y: 0, width: 1, height: 1 }, ['a', 'b', 'c'], al({ gap: -80 }), HUG),
      rect('a', 'f', { x: 0, y: 0, width: 100, height: 20 }),
      rect('b', 'f', { x: 20, y: 0, width: 20, height: 20 }),
      rect('c', 'f', { x: 0, y: 0, width: 100, height: 20 }),
    ]);
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 'a', frame: { x: 0, y: 0, width: 110, height: 20 } }],
    });
    expect(nodeIn(target, 'f').children).toEqual(['a', 'b', 'c']);
  });

  it('documents without auto layout are untouched by the pass', () => {
    const target = editorOf([
      frame('f', 'p1', { x: 0, y: 0, width: 100, height: 100 }, ['a']),
      rect('a', 'f', { x: 10, y: 10, width: 20, height: 20 }),
    ]);
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 'a', frame: { x: 50, y: 50, width: 20, height: 20 } }],
    });
    expect(frameOf(target, 'a')).toEqual({ x: 50, y: 50, width: 20, height: 20 });
  });
});

describe('V34-A03 more seeds (section 4.3)', () => {
  const none = { shift: false, alt: false, meta: false, ctrl: false };

  it('a text edit of an autoWidth child reflows the row', () => {
    const target = editorOf(
      row([textNode('t', 'f', { x: 90, y: 0, width: 30, height: 20 }, 'aaa')]),
    );
    // The fixture's frame is stored out of layout (S4): a gap edit lays it out first.
    ok(target, { type: 'setLayout', ids: ['f'], autoLayout: { gap: 12 } });
    const before = frameOf(target, 'f').width;
    const width = frameOf(target, 't').width;
    expect(before).toBe(60 + width + 36);
    ok(target, { type: 'setText', id: 't', start: 3, end: 3, text: 'aa' });
    const grown = frameOf(target, 't').width;
    expect(grown).toBeGreaterThan(width);
    expect(frameOf(target, 'f').width).toBe(before + grown - width);
    ok(target, { type: 'undo' });
    expect(frameOf(target, 'f').width).toBe(before);
  });

  it('paste into F lays the pasted copy out as a candidate, one undo step', () => {
    const target = editorOf(row());
    ok(target, { type: 'copy', ids: ['c'] });
    ok(target, { type: 'setSelection', ids: ['f'] });
    const before = serialized(target);
    const [pasted] = ok(target, { type: 'paste' });
    const children = nodeIn(target, 'f').children!;
    expect(children).toHaveLength(4);
    expect(children).toContain(pasted);
    expect(xs(target, [...children])).toEqual([0, 30, 60, 90]);
    expect(frameOf(target, 'f').width).toBe(110);
    ok(target, { type: 'undo' });
    expect(serialized(target)).toBe(before);
  });

  it('groupNodes and ungroupNodes inside F reflow it', () => {
    const target = editorOf(row());
    const before = serialized(target);
    const [group] = ok(target, { type: 'groupNodes', ids: ['a', 'b'], kind: 'group' });
    expect(nodeIn(target, 'f').children).toEqual([group, 'c']);
    expect(frameOf(target, group!)).toEqual({ x: 0, y: 0, width: 50, height: 20 });
    expect(frameOf(target, 'c').x).toBe(60);
    ok(target, { type: 'ungroupNodes', id: group! });
    expect(nodeIn(target, 'f').children).toEqual(['a', 'b', 'c']);
    expect(xs(target, ['a', 'b', 'c'])).toEqual([0, 30, 60]);
    ok(target, { type: 'undo' });
    ok(target, { type: 'undo' });
    expect(serialized(target)).toBe(before);
  });

  it('a loaded autoWidth text with fill equal to its share becomes autoHeight', () => {
    const target = editorOf([
      frame('f', 'p1', { x: 0, y: 0, width: 30, height: 20 }, ['t'], al()),
      textNode('t', 'f', { x: 0, y: 0, width: 30, height: 20 }, 'aaa', { layoutSizing: FILL_W }),
    ]);
    expect(nodeIn(target, 't')).toMatchObject({ sizing: 'autoWidth' });
    ok(target, { type: 'setLayout', ids: ['f'], autoLayout: { counterAlign: 'center' } });
    expect(nodeIn(target, 't')).toMatchObject({ sizing: 'autoHeight' });
    expect(frameOf(target, 't').width).toBe(30);
  });

  it('a child rotation places it by its box', () => {
    const target = editorOf(row());
    ok(target, { type: 'rotateNodes', ids: ['a'], angle: Math.PI / 4 });
    const box = rotatedBounds(nodeIn(target, 'a'));
    expect(box.x).toBeCloseTo(0, 9);
    expect(frameOf(target, 'b').x).toBeCloseTo(box.width + 10, 9);
    expect(frameOf(target, 'c').x).toBeCloseTo(box.width + 40, 9);
    ok(target, { type: 'undo' });
    expect(xs(target, ['a', 'b', 'c'])).toEqual([0, 30, 60]);
  });

  it('a flip of F makes its hug axis fixed and lays out again, children in order', () => {
    const target = editorOf(row());
    ok(target, { type: 'setSnapping', enabled: false });
    ok(target, { type: 'setSelection', ids: ['f'] });
    const before = serialized(target);
    // The right edge handle (80, 10) past the left edge to x −120: width 120, flipped.
    ok(target, {
      type: 'input',
      event: { kind: 'pointerdown', point: { x: 80, y: 10 }, modifiers: none },
    });
    ok(target, {
      type: 'input',
      event: { kind: 'pointermove', point: { x: -120, y: 10 }, modifiers: none },
    });
    ok(target, {
      type: 'input',
      event: { kind: 'pointerup', point: { x: -120, y: 10 }, modifiers: none },
    });
    expect(frameOf(target, 'f')).toEqual({ x: -120, y: 0, width: 120, height: 20 });
    expect(nodeIn(target, 'f').layoutSizing).toEqual({ horizontal: 'fixed', vertical: 'hug' });
    expect(nodeIn(target, 'f').children).toEqual(['a', 'b', 'c']);
    // Child frames are in F's space: the layout places them from F's start again.
    expect(xs(target, ['a', 'b', 'c'])).toEqual([0, 30, 60]);
    expect(frameOf(target, 'a').width).toBe(20);
    ok(target, { type: 'undo' });
    expect(serialized(target)).toBe(before);
  });

  it('a group scale over a hug F makes the scaled axis fixed', () => {
    const target = editorOf([
      base('g', 'p1', { x: 0, y: 0, width: 80, height: 20 }, { type: 'group', children: ['f'] }),
      ...row().map((n) => (n.id === 'f' ? { ...n, parent: 'g' } : n)),
    ]);
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 'g', frame: { x: 0, y: 0, width: 160, height: 20 } }],
    });
    expect(nodeIn(target, 'f').layoutSizing).toEqual({ horizontal: 'fixed', vertical: 'hug' });
    expect(frameOf(target, 'f').width).toBe(160);
    expect(xs(target, ['a', 'b', 'c'])).toEqual([0, 30, 60]);
  });

  it('setTextProps to an automatic sizing turns the fill it now sizes into fixed', () => {
    const target = editorOf([
      frame('f', 'p1', { x: 0, y: 0, width: 150, height: 40 }, ['t'], al()),
      textNode('t', 'f', { x: 0, y: 0, width: 150, height: 40 }, 'aaa', {
        sizing: 'fixed',
        layoutSizing: { horizontal: 'fill', vertical: 'fill' },
      }),
    ]);
    const before = serialized(target);
    // autoHeight sizes the height: vertical fill becomes fixed, horizontal fill stays.
    ok(target, { type: 'setTextProps', id: 't', sizing: 'autoHeight' });
    expect(nodeIn(target, 't')).toMatchObject({ sizing: 'autoHeight' });
    expect(nodeIn(target, 't').layoutSizing).toEqual(FILL_W);
    expect(frameOf(target, 't').width).toBe(150);
    // autoWidth sizes both: the pass no longer turns it back into autoHeight.
    ok(target, { type: 'setTextProps', id: 't', sizing: 'autoWidth' });
    expect(nodeIn(target, 't')).toMatchObject({ sizing: 'autoWidth' });
    expect(nodeIn(target, 't').layoutSizing).toBeUndefined();
    expect(frameOf(target, 't').width).toBe(30);
    ok(target, { type: 'undo' });
    ok(target, { type: 'undo' });
    expect(serialized(target)).toBe(before);
  });
});

describe('V34-A04 commands (section 5)', () => {
  it('addAutoLayout infers a row from a frame and lays it out, one undo step', () => {
    const target = editorOf([
      frame('f', 'p1', { x: 0, y: 0, width: 200, height: 100 }, ['b', 'a']),
      rect('a', 'f', { x: 12, y: 10, width: 20, height: 20 }),
      rect('b', 'f', { x: 40, y: 14, width: 20, height: 20 }),
    ]);
    const before = serialized(target);
    ok(target, { type: 'addAutoLayout', ids: ['f'] });
    const f = nodeIn(target, 'f');
    expect(f.autoLayout).toEqual(al({ gap: 8, padding: [10, 140, 66, 12] }));
    expect(f.layoutSizing).toEqual(HUG);
    expect(f.children).toEqual(['a', 'b']);
    expect(frameOf(target, 'b')).toMatchObject({ x: 40, y: 10 });
    expect(frameOf(target, 'f')).toEqual({ x: 0, y: 0, width: 200, height: 96 });
    ok(target, { type: 'undo' });
    expect(serialized(target)).toBe(before);
  });

  it('infers a column, one child and an empty frame; keeps a fill axis', () => {
    expect(
      inferAutoLayout(
        [
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 0, y: 30, width: 10, height: 10 },
        ],
        10,
        40,
        false,
      ).layout.direction,
    ).toBe('vertical');
    expect(inferAutoLayout([{ x: 5, y: 5, width: 10, height: 10 }], 20, 20, false).layout).toEqual(
      al({ direction: 'vertical', padding: [5, 5, 5, 5] }),
    );
    expect(inferAutoLayout([], 20, 20, false).layout).toEqual(al());
    const target = editorOf([
      frame('outer', 'p1', { x: 0, y: 0, width: 300, height: 100 }, ['f'], al()),
      frame('f', 'outer', { x: 0, y: 0, width: 300, height: 100 }, [], undefined, FILL_W),
    ]);
    ok(target, { type: 'addAutoLayout', ids: ['f'] });
    expect(nodeIn(target, 'f').layoutSizing).toEqual({ horizontal: 'fill', vertical: 'hug' });
  });

  it('several frames each get their own layout, one undo step', () => {
    const target = editorOf([
      frame('f', 'p1', { x: 0, y: 0, width: 200, height: 100 }, ['a', 'b']),
      rect('a', 'f', { x: 10, y: 10, width: 20, height: 20 }),
      rect('b', 'f', { x: 40, y: 10, width: 20, height: 20 }),
      frame('g', 'p1', { x: 300, y: 0, width: 100, height: 200 }, ['c', 'd']),
      rect('c', 'g', { x: 10, y: 10, width: 20, height: 20 }),
      rect('d', 'g', { x: 10, y: 50, width: 20, height: 20 }),
    ]);
    const before = serialized(target);
    ok(target, { type: 'addAutoLayout', ids: ['f', 'g'] });
    expect(nodeIn(target, 'f').autoLayout).toMatchObject({ direction: 'horizontal', gap: 10 });
    expect(nodeIn(target, 'g').autoLayout).toMatchObject({ direction: 'vertical', gap: 20 });
    ok(target, { type: 'undo' });
    expect(serialized(target)).toBe(before);
  });

  it('wraps loose nodes in a new auto-layout frame and selects it; refuses mixed parents', () => {
    const target = editorOf([
      rect('a', 'p1', { x: 100, y: 0, width: 20, height: 20 }),
      rect('b', 'p1', { x: 0, y: 0, width: 20, height: 20 }),
      frame('f', 'p1', { x: 500, y: 0, width: 50, height: 50 }, ['c']),
      rect('c', 'f', { x: 0, y: 0, width: 5, height: 5 }),
    ]);
    const [id] = ok(target, { type: 'addAutoLayout', ids: ['a', 'b'] });
    const wrap = nodeIn(target, id!);
    expect(wrap).toMatchObject({ type: 'frame', name: 'Frame', fills: [], stroke: null });
    expect(wrap.autoLayout).toEqual(al({ gap: 80 }));
    expect(wrap.children).toEqual(['b', 'a']);
    expect(frameOf(target, id!)).toEqual({ x: 0, y: 0, width: 120, height: 20 });
    expect(target.execute({ type: 'addAutoLayout', ids: ['a', 'c'] })).toMatchObject({
      ok: false,
      code: 'editor.not-siblings',
    });
  });

  it('removeAutoLayout keeps frames; hug becomes fixed', () => {
    const target = editorOf(row());
    ok(target, { type: 'setLayout', ids: ['f'], autoLayout: { gap: 20 } });
    const kept = xs(target, ['a', 'b', 'c']);
    ok(target, { type: 'removeAutoLayout', ids: ['f', 'a'] });
    expect(nodeIn(target, 'f').autoLayout).toBeUndefined();
    expect(nodeIn(target, 'f').layoutSizing).toBeUndefined();
    expect(xs(target, ['a', 'b', 'c'])).toEqual(kept);
  });

  it('setLayout on several nodes is one step; refusals change nothing; text rules', () => {
    const target = editorOf([
      ...row([textNode('t', 'f', { x: 90, y: 0, width: 30, height: 20 }, 'aaa')]),
      frame('g', 'p1', { x: 0, y: 100, width: 50, height: 50 }, []),
    ]);
    const before = serialized(target);
    // `g` has no auto layout: the patch leaves it unchanged.
    ok(target, { type: 'setLayout', ids: ['f', 'g'], autoLayout: { gap: 4 } });
    expect(nodeIn(target, 'g').autoLayout).toBeUndefined();
    expect(nodeIn(target, 'f').autoLayout!.gap).toBe(4);
    const after = serialized(target);
    for (const bad of [
      { type: 'setLayout', ids: ['a'], layoutSizing: { horizontal: 'hug' } },
      { type: 'setLayout', ids: ['f'], autoLayout: { gap: 20000 } },
      { type: 'setLayout', ids: ['f'], autoLayout: { padding: [-1, 0, 0, 0] } },
      { type: 'setLayout', ids: ['f'], autoLayout: { wrap: true } },
    ] as unknown as Command[]) {
      expect(target.execute(bad).ok).toBe(false);
      expect(serialized(target)).toBe(after);
    }
    ok(target, { type: 'setLayout', ids: ['t'], layoutSizing: { horizontal: 'fill' } });
    expect(nodeIn(target, 't')).toMatchObject({ sizing: 'autoHeight' });
    ok(target, { type: 'undo' });
    ok(target, { type: 'undo' });
    expect(serialized(target)).toBe(before);
  });

  it('setLayout null removes auto layout with hug fixed; createSymbol drops it', () => {
    const target = editorOf(row());
    ok(target, { type: 'setLayout', ids: ['f'], autoLayout: null });
    expect(nodeIn(target, 'f').layoutSizing).toBeUndefined();
    ok(target, { type: 'undo' });
    ok(target, { type: 'createSymbol', ids: ['f'] });
    const symbol = nodeIn(target, 'f');
    expect(symbol.type).toBe('symbol');
    expect(symbol.autoLayout).toBeUndefined();
    expect(symbol.layoutSizing).toBeUndefined();
  });

  it('detaching an instance keeps its layoutSizing', () => {
    const target = editorOf([...row(), rect('s', 'p1', { x: 500, y: 0, width: 20, height: 20 })]);
    const [symbol] = ok(target, { type: 'createSymbol', ids: ['s'] });
    const [instance] = ok(target, { type: 'createInstance', symbol: symbol! });
    ok(target, { type: 'moveNodes', ids: [instance!], parent: 'f', index: 3 });
    ok(target, { type: 'setLayout', ids: [instance!], layoutSizing: { vertical: 'fill' } });
    ok(target, { type: 'detachInstances', ids: [instance!] });
    const detached = nodeIn(target, instance!);
    expect(detached.type).toBe('frame');
    expect(detached.layoutSizing).toEqual(FILL_H);
  });

  it('Shift+A and Shift+Alt+A are bound', () => {
    const target = editorOf(row());
    const keymap = target.query({ type: 'keymap' }) as readonly { chord: string; action: string }[];
    const chords = (action: string) =>
      keymap.filter((b) => b.action === action).map((b) => b.chord);
    expect(chords('addAutoLayout')).toEqual(['Shift+KeyA']);
    expect(chords('removeAutoLayout')).toHaveLength(1);
    expect(chords('removeAutoLayout')[0]).toMatch(/Alt/);
  });
});

describe('V34-A01 schema fields', () => {
  it('reads, normalizes and round-trips the fields; refuses each S3 case', () => {
    const nodes = row();
    const document = doc(nodes);
    const text = serializeDocument(document);
    expect(text).toContain('"autoLayout"');
    expect(
      (JSON.parse(text) as { nodes: Record<string, Loose> }).nodes.a!.layoutSizing,
    ).toBeUndefined();
    const fixed = doc([
      ...row().slice(0, 1),
      rect(
        'a',
        'f',
        { x: 0, y: 0, width: 1, height: 1 },
        { layoutSizing: { horizontal: 'fixed', vertical: 'fixed' } },
      ),
      ...row().slice(2),
    ]);
    expect('layoutSizing' in fixed.nodes.a!).toBe(false);
    const bad = (patch: (value: Record<string, Loose>) => void, path: string) => {
      const value = JSON.parse(text) as { nodes: Record<string, Loose> };
      patch(value.nodes);
      expect(validateDocument(value)).toMatchObject({
        ok: false,
        code: 'document.invalid-field',
        path,
      });
    };
    bad((n) => (n.a!.autoLayout = al()), '/nodes/a/autoLayout');
    bad(
      (n) => (n.a!.layoutSizing = { horizontal: 'hug', vertical: 'fixed' }),
      '/nodes/a/layoutSizing/horizontal',
    );
    bad(
      (n) => ((n.f!.autoLayout as Record<string, unknown>).gap = 10001),
      '/nodes/f/autoLayout/gap',
    );
    bad(
      (n) => ((n.f!.autoLayout as Record<string, unknown>).padding = [0, 0, 0]),
      '/nodes/f/autoLayout/padding',
    );
    bad(
      (n) => ((n.f!.autoLayout as Record<string, unknown>).extra = 1),
      '/nodes/f/autoLayout/extra',
    );
    bad((n) => (n.a!.layoutSizing = { horizontal: 'fill' }), '/nodes/a/layoutSizing/vertical');
  });

  it('is a v8 field: a v7 input reads without it and refuses it (viz-schema-v8.md)', () => {
    const text = serializeDocument(doc(row()));
    const v7 = (strip: boolean) => {
      const value = JSON.parse(text) as { schemaVersion: number; nodes: Record<string, Loose> };
      value.schemaVersion = 7;
      // v7's shape: one `fill`, no `blendMode` (V-35).
      for (const node of Object.values(value.nodes)) {
        if ('fills' in node) {
          const fills = node.fills as readonly { paint: unknown }[];
          node.fill = fills[0]?.paint ?? null;
          delete node.fills;
        }
        delete node.blendMode;
      }
      if (strip) {
        for (const node of Object.values(value.nodes)) {
          delete node.autoLayout;
          delete node.layoutSizing;
        }
      }
      return value;
    };
    const read = validateAnyDocument(v7(true));
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.document.schemaVersion).toBe(8);
      expect('autoLayout' in read.document.nodes.f!).toBe(false);
    }
    expect(validateAnyDocument(v7(false))).toMatchObject({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/f/autoLayout',
    });
    // A clipboard fragment below v8 refuses the keys too.
    const editor = createEditor({ document: doc(row()) });
    expect(editor.execute({ type: 'copy', ids: ['f'] }).ok).toBe(true);
    const copied = editor.query({ type: 'clipboard' })!;
    expect(copied).toContain('"autoLayout"');
    const older = copied.replace('"schemaVersion":8,', '"schemaVersion":7,');
    expect(editor.execute({ type: 'paste', text: older })).toMatchObject({
      ok: false,
      code: 'document.invalid-field',
    });
    expect(editor.execute({ type: 'paste', text: copied }).ok).toBe(true);
  });
});

describe('V34-A08 cost', () => {
  it('lays out 1,000 participants (100 fill) and a 10-deep hug nest', () => {
    const nodes: Loose[] = [
      frame('f', 'p1', { x: 0, y: 0, width: 50000, height: 50 }, [], al({ gap: 2 })),
    ];
    for (let i = 0; i < 1000; i += 1) {
      nodes.push(
        rect(
          `r${i}`,
          'f',
          { x: 0, y: 0, width: 20, height: 20 },
          i % 10 === 0 ? { layoutSizing: FILL_W } : {},
        ),
      );
      (nodes[0]!.children as string[]).push(`r${i}`);
    }
    const document = doc(nodes);
    const times: number[] = [];
    for (let k = 0; k < 5; k += 1) {
      const draft = new Draft(document);
      const t0 = performance.now();
      layoutFrame({ tree: draft, measure: undefined }, 'f');
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[2]!;
    const nest: Loose[] = [];
    for (let i = 0; i < 10; i += 1) {
      nest.push(
        frame(
          `n${i}`,
          i === 0 ? 'p1' : `n${i - 1}`,
          { x: 0, y: 0, width: 1, height: 1 },
          [i === 9 ? 'leaf' : `n${i + 1}`],
          al({ padding: [1, 1, 1, 1] }),
          HUG,
        ),
      );
    }
    nest.push(rect('leaf', 'n9', { x: 0, y: 0, width: 10, height: 10 }));
    const nestTimes: number[] = [];
    for (let k = 0; k < 5; k += 1) {
      const target = editorOf(nest, false);
      const t0 = performance.now();
      ok(target, {
        type: 'setFrames',
        frames: [{ id: 'leaf', frame: { x: 0, y: 0, width: 11, height: 10 } }],
      });
      nestTimes.push(performance.now() - t0);
      expect(frameOf(target, 'n0').width).toBe(31);
    }
    nestTimes.sort((a, b) => a - b);
    console.log(
      `V34-A08 1000 participants median ${median.toFixed(3)} ms; 10-deep nest command median ${nestTimes[2]!.toFixed(3)} ms`,
    );
    // V34-A08's bounds hold in the cloud container where the record is taken; the Windows CI
    // runners only log, so a slow shared runner cannot fail an unrelated change.
    if (process.env.CI === undefined) {
      expect(median).toBeLessThanOrEqual(5);
      expect(nestTimes[2]!).toBeLessThanOrEqual(1);
    }
  });
});
