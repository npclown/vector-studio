import type { Frame } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type IdSource,
  type Modifiers,
  type PagePoint,
} from '../../packages/editor-core/src/index.js';
// Source import: page-space bounds, since a group refits its frame at commit.
import { boundsOf } from '../../packages/editor-core/src/hit-test.js';

// MVP M2-U5, M2-A09 (M2 contract, section 5): the session `scope` and `setScope` with its failure
// order; frame entry by double-click into nested groups, mask groups and frames and on a frame's
// background; the `exitScope` (Escape) and `enterScope` (Enter) actions; the selection-target
// and marquee rules with the scope in place of the page, a press on the scope node itself, and
// the scope resets (outside press, page switch, load, deletion, undo); Alt-click overlap cycling
// over a four-node stack with wrap-around, Alt-drag duplication kept, and snapping candidates
// inside a scope, all driven through `input`.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const alt: Modifiers = { ...none, alt: true };
const shift: Modifiers = { ...none, shift: true };
const ctrl: Modifiers = { ...none, ctrl: true };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });

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

function rect(id: string, parent: string, frame: Frame): Loose {
  return {
    ...base(id, parent, frame),
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
  };
}

/** A square path covering its frame: the mask source of `mg`. */
function square(id: string, parent: string, frame: Frame): Loose {
  return {
    ...base(id, parent, frame),
    type: 'path',
    path: {
      verbs: ['move', 'line', 'line', 'line', 'close'],
      points: [0, 0, 1, 0, 1, 1, 0, 1],
      fillRule: 'nonzero',
    },
    fill: black,
    stroke: null,
  };
}

function container(
  type: 'group' | 'frame' | 'maskGroup',
  id: string,
  parent: string,
  children: string[],
  frame: Frame,
): Loose {
  const node: Loose = { ...base(id, parent, frame), type, children };
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

/**
 * Page p1, in page coordinates: a group `g` (100..200, 0..100) holding `ga` (100..140, 0..40)
 * and a nested group `gg` (150..200, 50..100) with `gga` (150..170, 50..70) and `ggb`
 * (180..200, 80..100); a top-level frame `F` (300..500, 0..200) holding `fa` (310..340, 10..40),
 * a frame `F2` (400..480, 100..180) with `f2a` (410..430, 110..130) and an empty frame `F3`
 * (450..470, 150..170), and a group `fg` with `fga` (310..350, 100..140); a mask group `mg`
 * (0..100, 300..400) with the square source `mp`, `mr` (10..40, 310..340) and `ms`
 * (60..90, 360..390); a rectangle `r` (600..620, 0..20). Page p2: `o`.
 */
const FIXTURE = doc(
  [
    ['p1', ['g', 'F', 'mg', 'r']],
    ['p2', ['o']],
  ],
  [
    container('group', 'g', 'p1', ['ga', 'gg'], f(100, 0, 100, 100)),
    rect('ga', 'g', f(0, 0, 40, 40)),
    container('group', 'gg', 'g', ['gga', 'ggb'], f(50, 50, 50, 50)),
    rect('gga', 'gg', f(0, 0, 20, 20)),
    rect('ggb', 'gg', f(30, 30, 20, 20)),
    container('frame', 'F', 'p1', ['fa', 'F2', 'fg'], f(300, 0, 200, 200)),
    rect('fa', 'F', f(10, 10, 30, 30)),
    container('frame', 'F2', 'F', ['f2a', 'F3'], f(100, 100, 80, 80)),
    rect('f2a', 'F2', f(10, 10, 20, 20)),
    container('frame', 'F3', 'F2', [], f(50, 50, 20, 20)),
    container('group', 'fg', 'F', ['fga'], f(10, 100, 40, 40)),
    rect('fga', 'fg', f(0, 0, 40, 40)),
    container('maskGroup', 'mg', 'p1', ['mp', 'mr', 'ms'], f(0, 300, 100, 100)),
    square('mp', 'mg', f(0, 0, 100, 100)),
    rect('mr', 'mg', f(10, 10, 30, 30)),
    rect('ms', 'mg', f(60, 60, 30, 30)),
    rect('r', 'p1', f(600, 0, 20, 20)),
    rect('o', 'p2', f(0, 0, 10, 10)),
  ],
);

/** Points on each node, in page space. */
const P = {
  ga: at(120, 20),
  gga: at(160, 60),
  ggb: at(190, 90),
  fBackground: at(360, 60),
  fa: at(325, 25),
  f2a: at(420, 120),
  f2Background: at(420, 160),
  f3: at(460, 160),
  fga: at(330, 120),
  mr: at(25, 325),
  ms: at(75, 375),
  /** Inside the mask source only: the source is not hittable. */
  masked: at(50, 350),
  r: at(610, 10),
  empty: at(700, 300),
};

/**
 * Four overlapping rectangles `a` to `d` (paint order) sharing the point (35, 35); a rectangle
 * `e` and above it a group `q` with `qa` and `qb`, all three under (125, 25).
 */
const STACK = doc(
  [['p1', ['a', 'b', 'c', 'd', 'e', 'q']]],
  [
    rect('a', 'p1', f(0, 0, 40, 40)),
    rect('b', 'p1', f(10, 10, 40, 40)),
    rect('c', 'p1', f(20, 20, 40, 40)),
    rect('d', 'p1', f(30, 30, 40, 40)),
    rect('e', 'p1', f(110, 10, 40, 40)),
    container('group', 'q', 'p1', ['qa', 'qb'], f(100, 0, 40, 40)),
    rect('qa', 'q', f(0, 0, 40, 40)),
    rect('qb', 'q', f(10, 10, 30, 30)),
  ],
);
const FOUR = at(35, 35);
const NESTED = at(125, 25);

function counter(): IdSource {
  let drawn = 0;
  return () => {
    drawn += 1;
    return `n${drawn}`;
  };
}

/** An editor on `document` with snapping off, so moves are raw (M2-U3 note 10). */
function setup(document: unknown = FIXTURE, snapping = false): Editor {
  const target = createEditor({ document, ids: counter() });
  if (!snapping) ok(target, { type: 'setSnapping', enabled: false });
  return target;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function input(target: Editor, event: unknown): CommandResult {
  return target.execute({ type: 'input', event } as Command);
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  point: PagePoint,
  modifiers = none,
): CommandResult {
  return input(target, { kind, point, modifiers });
}

function click(target: Editor, point: PagePoint, modifiers = none): void {
  pointer(target, 'pointerdown', point, modifiers);
  pointer(target, 'pointerup', point, modifiers);
}

function drag(target: Editor, from: PagePoint, to: PagePoint, modifiers = none): void {
  pointer(target, 'pointerdown', from, modifiers);
  pointer(target, 'pointermove', to, modifiers);
  pointer(target, 'pointerup', to, modifiers);
}

const doubleclick = (target: Editor, point: PagePoint, modifiers = none) =>
  input(target, { kind: 'doubleclick', point, modifiers });
const key = (target: Editor, name: string, modifiers = none) =>
  input(target, { kind: 'keydown', key: name, modifiers });
const select = (target: Editor, ids: readonly string[]) =>
  ok(target, { type: 'setSelection', ids });
const enter = (target: Editor, id: string | null) => ok(target, { type: 'setScope', id });
const selection = (target: Editor) => target.query({ type: 'selection' });
const scope = (target: Editor) => target.query({ type: 'scope' });
const nodeOf = (target: Editor, id: string) => target.query({ type: 'node', id })!;
const undoDepth = (target: Editor) => target.query({ type: 'history' }).undoDepth;

/** Records each event as its session field, `document:<cause>` or its type. */
function record(target: Editor): string[] {
  const events: string[] = [];
  target.subscribe((event: EditorEvent) => {
    if (event.type === 'session') events.push(event.field);
    else if (event.type === 'document') events.push(`document:${event.cause}`);
    else events.push(event.type);
  });
  return events;
}

const consumed = { ok: true, ids: [], consumed: true };
const unconsumed = { ok: true, ids: [], consumed: false };

describe('M2-A09 setScope', () => {
  it('sets the scope as session state, read by query and snapshot; unchanged raises nothing', () => {
    const target = setup();
    expect(scope(target)).toBeNull();
    expect(target.getSnapshot().scope).toBeNull();
    const events = record(target);
    const revision = target.query({ type: 'revision' });
    expect(target.execute({ type: 'setScope', id: 'gg' })).toEqual({ ok: true, ids: [] });
    expect(scope(target)).toBe('gg');
    expect(target.getSnapshot().scope).toBe('gg');
    expect(events).toEqual(['scope']);
    // An unchanged value succeeds without an event (section 2).
    expect(target.execute({ type: 'setScope', id: 'gg' })).toEqual({ ok: true, ids: [] });
    expect(events).toEqual(['scope']);
    enter(target, null);
    expect(scope(target)).toBeNull();
    expect(target.execute({ type: 'setScope', id: null })).toEqual({ ok: true, ids: [] });
    expect(events).toEqual(['scope', 'scope']);
    // Never history, never the document.
    expect(target.query({ type: 'revision' })).toBe(revision);
    expect(undoDepth(target)).toBe(0);
  });

  it.each(['g', 'gg', 'mg', 'F', 'F2', 'F3', 'fg'])('accepts the container %s', (id) => {
    const target = setup();
    enter(target, id);
    expect(scope(target)).toBe(id);
  });

  it.each([
    ['a number', { id: 3 }, { ok: false, code: 'editor.invalid-command', path: '/id' }],
    ['a missing id', {}, { ok: false, code: 'editor.invalid-command', path: '/id' }],
    ['an unknown ID', { id: 'zz' }, { ok: false, code: 'editor.unknown-node' }],
    // Another page's leaf: unknown-node before invalid-scope (section 4.4).
    ['another page’s node', { id: 'o' }, { ok: false, code: 'editor.unknown-node' }],
    ['a page ID', { id: 'p1' }, { ok: false, code: 'editor.unknown-node' }],
    ['a leaf of the active page', { id: 'ga' }, { ok: false, code: 'editor.invalid-scope' }],
    ['the mask source', { id: 'mp' }, { ok: false, code: 'editor.invalid-scope' }],
  ])('rejects %s, changing nothing', (_, fields, expected) => {
    const target = setup();
    enter(target, 'g');
    const events = record(target);
    expect(target.execute({ type: 'setScope', ...fields } as Command)).toEqual(expected);
    expect(scope(target)).toBe('g');
    expect(events).toEqual([]);
  });

  it('a container of another page is unknown-node', () => {
    const target = setup(
      doc(
        [
          ['p1', ['a']],
          ['p2', ['h']],
        ],
        [
          rect('a', 'p1', f(0, 0, 10, 10)),
          container('group', 'h', 'p2', ['ha'], f(0, 0, 10, 10)),
          rect('ha', 'h', f(0, 0, 10, 10)),
        ],
      ),
    );
    expect(target.execute({ type: 'setScope', id: 'h' })).toEqual({
      ok: false,
      code: 'editor.unknown-node',
    });
  });
});

describe('M2-A09 frame entry by double-click', () => {
  it('enters nested groups one level per double-click, selecting the next node down', () => {
    const target = setup();
    const events = record(target);
    expect(doubleclick(target, P.gga)).toEqual(consumed);
    expect(scope(target)).toBe('g');
    expect(selection(target)).toEqual(['gg']);
    expect(events).toEqual(['scope', 'selection']);
    expect(doubleclick(target, P.gga)).toEqual(consumed);
    expect(scope(target)).toBe('gg');
    expect(selection(target)).toEqual(['gga']);
    // A leaf target does nothing (path editing is M3).
    events.length = 0;
    expect(doubleclick(target, P.gga)).toEqual(unconsumed);
    expect(scope(target)).toBe('gg');
    expect(selection(target)).toEqual(['gga']);
    expect(events).toEqual([]);
  });

  it('follows the browser sequence: two clicks select the target, the double-click enters', () => {
    const target = setup();
    click(target, P.gga);
    expect(selection(target)).toEqual(['g']);
    click(target, P.gga);
    doubleclick(target, P.gga);
    expect(scope(target)).toBe('g');
    expect(selection(target)).toEqual(['gg']);
    // The next pair of clicks inside the scope selects the target below it.
    click(target, P.gga);
    expect(selection(target)).toEqual(['gg']);
    doubleclick(target, P.gga);
    expect(scope(target)).toBe('gg');
    expect(selection(target)).toEqual(['gga']);
  });

  it('a top-level frame’s background scopes that frame with an empty selection', () => {
    const target = setup();
    select(target, ['r']);
    const events = record(target);
    expect(doubleclick(target, P.fBackground)).toEqual(consumed);
    expect(scope(target)).toBe('F');
    expect(selection(target)).toEqual([]);
    expect(events).toEqual(['scope', 'selection']);
  });

  it('a top-level frame’s leaf child is a leaf target: nothing happens', () => {
    const target = setup();
    expect(doubleclick(target, P.fa)).toEqual(unconsumed);
    expect(scope(target)).toBeNull();
  });

  it('a nested frame: its child is selected, its own background gives an empty selection', () => {
    const target = setup();
    // At the page, F2 is the target (a child of the top-level frame).
    doubleclick(target, P.f2a);
    expect(scope(target)).toBe('F2');
    expect(selection(target)).toEqual(['f2a']);

    const second = setup();
    doubleclick(second, P.f2Background);
    expect(scope(second)).toBe('F2');
    expect(selection(second)).toEqual([]);
    // Then the empty frame F3 inside it.
    doubleclick(second, P.f3);
    expect(scope(second)).toBe('F3');
    expect(selection(second)).toEqual([]);
  });

  it('enters a group inside a top-level frame', () => {
    const target = setup();
    doubleclick(target, P.fga);
    expect(scope(target)).toBe('fg');
    expect(selection(target)).toEqual(['fga']);
  });

  it('enters a mask group on a masked child; the source alone is not hittable', () => {
    const target = setup();
    doubleclick(target, P.mr);
    expect(scope(target)).toBe('mg');
    expect(selection(target)).toEqual(['mr']);
    // On the source's area alone no node is hit: empty canvas.
    const second = setup();
    expect(doubleclick(second, P.masked)).toEqual(unconsumed);
    expect(scope(second)).toBeNull();
    expect(selection(second)).toEqual([]);
  });

  it('empty canvas and the scope node itself do nothing', () => {
    const target = setup();
    expect(doubleclick(target, P.empty)).toEqual(unconsumed);
    expect(scope(target)).toBeNull();
    enter(target, 'F');
    select(target, ['fa']);
    const events = record(target);
    expect(doubleclick(target, P.fBackground)).toEqual(unconsumed);
    expect(scope(target)).toBe('F');
    expect(selection(target)).toEqual(['fa']);
    expect(events).toEqual([]);
  });

  it('a double-click outside the scope enters by the page rule', () => {
    const target = setup();
    enter(target, 'gg');
    doubleclick(target, P.mr);
    expect(scope(target)).toBe('mg');
    expect(selection(target)).toEqual(['mr']);
    // From inside fg, the group g is entered by the page rule.
    enter(target, 'fg');
    doubleclick(target, P.ga);
    expect(scope(target)).toBe('g');
    expect(selection(target)).toEqual(['ga']);
  });

  it('only the select tool acts on a double-click', () => {
    const target = setup();
    ok(target, { type: 'setTool', tool: 'rectangle' });
    expect(doubleclick(target, P.gga)).toEqual(unconsumed);
    expect(scope(target)).toBeNull();
  });
});

describe('M2-A09 Escape and Enter', () => {
  it('Escape goes up one level per press, selecting the scope node, then clears', () => {
    const target = setup();
    enter(target, 'gg');
    select(target, ['gga']);
    const events = record(target);
    expect(key(target, 'Escape')).toEqual(consumed);
    expect(selection(target)).toEqual(['gg']);
    expect(scope(target)).toBe('g');
    expect(events).toEqual(['selection', 'scope']);
    expect(key(target, 'Escape')).toEqual(consumed);
    expect(selection(target)).toEqual(['g']);
    expect(scope(target)).toBeNull();
    expect(key(target, 'Escape')).toEqual(consumed);
    expect(selection(target)).toEqual([]);
    expect(events).toEqual(['selection', 'scope', 'selection', 'scope', 'selection']);
    // At the top with nothing selected: consumed, no event.
    expect(key(target, 'Escape')).toEqual(consumed);
    expect(events).toHaveLength(5);
  });

  it.each([
    // A top-level frame is skipped: its children are targets at the page already.
    ['F2', null],
    ['fg', null],
    ['F', null],
    ['mg', null],
    // A frame inside a nested frame goes to that frame.
    ['F3', 'F2'],
  ])('Escape from %s selects it and moves the scope to %s', (from, to) => {
    const target = setup();
    enter(target, from);
    expect(key(target, 'Escape')).toEqual(consumed);
    expect(selection(target)).toEqual([from]);
    expect(scope(target)).toBe(to);
  });

  it('Escape during a drag cancels it first; the scope stays', () => {
    const target = setup();
    enter(target, 'g');
    select(target, ['r']);
    pointer(target, 'pointerdown', P.ga);
    pointer(target, 'pointermove', at(130, 30));
    expect(selection(target)).toEqual(['ga']);
    expect(key(target, 'Escape')).toEqual(consumed);
    expect(nodeOf(target, 'ga').frame).toEqual(f(0, 0, 40, 40));
    expect(scope(target)).toBe('g');
    // The selection when the gesture began, after the press selected the target.
    expect(selection(target)).toEqual(['ga']);
  });

  it('Enter enters a single selected container and selects its children', () => {
    const target = setup();
    select(target, ['g']);
    const events = record(target);
    expect(key(target, 'Enter')).toEqual(consumed);
    expect(scope(target)).toBe('g');
    expect(selection(target)).toEqual(['ga', 'gg']);
    expect(events).toEqual(['scope', 'selection']);
    // Two selected nodes, a leaf or nothing: a consumed no-op.
    events.length = 0;
    expect(key(target, 'Enter')).toEqual(consumed);
    select(target, ['ga']);
    expect(key(target, 'Enter')).toEqual(consumed);
    select(target, []);
    expect(key(target, 'Enter')).toEqual(consumed);
    expect(scope(target)).toBe('g');
    expect(events).toEqual(['selection', 'selection']);
    select(target, ['gg']);
    key(target, 'Enter');
    expect(scope(target)).toBe('gg');
    expect(selection(target)).toEqual(['gga', 'ggb']);
  });

  it.each([
    ['F', ['fa', 'F2', 'fg']],
    ['F3', []],
    // The mask source is not hittable, but it is a child: Enter selects it too.
    ['mg', ['mp', 'mr', 'ms']],
  ])('Enter on %s', (id, children) => {
    const target = setup();
    select(target, [id]);
    key(target, 'Enter');
    expect(scope(target)).toBe(id);
    expect(selection(target)).toEqual(children);
  });

  it('Enter with pending path anchors finishes the path, not a scope', () => {
    const target = setup();
    select(target, ['g']);
    ok(target, { type: 'setTool', tool: 'path' });
    click(target, at(700, 700));
    click(target, at(720, 700));
    expect(key(target, 'Enter')).toEqual(consumed);
    expect(scope(target)).toBeNull();
    expect(selection(target)).toEqual(['n1']);
  });

  it('select all selects the scope’s children, else the page’s', () => {
    const target = setup();
    key(target, 'a', ctrl);
    expect(selection(target)).toEqual(['g', 'F', 'mg', 'r']);
    enter(target, 'mg');
    expect(key(target, 'a', ctrl)).toEqual(consumed);
    expect(selection(target)).toEqual(['mp', 'mr', 'ms']);
    enter(target, 'F3');
    key(target, 'a', ctrl);
    expect(selection(target)).toEqual([]);
  });
});

describe('M2-A09 scope target and marquee rules', () => {
  it('a hit inside the scope targets its outermost ancestor below the scope', () => {
    const target = setup();
    enter(target, 'g');
    click(target, P.gga);
    expect(selection(target)).toEqual(['gg']);
    click(target, P.ga);
    expect(selection(target)).toEqual(['ga']);
    enter(target, 'gg');
    click(target, P.ggb);
    expect(selection(target)).toEqual(['ggb']);
    // Inside a frame scope, the nested frame is the target of its child.
    enter(target, 'F');
    click(target, P.f2a);
    expect(selection(target)).toEqual(['F2']);
    enter(target, 'mg');
    click(target, P.ms);
    expect(selection(target)).toEqual(['ms']);
    expect(scope(target)).toBe('mg');
  });

  it('a click on the scope node itself clears the selection and keeps the scope', () => {
    const target = setup();
    enter(target, 'F');
    select(target, ['fa']);
    const events = record(target);
    click(target, P.fBackground);
    expect(selection(target)).toEqual([]);
    expect(scope(target)).toBe('F');
    // The marquee's overlay appears at the press and goes at the release.
    expect(events).toEqual(['overlay', 'selection', 'overlay']);
  });

  it('a drag from the scope node is the scope’s marquee over its children', () => {
    const target = setup();
    enter(target, 'F');
    // Contains fa, intersects the group fg; r and the page's other children are not candidates.
    // The selection is cleared before each press, so no rotate zone is near it.
    drag(target, at(305, 5), at(345, 145));
    expect(selection(target)).toEqual(['fa', 'fg']);
    expect(scope(target)).toBe('F');
    select(target, []);
    drag(target, at(305, 5), at(650, 50));
    expect(selection(target)).toEqual(['fa']);
    // A frame child is selected only when contained.
    select(target, []);
    drag(target, at(390, 90), at(450, 150));
    expect(selection(target)).toEqual([]);
    drag(target, at(390, 90), at(490, 190));
    expect(selection(target)).toEqual(['F2']);
    // Shift adds to the selection.
    drag(target, at(305, 5), at(345, 45), shift);
    expect(selection(target)).toEqual(['F2', 'fa']);
  });

  it('a marquee in a nested frame scope uses page-space bounds of its children', () => {
    const target = setup();
    enter(target, 'F2');
    drag(target, at(405, 105), at(431, 131));
    expect(selection(target)).toEqual(['f2a']);
    select(target, []);
    drag(target, at(405, 105), at(465, 165));
    // F3 (450..470, 150..170) is a frame: intersecting is not enough.
    expect(selection(target)).toEqual(['f2a']);
    select(target, []);
    drag(target, at(405, 105), at(475, 175));
    expect(selection(target)).toEqual(['f2a', 'F3']);
  });

  it('a press outside the scope’s subtree leaves it and applies the page rule', () => {
    const target = setup();
    enter(target, 'gg');
    const events = record(target);
    click(target, P.r);
    expect(scope(target)).toBeNull();
    expect(selection(target)).toEqual(['r']);
    expect(events).toEqual(['scope', 'selection']);
    // A sibling of the scope inside its parent is outside the subtree too.
    enter(target, 'gg');
    click(target, P.ga);
    expect(scope(target)).toBeNull();
    expect(selection(target)).toEqual(['g']);
    // Shift toggles the page-rule target.
    enter(target, 'gg');
    click(target, P.fa, shift);
    expect(scope(target)).toBeNull();
    expect(selection(target)).toEqual(['g', 'fa']);
  });

  it('a press on empty page canvas leaves the scope; a drag there is the page marquee', () => {
    const target = setup();
    enter(target, 'gg');
    select(target, ['gga']);
    click(target, P.empty);
    expect(scope(target)).toBeNull();
    expect(selection(target)).toEqual([]);
    // Inside a group's box but on no node: a group has no area of its own.
    enter(target, 'g');
    drag(target, at(145, 45), at(615, 15));
    expect(scope(target)).toBeNull();
    expect(selection(target)).toEqual(['g', 'r']);
  });

  it('a resize handle wins over the scope reset', () => {
    const target = setup();
    enter(target, 'gg');
    select(target, ['gga']);
    // The bottom-right handle of gga at (170, 70), dragged outward.
    drag(target, at(170, 70), at(175, 75));
    expect(scope(target)).toBe('gg');
    expect(nodeOf(target, 'gga').frame).toEqual(f(0, 0, 25, 25));
  });
});

describe('M2-A09 scope resets', () => {
  it('a page switch clears the scope after the selection', () => {
    const target = setup();
    enter(target, 'g');
    select(target, ['ga']);
    const events = record(target);
    ok(target, { type: 'setActivePage', id: 'p2' });
    expect(scope(target)).toBeNull();
    expect(events).toEqual(['activePage', 'selection', 'scope']);
    // Without a scope, no scope event.
    events.length = 0;
    ok(target, { type: 'setActivePage', id: 'p1' });
    expect(events).toEqual(['activePage']);
  });

  it('a load clears the scope, also when the scoped node exists in the new document', () => {
    const target = setup();
    enter(target, 'g');
    const events = record(target);
    ok(target, { type: 'loadDocument', document: FIXTURE });
    expect(scope(target)).toBeNull();
    expect(events).toEqual(['document:load', 'scope']);
  });

  it('deleting the scoped node or an ancestor clears it; undo does not restore it', () => {
    const target = setup();
    enter(target, 'gg');
    select(target, ['gga']);
    const events = record(target);
    ok(target, { type: 'deleteNodes', ids: ['gg'] });
    expect(scope(target)).toBeNull();
    expect(events).toEqual(['document:command', 'selection', 'scope']);
    ok(target, { type: 'undo' });
    expect(scope(target)).toBeNull();

    enter(target, 'gg');
    ok(target, { type: 'deleteNodes', ids: ['g'] });
    expect(scope(target)).toBeNull();
  });

  it('the Delete key on a scope child keeps the scope; ungrouping the scope node clears it', () => {
    const target = setup();
    enter(target, 'gg');
    select(target, ['gga']);
    const events = record(target);
    key(target, 'Delete');
    expect(scope(target)).toBe('gg');
    expect(events).not.toContain('scope');
    ok(target, { type: 'ungroupNodes', id: 'gg' });
    expect(scope(target)).toBeNull();
  });

  it('undoing away the scoped node clears it', () => {
    const target = setup();
    const [group] = ok(target, { type: 'groupNodes', ids: ['r'], kind: 'group' });
    enter(target, group!);
    const events = record(target);
    ok(target, { type: 'undo' });
    expect(scope(target)).toBeNull();
    expect(events).toEqual(['document:undo', 'scope']);
  });
});

describe('M2-A09 overlap cycling', () => {
  it('Alt-click reaches all four nodes of the stack and wraps', () => {
    const target = setup(STACK);
    const events = record(target);
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      expect(pointer(target, 'pointerdown', FOUR, alt)).toEqual(consumed);
      expect(pointer(target, 'pointerup', FOUR, alt)).toEqual(consumed);
      seen.push(...selection(target));
    }
    expect(seen).toEqual(['d', 'c', 'b', 'a', 'd']);
    expect(events).toEqual(['selection', 'selection', 'selection', 'selection', 'selection']);
    expect(undoDepth(target)).toBe(0);
  });

  it('the press defers the change; cycling starts from the pre-press selection', () => {
    const target = setup(STACK);
    select(target, ['c']);
    const events = record(target);
    pointer(target, 'pointerdown', FOUR, alt);
    expect(selection(target)).toEqual(['c']);
    expect(events).toEqual([]);
    pointer(target, 'pointerup', FOUR, alt);
    expect(selection(target)).toEqual(['b']);
    // a is last: the next item wraps to the top.
    select(target, ['a']);
    click(target, FOUR, alt);
    expect(selection(target)).toEqual(['d']);
  });

  it.each([
    ['two selected nodes', ['c', 'b']],
    ['a node not in the stack', ['e']],
    ['nothing', []],
  ])('with %s it selects the top of the stack', (_, before) => {
    const target = setup(STACK);
    select(target, before);
    click(target, FOUR, alt);
    expect(selection(target)).toEqual(['d']);
  });

  it('the stack holds selection targets without repeats; inside a scope, its children', () => {
    const target = setup(STACK);
    // qb and qa both target q at the page.
    click(target, NESTED, alt);
    expect(selection(target)).toEqual(['q']);
    click(target, NESTED, alt);
    expect(selection(target)).toEqual(['e']);
    click(target, NESTED, alt);
    expect(selection(target)).toEqual(['q']);
    // In the scope q the stack is qb, qa; e is outside the scope.
    enter(target, 'q');
    click(target, NESTED, alt);
    expect(selection(target)).toEqual(['qb']);
    click(target, NESTED, alt);
    expect(selection(target)).toEqual(['qa']);
    click(target, NESTED, alt);
    expect(selection(target)).toEqual(['qb']);
    expect(scope(target)).toBe('q');
  });

  it('an Alt-click outside the scope leaves it at release and cycles by the page rule', () => {
    const target = setup(STACK);
    enter(target, 'q');
    const events = record(target);
    pointer(target, 'pointerdown', FOUR, alt);
    expect(scope(target)).toBe('q');
    pointer(target, 'pointerup', FOUR, alt);
    expect(scope(target)).toBeNull();
    expect(selection(target)).toEqual(['d']);
    expect(events).toEqual(['scope', 'selection']);
  });

  it('an Alt-click on empty canvas clears the selection', () => {
    const target = setup(STACK);
    select(target, ['a']);
    click(target, at(300, 300), alt);
    expect(selection(target)).toEqual([]);
  });

  it('Alt-drag still duplicates and selects the copy, one undo step', () => {
    const target = setup(STACK);
    drag(target, FOUR, at(45, 35), alt);
    expect(selection(target)).toEqual(['n1']);
    expect(nodeOf(target, 'n1').frame).toEqual(f(40, 30, 40, 40));
    expect(nodeOf(target, 'd').frame).toEqual(f(30, 30, 40, 40));
    expect(undoDepth(target)).toBe(1);
  });

  it('Alt-drag inside a scope keeps it; from outside, the scope is left at release', () => {
    const target = setup(STACK);
    enter(target, 'q');
    drag(target, NESTED, at(126, 25), alt);
    expect(selection(target)).toEqual(['n1']);
    expect(nodeOf(target, 'n1')).toMatchObject({ parent: 'q', frame: f(11, 10, 30, 30) });
    expect(scope(target)).toBe('q');
    drag(target, FOUR, at(36, 35), alt);
    expect(selection(target)).toEqual(['n2']);
    expect(scope(target)).toBeNull();
  });

  it('a cancelled Alt-drag from outside the scope keeps the scope and the selection', () => {
    const target = setup(STACK);
    enter(target, 'q');
    select(target, ['qa']);
    pointer(target, 'pointerdown', FOUR, alt);
    pointer(target, 'pointermove', at(40, 40), alt);
    expect(selection(target)).toEqual(['n1']);
    expect(key(target, 'Escape', alt)).toEqual(consumed);
    expect(scope(target)).toBe('q');
    expect(selection(target)).toEqual(['qa']);
    expect(target.query({ type: 'node', id: 'n1' })).toBeNull();
  });
});

describe('M2-A09 snapping inside a scope', () => {
  const pageBox = (target: Editor, id: string) =>
    boundsOf(target.query({ type: 'document' }), [id]);

  it('the scope’s children are candidates and the page’s other nodes are not', () => {
    // In the scope g, ga's left edge 147 snaps to gg's left edge 150; r is no candidate.
    const target = setup(FIXTURE, true);
    enter(target, 'g');
    drag(target, P.ga, at(P.ga.x + 47, P.ga.y));
    expect(pageBox(target, 'ga')).toEqual(f(150, 0, 40, 40));
    ok(target, { type: 'undo' });
    drag(target, P.ga, at(P.ga.x + 457, P.ga.y));
    expect(pageBox(target, 'ga')).toEqual(f(557, 0, 40, 40));
    expect(scope(target)).toBe('g');
  });

  it('at the page the same moves snap the other way', () => {
    // ga selected directly: the page's children are candidates (r's left edge 600), not gg.
    const target = setup(FIXTURE, true);
    select(target, ['ga']);
    drag(target, P.ga, at(P.ga.x + 47, P.ga.y));
    expect(pageBox(target, 'ga')).toEqual(f(147, 0, 40, 40));
    ok(target, { type: 'undo' });
    select(target, ['ga']);
    drag(target, P.ga, at(P.ga.x + 457, P.ga.y));
    expect(pageBox(target, 'ga')).toEqual(f(560, 0, 40, 40));
  });

  it('in a mask-group scope the source is excluded and the other children are candidates', () => {
    const target = setup(FIXTURE, true);
    enter(target, 'mg');
    // mr's left edge 2 would snap to the source's left edge 0.
    pointer(target, 'pointerdown', P.mr);
    pointer(target, 'pointermove', at(P.mr.x - 8, P.mr.y));
    expect(target.query({ type: 'snap' })).toBeNull();
    pointer(target, 'pointerup', at(P.mr.x - 8, P.mr.y));
    expect(nodeOf(target, 'mr').frame).toEqual(f(2, 10, 30, 30));
    ok(target, { type: 'undo' });
    // mr's right edge 58 snaps to ms's left edge 60.
    pointer(target, 'pointerdown', P.mr);
    pointer(target, 'pointermove', at(P.mr.x + 18, P.mr.y));
    expect(target.query({ type: 'snap' })).toEqual({
      guides: [{ a: at(60, 310), b: at(60, 390) }],
      gaps: [],
      angle: null,
    });
    pointer(target, 'pointerup', at(P.mr.x + 18, P.mr.y));
    expect(nodeOf(target, 'mr').frame).toEqual(f(30, 10, 30, 30));
    expect(scope(target)).toBe('mg');
  });

  it('an Alt-drag from outside the scope snaps with the page’s candidates', () => {
    // The copy of r at 582..602 snaps its right edge to the original's left edge 600, a page
    // child: a candidate at the page, not in the session scope gg.
    const target = setup(FIXTURE, true);
    enter(target, 'gg');
    drag(target, P.r, at(P.r.x - 18, P.r.y), alt);
    expect(nodeOf(target, 'n1').frame).toEqual(f(580, 0, 20, 20));
    expect(scope(target)).toBeNull();
  });
});
