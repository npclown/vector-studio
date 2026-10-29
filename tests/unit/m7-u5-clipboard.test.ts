import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  serializeDocument,
  validateDocument,
  type DocumentV4,
  type NodeV4,
} from '@vector-studio/model';
import { describe, expect, it, vi } from 'vitest';
import {
  createEditor,
  starExtension,
  type Command,
  type CommandResult,
  type Editor,
  type IdSource,
  type Modifiers,
} from '../../packages/editor-core/src/index.js';
import { applyEdit } from '../../packages/editor-core/src/edits.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { ExpansionCache } from '../../packages/editor-core/src/expansion.js';

// MVP M7-U5 (M7 contract, section 6): clipboard fragment version 2 with carried sources, the
// parse order, paste linking (M7-Q9 (a)), paste and duplication of sources (M7-Q10 (a)), the
// clipboard generation, nesting through paste and group (M7-A08) and the `cut` part of the source
// deletion rule (M7-A13). Criterion M7-A14. Every command leaves a document `validateDocument`
// accepts; a failed command changes nothing, keeps the clipboard and draws no ID.

const root = path.resolve(import.meta.dirname, '../..');
// Since M6a-U1 the model returns schema v4, so each M7 fixture is read as its committed v4
// migration under tests/fixtures/m6-text/migrated (M6a contract, section 2.1).
const fixture = (name: string) =>
  readFileSync(
    path.join(
      root,
      'tests/fixtures/m6-text/migrated',
      `${path.basename(name).replace(/(\.v3)?\.json$/, '')}.v4.json`,
    ),
    'utf8',
  );
const SYMBOLS = fixture('symbols.v3.json');
const MARKER = 'vector-studio/fragment\n';
const START = { horizontal: 'start', vertical: 'start' } as const;
const RED = { r: 1, g: 0, b: 0, a: 1 };
const BLUE = { r: 0, g: 0, b: 1, a: 1 };
const GREEN = { r: 0, g: 1, b: 0, a: 1 };
const none: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };
const TAIL = '"constraints":{"horizontal":"start","vertical":"start"},"opacity":1,"visible":true';

type Json = {
  schemaVersion: number;
  id: string;
  pages: { id: string; name: string; children: string[] }[];
  nodes: Record<string, Record<string, unknown>>;
};
type Frame = { x: number; y: number; width: number; height: number };
const f = (x: number, y: number, width: number, height: number): Frame => ({
  x,
  y,
  width,
  height,
});

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
const rect = (id: string, parent: string, frame: Frame, fill = BLUE) => ({
  ...base(id, parent, frame),
  type: 'rectangle',
  cornerRadii: [0, 0, 0, 0],
  fill,
  stroke: null,
});
const container = (type: string, id: string, parent: string, children: string[], frame: Frame) => ({
  ...base(id, parent, frame),
  type,
  children,
  ...(type === 'frame' || type === 'symbol' ? { fill: RED, stroke: null } : {}),
});
const instance = (id: string, parent: string, frame: Frame, symbol: string) => ({
  ...base(id, parent, frame),
  type: 'instance',
  symbol,
});

/**
 * Page `p`: a frame `F` at (300, 300) holding source `S` (40 × 20 at (10, 10), red, holding the
 * blue rectangle `r`), then an instance `I` of `S` at twice its size, then a rectangle `X`.
 */
function small(): Json {
  return {
    schemaVersion: 4,
    id: 'd',
    pages: [{ id: 'p', name: 'P', children: ['F', 'I', 'X'] }],
    nodes: {
      F: container('frame', 'F', 'p', ['S'], f(300, 300, 100, 100)),
      S: container('symbol', 'S', 'F', ['r'], f(10, 10, 40, 20)),
      r: rect('r', 'S', f(5, 5, 10, 10)),
      I: instance('I', 'p', f(100, 0, 80, 40), 'S'),
      X: rect('X', 'p', f(0, 200, 10, 10)),
    },
  };
}
const emptyDocument = (): Json => ({
  schemaVersion: 4,
  id: 'e',
  pages: [{ id: 'q', name: 'Q', children: [] }],
  nodes: {},
});

/** An editor whose ID source the host supplies and counts: `n1`, `n2`, ... */
function counted(document: unknown = small()): { target: Editor; drawn: () => number } {
  let count = 0;
  const ids: IdSource = () => `n${++count}`;
  const target = createEditor({ document, ids });
  return { target, drawn: () => count };
}
/** An editor with the default ID source, so rule (1) of section 6 applies. */
const own = (document: unknown = small()) => createEditor({ document });

const documentOf = (target: Editor) => target.query({ type: 'document' });
const text = (target: Editor) => serializeDocument(documentOf(target));
const clipboard = (target: Editor) => target.query({ type: 'clipboard' });
const undoDepth = (target: Editor) => target.query({ type: 'history' }).undoDepth;
const nodeOf = (target: Editor, id: string) => documentOf(target).nodes[id]!;

function run(target: Editor, command: Command): CommandResult {
  const result = target.execute(command);
  expect(validateDocument(JSON.parse(text(target))).ok).toBe(true);
  return result;
}
function ok(target: Editor, command: Command): readonly string[] {
  const result = run(target, command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}
/** Expects `failure`, no change to the document or the clipboard, and no ID drawn. */
function fails(
  setup: { target: Editor; drawn?: () => number },
  command: Command,
  failure: Readonly<{ code: string; path?: string }>,
): void {
  const { target, drawn } = setup;
  const before = documentOf(target);
  const held = clipboard(target);
  const count = drawn?.();
  expect(run(target, command)).toEqual({ ok: false, ...failure });
  expect(documentOf(target)).toBe(before);
  expect(clipboard(target)).toBe(held);
  if (drawn !== undefined) expect(drawn()).toBe(count);
}
/** Runs `command` as one undo step whose undo restores the document byte for byte. */
function oneStep(target: Editor, command: Command): readonly string[] {
  const before = text(target);
  const depth = undoDepth(target);
  const ids = ok(target, command);
  expect(undoDepth(target)).toBe(depth + 1);
  const after = text(target);
  ok(target, { type: 'undo' });
  expect(text(target)).toBe(before);
  ok(target, { type: 'redo' });
  expect(text(target)).toBe(after);
  return ids;
}
const copied = (target: Editor, ids: string[]) => {
  ok(target, { type: 'copy', ids });
  return clipboard(target)!;
};
const bodyOf = (fragment: string) => JSON.parse(fragment.slice(MARKER.length)) as FragmentBody;
type FragmentBody = {
  fragmentVersion: unknown;
  schemaVersion: unknown;
  roots: unknown;
  nodes: Record<string, Record<string, unknown>>;
  sources: unknown;
  sourceNodes: Record<string, Record<string, unknown>>;
};
const marked = (body: unknown) => MARKER + JSON.stringify(body);

/** The literal text of `copy { ids: ['I'] }` on `small()`. */
const I_FRAGMENT =
  MARKER +
  '{"fragmentVersion":2,"schemaVersion":4,"roots":["I"],"nodes":{' +
  '"I":{"id":"I","name":"I","parent":"","frame":{"x":100,"y":0,"width":80,"height":40},' +
  `"rotation":0,${TAIL},"type":"instance","symbol":"S"}},` +
  '"sources":["S"],"sourceNodes":{' +
  '"S":{"id":"S","name":"S","parent":"","frame":{"x":10,"y":10,"width":40,"height":20},' +
  `"rotation":0,${TAIL},"type":"symbol","children":["r"],"fill":${JSON.stringify(RED)},` +
  '"stroke":null},' +
  '"r":{"id":"r","name":"r","parent":"S","frame":{"x":5,"y":5,"width":10,"height":10},' +
  `"rotation":0,${TAIL},"type":"rectangle","cornerRadii":[0,0,0,0],` +
  `"fill":${JSON.stringify(BLUE)},"stroke":null}}}`;

/** `I` pasted detached as `id` with the expansion copy `child` (scale 2): section 5.2. */
const detachedI = (id: string, child: string, parent: string, frame = f(100, 0, 80, 40)) => ({
  [id]: { ...container('frame', id, parent, [child], frame), name: 'I' },
  [child]: { ...rect(child, id, f(10, 10, 20, 20)), name: 'r' },
});

describe('fragment version 2 copy (M7-A14)', () => {
  it('writes the literal text: the instance, then its carried source at its local placement', () => {
    const { target } = counted();
    expect(copied(target, ['I'])).toBe(I_FRAGMENT);
  });

  it('carries no source when the source is copied, and empty lists without instances', () => {
    const { target } = counted();
    const body = bodyOf(copied(target, ['F', 'I']));
    expect(body.roots).toEqual(['F', 'I']);
    expect(Object.keys(body.nodes)).toEqual(['F', 'I', 'S', 'r']);
    expect(body.sources).toEqual([]);
    expect(body.sourceNodes).toEqual({});
    expect(bodyOf(copied(target, ['X']))).toMatchObject({ sources: [], sourceNodes: {} });
  });

  it('lists carried sources once, in pages order then pre-order', () => {
    const target = createEditor({ document: JSON.parse(SYMBOLS) as unknown });
    // i1 and i3 on page-1 name s1 (page-1) and s2 (page-2); a duplicate of i1 names s1 again.
    const [copy] = ok(target, { type: 'duplicateNodes', ids: ['i1'] });
    const body = bodyOf(copied(target, ['i3', copy!, 'i1']));
    expect(body.sources).toEqual(['s1', 's2']);
    expect(Object.keys(body.sourceNodes)).toEqual([
      's1',
      's1-e',
      's1-f',
      's1-g',
      's1-l',
      's1-p',
      's1-r',
      's2',
    ]);
    expect(body.sourceNodes.s2).toMatchObject({ parent: '', frame: f(0, 300, 50, 40) });
  });

  it('a copied source child and its instance share a key without a collision', () => {
    const { target } = counted();
    const body = bodyOf(copied(target, ['r', 'I']));
    expect(body.roots).toEqual(['r', 'I']);
    // `r` as a root in page space, and inside the carried source in its local space.
    expect(body.nodes.r).toMatchObject({ parent: '', frame: f(315, 315, 10, 10) });
    expect(body.sourceNodes.r).toMatchObject({ parent: 'S', frame: f(5, 5, 10, 10) });
    const ids = oneStep(target, { type: 'paste' });
    expect(ids).toEqual(['n1', 'n2']);
    expect(nodeOf(target, 'n1')).toMatchObject({ type: 'rectangle', frame: f(315, 315, 10, 10) });
    // Not this editor's own clipboard (a host ID source), but the content matches: linked.
    expect(nodeOf(target, 'n2')).toMatchObject({ type: 'instance', symbol: 'S' });
  });
});

describe('fragment parse order (M7 contract, section 6)', () => {
  /** A valid version 2 body carrying `S`, which `cases` change one step at a time. */
  const valid = (): FragmentBody => bodyOf(I_FRAGMENT);
  const change = (edit: (body: FragmentBody) => void): string => {
    const body = valid();
    edit(body);
    return marked(body);
  };
  const cases: [string, string, Readonly<{ code: string; path?: string }>][] = [
    [
      'a repeated sourceNodes key',
      I_FRAGMENT.replace('"sourceNodes":{', '"sourceNodes":{"S":{},'),
      { code: 'document.duplicate-id', path: '/sourceNodes/S' },
    ],
    [
      'version 2 without sourceNodes: the missing key',
      change((body) => delete (body as Partial<FragmentBody>).sourceNodes),
      { code: 'editor.invalid-clipboard', path: '/sourceNodes' },
    ],
    [
      'version 2 with an unknown key',
      change((body) => Object.assign(body, { extra: 1 })),
      { code: 'editor.invalid-clipboard', path: '/extra' },
    ],
    [
      'version "2" with six keys: four keys are expected',
      change((body) => (body.fragmentVersion = '2')),
      { code: 'editor.invalid-clipboard', path: '/sources' },
    ],
    [
      'version null with four keys',
      marked({ fragmentVersion: null, schemaVersion: 3, roots: ['a'], nodes: {} }),
      { code: 'editor.invalid-clipboard', path: '/fragmentVersion' },
    ],
    [
      'version 3',
      change((body) => (body.fragmentVersion = 3)),
      { code: 'editor.invalid-clipboard', path: '/sources' },
    ],
    [
      'roots before sources',
      change((body) => {
        body.roots = [];
        body.sources = 5;
      }),
      { code: 'editor.invalid-clipboard', path: '/roots' },
    ],
    [
      'sources not an array',
      change((body) => (body.sources = {})),
      { code: 'editor.invalid-clipboard', path: '/sources' },
    ],
    [
      'a source that is not a key of sourceNodes',
      change((body) => (body.sources = ['S', 'T'])),
      { code: 'editor.invalid-clipboard', path: '/sources/1' },
    ],
    [
      'a repeated source',
      change((body) => (body.sources = ['S', 'S'])),
      { code: 'editor.invalid-clipboard', path: '/sources/1' },
    ],
    [
      'a source that is also a key of nodes',
      change((body) => (body.nodes.S = body.sourceNodes.S!)),
      { code: 'editor.invalid-clipboard', path: '/sources/0' },
    ],
    [
      'sources before the sourceNodes shape',
      change((body) => (body.sourceNodes = [] as never)),
      { code: 'editor.invalid-clipboard', path: '/sources/0' },
    ],
    [
      'sourceNodes not an object',
      change((body) => {
        body.sources = [];
        body.sourceNodes = [] as never;
      }),
      { code: 'editor.invalid-clipboard', path: '/sourceNodes' },
    ],
    [
      'version 2 at schemaVersion 2',
      change((body) => (body.schemaVersion = 2)),
      { code: 'document.unsupported-version', path: '/schemaVersion' },
    ],
    [
      'version 1 at schemaVersion 3',
      marked({
        fragmentVersion: 1,
        schemaVersion: 3,
        roots: ['X'],
        nodes: { X: rect('X', '', f(0, 0, 1, 1)) },
      }),
      { code: 'document.unsupported-version', path: '/schemaVersion' },
    ],
    [
      'version 1 holding a symbol at schemaVersion 2',
      marked({
        fragmentVersion: 1,
        schemaVersion: 2,
        roots: ['S'],
        nodes: { S: container('symbol', 'S', '', [], f(0, 0, 1, 1)) },
      }),
      { code: 'document.invalid-field', path: '/nodes/S/type' },
    ],
    [
      'a field in nodes before a field in sourceNodes',
      change((body) => {
        body.nodes.I!.opacity = 2;
        body.sourceNodes.r!.frame = f(0, 0, -1, 1);
      }),
      { code: 'document.invalid-field', path: '/nodes/I/opacity' },
    ],
    [
      'a field in sourceNodes',
      change((body) => (body.sourceNodes.r!.frame = f(0, 0, -1, 1))),
      { code: 'document.invalid-field', path: '/sourceNodes/r/frame/width' },
    ],
    [
      'a sourceNodes key that is not its ID',
      change((body) => (body.sourceNodes.r!.id = 'q')),
      { code: 'document.invalid-field', path: '/sourceNodes/r/id' },
    ],
    [
      'the field rules before the nodes reference rules',
      change((body) => {
        body.nodes.I!.parent = 'nowhere';
        body.sourceNodes.r!.frame = f(0, 0, -1, 1);
      }),
      { code: 'document.invalid-field', path: '/sourceNodes/r/frame/width' },
    ],
    [
      'a carried root that is not a symbol',
      change((body) => {
        body.sources = ['r'];
        body.sourceNodes = { r: { ...body.sourceNodes.r!, parent: '' } };
        body.nodes.I!.symbol = 'r';
      }),
      { code: 'editor.invalid-clipboard', path: '/sourceNodes/r/type' },
    ],
    [
      'a carried root whose parent is not empty',
      change((body) => (body.sourceNodes.S!.parent = 'F')),
      { code: 'editor.invalid-clipboard', path: '/sourceNodes/S/parent' },
    ],
    [
      'a carried child not claimed by its parent',
      change((body) => (body.sourceNodes.S!.children = [])),
      { code: 'editor.invalid-clipboard', path: '/sourceNodes/r/parent' },
    ],
    [
      'a carried child listing a missing node',
      change((body) => (body.sourceNodes.S!.children = ['r', 'z'])),
      { code: 'editor.invalid-clipboard', path: '/sourceNodes/S/children/1' },
    ],
    [
      'the nodes reference rules before the sourceNodes ones',
      change((body) => {
        body.nodes.I!.parent = 'nowhere';
        body.sourceNodes.S!.parent = 'F';
      }),
      { code: 'editor.invalid-clipboard', path: '/nodes/I/parent' },
    ],
    [
      'an instance inside a copied symbol',
      change((body) => {
        body.roots = ['T'];
        body.nodes = {
          T: container('symbol', 'T', '', ['I'], f(0, 0, 10, 10)),
          I: { ...body.nodes.I!, parent: 'T' },
        };
      }),
      { code: 'document.invalid-symbol', path: '/nodes/I/parent' },
    ],
    [
      'a symbol inside a carried source',
      change((body) => {
        body.sourceNodes.S!.children = ['r', 'T'];
        body.sourceNodes.T = container('symbol', 'T', 'S', [], f(0, 0, 1, 1));
      }),
      { code: 'document.invalid-symbol', path: '/sourceNodes/T/parent' },
    ],
    [
      'nesting before the instance references',
      change((body) => {
        body.nodes.I!.symbol = 'nowhere';
        body.sourceNodes.S!.children = ['r', 'T'];
        body.sourceNodes.T = container('symbol', 'T', 'S', [], f(0, 0, 1, 1));
      }),
      { code: 'document.invalid-symbol', path: '/sourceNodes/T/parent' },
    ],
    [
      'an instance naming no copied or carried symbol',
      change((body) => (body.nodes.I!.symbol = 'nowhere')),
      { code: 'editor.invalid-clipboard', path: '/nodes/I/symbol' },
    ],
    [
      'an instance naming a copied node that is not a symbol',
      change((body) => {
        body.roots = ['I', 'X'];
        body.nodes.X = rect('X', '', f(0, 0, 1, 1));
        body.nodes.I!.symbol = 'X';
      }),
      { code: 'editor.invalid-clipboard', path: '/nodes/I/symbol' },
    ],
    [
      'an instance naming a carried descendant',
      change((body) => (body.nodes.I!.symbol = 'r')),
      { code: 'editor.invalid-clipboard', path: '/nodes/I/symbol' },
    ],
    [
      'the instance references before the tree rules',
      change((body) => {
        body.nodes.I!.symbol = 'nowhere';
        body.sourceNodes.S!.children = ['r', 'g'];
        body.sourceNodes.g = container('group', 'g', 'S', [], f(0, 0, 1, 1));
      }),
      { code: 'editor.invalid-clipboard', path: '/nodes/I/symbol' },
    ],
    [
      'the tree rules of nodes before those of sourceNodes',
      change((body) => {
        body.roots = ['I', 'g'];
        body.nodes.g = container('group', 'g', '', [], f(0, 0, 1, 1));
        body.sourceNodes.S!.children = ['r', 'h'];
        body.sourceNodes.h = container('group', 'h', 'S', [], f(0, 0, 1, 1));
      }),
      { code: 'document.invalid-field', path: '/nodes/g/children' },
    ],
    [
      'the tree rules of sourceNodes, on their own holder',
      change((body) => {
        body.sourceNodes.S!.children = ['r', 'h'];
        body.sourceNodes.h = container('group', 'h', 'S', [], f(0, 0, 1, 1));
      }),
      { code: 'document.invalid-field', path: '/sourceNodes/h/children' },
    ],
  ];

  it.each(cases)('%s', (_, fragment, failure) => {
    const setup = counted();
    fails(setup, { type: 'paste', text: fragment }, failure);
  });

  it('runs the extension checks in ID order, nodes then sourceNodes', () => {
    let count = 0;
    const target = createEditor({
      document: small(),
      ids: () => `n${++count}`,
      extensions: [starExtension],
    });
    const star = (id: string, parent: string, points: number) => ({
      ...base(id, parent, f(0, 0, 10, 10)),
      type: 'custom',
      customType: 'ext.star',
      data: { innerRatio: 0.5, points },
      fill: null,
      stroke: null,
    });
    const body = bodyOf(I_FRAGMENT);
    body.sourceNodes.S!.children = ['r', 'b'];
    body.sourceNodes.b = star('b', 'S', 2);
    const setup = { target, drawn: () => count };
    fails(
      setup,
      { type: 'paste', text: marked(body) },
      {
        code: 'document.invalid-custom-data',
        path: '/sourceNodes/b/data',
      },
    );
    body.roots = ['I', 'z'];
    body.nodes.z = star('z', '', 40);
    fails(
      setup,
      { type: 'paste', text: marked(body) },
      {
        code: 'document.invalid-custom-data',
        path: '/nodes/z/data',
      },
    );
  });

  it('a node in both maps does not collide, even at another type', () => {
    const { target } = counted(emptyDocument());
    const body = bodyOf(I_FRAGMENT);
    body.roots = ['I', 'r'];
    body.nodes.r = { ...container('group', 'r', '', ['k'], f(0, 0, 10, 10)) };
    body.nodes.k = rect('k', 'r', f(0, 0, 10, 10));
    expect(ok(target, { type: 'paste', text: marked(body) })).toEqual(['n1', 'n3']);
    expect(nodeOf(target, 'n3')).toMatchObject({ type: 'group', children: ['n4'] });
  });

  it('reads fragment version 1 at schemaVersion 2', () => {
    const { target } = counted(emptyDocument());
    const v1 = {
      fragmentVersion: 1,
      schemaVersion: 2,
      roots: ['X'],
      nodes: { X: rect('X', '', f(0, 0, 1, 1)) },
    };
    expect(ok(target, { type: 'paste', text: marked(v1) })).toEqual(['n1']);
  });
});

describe('paste of an instance alone (M7-Q9 (a))', () => {
  it('links from this editor’s own clipboard, even after its source changed', () => {
    const target = own();
    copied(target, ['I']);
    ok(target, { type: 'setNodeProps', id: 'S', props: { fill: { r: 0, g: 1, b: 0, a: 1 } } });
    const [id] = oneStep(target, { type: 'paste' });
    expect(nodeOf(target, id!)).toEqual({
      ...instance(id!, 'p', f(100, 0, 80, 40), 'S'),
      name: 'I',
    });
    // The same text passed as `text` is this editor's own clipboard too.
    const [again] = ok(target, { type: 'paste', text: clipboard(target)! });
    expect(nodeOf(target, again!)).toMatchObject({ type: 'instance', symbol: 'S' });
  });

  it('links by content match in another editor: size, fill, stroke and descendants', () => {
    const from = own();
    const fragment = copied(from, ['I']);
    // Placement, name, constraints, opacity and visibility of the source do not count.
    const moved = small();
    Object.assign(moved.nodes.S!, { name: 'renamed', frame: f(0, 0, 40, 20), visible: false });
    const { target } = counted(moved);
    expect(oneStep(target, { type: 'paste', text: fragment })).toEqual(['n1']);
    expect(nodeOf(target, 'n1')).toMatchObject({ type: 'instance', symbol: 'S' });
  });

  it.each<[string, (value: Json) => void]>([
    ['its size', (value) => (value.nodes.S!.frame = f(10, 10, 41, 20))],
    ['its fill', (value) => (value.nodes.S!.fill = BLUE)],
    ['its stroke', (value) => (value.nodes.S!.stroke = { color: BLUE, width: 1 })],
    ['a descendant', (value) => (value.nodes.r!.frame = f(6, 5, 10, 10))],
    ['a descendant’s name', (value) => (value.nodes.r!.name = 'other')],
  ])('pastes detached when the target source differs in %s', (_, edit) => {
    const fragment = copied(own(), ['I']);
    const value = small();
    edit(value);
    const { target } = counted(value);
    const before = documentOf(target);
    expect(oneStep(target, { type: 'paste', text: fragment })).toEqual(['n1']);
    expect(documentOf(target).nodes).toEqual({
      ...before.nodes,
      ...detachedI('n1', 'n2', 'p'),
    });
  });

  it('pastes detached into a foreign document, a frame as detach makes it (section 5.2)', () => {
    const fragment = copied(own(), ['I', 'X']);
    const { target, drawn } = counted(emptyDocument());
    // IDs: the instance, its expansion in the source's pre-order, then the next root.
    expect(oneStep(target, { type: 'paste', text: fragment })).toEqual(['n1', 'n3']);
    expect(drawn()).toBe(3);
    expect(documentOf(target)).toEqual({
      schemaVersion: 4,
      id: 'e',
      pages: [{ id: 'q', name: 'Q', children: ['n1', 'n3'] }],
      nodes: {
        ...detachedI('n1', 'n2', 'q'),
        n3: { ...rect('n3', 'q', f(0, 200, 10, 10)), name: 'X' },
      },
    });
  });

  it('pastes detached where the ID names a node that is not a symbol', () => {
    const fragment = copied(own(), ['I']);
    const value = emptyDocument();
    value.pages[0]!.children = ['S'];
    value.nodes.S = rect('S', 'q', f(0, 0, 1, 1));
    const { target } = counted(value);
    expect(ok(target, { type: 'paste', text: fragment })).toEqual(['n1']);
    expect(nodeOf(target, 'n1').type).toBe('frame');
  });

  it('pastes detached inside a group and into a rotated frame target', () => {
    const fragment = copied(own(), ['I']);
    const value = emptyDocument();
    value.pages[0]!.children = ['T'];
    value.nodes.T = { ...container('frame', 'T', 'q', [], f(100, 0, 200, 200)), rotation: 0 };
    const { target } = counted(value);
    ok(target, { type: 'setSelection', ids: ['T'] });
    expect(ok(target, { type: 'paste', text: fragment })).toEqual(['n1']);
    expect(documentOf(target).nodes).toMatchObject(detachedI('n1', 'n2', 'T', f(0, 0, 80, 40)));
  });

  it('with a host ID source, an own-clipboard paste goes by content alone', () => {
    const { target } = counted();
    copied(target, ['I']);
    // Equal content: linked.
    expect(ok(target, { type: 'paste' })).toEqual(['n1']);
    expect(nodeOf(target, 'n1')).toMatchObject({ type: 'instance', symbol: 'S' });
    ok(target, { type: 'setNodeProps', id: 'S', props: { fill: BLUE } });
    expect(ok(target, { type: 'paste' })).toEqual(['n2']);
    expect(nodeOf(target, 'n2')).toMatchObject({ type: 'frame', children: ['n3'], fill: RED });
  });
});

describe('the clipboard generation (section 6)', () => {
  it('is 0 at construction and counts successful loads only', () => {
    const target = own();
    expect(internalsOf(target).clipboardGeneration).toBe(0);
    ok(target, { type: 'loadDocument', document: small() });
    expect(internalsOf(target).clipboardGeneration).toBe(1);
    expect(target.execute({ type: 'loadDocument', document: {} }).ok).toBe(false);
    expect(internalsOf(target).clipboardGeneration).toBe(1);
    expect(internalsOf(createEditor()).clipboardGeneration).toBe(0);
  });

  it('after loadDocument a paste falls back to the content match', () => {
    const target = own();
    copied(target, ['I']);
    // The same text stays in the clipboard, but the load changed the generation.
    const changed = small();
    changed.nodes.S!.fill = BLUE;
    ok(target, { type: 'loadDocument', document: changed });
    const [detached] = ok(target, { type: 'paste' });
    expect(nodeOf(target, detached!)).toMatchObject({ type: 'frame', fill: RED });
    ok(target, { type: 'loadDocument', document: small() });
    const [linked] = ok(target, { type: 'paste' });
    expect(nodeOf(target, linked!)).toMatchObject({ type: 'instance', symbol: 'S' });
    // A copy in the new generation links by ID again, whatever the content.
    copied(target, ['I']);
    ok(target, { type: 'setNodeProps', id: 'S', props: { fill: BLUE } });
    const [again] = ok(target, { type: 'paste' });
    expect(nodeOf(target, again!)).toMatchObject({ type: 'instance', symbol: 'S' });
  });
});

describe('paste and duplicate of sources (M7-Q10 (a))', () => {
  it('pastes an instance with its source: the copy refers to the pasted source', () => {
    const { target } = counted();
    copied(target, ['S', 'I']);
    expect(oneStep(target, { type: 'paste' })).toEqual(['n1', 'n3']);
    expect(nodeOf(target, 'n1')).toMatchObject({
      type: 'symbol',
      name: 'S',
      parent: 'p',
      frame: f(310, 310, 40, 20),
      children: ['n2'],
    });
    expect(nodeOf(target, 'n3')).toEqual({
      ...instance('n3', 'p', f(100, 0, 80, 40), 'n1'),
      name: 'I',
    });
    expect(nodeOf(target, 'I')).toMatchObject({ symbol: 'S' });
  });

  it('pastes a source alone as a new independent source', () => {
    const { target } = counted();
    copied(target, ['S']);
    const before = documentOf(target);
    expect(oneStep(target, { type: 'paste' })).toEqual(['n1']);
    const after = documentOf(target);
    expect(after.nodes.n1).toMatchObject({ type: 'symbol', children: ['n2'] });
    expect(after.nodes.n2).toMatchObject({ ...rect('n2', 'n1', f(5, 5, 10, 10)), name: 'r' });
    for (const id of Object.keys(before.nodes)) expect(after.nodes[id]).toBe(before.nodes[id]);
    expect(Object.values(after.nodes).filter((n) => n.type === 'instance')).toHaveLength(1);
  });

  it('duplicates an instance as an instance of the same source', () => {
    const { target } = counted();
    expect(oneStep(target, { type: 'duplicateNodes', ids: ['I'] })).toEqual(['n1']);
    expect(nodeOf(target, 'n1')).toEqual({
      ...instance('n1', 'p', f(100, 0, 80, 40), 'S'),
      name: 'I',
    });
  });

  it('duplicates a source as a new source, and both together refer to the copy', () => {
    const { target } = counted();
    expect(oneStep(target, { type: 'duplicateNodes', ids: ['S'] })).toEqual(['n1']);
    expect(nodeOf(target, 'n1')).toMatchObject({ type: 'symbol', parent: 'F', children: ['n2'] });
    expect(nodeOf(target, 'I')).toMatchObject({ symbol: 'S' });
    ok(target, { type: 'undo' });
    expect(oneStep(target, { type: 'duplicateNodes', ids: ['I', 'S'] }).length).toBe(2);
    const copies = Object.values(documentOf(target).nodes).filter(
      (node) => !Object.hasOwn(small().nodes, node.id),
    );
    const symbol = copies.find((node) => node.type === 'symbol')!;
    expect(copies.find((node) => node.type === 'instance')).toMatchObject({ symbol: symbol.id });
  });

  it('Alt-drag duplicates an instance, a source and both, as one step', () => {
    const drag = (ids: string[], from: { x: number; y: number }) => {
      const { target } = counted();
      ok(target, { type: 'setSnapping', enabled: false });
      ok(target, { type: 'setSelection', ids });
      const before = text(target);
      const modifiers = { ...none, alt: true };
      const pointer = (kind: 'pointerdown' | 'pointermove' | 'pointerup', x: number) =>
        target.execute({ type: 'input', event: { kind, point: { x, y: from.y }, modifiers } });
      pointer('pointerdown', from.x);
      pointer('pointermove', from.x + 10);
      pointer('pointerup', from.x + 10);
      expect(undoDepth(target)).toBe(1);
      const created = Object.values(documentOf(target).nodes).filter(
        (node) => !Object.hasOwn(small().nodes, node.id),
      );
      ok(target, { type: 'undo' });
      expect(text(target)).toBe(before);
      return created;
    };
    const [one] = drag(['I'], { x: 120, y: 10 });
    expect(one).toEqual({ ...instance('n1', 'p', f(110, 0, 80, 40), 'S'), name: 'I' });
    const source = drag(['S'], { x: 320, y: 320 });
    expect(source[0]).toMatchObject({ id: 'n1', type: 'symbol', frame: f(20, 10, 40, 20) });
    const both = drag(['S', 'I'], { x: 120, y: 10 });
    const symbol = both.find((node) => node.type === 'symbol')!;
    expect(both.find((node) => node.type === 'instance')).toMatchObject({ symbol: symbol.id });
  });
});

describe('nesting and depth through paste, duplicate and group (M7-A08)', () => {
  it('fails a paste of a symbol or a linked instance into a source; a detached one is a frame', () => {
    const setup = counted();
    const { target } = setup;
    copied(target, ['F']);
    ok(target, { type: 'setScope', id: 'S' });
    fails(setup, { type: 'paste' }, { code: 'editor.nested-symbol', path: '/nodes/S/parent' });
    ok(target, { type: 'setScope', id: null });
    copied(target, ['I']);
    ok(target, { type: 'setSelection', ids: ['S'] });
    fails(setup, { type: 'paste' }, { code: 'editor.nested-symbol', path: '/nodes/I/parent' });
    // Detached (the source's content differs), the instance is a frame and may go in.
    ok(target, { type: 'setNodeProps', id: 'S', props: { fill: BLUE } });
    ok(target, { type: 'setSelection', ids: ['S'] });
    const [frame] = ok(target, { type: 'paste' });
    expect(nodeOf(target, frame!)).toMatchObject({ type: 'frame', parent: 'S' });
  });

  it('pastes into a single selected symbol, as into a frame', () => {
    const { target } = counted();
    copied(target, ['X']);
    ok(target, { type: 'setSelection', ids: ['S'] });
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!)).toMatchObject({ parent: 'S', frame: f(-310, -110, 10, 10) });
    expect((nodeOf(target, 'S') as { children: readonly string[] }).children).toEqual(['r', id]);
  });

  it('fails a group inside a source that breaks an instance’s tree depth', () => {
    const setup = counted(JSON.parse(fixture('depth/tree-256.json')) as unknown);
    fails(
      setup,
      { type: 'groupNodes', ids: ['leaf'], kind: 'group' },
      { code: 'document.invalid-field', path: '/nodes/i/parent' },
    );
  });

  it('fails a paste of a linked instance past the tree depth, at its fragment path', () => {
    const setup = counted(JSON.parse(fixture('depth/tree-256.json')) as unknown);
    const { target } = setup;
    ok(target, { type: 'setActivePage', id: 'q' });
    copied(target, ['i']);
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 5, height: 5 },
      parent: 'b127',
    });
    ok(target, { type: 'setScope', id: frame! });
    fails(setup, { type: 'paste' }, { code: 'document.invalid-field', path: '/nodes/i/parent' });
    ok(target, { type: 'setScope', id: 'b127' });
    ok(target, { type: 'paste' });
  });
});

describe('cut and the source deletion rule (M7-A13, section 5.4)', () => {
  it('cut of a source detaches its remaining instances in the same step', () => {
    const value = JSON.parse(SYMBOLS) as Json;
    const cut = counted(value);
    const deleted = counted(value);
    const copyText = copied(cut.target, ['s1']);
    const before = text(cut.target);
    expect(ok(cut.target, { type: 'cut', ids: ['s1'] })).toEqual(['s1']);
    expect(undoDepth(cut.target)).toBe(1);
    expect(clipboard(cut.target)).toBe(copyText);
    // The cut equals the copy plus the delete, whose detach M7-U4 tests literally.
    ok(deleted.target, { type: 'deleteNodes', ids: ['s1'] });
    expect(text(cut.target)).toBe(text(deleted.target));
    for (const id of ['i1', 'i2', 'i4']) expect(nodeOf(cut.target, id).type).toBe('frame');
    ok(cut.target, { type: 'undo' });
    expect(text(cut.target)).toBe(before);
    // Pasted back (on another page), the source is new and has no instances (disclosure 2).
    ok(cut.target, { type: 'redo' });
    ok(cut.target, { type: 'setActivePage', id: 'page-2' });
    const [pasted] = ok(cut.target, { type: 'paste' });
    const after = documentOf(cut.target);
    expect(after.nodes[pasted!]!.type).toBe('symbol');
    expect(
      Object.values(after.nodes).some((n) => n.type === 'instance' && n.symbol === pasted),
    ).toBe(false);
  });

  it('a cut whose automatic detach cannot draw its IDs fails and keeps the clipboard', () => {
    const value = JSON.parse(SYMBOLS) as Json;
    const target = createEditor({ document: value, ids: () => 'i1' });
    copied(target, ['s1-r']);
    fails({ target }, { type: 'cut', ids: ['s1'] }, { code: 'editor.duplicate-id' });
  });

  it('cut of an instance carries its source; pasting it back links it', () => {
    const target = own();
    expect(ok(target, { type: 'cut', ids: ['I'] })).toEqual(['I']);
    expect(bodyOf(clipboard(target)!).sources).toEqual(['S']);
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!)).toMatchObject({ type: 'instance', symbol: 'S' });
  });
});

describe('expansion validity and caps through paste (M7-X3, section 4.1)', () => {
  it('an Infinity scale of a detached paste is editor.invalid-expansion, no ID drawn', () => {
    const body = bodyOf(copied(own(), ['I']));
    body.nodes.I!.frame = f(0, 0, 1e308, 40);
    body.sourceNodes.S!.frame = f(0, 0, 1e-300, 20);
    const setup = counted(emptyDocument());
    fails(
      setup,
      { type: 'paste', text: marked(body) },
      {
        code: 'editor.invalid-expansion',
        path: '/nodes/I',
      },
    );
  });

  it('the paste’s own failure comes before an invalid expansion of a detached instance', () => {
    const body = bodyOf(copied(own(), ['I']));
    body.nodes.I!.frame = f(-1.7e308, 0, 1e308, 40);
    body.sourceNodes.S!.frame = f(0, 0, 1e-300, 20);
    const setup = counted(emptyDocument());
    fails(
      setup,
      { type: 'paste', text: marked(body), at: { x: 1.7e308, y: 0 } },
      {
        code: 'document.invalid-field',
        path: '/nodes/I/frame/x',
      },
    );
  });

  it('a failing custom node of a detached paste is editor.invalid-expansion', () => {
    const fragment = copied(own(), ['I']);
    const body = bodyOf(fragment);
    body.sourceNodes.S!.children = ['r', 'c'];
    body.sourceNodes.c = {
      ...base('c', 'S', f(0, 0, 30, 10)),
      type: 'custom',
      customType: 'ext.wide',
      data: {},
      fill: null,
      stroke: null,
    };
    let drawn = 0;
    const custom = {
      check: (node: NodeV4) =>
        node.type === 'custom' && node.frame.width > 50
          ? { code: 'document.invalid-custom-data' as const, path: '/data' }
          : null,
      defaults: () => ({ data: {} }),
    };
    const document = JSON.parse(JSON.stringify(emptyDocument())) as DocumentV4;
    const context = { ids: () => `n${++drawn}`, activePage: 'q', custom };
    expect(applyEdit(document, { type: 'paste', text: marked(body) }, context)).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/I',
    });
    expect(drawn).toBe(0);
    // At equal size the custom node passes.
    body.nodes.I!.frame = f(0, 0, 40, 20);
    expect(applyEdit(document, { type: 'paste', text: marked(body) }, context).ok).toBe(true);
  });

  /** Page k + 1 holds `perPage[k]` instances of `s`, on page 1, of `rects` rectangles. */
  function capDocument(perPage: readonly number[], rects: number): Json {
    const nodes: Json['nodes'] = {};
    const children: string[] = [];
    for (let n = 1; n <= rects; n += 1) {
      children.push(`r-${n}`);
      nodes[`r-${n}`] = rect(`r-${n}`, 's', f(0, 0, 10, 10));
    }
    nodes.s = { ...container('symbol', 's', 'p-1', children, f(0, 0, 10, 10)), fill: null };
    const pages = perPage.map((count, k) => {
      const page = `p-${k + 1}`;
      const ids = Array.from({ length: count }, (_, n) => `i-${k + 1}-${n + 1}`);
      for (const id of ids) nodes[id] = instance(id, page, f(0, 0, 10, 10), 's');
      return { id: page, name: page, children: k === 0 ? ['s', ...ids] : ids };
    });
    return { schemaVersion: 4, id: 'cap', pages, nodes };
  }

  it('a paste over the page cap is editor.expansion-limit at its fragment path', () => {
    // 1,000 scene nodes per instance: 99 instances, then a paste of one reaches 100,000.
    const setup = counted(capDocument([99], 998));
    copied(setup.target, ['i-1-1']);
    ok(setup.target, { type: 'paste' });
    fails(setup, { type: 'paste' }, { code: 'editor.expansion-limit', path: '/nodes/i-1-1' });
  });

  it('a paste over the document total, with every page under its cap, fails', () => {
    const pages = [...Array.from({ length: 10 }, () => 100), 0];
    const setup = counted(capDocument(pages, 998));
    copied(setup.target, ['i-1-1']);
    ok(setup.target, { type: 'setActivePage', id: 'p-11' });
    fails(setup, { type: 'paste' }, { code: 'editor.expansion-limit', path: '/nodes/i-1-1' });
  });

  /** A fragment of `count` instances of a carried source of `rects` rectangles, at scale 2. */
  function hostile(
    count: number,
    rects: number,
    frameOf: (k: number) => Frame = () => f(0, 0, 20, 20),
  ) {
    const children = Array.from({ length: rects }, (_, k) => `c${k}`);
    const sourceNodes: Json['nodes'] = {
      s: { ...container('symbol', 's', '', children, f(0, 0, 10, 10)), fill: null },
    };
    for (const id of children) sourceNodes[id] = rect(id, 's', f(0, 0, 1, 1));
    const nodes: Json['nodes'] = {};
    const roots = Array.from({ length: count }, (_, k) => `i${k}`);
    roots.forEach((id, k) => (nodes[id] = instance(id, '', frameOf(k), 's')));
    return marked({
      fragmentVersion: 2,
      schemaVersion: 3,
      roots,
      nodes,
      sources: ['s'],
      sourceNodes,
    });
  }

  it('counts detached expansions against the page cap before expanding any', () => {
    // 1,000 scene nodes per detached instance (outer, content, 998 rectangles): the 101st
    // crosses 100,000; instances after it have an Infinity scale and are never expanded.
    const fragment = hostile(150, 998, (k) => (k < 101 ? f(0, 0, 20, 20) : f(0, 0, 1e308, 20)));
    const setup = counted(emptyDocument());
    const expand = vi.spyOn(ExpansionCache.prototype, 'expand');
    try {
      fails(
        setup,
        { type: 'paste', text: fragment },
        {
          code: 'editor.expansion-limit',
          path: '/nodes/i100',
        },
      );
      expect(expand).not.toHaveBeenCalled();
    } finally {
      expand.mockRestore();
    }
  });

  it('counts the page’s existing instances, and the document total, for a detached paste', () => {
    // 99 instances of 1,000 scene nodes on the page: the second detached instance crosses.
    const page = counted(capDocument([99], 998));
    fails(
      page,
      { type: 'paste', text: hostile(2, 998) },
      {
        code: 'editor.expansion-limit',
        path: '/nodes/i1',
      },
    );
    // One detached instance reaches the page cap exactly and is pasted.
    expect(ok(page.target, { type: 'paste', text: hostile(1, 998) })).toEqual(['n1']);
    // 1,000,000 on ten other pages: the first detached instance on an empty page crosses.
    const total = counted(capDocument([...Array.from({ length: 10 }, () => 100), 0], 998));
    ok(total.target, { type: 'setActivePage', id: 'p-11' });
    fails(
      total,
      { type: 'paste', text: hostile(1, 998) },
      {
        code: 'editor.expansion-limit',
        path: '/nodes/i0',
      },
    );
  });
});

describe('rule (1) review follow-ups (B1, S1, S2)', () => {
  /** Page `p` holding source `node-3` (with `c`) and its instance `I`. */
  const reused = (): Json => ({
    schemaVersion: 4,
    id: 'd',
    pages: [{ id: 'p', name: 'P', children: ['node-3', 'I'] }],
    nodes: {
      'node-3': container('symbol', 'node-3', 'p', ['c'], f(0, 0, 40, 20)),
      c: rect('c', 'node-3', f(5, 5, 10, 10)),
      I: instance('I', 'p', f(100, 0, 40, 20), 'node-3'),
    },
  });
  /** Deletes the source, then draws `node-3` again for an unrelated symbol. */
  const redraw = (target: Editor) => {
    ok(target, { type: 'deleteNodes', ids: ['node-3'] });
    const [ellipse] = ok(target, { type: 'createEllipse', frame: f(300, 300, 77, 33) });
    expect(ok(target, { type: 'createSymbol', ids: [ellipse!] })).toEqual(['node-3']);
  };

  it('a carried ID drawn again after the copy is not linked by rule (1)', () => {
    const target = own(reused());
    copied(target, ['I']);
    redraw(target);
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!)).toMatchObject({ type: 'frame', children: [expect.any(String)] });
  });

  it('the same after loadDocument, in the new generation', () => {
    const target = own(small());
    ok(target, { type: 'loadDocument', document: reused() });
    copied(target, ['I']);
    redraw(target);
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!).type).toBe('frame');
  });

  it('undo and redo that restore the source keep rule (1)', () => {
    const target = own(reused());
    copied(target, ['I']);
    ok(target, { type: 'deleteNodes', ids: ['node-3'] });
    ok(target, { type: 'undo' });
    ok(target, { type: 'setNodeProps', id: 'node-3', props: { fill: BLUE } });
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!)).toMatchObject({ type: 'instance', symbol: 'node-3' });
  });

  it('B1′: an undo that restores another node under a carried ID does not link (P4)', () => {
    const target = own(reused());
    redraw(target);
    const [copy] = ok(target, {
      type: 'createInstance',
      symbol: 'node-3',
      frame: f(500, 0, 77, 33),
    });
    copied(target, [copy!]);
    for (let k = 0; k < 4; k += 1) ok(target, { type: 'undo' });
    // The red node-3 with `c` is back; the carried node-3 was the ellipse source.
    expect(nodeOf(target, 'node-3')).toMatchObject({ children: ['c'] });
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!).type).toBe('frame');
  });

  it('B1′: a redo that brings another node under a carried ID does not link (P4b)', () => {
    const target = own(reused());
    redraw(target);
    for (let k = 0; k < 3; k += 1) ok(target, { type: 'undo' });
    copied(target, ['I']);
    for (let k = 0; k < 3; k += 1) ok(target, { type: 'redo' });
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!).type).toBe('frame');
  });

  /** `reused()` plus a green source `T` that an Alt-drag duplicates (the drag draws `node-3`). */
  function dragged() {
    const value = reused();
    value.pages[0]!.children.push('T');
    value.nodes.T = { ...container('symbol', 'T', 'p', [], f(300, 300, 30, 30)), fill: GREEN };
    const target = own(value);
    ok(target, { type: 'setSnapping', enabled: false });
    const pointer = (kind: 'pointerdown' | 'pointermove' | 'pointerup', x: number) =>
      target.execute({
        type: 'input',
        event: { kind, point: { x, y: 315 }, modifiers: { ...none, alt: true } },
      });
    return { target, pointer };
  }
  /** Deletes `node-3` (drawing `node-1`), creates `node-2`, then Alt-drags `T` into `node-3`. */
  function altDragRedraw(
    target: Editor,
    pointer: (kind: 'pointerdown' | 'pointermove' | 'pointerup', x: number) => unknown,
  ) {
    ok(target, { type: 'deleteNodes', ids: ['node-3'] });
    expect(ok(target, { type: 'createEllipse', frame: f(600, 600, 5, 5) })).toEqual(['node-2']);
    ok(target, { type: 'setSelection', ids: ['T'] });
    pointer('pointerdown', 315);
    pointer('pointermove', 325);
    pointer('pointerup', 325);
    expect(nodeOf(target, 'node-3')).toMatchObject({ type: 'symbol', fill: GREEN });
  }

  it('G1: an undo across an Alt-drag that drew a carried ID does not link', () => {
    const { target, pointer } = dragged();
    altDragRedraw(target, pointer);
    const [copy] = ok(target, {
      type: 'createInstance',
      symbol: 'node-3',
      frame: f(500, 0, 30, 30),
    });
    copied(target, [copy!]);
    for (let k = 0; k < 4; k += 1) ok(target, { type: 'undo' });
    expect(nodeOf(target, 'node-3')).toMatchObject({ children: ['c'] });
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!).type).toBe('frame');
  });

  it('G1b: a redo of an Alt-drag that draws a carried ID does not link', () => {
    const { target, pointer } = dragged();
    altDragRedraw(target, pointer);
    for (let k = 0; k < 3; k += 1) ok(target, { type: 'undo' });
    copied(target, ['I']);
    for (let k = 0; k < 3; k += 1) ok(target, { type: 'redo' });
    expect(nodeOf(target, 'node-3')).toMatchObject({ fill: GREEN });
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!).type).toBe('frame');
  });

  it('G2: host commands during an Alt-drag keep their own drawn IDs', () => {
    const { target, pointer } = dragged();
    ok(target, { type: 'deleteNodes', ids: ['node-3'] });
    ok(target, { type: 'setSelection', ids: ['T'] });
    pointer('pointerdown', 315);
    pointer('pointermove', 325);
    // The drag's duplicate drew node-2; the host commands cancel it and draw node-3 themselves.
    expect(nodeOf(target, 'node-2')).toMatchObject({ type: 'symbol' });
    expect(ok(target, { type: 'createFrame', frame: f(600, 600, 5, 5) })).toEqual(['node-3']);
    expect(ok(target, { type: 'createSymbol', ids: ['node-3'] })).toEqual(['node-3']);
    pointer('pointerup', 325);
    const [copy] = ok(target, { type: 'createInstance', symbol: 'node-3', frame: f(500, 0, 5, 5) });
    copied(target, [copy!]);
    for (let k = 0; k < 4; k += 1) ok(target, { type: 'undo' });
    // The red node-3 is back: createFrame's step drew the carried ID, so its undo unlinks it.
    expect(nodeOf(target, 'node-3')).toMatchObject({ children: ['c'] });
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!).type).toBe('frame');
  });

  it.each(['update', 'replace'] as const)(
    'G4 %s: a gesture that deletes the source and draws its ID again unlinks it',
    (mode) => {
      const value = reused();
      value.pages[0]!.children = ['node-1', 'I'];
      value.nodes['node-1'] = { ...value.nodes['node-3']!, id: 'node-1', name: 'node-1' };
      delete value.nodes['node-3'];
      value.nodes.c!.parent = 'node-1';
      value.nodes.I!.symbol = 'node-1';
      const target = own(value);
      copied(target, ['I']);
      const { gesture } = internalsOf(target);
      const remove: Command = { type: 'deleteNodes', ids: ['node-1', 'I'] };
      const create: Command = { type: 'createFrame', frame: f(300, 300, 77, 33), fill: GREEN };
      gesture.begin();
      if (mode === 'update') {
        expect(gesture.update(remove as never).ok).toBe(true);
        expect(gesture.update(create as never)).toEqual({ ok: true, ids: ['node-1'] });
      } else {
        expect(gesture.replace([remove, create] as never)).toEqual({ ok: true, ids: ['node-1'] });
      }
      gesture.commit();
      expect(ok(target, { type: 'createSymbol', ids: ['node-1'] })).toEqual(['node-1']);
      const [id] = ok(target, { type: 'paste' });
      expect(nodeOf(target, id!).type).toBe('frame');
    },
  );

  it('an ID the draw skips, because the document holds it, stays linkable', () => {
    // The default counter returns node-1 to node-4 here; node-3, the source, is held, so the
    // draw skips it and rule (1) still links the edited source.
    const target = own(reused());
    copied(target, ['I']);
    ok(target, { type: 'setNodeProps', id: 'node-3', props: { fill: BLUE } });
    for (let k = 0; k < 3; k += 1) {
      ok(target, { type: 'createEllipse', frame: f(600, 600, 5, 5) });
    }
    expect(Object.keys(documentOf(target).nodes)).toContain('node-4');
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!)).toMatchObject({ type: 'instance', symbol: 'node-3' });
  });

  it('S1: text other than the current clipboard goes by content, even naming an own symbol', () => {
    const target = own();
    copied(target, ['I']);
    const body = bodyOf(clipboard(target)!);
    body.sourceNodes.S!.fill = BLUE;
    const [id] = ok(target, { type: 'paste', text: marked(body) });
    expect(nodeOf(target, id!)).toMatchObject({ type: 'frame', fill: BLUE });
    // The current clipboard itself still links.
    const [linked] = ok(target, { type: 'paste' });
    expect(nodeOf(target, linked!)).toMatchObject({ type: 'instance', symbol: 'S' });
  });

  it('S2: cut records the generation, so an edited source still links', () => {
    const target = own();
    ok(target, { type: 'cut', ids: ['I'] });
    ok(target, { type: 'setNodeProps', id: 'S', props: { fill: BLUE } });
    const [id] = ok(target, { type: 'paste' });
    expect(nodeOf(target, id!)).toMatchObject({ type: 'instance', symbol: 'S' });
  });
});
