import { serializeDocument, type DocumentV6, type Frame } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type DocumentCommand,
  type Editor,
  type EditorEvent,
  type Modifiers,
  type PagePoint,
  type PathAnchorRef,
  type PathEditOverlay,
} from '../../packages/editor-core/src/index.js';
// Source imports: the tree geometry and the flattening are package-internal.
import { apply, localTransform, multiply } from '../../packages/editor-core/src/geometry.js';
import { cubicAt, cubicSegments } from '../../packages/editor-core/src/hit-test.js';
import { documentTree, spaceOf } from '../../packages/editor-core/src/tree.js';

// MVP M3-U2, M3-A08 to M3-A11 (M3 contract, sections 4, 5 and 5.1): path edit mode and its
// session commands, entry and exit, anchor retention, the `pathOverlay` query, the select
// tool's edit-mode targets, anchor and handle drags, Alt, marquee and snapping, and the keymap
// routing of `nudge`, `selectAll`, `delete`, `enterScope` and `exitScope`; the U1 review
// follow-up F2 (a drag ending at its press point records no step); M3-U3, the rest of M3-A09:
// the segment double-click, `delete` and `togglePathClosed` in edit mode. A drag is compared
// with its stated command run on a twin editor, so the values are the binary64 evaluation of
// the contract's formulas (M3-Q13); literal where the arithmetic is exact.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
/** The default path stroke in its v2 form, without the v6 `dash` (M4 contract, section 2.1). */
const V2_PATH_STROKE = { color: black, width: 1, cap: 'butt', join: 'miter', miterLimit: 4 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const shift: Modifiers = { ...none, shift: true };
const alt: Modifiers = { ...none, alt: true };
const ctrl: Modifiers = { ...none, ctrl: true };
const meta: Modifiers = { ...none, meta: true };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });
const ref = (subpath: number, anchor: number): PathAnchorRef => ({ subpath, anchor });

type Loose = Record<string, unknown> & { id: string };
type Verb = 'move' | 'line' | 'cubic' | 'close';

function base(id: string, parent: string, frame: Frame, rotation = 0, visible = true) {
  return { id, name: id, parent, frame, rotation, constraints: START, opacity: 1, visible };
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

function path(
  id: string,
  parent: string,
  frame: Frame,
  [verbs, points]: [Verb[], number[]],
  options: { rotation?: number; fill?: boolean; visible?: boolean } = {},
): Loose {
  return {
    ...base(id, parent, frame, options.rotation ?? 0, options.visible ?? true),
    type: 'path',
    path: { verbs, points, fillRule: 'nonzero' },
    fill: options.fill === false ? null : black,
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

/** An implicitly closed triangle: (0, 0), (1, 0), (1, 1). */
const TRIANGLE: [Verb[], number[]] = [
  ['move', 'line', 'line', 'close'],
  [0, 0, 1, 0, 1, 1],
];
/**
 * An open path of two cubics: A0 (0, 0.5), A1 (0.5, 0.5) with mirrored handles in (0.25, 0) and
 * out (0.75, 1), A2 (1, 0.5).
 */
const CURVE: [Verb[], number[]] = [
  ['move', 'cubic', 'cubic'],
  [0, 0.5, 0.1, 0.5, 0.25, 0, 0.5, 0.5, 0.75, 1, 0.9, 0.5, 1, 0.5],
];
/** One cubic whose `out` handle at A0 has length zero (`c1 = A0`, as the path tool writes it). */
const ZERO: [Verb[], number[]] = [
  ['move', 'cubic'],
  [0, 0, 0, 0, 0.5, 1, 1, 1],
];
const ARC: [Verb[], number[]] = [
  ['move', 'cubic'],
  [0, 0, 0.25, 0, 0.75, 1, 1, 1],
];

/**
 * Page p1: the page-root `tri` (fill) and `curve` (no fill), the rectangle `r`, `dot`
 * (`move, close`), `zero`, the hidden `hid`, `gp` in the group `g`, the rotated `rot`, and `np`
 * in the rotated group `G` inside the rotated frame `F`; page p2: the path `other`. Empty canvas
 * at (50, 50).
 */
const FIXTURE = doc(
  [
    ['p1', ['tri', 'curve', 'r', 'dot', 'zero', 'hid', 'g', 'rot', 'F']],
    ['p2', ['other']],
  ],
  [
    path('tri', 'p1', f(100, 100, 100, 100), TRIANGLE),
    path('curve', 'p1', f(300, 100, 100, 100), CURVE, { fill: false }),
    rect('r', 'p1', f(500, 100, 50, 50)),
    path('dot', 'p1', f(700, 100, 0, 0), [
      ['move', 'close'],
      [0, 0],
    ]),
    path('zero', 'p1', f(500, 300, 100, 100), ZERO, { fill: false }),
    path('hid', 'p1', f(100, 500, 100, 100), TRIANGLE, { visible: false }),
    container('group', 'g', 'p1', ['gp'], f(300, 300, 100, 100)),
    path(
      'gp',
      'g',
      f(0, 0, 100, 100),
      [
        ['move', 'line'],
        [0, 0, 1, 1],
      ],
      { fill: false },
    ),
    path('rot', 'p1', f(100, 700, 100, 50), ARC, { rotation: 0.3, fill: false }),
    container('frame', 'F', 'p1', ['G'], f(700, 600, 200, 200), 0.2),
    container('group', 'G', 'F', ['np'], f(20, 20, 100, 100), 0.4),
    path('np', 'G', f(0, 0, 100, 100), ARC, { rotation: 0.1, fill: false }),
    path('other', 'p2', f(0, 0, 10, 10), TRIANGLE),
  ],
);

/** The snapping fixture: the triangle `sp` (0, 0), (128, 0), (128, 128) and `r` x [256, 288]. */
const SNAP = doc(
  [['p1', ['sp', 'r']]],
  [path('sp', 'p1', f(0, 0, 128, 128), TRIANGLE), rect('r', 'p1', f(256, 64, 32, 32))],
);

const EMPTY = at(50, 50);

function editor(document: unknown = FIXTURE, snapping = false): Editor {
  const target = createEditor({ ids: createCounterIdSource('n'), document });
  if (!snapping) ok(target, { type: 'setSnapping', enabled: false });
  return target;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

/** An editor in edit mode on `id` with the anchor selection `anchors`. */
function editing(id: string, anchors: PathAnchorRef[] = [], document: unknown = FIXTURE): Editor {
  const target = editor(document);
  ok(target, { type: 'enterPathEdit', id });
  if (anchors.length > 0) ok(target, { type: 'setPathSelection', anchors });
  return target;
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
const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const selection = (target: Editor) => target.query({ type: 'selection' });
const editOf = (target: Editor) => target.query({ type: 'pathEdit' });
const anchorsOf = (target: Editor) => editOf(target)?.anchors;
const overlayOf = (target: Editor) => target.query({ type: 'pathOverlay' });
const undoDepth = (target: Editor) => target.query({ type: 'history' }).undoDepth;
const consumed = { ok: true, ids: [], consumed: true };

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

/** The text of `document` after `commands` run on a twin editor: the stated command's result. */
function twin(document: unknown, commands: DocumentCommand[]): string {
  const target = editor(document);
  for (const command of commands) ok(target, command);
  return text(target);
}

/** One gesture with byte-identical undo and redo (M3 contract, section 5). */
function expectOneStep(target: Editor, before: string, steps = 1) {
  expect(undoDepth(target)).toBe(steps);
  const after = text(target);
  ok(target, { type: 'undo' });
  expect(text(target)).toBe(before);
  ok(target, { type: 'redo' });
  expect(text(target)).toBe(after);
}

/** The page point of a node-local point through the node's chain `C`. */
function pagePoint(document: DocumentV6, id: string, x: number, y: number): PagePoint {
  const node = document.nodes[id]!;
  const space = spaceOf(documentTree(document), node.parent);
  return apply(multiply(space.matrix, localTransform(node.frame, node.rotation)), x, y);
}

const anchor = (
  point: PagePoint,
  handles: { in?: PagePoint; out?: PagePoint } = {},
  selected = false,
  mirrored = false,
) => ({ point, in: handles.in ?? null, out: handles.out ?? null, selected, mirrored });

// Page points of `tri` and `curve`.
const T0 = at(100, 100);
const T1 = at(200, 100);
const T2 = at(200, 200);
const C0 = at(300, 150);
const C1 = at(350, 150);
const C2 = at(400, 150);
const C1_IN = at(325, 100);
const C1_OUT = at(375, 200);

describe('M3-A08 edit mode entry', () => {
  it('enters by double-click on a page-root path: selection [id], select tool, handles null', () => {
    const target = editor();
    const events = record(target);
    // The host's double-click: two clicks, then the double-click event.
    click(target, at(150, 100));
    click(target, at(150, 100));
    events.length = 0;
    expect(doubleclick(target, at(150, 100))).toEqual(consumed);
    expect(editOf(target)).toEqual({ id: 'tri', anchors: [] });
    expect(target.getSnapshot().pathEdit).toEqual({ id: 'tri', anchors: [] });
    expect(Object.isFrozen(editOf(target))).toBe(true);
    expect(selection(target)).toEqual(['tri']);
    expect(target.query({ type: 'tool' })).toBe('select');
    expect(target.query({ type: 'handles' })).toBeNull();
    expect(target.query({ type: 'scope' })).toBeNull();
    expect(events).toEqual(['pathEdit']);
    expect(undoDepth(target)).toBe(0);
  });

  it('reaches a path inside a group by double-clicking twice; the scope is kept', () => {
    const target = editor();
    doubleclick(target, at(350, 350));
    expect(target.query({ type: 'scope' })).toBe('g');
    expect(selection(target)).toEqual(['gp']);
    expect(editOf(target)).toBeNull();
    doubleclick(target, at(350, 350));
    expect(editOf(target)).toEqual({ id: 'gp', anchors: [] });
    expect(target.query({ type: 'scope' })).toBe('g');
    // Escape exits edit mode only; a further Escape runs the M2 exitScope.
    expect(key(target, 'Escape')).toEqual(consumed);
    expect(editOf(target)).toBeNull();
    expect(selection(target)).toEqual(['gp']);
    expect(target.query({ type: 'scope' })).toBe('g');
    key(target, 'Escape');
    expect(selection(target)).toEqual(['g']);
    expect(target.query({ type: 'scope' })).toBeNull();
  });

  it('enters by Enter on a single selected path, and Enter exits again', () => {
    const target = editor();
    ok(target, { type: 'setSelection', ids: ['curve'] });
    expect(key(target, 'Enter')).toEqual(consumed);
    expect(editOf(target)).toEqual({ id: 'curve', anchors: [] });
    expect(key(target, 'Enter')).toEqual(consumed);
    expect(editOf(target)).toBeNull();
    expect(selection(target)).toEqual(['curve']);
    // Two paths selected: Enter does nothing.
    ok(target, { type: 'setSelection', ids: ['curve', 'tri'] });
    expect(key(target, 'Enter')).toEqual(consumed);
    expect(editOf(target)).toBeNull();
  });

  it('enterPathEdit: cancels a gesture, activates select, raises tool, selection, pathEdit', () => {
    const target = editor();
    const before = text(target);
    ok(target, { type: 'setSelection', ids: ['r'] });
    pointer(target, 'pointerdown', at(520, 120));
    pointer(target, 'pointermove', at(530, 120));
    expect(text(target)).not.toBe(before);
    ok(target, { type: 'setTool', tool: 'rectangle' });
    expect(text(target)).toBe(before);
    pointer(target, 'pointerdown', at(800, 800));
    pointer(target, 'pointermove', at(820, 820));
    const events = record(target);
    expect(target.execute({ type: 'enterPathEdit', id: 'tri' })).toEqual({ ok: true, ids: [] });
    expect(events).toEqual(['document:gesture-cancel', 'tool', 'selection', 'pathEdit']);
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'tool' })).toBe('select');
    expect(selection(target)).toEqual(['tri']);
    // Again on the edited path: a no-op without events.
    events.length = 0;
    ok(target, { type: 'setPathSelection', anchors: [ref(0, 1)] });
    events.length = 0;
    ok(target, { type: 'enterPathEdit', id: 'tri' });
    expect(events).toEqual([]);
    expect(anchorsOf(target)).toEqual([ref(0, 1)]);
    // Another path: selection, then pathEdit with an empty anchor selection.
    ok(target, { type: 'enterPathEdit', id: 'curve' });
    expect(events).toEqual(['selection', 'pathEdit']);
    expect(editOf(target)).toEqual({ id: 'curve', anchors: [] });
  });

  it('enters a hidden path by command only, and a nested one at any depth', () => {
    const target = editor();
    expect(doubleclick(target, at(150, 550)).consumed).toBe(false);
    expect(editOf(target)).toBeNull();
    ok(target, { type: 'enterPathEdit', id: 'hid' });
    expect(editOf(target)).toEqual({ id: 'hid', anchors: [] });
    ok(target, { type: 'enterPathEdit', id: 'np' });
    expect(selection(target)).toEqual(['np']);
    expect(target.query({ type: 'scope' })).toBeNull();
  });

  it('fails with the section 3.5 codes in order', () => {
    const target = editor();
    const run = (command: unknown) => target.execute(command as Command);
    expect(run({ type: 'enterPathEdit' })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/id',
    });
    expect(run({ type: 'enterPathEdit', id: 'nope' })).toEqual({
      ok: false,
      code: 'editor.unknown-node',
    });
    expect(run({ type: 'enterPathEdit', id: 'other' })).toEqual({
      ok: false,
      code: 'editor.unknown-node',
    });
    expect(run({ type: 'enterPathEdit', id: 'r' })).toEqual({
      ok: false,
      code: 'editor.not-a-path',
    });
    expect(run({ type: 'enterPathEdit', id: 'g' })).toEqual({
      ok: false,
      code: 'editor.not-a-path',
    });
    // setPathSelection: invalid-command before no-path-edit before invalid-path-ref.
    expect(run({ type: 'setPathSelection', anchors: [ref(0, 0)] })).toEqual({
      ok: false,
      code: 'editor.no-path-edit',
    });
    expect(run({ type: 'setPathSelection', anchors: [ref(0, 0), ref(0, 0)] })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/anchors',
    });
    expect(run({ type: 'setPathSelection', anchors: [{ subpath: 0 }] })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/anchors/0/anchor',
    });
    expect(run({ type: 'setPathSelection', anchors: 'all' })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/anchors',
    });
    ok(target, { type: 'enterPathEdit', id: 'tri' });
    expect(run({ type: 'setPathSelection', anchors: [ref(0, 2), ref(0, 3), ref(1, 0)] })).toEqual({
      ok: false,
      code: 'editor.invalid-path-ref',
      path: '/anchors/1',
    });
    expect(run({ type: 'setPathSelection', anchors: [ref(0, 0.5)] })).toEqual({
      ok: false,
      code: 'editor.invalid-path-ref',
      path: '/anchors/0',
    });
    expect(run({ type: 'setPathSelection', anchors: [ref(0, -0), ref(0, 0)] })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/anchors',
    });
    expect(anchorsOf(target)).toEqual([]);
  });

  it('stores the anchor selection canonical, raising pathEdit only on change', () => {
    const target = editing('tri');
    const events = record(target);
    ok(target, { type: 'setPathSelection', anchors: [ref(0, 2), ref(0, -0)] });
    const anchors = anchorsOf(target)!;
    expect(anchors).toEqual([ref(0, 0), ref(0, 2)]);
    expect(Object.is(anchors[0]!.anchor, 0)).toBe(true);
    ok(target, { type: 'setPathSelection', anchors: [ref(0, 0), ref(0, 2)] });
    expect(events).toEqual(['pathEdit']);
    ok(target, { type: 'setPathSelection', anchors: [] });
    expect(anchorsOf(target)).toEqual([]);
  });

  it('accepts editor.no-path-edit from extension results', () => {
    const target = createEditor({
      document: FIXTURE,
      extensions: [
        {
          id: 'x',
          commands: [{ id: 'x.a', run: () => ({ ok: false, code: 'editor.no-path-edit' }) }],
        },
      ],
    });
    expect(target.execute({ type: 'runCommand', id: 'x.a' })).toEqual({
      ok: false,
      code: 'editor.no-path-edit',
    });
  });
});

describe('M3-A08 edit mode exit', () => {
  it('exitPathEdit keeps the selection; a no-op outside edit mode', () => {
    const target = editing('tri', [ref(0, 1)]);
    const events = record(target);
    ok(target, { type: 'exitPathEdit' });
    expect(editOf(target)).toBeNull();
    expect(selection(target)).toEqual(['tri']);
    ok(target, { type: 'exitPathEdit' });
    expect(events).toEqual(['pathEdit']);
  });

  it('a press on another node ends edit mode and runs the M2 rules in the same input', () => {
    const target = editing('tri');
    const before = text(target);
    const events = record(target);
    drag(target, at(520, 120), at(530, 125));
    expect(editOf(target)).toBeNull();
    expect(selection(target)).toEqual(['r']);
    expect(target.query({ type: 'node', id: 'r' })!.frame).toEqual(f(510, 105, 50, 50));
    expect(events.slice(0, 2)).toEqual(['pathEdit', 'selection']);
    expectOneStep(target, before);
  });

  it('a press near a hidden resize handle of the path acts on the node hit, never resizes', () => {
    // The bottom-right handle of `tri` sits on its anchor; the right edge handle (200, 150)
    // is on segment 1. The bottom handle (150, 200) is empty canvas in edit mode.
    const target = editing('tri');
    const before = text(target);
    drag(target, at(150, 200), at(150, 260));
    expect(text(target)).toBe(before);
    expect(editOf(target)).toEqual({ id: 'tri', anchors: [] });
    // The rotate zone outside the bottom-left corner: empty canvas too.
    drag(target, at(92, 208), at(60, 240));
    expect(text(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
  });

  it('a click on empty canvas clears the selection and ends edit mode; Shift keeps it', () => {
    const target = editing('tri');
    const events = record(target);
    click(target, EMPTY);
    expect(selection(target)).toEqual([]);
    expect(editOf(target)).toBeNull();
    // The marquee overlay comes and goes around the click.
    expect(events).toEqual(['overlay', 'selection', 'pathEdit', 'overlay']);
    ok(target, { type: 'enterPathEdit', id: 'tri' });
    click(target, EMPTY, shift);
    expect(editOf(target)).toBeNull();
    expect(selection(target)).toEqual(['tri']);
  });

  it('a click on empty page canvas inside a scope leaves the scope, as M2', () => {
    const target = editor();
    doubleclick(target, at(350, 350));
    doubleclick(target, at(350, 350));
    expect(editOf(target)?.id).toBe('gp');
    click(target, EMPTY);
    expect(editOf(target)).toBeNull();
    expect(selection(target)).toEqual([]);
    expect(target.query({ type: 'scope' })).toBeNull();
  });

  it('ends on a selection change, another tool, another scope, a page switch and a load', () => {
    const cases: [string, (target: Editor) => void][] = [
      ['setSelection', (t) => ok(t, { type: 'setSelection', ids: ['r'] })],
      ['setSelection []', (t) => ok(t, { type: 'setSelection', ids: [] })],
      ['setTool', (t) => ok(t, { type: 'setTool', tool: 'path' })],
      ['setScope', (t) => ok(t, { type: 'setScope', id: 'g' })],
      ['setActivePage', (t) => ok(t, { type: 'setActivePage', id: 'p2' })],
      ['loadDocument', (t) => ok(t, { type: 'loadDocument', document: FIXTURE })],
      ['deleteNodes', (t) => ok(t, { type: 'deleteNodes', ids: ['tri'] })],
      ['cut', (t) => ok(t, { type: 'cut' })],
      [
        'paste',
        (t) => {
          ok(t, { type: 'copy' });
          ok(t, { type: 'paste' });
        },
      ],
      ['Mod+D', (t) => key(t, 'd', ctrl)],
      ['Mod+G', (t) => key(t, 'g', ctrl)],
    ];
    for (const [label, change] of cases) {
      const target = editing('tri', [ref(0, 1)]);
      const events = record(target);
      change(target);
      expect(editOf(target), label).toBeNull();
      // The pathEdit event follows the events of its cause.
      expect(events[events.length - 1], label).toBe('pathEdit');
    }
  });

  it('survives setTool select, setScope to the same value, pointercancel and blur', () => {
    const target = editing('tri', [ref(0, 1)]);
    ok(target, { type: 'setTool', tool: 'select' });
    ok(target, { type: 'setScope', id: null });
    ok(target, { type: 'setActivePage', id: 'p1' });
    expect(input(target, { kind: 'pointercancel', modifiers: none })).toEqual({
      ok: true,
      ids: [],
      consumed: false,
    });
    // An M2-I4 blur: pointercancel, then the Space key-up.
    input(target, { kind: 'pointercancel', modifiers: none });
    input(target, { kind: 'keyup', key: ' ', code: 'Space', modifiers: none });
    expect(editOf(target)).toEqual({ id: 'tri', anchors: [ref(0, 1)] });
  });

  it('a double-click on a container in edit mode raises scope, selection, then pathEdit', () => {
    const target = editing('tri', [ref(0, 1)]);
    const events = record(target);
    expect(doubleclick(target, at(350, 350))).toEqual(consumed);
    expect(events).toEqual(['scope', 'selection', 'pathEdit']);
    expect(editOf(target)).toBeNull();
    expect(target.query({ type: 'scope' })).toBe('g');
    expect(selection(target)).toEqual(['gp']);
    // setScope alone: scope, then pathEdit.
    ok(target, { type: 'enterPathEdit', id: 'gp' });
    events.length = 0;
    ok(target, { type: 'setScope', id: null });
    expect(events).toEqual(['scope', 'pathEdit']);
    expect(selection(target)).toEqual(['gp']);
  });

  it('enterPathEdit on the edited path after setScope in one call keeps edit mode', () => {
    const target = createEditor({
      ids: createCounterIdSource('n'),
      document: FIXTURE,
      extensions: [
        {
          id: 'x',
          commands: [
            {
              id: 'x.reenter',
              run: (_args, api) => {
                api.execute({ type: 'setScope', id: 'g' });
                api.execute({ type: 'enterPathEdit', id: 'gp' });
                return { ok: true, ids: [] };
              },
            },
          ],
        },
      ],
    });
    ok(target, { type: 'enterPathEdit', id: 'gp' });
    ok(target, { type: 'runCommand', id: 'x.reenter' });
    expect(editOf(target)).toEqual({ id: 'gp', anchors: [] });
    expect(target.query({ type: 'scope' })).toBe('g');
  });

  it('ends when undo or redo takes the node away; events in order', () => {
    const target = editor();
    const [id] = ok(target, { type: 'createPath', verbs: ['move', 'line'], points: [0, 0, 9, 9] });
    ok(target, { type: 'enterPathEdit', id: id! });
    const events = record(target);
    ok(target, { type: 'undo' });
    expect(editOf(target)).toBeNull();
    expect(events).toEqual(['document:undo', 'selection', 'pathEdit']);
    ok(target, { type: 'redo' });
    expect(selection(target)).toEqual([]);
  });
});

describe('M3-A08 retention, handles off and consumed double-clicks', () => {
  it('keeps the anchor selection across a move, its undo and redo', () => {
    const target = editing('tri', [ref(0, 1), ref(0, 2)]);
    ok(target, {
      type: 'movePathAnchors',
      id: 'tri',
      anchors: [ref(0, 1)],
      dx: 10,
      dy: 0,
    });
    expect(anchorsOf(target)).toEqual([ref(0, 1), ref(0, 2)]);
    ok(target, { type: 'undo' });
    ok(target, { type: 'redo' });
    expect(anchorsOf(target)).toEqual([ref(0, 1), ref(0, 2)]);
  });

  it('clears it when the structure changes (the implicit-form merge, section 8) and back', () => {
    const target = editing('tri', [ref(0, 2)]);
    const events = record(target);
    // A2 exactly onto A0: the stored data reads as the explicit form with two anchors.
    ok(target, { type: 'movePathAnchors', id: 'tri', anchors: [ref(0, 2)], dx: -100, dy: -100 });
    expect(overlayOf(target)!.subpaths[0]!.anchors).toHaveLength(2);
    expect(anchorsOf(target)).toEqual([]);
    expect(events).toEqual(['document:command', 'pathEdit']);
    ok(target, { type: 'setPathSelection', anchors: [ref(0, 1)] });
    ok(target, { type: 'undo' });
    expect(anchorsOf(target)).toEqual([]);
    expect(editOf(target)?.id).toBe('tri');
  });

  it('keeps resize, rotate, Alt-drag duplication and overlap cycling off', () => {
    const target = editing('tri');
    const before = text(target);
    // Alt-drag and Alt-click on the fill: an anchor marquee, never a duplicate or a cycle.
    drag(target, at(180, 120), at(190, 130), alt);
    click(target, at(180, 120), alt);
    expect(text(target)).toBe(before);
    expect(Object.keys(target.query({ type: 'document' }).nodes)).toHaveLength(13);
    expect(selection(target)).toEqual(['tri']);
    expect(editOf(target)).toEqual({ id: 'tri', anchors: [] });
    expect(undoDepth(target)).toBe(0);
  });

  it('consumes a double-click on an anchor, a visible handle and the fill', () => {
    const target = editing('curve', [ref(0, 1)]);
    const fill = editing('tri');
    const before = text(target);
    for (const point of [C1, C1_OUT]) {
      expect(doubleclick(target, point)).toEqual(consumed);
    }
    expect(doubleclick(fill, at(180, 120))).toEqual(consumed);
    expect(text(target)).toBe(before);
    expect(editOf(target)).toEqual({ id: 'curve', anchors: [ref(0, 1)] });
    expect(editOf(fill)).toEqual({ id: 'tri', anchors: [] });
    // On another path a double-click enters it.
    expect(doubleclick(target, at(150, 100))).toEqual(consumed);
    expect(editOf(target)).toEqual({ id: 'tri', anchors: [] });
  });
});

describe('M3-A09 targets and anchor selection through input', () => {
  it('picks anchors over handles, handles over segments, segments over the fill', () => {
    const target = editing('curve', [ref(0, 1)]);
    // A press 3 px from C1 and 4.2 px from no handle: the anchor.
    click(target, at(353, 150));
    expect(anchorsOf(target)).toEqual([ref(0, 1)]);
    // The out handle (375, 200) is visible; a press there drags it, not segment 1.
    const before = text(target);
    drag(target, at(376, 199), at(386, 199));
    expect(text(target)).toBe(
      twin(FIXTURE, [
        {
          type: 'setPathHandle',
          id: 'curve',
          anchor: ref(0, 1),
          side: 'out',
          to: at(385, 200),
          mirror: true,
        },
      ]),
    );
    expectOneStep(target, before);
    // A press on segment 0 (now with c2 = (315, 100), at t = 0.5) selects both its ends.
    click(target, at(315.625, 131.25));
    expect(anchorsOf(target)).toEqual([ref(0, 0), ref(0, 1)]);
    // Inside the triangle and away from its edges: the fill, which clears the anchors.
    const tri = editing('tri', [ref(0, 1)]);
    click(tri, at(180, 120));
    expect(anchorsOf(tri)).toEqual([]);
    expect(editOf(tri)?.id).toBe('tri');
  });

  it('a zero-length handle never hides its anchor; ties go to the lower ref', () => {
    const target = editing('zero', [ref(0, 0)]);
    const overlay = overlayOf(target)!;
    expect(overlay.subpaths[0]!.anchors[0]!.out).toEqual(at(500, 300));
    // The handle sits on A0; a press there is an anchor press that drags A0.
    drag(target, at(500, 300), at(510, 300));
    expect(text(target)).toBe(
      twin(FIXTURE, [{ type: 'movePathAnchors', id: 'zero', anchors: [ref(0, 0)], dx: 10, dy: 0 }]),
    );
    // `dot` and a tie: the lower ref wins between two anchors at equal distance.
    const tie = editor(
      doc(
        [['p1', ['two']]],
        [
          path(
            'two',
            'p1',
            f(0, 0, 10, 0),
            [
              ['move', 'line'],
              [0, 0, 1, 0],
            ],
            { fill: false },
          ),
        ],
      ),
    );
    ok(tie, { type: 'enterPathEdit', id: 'two' });
    click(tie, at(5, 0));
    // Both anchors are 5 away (within 6): anchor 0.
    expect(anchorsOf(tie)).toEqual([ref(0, 0)]);
  });

  it('Shift toggles an anchor and starts no drag; Shift on a segment adds both ends', () => {
    const target = editing('tri', [ref(0, 0)]);
    const before = text(target);
    click(target, T1, shift);
    expect(anchorsOf(target)).toEqual([ref(0, 0), ref(0, 1)]);
    // A Shift-drag is ignored: no move, no marquee.
    pointer(target, 'pointerdown', T0, shift);
    pointer(target, 'pointermove', at(140, 140), shift);
    expect(target.query({ type: 'overlay' })).toBeNull();
    pointer(target, 'pointerup', at(140, 140), shift);
    expect(text(target)).toBe(before);
    expect(anchorsOf(target)).toEqual([ref(0, 1)]);
    // Segment 1 (T1 to T2) with Shift adds T2.
    click(target, at(200, 150), shift);
    expect(anchorsOf(target)).toEqual([ref(0, 1), ref(0, 2)]);
    // The implicit closing segment 2 (T2 to T0).
    click(target, at(150, 150), shift);
    expect(anchorsOf(target)).toEqual([ref(0, 0), ref(0, 1), ref(0, 2)]);
  });

  it('a Shift-drag on a segment adds both ends and drags the union in one step', () => {
    const target = editing('tri', [ref(0, 0)]);
    const before = text(target);
    // Segment 1 runs from T1 to T2.
    drag(target, at(200, 150), at(210, 150), shift);
    expect(anchorsOf(target)).toEqual([ref(0, 0), ref(0, 1), ref(0, 2)]);
    expect(text(target)).toBe(
      twin(FIXTURE, [
        {
          type: 'movePathAnchors',
          id: 'tri',
          anchors: [ref(0, 0), ref(0, 1), ref(0, 2)],
          dx: 10,
          dy: 0,
        },
      ]),
    );
    expectOneStep(target, before);
  });

  it('ties: in before out at one anchor, the lower segment between two', () => {
    // A1 (50, 0) with handles in (45, 100) and out (55, 100); (50, 100) is 5 from both.
    const handles = editor(
      doc(
        [['p1', ['h']]],
        [
          path(
            'h',
            'p1',
            f(0, 0, 100, 100),
            [
              ['move', 'cubic', 'cubic'],
              [0, 0, 0, 0, 0.45, 1, 0.5, 0, 0.55, 1, 1, 0, 1, 0],
            ],
            { fill: false },
          ),
        ],
      ),
    );
    ok(handles, { type: 'enterPathEdit', id: 'h' });
    ok(handles, { type: 'setPathSelection', anchors: [ref(0, 1)] });
    const start = handles.query({ type: 'document' });
    drag(handles, at(50, 100), at(50, 110));
    expect(text(handles)).toBe(
      twin(start, [
        { type: 'setPathHandle', id: 'h', anchor: ref(0, 1), side: 'in', to: at(45, 110) },
      ]),
    );
    // A stroke of width 20: (192, 108) is 8 from segments 0 and 1 and 11.3 from T1.
    const wide = editor(
      doc(
        [['p1', ['w']]],
        [
          {
            ...path('w', 'p1', f(100, 100, 100, 100), TRIANGLE),
            stroke: { ...V2_PATH_STROKE, width: 20 },
          },
        ],
      ),
    );
    ok(wide, { type: 'enterPathEdit', id: 'w' });
    click(wide, at(192, 108));
    expect(anchorsOf(wide)).toEqual([ref(0, 0), ref(0, 1)]);
  });

  it('on a filled path, a press on the edge within the segment radius is the segment', () => {
    const target = editing('tri');
    // 3 below the top edge and inside the fill.
    click(target, at(150, 103));
    expect(anchorsOf(target)).toEqual([ref(0, 0), ref(0, 1)]);
  });

  it('a click on an anchor of a larger selection selects only it', () => {
    const target = editing('tri', [ref(0, 0), ref(0, 1), ref(0, 2)]);
    click(target, T1);
    expect(anchorsOf(target)).toEqual([ref(0, 1)]);
    expect(undoDepth(target)).toBe(0);
  });

  it('marquee: the anchors inside the closed box, Shift adds; the marquee overlay', () => {
    const target = editing('tri');
    pointer(target, 'pointerdown', at(180, 90));
    pointer(target, 'pointermove', at(200, 200));
    expect(target.query({ type: 'overlay' })).toEqual({
      kind: 'marquee',
      frame: f(180, 90, 20, 110),
    });
    pointer(target, 'pointerup', at(200, 200));
    // The box's edge holds T1 and T2 (closed box).
    expect(anchorsOf(target)).toEqual([ref(0, 1), ref(0, 2)]);
    expect(target.query({ type: 'overlay' })).toBeNull();
    drag(target, at(90, 90), at(110, 110), shift);
    expect(anchorsOf(target)).toEqual([ref(0, 0), ref(0, 1), ref(0, 2)]);
    drag(target, at(90, 90), at(110, 110));
    expect(anchorsOf(target)).toEqual([ref(0, 0)]);
    expect(undoDepth(target)).toBe(0);
  });
});

describe('M3-A09 anchor and handle drags through input', () => {
  it('drags the anchor selection by the page delta (exact values), one step', () => {
    const target = editing('tri', [ref(0, 0)]);
    const before = text(target);
    click(target, T1, shift);
    drag(target, at(201, 101), at(211, 101));
    const node = target.query({ type: 'node', id: 'tri' })!;
    expect(node.frame).toEqual(f(110, 100, 100, 100));
    expect(node.type === 'path' && node.path.points).toEqual([0, 0, 1, 0, 0.9, 1]);
    expect(anchorsOf(target)).toEqual([ref(0, 0), ref(0, 1)]);
    expectOneStep(target, before);
  });

  it('a segment press selects both ends and drags them without snapping', () => {
    const target = editor(FIXTURE, true);
    ok(target, { type: 'enterPathEdit', id: 'tri' });
    const before = text(target);
    drag(target, at(150, 100), at(150, 110));
    const node = target.query({ type: 'node', id: 'tri' })!;
    expect(node.frame).toEqual(f(100, 110, 100, 90));
    expect(node.type === 'path' && node.path.points).toEqual([0, 0, 1, 0, 1, 1]);
    expect(anchorsOf(target)).toEqual([ref(0, 0), ref(0, 1)]);
    expectOneStep(target, before);
  });

  it('a handle drag mirrors when the anchor was mirrored at press, and with Alt it does not', () => {
    const start = FIXTURE;
    const command = (mirror: boolean): DocumentCommand => ({
      type: 'setPathHandle',
      id: 'curve',
      anchor: ref(0, 1),
      side: 'in',
      to: at(321, 103),
      mirror,
    });
    const mirrored = editing('curve', [ref(0, 1)]);
    drag(mirrored, at(326, 101), at(322, 104));
    expect(text(mirrored)).toBe(twin(start, [command(true)]));
    expect(overlayOf(mirrored)!.subpaths[0]!.anchors[1]!.mirrored).toBe(true);
    const free = editing('curve', [ref(0, 1)]);
    drag(free, at(326, 101), at(322, 104), alt);
    expect(text(free)).toBe(twin(start, [command(false)]));
    expect(overlayOf(free)!.subpaths[0]!.anchors[1]!.mirrored).toBe(false);
    // An independent anchor stays independent without Alt: the curve's A2 has one handle.
    const end = editing('curve', [ref(0, 2)]);
    drag(end, at(390, 150), at(390, 160));
    expect(text(end)).toBe(
      twin(start, [
        {
          type: 'setPathHandle',
          id: 'curve',
          anchor: ref(0, 2),
          side: 'in',
          to: at(390, 160),
          mirror: false,
        },
      ]),
    );
  });

  it('Alt-drag on an anchor pulls mirrored handles; at an open end the side is in', () => {
    const start = FIXTURE;
    const pull = (id: string, a: number, side: 'in' | 'out', to: PagePoint): DocumentCommand => ({
      type: 'setPathHandle',
      id,
      anchor: ref(0, a),
      side,
      to,
      mirror: true,
    });
    const tri = editing('tri');
    const before = text(tri);
    drag(tri, T1, at(220, 90), alt);
    expect(text(tri)).toBe(twin(start, [pull('tri', 1, 'out', at(220, 90))]));
    expect(anchorsOf(tri)).toEqual([ref(0, 1)]);
    expectOneStep(tri, before);
    // The last anchor of the open curve: side in, to 2·A − q.
    const curve = editing('curve');
    drag(curve, C2, at(410, 140), alt);
    expect(text(curve)).toBe(twin(start, [pull('curve', 2, 'in', at(390, 160))]));
    // An anchor with no segment does nothing.
    const dot = editing('dot');
    const dotBefore = text(dot);
    drag(dot, at(700, 100), at(720, 110), alt);
    expect(text(dot)).toBe(dotBefore);
    expect(undoDepth(dot)).toBe(0);
  });

  it('Alt-click on an anchor retracts both handles; segments fully retracted become lines', () => {
    const target = editing('curve');
    const before = text(target);
    click(target, C1, alt);
    const expected = twin(FIXTURE, [
      {
        type: 'setPathHandle',
        id: 'curve',
        anchor: ref(0, 1),
        side: 'out',
        to: null,
        mirror: true,
      },
    ]);
    expect(text(target)).toBe(expected);
    expectOneStep(target, before);
    // A corner of lines: retracting changes nothing, no step.
    const tri = editing('tri');
    click(tri, T1, alt);
    expect(undoDepth(tri)).toBe(0);
  });

  it('Escape and pointercancel restore the document, the selection and the anchor selection', () => {
    for (const cancel of [
      (t: Editor) => expect(key(t, 'Escape')).toEqual(consumed),
      (t: Editor) => input(t, { kind: 'pointercancel', modifiers: none }),
    ]) {
      const target = editing('tri', [ref(0, 0)]);
      const before = text(target);
      pointer(target, 'pointerdown', T1);
      pointer(target, 'pointermove', at(230, 130));
      ok(target, { type: 'setPathSelection', anchors: [ref(0, 2)] });
      expect(text(target)).not.toBe(before);
      cancel(target);
      expect(text(target)).toBe(before);
      expect(selection(target)).toEqual(['tri']);
      // The anchor selection recorded when the gesture began (the press selected T1).
      expect(editOf(target)).toEqual({ id: 'tri', anchors: [ref(0, 1)] });
      expect(undoDepth(target)).toBe(0);
      // A handle drag and an Alt-drag on an anchor likewise.
      const gestures: [string, PathAnchorRef[], PagePoint, Modifiers][] = [
        ['curve', [ref(0, 1)], C1_OUT, none],
        ['tri', [ref(0, 0)], T1, alt],
      ];
      for (const [id, anchors, from, modifiers] of gestures) {
        const other = editing(id, anchors);
        const start = text(other);
        const expected = editOf(other);
        pointer(other, 'pointerdown', from, modifiers);
        pointer(other, 'pointermove', at(from.x + 12, from.y + 7), modifiers);
        expect(text(other)).not.toBe(start);
        cancel(other);
        expect(text(other), id).toBe(start);
        expect(selection(other)).toEqual([id]);
        // The Alt press selected T1 before the gesture began.
        expect(editOf(other), id).toEqual(modifiers.alt ? { id, anchors: [ref(0, 1)] } : expected);
        expect(undoDepth(other)).toBe(0);
      }
    }
  });

  it('F2: a drag that ends at its press point records no step and raises no document event', () => {
    for (const snapping of [true, false]) {
      const target = editor(SNAP, snapping);
      ok(target, { type: 'enterPathEdit', id: 'sp' });
      const before = text(target);
      const events = record(target);
      // Away and back: the move back gives the pre-gesture document; the release adds nothing.
      pointer(target, 'pointerdown', at(129, 1));
      pointer(target, 'pointermove', at(190, 40));
      pointer(target, 'pointermove', at(129, 1));
      expect(text(target)).toBe(before);
      events.length = 0;
      pointer(target, 'pointerup', at(129, 1));
      expect(events.filter((event) => event.startsWith('document'))).toEqual([]);
      expect(undoDepth(target)).toBe(0);
      expect(text(target)).toBe(before);
      // A press, a move to the press point and a release: no document event at all.
      pointer(target, 'pointerdown', at(127, 0));
      pointer(target, 'pointermove', at(127, 0));
      pointer(target, 'pointerup', at(127, 0));
      expect(events.filter((event) => event.startsWith('document'))).toEqual([]);
      // A handle drag back to its press point likewise.
      ok(target, {
        type: 'setPathHandle',
        id: 'sp',
        anchor: ref(0, 1),
        side: 'out',
        to: at(128, 64),
      });
      ok(target, { type: 'setPathSelection', anchors: [ref(0, 1)] });
      const curved = text(target);
      const depth = undoDepth(target);
      pointer(target, 'pointerdown', at(128, 64));
      pointer(target, 'pointermove', at(140, 70));
      pointer(target, 'pointermove', at(128, 64));
      events.length = 0;
      pointer(target, 'pointerup', at(128, 64));
      expect(events.filter((event) => event.startsWith('document'))).toEqual([]);
      expect(text(target)).toBe(curved);
      expect(undoDepth(target)).toBe(depth);
    }
  });
});

describe('M3-A09 keymap routing in edit mode', () => {
  it('nudges the anchor selection by 1 and 10 page units at zoom 0.5, 1 and 8: one document', () => {
    const texts = new Set<string>();
    for (const zoom of [0.5, 1, 8]) {
      const target = editing('tri', [ref(0, 1)]);
      ok(target, { type: 'setViewport', camera: { position: at(0, 0), zoom } });
      const before = text(target);
      expect(key(target, 'ArrowRight')).toEqual({ ok: true, ids: ['tri'], consumed: true });
      expect(key(target, 'ArrowDown', shift).ok).toBe(true);
      texts.add(text(target));
      expect(undoDepth(target)).toBe(2);
      ok(target, { type: 'undo' });
      ok(target, { type: 'undo' });
      expect(text(target)).toBe(before);
    }
    expect([...texts]).toEqual([
      twin(FIXTURE, [
        { type: 'movePathAnchors', id: 'tri', anchors: [ref(0, 1)], dx: 1, dy: 0 },
        { type: 'movePathAnchors', id: 'tri', anchors: [ref(0, 1)], dx: 0, dy: 10 },
      ]),
    ]);
  });

  it('with no anchor selected, nudge and delete are consumed no-ops', () => {
    const target = editing('tri');
    const before = text(target);
    for (const name of ['ArrowLeft', 'Delete', 'Backspace']) {
      expect(key(target, name)).toEqual(consumed);
    }
    expect(text(target)).toBe(before);
    expect(editOf(target)).toEqual({ id: 'tri', anchors: [] });
    expect(undoDepth(target)).toBe(0);
  });

  it('Mod+A selects every anchor; copy acts on the whole node', () => {
    const target = editing('curve');
    expect(key(target, 'a', ctrl)).toEqual(consumed);
    expect(anchorsOf(target)).toEqual([ref(0, 0), ref(0, 1), ref(0, 2)]);
    expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: ['curve'] });
    expect(editOf(target)?.id).toBe('curve');
  });
});

/**
 * `two`: an implicitly closed subpath of 2 anchors (0, 0), (100, 0); an open one (0, 100) to
 * (100, 100); a lone `move` at (50, 50).
 */
const TWO = doc(
  [['p1', ['two']]],
  [
    path('two', 'p1', f(0, 0, 100, 100), [
      ['move', 'line', 'close', 'move', 'line', 'move'],
      [0, 0, 1, 0, 0, 1, 1, 1, 0.5, 0.5],
    ]),
  ],
);

const insert = (id: string, subpath: number, segment: number, t: number): DocumentCommand => ({
  type: 'insertPathAnchor',
  id,
  subpath,
  segment,
  t,
});

/** An editor in edit mode with `togglePathClosed` bound to T by the host layer. */
function toggling(id: string, anchors: PathAnchorRef[], document: unknown = FIXTURE): Editor {
  const target = editing(id, anchors, document);
  ok(target, { type: 'setKeymap', bindings: [{ chord: 'T', action: 'togglePathClosed' }] });
  return target;
}

describe('M3-A09 segment double-click, Delete and togglePathClosed', () => {
  it('a double-click on a line inserts at t = σ and selects the new anchor, one step', () => {
    const target = editing('tri');
    const before = text(target);
    // σ = 30 / 100 on segment 0 from T0 to T1.
    expect(doubleclick(target, at(130, 101))).toEqual(consumed);
    expect(text(target)).toBe(twin(FIXTURE, [insert('tri', 0, 0, 0.3)]));
    expect(editOf(target)).toEqual({ id: 'tri', anchors: [ref(0, 1)] });
    expectOneStep(target, before);
    // The implicit closing segment from T2 to T0: the new anchor is anchor 3.
    const closing = editing('tri');
    expect(doubleclick(closing, at(150, 150))).toEqual(consumed);
    expect(text(closing)).toBe(twin(FIXTURE, [insert('tri', 0, 2, 0.5)]));
    expect(editOf(closing)).toEqual({ id: 'tri', anchors: [ref(0, 3)] });
  });

  it('a double-click on a cubic inserts at t = (j + σ) / N, page-root and rotated', () => {
    for (const id of ['curve', 'rot']) {
      const target = editing(id);
      const document = target.query({ type: 'document' });
      const { width: W, height: H } = document.nodes[id]!.frame;
      const local = id === 'curve' ? CURVE[1] : ARC[1];
      const [p0, p1, p2, p3] = [0, 2, 4, 6].map((i) =>
        pagePoint(document, id, local[i]! * W, local[i + 1]! * H),
      ) as [PagePoint, PagePoint, PagePoint, PagePoint];
      // At a chord end i / N the nearest chord gives t = i / N exactly.
      const count = cubicSegments(p0, p1, p2, p3, 0.25);
      const i = Math.floor(count / 2);
      const before = text(target);
      expect(doubleclick(target, cubicAt(p0, p1, p2, p3, i / count))).toEqual(consumed);
      expect(text(target), id).toBe(twin(FIXTURE, [insert(id, 0, 0, i / count)]));
      expect(editOf(target)).toEqual({ id, anchors: [ref(0, 1)] });
      expectOneStep(target, before);
    }
  });

  it('a double-click past an open end of a wide stroke hits the segment and inserts nothing', () => {
    // Width 40: the segment radius is 20 > 12 / zoom, so a point 10 past either end along the
    // tangent is outside ρ = 6 of the anchor but on segment 0, with σ clamped to 0 or 1.
    const wide = doc(
      [['p1', ['w']]],
      [
        {
          ...path(
            'w',
            'p1',
            f(100, 100, 100, 0),
            [
              ['move', 'line'],
              [0, 0, 1, 0],
            ],
            { fill: false },
          ),
          stroke: { ...V2_PATH_STROKE, width: 40 },
        },
      ],
    );
    const target = editing('w', [], wide);
    const before = text(target);
    for (const point of [at(90, 100), at(210, 100)]) {
      expect(doubleclick(target, point)).toEqual(consumed);
    }
    expect(text(target)).toBe(before);
    expect(editOf(target)).toEqual({ id: 'w', anchors: [] });
    expect(undoDepth(target)).toBe(0);
    // The same points are segment presses: they select both ends.
    click(target, at(90, 100));
    expect(anchorsOf(target)).toEqual([ref(0, 0), ref(0, 1)]);
  });

  it('Delete and Backspace remove the anchor selection in one step', () => {
    const target = editing('curve', [ref(0, 1)]);
    const before = text(target);
    expect(key(target, 'Delete')).toEqual({ ok: true, ids: ['curve'], consumed: true });
    expect(text(target)).toBe(
      twin(FIXTURE, [{ type: 'removePathAnchors', id: 'curve', anchors: [ref(0, 1)] }]),
    );
    // The structure changed, so the anchor selection is cleared; edit mode stays.
    expect(editOf(target)).toEqual({ id: 'curve', anchors: [] });
    expectOneStep(target, before);
    const back = editing('tri', [ref(0, 2)]);
    expect(key(back, 'Backspace')).toEqual({ ok: true, ids: ['tri'], consumed: true });
    expect(text(back)).toBe(
      twin(FIXTURE, [{ type: 'removePathAnchors', id: 'tri', anchors: [ref(0, 2)] }]),
    );
  });

  it('a Delete that would leave no subpath deletes the node in one step', () => {
    for (const [id, anchors] of [
      ['tri', [ref(0, 0), ref(0, 2)]],
      ['dot', [ref(0, 0)]],
    ] as const) {
      const target = editing(id, [...anchors]);
      const before = text(target);
      expect(key(target, 'Delete')).toMatchObject({ ok: true, consumed: true });
      expect(target.query({ type: 'node', id })).toBeNull();
      expect(text(target)).toBe(twin(FIXTURE, [{ type: 'deleteNodes', ids: [id] }]));
      expect(editOf(target)).toBeNull();
      expect(selection(target)).toEqual([]);
      expectOneStep(target, before);
    }
  });

  it('togglePathClosed closes an open subpath and opens a closed one, one step each', () => {
    const target = toggling('curve', [ref(0, 1)]);
    const before = text(target);
    expect(key(target, 't')).toEqual({ ok: true, ids: ['curve'], consumed: true });
    expect(text(target)).toBe(
      twin(FIXTURE, [{ type: 'closePathSubpath', id: 'curve', subpath: 0 }]),
    );
    expect(editOf(target)).toEqual({ id: 'curve', anchors: [] });
    expectOneStep(target, before);
    // Exactly the two ends of segment k selected: open there; else at n − 1.
    const cases: [PathAnchorRef[], number | undefined][] = [
      [[ref(0, 1), ref(0, 2)], 1],
      [[ref(0, 0), ref(0, 2)], 2],
      [[ref(0, 2)], undefined],
      [[ref(0, 0), ref(0, 1), ref(0, 2)], undefined],
    ];
    for (const [anchors, segment] of cases) {
      const tri = toggling('tri', anchors);
      const start = text(tri);
      expect(key(tri, 't').ok).toBe(true);
      expect(text(tri), JSON.stringify(anchors)).toBe(
        twin(FIXTURE, [
          {
            type: 'openPathSubpath',
            id: 'tri',
            subpath: 0,
            ...(segment === undefined ? {} : { segment }),
          },
        ]),
      );
      expectOneStep(tri, start);
    }
    // Both segments of a 2-anchor subpath have the selected ends: the lowest, k = 0.
    const two = toggling('two', [ref(0, 0), ref(0, 1)], TWO);
    expect(key(two, 't').ok).toBe(true);
    expect(text(two)).toBe(
      twin(TWO, [{ type: 'openPathSubpath', id: 'two', subpath: 0, segment: 0 }]),
    );
  });

  it('togglePathClosed is a consumed no-op across subpaths, with none and outside edit mode', () => {
    const across = toggling('two', [ref(0, 0), ref(1, 0)], TWO);
    const empty = toggling('tri', []);
    const outside = toggling('tri', []);
    ok(outside, { type: 'exitPathEdit' });
    for (const target of [across, empty, outside]) {
      const before = text(target);
      expect(key(target, 't')).toEqual(consumed);
      expect(text(target)).toBe(before);
      expect(undoDepth(target)).toBe(0);
    }
    expect(selection(outside)).toEqual(['tri']);
    // A lone `move` cannot close: the command's failure, consumed.
    const lone = toggling('two', [ref(2, 0)], TWO);
    expect(key(lone, 't')).toEqual({ ok: false, code: 'editor.too-few-anchors', consumed: true });
  });
});

describe('M3-A10 anchor snapping', () => {
  it('snaps the pressed anchor to candidate edges with the literal overlay, one step', () => {
    const target = editor(SNAP, true);
    ok(target, { type: 'enterPathEdit', id: 'sp' });
    const before = text(target);
    pointer(target, 'pointerdown', at(128, 0));
    pointer(target, 'pointermove', at(253, 0));
    // A1 at 253 snaps to r's left edge 256: the issued delta is 125 + 3.
    expect(target.query({ type: 'snap' })).toEqual({
      guides: [{ a: at(256, 0), b: at(256, 96) }],
      gaps: [],
      angle: null,
    });
    pointer(target, 'pointerup', at(253, 0));
    expect(target.query({ type: 'snap' })).toBeNull();
    const node = target.query({ type: 'node', id: 'sp' })!;
    expect(node.frame).toEqual(f(0, 0, 256, 128));
    expect(node.type === 'path' && node.path.points).toEqual([0, 0, 1, 0, 0.5, 1]);
    expectOneStep(target, before);
  });

  it('snaps to a centre; the edited path is no candidate', () => {
    const target = editor(SNAP, true);
    ok(target, { type: 'enterPathEdit', id: 'sp' });
    pointer(target, 'pointerdown', at(128, 0));
    pointer(target, 'pointermove', at(275, 0));
    expect(target.query({ type: 'snap' })).toEqual({
      guides: [{ a: at(272, 0), b: at(272, 96) }],
      gaps: [],
      angle: null,
    });
    expect(overlayOf(target)!.subpaths[0]!.anchors[1]!.point.x).toBe(272);
    pointer(target, 'pointerup', at(275, 0));
    expect(target.query({ type: 'node', id: 'sp' })!.frame).toEqual(f(0, 0, 272, 128));
    // Near its own pre-gesture left edge and top edge: nothing snaps.
    const fresh = editor(SNAP, true);
    ok(fresh, { type: 'enterPathEdit', id: 'sp' });
    pointer(fresh, 'pointerdown', at(128, 0));
    pointer(fresh, 'pointermove', at(3, 1));
    expect(fresh.query({ type: 'snap' })).toBeNull();
    expect(overlayOf(fresh)!.subpaths[0]!.anchors[1]!.point).toEqual(at(3, 1));
  });

  it('is off with Ctrl, Meta and setSnapping false', () => {
    const raw = twin(SNAP, [
      { type: 'movePathAnchors', id: 'sp', anchors: [ref(0, 1)], dx: 125, dy: 0 },
    ]);
    for (const [modifiers, snapping] of [
      [ctrl, true],
      [meta, true],
      [none, false],
    ] as const) {
      const target = editor(SNAP, snapping);
      ok(target, { type: 'enterPathEdit', id: 'sp' });
      drag(target, at(128, 0), at(253, 0), modifiers);
      expect(text(target)).toBe(raw);
    }
  });

  it('never snaps a handle or a segment drag', () => {
    const target = editor(SNAP, true);
    ok(target, { type: 'enterPathEdit', id: 'sp' });
    // Segment 0 from (0, 0) to (128, 0): its ends move by the raw delta.
    pointer(target, 'pointerdown', at(64, 0));
    pointer(target, 'pointermove', at(64 + 125, 63));
    expect(target.query({ type: 'snap' })).toBeNull();
    pointer(target, 'pointerup', at(64 + 125, 63));
    expect(text(target)).toBe(
      twin(SNAP, [
        { type: 'movePathAnchors', id: 'sp', anchors: [ref(0, 0), ref(0, 1)], dx: 125, dy: 63 },
      ]),
    );
    const handle = editor(SNAP, true);
    ok(handle, {
      type: 'setPathHandle',
      id: 'sp',
      anchor: ref(0, 1),
      side: 'out',
      to: at(128, 64),
    });
    ok(handle, { type: 'enterPathEdit', id: 'sp' });
    ok(handle, { type: 'setPathSelection', anchors: [ref(0, 1)] });
    const start = handle.query({ type: 'document' });
    drag(handle, at(128, 64), at(254, 64));
    expect(handle.query({ type: 'snap' })).toBeNull();
    expect(text(handle)).toBe(
      twin(start, [
        { type: 'setPathHandle', id: 'sp', anchor: ref(0, 1), side: 'out', to: at(254, 64) },
      ]),
    );
  });
});

describe('M3-A11 pathOverlay', () => {
  it('is null outside edit mode and frozen inside', () => {
    const target = editor();
    expect(overlayOf(target)).toBeNull();
    ok(target, { type: 'enterPathEdit', id: 'tri' });
    expect(Object.isFrozen(overlayOf(target))).toBe(true);
    ok(target, { type: 'exitPathEdit' });
    expect(overlayOf(target)).toBeNull();
  });

  it('gives literal page-space anchors, visible handles, selected and mirrored', () => {
    const tri = editing('tri', [ref(0, 2)]);
    expect(overlayOf(tri)).toEqual({
      id: 'tri',
      subpaths: [{ closed: true, anchors: [anchor(T0), anchor(T1), anchor(T2, {}, true)] }],
    } satisfies PathEditOverlay);
    const curve = editing('curve');
    // Nothing selected: no handle is visible, but A1 is mirrored.
    expect(overlayOf(curve)!.subpaths[0]!.anchors).toEqual([
      anchor(C0),
      anchor(C1, {}, false, true),
      anchor(C2),
    ]);
    // A1 selected: its handles, and the handles of the other ends of its segments.
    ok(curve, { type: 'setPathSelection', anchors: [ref(0, 1)] });
    expect(overlayOf(curve)).toEqual({
      id: 'curve',
      subpaths: [
        {
          closed: false,
          anchors: [
            anchor(C0, { out: at(310, 150) }),
            anchor(C1, { in: C1_IN, out: C1_OUT }, true, true),
            anchor(C2, { in: at(390, 150) }),
          ],
        },
      ],
    });
    // A0 selected: its out handle and A1's in handle (the other end of segment 0).
    ok(curve, { type: 'setPathSelection', anchors: [ref(0, 0)] });
    expect(overlayOf(curve)!.subpaths[0]!.anchors).toEqual([
      anchor(C0, { out: at(310, 150) }, true),
      anchor(C1, { in: C1_IN }, false, true),
      anchor(C2),
    ]);
  });

  it('maps a non-dyadic page-root path as x + u·W, y + v·H', () => {
    const target = editor(
      doc(
        [['p1', ['nd']]],
        [
          path(
            'nd',
            'p1',
            f(10.1, 20.3, 30.7, 40.9),
            [
              ['move', 'line', 'line'],
              [0, 0, 0.3, 0.7, 1, 1],
            ],
            {
              fill: false,
            },
          ),
        ],
      ),
    );
    ok(target, { type: 'enterPathEdit', id: 'nd' });
    expect(overlayOf(target)!.subpaths[0]!.anchors.map((entry) => entry.point)).toEqual([
      at(10.1 + 0 * 30.7, 20.3 + 0 * 40.9),
      at(10.1 + 0.3 * 30.7, 20.3 + 0.7 * 40.9),
      at(10.1 + 1 * 30.7, 20.3 + 1 * 40.9),
    ]);
  });

  it('lists anchor 0 of an explicitly closed subpath once', () => {
    const target = editor(
      doc(
        [['p1', ['ex']]],
        [
          path('ex', 'p1', f(0, 0, 10, 10), [
            ['move', 'line', 'line', 'line', 'close'],
            [0, 0, 1, 0, 1, 1, 0, 0],
          ]),
        ],
      ),
    );
    ok(target, { type: 'enterPathEdit', id: 'ex' });
    expect(overlayOf(target)!.subpaths).toEqual([
      { closed: true, anchors: [anchor(at(0, 0)), anchor(at(10, 0)), anchor(at(10, 10))] },
    ]);
  });

  it('maps a rotated and a nested path through their chains; targets agree with it', () => {
    for (const [id, frame] of [
      ['rot', f(100, 700, 100, 50)],
      ['np', f(0, 0, 100, 100)],
    ] as const) {
      const target = editing(id, [ref(0, 0), ref(0, 1)]);
      const document = target.query({ type: 'document' });
      const { width: W, height: H } = frame;
      const page = (u: number, v: number) => pagePoint(document, id, u * W, v * H);
      expect(overlayOf(target)).toEqual({
        id,
        subpaths: [
          {
            closed: false,
            anchors: [
              anchor(page(0, 0), { out: page(0.25, 0) }, true),
              anchor(page(1, 1), { in: page(0.75, 1) }, true),
            ],
          },
        ],
      });
      // A click on each overlay anchor selects exactly it; a drag from each visible handle
      // moves that handle.
      const overlay = overlayOf(target)!;
      overlay.subpaths[0]!.anchors.forEach((entry, a) => {
        click(target, entry.point);
        expect(anchorsOf(target), `${id} anchor ${a}`).toEqual([ref(0, a)]);
      });
      ok(target, { type: 'setPathSelection', anchors: [ref(0, 0), ref(0, 1)] });
      const out = overlay.subpaths[0]!.anchors[0]!.out!;
      const before = target.query({ type: 'document' });
      drag(target, out, at(out.x + 4, out.y + 2));
      expect(text(target)).toBe(
        twin(before, [
          {
            type: 'setPathHandle',
            id,
            anchor: ref(0, 0),
            side: 'out',
            to: at(out.x + 4, out.y + 2),
            mirror: false,
          },
        ]),
      );
    }
  });
});
