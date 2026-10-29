import {
  normalizeRotation,
  serializeDocument,
  type DocumentV3,
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
} from '../../packages/editor-core/src/index.js';
// Source imports: the gesture API, the handle box and the tree geometry are package-internal.
import { Draft } from '../../packages/editor-core/src/draft.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { apply, invertRigid } from '../../packages/editor-core/src/geometry.js';
import { boundsOf } from '../../packages/editor-core/src/hit-test.js';
import { handleBoxOf, handleCentre } from '../../packages/editor-core/src/handles.js';
import { documentTree, spaceOf } from '../../packages/editor-core/src/tree.js';

// MVP M2-U2, M2-A03 (M2 contract, section 4.1 and S1): `rotateNodes` with the one-node pivot
// rule, gesture `replace` against `update`, and the select tool's rotate gesture through `input`
// (press precedence, Shift steps with Math.round halves, containers rigid, ancestors refit, one
// undo step, Escape and pointercancel). Values are the binary64 evaluation of the section's
// formulas (M2-Q14).

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const shift: Modifiers = { ...none, shift: true };
const STEP = Math.PI / 12;
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
 * Page p1: a page-root rectangle `r` and `s`, a rotated group `g` (children `ga`, `gb`), a
 * rotated frame `fr` holding a rectangle and a nested group, a mask group `mg`; page p2: `o`.
 */
const FIXTURE = doc(
  [
    ['p1', ['r', 's', 'g', 'fr', 'mg']],
    ['p2', ['o']],
  ],
  [
    rect('r', 'p1', f(0, 0, 100, 50)),
    rect('s', 'p1', f(200, 0, 40, 30)),
    container('group', 'g', 'p1', ['ga', 'gb'], f(400, 0, 60, 20), 0.3),
    rect('ga', 'g', f(0, 0, 30, 20)),
    rect('gb', 'g', f(30, 0, 30, 20)),
    container('frame', 'fr', 'p1', ['fc', 'fg'], f(0, 300, 200, 100), -0.4),
    rect('fc', 'fr', f(10, 10, 40, 20), 0.1),
    container('group', 'fg', 'fr', ['fga'], f(60, 10, 50, 30)),
    rect('fga', 'fg', f(0, 0, 50, 30)),
    container('maskGroup', 'mg', 'p1', ['mp', 'mr'], f(500, 300, 50, 50)),
    triangle('mp', 'mg', f(0, 0, 50, 50)),
    rect('mr', 'mg', f(10, 10, 20, 20)),
    rect('o', 'p2', f(0, 0, 10, 10)),
  ],
);

function editor(document: unknown = FIXTURE): Editor {
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

/** Press at `from`, move through `moves` and release at the last one. */
function drag(target: Editor, from: PagePoint, moves: readonly PagePoint[], modifiers = none) {
  input(target, 'pointerdown', from, modifiers);
  for (const point of moves) input(target, 'pointermove', point, modifiers);
  input(target, 'pointerup', moves[moves.length - 1]!, modifiers);
}

const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const documentOf = (target: Editor) => target.query({ type: 'document' });
const nodeOf = (target: Editor, id: string) => target.query({ type: 'node', id })!;
const undoDepth = (target: Editor) => target.query({ type: 'history' }).undoDepth;
const at = (x: number, y: number): PagePoint => ({ x, y });

/** The gesture's angle: the sweep about the pivot from the press to `q`, wrapped (−π, π]. */
function sweep(pivot: PagePoint, press: PagePoint, q: PagePoint): number {
  return normalizeRotation(
    Math.atan2(q.y - pivot.y, q.x - pivot.x) - Math.atan2(press.y - pivot.y, press.x - pivot.x),
  );
}

/** The Shift step: `normalize(Math.round(value / (π / 12)) · (π / 12))`. */
const stepped = (value: number) => normalizeRotation(Math.round(value / STEP) * STEP);

/**
 * The section 4.1 placement of one node rotated by `angle` about `pivot`: page rotation
 * `normalize(θ + angle)` stored minus the parent chain's, frame centre turned about the pivot
 * in page space and mapped back into the parent space, size kept; `keep` keeps `x` and `y`.
 */
function rotated(document: DocumentV3, id: string, angle: number, pivot: PagePoint, keep = false) {
  const node = document.nodes[id]!;
  const space = spaceOf(documentTree(document), node.parent);
  const rotation = normalizeRotation(
    normalizeRotation(space.rotation + node.rotation + angle) - space.rotation,
  );
  if (keep) return { frame: node.frame, rotation };
  const { x, y, width, height } = node.frame;
  const onPage = document.pages.some((page) => page.id === node.parent);
  const c = onPage
    ? at(x + width / 2, y + height / 2)
    : apply(space.matrix, x + width / 2, y + height / 2);
  const dx = c.x - pivot.x;
  const dy = c.y - pivot.y;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const turned = at(pivot.x + (dx * cos - dy * sin), pivot.y + (dx * sin + dy * cos));
  const local = onPage ? turned : apply(invertRigid(space.matrix), turned.x, turned.y);
  return { frame: f(local.x - width / 2 + 0, local.y - height / 2 + 0, width, height), rotation };
}

/** The expected document: `ids` placed by `rotated`, then the M1 group refit. */
function expectedText(
  document: DocumentV3,
  ids: readonly string[],
  angle: number,
  pivot: PagePoint,
  keep = false,
): string {
  const draft = new Draft(document);
  for (const id of ids)
    draft.set({ ...document.nodes[id]!, ...rotated(document, id, angle, pivot, keep) });
  const result = draft.finish(() => null);
  if ('ok' in result) throw new Error(result.code);
  return serializeDocument(result);
}

/** The expected document of a one-node Shift step: the stored rotation set, then the refit. */
function steppedText(document: DocumentV3, id: string, rotation: number): string {
  const draft = new Draft(document);
  draft.set({ ...document.nodes[id]!, rotation });
  const result = draft.finish(() => null);
  if ('ok' in result) throw new Error(result.code);
  return serializeDocument(result);
}

/**
 * Checks a one-node Shift rotation from `press` to `end`: the stored rotation is exactly
 * `normalize(normalize(k · π/12) − chain)`, x and y are kept, and undo is one step and
 * byte-identical.
 */
function checkStep(
  target: Editor,
  before: DocumentV3,
  id: string,
  press: PagePoint,
  end: PagePoint,
) {
  const pivot = pivotOf(target, [id]);
  drag(target, press, [end], shift);
  const node = before.nodes[id]!;
  const chain = spaceOf(documentTree(before), node.parent).rotation;
  const result = stepped(normalizeRotation(chain + node.rotation + sweep(pivot, press, end)));
  const rotation = normalizeRotation(result - chain);
  expect(nodeOf(target, id).rotation, id).toBe(rotation);
  if (chain === 0) expect(nodeOf(target, id).rotation, id).toBe(result);
  if (rotation === node.rotation) {
    expect(documentOf(target), id).toBe(before);
    return;
  }
  expect(text(target), id).toBe(steppedText(before, id, rotation));
  expect(undoDepth(target), id).toBe(1);
  ok(target, { type: 'undo' });
  expect(text(target), id).toBe(serializeDocument(before));
}

/** The pivot the tool fixes at press: the handle-box centre of the selection. */
function pivotOf(target: Editor, ids: readonly string[]): PagePoint {
  return handleCentre(handleBoxOf(documentOf(target), 'p1', ids)!);
}

describe('M2-A03 rotateNodes', () => {
  it('keeps x and y for one node without a pivot, also nested and rotated', () => {
    for (const [id, angle] of [
      ['r', Math.PI / 2],
      ['ga', 0.7],
      ['fc', -2.5],
      ['g', 1.1],
    ] as const) {
      const target = editor();
      const before = documentOf(target);
      const node = before.nodes[id]!;
      ok(target, { type: 'rotateNodes', ids: [id], angle });
      const space = spaceOf(documentTree(before), node.parent);
      // `ga` keeps them too, then its group refits around it (section 4.2).
      if (id !== 'ga') expect(nodeOf(target, id).frame).toEqual(node.frame);
      expect(nodeOf(target, id).rotation).toBe(
        normalizeRotation(
          normalizeRotation(space.rotation + node.rotation + angle) - space.rotation,
        ),
      );
      expect(text(target)).toBe(expectedText(before, [id], angle, at(0, 0), true));
    }
  });

  it('normalizes the page rotation into (−π, π]', () => {
    const target = editor();
    ok(target, { type: 'setFrames', frames: [{ id: 'r', frame: f(0, 0, 100, 50), rotation: 3 }] });
    ok(target, { type: 'rotateNodes', ids: ['r'], angle: 1 });
    expect(nodeOf(target, 'r').rotation).toBe(normalizeRotation(3 + 1));
    expect(nodeOf(target, 'r').rotation).toBeLessThan(0);
  });

  it('turns one node about a given pivot by the section formula', () => {
    const target = editor();
    const before = documentOf(target);
    const pivot = at(10, -20);
    ok(target, { type: 'rotateNodes', ids: ['r'], angle: 0.5, pivot });
    expect(nodeOf(target, 'r')).toMatchObject(rotated(before, 'r', 0.5, pivot));
    expect(text(target)).toBe(expectedText(before, ['r'], 0.5, pivot));
  });

  it('turns several nodes of different parents about the handle-box centre', () => {
    const target = editor();
    const before = documentOf(target);
    const ids = ['r', 'ga', 'fc'];
    const b = boundsOf(before, ids)!;
    const pivot = at(b.x + b.width / 2, b.y + b.height / 2);
    ok(target, { type: 'rotateNodes', ids, angle: -0.8 });
    expect(text(target)).toBe(expectedText(before, ids, -0.8, pivot));
    // The group holding `ga` refit at once (a command, not a gesture).
    expect(nodeOf(target, 'g').frame).not.toEqual(before.nodes.g!.frame);
  });

  it('turns containers rigidly: children stay as stored, frames do not refit', () => {
    for (const id of ['g', 'fr', 'mg', 'fg']) {
      const target = editor();
      const before = documentOf(target);
      const pivot = at(-50, 75);
      ok(target, { type: 'rotateNodes', ids: [id], angle: 0.9, pivot });
      const node = nodeOf(target, id);
      expect(node).toMatchObject(rotated(before, id, 0.9, pivot));
      for (const child of (before.nodes[id] as { children: readonly string[] }).children) {
        expect(nodeOf(target, child)).toBe(before.nodes[child]);
      }
      expect(text(target)).toBe(expectedText(before, [id], 0.9, pivot));
    }
    // `fg` sits in the frame `fr`, which keeps its frame.
    const target = editor();
    const fr = nodeOf(target, 'fr');
    ok(target, { type: 'rotateNodes', ids: ['fg'], angle: 0.9 });
    expect(nodeOf(target, 'fr')).toBe(fr);
  });

  it('rotating a mask source refits its mask group, with byte-identical undo', () => {
    const target = editor();
    const before = documentOf(target);
    ok(target, { type: 'rotateNodes', ids: ['mp'], angle: 0.6 });
    expect(nodeOf(target, 'mp').rotation).toBe(0.6);
    expect(nodeOf(target, 'mg').frame).not.toEqual(before.nodes.mg!.frame);
    expect(text(target)).toBe(expectedText(before, ['mp'], 0.6, at(0, 0), true));
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(serializeDocument(before));
    // The same through the rotate gesture.
    ok(target, { type: 'setSelection', ids: ['mp'] });
    const [tl, , br] = target.query({ type: 'handles' })!.corners;
    const length = Math.hypot(tl.x - br.x, tl.y - br.y);
    const press = at(tl.x + ((tl.x - br.x) / length) * 10, tl.y + ((tl.y - br.y) / length) * 10);
    const pivot = pivotOf(target, ['mp']);
    const end = at(press.x + 40, press.y - 25);
    drag(target, press, [end]);
    expect(text(target)).toBe(expectedText(before, ['mp'], sweep(pivot, press, end), pivot, true));
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(serializeDocument(before));
  });

  it('ignores a listed descendant of a listed node', () => {
    const a = editor();
    const b = editor();
    ok(a, { type: 'rotateNodes', ids: ['g', 'ga'], angle: 0.4 });
    ok(b, { type: 'rotateNodes', ids: ['g'], angle: 0.4 });
    expect(text(a)).toBe(text(b));
  });

  it('is one undo step with byte-identical undo and redo', () => {
    const target = editor();
    const before = text(target);
    ok(target, { type: 'rotateNodes', ids: ['r', 'g', 'fc'], angle: 2 });
    const after = text(target);
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
    ok(target, { type: 'redo' });
    expect(text(target)).toBe(after);
  });

  it('records no step and no event for a whole number of turns', () => {
    const target = editor();
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    const before = documentOf(target);
    for (const angle of [0, -0, 2 * Math.PI, -4 * Math.PI]) {
      expect(target.execute({ type: 'rotateNodes', ids: ['r', 'ga'], angle })).toEqual({
        ok: true,
        ids: [],
      });
    }
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
    expect(events).toEqual([]);
  });

  it('fails in the contract order and changes nothing', () => {
    const target = editor();
    const before = text(target);
    const cases: [Record<string, unknown>, CommandResult][] = [
      [
        { ids: 'r', angle: 1 },
        { ok: false, code: 'editor.invalid-command', path: '/ids' },
      ],
      [
        { ids: [], angle: 1 },
        { ok: false, code: 'editor.invalid-command', path: '/ids' },
      ],
      [
        { ids: ['r', 'r'], angle: 1 },
        { ok: false, code: 'editor.invalid-command', path: '/ids' },
      ],
      [
        { ids: [7], angle: 1 },
        { ok: false, code: 'editor.invalid-command', path: '/ids' },
      ],
      [
        { ids: ['r'], angle: NaN },
        { ok: false, code: 'editor.invalid-command', path: '/angle' },
      ],
      [
        { ids: ['r'], angle: Infinity },
        { ok: false, code: 'editor.invalid-command', path: '/angle' },
      ],
      [
        { ids: ['r'], angle: '1' },
        { ok: false, code: 'editor.invalid-command', path: '/angle' },
      ],
      [{ ids: ['r'] }, { ok: false, code: 'editor.invalid-command', path: '/angle' }],
      [
        { ids: ['r'], angle: 1, pivot: { x: 0 } },
        { ok: false, code: 'editor.invalid-command', path: '/pivot' },
      ],
      // A shape failure wins over an unknown node.
      [
        { ids: ['nope'], angle: NaN },
        { ok: false, code: 'editor.invalid-command', path: '/angle' },
      ],
      [
        { ids: ['nope'], angle: 1 },
        { ok: false, code: 'editor.unknown-node' },
      ],
      // A node of another page is unknown on the active page.
      [
        { ids: ['r', 'o'], angle: 1 },
        { ok: false, code: 'editor.unknown-node' },
      ],
      // Binary64 overflow fails the model's rules, after the unknown-node check.
      [
        { ids: ['r'], angle: Math.PI / 2, pivot: { x: -1.7e308, y: 1.7e308 } },
        { ok: false, code: 'document.invalid-field', path: '/nodes/r/frame/y' },
      ],
      [
        { ids: ['nope', 'r'], angle: Math.PI / 2, pivot: { x: -1.7e308, y: 1.7e308 } },
        { ok: false, code: 'editor.unknown-node' },
      ],
    ];
    for (const [command, expected] of cases) {
      expect(target.execute({ type: 'rotateNodes', ...command } as unknown as Command)).toEqual(
        expected,
      );
    }
    expect(text(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
  });
});

describe('M2-A03 gesture replace and update', () => {
  it('rejects a relative command in update with editor.invalid-command', () => {
    const target = editor();
    const { gesture } = internalsOf(target);
    const before = documentOf(target);
    gesture.begin();
    expect(gesture.update({ type: 'rotateNodes', ids: ['r'], angle: 1 })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/type',
    });
    // Before any other check: an unknown node in a relative update is still a shape failure.
    expect(gesture.update({ type: 'rotateNodes', ids: ['nope'], angle: 1 })).toMatchObject({
      code: 'editor.invalid-command',
    });
    expect(documentOf(target)).toBe(before);
    gesture.commit();
    expect(undoDepth(target)).toBe(0);
  });

  it('replace discards every earlier update and replace of the gesture', () => {
    const target = editor();
    const before = text(target);
    const { gesture } = internalsOf(target);
    gesture.begin();
    ok(target, { type: 'setSelection', ids: [] });
    expect(
      gesture.update({ type: 'setFrames', frames: [{ id: 'r', frame: f(5, 5, 100, 50) }] }).ok,
    ).toBe(true);
    expect(
      gesture.update({ type: 'setFrames', frames: [{ id: 's', frame: f(9, 9, 40, 30) }] }).ok,
    ).toBe(true);
    expect(gesture.replace([{ type: 'rotateNodes', ids: ['ga'], angle: 0.3 }])).toEqual({
      ok: true,
      ids: [],
    });
    // `r` and `s` are back where they started; only the replace's rotation is live.
    expect(nodeOf(target, 'r').frame).toEqual(f(0, 0, 100, 50));
    expect(nodeOf(target, 's').frame).toEqual(f(200, 0, 40, 30));
    expect(gesture.replace([{ type: 'rotateNodes', ids: ['ga'], angle: 0.5 }]).ok).toBe(true);
    gesture.commit();
    // Not 0.8: the second replace started from the pre-gesture document.
    const command = editor();
    ok(command, { type: 'rotateNodes', ids: ['ga'], angle: 0.5 });
    expect(text(target)).toBe(text(command));
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
  });

  it('update keeps accumulating on the live document', () => {
    const target = editor();
    const { gesture } = internalsOf(target);
    gesture.begin();
    gesture.update({ type: 'setFrames', frames: [{ id: 'r', frame: f(5, 5, 100, 50) }] });
    gesture.update({ type: 'setFrames', frames: [{ id: 's', frame: f(9, 9, 40, 30) }] });
    expect(nodeOf(target, 'r').frame).toEqual(f(5, 5, 100, 50));
    expect(nodeOf(target, 's').frame).toEqual(f(9, 9, 40, 30));
    gesture.cancel();
  });

  it('applies the listed commands in order and fails atomically', () => {
    const target = editor();
    const { gesture } = internalsOf(target);
    gesture.begin();
    gesture.replace([
      { type: 'setFrames', frames: [{ id: 'r', frame: f(50, 0, 100, 50) }] },
      { type: 'rotateNodes', ids: ['r'], angle: Math.PI / 2 },
    ]);
    expect(nodeOf(target, 'r')).toMatchObject({ frame: f(50, 0, 100, 50), rotation: Math.PI / 2 });
    const live = documentOf(target);
    expect(
      gesture.replace([
        { type: 'setFrames', frames: [{ id: 's', frame: f(0, 0, 1, 1) }] },
        { type: 'rotateNodes', ids: ['nope'], angle: 1 },
      ]),
    ).toEqual({ ok: false, code: 'editor.unknown-node' });
    expect(documentOf(target)).toBe(live);
    expect(gesture.replace('x' as never)).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/commands',
    });
    gesture.cancel();
    expect(gesture.replace([])).toEqual({ ok: false, code: 'editor.invalid-command' });
  });

  it('rejects a non-object command in replace and update', () => {
    const target = editor();
    const before = documentOf(target);
    const { gesture } = internalsOf(target);
    gesture.begin();
    expect(gesture.replace([null as never])).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/commands/0',
    });
    expect(gesture.replace([{ type: 'rotateNodes', ids: ['r'], angle: 1 }, 5 as never])).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/commands/1',
    });
    expect(gesture.update(null as never)).toEqual({ ok: false, code: 'editor.invalid-command' });
    expect(gesture.update('x' as never)).toEqual({ ok: false, code: 'editor.invalid-command' });
    expect(documentOf(target)).toBe(before);
    gesture.commit();
    expect(undoDepth(target)).toBe(0);
  });

  it('commit and its step list only nodes that differ from the pre-gesture document', () => {
    const target = editor();
    const before = text(target);
    const { gesture } = internalsOf(target);
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    gesture.begin();
    // A node created by an update and discarded by a later replace exists in neither document.
    expect(gesture.update({ type: 'createRectangle', frame: f(0, 0, 5, 5) })).toEqual({
      ok: true,
      ids: ['n1'],
    });
    gesture.replace([{ type: 'rotateNodes', ids: ['r'], angle: 1 }]);
    gesture.commit();
    const commit = events.find(
      (event) => event.type === 'document' && event.cause === 'gesture-commit',
    );
    expect(commit).toMatchObject({ touched: ['r'] });
    events.length = 0;
    ok(target, { type: 'undo' });
    expect(events.find((event) => event.type === 'document')).toMatchObject({ touched: ['r'] });
    expect(text(target)).toBe(before);
  });

  it('cancelling after a replace back to the pre-gesture document raises no event', () => {
    const target = editor();
    const before = documentOf(target);
    const { gesture } = internalsOf(target);
    gesture.begin();
    gesture.replace([{ type: 'rotateNodes', ids: ['r'], angle: 1 }]);
    gesture.replace([]);
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    gesture.cancel();
    expect(events).toEqual([]);
    expect(documentOf(target)).toBe(before);
  });

  it('a replace back to the pre-gesture document commits no step', () => {
    const target = editor();
    const before = documentOf(target);
    const { gesture } = internalsOf(target);
    gesture.begin();
    gesture.replace([{ type: 'rotateNodes', ids: ['r'], angle: 1 }]);
    gesture.replace([]);
    expect(documentOf(target)).toBe(before);
    gesture.commit();
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
  });

  it('reports the nodes that changed, reverted ones included', () => {
    const target = editor();
    const { gesture } = internalsOf(target);
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    gesture.begin();
    gesture.update({ type: 'setFrames', frames: [{ id: 'r', frame: f(5, 5, 100, 50) }] });
    gesture.replace([{ type: 'rotateNodes', ids: ['s'], angle: 1 }]);
    const last = events.filter((event) => event.type === 'document').at(-1);
    expect(last).toMatchObject({ cause: 'gesture-update', touched: ['r', 's'] });
    gesture.cancel();
  });

  it('defers the group refit to commit, which refits as the command does', () => {
    const target = editor();
    const before = documentOf(target);
    const { gesture } = internalsOf(target);
    gesture.begin();
    gesture.replace([{ type: 'rotateNodes', ids: ['ga'], angle: 1 }]);
    expect(nodeOf(target, 'g')).toBe(before.nodes.g);
    gesture.commit();
    const command = editor();
    ok(command, { type: 'rotateNodes', ids: ['ga'], angle: 1 });
    expect(text(target)).toBe(text(command));
  });
});

describe('M2-A03 rotate gesture', () => {
  /** A press in `r`'s rotate zone: outside its top-right corner (100, 0), 10√2 away. */
  const ZONE = at(110, -10);

  function selected(ids: string[], zoom = 1, document: unknown = FIXTURE): Editor {
    const target = editor(document);
    // These cases assert unsnapped rotations and moves; snapping (on by default, M2-U3) and
    // rotation-angle snapping are covered in m2-snap.test.ts.
    ok(target, { type: 'setSnapping', enabled: false });
    ok(target, { type: 'setSelection', ids });
    if (zoom !== 1) ok(target, { type: 'setViewport', camera: { position: at(0, 0), zoom } });
    return target;
  }

  it('turns one page-root node about the handle-box centre, one undo step', () => {
    const target = selected(['r']);
    const before = documentOf(target);
    const pivot = pivotOf(target, ['r']);
    expect(pivot).toEqual(at(50, 25));
    const end = at(60, 120);
    drag(target, ZONE, [at(120, 10), at(100, 60), end]);
    const angle = sweep(pivot, ZONE, end);
    // One node: the gesture omits the pivot, so x and y stay exactly as stored.
    expect(text(target)).toBe(expectedText(before, ['r'], angle, pivot, true));
    expect(nodeOf(target, 'r').frame).toEqual(before.nodes.r!.frame);
    expect(nodeOf(target, 'r').rotation).toBe(angle);
    expect(target.query({ type: 'selection' })).toEqual(['r']);
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(documentOf(target)).toBe(before);
    expect(text(target)).toBe(serializeDocument(before));
  });

  it('does not compound: many moves give the result of the last one', () => {
    const many = selected(['r', 'ga']);
    const one = selected(['r', 'ga']);
    const end = at(-40, 90);
    drag(many, ZONE, [at(120, 0), at(130, 40), at(80, 120), at(0, 100), end]);
    drag(one, ZONE, [end]);
    expect(text(many)).toBe(text(one));
  });

  it('turns several nodes and refits their group ancestors at commit', () => {
    const target = selected(['r', 'ga', 'fc']);
    const before = documentOf(target);
    const handles = target.query({ type: 'handles' })!;
    const tr = handles.corners[1];
    const press = at(tr.x + 8, tr.y - 8);
    const pivot = pivotOf(target, ['r', 'ga', 'fc']);
    const end = at(press.x - 30, press.y + 70);
    drag(target, press, [at(press.x, press.y + 20), end]);
    expect(text(target)).toBe(
      expectedText(before, ['r', 'ga', 'fc'], sweep(pivot, press, end), pivot),
    );
    expect(undoDepth(target)).toBe(1);
  });

  it('turns a nested node in a rotated group, and group, frame and mask group rigidly', () => {
    for (const id of ['ga', 'fc', 'fga', 'g', 'fr', 'mg']) {
      const target = selected([id]);
      const before = documentOf(target);
      const handles = target.query({ type: 'handles' })!;
      // Outward from the top-left corner along the box's diagonal, 10 page units.
      const [tl, , br] = handles.corners;
      const length = Math.hypot(tl.x - br.x, tl.y - br.y);
      const press = at(tl.x + ((tl.x - br.x) / length) * 10, tl.y + ((tl.y - br.y) / length) * 10);
      const pivot = pivotOf(target, [id]);
      const end = at(press.x + 40, press.y - 25);
      drag(target, press, [at(press.x + 5, press.y), end]);
      const angle = sweep(pivot, press, end);
      expect(text(target), id).toBe(expectedText(before, [id], angle, pivot, true));
      const command = editor();
      ok(command, { type: 'rotateNodes', ids: [id], angle });
      expect(text(target), id).toBe(text(command));
      for (const child of (before.nodes[id] as { children?: readonly string[] }).children ?? []) {
        expect(nodeOf(target, child), child).toBe(before.nodes[child]);
      }
    }
  });

  it('steps one node to a multiple of 15° with Shift, also nested', () => {
    for (const [id, end] of [
      ['r', at(60, 120)],
      ['r', at(-30, -70)],
      ['ga', at(500, 120)],
      ['fc', at(-100, 200)],
    ] as const) {
      const target = selected([id]);
      const before = documentOf(target);
      const handles = target.query({ type: 'handles' })!;
      const [tl, , br] = handles.corners;
      const length = Math.hypot(tl.x - br.x, tl.y - br.y);
      const press = at(tl.x + ((tl.x - br.x) / length) * 10, tl.y + ((tl.y - br.y) / length) * 10);
      checkStep(target, before, id, press, end);
    }
  });

  it('stores exactly the stepped rotation for every direction', () => {
    for (const id of ['r', 'fc', 'gb']) {
      for (let i = 0; i < 96; i += 1) {
        const target = selected([id]);
        const before = documentOf(target);
        const [tl, , br] = target.query({ type: 'handles' })!.corners;
        const length = Math.hypot(tl.x - br.x, tl.y - br.y);
        const press = at(
          tl.x + ((tl.x - br.x) / length) * 10,
          tl.y + ((tl.y - br.y) / length) * 10,
        );
        const pivot = pivotOf(target, [id]);
        const turn = (2 * Math.PI * i) / 96 + 0.01;
        const end = at(pivot.x + 80 * Math.cos(turn), pivot.y + 80 * Math.sin(turn));
        checkStep(target, before, id, press, end);
      }
    }
  });

  it('rounds Shift halves towards +∞, as Math.round', () => {
    // A node at ±π/24 and a move straight away from the pivot: the sweep is exactly 0, so the
    // resulting rotation is the half step ±0.5 · (π/12), and the stepped result is exact.
    for (const [rotation, expected] of [
      [Math.PI / 24, Math.PI / 12],
      [-Math.PI / 24, 0],
      // Back to exactly 0, so the node is page-aligned again.
      [0.1, 0],
    ] as const) {
      const document = doc([['p1', ['h']]], [rect('h', 'p1', f(600, 600, 40, 40), rotation)]);
      const target = selected(['h'], 1, document);
      const pivot = pivotOf(target, ['h']);
      const tr = target.query({ type: 'handles' })!.corners[1];
      const out = at(tr.x - pivot.x, tr.y - pivot.y);
      const press = at(pivot.x + out.x * 1.25, pivot.y + out.y * 1.25);
      const d = at(press.x - pivot.x, press.y - pivot.y);
      const end = at(pivot.x + 2 * d.x, pivot.y + 2 * d.y);
      expect(sweep(pivot, press, end)).toBe(0);
      drag(target, press, [end], shift);
      expect(nodeOf(target, 'h').rotation).toBe(expected);
      expect(undoDepth(target)).toBe(1);
    }
  });

  it('rounds the angle itself with Shift for several nodes', () => {
    const target = selected(['r', 's']);
    const before = documentOf(target);
    const pivot = pivotOf(target, ['r', 's']);
    const handles = target.query({ type: 'handles' })!;
    const tr = handles.corners[1];
    const press = at(tr.x + 8, tr.y - 8);
    const end = at(180, 150);
    drag(target, press, [end], shift);
    const angle = stepped(sweep(pivot, press, end));
    expect(Math.abs(angle)).toBeGreaterThan(0);
    expect(text(target)).toBe(expectedText(before, ['r', 's'], angle, pivot));
  });

  it('a move back to the press direction leaves no step', () => {
    const target = selected(['r']);
    const before = documentOf(target);
    const pivot = pivotOf(target, ['r']);
    const back = at(pivot.x + 2 * (ZONE.x - pivot.x), pivot.y + 2 * (ZONE.y - pivot.y));
    drag(target, ZONE, [at(60, 120), back]);
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
  });

  it.each(['Escape', 'pointercancel'] as const)('cancels by %s and restores', (how) => {
    const target = selected(['r', 'ga']);
    const before = text(target);
    const tr = target.query({ type: 'handles' })!.corners[1];
    input(target, 'pointerdown', at(tr.x + 8, tr.y - 8));
    input(target, 'pointermove', at(60, 120));
    expect(text(target)).not.toBe(before);
    const result =
      how === 'Escape'
        ? target.execute({
            type: 'input',
            event: { kind: 'keydown', key: 'Escape', modifiers: none },
          })
        : target.execute({ type: 'input', event: { kind: 'pointercancel', modifiers: none } });
    expect(result).toEqual({ ok: true, ids: [], consumed: true });
    expect(text(target)).toBe(before);
    expect(target.query({ type: 'selection' })).toEqual(['r', 'ga']);
    expect(internalsOf(target).gesture.active).toBe(false);
    expect(undoDepth(target)).toBe(0);
    // The release after a cancel changes nothing.
    input(target, 'pointerup', at(60, 120));
    expect(text(target)).toBe(before);
  });

  /** Drags one selected node from `press` to `end` and asserts the exact one-node rotation. */
  function rotatesExactly(target: Editor, id: string, press: PagePoint, end: PagePoint) {
    const before = documentOf(target);
    const pivot = pivotOf(target, [id]);
    drag(target, press, [end]);
    const angle = sweep(pivot, press, end);
    expect(angle).not.toBe(0);
    expect(nodeOf(target, id).rotation).toBe(rotated(before, id, angle, pivot, true).rotation);
    expect(text(target)).toBe(expectedText(before, [id], angle, pivot, true));
  }

  describe('press precedence', () => {
    it('a handle within 6 / zoom wins over the rotate zone', () => {
      const target = selected(['r']);
      drag(target, at(104, -4), [at(124, -4)]);
      expect(nodeOf(target, 'r')).toMatchObject({ frame: f(0, 0, 120, 50), rotation: 0 });
    });

    it('the rotate zone wins over a node under the press', () => {
      const document = doc(
        [['p1', ['r', 'under']]],
        [rect('r', 'p1', f(0, 0, 100, 50)), rect('under', 'p1', f(105, -40, 30, 35))],
      );
      const target = selected(['r'], 1, document);
      rotatesExactly(target, 'r', ZONE, at(60, 120));
      expect(nodeOf(target, 'under').frame).toEqual(f(105, -40, 30, 35));
      expect(target.query({ type: 'selection' })).toEqual(['r']);
    });

    it('needs a press strictly outside the box, within 18 / zoom of a corner', () => {
      // Inside the box near a corner (not a handle) moves the node.
      const inside = selected(['r']);
      drag(inside, at(90, 10), [at(95, 15)]);
      expect(nodeOf(inside, 'r')).toMatchObject({ frame: f(5, 5, 100, 50), rotation: 0 });
      // On the box edge (not strictly outside), between handles: a press on the node moves it.
      const edge = selected(['r']);
      drag(edge, at(85, 0), [at(85, 5)]);
      expect(nodeOf(edge, 'r')).toMatchObject({ frame: f(0, 5, 100, 50), rotation: 0 });
      // 18 away from the corner is still in the zone; just beyond it is empty canvas.
      const near = selected(['r']);
      rotatesExactly(near, 'r', at(118, 0), at(118, 40));
      const far = selected(['r']);
      drag(far, at(118.5, 0), [at(118.5, 40)]);
      expect(nodeOf(far, 'r').rotation).toBe(0);
      expect(far.query({ type: 'selection' })).toEqual([]);
    });

    it('scales the zone with zoom', () => {
      const near = selected(['r'], 4);
      rotatesExactly(near, 'r', at(100, -4.5), at(100, 60));
      const far = selected(['r'], 4);
      drag(far, at(100, -4.6), [at(100, 60)]);
      expect(nodeOf(far, 'r').rotation).toBe(0);
    });

    it('applies to the rotated box of a single rotated node, in its own axes', () => {
      const target = selected(['ga']);
      const handles = target.query({ type: 'handles' })!;
      const [tl, tr] = handles.corners;
      // Along the top edge's line beyond the top-left corner: outside in the box's axes.
      const length = Math.hypot(tr.x - tl.x, tr.y - tl.y);
      const press = at(tl.x - ((tr.x - tl.x) / length) * 12, tl.y - ((tr.y - tl.y) / length) * 12);
      rotatesExactly(target, 'ga', press, at(press.x - 10, press.y + 30));
    });

    it('keeps the small-box rule first and has no zone without a selection', () => {
      const document = doc([['p1', ['t']]], [rect('t', 'p1', f(0, 0, 10, 10))]);
      // Inside a small selected box a press moves, even within reach of a handle.
      const small = selected(['t'], 1, document);
      drag(small, at(8, 2), [at(9, 3)]);
      expect(nodeOf(small, 't')).toMatchObject({ frame: f(1, 1, 10, 10), rotation: 0 });
      // Outside it near a corner, beyond the handles, the zone still rotates.
      const zone = selected(['t'], 1, document);
      rotatesExactly(zone, 't', at(20, -8), at(20, 30));
      // Without a selection the same press is a marquee.
      const empty = selected([], 1, document);
      drag(empty, at(20, -8), [at(20, 30)]);
      expect(nodeOf(empty, 't').rotation).toBe(0);
    });

    it('rotates a zero-height rectangle from its corner zone', () => {
      const document = doc([['p1', ['flat']]], [rect('flat', 'p1', f(0, 0, 100, 0))]);
      const target = selected(['flat'], 1, document);
      // Above the right end: outside the box (y < 0), 10 from the corner, beyond the handles.
      rotatesExactly(target, 'flat', at(100, -10), at(40, 60));
      expect(nodeOf(target, 'flat').frame).toEqual(f(0, 0, 100, 0));
      expect(undoDepth(target)).toBe(1);
    });

    it('a click in the zone without movement changes nothing', () => {
      const target = selected(['r']);
      const before = documentOf(target);
      input(target, 'pointerdown', ZONE);
      input(target, 'pointerup', ZONE);
      expect(documentOf(target)).toBe(before);
      expect(target.query({ type: 'selection' })).toEqual(['r']);
      expect(undoDepth(target)).toBe(0);
    });
  });
});
