import {
  normalizeRotation,
  serializeDocument,
  type DocumentV5,
  type Frame,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type Modifiers,
  type PagePoint,
  type SnapOverlay,
} from '../../packages/editor-core/src/index.js';
// Source imports: the gesture state, the page-aligned bounds and the snap module are internal.
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { rotate } from '../../packages/editor-core/src/geometry.js';
import { boundsOf } from '../../packages/editor-core/src/hit-test.js';
import { snapAngle, snapSet } from '../../packages/editor-core/src/snap.js';

// MVP M2-U3, M2-A04 (M2 contract, section 4.2): snapping of the select tool's move and
// page-aligned resize, the box tools' corner, the line end and the one-node rotation; the
// candidate set and its exclusions, the threshold, align, spacing and centring offers with the
// whole tie chain, rotation-angle targets, Ctrl or Meta and `setSnapping`, and the literal snap
// overlay during a drag, cleared at commit and cancel. Values are literal where the arithmetic
// is exact, else the binary64 evaluation of the section's formulas (M2-Q14).

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const shift: Modifiers = { ...none, shift: true };
const ctrl: Modifiers = { ...none, ctrl: true };
const meta: Modifiers = { ...none, meta: true };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });
const seg = (ax: number, ay: number, bx: number, by: number) => ({
  a: at(ax, ay),
  b: at(bx, by),
});

type Loose = Record<string, unknown> & { id: string };

function base(id: string, parent: string, frame: Frame, rotation = 0, visible = true) {
  return { id, name: id, parent, frame, rotation, constraints: START, opacity: 1, visible };
}

function rect(id: string, parent: string, frame: Frame, rotation = 0, visible = true): Loose {
  return {
    ...base(id, parent, frame, rotation, visible),
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
  };
}

function triangle(id: string, parent: string, frame: Frame): Loose {
  return {
    ...base(id, parent, frame),
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
  type: 'group' | 'frame' | 'maskGroup',
  id: string,
  parent: string,
  children: string[],
  frame: Frame,
  rotation = 0,
  visible = true,
): Loose {
  const node: Loose = { ...base(id, parent, frame, rotation, visible), type, children };
  return type === 'frame' ? { ...node, fill: DEFAULT_FRAME_FILL, stroke: null } : node;
}

/** One page `p1` whose children are the nodes with parent `p1`, in the listed order. */
function page(nodes: Loose[]) {
  return {
    schemaVersion: 2,
    id: 'doc',
    pages: [
      { id: 'p1', name: 'p1', children: nodes.filter((n) => n.parent === 'p1').map((n) => n.id) },
    ],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

function editor(document: unknown): Editor {
  return createEditor({ ids: createCounterIdSource('n'), document });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function input(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  point: PagePoint,
  modifiers = none,
): CommandResult {
  return target.execute({ type: 'input', event: { kind, point, modifiers } });
}

function key(target: Editor, name: string): CommandResult {
  return target.execute({ type: 'input', event: { kind: 'keydown', key: name, modifiers: none } });
}

/** Press at `from` and move to `to`, without releasing. */
function press(target: Editor, from: PagePoint, to: PagePoint, modifiers = none) {
  input(target, 'pointerdown', from, modifiers);
  input(target, 'pointermove', to, modifiers);
}

/** Press at `from`, move to `to` and release there. */
function drag(target: Editor, from: PagePoint, to: PagePoint, modifiers = none) {
  press(target, from, to, modifiers);
  input(target, 'pointerup', to, modifiers);
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const frameOf = (target: Editor, id: string) => target.query({ type: 'node', id })!.frame;
const snapOf = (target: Editor) => target.query({ type: 'snap' });
const undoDepth = (target: Editor) => target.query({ type: 'history' }).undoDepth;
const overlay = (
  guides: SnapOverlay['guides'],
  gaps: SnapOverlay['gaps'] = [],
  angle: number | null = null,
): SnapOverlay => ({ guides, gaps, angle });

function selected(document: unknown, ids: string[], zoom = 1): Editor {
  const target = editor(document);
  if (ids.length > 0) ok(target, { type: 'setSelection', ids });
  if (zoom !== 1) ok(target, { type: 'setViewport', camera: { position: at(0, 0), zoom } });
  return target;
}

function unsnapped(document: unknown, ids: string[]): Editor {
  const target = selected(document, ids);
  ok(target, { type: 'setSnapping', enabled: false });
  return target;
}

/** Tall candidates across y [0, 100]; the moving box spans y [30, 41], so y never snaps. */
const tall = (id: string, x: number, width: number) => rect(id, 'p1', f(x, 0, width, 100));

/** The section's worked example: candidates [0, 10], [20, 30], [25, 35]; `m` at [30, 40]. */
const EXAMPLE = page([
  tall('a', 0, 10),
  tall('b', 20, 10),
  tall('c', 25, 10),
  rect('m', 'p1', f(30, 30, 10, 11)),
]);

describe('M2-A04 snapping: the worked example and the overlay life cycle', () => {
  it('snaps B = [41, 51] to the spacing offer o = 4 (B′ = [45, 55]), gaps 10 → 20, 35 → 45', () => {
    const target = editor(EXAMPLE);
    const before = text(target);
    press(target, at(36, 35), at(47, 35));
    expect(frameOf(target, 'm')).toEqual(f(45, 30, 10, 11));
    const expected = overlay([], [seg(10, 50, 20, 50), seg(35, 35.5, 45, 35.5)]);
    expect(snapOf(target)).toEqual(expected);
    expect(target.getSnapshot().snap).toEqual(expected);
    expect(Object.isFrozen(snapOf(target))).toBe(true);
    input(target, 'pointerup', at(47, 35));
    expect(frameOf(target, 'm')).toEqual(f(45, 30, 10, 11));
    expect(snapOf(target)).toBeNull();
    expect(target.getSnapshot().snap).toBeNull();
    // One undo step with byte-identical undo and redo.
    expect(undoDepth(target)).toBe(1);
    const after = text(target);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
    ok(target, { type: 'redo' });
    expect(text(target)).toBe(after);
  });

  it('measures each update from the pre-gesture box, raises snap only on change', () => {
    const target = editor(EXAMPLE);
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    const snaps = () => seen.filter((e) => e.type === 'session' && e.field === 'snap').length;
    press(target, at(36, 35), at(47, 35));
    expect(snaps()).toBe(1);
    // dx = 11.5: B = [41.5, 51.5], the offer 3.5 reaches the same B′, so no event.
    input(target, 'pointermove', at(47.5, 35));
    expect(frameOf(target, 'm')).toEqual(f(45, 30, 10, 11));
    expect(snaps()).toBe(1);
    // dx = 34: B = [64, 74], out of reach of every offer, so the overlay clears.
    input(target, 'pointermove', at(70, 35));
    expect(frameOf(target, 'm')).toEqual(f(64, 30, 10, 11));
    expect(snapOf(target)).toBeNull();
    expect(snaps()).toBe(2);
    input(target, 'pointermove', at(47, 35));
    expect(snaps()).toBe(3);
    input(target, 'pointerup', at(47, 35));
    expect(snapOf(target)).toBeNull();
    expect(snaps()).toBe(4);
    expect(undoDepth(target)).toBe(1);
  });

  it.each(['Escape', 'pointercancel', 'loadDocument'] as const)(
    'clears the overlay when %s cancels the gesture',
    (how) => {
      const target = editor(EXAMPLE);
      const before = text(target);
      press(target, at(36, 35), at(47, 35));
      expect(snapOf(target)).not.toBeNull();
      if (how === 'Escape') key(target, 'Escape');
      else if (how === 'pointercancel') {
        target.execute({ type: 'input', event: { kind: 'pointercancel', modifiers: none } });
      } else ok(target, { type: 'loadDocument', document: EXAMPLE });
      expect(snapOf(target)).toBeNull();
      expect(target.getSnapshot().snap).toBeNull();
      expect(text(target)).toBe(before);
      expect(undoDepth(target)).toBe(0);
      expect(internalsOf(target).gesture.active).toBe(false);
    },
  );
});

describe('M2-A04 snapping: Ctrl, Meta and setSnapping', () => {
  it.each([
    ['ctrl', ctrl],
    ['meta', meta],
  ] as const)('%s held disables snapping for that update', (_, modifiers) => {
    const target = editor(EXAMPLE);
    press(target, at(36, 35), at(47, 35), modifiers);
    expect(frameOf(target, 'm')).toEqual(f(41, 30, 10, 11));
    expect(snapOf(target)).toBeNull();
    // Released without the modifier, the next update snaps again.
    input(target, 'pointermove', at(47, 35));
    expect(frameOf(target, 'm')).toEqual(f(45, 30, 10, 11));
    input(target, 'pointerup', at(47, 35), modifiers);
    expect(frameOf(target, 'm')).toEqual(f(41, 30, 10, 11));
  });

  it('setSnapping is a session command with an event only on change', () => {
    const target = editor(EXAMPLE);
    expect(target.query({ type: 'snapping' })).toBe(true);
    expect(target.getSnapshot().snapping).toBe(true);
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    expect(target.execute({ type: 'setSnapping', enabled: false })).toEqual({ ok: true, ids: [] });
    expect(target.execute({ type: 'setSnapping', enabled: false })).toEqual({ ok: true, ids: [] });
    expect(seen).toEqual([{ type: 'session', field: 'snapping' }]);
    expect(target.query({ type: 'snapping' })).toBe(false);
    expect(target.getSnapshot().snapping).toBe(false);
    expect(undoDepth(target)).toBe(0);
    drag(target, at(36, 35), at(47, 35));
    expect(frameOf(target, 'm')).toEqual(f(41, 30, 10, 11));
    ok(target, { type: 'setSnapping', enabled: true });
    expect(seen.filter((e) => e.type === 'session' && e.field === 'snapping')).toHaveLength(2);
    ok(target, { type: 'undo' });
    drag(target, at(36, 35), at(47, 35));
    expect(frameOf(target, 'm')).toEqual(f(45, 30, 10, 11));
    // Snapping is never part of the document.
    expect(text(target)).not.toContain('snap');
  });

  it('rejects a malformed setSnapping at /enabled and changes nothing', () => {
    const target = editor(EXAMPLE);
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    for (const enabled of ['yes', 1, null, undefined]) {
      expect(target.execute({ type: 'setSnapping', enabled } as unknown as Command)).toEqual({
        ok: false,
        code: 'editor.invalid-command',
        path: '/enabled',
      });
    }
    expect(target.execute({ type: 'setSnapping' } as unknown as Command)).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/enabled',
    });
    expect(seen).toEqual([]);
    expect(target.query({ type: 'snapping' })).toBe(true);
  });
});

describe('M2-A04 snapping: threshold', () => {
  const DOC = page([rect('k', 'p1', f(0, 0, 10, 10)), rect('m', 'p1', f(100, 200, 10, 10))]);

  it('is 6 page units at zoom 1, inclusive', () => {
    const target = editor(DOC);
    press(target, at(105, 205), at(21, 205));
    expect(frameOf(target, 'm')).toEqual(f(10, 200, 10, 10));
    expect(snapOf(target)).toEqual(overlay([seg(10, 0, 10, 210)]));
    input(target, 'pointermove', at(21.5, 205));
    expect(frameOf(target, 'm')).toEqual(f(16.5, 200, 10, 10));
    expect(snapOf(target)).toBeNull();
  });

  it('is 6 / zoom page units at zoom 4', () => {
    const target = selected(DOC, [], 4);
    press(target, at(105, 205), at(16.5, 205));
    expect(frameOf(target, 'm')).toEqual(f(10, 200, 10, 10));
    expect(snapOf(target)).toEqual(overlay([seg(10, 0, 10, 210)]));
    input(target, 'pointermove', at(16.6, 205));
    expect(frameOf(target, 'm')).toEqual(f(100 + (16.6 - 105), 200, 10, 10));
    expect(snapOf(target)).toBeNull();
  });
});

describe('M2-A04 snapping: align offers and guides', () => {
  it('snaps both axes and orders x guides before y guides', () => {
    const target = editor(
      page([rect('k', 'p1', f(0, 0, 10, 10)), rect('m', 'p1', f(13, 14, 10, 10))]),
    );
    press(target, at(18, 19), at(18.5, 19));
    expect(frameOf(target, 'm')).toEqual(f(10, 10, 10, 10));
    expect(snapOf(target)).toEqual(overlay([seg(10, 0, 10, 20), seg(0, 10, 20, 10)]));
  });

  it('draws one guide per matched value, by value, spanning every matched candidate', () => {
    const target = editor(
      page([
        rect('k1', 'p1', f(0, 0, 10, 10)),
        rect('k2', 'p1', f(20, 50, 10, 10)),
        rect('k3', 'p1', f(-5, 80, 15, 10)),
        rect('m', 'p1', f(11.5, 20, 20, 10)),
      ]),
    );
    press(target, at(15, 25), at(15.5, 25));
    expect(frameOf(target, 'm')).toEqual(f(10, 20, 20, 10));
    expect(snapOf(target)).toEqual(
      overlay([seg(10, 0, 10, 90), seg(20, 20, 20, 60), seg(30, 20, 30, 60)]),
    );
  });

  it('ties: the least |o| wins (spacing 4 over align −6, the worked example)', () => {
    const target = editor(EXAMPLE);
    press(target, at(36, 35), at(47, 35));
    expect(frameOf(target, 'm').x).toBe(45);
  });

  it('ties: an align offer wins over a spacing offer of equal |o|', () => {
    // B = [40, 50]: align c = 35 gives −5, the spacing offer 35 + 10 − 40 gives +5.
    const target = editor(EXAMPLE);
    press(target, at(36, 35), at(46, 35));
    expect(frameOf(target, 'm')).toEqual(f(35, 30, 10, 11));
    expect(snapOf(target)).toEqual(overlay([seg(35, 0, 35, 100)]));
  });

  it('ties: between align offers of equal |o|, the lesser candidate value wins', () => {
    // B = [17, 47]: c = 20 gives +3 for the left edge, c = 44 gives −3 for the right edge.
    const target = editor(
      page([
        rect('k1', 'p1', f(20, 200, 1, 10)),
        rect('k2', 'p1', f(40, 200, 4, 10)),
        rect('m', 'p1', f(16, 0, 30, 10)),
      ]),
    );
    press(target, at(20, 5), at(21, 5));
    expect(frameOf(target, 'm')).toEqual(f(20, 0, 30, 10));
    expect(snapOf(target)).toEqual(overlay([seg(20, 0, 20, 210)]));
  });

  it('ties: for one candidate value, the lesser moving index wins', () => {
    // B = [47, 59], cx 53: c = 50 gives +3 for index 0 and −3 for index 1.
    const target = editor(
      page([rect('k', 'p1', f(50, 200, 100, 10)), rect('m', 'p1', f(46, 0, 12, 10))]),
    );
    press(target, at(50, 5), at(51, 5));
    expect(frameOf(target, 'm')).toEqual(f(50, 0, 12, 10));
    expect(snapOf(target)).toEqual(overlay([seg(50, 0, 50, 210)]));
  });
});

describe('M2-A04 snapping: spacing and centring', () => {
  it('ties: spacing offers of equal |o| go to the lesser target value', () => {
    // G = {20, 58, 40}; B = [−32, −30]: the left offer +2 targets B.left = −30, the right offer
    // −2 targets B.right = −32, which wins.
    const target = editor(
      page([
        tall('p', -100, 20),
        tall('q', -60, 10),
        tall('e', 8, 10),
        tall('z', 58, 10),
        rect('m', 'p1', f(-42, 30, 2, 11)),
      ]),
    );
    press(target, at(-41, 35), at(-31, 35));
    expect(frameOf(target, 'm')).toEqual(f(-34, 30, 2, 11));
    expect(snapOf(target)).toEqual(overlay([], [seg(18, 50, 58, 50), seg(-32, 35.5, 8, 35.5)]));
    // G = {20, 66, 40}; B = [−32, −22]: now the left offer's target −30 is the lesser one.
    const wide = editor(
      page([
        tall('p', -100, 20),
        tall('q', -60, 10),
        tall('e', 16, 10),
        tall('z', 66, 10),
        rect('m', 'p1', f(-42, 30, 10, 11)),
      ]),
    );
    press(wide, at(-37, 35), at(-27, 35));
    expect(frameOf(wide, 'm')).toEqual(f(-30, 30, 10, 11));
    expect(snapOf(wide)).toEqual(overlay([], [seg(-80, 50, -60, 50), seg(-50, 35.5, -30, 35.5)]));
  });

  it('ties: spacing offers of equal |o| and target go to the lesser gap', () => {
    // G = {40, 60, 20}; B = [−12, −8]: the left offer with g = 40 and the right offer with
    // g = 20 both target −10; the lesser gap 20 wins.
    const target = editor(
      page([
        tall('p', -110, 10),
        tall('q', -60, 10),
        tall('e', 10, 10),
        tall('z', 40, 10),
        rect('m', 'p1', f(-22, 30, 4, 11)),
      ]),
    );
    press(target, at(-20, 35), at(-10, 35));
    expect(frameOf(target, 'm')).toEqual(f(-14, 30, 4, 11));
    expect(snapOf(target)).toEqual(overlay([], [seg(20, 50, 40, 50), seg(-10, 35.5, 10, 35.5)]));
  });

  it('centres between the nearest left and right neighbours', () => {
    const target = editor(
      page([tall('a', 0, 10), tall('e', 50, 10), rect('m', 'p1', f(12, 30, 10, 11))]),
    );
    press(target, at(17, 35), at(27, 35));
    expect(frameOf(target, 'm')).toEqual(f(25, 30, 10, 11));
    expect(snapOf(target)).toEqual(overlay([], [seg(10, 35.5, 25, 35.5), seg(35, 35.5, 50, 35.5)]));
  });

  it('nearest neighbours tie to the earlier candidate (by document order)', () => {
    const nodes = (order: 'a1' | 'a2') => {
      const a1 = rect('a1', 'p1', f(20, 0, 10, 200));
      const a2 = rect('a2', 'p1', f(25, 40, 5, 160));
      return page([
        rect('p', 'p1', f(0, 0, 10, 200)),
        ...(order === 'a1' ? [a1, a2] : [a2, a1]),
        rect('m', 'p1', f(32, 30, 10, 40)),
      ]);
    };
    // Both left neighbours end at 30; B = [42, 52] takes the offer 30 + 10 − 42 = −2.
    const first = editor(nodes('a1'));
    press(first, at(37, 50), at(47, 50));
    expect(frameOf(first, 'm')).toEqual(f(40, 30, 10, 40));
    expect(snapOf(first)).toEqual(overlay([], [seg(10, 100, 20, 100), seg(30, 50, 40, 50)]));
    const second = editor(nodes('a2'));
    press(second, at(37, 50), at(47, 50));
    expect(frameOf(second, 'm')).toEqual(f(40, 30, 10, 40));
    expect(snapOf(second)).toEqual(overlay([], [seg(10, 100, 20, 100), seg(30, 55, 40, 55)]));
  });

  it('overlapping and nested candidates give no gap; consecutive pairs still do', () => {
    // Sorted: big [0, 40], inner [10, 20], d [50, 60]; only inner → d gives a gap (30).
    const target = editor(
      page([
        tall('big', 0, 40),
        tall('inner', 10, 10),
        tall('d', 50, 10),
        rect('m', 'p1', f(82, 30, 10, 11)),
      ]),
    );
    press(target, at(87, 35), at(97, 35));
    expect(frameOf(target, 'm')).toEqual(f(90, 30, 10, 11));
    expect(snapOf(target)).toEqual(overlay([], [seg(20, 50, 50, 50), seg(60, 35.5, 90, 35.5)]));
  });

  it('runs along y with x and y swapped', () => {
    const wide = (id: string, y: number) => rect(id, 'p1', f(0, y, 100, 10));
    const target = editor(
      page([wide('a', 0), wide('b', 20), wide('c', 25), rect('m', 'p1', f(30, 30, 11, 10))]),
    );
    press(target, at(35, 36), at(35, 47));
    expect(frameOf(target, 'm')).toEqual(f(30, 45, 11, 10));
    expect(snapOf(target)).toEqual(overlay([], [seg(50, 10, 50, 20), seg(35.5, 35, 35.5, 45)]));
  });
});

describe('M2-A04 snapping: candidates', () => {
  it('excludes hidden nodes and the children of a hidden top-level frame', () => {
    const target = editor(
      page([
        rect('k', 'p1', f(0, 0, 10, 10), 0, false),
        container('frame', 'hf', 'p1', ['hc'], f(0, 400, 50, 50), 0, false),
        rect('hc', 'hf', f(0, 0, 10, 10)),
        rect('m', 'p1', f(12, 200, 10, 10)),
      ]),
    );
    press(target, at(17, 205), at(18, 205));
    expect(frameOf(target, 'm').x).toBe(13);
    expect(snapOf(target)).toBeNull();
  });

  it('excludes the moving nodes’ descendants', () => {
    const target = editor(
      page([
        container('frame', 'fr', 'p1', ['fc'], f(0, 0, 100, 100)),
        rect('fc', 'fr', f(0, 0, 10, 10)),
      ]),
    );
    press(target, at(50, 50), at(51, 50));
    expect(frameOf(target, 'fr')).toEqual(f(1, 0, 100, 100));
    expect(snapOf(target)).toBeNull();
  });

  it('excludes a moving node’s group ancestor', () => {
    const target = selected(
      page([
        container('group', 'g', 'p1', ['ga', 'gb'], f(0, 0, 60, 10)),
        rect('ga', 'g', f(0, 0, 10, 10)),
        rect('gb', 'g', f(50, 0, 10, 10)),
      ]),
      ['ga'],
    );
    press(target, at(5, 5), at(6, 5));
    expect(frameOf(target, 'ga')).toEqual(f(1, 0, 10, 10));
    expect(snapOf(target)).toBeNull();
  });

  it('excludes a moving node’s mask-group ancestor (the source rule is in the snap-module scope test)', () => {
    const target = selected(
      page([
        container('maskGroup', 'mg', 'p1', ['mp', 'mr'], f(0, 0, 60, 60)),
        triangle('mp', 'mg', f(0, 0, 60, 60)),
        rect('mr', 'mg', f(0, 0, 10, 10)),
      ]),
      ['mr'],
    );
    press(target, at(7, 3), at(8, 3));
    expect(frameOf(target, 'mr')).toEqual(f(1, 0, 10, 10));
    expect(snapOf(target)).toBeNull();
  });

  it('includes the children of a top-level frame, by page-aligned bounds in a rotated frame', () => {
    const document = page([
      container('frame', 'fr', 'p1', ['fc'], f(100, 0, 50, 50), 0.3),
      rect('fc', 'fr', f(30, 30, 10, 10)),
      rect('m', 'p1', f(0, 500, 10, 10)),
    ]);
    const k = boundsOf(document as unknown as DocumentV5, ['fc'])!;
    const right = k.x + k.width;
    const mx = right + 2 - 1;
    const moved = {
      ...document,
      nodes: { ...document.nodes, m: rect('m', 'p1', f(mx, 500, 10, 10)) },
    };
    const target = editor(moved);
    press(target, at(mx + 5, 505), at(mx + 6, 505));
    // B.left = mx + 1, o = K.right − B.left; the delta is 1 + o.
    const o = right - (mx + 1);
    expect(frameOf(target, 'm')).toEqual(f(mx + (1 + o), 500, 10, 10));
    const v = mx + 1 + o;
    expect(snapOf(target)).toEqual(overlay([seg(v, k.y, v, 510)]));
  });

  it('does not include the children of a nested frame', () => {
    const target = editor(
      page([
        container('frame', 'fr', 'p1', ['f2'], f(0, 0, 200, 200)),
        container('frame', 'f2', 'fr', ['n'], f(0, 0, 100, 100)),
        rect('n', 'f2', f(20, 20, 10, 10)),
        rect('m', 'p1', f(32, 300, 10, 10)),
      ]),
    );
    press(target, at(37, 305), at(38, 305));
    expect(frameOf(target, 'm').x).toBe(33);
    expect(snapOf(target)).toBeNull();
  });

  it('includes a frame ancestor of a moving node, not that frame’s other children', () => {
    const nodes = page([
      container('group', 'g0', 'p1', ['f2'], f(50, 50, 100, 100)),
      container('frame', 'f2', 'g0', ['n', 'm2'], f(0, 0, 100, 100)),
      rect('n', 'f2', f(10, 10, 10, 10)),
      rect('m2', 'f2', f(30, 30, 10, 10)),
    ]);
    const toFrame = selected(nodes, ['n']);
    press(toFrame, at(65, 65), at(58, 65));
    expect(frameOf(toFrame, 'n')).toEqual(f(0, 10, 10, 10));
    expect(snapOf(toFrame)).toEqual(overlay([seg(50, 50, 50, 150)]));
    const toSibling = selected(nodes, ['n']);
    press(toSibling, at(65, 65), at(82, 65));
    expect(frameOf(toSibling, 'n')).toEqual(f(27, 10, 10, 10));
    expect(snapOf(toSibling)).toBeNull();
  });

  it('moves nodes of different parents by one snapped page delta, in rotated containers', () => {
    const document = page([
      container('frame', 'fr', 'p1', ['c1'], f(200, 0, 100, 100), 0.3),
      rect('c1', 'fr', f(10, 10, 10, 10)),
      rect('r', 'p1', f(0, 200, 10, 10)),
      rect('k', 'p1', f(4, 400, 10, 10)),
    ]);
    // The joint box of `r` and `c1` (left 0) moves by 1; its left edge snaps to k.left = 4.
    const joint = boundsOf(document as unknown as DocumentV5, ['r', 'c1'])!;
    expect(joint.x).toBe(0);
    const target = selected(document, ['r', 'c1']);
    press(target, at(5, 205), at(6, 205));
    const o = 4 - (joint.x + 1);
    const mx = 1 + o;
    expect(frameOf(target, 'r')).toEqual(f(0 + mx, 200, 10, 10));
    const d = rotate(-0.3, mx, 0);
    expect(frameOf(target, 'c1')).toEqual(f(10 + d.x, 10 + d.y, 10, 10));
    expect(snapOf(target)).toEqual(overlay([seg(4, joint.y, 4, 410)]));
    input(target, 'pointerup', at(6, 205));
    expect(undoDepth(target)).toBe(1);
  });
});

describe('M2-A04 snapping: candidate set and scope (snap module)', () => {
  const DOC = page([
    rect('k', 'p1', f(0, 0, 10, 10)),
    container('group', 'g', 'p1', ['ga', 'gb'], f(0, 100, 60, 10)),
    rect('ga', 'g', f(0, 0, 10, 10)),
    rect('gb', 'g', f(50, 0, 10, 10)),
    container('maskGroup', 'mg', 'p1', ['mp', 'mr', 'mr2'], f(0, 200, 60, 60)),
    triangle('mp', 'mg', f(0, 0, 60, 60)),
    rect('mr', 'mg', f(0, 0, 10, 10)),
    rect('mr2', 'mg', f(20, 0, 10, 10)),
    container('frame', 'fr', 'p1', ['fc'], f(200, 0, 100, 100)),
    rect('fc', 'fr', f(0, 0, 10, 10)),
    rect('last', 'p1', f(400, 0, 10, 10)),
  ]) as unknown as DocumentV5;
  const ids = (scope: string | null, moving: string[]) =>
    snapSet(DOC, 'p1', scope, moving).candidates.map((candidate) => candidate.id);

  it('orders candidates in document pre-order of the page', () => {
    expect(ids(null, [])).toEqual(['k', 'g', 'mg', 'fr', 'fc', 'last']);
    const set = snapSet(DOC, 'p1', null, []);
    expect(set.candidates.map((candidate) => candidate.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(set.candidates[4]!.box).toEqual({ left: 200, top: 0, right: 210, bottom: 10 });
  });

  it('inside a scope: the scope’s children and the top-level frames’ children only', () => {
    expect(ids('g', ['ga'])).toEqual(['gb', 'fc']);
    // A mask group's source is never a candidate.
    expect(ids('mg', ['mr'])).toEqual(['mr2', 'fc']);
    expect(ids('mg', [])).toEqual(['mr', 'mr2', 'fc']);
  });
});

describe('M2-A04 snapping: resize', () => {
  it('a p5 resize offers only the edges the handle moves, no spacing', () => {
    const document = page([
      rect('r', 'p1', f(0, 0, 100, 50)),
      rect('k', 'p1', f(103, 200, 10, 10)),
      rect('k2', 'p1', f(52, 300, 5, 5)),
    ]);
    const target = selected(document, ['r']);
    press(target, at(100, 25), at(101, 25));
    expect(frameOf(target, 'r')).toEqual(f(0, 0, 103, 50));
    expect(snapOf(target)).toEqual(overlay([seg(103, 0, 103, 210)]));
    input(target, 'pointerup', at(101, 25));
    expect(snapOf(target)).toBeNull();
    expect(undoDepth(target)).toBe(1);
    // A right neighbour 10 past a reference gap of 10 would offer spacing to a move, not here.
    const spaced = selected(
      page([
        rect('r', 'p1', f(0, 0, 100, 50)),
        rect('p', 'p1', f(200, 0, 10, 50)),
        rect('q', 'p1', f(220, 0, 10, 50)),
      ]),
      ['r'],
    );
    press(spaced, at(100, 25), at(191, 25));
    expect(frameOf(spaced, 'r')).toEqual(f(0, 0, 191, 50));
    expect(snapOf(spaced)).toBeNull();
  });

  it('a map resize snaps like the same resize by raw + o without snapping', () => {
    const document = page([
      container('frame', 'fr', 'p1', ['c'], f(300, 0, 100, 100)),
      rect('c', 'fr', f(0, 0, 10, 10)),
      rect('r', 'p1', f(0, 0, 100, 50)),
      rect('k', 'p1', f(313, 200, 10, 10)),
    ]);
    const target = selected(document, ['r', 'c']);
    press(target, at(310, 25), at(311, 25));
    expect(snapOf(target)).toEqual(overlay([seg(313, 0, 313, 210)]));
    input(target, 'pointerup', at(311, 25));
    const reference = unsnapped(document, ['r', 'c']);
    drag(reference, at(310, 25), at(313, 25));
    expect(text(target)).toBe(text(reference));
  });

  it('a single node whose page rotation is 0 snaps; a rotated one does not', () => {
    const document = (rotation: number) =>
      page([
        container('frame', 'fr', 'p1', ['c'], f(300, 0, 100, 100)),
        rect('c', 'fr', f(0, 0, 10, 10), rotation),
        rect('k', 'p1', f(313, 200, 10, 10)),
      ]);
    const target = selected(document(0), ['c']);
    press(target, at(310, 5), at(311, 5));
    expect(frameOf(target, 'c')).toEqual(f(0, 0, 13, 10));
    expect(snapOf(target)).toEqual(overlay([seg(313, 0, 313, 210)]));
    input(target, 'pointerup', at(311, 5));
    const reference = unsnapped(document(0), ['c']);
    drag(reference, at(310, 5), at(313, 5));
    expect(text(target)).toBe(text(reference));

    const turned = selected(document(0.3), ['c']);
    const handle = turned.query({ type: 'handles' })!.handles[3]!;
    const end = at(handle.x + 1, handle.y);
    press(turned, handle, end);
    expect(snapOf(turned)).toBeNull();
    input(turned, 'pointerup', end);
    const plain = unsnapped(document(0.3), ['c']);
    drag(plain, handle, end);
    expect(text(turned)).toBe(text(plain));
  });
});

describe('M2-A04 snapping: drawing tools', () => {
  const DOC = page([rect('k', 'p1', f(50, 100, 10, 10))]);

  it('snaps the rectangle tool’s dragged corner', () => {
    const target = editor(DOC);
    ok(target, { type: 'setTool', tool: 'rectangle' });
    press(target, at(0, 0), at(47, 52));
    expect(snapOf(target)).toEqual(overlay([seg(50, 52, 50, 110)]));
    input(target, 'pointerup', at(47, 52));
    const [id] = target.query({ type: 'selection' });
    expect(frameOf(target, id!)).toEqual(f(0, 0, 50, 52));
    expect(snapOf(target)).toBeNull();
    expect(undoDepth(target)).toBe(1);
  });

  it('snaps the frame tool’s dragged corner on y', () => {
    const target = editor(DOC);
    ok(target, { type: 'setTool', tool: 'frame' });
    press(target, at(0, 0), at(20, 97));
    expect(snapOf(target)).toEqual(overlay([seg(20, 100, 60, 100)]));
    input(target, 'pointerup', at(20, 97));
    const [id] = target.query({ type: 'selection' });
    expect(frameOf(target, id!)).toEqual(f(0, 0, 20, 100));
  });

  it('snaps the line tool’s end, except under the Shift constraint', () => {
    const target = editor(DOC);
    ok(target, { type: 'setTool', tool: 'line' });
    press(target, at(0, 0), at(47, 52));
    expect(snapOf(target)).toEqual(overlay([seg(50, 52, 50, 110)]));
    input(target, 'pointerup', at(47, 52));
    const reference = editor(DOC);
    ok(reference, { type: 'setTool', tool: 'line' });
    drag(reference, at(0, 0), at(50, 52));
    expect(text(target)).toBe(text(reference));

    const constrained = editor(DOC);
    ok(constrained, { type: 'setTool', tool: 'line' });
    press(constrained, at(0, 0), at(47, 52), shift);
    expect(snapOf(constrained)).toBeNull();
    input(constrained, 'pointerup', at(47, 52), shift);
    const plain = unsnapped(DOC, []);
    ok(plain, { type: 'setTool', tool: 'line' });
    drag(plain, at(0, 0), at(47, 52), shift);
    expect(text(constrained)).toBe(text(plain));
  });
});

describe('M2-A04 snapping: rotation angles', () => {
  // `r` pivots about (50, 25); the press is in its top-right rotate zone.
  const ZONE = at(110, -10);
  const PIVOT = at(50, 25);
  const phi0 = Math.atan2(ZONE.y - PIVOT.y, ZONE.x - PIVOT.x);
  const toward = (phi: number, radius: number) =>
    at(PIVOT.x + radius * Math.cos(phi), PIVOT.y + radius * Math.sin(phi));
  const sweep = (q: PagePoint) => {
    const a = Math.atan2(q.y - PIVOT.y, q.x - PIVOT.x) - phi0;
    return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
  };
  const DOC = page([rect('r', 'p1', f(0, 0, 100, 50)), rect('k', 'p1', f(300, 300, 10, 10), 0.3)]);
  const rotationOf = (target: Editor) => target.query({ type: 'node', id: 'r' })!.rotation;

  it('snaps one node to a multiple of π/2 within T / r, one undo step', () => {
    const target = selected(DOC, ['r']);
    const before = text(target);
    press(target, ZONE, toward(phi0 + Math.PI / 2 + 0.02, 60));
    expect(rotationOf(target)).toBe(Math.PI / 2);
    expect(frameOf(target, 'r')).toEqual(f(0, 0, 100, 50));
    expect(snapOf(target)).toEqual(overlay([], [], Math.PI / 2));
    input(target, 'pointerup', toward(phi0 + Math.PI / 2 + 0.02, 60));
    expect(snapOf(target)).toBeNull();
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
  });

  it('snaps to a candidate’s page rotation', () => {
    const target = selected(DOC, ['r']);
    press(target, ZONE, toward(phi0 + 0.305, 60));
    expect(rotationOf(target)).toBe(0.3);
    expect(snapOf(target)).toEqual(overlay([], [], 0.3));
  });

  it('wraps: just above −π snaps to π', () => {
    const target = selected(DOC, ['r']);
    press(target, ZONE, toward(phi0 - Math.PI + 0.01, 50));
    expect(rotationOf(target)).toBe(Math.PI);
    expect(snapOf(target)).toEqual(overlay([], [], Math.PI));
  });

  it('does not snap beyond the 6 px arc, at r = 0, with Ctrl or with snapping off', () => {
    const far = selected(DOC, ['r']);
    const q = toward(phi0 + Math.PI / 2 + 0.2, 60);
    press(far, ZONE, q);
    expect(rotationOf(far)).toBe(sweep(q));
    expect(snapOf(far)).toBeNull();
    // r = 0: the pointer on the pivot gives no angle snap (the reach would be infinite).
    const centre = selected(DOC, ['r']);
    press(centre, ZONE, PIVOT);
    expect(rotationOf(centre)).toBe(sweep(PIVOT));
    expect(snapOf(centre)).toBeNull();
    const near = toward(phi0 + Math.PI / 2 + 0.02, 60);
    const held = selected(DOC, ['r']);
    press(held, ZONE, near, ctrl);
    expect(rotationOf(held)).toBe(sweep(near));
    expect(snapOf(held)).toBeNull();
    const off = unsnapped(DOC, ['r']);
    press(off, ZONE, near);
    expect(rotationOf(off)).toBe(sweep(near));
    expect(snapOf(off)).toBeNull();
  });

  it('shows the Shift step as the overlay angle, for one node and for several', () => {
    const one = selected(DOC, ['r']);
    press(one, ZONE, toward(phi0 + 0.3, 60), shift);
    expect(rotationOf(one)).toBe(Math.PI / 12);
    expect(snapOf(one)).toEqual(overlay([], [], Math.PI / 12));
    input(one, 'pointerup', toward(phi0 + 0.3, 60), shift);
    expect(snapOf(one)).toBeNull();

    const several = selected(DOC, ['r', 'k']);
    const [, tr] = several.query({ type: 'handles' })!.corners;
    const start = at(tr.x + 8, tr.y - 8);
    // Without Shift, several nodes never angle-snap.
    press(several, start, at(start.x - 40, start.y + 300));
    expect(snapOf(several)).toBeNull();
    const plain = unsnapped(DOC, ['r', 'k']);
    press(plain, start, at(start.x - 40, start.y + 300));
    expect(text(several)).toBe(text(plain));
    const q = at(start.x - 40, start.y + 300);
    input(several, 'pointermove', q, shift);
    // The pivot is the handle-box centre fixed at press; `a` is the sweep from the press to q.
    const box = boundsOf(DOC as unknown as DocumentV5, ['r', 'k'])!;
    const pivot = at(box.x + box.width / 2, box.y + box.height / 2);
    const a = normalizeRotation(
      Math.atan2(q.y - pivot.y, q.x - pivot.x) - Math.atan2(start.y - pivot.y, start.x - pivot.x),
    );
    const step = Math.PI / 12;
    const angle = normalizeRotation(Math.round(a / step) * step);
    expect(angle).not.toBe(0);
    expect(snapOf(several)).toEqual(overlay([], [], angle));
  });

  it('ties (snap module): a multiple of π/2, then the lesser target', () => {
    const set = snapSet(
      page([
        rect('a', 'p1', f(0, 0, 10, 10), 0.25),
        rect('b', 'p1', f(0, 0, 10, 10), 0.75),
        rect('c', 'p1', f(0, 0, 10, 10), -0.25),
      ]) as unknown as DocumentV5,
      'p1',
      null,
      [],
    );
    // 0.25 and 0.75 are both 0.25 from 0.5: the lesser target wins.
    expect(snapAngle(set, 0.5, 1, 1)).toBe(0.25);
    // 0 and −0.25 are both 0.125 from −0.125: the multiple of π/2 wins over the lesser target.
    expect(snapAngle(set, -0.125, 1, 1)).toBe(0);
    // The reach is threshold / r, and r = 0 never snaps.
    expect(snapAngle(set, 0.5, 8, 1)).toBeNull();
    expect(snapAngle(set, 0.5, 0, 1)).toBeNull();
    // The distance wraps: −π + 0.01 is 0.01 from π.
    expect(snapAngle(set, -Math.PI + 0.01, 1, 0.02)).toBe(Math.PI);
  });
});

describe('M2-A04 snapping: review follow-ups', () => {
  it('ties: a spacing offer wins over a centring offer of equal |o|', () => {
    // G = {20, 40}; B = [22.5, 32.5]: the right offer 50 − 20 − 32.5 = −2.5 and the centring
    // offer (10 + 50) / 2 − 27.5 = 2.5; spacing wins.
    const target = editor(
      page([
        tall('p', -30, 10),
        tall('a', 0, 10),
        tall('e', 50, 10),
        rect('m', 'p1', f(12.5, 30, 10, 11)),
      ]),
    );
    press(target, at(17, 35), at(27, 35));
    expect(frameOf(target, 'm')).toEqual(f(20, 30, 10, 11));
    expect(snapOf(target)).toEqual(overlay([], [seg(-20, 50, 0, 50), seg(30, 35.5, 50, 35.5)]));
  });

  it('ties: an align offer wins over a centring offer of equal |o|', () => {
    // B = [22, 32]: k.right = 19 gives −3 for the left edge, centring (10 + 50) / 2 − 27 gives +3.
    const target = editor(
      page([
        tall('a', 0, 10),
        tall('e', 50, 10),
        rect('k', 'p1', f(14, 300, 5, 5)),
        rect('m', 'p1', f(12, 30, 10, 11)),
      ]),
    );
    press(target, at(17, 35), at(27, 35));
    expect(frameOf(target, 'm')).toEqual(f(19, 30, 10, 11));
    expect(snapOf(target)).toEqual(overlay([seg(19, 30, 19, 305)]));
  });

  // Rows for x spacing (y [0, 200]) and columns for y spacing (x [0, 200]); `m` at [30, 40]².
  const row = (id: string, x: number, width: number) => rect(id, 'p1', f(x, 0, width, 200));
  const column = (id: string, y: number, height: number) => rect(id, 'p1', f(0, y, 200, height));
  const columns = [column('ca', 0, 10), column('cb', 20, 10), column('cc', 25, 10)];

  it('orders x gaps before y gaps when both axes snap by spacing', () => {
    const target = editor(
      page([
        row('ra', 0, 10),
        row('rb', 20, 10),
        row('rc', 25, 10),
        ...columns,
        rect('m', 'p1', f(30, 30, 10, 10)),
      ]),
    );
    press(target, at(36, 36), at(47, 47));
    expect(frameOf(target, 'm')).toEqual(f(45, 45, 10, 10));
    expect(snapOf(target)).toEqual(
      overlay(
        [],
        [seg(10, 100, 20, 100), seg(35, 50, 45, 50), seg(100, 10, 100, 20), seg(50, 35, 50, 45)],
      ),
    );
  });

  it('mixes an x align guide with y spacing gaps', () => {
    // B = [41, 51]²: x.right = 38.5 gives −2.5 on x; the columns' gap 10 gives +4 on y.
    const target = editor(
      page([...columns, rect('x', 'p1', f(0, 300, 38.5, 10)), rect('m', 'p1', f(30, 30, 10, 10))]),
    );
    press(target, at(36, 36), at(47, 47));
    expect(frameOf(target, 'm')).toEqual(f(38.5, 45, 10, 10));
    expect(snapOf(target)).toEqual(
      overlay([seg(38.5, 45, 38.5, 310)], [seg(100, 10, 100, 20), seg(43.5, 35, 43.5, 45)]),
    );
  });

  it('a move snapped back to its origin records no step, with a commit event to resync', () => {
    const target = editor(EXAMPLE);
    const before = text(target);
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    // B = [31, 41]: b.right = 30 gives o = −1, so the snapped delta is 0.
    drag(target, at(36, 35), at(37, 35));
    expect(text(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
    const commits = seen.filter((e) => e.type === 'document' && e.cause === 'gesture-commit');
    expect(commits).toEqual([
      expect.objectContaining({ type: 'document', cause: 'gesture-commit', touched: ['m'] }),
    ]);
    expect(target.execute({ type: 'undo' })).toEqual({ ok: false, code: 'editor.nothing-to-undo' });
  });

  it('a resize snapped back to its origin records no step', () => {
    const target = selected(
      page([rect('r', 'p1', f(0, 0, 100, 50)), rect('k', 'p1', f(100, 200, 10, 10))]),
      ['r'],
    );
    const before = text(target);
    drag(target, at(100, 25), at(101, 25));
    expect(text(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
  });

  it('a one-node angle snap back to the stored rotation replaces with nothing', () => {
    const document = page([rect('r', 'p1', f(0, 0, 100, 50), Math.PI / 2)]);
    const target = selected(document, ['r']);
    const before = text(target);
    const pivot = at(50, 25);
    const [, tr] = target.query({ type: 'handles' })!.corners;
    const length = Math.hypot(tr.x - pivot.x, tr.y - pivot.y);
    const out = (length + 10) / length;
    const start = at(pivot.x + (tr.x - pivot.x) * out, pivot.y + (tr.y - pivot.y) * out);
    const q = at(
      pivot.x + (start.x - pivot.x) * Math.cos(0.02) - (start.y - pivot.y) * Math.sin(0.02),
      pivot.y + (start.x - pivot.x) * Math.sin(0.02) + (start.y - pivot.y) * Math.cos(0.02),
    );
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    press(target, start, q);
    expect(snapOf(target)).toEqual(overlay([], [], Math.PI / 2));
    input(target, 'pointerup', q);
    expect(text(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
    expect(seen.filter((e) => e.type === 'document')).toEqual([]);
  });

  it('setSnapping off during a gesture clears the overlay at once, with one event', () => {
    const target = editor(EXAMPLE);
    press(target, at(36, 35), at(47, 35));
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    ok(target, { type: 'setSnapping', enabled: false });
    expect(snapOf(target)).toBeNull();
    expect(seen).toEqual([
      { type: 'session', field: 'snapping' },
      { type: 'session', field: 'snap' },
    ]);
    expect(internalsOf(target).gesture.active).toBe(true);
    input(target, 'pointermove', at(47, 35));
    expect(frameOf(target, 'm')).toEqual(f(41, 30, 10, 11));
  });

  it.each([
    ['Control', ctrl],
    ['Meta', meta],
  ] as const)('a %s key-down during a gesture clears the overlay at once', (name, modifiers) => {
    const target = editor(EXAMPLE);
    press(target, at(36, 35), at(47, 35));
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    target.execute({ type: 'input', event: { kind: 'keydown', key: name, modifiers } });
    expect(snapOf(target)).toBeNull();
    expect(seen).toEqual([{ type: 'session', field: 'snap' }]);
    expect(internalsOf(target).gesture.active).toBe(true);
    input(target, 'pointermove', at(47, 35), modifiers);
    expect(frameOf(target, 'm')).toEqual(f(41, 30, 10, 11));
    expect(snapOf(target)).toBeNull();
  });
});
