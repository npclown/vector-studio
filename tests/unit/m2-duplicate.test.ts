import { serializeDocument, type DocumentV2, type Frame, type NodeV2 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  DEFAULT_PATH_STROKE,
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type Extension,
  type IdSource,
  type KeyBinding,
  type Modifiers,
  type PagePoint,
} from '../../packages/editor-core/src/index.js';
// Source imports: the expected values restate the section 4.3 formulas with the package's own
// placement helpers and the edit draft (the M1 group refit).
import { Draft } from '../../packages/editor-core/src/draft.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { apply, localTransform } from '../../packages/editor-core/src/geometry.js';
import { documentTree, spaceOf } from '../../packages/editor-core/src/tree.js';

// MVP M2-U4, M2-A08 (M2 contract, section 4.3, S8): `duplicateNodes` and the select tool's
// Alt-drag through `input`: fresh IDs drawn root by root in paint order, each subtree in
// pre-order, after every check (a failed command draws none); copies directly above the
// originals, with custom nodes re-validated, an offset, inside frames and mask groups and at the
// depth limits; Alt-drag commit is one undo step and its cancel (Escape, `pointercancel`)
// restores the document and the originals' selection.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const alt: Modifiers = { ...none, alt: true };
const ctrl: Modifiers = { ...none, ctrl: true };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });

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

function tally(id: string, parent: string, frame: Frame, level = 1): Loose {
  return {
    ...base(id, parent, frame),
    type: 'custom',
    customType: 'ext.tally',
    data: { level },
    fill: null,
    stroke: DEFAULT_PATH_STROKE,
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
 * Page p1: page-root rectangles `a` and `b`, a rotated group `g` (`ga`, `gb`), a rotated frame
 * `fr` holding a rotated rectangle `fc` and a group `fg` (`fga`, custom `fct`), a mask group
 * `mg` (`mp`, `mr`, `ms`) and a custom node `ct`; page p2: `o`.
 */
const FIXTURE = doc(
  [
    ['p1', ['a', 'b', 'g', 'fr', 'mg', 'ct']],
    ['p2', ['o']],
  ],
  [
    rect('a', 'p1', f(0, 0, 10, 10)),
    rect('b', 'p1', f(30, 20, 20, 10)),
    container('group', 'g', 'p1', ['ga', 'gb'], f(200, 0, 60, 40), 0.5),
    rect('ga', 'g', f(0, 0, 30, 20)),
    rect('gb', 'g', f(30, 20, 30, 20)),
    container('frame', 'fr', 'p1', ['fc', 'fg'], f(0, 300, 200, 100), -0.4),
    rect('fc', 'fr', f(10, 10, 40, 20), 0.1),
    container('group', 'fg', 'fr', ['fga', 'fct'], f(100, 50, 60, 30)),
    rect('fga', 'fg', f(0, 0, 30, 30)),
    tally('fct', 'fg', f(30, 0, 30, 30)),
    container('maskGroup', 'mg', 'p1', ['mp', 'mr', 'ms'], f(500, 300, 50, 50)),
    triangle('mp', 'mg', f(0, 0, 50, 50)),
    rect('mr', 'mg', f(10, 10, 20, 20)),
    rect('ms', 'mg', f(20, 20, 10, 10)),
    tally('ct', 'p1', f(400, 400, 20, 20)),
    rect('o', 'p2', f(0, 0, 10, 10)),
  ],
);

/**
 * `ext.tally`: data `{ level }`; counts its validations, and rejects every node while `strict`
 * holds, so a test can make an existing node's copy fail its custom check.
 */
function tallyExtension() {
  const state = { validations: 0, strict: false };
  const extension: Extension = {
    id: 'ext.tally',
    nodeTypes: [
      {
        customType: 'ext.tally',
        validate(data) {
          state.validations += 1;
          return !state.strict && typeof data === 'object' && data !== null && 'level' in data;
        },
        defaults: () => ({ level: 1 }),
        toScene: (_, frame) => ({
          verbs: ['move', 'line', 'line', 'close'],
          points: [0, 0, frame.width, 0, frame.width, frame.height],
          fillRule: 'nonzero',
        }),
      },
    ],
  };
  return { extension, state };
}

/** A counter ID source `n1`, `n2`, ... that records how many IDs were drawn. */
function counter() {
  const state = { drawn: 0 };
  const ids: IdSource = () => {
    state.drawn += 1;
    return `n${state.drawn}`;
  };
  return { ids, state };
}

const OFFSET_KEY: KeyBinding = {
  chord: 'Alt+D',
  action: 'duplicate',
  args: { offset: { x: 5, y: 7 } },
};

function setup(document: unknown = FIXTURE, ids?: IdSource) {
  const source = counter();
  const custom = tallyExtension();
  const target = createEditor({
    ids: ids ?? source.ids,
    document,
    extensions: [custom.extension],
    keymap: [OFFSET_KEY],
  });
  return { target, drawn: source.state, custom: custom.state };
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function press(target: Editor, key: string, modifiers = none): CommandResult {
  return target.execute({ type: 'input', event: { kind: 'keydown', key, modifiers } });
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  point: PagePoint,
  modifiers = alt,
): CommandResult {
  return target.execute({ type: 'input', event: { kind, point, modifiers } });
}

const select = (target: Editor, ids: readonly string[]) =>
  ok(target, { type: 'setSelection', ids });
const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const documentOf = (target: Editor) => target.query({ type: 'document' });
const nodeOf = (target: Editor, id: string) => target.query({ type: 'node', id })!;
const selection = (target: Editor) => target.query({ type: 'selection' });
const undoDepth = (target: Editor) => target.query({ type: 'history' }).undoDepth;
const childrenOf = (target: Editor, owner: string): readonly string[] => {
  const page = documentOf(target).pages.find((entry) => entry.id === owner);
  if (page !== undefined) return page.children;
  return (nodeOf(target, owner) as { children: readonly string[] }).children;
};

/** The node's frame moved by the page vector `(dx, dy)` turned into its parent space. */
function translated(document: DocumentV2, id: string, dx: number, dy: number): Frame {
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

/** A copy of `node` with ID `id` and, optionally, its parent and frame replaced. */
function copyOf(node: NodeV2, id: string, changes: Partial<Record<string, unknown>> = {}) {
  return { ...node, id, ...changes };
}

/** One undo step back to `before` byte for byte, and redo back to `after`. */
function expectOneStep(target: Editor, before: string) {
  const after = text(target);
  expect(undoDepth(target)).toBe(1);
  ok(target, { type: 'undo' });
  expect(text(target)).toBe(before);
  ok(target, { type: 'redo' });
  expect(text(target)).toBe(after);
}

describe('M2-A08 duplicateNodes', () => {
  it('Mod+D copies the selection directly above it in place and selects the copy', () => {
    const { target } = setup();
    const before = documentOf(target);
    select(target, ['a']);
    expect(press(target, 'd', ctrl)).toEqual({ ok: true, ids: ['n1'], consumed: true });
    expect(childrenOf(target, 'p1')).toEqual(['a', 'n1', 'b', 'g', 'fr', 'mg', 'ct']);
    expect(nodeOf(target, 'n1')).toEqual(copyOf(before.nodes.a!, 'n1'));
    expect(nodeOf(target, 'a')).toBe(before.nodes.a);
    expect(selection(target)).toEqual(['n1']);
    expectOneStep(target, serializeDocument(before));
  });

  it('draws IDs root by root in paint order, not listed order, across parents', () => {
    const { target, drawn } = setup();
    const before = documentOf(target);
    select(target, ['fc', 'gb', 'b', 'a']);
    expect(press(target, 'd', ctrl)).toEqual({
      ok: true,
      ids: ['n1', 'n2', 'n3', 'n4'],
      consumed: true,
    });
    expect(drawn.drawn).toBe(4);
    // Each copy above the topmost original of its parent, originals' relative order kept.
    expect(childrenOf(target, 'p1')).toEqual(['a', 'b', 'n1', 'n2', 'g', 'fr', 'mg', 'ct']);
    expect(childrenOf(target, 'g')).toEqual(['ga', 'gb', 'n3']);
    expect(childrenOf(target, 'fr')).toEqual(['fc', 'n4', 'fg']);
    for (const [original, copy] of [
      ['a', 'n1'],
      ['b', 'n2'],
      ['gb', 'n3'],
      ['fc', 'n4'],
    ] as const) {
      expect(nodeOf(target, copy)).toEqual(copyOf(before.nodes[original]!, copy));
    }
    // In place, the groups keep their frames (the refit finds nothing to change).
    expect(nodeOf(target, 'g').frame).toEqual(before.nodes.g!.frame);
    expectOneStep(target, serializeDocument(before));
  });

  it('copies nested subtrees in pre-order, custom nodes included and re-validated', () => {
    const { target, custom } = setup();
    const before = documentOf(target);
    const validations = custom.validations;
    expect(target.execute({ type: 'duplicateNodes', ids: ['fr'] })).toEqual({
      ok: true,
      ids: ['n1'],
    });
    // fr, fc, fg, fga, fct: a container before its children, in `children` order.
    expect(nodeOf(target, 'n1')).toEqual(
      copyOf(before.nodes.fr!, 'n1', { children: ['n2', 'n3'] }),
    );
    expect(nodeOf(target, 'n2')).toEqual(copyOf(before.nodes.fc!, 'n2', { parent: 'n1' }));
    expect(nodeOf(target, 'n3')).toEqual(
      copyOf(before.nodes.fg!, 'n3', { parent: 'n1', children: ['n4', 'n5'] }),
    );
    expect(nodeOf(target, 'n4')).toEqual(copyOf(before.nodes.fga!, 'n4', { parent: 'n3' }));
    expect(nodeOf(target, 'n5')).toEqual(copyOf(before.nodes.fct!, 'n5', { parent: 'n3' }));
    expect(nodeOf(target, 'n5')).toMatchObject({ customType: 'ext.tally', data: { level: 1 } });
    expect(custom.validations).toBeGreaterThan(validations);
    expect(childrenOf(target, 'p1')).toEqual(['a', 'b', 'g', 'fr', 'n1', 'mg', 'ct']);
    // The command does not change the selection.
    expect(selection(target)).toEqual([]);
    expectOneStep(target, serializeDocument(before));
  });

  it('several originals of one parent go together above the topmost one', () => {
    const { target } = setup();
    expect(target.execute({ type: 'duplicateNodes', ids: ['mg', 'a'] })).toEqual({
      ok: true,
      ids: ['n1', 'n2'],
    });
    expect(childrenOf(target, 'p1')).toEqual(['a', 'b', 'g', 'fr', 'mg', 'n1', 'n2', 'ct']);
    expect(childrenOf(target, 'n2')).toEqual(['n3', 'n4', 'n5']);
  });

  it('draws IDs in the copies’ paint order when it differs from the originals’', () => {
    // Originals in paint order: a, gb (inside g, between a and b), b. Copies: a and b go above
    // b; gb's copy stays in g, so it paints first and draws the first ID.
    const { target } = setup(
      doc(
        [['p1', ['a', 'g', 'b']]],
        [
          rect('a', 'p1', f(0, 0, 10, 10)),
          container('group', 'g', 'p1', ['gb'], f(100, 0, 10, 10)),
          rect('gb', 'g', f(0, 0, 10, 10)),
          rect('b', 'p1', f(30, 20, 20, 10)),
        ],
      ),
    );
    expect(target.execute({ type: 'duplicateNodes', ids: ['b', 'gb', 'a'] })).toEqual({
      ok: true,
      ids: ['n1', 'n2', 'n3'],
    });
    expect(childrenOf(target, 'p1')).toEqual(['a', 'g', 'b', 'n2', 'n3']);
    expect(childrenOf(target, 'g')).toEqual(['gb', 'n1']);
    expect(nodeOf(target, 'n2')).toMatchObject({ name: 'a', parent: 'p1' });
  });

  it('copies inside a mask group keep its path source first', () => {
    for (const [ids, children] of [
      [['mr'], ['mp', 'mr', 'n1', 'ms']],
      [['mp'], ['mp', 'n1', 'mr', 'ms']],
      [
        ['ms', 'mp'],
        ['mp', 'mr', 'ms', 'n1', 'n2'],
      ],
    ] as const) {
      const { target } = setup();
      const before = text(target);
      ok(target, { type: 'duplicateNodes', ids });
      expect(childrenOf(target, 'mg')).toEqual(children);
      expectOneStep(target, before);
    }
  });

  it('moves the copies by the page offset, turned into each parent space; groups refit', () => {
    const { target } = setup();
    const before = documentOf(target);
    select(target, ['gb', 'a', 'fc']);
    expect(press(target, 'd', alt)).toEqual({ ok: true, ids: ['n1', 'n2', 'n3'], consumed: true });
    // a → n1 (page root: x + 5, y + 7 exactly), gb → n2, fc → n3.
    expect(nodeOf(target, 'n1').frame).toEqual(f(5, 7, 10, 10));
    const draft = new Draft(before);
    const copies = [
      ['a', 'n1', 'p1'],
      ['gb', 'n2', 'g'],
      ['fc', 'n3', 'fr'],
    ] as const;
    for (const [original, copy] of copies) {
      draft.set(
        copyOf(before.nodes[original]!, copy, { frame: translated(before, original, 5, 7) }),
      );
    }
    draft.setChildren('p1', ['a', 'n1', 'b', 'g', 'fr', 'mg', 'ct']);
    draft.setChildren('g', ['ga', 'gb', 'n2']);
    draft.setChildren('fr', ['fc', 'n3', 'fg']);
    const expected = draft.finish(() => null);
    if ('ok' in expected) throw new Error(expected.code);
    expect(text(target)).toBe(serializeDocument(expected));
    // The copy outside g's old bounds made g refit.
    expect(nodeOf(target, 'g').frame).not.toEqual(before.nodes.g!.frame);
    expectOneStep(target, serializeDocument(before));
  });

  it('a failed duplicate draws no ID', () => {
    const { target, drawn, custom } = setup(
      doc(
        [['p1', ['big', 'ct']]],
        [rect('big', 'p1', f(1e308, 0, 10, 10)), tally('ct', 'p1', f(0, 0, 10, 10))],
      ),
    );
    const before = documentOf(target);
    const failures: [Command, CommandResult][] = [
      [
        { type: 'duplicateNodes', ids: [] },
        { ok: false, code: 'editor.invalid-command', path: '/ids' },
      ],
      [
        { type: 'duplicateNodes', ids: ['big'], offset: { x: Number.NaN, y: 0 } },
        { ok: false, code: 'editor.invalid-command', path: '/offset' },
      ],
      [
        { type: 'duplicateNodes', ids: ['big', 'missing'] },
        { ok: false, code: 'editor.unknown-node' },
      ],
      // The copy's frame overflows: reported at its original.
      [
        { type: 'duplicateNodes', ids: ['ct', 'big'], offset: { x: 1e308, y: 0 } },
        { ok: false, code: 'document.invalid-field', path: '/nodes/big/frame/x' },
      ],
    ];
    for (const [command, result] of failures) {
      expect(target.execute(command), JSON.stringify(command)).toEqual(result);
      expect(drawn.drawn).toBe(0);
    }
    // A copy failing its custom check, at its original's path.
    custom.strict = true;
    expect(target.execute({ type: 'duplicateNodes', ids: ['big', 'ct'] })).toEqual({
      ok: false,
      code: 'document.invalid-custom-data',
      path: '/nodes/ct/data',
    });
    expect(drawn.drawn).toBe(0);
    expect(documentOf(target)).toBe(before);
    custom.strict = false;
    expect(target.execute({ type: 'duplicateNodes', ids: ['big'] })).toEqual({
      ok: true,
      ids: ['n1'],
    });
  });

  it('skips drawn IDs that exist or repeat, and editor.duplicate-id comes last', () => {
    const sequence = ['b', 'x1', 'x1', 'x2'];
    const { target } = setup(FIXTURE, () => sequence.shift() ?? 'a');
    expect(target.execute({ type: 'duplicateNodes', ids: ['a', 'b'] })).toEqual({
      ok: true,
      ids: ['x1', 'x2'],
    });
    const before = documentOf(target);
    // Only existing IDs: every check passed, so the failure is the ID draw itself.
    expect(target.execute({ type: 'duplicateNodes', ids: ['a'] })).toEqual({
      ok: false,
      code: 'editor.duplicate-id',
    });
    expect(target.execute({ type: 'duplicateNodes', ids: ['missing'] })).toEqual({
      ok: false,
      code: 'editor.unknown-node',
    });
    expect(documentOf(target)).toBe(before);
  });

  it('keeps tree depth 256 and clip depth 32: duplicates never change either', () => {
    // Groups h1 (page root) to h256, leaf `leaf` at tree depth 256.
    const groups: Loose[] = [];
    for (let i = 1; i <= 256; i += 1) {
      const child = i === 256 ? 'leaf' : `h${i + 1}`;
      groups.push(
        container('group', `h${i}`, i === 1 ? 'p1' : `h${i - 1}`, [child], f(0, 0, 10, 10)),
      );
    }
    const deep = setup(doc([['p1', ['h1']]], [...groups, rect('leaf', 'h256', f(0, 0, 10, 10))]));
    ok(deep.target, { type: 'duplicateNodes', ids: ['leaf'] });
    expect(childrenOf(deep.target, 'h256')).toEqual(['leaf', 'n1']);
    ok(deep.target, { type: 'duplicateNodes', ids: ['h256'] });
    expect(childrenOf(deep.target, 'h255')).toEqual(['h256', 'n2']);
    expect(childrenOf(deep.target, 'n2')).toEqual(['n3', 'n4']);
    // Frames k1 (clip depth 0) to k32 (31, the deepest a frame may sit), a leaf at 32.
    const frames: Loose[] = [];
    for (let i = 1; i <= 32; i += 1) {
      const child = i === 32 ? 'leaf' : `k${i + 1}`;
      frames.push(
        container('frame', `k${i}`, i === 1 ? 'p1' : `k${i - 1}`, [child], f(0, 0, 10, 10)),
      );
    }
    const clipped = setup(doc([['p1', ['k1']]], [...frames, rect('leaf', 'k32', f(0, 0, 10, 10))]));
    ok(clipped.target, { type: 'duplicateNodes', ids: ['leaf'] });
    ok(clipped.target, { type: 'duplicateNodes', ids: ['k32'] });
    expect(childrenOf(clipped.target, 'k31')).toEqual(['k32', 'n2']);
    expect(undoDepth(clipped.target)).toBe(2);
  });

  it('is a creating command: a gesture issues it through update', () => {
    const { target } = setup();
    const { gesture } = internalsOf(target);
    expect(gesture.begin()).toBe(true);
    expect(gesture.update({ type: 'duplicateNodes', ids: ['a'] })).toEqual({
      ok: true,
      ids: ['n1'],
    });
    gesture.commit();
    expect(undoDepth(target)).toBe(1);
  });
});

/** The page point of a node's local point. */
function pagePoint(document: DocumentV2, id: string, x: number, y: number): PagePoint {
  const node = document.nodes[id]!;
  const { matrix } = spaceOf(documentTree(document), node.parent);
  const local = apply(localTransform(node.frame, node.rotation), x, y);
  return apply(matrix, local.x, local.y);
}

/** Alt-drag tests assert raw moves: snapping is on by default (M2-U3 note 10). */
function raw(document: unknown = FIXTURE) {
  const result = setup(document);
  ok(result.target, { type: 'setSnapping', enabled: false });
  return result;
}

describe('M2-A08 Alt-drag', () => {
  it('defers the selection at press, duplicates on the first movement, moves the copy', () => {
    const { target } = raw();
    const before = documentOf(target);
    select(target, ['a']);
    pointer(target, 'pointerdown', at(40, 25));
    expect(selection(target)).toEqual(['a']);
    expect(documentOf(target)).toBe(before);
    pointer(target, 'pointermove', at(45, 30));
    expect(selection(target)).toEqual(['n1']);
    expect(nodeOf(target, 'n1').frame).toEqual(f(35, 25, 20, 10));
    expect(nodeOf(target, 'b')).toBe(before.nodes.b);
    // Absolute: a second move does not compound, and draws no second copy.
    pointer(target, 'pointermove', at(50, 25));
    expect(nodeOf(target, 'n1').frame).toEqual(f(40, 20, 20, 10));
    pointer(target, 'pointerup', at(50, 25));
    expect(Object.keys(documentOf(target).nodes).filter((id) => id.startsWith('n'))).toEqual([
      'n1',
    ]);
    expect(childrenOf(target, 'p1')).toEqual(['a', 'b', 'n1', 'g', 'fr', 'mg', 'ct']);
    expect(selection(target)).toEqual(['n1']);
    // One step holds both the duplicate and the move.
    expectOneStep(target, serializeDocument(before));
  });

  it('a pressed selected node duplicates the whole selection in paint order', () => {
    const { target } = raw();
    const before = documentOf(target);
    select(target, ['b', 'a']);
    pointer(target, 'pointerdown', at(5, 5));
    pointer(target, 'pointermove', at(5, 15));
    pointer(target, 'pointerup', at(5, 15));
    expect(selection(target)).toEqual(['n1', 'n2']);
    expect(nodeOf(target, 'n1')).toEqual(
      copyOf(before.nodes.a!, 'n1', { frame: f(0, 10, 10, 10) }),
    );
    expect(nodeOf(target, 'n2')).toEqual(
      copyOf(before.nodes.b!, 'n2', { frame: f(30, 30, 20, 10) }),
    );
    expect(childrenOf(target, 'p1')).toEqual(['a', 'b', 'n1', 'n2', 'g', 'fr', 'mg', 'ct']);
    expectOneStep(target, serializeDocument(before));
  });

  it('draws subtree IDs in pre-order: a group target, and with a page-root node', () => {
    const { target } = raw();
    const press = pagePoint(documentOf(target), 'ga', 15, 10);
    pointer(target, 'pointerdown', press);
    pointer(target, 'pointermove', at(press.x + 1, press.y));
    pointer(target, 'pointerup', at(press.x + 1, press.y));
    expect(selection(target)).toEqual(['n1']);
    expect(childrenOf(target, 'n1')).toEqual(['n2', 'n3']);

    const second = raw();
    select(second.target, ['g', 'a']);
    pointer(second.target, 'pointerdown', press);
    pointer(second.target, 'pointermove', at(press.x, press.y + 1));
    pointer(second.target, 'pointerup', at(press.x, press.y + 1));
    // a → n1, then g → n2 with ga → n3 and gb → n4.
    expect(selection(second.target)).toEqual(['n1', 'n2']);
    expect(childrenOf(second.target, 'n2')).toEqual(['n3', 'n4']);
    expect(nodeOf(second.target, 'n3')).toMatchObject({ parent: 'n2', frame: f(0, 0, 30, 20) });
  });

  it('copies a frame child in place, moving by the page delta in the rotated frame', () => {
    const { target } = raw();
    const before = documentOf(target);
    const press = pagePoint(before, 'fc', 20, 10);
    pointer(target, 'pointerdown', press);
    pointer(target, 'pointermove', at(press.x + 10, press.y));
    pointer(target, 'pointerup', at(press.x + 10, press.y));
    expect(selection(target)).toEqual(['n1']);
    expect(childrenOf(target, 'fr')).toEqual(['fc', 'n1', 'fg']);
    expect(nodeOf(target, 'n1')).toEqual(
      copyOf(before.nodes.fc!, 'n1', { frame: translated(before, 'fc', 10, 0) }),
    );
    expectOneStep(target, serializeDocument(before));
  });

  it('combines with move snapping: the copy snaps to its original, overlay cleared at commit', () => {
    const { target } = setup(
      doc(
        [['p1', ['a', 'b']]],
        [rect('a', 'p1', f(0, 0, 10, 10)), rect('b', 'p1', f(30, 20, 20, 10))],
      ),
    );
    pointer(target, 'pointerdown', at(40, 25));
    // Raw left edge 48; the original's right edge 50 is within 6.
    pointer(target, 'pointermove', at(58, 25));
    expect(nodeOf(target, 'n1').frame).toEqual(f(50, 20, 20, 10));
    expect(target.query({ type: 'snap' })?.guides).toContainEqual({ a: at(50, 20), b: at(50, 30) });
    pointer(target, 'pointerup', at(58, 25));
    expect(target.query({ type: 'snap' })).toBeNull();
    expect(nodeOf(target, 'n1').frame).toEqual(f(50, 20, 20, 10));
    expect(undoDepth(target)).toBe(1);
  });

  it.each([
    ['Escape', { type: 'input', event: { kind: 'keydown', key: 'Escape', modifiers: alt } }],
    ['pointercancel', { type: 'input', event: { kind: 'pointercancel', modifiers: none } }],
  ] as const)('%s restores the document and the originals’ selection', (_, cancel) => {
    const { target, drawn } = raw();
    const before = documentOf(target);
    select(target, ['a']);
    pointer(target, 'pointerdown', at(40, 25));
    pointer(target, 'pointermove', at(45, 30));
    expect(selection(target)).toEqual(['n1']);
    expect(target.execute(cancel as Command)).toEqual({ ok: true, ids: [], consumed: true });
    expect(documentOf(target)).toBe(before);
    expect(selection(target)).toEqual(['a']);
    expect(undoDepth(target)).toBe(0);
    // Drawn IDs are not returned to the source: the next Alt-drag draws n2.
    pointer(target, 'pointerdown', at(40, 25));
    pointer(target, 'pointermove', at(41, 25));
    pointer(target, 'pointerup', at(41, 25));
    expect(selection(target)).toEqual(['n2']);
    expect(drawn.drawn).toBe(2);
    expect(undoDepth(target)).toBe(1);
  });

  it('a release without movement duplicates nothing and records no step', () => {
    const { target, drawn } = raw();
    const before = documentOf(target);
    select(target, ['a']);
    pointer(target, 'pointerdown', at(40, 25), { ...alt, shift: true });
    expect(selection(target)).toEqual(['a']);
    pointer(target, 'pointerup', at(40, 25), { ...alt, shift: true });
    expect(documentOf(target)).toBe(before);
    expect(drawn.drawn).toBe(0);
    expect(undoDepth(target)).toBe(0);
    // An Alt-click cycles (M2-U5): the pre-press selection `a` is not in the stack under the
    // point, whose only item is b, so cycling selects the stack's top item, b.
    expect(selection(target)).toEqual(['b']);
  });

  it('Alt on a resize handle resizes, and in the rotate zone rotates, without copying', () => {
    const resized = raw();
    select(resized.target, ['b']);
    // b's bottom-right handle is at (50, 30).
    pointer(resized.target, 'pointerdown', at(50, 30));
    pointer(resized.target, 'pointermove', at(60, 40));
    pointer(resized.target, 'pointerup', at(60, 40));
    expect(nodeOf(resized.target, 'b').frame).toEqual(f(30, 20, 30, 20));
    expect(resized.drawn.drawn).toBe(0);
    expect(selection(resized.target)).toEqual(['b']);
    expect(undoDepth(resized.target)).toBe(1);

    const rotated = raw();
    select(rotated.target, ['b']);
    // Outside the box near its bottom-right corner.
    pointer(rotated.target, 'pointerdown', at(55, 35));
    pointer(rotated.target, 'pointermove', at(40, 45));
    pointer(rotated.target, 'pointerup', at(40, 45));
    expect(nodeOf(rotated.target, 'b').rotation).not.toBe(0);
    expect(nodeOf(rotated.target, 'b').frame).toEqual(f(30, 20, 20, 10));
    expect(rotated.drawn.drawn).toBe(0);
    expect(undoDepth(rotated.target)).toBe(1);
  });

  it('an Alt-drag whose duplicate fails moves nothing and keeps the selection', () => {
    const { target, drawn, custom } = raw(
      doc(
        [['p1', ['a', 'ct']]],
        [rect('a', 'p1', f(100, 0, 10, 10)), tally('ct', 'p1', f(0, 0, 10, 10))],
      ),
    );
    const before = documentOf(target);
    select(target, ['a']);
    custom.strict = true;
    // Inside ct's triangle (0, 0), (10, 0), (10, 10).
    pointer(target, 'pointerdown', at(7, 3));
    pointer(target, 'pointermove', at(17, 3));
    pointer(target, 'pointermove', at(27, 8));
    pointer(target, 'pointerup', at(27, 8));
    expect(documentOf(target)).toBe(before);
    expect(drawn.drawn).toBe(0);
    expect(undoDepth(target)).toBe(0);
    expect(selection(target)).toEqual(['a']);
    // The same press duplicates once the check passes.
    custom.strict = false;
    pointer(target, 'pointerdown', at(7, 3));
    pointer(target, 'pointermove', at(17, 3));
    pointer(target, 'pointerup', at(17, 3));
    expect(selection(target)).toEqual(['n1']);
    expect(nodeOf(target, 'n1').frame).toEqual(f(10, 0, 10, 10));
  });
});
