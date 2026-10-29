import { serializeDocument, type DocumentV4, type Frame } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  createCounterIdSource,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type EditorEvent,
  type KeyBinding,
  type Modifiers,
} from '../../packages/editor-core/src/index.js';
// Source imports: the expected values restate the section 4.3 formulas with the package's own
// page-space helpers (boxes, parent spaces) and the edit draft (the M1 group refit).
import { Draft } from '../../packages/editor-core/src/draft.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { apply } from '../../packages/editor-core/src/geometry.js';
import { boundsOf } from '../../packages/editor-core/src/hit-test.js';
import { documentTree, spaceOf } from '../../packages/editor-core/src/tree.js';

// MVP M2-U4, M2-A05 to M2-A07 (M2 contract, section 4.3): align, distribute, reorder and nudge
// through `input` (default chords, and host bindings for align and distribute, which have none),
// across parents and in rotated containers, with the section 4.4 failure order. Values are the
// binary64 evaluation of the section's formulas (M2-Q14), literal where the arithmetic is exact.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });

type Loose = Record<string, unknown> & { id: string };

function base(id: string, parent: string, frame: Frame, rotation = 0) {
  return { id, name: id, parent, frame, rotation, constraints: START, opacity: 1, visible: true };
}

function rect(id: string, parent: string, frame: Frame, rotation = 0): Loose {
  return {
    ...base(id, parent, frame, rotation),
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

/**
 * Page p1: page-root rectangles `a` and `b`, a rotated rectangle `c`, a rotated group `g`
 * (`ga`, `gb`), a rotated frame `fr` (`fc` rotated, `fd`), a mask group `mg` with two path
 * children first (`mp`, `mq`) and two rectangles; page p2: `o`.
 */
const FIXTURE = doc(
  [
    ['p1', ['a', 'b', 'c', 'g', 'fr', 'mg']],
    ['p2', ['o']],
  ],
  [
    rect('a', 'p1', f(0, 0, 10, 10)),
    rect('b', 'p1', f(30, 20, 20, 10)),
    rect('c', 'p1', f(100, 50, 40, 20), 0.3),
    container('group', 'g', 'p1', ['ga', 'gb'], f(200, 0, 60, 40), 0.5),
    rect('ga', 'g', f(0, 0, 30, 20)),
    rect('gb', 'g', f(30, 20, 30, 20)),
    container('frame', 'fr', 'p1', ['fc', 'fd'], f(0, 300, 200, 100), -0.4),
    rect('fc', 'fr', f(10, 10, 40, 20), 0.1),
    rect('fd', 'fr', f(100, 50, 30, 30)),
    container('maskGroup', 'mg', 'p1', ['mp', 'mq', 'mr', 'ms'], f(500, 300, 50, 50)),
    triangle('mp', 'mg', f(0, 0, 50, 50)),
    triangle('mq', 'mg', f(5, 5, 40, 40)),
    rect('mr', 'mg', f(10, 10, 20, 20)),
    rect('ms', 'mg', f(20, 20, 10, 10)),
    rect('o', 'p2', f(0, 0, 10, 10)),
  ],
);

/** Host bindings for the actions without a default chord (section 8). */
const ARRANGE_KEYS: readonly KeyBinding[] = [
  { chord: 'Alt+1', action: 'align', args: { edge: 'left' } },
  { chord: 'Alt+2', action: 'align', args: { edge: 'hcenter' } },
  { chord: 'Alt+3', action: 'align', args: { edge: 'right' } },
  { chord: 'Alt+4', action: 'align', args: { edge: 'top' } },
  { chord: 'Alt+5', action: 'align', args: { edge: 'vcenter' } },
  { chord: 'Alt+6', action: 'align', args: { edge: 'bottom' } },
  { chord: 'Alt+7', action: 'distribute', args: { axis: 'horizontal' } },
  { chord: 'Alt+8', action: 'distribute', args: { axis: 'vertical' } },
];
const EDGE_KEYS = {
  left: '1',
  hcenter: '2',
  right: '3',
  top: '4',
  vcenter: '5',
  bottom: '6',
} as const;
type Edge = keyof typeof EDGE_KEYS;
const EDGES = Object.keys(EDGE_KEYS) as Edge[];
const alt: Modifiers = { ...none, alt: true };
const shift: Modifiers = { ...none, shift: true };
const ctrl: Modifiers = { ...none, ctrl: true };
const ctrlShift: Modifiers = { ...none, ctrl: true, shift: true };

function editor(document: unknown = FIXTURE): Editor {
  return createEditor({ ids: createCounterIdSource('n'), document, keymap: ARRANGE_KEYS });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function press(target: Editor, key: string, modifiers = none, repeat = false): CommandResult {
  return target.execute({ type: 'input', event: { kind: 'keydown', key, modifiers, repeat } });
}

function select(target: Editor, ids: readonly string[]) {
  ok(target, { type: 'setSelection', ids });
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const documentOf = (target: Editor) => target.query({ type: 'document' });
const nodeOf = (target: Editor, id: string) => target.query({ type: 'node', id })!;
const undoDepth = (target: Editor) => target.query({ type: 'history' }).undoDepth;
const childrenOf = (target: Editor, owner: string): readonly string[] => {
  const page = documentOf(target).pages.find((entry) => entry.id === owner);
  if (page !== undefined) return page.children;
  return (nodeOf(target, owner) as { children: readonly string[] }).children;
};

function events(target: Editor): EditorEvent[] {
  const seen: EditorEvent[] = [];
  target.subscribe((event) => seen.push(event));
  return seen;
}

/** The node's frame moved by the page vector `(dx, dy)` turned into its parent space. */
function translated(document: DocumentV4, id: string, dx: number, dy: number): Frame {
  const node = document.nodes[id]!;
  const chain = spaceOf(documentTree(document), node.parent).rotation;
  if (chain === 0) return { ...node.frame, x: node.frame.x + dx, y: node.frame.y + dy };
  const cos = Math.cos(-chain);
  const sin = Math.sin(-chain);
  return {
    ...node.frame,
    x: node.frame.x + (dx * cos - dy * sin),
    y: node.frame.y + (dx * sin + dy * cos),
  };
}

/** The expected document: each node set to its frame, then the M1 group refit. */
function expectedText(document: DocumentV4, frames: ReadonlyMap<string, Frame>): string {
  const draft = new Draft(document);
  for (const [id, frame] of frames) draft.set({ ...document.nodes[id]!, frame });
  const result = draft.finish(() => null);
  if ('ok' in result) throw new Error(result.code);
  return serializeDocument(result);
}

/** One undo step, byte-identical undo, and redo back to `after`. */
function expectOneStep(target: Editor, before: string, after: string) {
  expect(text(target)).toBe(after);
  expect(undoDepth(target)).toBe(1);
  ok(target, { type: 'undo' });
  expect(text(target)).toBe(before);
  ok(target, { type: 'redo' });
  expect(text(target)).toBe(after);
}

const isPageRoot = (document: DocumentV4, id: string) =>
  document.pages.some((page) => page.children.includes(id));

/**
 * The section 4.3 align frames: a page-root node with rotation 0 sets `x` or `y` exactly; any
 * other node moves by its box's value minus the target's, as a page translation.
 */
function alignFrames(document: DocumentV4, ids: readonly string[], edge: Edge, target: Frame) {
  const horizontal = edge === 'left' || edge === 'hcenter' || edge === 'right';
  const at =
    edge === 'left' || edge === 'top' ? 0 : edge === 'hcenter' || edge === 'vcenter' ? 0.5 : 1;
  const [low, size] = horizontal ? [target.x, target.width] : [target.y, target.height];
  const value = (origin: number, extent: number) =>
    at === 0 ? origin : at === 0.5 ? origin + extent / 2 : origin + extent;
  const frames = new Map<string, Frame>();
  for (const id of ids) {
    const node = document.nodes[id]!;
    if (isPageRoot(document, id) && node.rotation === 0) {
      const own = horizontal ? node.frame.width : node.frame.height;
      const exact = at === 0 ? low : at === 0.5 ? low + size / 2 - own / 2 : low + size - own;
      frames.set(id, horizontal ? { ...node.frame, x: exact } : { ...node.frame, y: exact });
      continue;
    }
    const box = boundsOf(document, [id])!;
    const delta = horizontal
      ? value(low, size) - value(box.x, box.width)
      : value(low, size) - value(box.y, box.height);
    frames.set(id, translated(document, id, horizontal ? delta : 0, horizontal ? 0 : delta));
  }
  return frames;
}

/** The page-space centre of a node's rotated frame. */
function pageCentre(document: DocumentV4, id: string) {
  const node = document.nodes[id]!;
  const { matrix } = spaceOf(documentTree(document), node.parent);
  const { x, y, width, height } = node.frame;
  return apply(matrix, x + width / 2, y + height / 2);
}

describe('M2-A05 align', () => {
  it.each(EDGES)('aligns %s across parents, rotated nodes moving by their box', (edge) => {
    const target = editor();
    const before = documentOf(target);
    // Listed order is not paint order; `ga` is in a rotated group, `fc` in a rotated frame.
    const ids = ['fc', 'b', 'c', 'ga', 'a'];
    select(target, ids);
    const union = boundsOf(before, ids)!;
    expect(press(target, EDGE_KEYS[edge], alt)).toEqual({ ok: true, ids: [], consumed: true });
    const frames = alignFrames(before, ids, edge, union);
    expectOneStep(target, serializeDocument(before), expectedText(before, frames));
    // Each box now sits on the target edge (exact for the page-root nodes).
    const after = documentOf(target);
    for (const id of ids) {
      const box = boundsOf(after, [id])!;
      const [v, t] =
        edge === 'left'
          ? [box.x, union.x]
          : edge === 'right'
            ? [box.x + box.width, union.x + union.width]
            : edge === 'top'
              ? [box.y, union.y]
              : edge === 'bottom'
                ? [box.y + box.height, union.y + union.height]
                : edge === 'hcenter'
                  ? [box.x + box.width / 2, union.x + union.width / 2]
                  : [box.y + box.height / 2, union.y + union.height / 2];
      expect(v, id).toBeCloseTo(t, 9);
    }
  });

  it('sets page-root x and y exactly: target.x, the centre minus w / 2, the edge minus w', () => {
    // The union of a (0, 0, 10, 10), b (30, 20, 20, 10) and c's box.
    const before = documentOf(editor());
    const union = boundsOf(before, ['a', 'b', 'c'])!;
    const cases: [Edge, string, number][] = [
      ['left', 'x', union.x],
      ['hcenter', 'x', union.x + union.width / 2 - 20 / 2],
      ['right', 'x', union.x + union.width - 20],
      ['top', 'y', union.y],
      ['vcenter', 'y', union.y + union.height / 2 - 10 / 2],
      ['bottom', 'y', union.y + union.height - 10],
    ];
    for (const [edge, axis, value] of cases) {
      const target = editor();
      select(target, ['a', 'b', 'c']);
      press(target, EDGE_KEYS[edge], alt);
      expect((nodeOf(target, 'b').frame as Record<string, number>)[axis], edge).toBe(value);
    }
    // Literal: a and b only, left to 0 and bottom to 30.
    const target = editor();
    select(target, ['a', 'b']);
    press(target, '1', alt);
    expect(nodeOf(target, 'b').frame).toEqual(f(0, 20, 20, 10));
    press(target, '6', alt);
    expect(nodeOf(target, 'a').frame).toEqual(f(0, 20, 10, 10));
    press(target, '3', alt);
    expect(nodeOf(target, 'a').frame).toEqual(f(10, 20, 10, 10));
    expect(undoDepth(target)).toBe(3);
  });

  it('moves rotated containers rigidly: children keep their stored frames, groups refit', () => {
    const target = editor();
    const before = documentOf(target);
    const ids = ['g', 'fr', 'a'];
    select(target, ids);
    press(target, '4', alt);
    const frames = alignFrames(before, ids, 'top', boundsOf(before, ids)!);
    expectOneStep(target, serializeDocument(before), expectedText(before, frames));
    for (const child of ['ga', 'gb', 'fc', 'fd']) {
      expect(nodeOf(target, child)).toBe(before.nodes[child]);
    }
    expect(nodeOf(target, 'g').rotation).toBe(0.5);
  });

  it('aligns one node to its nearest frame ancestor, also in a rotated frame', () => {
    for (const edge of EDGES) {
      const target = editor();
      const before = documentOf(target);
      select(target, ['fc']);
      press(target, EDGE_KEYS[edge], alt);
      const frames = alignFrames(before, ['fc'], edge, boundsOf(before, ['fr'])!);
      expectOneStep(target, serializeDocument(before), expectedText(before, frames));
    }
  });

  it('one node without a frame ancestor changes nothing and records no step', () => {
    for (const id of ['a', 'c', 'ga', 'g']) {
      const target = editor();
      const before = documentOf(target);
      select(target, [id]);
      const seen = events(target);
      expect(press(target, '1', alt)).toEqual({ ok: true, ids: [], consumed: true });
      expect(documentOf(target)).toBe(before);
      expect(undoDepth(target)).toBe(0);
      expect(seen).toEqual([]);
    }
  });

  it('a listed descendant of a listed node is ignored: [g, ga] is one node', () => {
    const target = editor();
    const before = documentOf(target);
    expect(target.execute({ type: 'alignNodes', ids: ['g', 'ga'], edge: 'left' })).toEqual({
      ok: true,
      ids: [],
    });
    expect(documentOf(target)).toBe(before);
  });

  it('an alignment that changes nothing records no step and no event', () => {
    const target = editor(
      doc(
        [['p1', ['a', 'b']]],
        [rect('a', 'p1', f(0, 0, 10, 10)), rect('b', 'p1', f(0, 20, 30, 5))],
      ),
    );
    const before = documentOf(target);
    select(target, ['a', 'b']);
    const seen = events(target);
    expect(press(target, '1', alt)).toEqual({ ok: true, ids: [], consumed: true });
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
    expect(seen).toEqual([]);
  });

  it('an empty selection is a consumed no-op', () => {
    const target = editor();
    expect(press(target, '1', alt)).toEqual({ ok: true, ids: [], consumed: true });
    expect(press(target, '7', alt)).toEqual({ ok: true, ids: [], consumed: true });
    expect(undoDepth(target)).toBe(0);
  });
});

/** The section 4.3 distribute frames, from the sorted boxes. */
function distributeFrames(document: DocumentV4, ids: readonly string[], horizontal: boolean) {
  const order = document.pages[0]!.children.flatMap(function walk(id): string[] {
    const node = document.nodes[id] as { children?: readonly string[] };
    return [id, ...(node.children ?? []).flatMap(walk)];
  });
  const entries = ids
    .map((id) => {
      const box = boundsOf(document, [id])!;
      const [min, size] = horizontal ? [box.x, box.width] : [box.y, box.height];
      return { id, min, size, centre: min + size / 2, order: order.indexOf(id) };
    })
    .sort((p, q) => p.centre - q.centre || p.order - q.order);
  let total = 0;
  for (const entry of entries) total += entry.size;
  const first = entries[0]!;
  const last = entries[entries.length - 1]!;
  const gap = (last.min + last.size - first.min - total) / (entries.length - 1);
  const frames = new Map<string, Frame>();
  let previous = first.min + first.size;
  for (const entry of entries.slice(1, -1)) {
    const min = previous + gap;
    const node = document.nodes[entry.id]!;
    if (isPageRoot(document, entry.id) && node.rotation === 0) {
      // A page-root node with rotation 0 takes the new min exactly.
      frames.set(entry.id, horizontal ? { ...node.frame, x: min } : { ...node.frame, y: min });
    } else {
      const delta = min - entry.min;
      frames.set(
        entry.id,
        translated(document, entry.id, horizontal ? delta : 0, horizontal ? 0 : delta),
      );
    }
    previous = min + entry.size;
  }
  return { frames, gap, sorted: entries.map((entry) => entry.id) };
}

function row(frames: Frame[], order?: number[]) {
  const ids = frames.map((_, i) => `d${i + 1}`);
  const nodes = frames.map((frame, i) => rect(ids[i]!, 'p1', frame));
  return doc([['p1', order === undefined ? ids : order.map((i) => ids[i]!)]], nodes);
}

describe('M2-A05 distribute', () => {
  it('spaces page-root boxes evenly; the outer two stay (literal values)', () => {
    // S = 110 − 0, Σ = 40, gap = 35: d2.min = 10 + 35.
    const target = editor(row([f(0, 0, 10, 10), f(30, 0, 20, 10), f(100, 0, 10, 10)]));
    select(target, ['d3', 'd1', 'd2']);
    expect(press(target, '7', alt)).toEqual({ ok: true, ids: [], consumed: true });
    expect(nodeOf(target, 'd1').frame).toEqual(f(0, 0, 10, 10));
    expect(nodeOf(target, 'd2').frame).toEqual(f(45, 0, 20, 10));
    expect(nodeOf(target, 'd3').frame).toEqual(f(100, 0, 10, 10));
    expect(undoDepth(target)).toBe(1);
  });

  it('sets page-root mins exactly to the formula on non-integer frames', () => {
    // A deterministic generator (an LCG), so the cases are reproducible.
    let seed = 12345;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const round = (v: number) => Math.round(v * 100) / 100;
    for (let trial = 0; trial < 500; trial += 1) {
      const n = 3 + Math.floor(next() * 4);
      const frames = Array.from({ length: n }, () =>
        f(round(next() * 500), round(next() * 500), round(1 + next() * 80), round(1 + next() * 80)),
      );
      const horizontal = trial % 2 === 0;
      const target = editor(row(frames));
      const before = documentOf(target);
      const ids = frames.map((_, i) => `d${i + 1}`);
      select(target, ids);
      press(target, horizontal ? '7' : '8', alt);
      const expected = distributeFrames(before, ids, horizontal).frames;
      for (const id of ids) {
        const frame = expected.get(id) ?? before.nodes[id]!.frame;
        expect(nodeOf(target, id).frame, `${trial} ${id}`).toEqual(frame);
      }
    }
  });

  it('distributes vertically (literal values)', () => {
    // S = 100 − 0, Σ = 10 + 30 + 20 + 10 = 70, gap = 10.
    const target = editor(row([f(0, 0, 5, 10), f(0, 70, 5, 30), f(0, 20, 5, 20), f(0, 90, 5, 10)]));
    select(target, ['d1', 'd2', 'd3', 'd4']);
    press(target, '8', alt);
    expect(nodeOf(target, 'd3').frame).toEqual(f(0, 20, 5, 20));
    expect(nodeOf(target, 'd2').frame).toEqual(f(0, 50, 5, 30));
    expect(nodeOf(target, 'd4').frame).toEqual(f(0, 90, 5, 10));
  });

  it('a negative gap overlaps the boxes', () => {
    // Centres 25, 40, 75; S = 90, Σ = 120, gap = −15: d2.min = 50 − 15.
    const target = editor(row([f(0, 0, 50, 10), f(20, 0, 40, 10), f(60, 0, 30, 10)]));
    select(target, ['d1', 'd2', 'd3']);
    press(target, '7', alt);
    expect(nodeOf(target, 'd2').frame).toEqual(f(35, 0, 40, 10));
  });

  it('ties on the centre fall back to document pre-order', () => {
    // d2 and d4 both centre at 50; S = 110, Σ = 50, gap = 20.
    const frames = [f(0, 0, 10, 10), f(40, 0, 20, 10), f(100, 0, 10, 10), f(45, 0, 10, 10)];
    const first = editor(row(frames, [0, 3, 1, 2]));
    select(first, ['d1', 'd2', 'd3', 'd4']);
    press(first, '7', alt);
    // d4 is first in pre-order: d4.min = 10 + 20, d2.min = 40 + 20.
    expect(nodeOf(first, 'd4').frame.x).toBe(30);
    expect(nodeOf(first, 'd2').frame.x).toBe(60);
    const second = editor(row(frames, [0, 1, 3, 2]));
    select(second, ['d1', 'd2', 'd3', 'd4']);
    press(second, '7', alt);
    expect(nodeOf(second, 'd2').frame.x).toBe(30);
    expect(nodeOf(second, 'd4').frame.x).toBe(70);
  });

  it('distributes across parents and rotated nodes in page space', () => {
    for (const horizontal of [true, false]) {
      const target = editor();
      const before = documentOf(target);
      const ids = ['fd', 'a', 'c', 'ga', 'b', 'fc'];
      select(target, ids);
      press(target, horizontal ? '7' : '8', alt);
      const { frames } = distributeFrames(before, ids, horizontal);
      expectOneStep(target, serializeDocument(before), expectedText(before, frames));
    }
  });

  it('moves rotated containers rigidly', () => {
    const target = editor();
    const before = documentOf(target);
    const ids = ['a', 'g', 'fr', 'mg'];
    select(target, ids);
    press(target, '7', alt);
    const { frames } = distributeFrames(before, ids, true);
    expectOneStep(target, serializeDocument(before), expectedText(before, frames));
    for (const child of ['ga', 'gb', 'fc', 'fd', 'mp', 'mr']) {
      expect(nodeOf(target, child)).toBe(before.nodes[child]);
    }
  });

  it('fewer than 3 nodes is editor.too-few-nodes, also after the selection rule', () => {
    const target = editor();
    const before = documentOf(target);
    select(target, ['a', 'b']);
    expect(press(target, '7', alt)).toEqual({
      ok: false,
      code: 'editor.too-few-nodes',
      consumed: true,
    });
    expect(
      target.execute({ type: 'distributeNodes', ids: ['g', 'ga', 'a'], axis: 'vertical' }),
    ).toEqual({ ok: false, code: 'editor.too-few-nodes' });
    expect(documentOf(target)).toBe(before);
  });

  it('evenly spaced boxes record no step', () => {
    const target = editor(row([f(0, 0, 10, 10), f(20, 0, 10, 10), f(40, 0, 10, 10)]));
    const before = documentOf(target);
    select(target, ['d1', 'd2', 'd3']);
    const seen = events(target);
    expect(press(target, '7', alt)).toEqual({ ok: true, ids: [], consumed: true });
    expect(documentOf(target)).toBe(before);
    expect(seen).toEqual([]);
  });
});

/** Six page-root rectangles `r1` to `r6` and a group `q` of `q1` to `q4` on top. */
function stack() {
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
  return doc(
    [['p1', [...ids, 'q']]],
    [
      ...ids.map((id, i) => rect(id, 'p1', f(i * 20, 0, 10, 10))),
      container('group', 'q', 'p1', ['q1', 'q2', 'q3', 'q4'], f(0, 100, 70, 10)),
      ...['q1', 'q2', 'q3', 'q4'].map((id, i) => rect(id, 'q', f(i * 20, 0, 10, 10))),
    ],
  );
}

const REORDER_KEYS = {
  forward: [']', ctrl],
  backward: ['[', ctrl],
  front: ['}', ctrlShift],
  back: ['{', ctrlShift],
} as const;
type Op = keyof typeof REORDER_KEYS;

function reorder(target: Editor, ids: readonly string[], op: Op): CommandResult {
  select(target, ids);
  const [key, modifiers] = REORDER_KEYS[op];
  return press(target, key, modifiers);
}

describe('M2-A06 reorder', () => {
  it.each<[Op, string[]]>([
    ['forward', ['r1', 'r4', 'r2', 'r3', 'r6', 'r5', 'q']],
    ['backward', ['r2', 'r3', 'r1', 'r5', 'r4', 'r6', 'q']],
    ['front', ['r1', 'r4', 'r6', 'q', 'r2', 'r3', 'r5']],
    ['back', ['r2', 'r3', 'r5', 'r1', 'r4', 'r6', 'q']],
  ])('%s moves runs of listed children past the next unlisted sibling', (op, expected) => {
    const target = editor(stack());
    const before = text(target);
    expect(reorder(target, ['r5', 'r2', 'r3'], op)).toEqual({ ok: true, ids: [], consumed: true });
    expect(childrenOf(target, 'p1')).toEqual(expected);
    // A reorder keeps every node exactly; only the children order changes.
    const original = documentOf(editor(stack()));
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'q']) {
      expect(nodeOf(target, id), id).toEqual(original.nodes[id]);
    }
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
  });

  it('runs never pass each other: forward twice walks a run up one sibling at a time', () => {
    const target = editor(stack());
    reorder(target, ['r1', 'r2', 'r4'], 'forward');
    expect(childrenOf(target, 'p1')).toEqual(['r3', 'r1', 'r2', 'r5', 'r4', 'r6', 'q']);
    reorder(target, ['r1', 'r2', 'r4'], 'forward');
    expect(childrenOf(target, 'p1')).toEqual(['r3', 'r5', 'r1', 'r2', 'r6', 'r4', 'q']);
    reorder(target, ['r1', 'r2', 'r4'], 'backward');
    expect(childrenOf(target, 'p1')).toEqual(['r3', 'r1', 'r2', 'r5', 'r4', 'r6', 'q']);
  });

  it('handles several parents independently', () => {
    const target = editor(stack());
    reorder(target, ['q2', 'r6', 'q3'], 'forward');
    expect(childrenOf(target, 'p1')).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'q', 'r6']);
    expect(childrenOf(target, 'q')).toEqual(['q1', 'q4', 'q2', 'q3']);
    expect(undoDepth(target)).toBe(1);
    reorder(target, ['q2', 'r1'], 'back');
    expect(childrenOf(target, 'q')).toEqual(['q2', 'q1', 'q4', 'q3']);
    expect(childrenOf(target, 'p1')[0]).toBe('r1');
    expect(undoDepth(target)).toBe(2);
  });

  it.each<[Op, string[]]>([
    ['forward', ['q']],
    ['forward', ['q', 'r6']],
    ['front', ['r6', 'q']],
    ['backward', ['r1', 'r2']],
    ['back', ['r1']],
    ['back', ['q1', 'r1']],
  ])('%s of %j, already at the end, records no step and no event', (op, ids) => {
    const target = editor(stack());
    const before = documentOf(target);
    select(target, ids);
    const seen = events(target);
    const [key, modifiers] = REORDER_KEYS[op];
    expect(press(target, key, modifiers)).toEqual({ ok: true, ids: [], consumed: true });
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
    expect(seen).toEqual([]);
  });

  it('keeps a path as the mask group first child, else editor.invalid-mask-source', () => {
    const failing: [Op, string[]][] = [
      ['back', ['mr']],
      ['forward', ['mp', 'mq']],
      ['front', ['mp', 'mq']],
    ];
    for (const [op, ids] of failing) {
      const target = editor();
      const before = documentOf(target);
      expect(reorder(target, ids, op), `${op} ${ids.join()}`).toEqual({
        ok: false,
        code: 'editor.invalid-mask-source',
        path: '/nodes/mg/children/0',
        consumed: true,
      });
      expect(documentOf(target)).toBe(before);
    }
    // A path may take the source's place: mq backward, or mp forward past mq.
    const target = editor();
    reorder(target, ['mq'], 'backward');
    expect(childrenOf(target, 'mg')).toEqual(['mq', 'mp', 'mr', 'ms']);
    reorder(target, ['mq'], 'forward');
    expect(childrenOf(target, 'mg')).toEqual(['mp', 'mq', 'mr', 'ms']);
    reorder(target, ['mp'], 'forward');
    expect(childrenOf(target, 'mg')).toEqual(['mq', 'mp', 'mr', 'ms']);
    reorder(target, ['mr'], 'front');
    expect(childrenOf(target, 'mg')).toEqual(['mq', 'mp', 'ms', 'mr']);
    expect(undoDepth(target)).toBe(4);
  });
});

const ARROWS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
} as const;

describe('M2-A07 nudge', () => {
  it('moves page-root nodes by 1 and, with Shift, 10 page units exactly', () => {
    const target = editor();
    select(target, ['b']);
    for (const [key, [dx, dy]] of Object.entries(ARROWS)) {
      const before = nodeOf(target, 'b').frame;
      expect(press(target, key)).toEqual({ ok: true, ids: [], consumed: true });
      expect(nodeOf(target, 'b').frame).toEqual({ ...before, x: before.x + dx, y: before.y + dy });
      press(target, key, shift);
      expect(nodeOf(target, 'b').frame).toEqual({
        ...before,
        x: before.x + 11 * dx,
        y: before.y + 11 * dy,
      });
    }
    expect(nodeOf(target, 'b').frame).toEqual(f(30, 20, 20, 10));
    expect(undoDepth(target)).toBe(8);
  });

  it('gives the same document at zoom 0.5, 1 and 8', () => {
    const results = [0.5, 1, 8].map((zoom) => {
      const target = editor();
      ok(target, { type: 'setViewport', camera: { position: { x: 7, y: 3 }, zoom } });
      select(target, ['a', 'fc', 'ga']);
      press(target, 'ArrowRight');
      press(target, 'ArrowDown', shift);
      return text(target);
    });
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it('children of rotated containers move by the page vector turned into their parent space', () => {
    for (const [key, modifiers, dx, dy] of [
      ['ArrowRight', none, 1, 0],
      ['ArrowUp', shift, 0, -10],
    ] as const) {
      const target = editor();
      const before = documentOf(target);
      const ids = ['fc', 'ga', 'a', 'c'];
      select(target, ids);
      press(target, key, modifiers);
      const frames = new Map(ids.map((id) => [id, translated(before, id, dx, dy)] as const));
      expectOneStep(target, serializeDocument(before), expectedText(before, frames));
      // In page space each node moved by (dx, dy), up to the rotation's rounding.
      const after = documentOf(target);
      for (const id of ['fc', 'a', 'c']) {
        const from = pageCentre(before, id);
        const to = pageCentre(after, id);
        expect(to.x - from.x, id).toBeCloseTo(dx, 9);
        expect(to.y - from.y, id).toBeCloseTo(dy, 9);
      }
    }
  });

  it('each press is one step, auto-repeat included', () => {
    const target = editor();
    const before = text(target);
    select(target, ['a', 'ga']);
    press(target, 'ArrowRight');
    press(target, 'ArrowRight', none, true);
    press(target, 'ArrowRight', none, true);
    expect(nodeOf(target, 'a').frame).toEqual(f(3, 0, 10, 10));
    expect(undoDepth(target)).toBe(3);
    ok(target, { type: 'undo' });
    expect(nodeOf(target, 'a').frame).toEqual(f(2, 0, 10, 10));
    ok(target, { type: 'undo' });
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
  });

  it('does nothing on an empty selection or during a gesture (still consumed only then)', () => {
    const target = editor();
    const before = documentOf(target);
    expect(press(target, 'ArrowLeft')).toEqual({ ok: true, ids: [], consumed: true });
    expect(documentOf(target)).toBe(before);
    select(target, ['a']);
    target.execute({
      type: 'input',
      event: { kind: 'pointerdown', point: { x: 5, y: 5 }, modifiers: none },
    });
    expect(press(target, 'ArrowLeft')).toEqual({ ok: true, ids: [], consumed: false });
    expect(documentOf(target)).toBe(before);
  });

  it('a zero vector records no step', () => {
    const target = editor();
    const before = documentOf(target);
    expect(target.execute({ type: 'nudgeNodes', ids: ['a', 'fc'], dx: 0, dy: 0 })).toEqual({
      ok: true,
      ids: [],
    });
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
  });
});

describe('M2-A05 to A07 failure order (section 4.4)', () => {
  type Make = (ids: unknown) => Command;
  const commands: [string, Make, string, Make][] = [
    [
      'alignNodes',
      (ids) => ({ type: 'alignNodes', ids, edge: 'left' }) as Command,
      '/edge',
      (ids) => ({ type: 'alignNodes', ids, edge: 'middle' }) as unknown as Command,
    ],
    [
      'distributeNodes',
      (ids) => ({ type: 'distributeNodes', ids, axis: 'vertical' }) as Command,
      '/axis',
      (ids) => ({ type: 'distributeNodes', ids, axis: 'x' }) as unknown as Command,
    ],
    [
      'reorderNodes',
      (ids) => ({ type: 'reorderNodes', ids, op: 'front' }) as Command,
      '/op',
      (ids) => ({ type: 'reorderNodes', ids, op: 'top' }) as unknown as Command,
    ],
    [
      'nudgeNodes',
      (ids) => ({ type: 'nudgeNodes', ids, dx: 1, dy: 0 }) as Command,
      '/dx',
      (ids) => ({ type: 'nudgeNodes', ids, dx: Number.NaN, dy: 0 }) as Command,
    ],
    [
      'duplicateNodes',
      (ids) => ({ type: 'duplicateNodes', ids }) as Command,
      '/offset',
      (ids) => ({ type: 'duplicateNodes', ids, offset: { x: 1 } }) as unknown as Command,
    ],
  ];

  it.each(commands)('%s: /ids, then its fields, then unknown-node', (_, good, field, bad) => {
    const target = editor();
    const before = documentOf(target);
    const invalid = (path: string) => ({ ok: false, code: 'editor.invalid-command', path });
    expect(target.execute(good([]))).toEqual(invalid('/ids'));
    expect(target.execute(good('a'))).toEqual(invalid('/ids'));
    expect(target.execute(good(['a', 'a', 'b']))).toEqual(invalid('/ids'));
    expect(target.execute(good([1, 'a']))).toEqual(invalid('/ids'));
    // Empty `ids` before a bad field, a bad field before an unknown node.
    expect(target.execute(bad([]))).toEqual(invalid('/ids'));
    expect(target.execute(bad(['a', 'b', 'c']))).toEqual(invalid(field));
    expect(target.execute(bad(['missing', 'a', 'b']))).toEqual(invalid(field));
    // Unknown, and a node of another page.
    expect(target.execute(good(['a', 'b', 'missing']))).toEqual({
      ok: false,
      code: 'editor.unknown-node',
    });
    expect(target.execute(good(['a', 'b', 'o']))).toEqual({
      ok: false,
      code: 'editor.unknown-node',
    });
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
  });

  it('nudge checks dy as well', () => {
    const target = editor();
    expect(target.execute({ type: 'nudgeNodes', ids: ['a'], dx: 1, dy: Infinity })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/dy',
    });
    expect(
      target.execute({ type: 'nudgeNodes', ids: ['a'], dx: '1', dy: 0 } as unknown as Command),
    ).toEqual({ ok: false, code: 'editor.invalid-command', path: '/dx' });
  });

  it('unknown-node comes before too-few-nodes', () => {
    const target = editor();
    expect(
      target.execute({ type: 'distributeNodes', ids: ['a', 'missing'], axis: 'vertical' }),
    ).toEqual({ ok: false, code: 'editor.unknown-node' });
    expect(target.execute({ type: 'distributeNodes', ids: ['a', 'o'], axis: 'vertical' })).toEqual({
      ok: false,
      code: 'editor.unknown-node',
    });
  });

  it('a placement that breaks the model rules is document.invalid-field, changing nothing', () => {
    const target = editor(
      doc(
        [['p1', ['big', 'g2']]],
        [
          rect('big', 'p1', f(1e308, 0, 10, 10)),
          container('group', 'g2', 'p1', ['gc'], f(1e308, 0, 10, 10)),
          rect('gc', 'g2', f(0, 0, 10, 10)),
        ],
      ),
    );
    const before = documentOf(target);
    expect(target.execute({ type: 'nudgeNodes', ids: ['big'], dx: 1e308, dy: 0 })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/big/frame/x',
    });
    // The group refit after a child's move fails the same way.
    expect(target.execute({ type: 'nudgeNodes', ids: ['gc'], dx: 1e308, dy: 0 })).toMatchObject({
      ok: false,
      code: 'document.invalid-field',
    });
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
  });

  it('relative commands are rejected in a gesture update and run through replace', () => {
    const target = editor();
    const { gesture } = internalsOf(target);
    const before = documentOf(target);
    expect(gesture.begin()).toBe(true);
    for (const command of [
      { type: 'alignNodes', ids: ['a', 'b'], edge: 'left' },
      { type: 'distributeNodes', ids: ['a', 'b', 'c'], axis: 'vertical' },
      { type: 'reorderNodes', ids: ['a'], op: 'front' },
      { type: 'nudgeNodes', ids: ['a'], dx: 1, dy: 0 },
    ] as const) {
      expect(gesture.update(command)).toEqual({
        ok: false,
        code: 'editor.invalid-command',
        path: '/type',
      });
    }
    expect(documentOf(target)).toBe(before);
    // Through replace, two replaces do not compound.
    expect(gesture.replace([{ type: 'nudgeNodes', ids: ['a'], dx: 4, dy: 0 }]).ok).toBe(true);
    expect(gesture.replace([{ type: 'nudgeNodes', ids: ['a'], dx: 4, dy: 0 }]).ok).toBe(true);
    expect(nodeOf(target, 'a').frame).toEqual(f(4, 0, 10, 10));
    gesture.commit();
    expect(undoDepth(target)).toBe(1);
  });

  it('rejects malformed action args as editor.invalid-keymap', () => {
    const target = editor();
    for (const [binding, path] of [
      [{ chord: 'X', action: 'nudge' }, '/bindings/0/args'],
      [{ chord: 'X', action: 'nudge', args: { dx: 1 } }, '/bindings/0/args'],
      [{ chord: 'X', action: 'reorder', args: { op: 'up' } }, '/bindings/0/args'],
      [{ chord: 'X', action: 'align', args: { edge: 'middle' } }, '/bindings/0/args'],
      [{ chord: 'X', action: 'distribute' }, '/bindings/0/args'],
      [{ chord: 'X', action: 'duplicate', args: 3 }, '/bindings/0/args'],
      [{ chord: 'X', action: 'duplicate', args: { offset: { x: 1 } } }, '/bindings/0/args'],
    ] as const) {
      expect(target.execute({ type: 'setKeymap', bindings: [binding as KeyBinding] })).toEqual({
        ok: false,
        code: 'editor.invalid-keymap',
        path,
      });
    }
    expect(
      target.execute({
        type: 'setKeymap',
        bindings: [{ chord: 'X', action: 'duplicate', args: { offset: { x: 1, y: 2 } } }],
      }),
    ).toEqual({ ok: true, ids: [] });
  });
});
