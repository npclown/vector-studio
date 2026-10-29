import { serializeDocument, type DocumentV3, type Frame, type NodeV3 } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  DEFAULT_KEYMAP,
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
// Source imports: the expected values restate the section 6 placement with the package's own
// placement helpers and the edit draft (the M1 group refit).
import { Draft } from '../../packages/editor-core/src/draft.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import {
  IDENTITY,
  apply,
  boundsOfPoints,
  corners,
  localTransform,
  relocate,
} from '../../packages/editor-core/src/geometry.js';
import { documentTree, spaceOf } from '../../packages/editor-core/src/tree.js';
import {
  CanvasInput,
  attachCanvasListeners,
  type ClipboardEventLike,
  type ClipboardWriter,
  type KeyLike,
  type ListenerTarget,
} from '../../packages/react/src/canvas-input.js';

// MVP M2-U6, M2-A10 (M2 contract, section 6; IDs per section 4.3, S8; codes per section 4.4):
// `copy`, `cut` and `paste` and the `clipboard` query, driven through `input` with host bindings
// for the clipboard actions (unbound by default) and through the commands. The fragment text is
// byte-exact (roots in paint order, page-space roots with parent ""); copy then paste round-trips
// every v2 node type with fresh IDs at the same page placement into the page, a scope and a
// selected frame, rotated targets included; `at`; cut is one step and a failed cut keeps the
// clipboard; each paste failure has no partial document and draws no ID; clip depth 32 and 33,
// tree depth 256 and 257 at the target, and a target failing both gives `document.invalid-field`;
// foreign and empty text create nothing.

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const ctrl: Modifiers = { ...none, ctrl: true };
const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });
const at = (x: number, y: number): PagePoint => ({ x, y });
const MARKER = 'vector-studio/fragment\n';

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

function ellipse(id: string, parent: string, frame: Frame): Loose {
  return {
    ...base(id, parent, frame),
    type: 'ellipse',
    fill: null,
    stroke: { color: black, width: 2 },
  };
}

function line(id: string, parent: string, frame: Frame): Loose {
  return {
    ...base(id, parent, frame),
    type: 'line',
    points: [0, 0, 1, 1],
    stroke: DEFAULT_PATH_STROKE,
    startArrow: 'triangle',
    endArrow: 'none',
  };
}

function triangle(id: string, parent: string, frame: Frame): Loose {
  return {
    ...base(id, parent, frame),
    type: 'path',
    path: {
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 1, 0, 1, 1],
      fillRule: 'evenodd',
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
    data: { level, tags: ['b', 'a'] },
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
 * Page p1: one node of every leaf type at the page root (`a` with corner radii and a stroke,
 * `el`, `ln`, `pt`, custom `ct`), a rotated group `g` (`ga`, `gb`), a rotated frame `fr` holding
 * a rotated rectangle `fc` and a group `fg` (`fga`, custom `fct`), a mask group `mg` (`mp`,
 * `mr`), a rotated frame `tf` (`tfc`) and an empty frame `sf`; page p2: `o`.
 */
const FIXTURE = doc(
  [
    ['p1', ['a', 'el', 'ln', 'pt', 'ct', 'g', 'fr', 'mg', 'tf', 'sf']],
    ['p2', ['o']],
  ],
  [
    {
      ...rect('a', 'p1', f(0, 0, 10, 10)),
      cornerRadii: [1, 2, 3, 4],
      stroke: { color: black, width: 2 },
    },
    ellipse('el', 'p1', f(20, 0, 10, 5)),
    line('ln', 'p1', f(40, 0, 10, 10)),
    triangle('pt', 'p1', f(60, 0, 10, 10)),
    tally('ct', 'p1', f(80, 0, 10, 10)),
    container('group', 'g', 'p1', ['ga', 'gb'], f(200, 0, 60, 40), 0.5),
    rect('ga', 'g', f(0, 0, 30, 20)),
    rect('gb', 'g', f(30, 20, 30, 20)),
    container('frame', 'fr', 'p1', ['fc', 'fg'], f(0, 300, 200, 100), -0.4),
    rect('fc', 'fr', f(10, 10, 40, 20), 0.1),
    container('group', 'fg', 'fr', ['fga', 'fct'], f(100, 50, 60, 30)),
    rect('fga', 'fg', f(0, 0, 30, 30)),
    tally('fct', 'fg', f(30, 0, 30, 30), 2),
    container('maskGroup', 'mg', 'p1', ['mp', 'mr'], f(500, 300, 50, 50)),
    triangle('mp', 'mg', f(0, 0, 50, 50)),
    rect('mr', 'mg', f(10, 10, 20, 20)),
    container('frame', 'tf', 'p1', ['tfc'], f(600, 0, 100, 100), 0.3),
    rect('tfc', 'tf', f(10, 10, 10, 10)),
    container('frame', 'sf', 'p1', [], f(800, 0, 100, 100)),
    rect('o', 'p2', f(0, 0, 10, 10)),
  ],
);

/** `ext.tally`: data `{ level, tags }`; rejects every node while `strict` holds. */
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

/** Host bindings for the clipboard actions, which have no default chord (M2-Q4). */
const CLIPBOARD_KEYS: readonly KeyBinding[] = [
  { chord: 'Mod+C', action: 'copy' },
  { chord: 'Mod+X', action: 'cut' },
  { chord: 'Mod+V', action: 'paste' },
];

function setup(document: unknown = FIXTURE, ids?: IdSource) {
  const source = counter();
  const custom = tallyExtension();
  const target = createEditor({
    ids: ids ?? source.ids,
    document,
    extensions: [custom.extension],
    keymap: CLIPBOARD_KEYS,
  });
  return { target, drawn: source.state, custom: custom.state };
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function press(target: Editor, key: string, modifiers = ctrl): CommandResult {
  return target.execute({ type: 'input', event: { kind: 'keydown', key, modifiers } });
}

const select = (target: Editor, ids: readonly string[]) =>
  ok(target, { type: 'setSelection', ids });
const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const documentOf = (target: Editor) => target.query({ type: 'document' });
const nodeOf = (target: Editor, id: string) => target.query({ type: 'node', id })!;
const selection = (target: Editor) => target.query({ type: 'selection' });
const clipboard = (target: Editor) => target.query({ type: 'clipboard' });
const undoDepth = (target: Editor) => target.query({ type: 'history' }).undoDepth;
const childrenOf = (target: Editor, owner: string): readonly string[] => {
  const page = documentOf(target).pages.find((entry) => entry.id === owner);
  if (page !== undefined) return page.children;
  return (nodeOf(target, owner) as { children: readonly string[] }).children;
};

/** A copy of `node` with ID `id` and, optionally, other fields replaced. */
function copyOf(node: NodeV3, id: string, changes: Partial<Record<string, unknown>> = {}) {
  return { ...node, id, ...changes };
}

/** A node's frame and rotation in page space, as `copy` converts a root. */
function pagePlacement(document: DocumentV3, id: string) {
  const node = document.nodes[id]!;
  const tree = documentTree(document);
  if (tree.page(node.parent) !== undefined) return { frame: node.frame, rotation: node.rotation };
  const space = spaceOf(tree, node.parent);
  return relocate(node.frame, node.rotation, space.matrix, space.rotation, IDENTITY, 0);
}

/** A page placement mapped into the space of container `owner`, as `paste` maps a root. */
function placedIn(
  document: DocumentV3,
  owner: string,
  placement: Readonly<{ frame: Frame; rotation: number }>,
) {
  const space = spaceOf(documentTree(document), owner);
  return relocate(placement.frame, placement.rotation, IDENTITY, 0, space.matrix, space.rotation);
}

/** The page corners of a node's rotated frame. */
function pageCorners(document: DocumentV3, id: string): PagePoint[] {
  const node = document.nodes[id]!;
  const { matrix } = spaceOf(documentTree(document), node.parent);
  const local = localTransform(node.frame, node.rotation);
  const { width, height } = node.frame;
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ].map(([x, y]) => {
    const p = apply(local, x!, y!);
    return apply(matrix, p.x, p.y);
  });
}

function expectSamePlace(a: readonly PagePoint[], b: readonly PagePoint[]) {
  a.forEach((point, i) => {
    expect(point.x).toBeCloseTo(b[i]!.x, 9);
    expect(point.y).toBeCloseTo(b[i]!.y, 9);
  });
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

// The fragment's fixed node tail: constraints, opacity and visibility of every fixture node.
const TAIL = '"constraints":{"horizontal":"start","vertical":"start"},"opacity":1,"visible":true';
const BLACK = '{"r":0,"g":0,"b":0,"a":1}';

/** Page p1: `z`, a group `g` at (100, 50) holding `a`, and a group `k` holding the ellipse `kc`. */
const BYTES = doc(
  [['p1', ['z', 'g', 'k']]],
  [
    rect('z', 'p1', f(30, 20, 20, 10)),
    container('group', 'g', 'p1', ['a'], f(100, 50, 20, 20)),
    rect('a', 'g', f(5, 5, 10, 10)),
    container('group', 'k', 'p1', ['kc'], f(0, 100, 10, 10)),
    ellipse('kc', 'k', f(0, 0, 10, 10)),
  ],
);

/**
 * The fragment of `k`, `a` and `z` of BYTES, written out by hand: fragment version 2 (M7
 * contract, section 6), which carries no source here.
 */
const BYTES_FRAGMENT =
  MARKER +
  '{"fragmentVersion":2,"schemaVersion":3,"roots":["z","a","k"],"nodes":{' +
  '"a":{"id":"a","name":"a","parent":"","frame":{"x":105,"y":55,"width":10,"height":10},' +
  `"rotation":0,${TAIL},"type":"rectangle","cornerRadii":[0,0,0,0],"fill":${BLACK},` +
  '"stroke":null},' +
  '"k":{"id":"k","name":"k","parent":"","frame":{"x":0,"y":100,"width":10,"height":10},' +
  `"rotation":0,${TAIL},"type":"group","children":["kc"]},` +
  '"kc":{"id":"kc","name":"kc","parent":"k","frame":{"x":0,"y":0,"width":10,"height":10},' +
  `"rotation":0,${TAIL},"type":"ellipse","fill":null,"stroke":{"color":${BLACK},"width":2}},` +
  '"z":{"id":"z","name":"z","parent":"","frame":{"x":30,"y":20,"width":20,"height":10},' +
  `"rotation":0,${TAIL},"type":"rectangle","cornerRadii":[0,0,0,0],"fill":${BLACK},` +
  '"stroke":null}},"sources":[],"sourceNodes":{}}';

describe('M2-A10 copy', () => {
  it('writes the byte-exact fragment: roots in paint order, page-space roots, sorted nodes', () => {
    const { target } = setup(BYTES);
    expect(clipboard(target)).toBeNull();
    select(target, ['k', 'a', 'z']);
    const before = documentOf(target);
    expect(press(target, 'c')).toEqual({ ok: true, ids: ['z', 'a', 'k'], consumed: true });
    expect(clipboard(target)).toBe(BYTES_FRAGMENT);
    // Copy changes neither the document, the history nor the selection.
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
    expect(selection(target)).toEqual(['k', 'a', 'z']);
    // The command with listed IDs (a listed descendant is ignored) gives the same text.
    const other = setup(BYTES).target;
    expect(other.execute({ type: 'copy', ids: ['z', 'kc', 'k', 'a'] })).toEqual({
      ok: true,
      ids: ['z', 'a', 'k'],
    });
    expect(clipboard(other)).toBe(BYTES_FRAGMENT);
  });

  it('converts a nested root in rotated containers to page space', () => {
    const { target } = setup();
    const before = documentOf(target);
    ok(target, { type: 'copy', ids: ['fc', 'gb'] });
    const body = JSON.parse(clipboard(target)!.slice(MARKER.length)) as {
      roots: string[];
      nodes: Record<string, NodeV3>;
    };
    // gb (inside g) paints before fc (inside fr).
    expect(body.roots).toEqual(['gb', 'fc']);
    for (const id of ['gb', 'fc']) {
      const { frame, rotation } = pagePlacement(before, id);
      expect(body.nodes[id]).toEqual({ ...before.nodes[id], parent: '', frame, rotation });
    }
  });

  it('with an empty selection changes nothing and is not consumed', () => {
    const { target } = setup();
    const before = documentOf(target);
    expect(press(target, 'c')).toEqual({ ok: true, ids: [], consumed: false });
    expect(press(target, 'x')).toEqual({ ok: true, ids: [], consumed: false });
    expect(clipboard(target)).toBeNull();
    expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: [] });
    expect(target.execute({ type: 'cut' })).toEqual({ ok: true, ids: [] });
    expect(clipboard(target)).toBeNull();
    // An earlier copy stays.
    ok(target, { type: 'copy', ids: ['a'] });
    const copied = clipboard(target);
    expect(press(target, 'c')).toEqual({ ok: true, ids: [], consumed: false });
    expect(press(target, 'x')).toEqual({ ok: true, ids: [], consumed: false });
    expect(clipboard(target)).toBe(copied);
    expect(documentOf(target)).toBe(before);
  });

  it('checks ids: empty, repeated or unknown, and nodes of the active page only', () => {
    const { target } = setup();
    expect(target.execute({ type: 'copy', ids: [] })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/ids',
    });
    expect(target.execute({ type: 'cut', ids: ['a', 'a'] })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/ids',
    });
    expect(target.execute({ type: 'copy', ids: ['missing'] })).toEqual({
      ok: false,
      code: 'editor.unknown-node',
    });
    expect(target.execute({ type: 'cut', ids: ['o'] })).toEqual({
      ok: false,
      code: 'editor.unknown-node',
    });
    expect(clipboard(target)).toBeNull();
    expect(undoDepth(target)).toBe(0);
  });

  it('the clipboard actions are unbound by default and the clipboard survives load and page', () => {
    for (const action of ['copy', 'cut', 'paste']) {
      expect(DEFAULT_KEYMAP.some((binding) => binding.action === action)).toBe(false);
    }
    const plain = createEditor({ document: BYTES });
    ok(plain, { type: 'setSelection', ids: ['z'] });
    expect(press(plain, 'c')).toEqual({ ok: true, ids: [], consumed: false });
    expect(clipboard(plain)).toBeNull();

    const { target } = setup();
    ok(target, { type: 'copy', ids: ['a'] });
    const copied = clipboard(target);
    ok(target, { type: 'setActivePage', id: 'p2' });
    ok(target, { type: 'loadDocument', document: BYTES });
    expect(clipboard(target)).toBe(copied);
    // A copy raises no event.
    const events: unknown[] = [];
    target.subscribe((event) => events.push(event));
    ok(target, { type: 'copy', ids: ['z'] });
    expect(events).toEqual([]);
  });
});

describe('M2-A10 paste', () => {
  it('round-trips every v2 node type with fresh IDs in paint order, each subtree in pre-order', () => {
    const { target, drawn } = setup();
    const before = documentOf(target);
    const roots = ['mg', 'fr', 'g', 'ct', 'pt', 'ln', 'el', 'a'];
    select(target, roots);
    press(target, 'c');
    const ready = text(target);
    // Mod+V: the in-memory clipboard, onto the active page (no scope, no selected frame).
    select(target, []);
    const result = press(target, 'v');
    expect(result).toEqual({
      ok: true,
      ids: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n9', 'n14'],
      consumed: true,
    });
    expect(drawn.drawn).toBe(16);
    const map: Record<string, string> = {
      a: 'n1',
      el: 'n2',
      ln: 'n3',
      pt: 'n4',
      ct: 'n5',
      g: 'n6',
      ga: 'n7',
      gb: 'n8',
      fr: 'n9',
      fc: 'n10',
      fg: 'n11',
      fga: 'n12',
      fct: 'n13',
      mg: 'n14',
      mp: 'n15',
      mr: 'n16',
    };
    for (const [original, copy] of Object.entries(map)) {
      const node = before.nodes[original]!;
      const changes: Record<string, unknown> = {
        parent: Object.hasOwn(map, node.parent) ? map[node.parent] : 'p1',
      };
      if ('children' in node) changes.children = node.children.map((child) => map[child]);
      expect(nodeOf(target, copy)).toEqual(copyOf(node, copy, changes));
    }
    expect(childrenOf(target, 'p1')).toEqual([
      ...before.pages[0]!.children,
      'n1',
      'n2',
      'n3',
      'n4',
      'n5',
      'n6',
      'n9',
      'n14',
    ]);
    expect(selection(target)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n9', 'n14']);
    expectOneStep(target, ready);
  });

  it('keeps the page placement of nested roots on the page and in a rotated selected frame', () => {
    const { target } = setup();
    const before = documentOf(target);
    ok(target, { type: 'copy', ids: ['fc', 'gb'] });
    // Onto the page: the roots' page placement exactly.
    expect(target.execute({ type: 'paste' })).toEqual({ ok: true, ids: ['n1', 'n2'] });
    expect(nodeOf(target, 'n1')).toEqual(
      copyOf(before.nodes.gb!, 'n1', { parent: 'p1', ...pagePlacement(before, 'gb') }),
    );
    expect(nodeOf(target, 'n2')).toEqual(
      copyOf(before.nodes.fc!, 'n2', { parent: 'p1', ...pagePlacement(before, 'fc') }),
    );
    expectSamePlace(pageCorners(documentOf(target), 'n1'), pageCorners(before, 'gb'));
    expectSamePlace(pageCorners(documentOf(target), 'n2'), pageCorners(before, 'fc'));
    // Into the selected rotated frame tf: mapped into its space, on top of its children.
    select(target, ['tf']);
    expect(target.execute({ type: 'paste' })).toEqual({ ok: true, ids: ['n3', 'n4'] });
    expect(childrenOf(target, 'tf')).toEqual(['tfc', 'n3', 'n4']);
    for (const [original, copy] of [
      ['gb', 'n3'],
      ['fc', 'n4'],
    ] as const) {
      const placed = placedIn(before, 'tf', pagePlacement(before, original));
      expect(nodeOf(target, copy)).toEqual(
        copyOf(before.nodes[original]!, copy, { parent: 'tf', ...placed }),
      );
      expectSamePlace(pageCorners(documentOf(target), copy), pageCorners(before, original));
    }
    expect(selection(target)).toEqual(['n3', 'n4']);
  });

  it('pastes into the scope (a rotated group that refits), which wins over a selected frame', () => {
    const { target } = setup();
    const before = documentOf(target);
    ok(target, { type: 'copy', ids: ['a', 'fga'] });
    ok(target, { type: 'setScope', id: 'g' });
    select(target, ['ga']);
    const ready = text(target);
    expect(target.execute({ type: 'paste' })).toEqual({ ok: true, ids: ['n1', 'n2'] });
    const draft = new Draft(before);
    for (const [original, copy] of [
      ['a', 'n1'],
      ['fga', 'n2'],
    ] as const) {
      const placed = placedIn(before, 'g', pagePlacement(before, original));
      draft.set(copyOf(before.nodes[original]!, copy, { parent: 'g', ...placed }));
    }
    draft.setChildren('g', ['ga', 'gb', 'n1', 'n2']);
    const expected = draft.finish(() => null);
    if ('ok' in expected) throw new Error(expected.code);
    expect(text(target)).toBe(serializeDocument(expected));
    expectSamePlace(pageCorners(documentOf(target), 'n1'), pageCorners(before, 'a'));
    expectSamePlace(pageCorners(documentOf(target), 'n2'), pageCorners(before, 'fga'));
    expect(selection(target)).toEqual(['n1', 'n2']);
    expectOneStep(target, ready);

    // A scope wins over a single selected frame.
    const scoped = setup();
    ok(scoped.target, { type: 'copy', ids: ['a'] });
    ok(scoped.target, { type: 'setScope', id: 'mg' });
    select(scoped.target, ['tf']);
    ok(scoped.target, { type: 'paste' });
    expect(childrenOf(scoped.target, 'mg')).toEqual(['mp', 'mr', 'n1']);
  });

  it('goes to the page unless exactly one frame is selected', () => {
    for (const [ids, owner] of [
      [['sf'], 'sf'],
      [['tfc'], 'p1'],
      [['sf', 'tf'], 'p1'],
      [['g'], 'p1'],
      [['fr'], 'fr'],
    ] as const) {
      const { target } = setup();
      ok(target, { type: 'copy', ids: ['a'] });
      select(target, ids);
      ok(target, { type: 'paste' });
      const children = childrenOf(target, owner);
      expect(children[children.length - 1], ids.join()).toBe('n1');
    }
  });

  it('`at` moves the roots’ joint page bounds centre to the point', () => {
    const { target } = setup();
    ok(target, { type: 'copy', ids: ['el', 'a'] });
    // Bounds (0, 0)–(30, 10), centre (15, 5): the move is (85, 95).
    expect(target.execute({ type: 'paste', at: at(100, 100) })).toEqual({
      ok: true,
      ids: ['n1', 'n2'],
    });
    expect(nodeOf(target, 'n1').frame).toEqual(f(85, 95, 10, 10));
    expect(nodeOf(target, 'n2').frame).toEqual(f(105, 95, 10, 5));

    // A rotated root into the rotated frame tf: moved in page space, then mapped.
    const before = documentOf(target);
    ok(target, { type: 'copy', ids: ['g'] });
    select(target, ['tf']);
    expect(target.execute({ type: 'paste', at: at(650, 50) })).toEqual({ ok: true, ids: ['n3'] });
    const page = pagePlacement(before, 'g');
    const bounds = boundsOfPoints(corners(page.frame, page.rotation))!;
    const dx = 650 - (bounds.x + bounds.width / 2);
    const dy = 50 - (bounds.y + bounds.height / 2);
    const moved = { ...page, frame: { ...page.frame, x: page.frame.x + dx, y: page.frame.y + dy } };
    expect(nodeOf(target, 'n3')).toEqual(
      copyOf(before.nodes.g!, 'n3', {
        parent: 'tf',
        children: ['n4', 'n5'],
        ...placedIn(before, 'tf', moved),
      }),
    );
    expect(nodeOf(target, 'n4')).toEqual(copyOf(before.nodes.ga!, 'n4', { parent: 'n3' }));
  });

  it('pastes given text, not the in-memory clipboard, and goes through a gesture update', () => {
    const { target } = setup(BYTES);
    ok(target, { type: 'copy', ids: ['z'] });
    expect(target.execute({ type: 'paste', text: BYTES_FRAGMENT })).toEqual({
      ok: true,
      ids: ['n1', 'n2', 'n3'],
    });
    expect(nodeOf(target, 'n2').frame).toEqual(f(105, 55, 10, 10));
    expect(childrenOf(target, 'n3')).toEqual(['n4']);
    // A creating command: a gesture issues it once through update.
    const { gesture } = internalsOf(target);
    expect(gesture.begin()).toBe(true);
    expect(gesture.update({ type: 'paste' })).toEqual({ ok: true, ids: ['n5'] });
    gesture.commit();
    expect(undoDepth(target)).toBe(2);
    expect(nodeOf(target, 'n5')).toMatchObject({ name: 'z', parent: 'p1' });
  });
});

describe('M2-A10 cut', () => {
  it('copies and deletes as one step; the pasted copy restores the placement', () => {
    const { target } = setup();
    const before = documentOf(target);
    select(target, ['gb', 'a']);
    expect(press(target, 'x')).toEqual({ ok: true, ids: ['a', 'gb'], consumed: true });
    expect(nodeOf(target, 'a')).toBeNull();
    expect(nodeOf(target, 'gb')).toBeNull();
    expect(selection(target)).toEqual([]);
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(serializeDocument(before));
    ok(target, { type: 'redo' });
    expect(JSON.parse(clipboard(target)!.slice(MARKER.length))).toMatchObject({
      roots: ['a', 'gb'],
    });
    press(target, 'v');
    expect(nodeOf(target, 'n1')).toEqual(copyOf(before.nodes.a!, 'n1'));
    expect(nodeOf(target, 'n2')).toEqual(
      copyOf(before.nodes.gb!, 'n2', { parent: 'p1', ...pagePlacement(before, 'gb') }),
    );
    expect(undoDepth(target)).toBe(2);
  });

  it('a failed cut changes neither the document nor the clipboard', () => {
    const { target } = setup();
    ok(target, { type: 'copy', ids: ['a'] });
    const copied = clipboard(target);
    const before = documentOf(target);
    // Deleting the mask source would leave mg without a path first child.
    select(target, ['mp']);
    expect(press(target, 'x')).toEqual({
      ok: false,
      code: 'editor.invalid-mask-source',
      path: '/nodes/mg/children/0',
      consumed: true,
    });
    expect(target.execute({ type: 'cut', ids: ['mp'] })).toMatchObject({
      ok: false,
      code: 'editor.invalid-mask-source',
    });
    expect(clipboard(target)).toBe(copied);
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
  });
});

/** A fragment text from a body value. */
const marked = (body: unknown) => MARKER + JSON.stringify(body);

/** A valid one-node body that the failure cases change. */
function body(nodes: Record<string, unknown>, roots: unknown = Object.keys(nodes).slice(0, 1)) {
  return { fragmentVersion: 1, schemaVersion: 2, roots, nodes };
}
const leaf = (id: string, parent = '') => rect(id, parent, f(0, 0, 10, 10));

describe('M2-A10 paste failures', () => {
  const cases: [string, Command, CommandResult][] = [
    [
      'text not a string',
      { type: 'paste', text: 5 } as unknown as Command,
      { ok: false, code: 'editor.invalid-command', path: '/text' },
    ],
    [
      'at not a point',
      { type: 'paste', text: 'x', at: { x: Number.NaN, y: 0 } },
      { ok: false, code: 'editor.invalid-command', path: '/at' },
    ],
    ['empty clipboard', { type: 'paste' }, { ok: false, code: 'editor.empty-clipboard' }],
    [
      'empty text',
      { type: 'paste', text: '' },
      { ok: false, code: 'editor.unsupported-clipboard' },
    ],
    [
      'foreign text',
      { type: 'paste', text: 'hello' },
      { ok: false, code: 'editor.unsupported-clipboard' },
    ],
    [
      'an unmarked fragment body',
      { type: 'paste', text: JSON.stringify(body({ a: leaf('a') })) },
      { ok: false, code: 'editor.unsupported-clipboard' },
    ],
    [
      'a document text',
      { type: 'paste', text: serializeDocument(FIXTURE as unknown as DocumentV3) },
      { ok: false, code: 'editor.unsupported-clipboard' },
    ],
    [
      'the marker alone',
      { type: 'paste', text: 'vector-studio/fragment' },
      { ok: false, code: 'editor.invalid-clipboard', path: '' },
    ],
    [
      'a CR LF marker line',
      {
        type: 'paste',
        text: `vector-studio/fragment\r\n${JSON.stringify(body({ a: leaf('a') }))}`,
      },
      { ok: false, code: 'editor.invalid-clipboard', path: '' },
    ],
    [
      'malformed JSON',
      { type: 'paste', text: `${MARKER}{"fragmentVersion":1,` },
      { ok: false, code: 'document.malformed-json', path: '' },
    ],
    [
      'a repeated node key',
      {
        type: 'paste',
        text: `${MARKER}{"fragmentVersion":1,"schemaVersion":2,"roots":["a"],"nodes":{"a":${JSON.stringify(leaf('a'))},"a":${JSON.stringify(leaf('a'))}}}`,
      },
      { ok: false, code: 'document.duplicate-id', path: '/nodes/a' },
    ],
    [
      'a repeated top-level key',
      { type: 'paste', text: `${MARKER}{"fragmentVersion":1,"fragmentVersion":1}` },
      { ok: false, code: 'document.invalid-field', path: '/fragmentVersion' },
    ],
    [
      'not an object',
      { type: 'paste', text: `${MARKER}[]` },
      { ok: false, code: 'editor.invalid-clipboard', path: '' },
    ],
    [
      'a missing key',
      { type: 'paste', text: marked({ fragmentVersion: 1, schemaVersion: 2, nodes: {} }) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/roots' },
    ],
    [
      'an unknown key',
      { type: 'paste', text: marked({ ...body({ a: leaf('a') }), extra: 1 }) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/extra' },
    ],
    // Fragment version 2 (M7 contract, section 6) has six keys: the four-key body misses one.
    [
      'fragmentVersion 2 with the four keys',
      { type: 'paste', text: marked({ ...body({ a: leaf('a') }), fragmentVersion: 2 }) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/sources' },
    ],
    [
      'fragmentVersion 3',
      { type: 'paste', text: marked({ ...body({ a: leaf('a') }), fragmentVersion: 3 }) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/fragmentVersion' },
    ],
    [
      'schemaVersion 1',
      { type: 'paste', text: marked({ ...body({ a: leaf('a') }), schemaVersion: 1 }) },
      { ok: false, code: 'document.unsupported-version', path: '/schemaVersion' },
    ],
    [
      'no roots',
      { type: 'paste', text: marked(body({ a: leaf('a') }, [])) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/roots' },
    ],
    [
      'nodes not an object',
      { type: 'paste', text: marked({ ...body({}), roots: ['a'], nodes: [] }) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/nodes' },
    ],
    [
      'a root that is not a node',
      { type: 'paste', text: marked(body({ a: leaf('a') }, ['a', 'b'])) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/roots/1' },
    ],
    [
      'a repeated root',
      { type: 'paste', text: marked(body({ a: leaf('a') }, ['a', 'a'])) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/roots/1' },
    ],
    [
      'an invalid node field',
      { type: 'paste', text: marked(body({ a: rect('a', '', f(0, 0, -1, 10)) })) },
      { ok: false, code: 'document.invalid-field', path: '/nodes/a/frame/width' },
    ],
    [
      'a node key that is not its ID',
      { type: 'paste', text: marked(body({ a: leaf('b') })) },
      { ok: false, code: 'document.invalid-field', path: '/nodes/a/id' },
    ],
    [
      'a root whose parent is not empty',
      { type: 'paste', text: marked(body({ a: leaf('a', 'p1') })) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/nodes/a/parent' },
    ],
    [
      'a root whose parent is the holder ID',
      { type: 'paste', text: marked(body({ a: leaf('a', 'fragment') })) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/nodes/a/parent' },
    ],
    [
      'a root whose parent is the holder ID next to a node named fragment',
      {
        type: 'paste',
        text: marked(
          body({
            a: container('group', 'a', 'fragment-1', ['fragment'], f(0, 0, 10, 10)),
            fragment: leaf('fragment', 'a'),
          }),
        ),
      },
      { ok: false, code: 'editor.invalid-clipboard', path: '/nodes/a/parent' },
    ],
    // Two failures at once: the first in the parse order wins.
    [
      'schemaVersion 4 with no roots: the roots shape first',
      { type: 'paste', text: marked({ ...body({ a: leaf('a') }, []), schemaVersion: 4 }) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/roots' },
    ],
    [
      'schemaVersion 4 with a root that is not a node: the roots first',
      { type: 'paste', text: marked({ ...body({ a: leaf('a') }, ['b']), schemaVersion: 4 }) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/roots/0' },
    ],
    [
      'schemaVersion 4 with a repeated root: the roots first',
      { type: 'paste', text: marked({ ...body({ a: leaf('a') }, ['a', 'a']), schemaVersion: 4 }) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/roots/1' },
    ],
    [
      'schemaVersion 4 with valid roots: the version',
      { type: 'paste', text: marked({ ...body({ a: leaf('a') }), schemaVersion: 4 }) },
      { ok: false, code: 'document.unsupported-version', path: '/schemaVersion' },
    ],
    [
      'fragmentVersion 2 with a repeated node key: the JSON rules first',
      {
        type: 'paste',
        text: `${MARKER}{"fragmentVersion":2,"schemaVersion":2,"roots":["a"],"nodes":{"a":${JSON.stringify(leaf('a'))},"a":${JSON.stringify(leaf('a'))}}}`,
      },
      { ok: false, code: 'document.duplicate-id', path: '/nodes/a' },
    ],
    [
      'a bad frame width on a node with a dangling parent: the node fields first',
      {
        type: 'paste',
        text: marked(body({ a: leaf('a'), b: rect('b', 'missing', f(0, 0, -1, 10)) })),
      },
      { ok: false, code: 'document.invalid-field', path: '/nodes/b/frame/width' },
    ],
    [
      'a node no root reaches',
      { type: 'paste', text: marked(body({ a: leaf('a'), b: leaf('b', 'a') })) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/nodes/b/parent' },
    ],
    [
      'a second, empty-parent node that is not a root',
      { type: 'paste', text: marked(body({ a: leaf('a'), b: leaf('b') })) },
      { ok: false, code: 'editor.invalid-clipboard', path: '/nodes/b/parent' },
    ],
    [
      'a child listed twice',
      {
        type: 'paste',
        text: marked(
          body({ g: container('group', 'g', '', ['b', 'b'], f(0, 0, 10, 10)), b: leaf('b', 'g') }),
        ),
      },
      { ok: false, code: 'editor.invalid-clipboard', path: '/nodes/g/children/1' },
    ],
    [
      'a root listed as a child',
      {
        type: 'paste',
        text: marked(
          body({ g: container('group', 'g', '', ['g'], f(0, 0, 10, 10)), b: leaf('b', 'g') }),
        ),
      },
      { ok: false, code: 'editor.invalid-clipboard', path: '/nodes/g/children/0' },
    ],
    [
      'a child whose parent differs',
      {
        type: 'paste',
        text: marked(
          body(
            {
              g: container('group', 'g', '', ['b'], f(0, 0, 10, 10)),
              h: container('group', 'h', '', ['c'], f(0, 0, 10, 10)),
              b: leaf('b', 'h'),
              c: leaf('c', 'h'),
            },
            ['g', 'h'],
          ),
        ),
      },
      { ok: false, code: 'editor.invalid-clipboard', path: '/nodes/b/parent' },
    ],
    [
      'a cycle',
      {
        type: 'paste',
        text: marked(
          body({
            a: leaf('a'),
            x: container('group', 'x', 'y', ['y'], f(0, 0, 10, 10)),
            y: container('group', 'y', 'x', ['x'], f(0, 0, 10, 10)),
          }),
        ),
      },
      { ok: false, code: 'editor.invalid-clipboard', path: '/nodes/x/parent' },
    ],
    [
      'an empty group',
      { type: 'paste', text: marked(body({ g: container('group', 'g', '', [], f(0, 0, 1, 1)) })) },
      { ok: false, code: 'document.invalid-field', path: '/nodes/g/children' },
    ],
    [
      'a mask group without a path source',
      {
        type: 'paste',
        text: marked(
          body({ m: container('maskGroup', 'm', '', ['b'], f(0, 0, 1, 1)), b: leaf('b', 'm') }),
        ),
      },
      { ok: false, code: 'document.invalid-mask-source', path: '/nodes/m/children/0' },
    ],
    [
      'an unknown custom type',
      {
        type: 'paste',
        text: marked(body({ c: { ...tally('c', '', f(0, 0, 1, 1)), customType: 'other' } })),
      },
      { ok: false, code: 'document.unknown-custom-type', path: '/nodes/c/customType' },
    ],
    [
      'invalid custom data',
      { type: 'paste', text: marked(body({ c: { ...tally('c', '', f(0, 0, 1, 1)), data: 1 } })) },
      { ok: false, code: 'document.invalid-custom-data', path: '/nodes/c/data' },
    ],
    [
      'a placement that overflows',
      {
        type: 'paste',
        text: marked(body({ a: rect('a', '', f(1e308, 0, 10, 10)) })),
        at: at(-1e308, 0),
      },
      { ok: false, code: 'document.invalid-field', path: '/nodes/a/frame/x' },
    ],
  ];

  it.each(cases)('%s: no partial document and no ID drawn', (_, command, result) => {
    const { target, drawn } = setup();
    const before = documentOf(target);
    expect(target.execute(command)).toEqual(result);
    expect(documentOf(target)).toBe(before);
    expect(undoDepth(target)).toBe(0);
    expect(drawn.drawn).toBe(0);
    expect(selection(target)).toEqual([]);
  });

  it('a bound paste with an empty clipboard fails, consumed', () => {
    const { target } = setup();
    expect(press(target, 'v')).toEqual({
      ok: false,
      code: 'editor.empty-clipboard',
      consumed: true,
    });
  });

  it('the shape check comes before the clipboard checks', () => {
    const { target } = setup();
    expect(target.execute({ type: 'paste', at: at(Number.POSITIVE_INFINITY, 0) })).toEqual({
      ok: false,
      code: 'editor.invalid-command',
      path: '/at',
    });
  });

  it('draws IDs that do not exist or repeat, and editor.duplicate-id comes last', () => {
    const sequence = ['a', 'x1', 'x1', 'x2'];
    const { target } = setup(FIXTURE, () => sequence.shift() ?? 'a');
    ok(target, { type: 'copy', ids: ['a', 'el'] });
    expect(target.execute({ type: 'paste' })).toEqual({ ok: true, ids: ['x1', 'x2'] });
    const before = documentOf(target);
    expect(target.execute({ type: 'paste' })).toEqual({ ok: false, code: 'editor.duplicate-id' });
    expect(target.execute({ type: 'paste', text: 'hello' })).toEqual({
      ok: false,
      code: 'editor.unsupported-clipboard',
    });
    expect(documentOf(target)).toBe(before);
  });
});

describe('M2-A10 copy and cut details', () => {
  it('ids null is checked, not the selection', () => {
    const { target } = setup();
    select(target, ['a']);
    for (const type of ['copy', 'cut'] as const) {
      expect(target.execute({ type, ids: null } as unknown as Command)).toEqual({
        ok: false,
        code: 'editor.invalid-command',
        path: '/ids',
      });
    }
    expect(clipboard(target)).toBeNull();
    expect(undoDepth(target)).toBe(0);
  });

  it('writes a rotated root inside a rotated frame and sorts custom data keys, byte-exact', () => {
    // rc is centred in rf, so turning about rf's centre keeps its frame: page rotation
    // 0.25 + 0.5 = 0.75, frame (40, 40, 20, 20).
    const { target } = setup(
      doc(
        [['p1', ['rf']]],
        [
          container('frame', 'rf', 'p1', ['rc'], f(0, 0, 100, 100), 0.5),
          {
            ...base('rc', 'rf', f(40, 40, 20, 20), 0.25),
            type: 'custom',
            customType: 'ext.tally',
            data: { zeta: 1, level: 1, alpha: { b: 2, a: 1 } },
            fill: null,
            stroke: null,
          },
        ],
      ),
    );
    ok(target, { type: 'copy', ids: ['rc'] });
    expect(clipboard(target)).toBe(
      MARKER +
        '{"fragmentVersion":2,"schemaVersion":3,"roots":["rc"],"nodes":{' +
        '"rc":{"id":"rc","name":"rc","parent":"","frame":{"x":40,"y":40,"width":20,"height":20},' +
        `"rotation":0.75,${TAIL},"type":"custom","customType":"ext.tally",` +
        '"data":{"alpha":{"a":1,"b":2},"level":1,"zeta":1},"fill":null,"stroke":null}},' +
        '"sources":[],"sourceNodes":{}}',
    );
  });

  /** A select-tool drag with snapping off, so frames move by the raw delta. */
  function dragging(modifiers = none) {
    const harness = setup();
    ok(harness.target, { type: 'setSnapping', enabled: false });
    const pointer = (kind: 'pointerdown' | 'pointermove' | 'pointerup', point: PagePoint) =>
      harness.target.execute({ type: 'input', event: { kind, point, modifiers } });
    select(harness.target, ['a']);
    pointer('pointerdown', at(5, 5));
    pointer('pointermove', at(25, 15));
    return { ...harness, pointer, gesture: internalsOf(harness.target).gesture };
  }

  const frameIn = (fragment: string | null, id: string) =>
    (JSON.parse(fragment!.slice(MARKER.length)) as { nodes: Record<string, NodeV3> }).nodes[id]!
      .frame;

  it('copy during a move drag copies the live position and leaves the drag running', () => {
    const { target, pointer, gesture } = dragging();
    expect(nodeOf(target, 'a').frame).toEqual(f(20, 10, 10, 10));
    expect(target.execute({ type: 'copy' })).toEqual({ ok: true, ids: ['a'] });
    expect(frameIn(clipboard(target), 'a')).toEqual(f(20, 10, 10, 10));
    expect(gesture.active).toBe(true);
    pointer('pointermove', at(35, 15));
    pointer('pointerup', at(35, 15));
    expect(nodeOf(target, 'a').frame).toEqual(f(30, 10, 10, 10));
    expect(undoDepth(target)).toBe(1);
  });

  it('cut during a move drag copies the pre-drag frame, deletes and interrupts the drag', () => {
    const { target, pointer, gesture } = dragging();
    expect(target.execute({ type: 'cut' })).toEqual({ ok: true, ids: ['a'] });
    expect(frameIn(clipboard(target), 'a')).toEqual(f(0, 0, 10, 10));
    expect(nodeOf(target, 'a')).toBeNull();
    expect(gesture.active).toBe(false);
    pointer('pointermove', at(45, 15));
    pointer('pointerup', at(45, 15));
    expect(nodeOf(target, 'a')).toBeNull();
    expect(undoDepth(target)).toBe(1);
    ok(target, { type: 'undo' });
    expect(nodeOf(target, 'a').frame).toEqual(f(0, 0, 10, 10));
  });

  it('cut during an Alt-drag fails on the copies, which the pre-drag document lacks', () => {
    const { target, pointer, gesture } = dragging({ ...none, alt: true });
    expect(selection(target)).toEqual(['n1']);
    const live = documentOf(target);
    expect(target.execute({ type: 'cut' })).toEqual({ ok: false, code: 'editor.unknown-node' });
    expect(clipboard(target)).toBeNull();
    expect(documentOf(target)).toBe(live);
    expect(gesture.active).toBe(true);
    pointer('pointerup', at(25, 15));
    expect(nodeOf(target, 'n1').frame).toEqual(f(20, 10, 10, 10));
    expect(undoDepth(target)).toBe(1);
  });
});

describe('M2-A10 paste depth at the target', () => {
  /** Frames k1 (page root) to k`count`, the last holding `leaf`. */
  function frames(count: number, tail: Loose[] = []): Loose[] {
    const nodes: Loose[] = [];
    for (let i = 1; i <= count; i += 1) {
      const child = i === count ? (tail[0]?.id ?? 'leaf') : `k${i + 1}`;
      nodes.push(
        container('frame', `k${i}`, i === 1 ? 'p1' : `k${i - 1}`, [child], f(0, 0, 10, 10)),
      );
    }
    return tail.length > 0
      ? [...nodes, ...tail]
      : [...nodes, rect('leaf', `k${count}`, f(0, 0, 1, 1))];
  }

  /** Groups h`from` to h256 under `parent`, the last holding `leaf`. */
  function groups(from: number, parent: string): Loose[] {
    const nodes: Loose[] = [];
    for (let i = from; i <= 256; i += 1) {
      const child = i === 256 ? 'leaf' : `h${i + 1}`;
      nodes.push(
        container('group', `h${i}`, i === from ? parent : `h${i - 1}`, [child], f(0, 0, 10, 10)),
      );
    }
    return [...nodes, rect('leaf', 'h256', f(0, 0, 1, 1))];
  }

  const one = marked(body({ r: leaf('r') }));
  /** A frame `ff` holding the rectangle `fr`. */
  const framed = marked(
    body({ ff: container('frame', 'ff', '', ['fr'], f(0, 0, 10, 10)), fr: leaf('fr', 'ff') }),
  );
  /** A frame `fo` holding the frame `fi` holding the rectangle `fl`. */
  const nested = marked(
    body({
      fo: container('frame', 'fo', '', ['fi'], f(0, 0, 10, 10)),
      fi: container('frame', 'fi', 'fo', ['fl'], f(0, 0, 10, 10)),
      fl: leaf('fl', 'fi'),
    }),
  );
  /** A group `gg` holding the rectangle `gr`. */
  const grouped = marked(
    body({ gg: container('group', 'gg', '', ['gr'], f(0, 0, 10, 10)), gr: leaf('gr', 'gg') }),
  );

  function pasteInto(document: unknown, scope: string, fragment: string) {
    const { target, drawn } = setup(document);
    ok(target, { type: 'setScope', id: scope });
    const before = documentOf(target);
    const result = target.execute({ type: 'paste', text: fragment });
    if (!result.ok) {
      expect(documentOf(target)).toBe(before);
      expect(drawn.drawn).toBe(0);
    }
    return result;
  }

  it('clip depth 32 succeeds and 33 fails with editor.clip-depth', () => {
    const chain = doc([['p1', ['k1']]], frames(32));
    // A rectangle in k32 sits at clip depth 32.
    expect(pasteInto(chain, 'k32', one)).toEqual({ ok: true, ids: ['n1'] });
    // A frame (31) holding a rectangle (32) in k31.
    expect(pasteInto(chain, 'k31', framed)).toEqual({ ok: true, ids: ['n1'] });
    // A frame in k32 sits at 32, one more than a frame may.
    expect(pasteInto(chain, 'k32', framed)).toEqual({
      ok: false,
      code: 'editor.clip-depth',
      path: '/nodes/ff/parent',
    });
    // In k31: the inner frame at 32, its rectangle at 33.
    expect(pasteInto(chain, 'k31', nested)).toEqual({
      ok: false,
      code: 'editor.clip-depth',
      path: '/nodes/fi/parent',
    });
  });

  it('tree depth 256 succeeds and 257 fails with document.invalid-field', () => {
    const chain = doc([['p1', ['h1']]], groups(1, 'p1'));
    // h256 is at tree depth 255, so its children sit at 256.
    expect(pasteInto(chain, 'h256', one)).toEqual({ ok: true, ids: ['n1'] });
    expect(pasteInto(chain, 'h256', grouped)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/gr/parent',
    });
  });

  it('a target failing both depths gives document.invalid-field', () => {
    // Frames k1 to k32 (clip depth 32 below k32), then groups h33 to h256 down to tree depth 255.
    const chain = doc([['p1', ['k1']]], frames(32, groups(33, 'k32')));
    // A rectangle at tree depth 256 and clip depth 32 fits.
    expect(pasteInto(chain, 'h256', one)).toEqual({ ok: true, ids: ['n1'] });
    // ff at clip depth 32 (too deep for a frame) and fr at tree depth 257: tree depth first.
    expect(pasteInto(chain, 'h256', framed)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/fr/parent',
    });
  });
});

/** A DOM clipboard event stand-in that records `preventDefault` and `setData`. */
function clipboardEvent(plain: string | null = null, withData = true) {
  const state = { prevented: false, set: [] as [string, string][], read: [] as string[] };
  const event: ClipboardEventLike = {
    clipboardData: withData
      ? {
          getData: (format) => {
            state.read.push(format);
            return format === 'text/plain' && plain !== null ? plain : '';
          },
          setData: (format, data) => {
            state.set.push([format, data]);
          },
        }
      : null,
    preventDefault: () => {
      state.prevented = true;
    },
  };
  return { event, state };
}

function listenerTarget() {
  const listeners: { type: string; listener: (event: Event) => void }[] = [];
  const target: ListenerTarget = {
    addEventListener: (type, listener) => listeners.push({ type, listener }),
    removeEventListener: (type, listener) => {
      const index = listeners.findIndex((e) => e.type === type && e.listener === listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  const fire = (type: string, event: object) =>
    listeners.filter((e) => e.type === type).forEach((e) => e.listener(event as Event));
  return { target, fire };
}

/** EditorCanvas's clipboard path over structural events, with a stand-in system clipboard. */
function canvasHost(writer?: ClipboardWriter | null, document: unknown = FIXTURE) {
  const harness = setup(document);
  const element = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    clientLeft: 0,
    clientTop: 0,
  };
  const canvasInput = new CanvasInput(
    harness.target,
    () => 600,
    () => element,
    () => writer,
  );
  const canvas = listenerTarget();
  const view = listenerTarget();
  attachCanvasListeners(canvas.target, view.target, canvasInput, () => false);
  const key = (k: string) => {
    let prevented = false;
    const event: KeyLike = {
      key: k,
      code: `Key${k.toUpperCase()}`,
      repeat: false,
      isComposing: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: true,
      preventDefault: () => {
        prevented = true;
      },
    };
    canvasInput.keyDown(event);
    return prevented;
  };
  return { ...harness, canvasInput, canvas, key };
}

/** A recording `navigator.clipboard` stand-in. */
function systemClipboard(writeText: (text: string) => unknown = () => Promise.resolve()) {
  const written: string[] = [];
  const writer: ClipboardWriter = {
    writeText: (text: string) => {
      written.push(text);
      return writeText(text);
    },
  };
  return { writer, written };
}

describe('M2-A10 EditorCanvas clipboard events (section 6)', () => {
  it('copy and cut with an empty selection leave the DOM event untouched', () => {
    const { target, canvas } = canvasHost();
    const before = documentOf(target);
    for (const type of ['copy', 'cut']) {
      const { event, state } = clipboardEvent();
      canvas.fire(type, event);
      expect(state).toEqual({ prevented: false, set: [], read: [] });
    }
    expect(clipboard(target)).toBeNull();
    expect(documentOf(target)).toBe(before);
  });

  it('copy prevents the event and writes the fragment as text/plain', () => {
    const { target, canvas } = canvasHost(undefined, BYTES);
    select(target, ['k', 'a', 'z']);
    const { event, state } = clipboardEvent();
    canvas.fire('copy', event);
    expect(state.prevented).toBe(true);
    expect(state.set).toEqual([['text/plain', BYTES_FRAGMENT]]);
    expect(clipboard(target)).toBe(BYTES_FRAGMENT);
    expect(undoDepth(target)).toBe(0);
  });

  it('cut prevents the event, writes text/plain and deletes in one step', () => {
    const { target, canvas } = canvasHost();
    const before = text(target);
    select(target, ['a']);
    const { event, state } = clipboardEvent();
    canvas.fire('cut', event);
    expect(state.prevented).toBe(true);
    expect(state.set).toEqual([['text/plain', clipboard(target)]]);
    expect(nodeOf(target, 'a')).toBeNull();
    expectOneStep(target, before);
  });

  it('a failed cut leaves the DOM event untouched', () => {
    const { target, canvas } = canvasHost();
    select(target, ['mp']);
    const { event, state } = clipboardEvent();
    canvas.fire('cut', event);
    expect(state).toEqual({ prevented: false, set: [], read: [] });
    expect(nodeOf(target, 'mp')).not.toBeNull();
  });

  it('paste always runs paste { text }, the empty string without text/plain, and prevents', () => {
    const { target, canvas } = canvasHost();
    const pastes: unknown[] = [];
    const execute = target.execute.bind(target);
    target.execute = (command) => {
      if (command.type === 'paste') pastes.push(command);
      return execute(command);
    };
    // The in-memory clipboard is never used for a DOM paste.
    ok(target, { type: 'copy', ids: ['a'] });
    const before = documentOf(target);
    const empty = clipboardEvent(null);
    canvas.fire('paste', empty.event);
    const missing = clipboardEvent(null, false);
    canvas.fire('paste', missing.event);
    expect(empty.state.prevented).toBe(true);
    expect(empty.state.read).toEqual(['text/plain']);
    expect(missing.state.prevented).toBe(true);
    expect(pastes).toEqual([
      { type: 'paste', text: '' },
      { type: 'paste', text: '' },
    ]);
    expect(documentOf(target)).toBe(before);
    // Fragment text pastes and selects.
    const marked = clipboardEvent(BYTES_FRAGMENT);
    canvas.fire('paste', marked.event);
    expect(marked.state.prevented).toBe(true);
    expect(selection(target)).toEqual(['n1', 'n2', 'n3']);
    expect(nodeOf(target, 'n1')).toMatchObject({ name: 'z', parent: 'p1' });
  });

  it('bound actions write the in-memory text with writeText', () => {
    const { writer, written } = systemClipboard();
    const { target, key } = canvasHost(writer);
    // An empty-selection copy is not consumed and writes nothing.
    expect(key('c')).toBe(false);
    expect(written).toEqual([]);
    // A failing bound paste (empty clipboard) writes nothing.
    expect(key('v')).toBe(true);
    expect(written).toEqual([]);
    select(target, ['a']);
    expect(key('c')).toBe(true);
    expect(written).toEqual([clipboard(target)]);
    expect(key('x')).toBe(true);
    expect(written).toEqual([clipboard(target), clipboard(target)]);
    // A successful bound paste writes nothing: the system clipboard may hold another app's copy.
    expect(key('v')).toBe(true);
    expect(selection(target)).toEqual(['n1']);
    expect(written).toHaveLength(2);
    // Another bound key writes nothing.
    expect(key('z')).toBe(true);
    expect(written).toHaveLength(2);
  });

  it('a bound copy key the tool consumes writes no stale text', () => {
    const { writer, written } = systemClipboard();
    const { target, key } = canvasHost(writer);
    ok(target, { type: 'copy', ids: ['el'] });
    const stale = clipboard(target);
    select(target, ['a']);
    // A tool that consumes every key (as an extension tool may consume Mod+C).
    internalsOf(target).tools.set('select', {
      input: () => true,
      reset: () => undefined,
      overlay: () => null,
    });
    expect(key('c')).toBe(true);
    expect(key('x')).toBe(true);
    expect(clipboard(target)).toBe(stale);
    expect(nodeOf(target, 'a')).not.toBeNull();
    expect(written).toEqual([]);
  });

  it('an extension tool that consumes Mod+C makes no clipboard write (M2-U7, U6 note 6)', () => {
    const { writer, written } = systemClipboard();
    const keys: string[] = [];
    const target = createEditor({
      document: FIXTURE,
      keymap: CLIPBOARD_KEYS,
      extensions: [
        tallyExtension().extension,
        {
          id: 'ext.keys',
          tools: [
            {
              id: 'ext.keys.tool',
              input: (event) => {
                if (event.kind !== 'keydown') return false;
                keys.push(event.key);
                return event.key === 'c' && event.modifiers.ctrl;
              },
              reset: () => undefined,
            },
          ],
        },
      ],
    });
    const element = {
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      clientLeft: 0,
      clientTop: 0,
    };
    const canvasInput = new CanvasInput(
      target,
      () => 600,
      () => element,
      () => writer,
    );
    const key = (k: string) => {
      let prevented = false;
      canvasInput.keyDown({
        key: k,
        code: `Key${k.toUpperCase()}`,
        repeat: false,
        isComposing: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: true,
        preventDefault: () => {
          prevented = true;
        },
      });
      return prevented;
    };
    select(target, ['a']);
    ok(target, { type: 'setTool', tool: 'ext.keys.tool' });
    // Consumed by the tool: prevented, so no DOM copy follows, and nothing copied or written.
    expect(key('c')).toBe(true);
    expect(clipboard(target)).toBeNull();
    expect(written).toEqual([]);
    // Mod+X is not the tool's: the bound cut runs and writes its text.
    expect(key('x')).toBe(true);
    expect(keys).toEqual(['c', 'x']);
    expect(written).toEqual([clipboard(target)]);
    expect(nodeOf(target, 'a')).toBeNull();
  });

  it('writeText is guarded: missing, not a function, throwing or rejecting', async () => {
    const throwing = systemClipboard(() => {
      throw new Error('no permission');
    });
    const rejecting = systemClipboard(() => Promise.reject(new Error('not focused')));
    for (const writer of [
      undefined,
      null,
      {},
      { writeText: 'yes' },
      throwing.writer,
      rejecting.writer,
    ]) {
      const { target, key } = canvasHost(writer);
      select(target, ['a']);
      expect(key('c')).toBe(true);
      expect(clipboard(target)).not.toBeNull();
    }
    expect(throwing.written).toHaveLength(1);
    expect(rejecting.written).toHaveLength(1);
    // The rejection is handled: no unhandled rejection reaches the test run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
