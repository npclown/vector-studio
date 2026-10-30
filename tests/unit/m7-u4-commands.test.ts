import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  serializeDocument,
  validateDocument,
  type DocumentV6,
  type NodeV6,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type IdSource,
} from '../../packages/editor-core/src/index.js';
import { applyEdit } from '../../packages/editor-core/src/edits.js';
import { expandInstance } from '../../packages/editor-core/src/expansion.js';
import { boundsOf } from '../../packages/editor-core/src/hit-test.js';
import { projectPage } from '../../packages/editor-core/src/projector.js';
import { documentTree, symbolChange } from '../../packages/editor-core/src/tree.js';

// MVP M7-U4 (M7 contract, section 5): `createSymbol`, `createInstance`, `detachInstances`,
// instance `setNodeProps` and `setFrames`, the nesting and depth checks of section 5.3 and the
// source deletion rule of section 5.4. Criteria M7-A07, M7-A08, M7-A09 and M7-A13. Every command
// leaves a document `validateDocument` accepts, and a failed command changes nothing and draws
// no ID.

const root = path.resolve(import.meta.dirname, '../..');
// Since M4-U1 the model returns schema v6, so each M7 fixture is read as its committed v6
// migration under tests/fixtures/m4-appearance/migrated (M6a contract, section 9; M4 contract,
// section 2.1).
const fixture = (name: string) =>
  readFileSync(
    path.join(
      root,
      'tests/fixtures/m4-appearance/migrated',
      `${path.basename(name).replace(/(\.v3)?\.json$/, '')}.v6.json`,
    ),
    'utf8',
  );
const SYMBOLS = fixture('symbols.v3.json');
const START = { horizontal: 'start', vertical: 'start' } as const;
const red = { r: 1, g: 0, b: 0, a: 1 };
const noCustom = () => null;

type Json = {
  schemaVersion: number;
  id: string;
  pages: { id: string; name: string; children: string[] }[];
  nodes: Record<string, Record<string, unknown>>;
};

/** An editor on `document` whose ID source counts its draws: `n1`, `n2`, ... */
function counted(document: unknown = JSON.parse(SYMBOLS)): {
  target: Editor;
  drawn: () => number;
} {
  let count = 0;
  const ids: IdSource = () => `n${++count}`;
  const target = createEditor({ document, ids });
  // Loading draws nothing; the count starts here.
  return { target, drawn: () => count };
}

const documentOf = (target: Editor) => target.query({ type: 'document' });
const text = (target: Editor) => serializeDocument(documentOf(target));

/** Runs `command` and checks the editor's document is still a valid v3 document. */
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

/** Runs `command`, expects `failure`, and that nothing changed and no ID was drawn. */
function fails(
  setup: { target: Editor; drawn: () => number },
  command: Command,
  failure: Readonly<{ code: string; path?: string }>,
): void {
  const { target, drawn } = setup;
  const before = text(target);
  const document = documentOf(target);
  const count = drawn();
  expect(run(target, command)).toEqual({ ok: false, ...failure });
  expect(documentOf(target)).toBe(document);
  expect(text(target)).toBe(before);
  expect(drawn()).toBe(count);
}

function node(id: string, parent: string, type: string, extra = {}) {
  return {
    id,
    name: id,
    parent,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type,
    // Schema v5 (M6a contract, section 9): an instance always has its text overrides.
    ...(type === 'instance' ? { textOverrides: {} } : {}),
    ...extra,
  };
}

const rect = (id: string, parent: string, frame: Record<string, number>) =>
  node(id, parent, 'rectangle', { frame, cornerRadii: [0, 0, 0, 0], fill: red, stroke: null });

/** A document whose source `S` has an expansion that overflows to Infinity in instance `I`. */
function overflowing(masked = false): DocumentV6 {
  // With `masked`, a mask group `M` on the page: a path `mp` masking a rectangle `mr`.
  const mask = {
    M: node('M', 'p', 'maskGroup', { children: ['mp', 'mr'] }),
    mp: node('mp', 'M', 'path', {
      path: {
        verbs: ['move', 'line', 'line', 'close'],
        points: [0, 0, 1, 0, 0, 1],
        fillRule: 'nonzero',
      },
      fill: null,
      stroke: null,
    }),
    mr: rect('mr', 'M', { x: 0, y: 0, width: 10, height: 10 }),
  };
  const result = validateDocument({
    schemaVersion: 6,
    id: 'doc',
    pages: [{ id: 'p', name: 'P', children: ['S', 'I', 'x', ...(masked ? ['M'] : [])] }],
    nodes: {
      ...(masked ? mask : {}),
      S: node('S', 'p', 'symbol', {
        frame: { x: 0, y: 0, width: 1e-300, height: 10 },
        children: ['a'],
        fill: null,
        stroke: null,
      }),
      a: rect('a', 'S', { x: 0, y: 0, width: 1e10, height: 10 }),
      I: node('I', 'p', 'instance', { symbol: 'S' }),
      x: rect('x', 'p', { x: 0, y: 0, width: 1, height: 1 }),
    },
  });
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

/** The copy of source node `n` renamed by `copyOf`, its parent the instance for a direct child. */
function renamed(
  original: NodeV6,
  copyOf: ReadonlyMap<string, string>,
  source: string,
  instance: string,
): NodeV6 {
  const copy: Record<string, unknown> = {
    ...original,
    id: copyOf.get(original.id)!,
    parent: original.parent === source ? instance : copyOf.get(original.parent)!,
  };
  if ('children' in original) copy.children = original.children.map((id) => copyOf.get(id)!);
  return copy as NodeV6;
}

/**
 * The detached frame of `instance` in `before` with copies named `ids` in the expansion's
 * pre-order: the literal result of section 5.2.
 */
function detachedNodes(
  before: DocumentV6,
  instance: string,
  ids: readonly string[],
): Record<string, NodeV6> {
  const node = before.nodes[instance] as Extract<NodeV6, { type: 'instance' }>;
  const source = before.nodes[node.symbol] as Extract<NodeV6, { type: 'symbol' }>;
  const result = expandInstance(before, instance);
  if (result === null || !result.ok) throw new Error('no expansion');
  const keys = [...result.expansion.nodes.keys()];
  expect(keys.length).toBe(ids.length);
  const copyOf = new Map(keys.map((key, i) => [key, ids[i]!] as const));
  const out: Record<string, NodeV6> = {
    [instance]: {
      id: instance,
      name: node.name,
      parent: node.parent,
      frame: node.frame,
      rotation: node.rotation,
      constraints: node.constraints,
      opacity: node.opacity,
      visible: node.visible,
      type: 'frame',
      children: result.expansion.children.map((id) => copyOf.get(id)!),
      fill: source.fill,
      stroke: source.stroke,
    },
  };
  for (const [key, copy] of result.expansion.nodes) {
    out[copyOf.get(key)!] = renamed(copy, copyOf, source.id, instance);
  }
  return out;
}

/** `before` with `nodes` replaced or added and `removed` taken out, in canonical text. */
function expectedText(
  before: DocumentV6,
  nodes: Record<string, NodeV6>,
  removed: readonly string[] = [],
  pages = before.pages,
): string {
  const next: Record<string, NodeV6> = { ...before.nodes, ...nodes };
  for (const id of removed) delete next[id];
  return serializeDocument({ ...before, pages, nodes: next });
}

const S1_ORDER = ['s1-r', 's1-g', 's1-e', 's1-p', 's1-f', 's1-l'];
const S1_SUBTREE = ['s1', ...S1_ORDER];

describe('createSymbol (M7-A07)', () => {
  it('turns one frame into a symbol in place, same ID, fields and children', () => {
    const setup = counted();
    const { target, drawn } = setup;
    ok(target, { type: 'setActivePage', id: 'page-2' });
    const before = documentOf(target);
    expect(run(target, { type: 'createSymbol', ids: ['d1'] })).toEqual({ ok: true, ids: ['d1'] });
    expect(drawn()).toBe(0);
    expect(text(target)).toBe(
      expectedText(before, { d1: { ...before.nodes.d1!, type: 'symbol' } as NodeV6 }),
    );
    // It is a source at once: an instance of it, and its child edits propagate.
    const [instance] = ok(target, { type: 'createInstance', symbol: 'd1' });
    expect(documentOf(target).nodes[instance!]).toMatchObject({ type: 'instance', symbol: 'd1' });
    ok(target, { type: 'undo' });
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(serializeDocument(before));
  });

  it('wraps siblings as groupNodes does: bounds, paint index, page placement, Symbol, no style', () => {
    const value: Json = {
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p', name: 'P', children: ['r0', 'r1', 'r2', 'r3'] }],
      nodes: {
        r0: rect('r0', 'p', { x: 0, y: 0, width: 5, height: 5 }),
        r1: rect('r1', 'p', { x: 10, y: 20, width: 30, height: 40 }),
        r2: rect('r2', 'p', { x: 50, y: 0, width: 10, height: 10 }),
        r3: rect('r3', 'p', { x: 0, y: 100, width: 5, height: 5 }),
      },
    };
    const setup = counted(value);
    const { target, drawn } = setup;
    const before = documentOf(target);
    expect(run(target, { type: 'createSymbol', ids: ['r2', 'r1'] })).toEqual({
      ok: true,
      ids: ['n1'],
    });
    expect(drawn()).toBe(1);
    const symbol = {
      id: 'n1',
      name: 'Symbol',
      parent: 'p',
      frame: { x: 10, y: 0, width: 50, height: 60 },
      rotation: 0,
      constraints: START,
      opacity: 1,
      visible: true,
      type: 'symbol',
      children: ['r1', 'r2'],
      fill: null,
      stroke: null,
    } as NodeV6;
    expect(text(target)).toBe(
      expectedText(
        before,
        {
          n1: symbol,
          r1: { ...before.nodes.r1!, parent: 'n1', frame: { x: 0, y: 20, width: 30, height: 40 } },
          r2: { ...before.nodes.r2!, parent: 'n1', frame: { x: 40, y: 0, width: 10, height: 10 } },
        },
        [],
        [{ id: 'p', name: 'P', children: ['r0', 'n1', 'r3'] }],
      ),
    );
  });

  it('wraps a horizontal line in a symbol as high as its stroke (visual bounds)', () => {
    // Section 5.1 since the M7-U6 hands-on check: the wrap takes the nodes' visual bounds, so a
    // 0-high line of the default stroke (width 1, butt caps) gives a 1-high symbol that keeps it
    // painted, and the line keeps its page placement half a unit below the symbol's top.
    const setup = counted({
      schemaVersion: 6,
      id: 'doc',
      pages: [{ id: 'p', name: 'P', children: [] }],
      nodes: {},
    });
    const { target } = setup;
    const [line] = ok(target, {
      type: 'createLine',
      start: { x: 10, y: 20 },
      end: { x: 110, y: 20 },
    });
    const before = documentOf(target);
    expect(ok(target, { type: 'createSymbol', ids: [line!] })).toEqual(['n2']);
    expect(text(target)).toBe(
      expectedText(
        before,
        {
          n2: {
            id: 'n2',
            name: 'Symbol',
            parent: 'p',
            frame: { x: 10, y: 19.5, width: 100, height: 1 },
            rotation: 0,
            constraints: START,
            opacity: 1,
            visible: true,
            type: 'symbol',
            children: [line!],
            fill: null,
            stroke: null,
          },
          [line!]: {
            ...before.nodes[line!]!,
            parent: 'n2',
            frame: { x: 0, y: 0.5, width: 100, height: 0 },
          },
        },
        [],
        [{ id: 'p', name: 'P', children: ['n2'] }],
      ),
    );
  });

  it('wraps one non-frame node, and a frame holding a source cannot become one', () => {
    const { target } = counted();
    ok(target, { type: 'setActivePage', id: 'page-2' });
    expect(ok(target, { type: 'createSymbol', ids: ['d1-r'] })).toEqual(['n1']);
    const document = documentOf(target);
    expect(document.nodes.n1).toMatchObject({ type: 'symbol', parent: 'd1', children: ['d1-r'] });
    expect(document.nodes.d1).toMatchObject({ type: 'frame', children: ['n1'] });
    // The frame now holds a source, so it cannot become one.
    expect(run(target, { type: 'createSymbol', ids: ['d1'] })).toEqual({
      ok: false,
      code: 'editor.nested-symbol',
      path: '/nodes/n1/parent',
    });
  });

  it('fails each section 5.5 rule with nothing changed and no ID drawn, in the stated order', () => {
    const setup = counted();
    const command = (ids: unknown) => ({ type: 'createSymbol', ids }) as Command;
    fails(setup, command('s1'), { code: 'editor.invalid-command', path: '/ids' });
    fails(setup, command(['s1-r', 's1-r']), { code: 'editor.invalid-command', path: '/ids' });
    fails(setup, command(['nope']), { code: 'editor.unknown-node' });
    // A node of another page is unknown on the active page; unknown before not-siblings.
    fails(setup, command(['d1-r']), { code: 'editor.unknown-node' });
    fails(setup, command(['i1', 'nope', 's1-r']), { code: 'editor.unknown-node' });
    fails(setup, command([]), { code: 'editor.not-siblings' });
    fails(setup, command(['i1', 's1-r']), { code: 'editor.not-siblings' });
    // Section 5.3: a frame inside a source would become a source inside one (in place).
    fails(setup, command(['s1-f']), { code: 'editor.nested-symbol', path: '/nodes/s1-f/parent' });
    // A wrap inside a source: the failure inside the new symbol is relative to it.
    fails(setup, command(['s1-r', 's1-g']), { code: 'editor.nested-symbol', path: '/parent' });
    // A wrap of instances or of a source.
    fails(setup, command(['i3', 'i1']), { code: 'editor.nested-symbol', path: '/nodes/i1/parent' });
    fails(setup, command(['s1']), { code: 'editor.nested-symbol', path: '/nodes/s1/parent' });
    // A frame holding an instance (in place).
    ok(setup.target, { type: 'setActivePage', id: 'page-2' });
    fails(setup, command(['f2']), { code: 'editor.nested-symbol', path: '/nodes/i4/parent' });
  });

  it('fails a wrap that puts a frame at clip depth 32, as a symbol clips (section 1.2)', () => {
    const nodes: Json['nodes'] = {
      t: node('t', 'p', 'group', { children: ['f0', 'x'] }),
      x: rect('x', 't', { x: 0, y: 0, width: 1, height: 1 }),
    };
    for (let level = 0; level < 32; level += 1) {
      nodes[`f${level}`] = node(`f${level}`, level === 0 ? 't' : `f${level - 1}`, 'frame', {
        children: level < 31 ? [`f${level + 1}`] : [],
        fill: null,
        stroke: null,
      });
    }
    const setup = counted({
      schemaVersion: 6,
      id: 'd',
      pages: [{ id: 'p', name: 'P', children: ['t'] }],
      nodes,
    });
    fails(
      setup,
      { type: 'createSymbol', ids: ['f0', 'x'] },
      { code: 'editor.clip-depth', path: '/nodes/f31/parent' },
    );
    // A group wraps them without a clip level.
    expect(ok(setup.target, { type: 'groupNodes', ids: ['f0', 'x'], kind: 'group' })).toEqual([
      'n1',
    ]);
  });

  it('checks editor.duplicate-id last, and an in-place conversion draws no ID', () => {
    const target = createEditor({ document: JSON.parse(SYMBOLS) as unknown, ids: () => 's1' });
    const before = text(target);
    expect(run(target, { type: 'createSymbol', ids: ['s1'] })).toMatchObject({
      code: 'editor.nested-symbol',
    });
    ok(target, { type: 'setActivePage', id: 'page-2' });
    expect(run(target, { type: 'createSymbol', ids: ['d1-r'] })).toEqual({
      ok: false,
      code: 'editor.duplicate-id',
    });
    expect(text(target)).toBe(before);
    expect(ok(target, { type: 'createSymbol', ids: ['d1'] })).toEqual(['d1']);
  });
});

describe('createInstance (M7-A07)', () => {
  const instance = (id: string, extra: Record<string, unknown>) => ({
    id,
    name: 'Card',
    parent: 'page-1',
    frame: { x: 140, y: 0, width: 100, height: 80 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type: 'instance',
    symbol: 's1',
    textOverrides: {},
    ...extra,
  });

  it('defaults: the source size, beside its page bounds, rotation 0, its name, on top', () => {
    const { target, drawn } = counted();
    const before = documentOf(target);
    expect(run(target, { type: 'createInstance', symbol: 's1' })).toEqual({
      ok: true,
      ids: ['n1'],
    });
    expect(drawn()).toBe(1);
    expect(text(target)).toBe(
      expectedText(
        before,
        { n1: instance('n1', {}) as NodeV6 },
        [],
        [{ ...before.pages[0]!, children: ['s1', 'i1', 'i3', 'n1'] }, before.pages[1]!],
      ),
    );
  });

  it('a rotated source: beside its page-aligned bounds, with its own unrotated size', () => {
    const { target } = counted();
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 's1', frame: { x: 0, y: 0, width: 100, height: 80 }, rotation: Math.PI / 2 }],
    });
    const bounds = boundsOf(documentOf(target), ['s1'])!;
    // Up to binary64 rounding of cos(π/2): x 10, y -10, width 80, height 100.
    expect(bounds.x).toBeCloseTo(10, 12);
    expect(bounds.y).toBeCloseTo(-10, 12);
    expect(bounds.width).toBeCloseTo(80, 12);
    const [id] = ok(target, { type: 'createInstance', symbol: 's1' });
    expect(documentOf(target).nodes[id!]).toEqual(
      instance(id!, {
        frame: { x: bounds.x + bounds.width + 40, y: bounds.y, width: 100, height: 80 },
      }),
    );
  });

  it('a source on another page: its bounds taken as coordinates on the active page', () => {
    const { target } = counted();
    const [id] = ok(target, { type: 'createInstance', symbol: 's2' });
    expect(documentOf(target).nodes[id!]).toEqual(
      instance(id!, {
        name: 'Empty',
        symbol: 's2',
        frame: { x: 90, y: 300, width: 50, height: 40 },
      }),
    );
  });

  it('a given page frame, rotation, parent and index map into the parent space', () => {
    const { target } = counted();
    ok(target, { type: 'setActivePage', id: 'page-2' });
    const before = documentOf(target);
    const [id] = ok(target, {
      type: 'createInstance',
      symbol: 's1',
      frame: { x: 310, y: 10, width: 40, height: 30 },
      rotation: 0.25,
      parent: 'f2',
      index: 0,
    });
    const after = documentOf(target);
    expect(after.nodes[id!]).toEqual(
      instance(id!, {
        parent: 'f2',
        frame: { x: 10, y: 10, width: 40, height: 30 },
        rotation: 0.25,
      }),
    );
    expect(after.nodes.f2).toEqual({ ...before.nodes.f2, children: [id, 'i4'] });
  });

  it('fails each section 5.5 rule with nothing changed and no ID drawn, in the stated order', () => {
    const setup = counted();
    const command = (fields: Record<string, unknown>) =>
      ({ type: 'createInstance', symbol: 's1', ...fields }) as Command;
    fails(setup, command({ symbol: 7 }), { code: 'editor.invalid-command', path: '/symbol' });
    fails(setup, command({ parent: 7 }), { code: 'editor.invalid-command', path: '/parent' });
    fails(setup, command({ symbol: 'nope' }), { code: 'editor.unknown-node' });
    fails(setup, command({ parent: 'nope' }), { code: 'editor.unknown-node' });
    // unknown-* before not-a-symbol, not-a-symbol before the index.
    fails(setup, command({ symbol: 'i1', parent: 'nope' }), { code: 'editor.unknown-node' });
    fails(setup, command({ symbol: 'i1' }), { code: 'editor.not-a-symbol' });
    fails(setup, command({ symbol: 's1-f', index: 99 }), { code: 'editor.not-a-symbol' });
    fails(setup, command({ index: 99 }), { code: 'editor.invalid-index' });
    fails(setup, command({ frame: null }), { code: 'document.invalid-field', path: '/frame' });
    fails(setup, command({ frame: { x: 0, y: 0, width: -1, height: 1 } }), {
      code: 'document.invalid-field',
      path: '/frame/width',
    });
    fails(setup, command({ parent: 's1-r' }), { code: 'editor.invalid-parent', path: '/parent' });
    // Section 5.3: no instance inside a source, at any depth.
    fails(setup, command({ parent: 's1' }), { code: 'editor.nested-symbol', path: '/parent' });
    fails(setup, command({ parent: 's1-g' }), { code: 'editor.nested-symbol', path: '/parent' });
    fails(setup, command({ symbol: 's1', parent: 's1-f' }), {
      code: 'editor.nested-symbol',
      path: '/parent',
    });
  });

  it('fails on the M7-S5 tree and clip depth of its own expansion, relative to it', () => {
    const tall = counted(JSON.parse(fixture('depth/tree-256.json')) as unknown);
    ok(tall.target, { type: 'setActivePage', id: 'q' });
    // At b127 the expansion's deepest node sits at 128 + 128 = 256.
    ok(tall.target, { type: 'createInstance', symbol: 's', parent: 'b127' });
    const [frame] = ok(tall.target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 1, height: 1 },
      parent: 'b127',
    });
    fails(
      tall,
      { type: 'createInstance', symbol: 's', parent: frame! },
      {
        code: 'document.invalid-field',
        path: '/parent',
      },
    );
    const clip = counted(JSON.parse(fixture('depth/clip-32.json')) as unknown);
    // Beside `i`, at clip depth 16, the expansion fits; one frame deeper it does not.
    ok(clip.target, { type: 'createInstance', symbol: 's', parent: 'b15' });
    const [deeper] = ok(clip.target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 1, height: 1 },
      parent: 'b15',
    });
    fails(
      clip,
      { type: 'createInstance', symbol: 's', parent: deeper! },
      {
        code: 'editor.clip-depth',
        path: '/parent',
      },
    );
  });

  it('fails an invalid expansion and the cap at the new instance with no path, no ID drawn', () => {
    const value = JSON.parse(serializeDocument(overflowing())) as Json;
    // Without the overflowing instance the document loads.
    value.pages[0]!.children = ['S', 'x'];
    delete value.nodes.I;
    const setup = counted(value);
    fails(
      setup,
      { type: 'createInstance', symbol: 'S', frame: { x: 0, y: 0, width: 10, height: 10 } },
      { code: 'editor.invalid-expansion' },
    );
    // A page of 99 instances of a source adding 1,001 scene nodes each: the 100th crosses 100,000.
    const nodes: Json['nodes'] = {
      S: node('S', 'p', 'symbol', { children: [], fill: null, stroke: null }),
    };
    const children = ['S'];
    for (let k = 0; k < 999; k += 1) {
      nodes[`c${k}`] = rect(`c${k}`, 'S', { x: 0, y: 0, width: 1, height: 1 });
      (nodes.S!.children as string[]).push(`c${k}`);
    }
    for (let k = 0; k < 99; k += 1) {
      nodes[`i${k}`] = node(`i${k}`, 'p', 'instance', { symbol: 'S' });
      children.push(`i${k}`);
    }
    const capped = counted({
      schemaVersion: 6,
      id: 'd',
      pages: [{ id: 'p', name: 'P', children }],
      nodes,
    });
    fails(capped, { type: 'createInstance', symbol: 'S' }, { code: 'editor.expansion-limit' });
  });

  it('checks editor.duplicate-id last', () => {
    const target = createEditor({ document: JSON.parse(SYMBOLS) as unknown, ids: () => 'i1' });
    const before = text(target);
    expect(run(target, { type: 'createInstance', symbol: 's1', parent: 's1' })).toMatchObject({
      code: 'editor.nested-symbol',
    });
    expect(run(target, { type: 'createInstance', symbol: 's1' })).toEqual({
      ok: false,
      code: 'editor.duplicate-id',
    });
    expect(text(target)).toBe(before);
  });
});

describe('setNodeProps and setFrames on instances and symbols (M7-A07, section 5.1)', () => {
  it('accepts the common props on an instance and rejects the rest', () => {
    const setup = counted();
    const { target } = setup;
    const before = documentOf(target);
    ok(target, {
      type: 'setNodeProps',
      id: 'i1',
      props: {
        name: 'Copy',
        visible: false,
        opacity: 1,
        constraints: { horizontal: 'end', vertical: 'scale' },
      },
    });
    expect(text(target)).toBe(
      expectedText(before, {
        i1: {
          ...before.nodes.i1!,
          name: 'Copy',
          visible: false,
          constraints: { horizontal: 'end', vertical: 'scale' },
        },
      }),
    );
    for (const key of ['fill', 'stroke', 'cornerRadii', 'data', 'startArrow']) {
      fails(
        setup,
        { type: 'setNodeProps', id: 'i1', props: { [key]: null } },
        {
          code: 'editor.invalid-command',
          path: `/props/${key}`,
        },
      );
    }
    // M7-S4: an instance's opacity stays 1.
    fails(
      setup,
      { type: 'setNodeProps', id: 'i1', props: { opacity: 0.5 } },
      {
        code: 'document.invalid-field',
        path: '/nodes/i1/opacity',
      },
    );
  });

  it('accepts a frame’s props on a symbol, which propagate to its instances', () => {
    const setup = counted();
    const { target } = setup;
    const before = documentOf(target);
    const green = { r: 0, g: 1, b: 0, a: 1 };
    ok(target, { type: 'setNodeProps', id: 's1', props: { fill: green, stroke: null, name: 'S' } });
    expect(text(target)).toBe(
      expectedText(before, {
        s1: { ...before.nodes.s1!, fill: green, stroke: null, name: 'S' } as NodeV6,
      }),
    );
    fails(
      setup,
      { type: 'setNodeProps', id: 's1', props: { cornerRadii: [1, 1, 1, 1] } },
      {
        code: 'editor.invalid-command',
        path: '/props/cornerRadii',
      },
    );
    fails(
      setup,
      { type: 'setNodeProps', id: 's1', props: { opacity: 0.5 } },
      {
        code: 'document.invalid-field',
        path: '/nodes/s1/opacity',
      },
    );
  });

  it('setFrames on an instance changes only its own frame', () => {
    const { target } = counted();
    const before = documentOf(target);
    const frame = { x: 1, y: 2, width: 300, height: 30 };
    ok(target, { type: 'setFrames', frames: [{ id: 'i1', frame, rotation: 0.5 }] });
    expect(text(target)).toBe(
      expectedText(before, { i1: { ...before.nodes.i1!, frame, rotation: 0.5 } }),
    );
  });
});

describe('section 5.3 nesting and depth (M7-A08)', () => {
  it('fails moveNodes of an instance, a source or a container holding one into a source', () => {
    const setup = counted();
    const { target } = setup;
    const move = (ids: string[], parent: string) =>
      ({ type: 'moveNodes', ids, parent, index: 0 }) as Command;
    fails(setup, move(['i1'], 's1'), { code: 'editor.nested-symbol', path: '/nodes/i1/parent' });
    fails(setup, move(['i1'], 's1-g'), { code: 'editor.nested-symbol', path: '/nodes/i1/parent' });
    fails(setup, move(['i3', 'i1'], 's1-f'), {
      code: 'editor.nested-symbol',
      path: '/nodes/i1/parent',
    });
    const [group] = ok(target, { type: 'groupNodes', ids: ['i1', 'i3'], kind: 'group' });
    fails(setup, move([group!], 's1'), { code: 'editor.nested-symbol', path: '/nodes/i1/parent' });
    ok(target, { type: 'undo' });
    const [other] = ok(target, {
      type: 'createSymbol',
      ids: [
        ok(target, { type: 'createRectangle', frame: { x: 0, y: 0, width: 5, height: 5 } })[0]!,
      ],
    });
    fails(setup, move([other!], 's1'), {
      code: 'editor.nested-symbol',
      path: `/nodes/${other}/parent`,
    });
  });

  it('moves a plain node into a source, and a source into a group', () => {
    const { target } = counted();
    const [created] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 5, height: 5 },
    });
    ok(target, { type: 'moveNodes', ids: [created!], parent: 's1', index: 0 });
    expect(documentOf(target).nodes[created!]!.parent).toBe('s1');
    const [group] = ok(target, { type: 'groupNodes', ids: ['s1', 'i1'], kind: 'group' });
    expect(documentOf(target).nodes.s1!.parent).toBe(group);
  });

  it('fails a frame moved into a source that breaks an instance’s clip depth, at the instance', () => {
    const setup = counted(JSON.parse(fixture('depth/clip-32.json')) as unknown);
    const [frame] = ok(setup.target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 1, height: 1 },
    });
    // Under a14 the frame's copy sits at clip depth 16 + 1 + 15 = 32.
    fails(
      setup,
      { type: 'moveNodes', ids: [frame!], parent: 'a14', index: 0 },
      {
        code: 'editor.clip-depth',
        path: '/nodes/i/parent',
      },
    );
    ok(setup.target, { type: 'moveNodes', ids: [frame!], parent: 'a13', index: 0 });
  });

  it('fails a change inside a source that breaks the tree depth of an instance on another page', () => {
    const setup = counted(JSON.parse(fixture('depth/tree-256.json')) as unknown);
    const { target } = setup;
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 5, height: 5 },
      parent: 'a126',
    });
    fails(
      setup,
      { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 }, parent: frame! },
      { code: 'document.invalid-field', path: '/nodes/i/parent' },
    );
    // A node moved under the frame fails the same way.
    const [loose] = ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 1, height: 1 },
    });
    fails(
      setup,
      { type: 'moveNodes', ids: [loose!], parent: frame!, index: 0 },
      {
        code: 'document.invalid-field',
        path: '/nodes/i/parent',
      },
    );
    // The same rectangle under a frame that is not in the source is within the bound.
    ok(target, { type: 'setActivePage', id: 'q' });
    ok(target, {
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 1, height: 1 },
      parent: 'b0',
    });
  });

  it('fails an instance moved deeper past the tree depth, at the instance', () => {
    const setup = counted(JSON.parse(fixture('depth/tree-256.json')) as unknown);
    ok(setup.target, { type: 'setActivePage', id: 'q' });
    const [frame] = ok(setup.target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 5, height: 5 },
      parent: 'b127',
    });
    fails(
      setup,
      { type: 'moveNodes', ids: ['i'], parent: frame!, index: 0 },
      {
        code: 'document.invalid-field',
        path: '/nodes/i/parent',
      },
    );
  });

  it('reports the first failing instance in pages order, then page-tree pre-order', () => {
    const value = JSON.parse(fixture('depth/clip-32.json')) as Json;
    // A second instance `j` beside `i` and a third `k` on a page before it, both at depth 16.
    const extra = (id: string, parent: string) => node(id, parent, 'instance', { symbol: 's' });
    value.nodes.j = extra('j', 'b15');
    (value.nodes.b15!.children as string[]).unshift('j');
    for (let level = 0; level < 16; level += 1) {
      const id = `k${level}`;
      value.nodes[id] = node(id, level === 0 ? 'q' : `k${level - 1}`, 'frame', {
        children: level < 15 ? [`k${level + 1}`] : ['k'],
        fill: null,
        stroke: null,
      });
    }
    value.nodes.k = extra('k', 'k15');
    value.pages.unshift({ id: 'q', name: 'Q', children: ['k0'] });
    const setup = counted(value);
    ok(setup.target, { type: 'setActivePage', id: 'p' });
    fails(
      setup,
      { type: 'createFrame', frame: { x: 0, y: 0, width: 1, height: 1 }, parent: 'a14' },
      { code: 'editor.clip-depth', path: '/nodes/k/parent' },
    );
    // Without page q, `j` comes before `i` in page-tree pre-order.
    ok(setup.target, { type: 'removePage', id: 'q' });
    fails(
      setup,
      { type: 'createFrame', frame: { x: 0, y: 0, width: 1, height: 1 }, parent: 'a14' },
      { code: 'editor.clip-depth', path: '/nodes/j/parent' },
    );
  });

  it('fails a paste into a source that breaks an instance’s clip depth, with no ID drawn', () => {
    const setup = counted(JSON.parse(fixture('depth/clip-32.json')) as unknown);
    const { target } = setup;
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 1, height: 1 },
    });
    ok(target, { type: 'copy', ids: [frame!] });
    ok(target, { type: 'setScope', id: 'a14' });
    fails(setup, { type: 'paste' }, { code: 'editor.clip-depth', path: '/nodes/i/parent' });
    ok(target, { type: 'setScope', id: 'a13' });
    ok(target, { type: 'paste' });
  });

  it('symbolChange: a change that reparents nothing checks no instance (bounded work)', () => {
    const { target } = counted();
    const before = documentOf(target);
    // A source child resized: no root, no instance to check.
    const resized = applyEdit(
      before,
      {
        type: 'setFrames',
        frames: [{ id: 's1-r', frame: { x: 0, y: 0, width: 1, height: 1 } }],
      },
      { ids: () => 'x', activePage: 'page-1' },
    );
    if (!resized.ok) throw new Error(resized.code);
    expect(symbolChange(before, resized.document, resized.touched)).toEqual({
      roots: [],
      instances: [],
    });
    // A node created outside any source: a root, no instance.
    const created = applyEdit(
      before,
      { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 } },
      { ids: () => 'x', activePage: 'page-1' },
    );
    if (!created.ok) throw new Error(created.code);
    expect(symbolChange(before, created.document, created.touched)).toEqual({
      roots: ['x'],
      instances: [],
    });
    // A node created inside s1: every instance of s1, on every page, in pages order.
    const inside = applyEdit(
      before,
      { type: 'createRectangle', frame: { x: 0, y: 0, width: 1, height: 1 }, parent: 's1-g' },
      { ids: () => 'x', activePage: 'page-1' },
    );
    if (!inside.ok) throw new Error(inside.code);
    expect(symbolChange(before, inside.document, inside.touched)).toEqual({
      roots: ['x'],
      instances: ['i1', 'i2', 'i4'],
    });
    expect(documentTree(inside.document).node('x')?.parent).toBe('s1-g');
  });
});

describe('detachInstances (M7-A09)', () => {
  it('detaches an equal-size instance: same ID and placement, copies of the source, one step', () => {
    const { target, drawn } = counted();
    ok(target, { type: 'setSelection', ids: ['i1'] });
    const before = documentOf(target);
    expect(run(target, { type: 'detachInstances', ids: ['i1'] })).toEqual({ ok: true, ids: [] });
    expect(drawn()).toBe(6);
    const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
    const nodes = detachedNodes(before, 'i1', ids);
    // At equal size the copies are the source's descendants field for field (M7-X6).
    const copyOf = new Map(S1_ORDER.map((source, k) => [source, ids[k]!] as const));
    S1_ORDER.forEach((source, i) =>
      expect(nodes[ids[i]!]).toEqual(renamed(before.nodes[source]!, copyOf, 's1', 'i1')),
    );
    const s1 = before.nodes.s1 as Extract<NodeV6, { type: 'symbol' }>;
    expect(nodes.i1).toEqual({
      id: 'i1',
      name: 'Card',
      parent: 'page-1',
      frame: { x: 140, y: 0, width: 100, height: 80 },
      rotation: 0,
      constraints: START,
      opacity: 1,
      visible: true,
      type: 'frame',
      children: ['n1', 'n2', 'n5'],
      fill: s1.fill,
      stroke: s1.stroke,
    });
    expect(text(target)).toBe(expectedText(before, nodes));
    expect(target.query({ type: 'selection' })).toEqual(['i1']);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
    const after = text(target);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(serializeDocument(before));
    ok(target, { type: 'redo' });
    expect(text(target)).toBe(after);
  });

  it('draws IDs in page-tree pre-order whatever the listed order, each expansion in pre-order', () => {
    const { target } = counted();
    ok(target, { type: 'setActivePage', id: 'page-2' });
    const before = documentOf(target);
    // i2 (in g1, rotated, scale 2) comes before i4 (in f2, scale 0.5) in page pre-order.
    ok(target, { type: 'detachInstances', ids: ['i4', 'i2'] });
    const first = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'];
    const second = ['n7', 'n8', 'n9', 'n10', 'n11', 'n12'];
    expect(text(target)).toBe(
      expectedText(before, {
        ...detachedNodes(before, 'i2', first),
        ...detachedNodes(before, 'i4', second),
      }),
    );
  });

  it('the scene of a detached frame equals the instance’s up to the ID map', () => {
    for (const [page, instance] of [
      ['page-1', 'i1'],
      ['page-2', 'i2'],
      ['page-2', 'i4'],
    ] as const) {
      const { target } = counted();
      ok(target, { type: 'setActivePage', id: page });
      const before = documentOf(target);
      const scene = projectPage(before, page, noCustom);
      ok(target, { type: 'detachInstances', ids: [instance] });
      const after = projectPage(documentOf(target), page, noCustom);
      const copyOf = new Map(S1_ORDER.map((id, i) => [id, `n${i + 1}`] as const));
      const prefix = `${instance}\u0000@`;
      const mapId = (id: string): string => {
        if (!id.startsWith(prefix)) return id;
        const rest = id.slice(prefix.length);
        const cut = rest.indexOf('\u0000');
        const source = cut < 0 ? rest : rest.slice(0, cut);
        return copyOf.get(source)! + (cut < 0 ? '' : rest.slice(cut));
      };
      const mapped = (value: unknown): unknown =>
        typeof value === 'string'
          ? mapId(value)
          : Array.isArray(value)
            ? value.map(mapped)
            : typeof value === 'object' && value !== null
              ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapped(v)]))
              : value;
      expect(after.rootOrder).toEqual(scene.rootOrder);
      expect([...after.nodes.keys()]).toEqual([...scene.nodes.keys()].map(mapId));
      for (const [id, snapshot] of scene.nodes) {
        expect(after.nodes.get(mapId(id))).toEqual(mapped(snapshot));
      }
    }
  });

  it('detaches an instance of an empty source into an empty frame, drawing no ID', () => {
    const { target, drawn } = counted();
    const before = documentOf(target);
    ok(target, { type: 'detachInstances', ids: ['i3'] });
    expect(drawn()).toBe(0);
    const {
      symbol: _symbol,
      textOverrides: _overrides,
      ...rest
    } = before.nodes.i3 as Extract<NodeV6, { type: 'instance' }>;
    expect(_overrides).toEqual({});
    expect(_symbol).toBe('s2');
    expect(documentOf(target).nodes.i3).toEqual({
      ...rest,
      type: 'frame',
      children: [],
      fill: null,
      stroke: null,
    });
    expect(text(target)).toBe(expectedText(before, detachedNodes(before, 'i3', [])));
  });

  it('fails each rule with nothing changed and no ID drawn, in the stated order', () => {
    const setup = counted();
    const command = (ids: unknown) => ({ type: 'detachInstances', ids }) as Command;
    fails(setup, command('i1'), { code: 'editor.invalid-command', path: '/ids' });
    fails(setup, command([]), { code: 'editor.invalid-command', path: '/ids' });
    fails(setup, command(['i1', 'i1']), { code: 'editor.invalid-command', path: '/ids' });
    fails(setup, command(['nope']), { code: 'editor.unknown-node' });
    // An instance of another page is unknown on the active one; unknown before not-an-instance.
    fails(setup, command(['i2']), { code: 'editor.unknown-node' });
    fails(setup, command(['s1', 'nope']), { code: 'editor.unknown-node' });
    fails(setup, command(['i1', 's1']), { code: 'editor.not-an-instance' });
    fails(setup, command(['s1-r']), { code: 'editor.not-an-instance' });
    const target = createEditor({ document: JSON.parse(SYMBOLS) as unknown, ids: () => 's1' });
    const before = text(target);
    expect(run(target, command(['i1']))).toEqual({ ok: false, code: 'editor.duplicate-id' });
    expect(text(target)).toBe(before);
  });

  it('fails an invalid expansion with editor.invalid-expansion and draws no ID (M7-X3)', () => {
    const document = overflowing();
    let drawn = 0;
    const result = applyEdit(
      document,
      { type: 'detachInstances', ids: ['I'] },
      {
        ids: () => `n${++drawn}`,
        activePage: 'p',
      },
    );
    expect(result).toEqual({ ok: false, code: 'editor.invalid-expansion', path: '/nodes/I' });
    expect(drawn).toBe(0);
  });
});

describe('the source deletion rule (M7-A13, section 5.4)', () => {
  /** The document after deleting with `command`, every s1 instance in `detached` detached. */
  function expectDeleted(
    command: Command,
    detached: readonly string[],
    removed: readonly string[],
    page = 'page-1',
    pages?: DocumentV6['pages'],
  ) {
    const { target, drawn } = counted();
    ok(target, { type: 'setActivePage', id: page });
    const before = documentOf(target);
    expect(run(target, command)).toEqual({ ok: true, ids: [] });
    let next = 0;
    const nodes: Record<string, NodeV6> = {};
    for (const instance of detached) {
      const count =
        before.nodes[instance]!.type === 'instance' ? expandedCount(before, instance) : 0;
      const ids = Array.from({ length: count }, () => `n${++next}`);
      Object.assign(nodes, detachedNodes(before, instance, ids));
    }
    expect(drawn()).toBe(next);
    const expected = expectedText(before, nodes, removed, pages);
    expect(text(target)).toBe(expected);
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(serializeDocument(before));
    // Undo restores the source and the linked instances: they expand again.
    for (const instance of detached) {
      expect(documentOf(target).nodes[instance]!.type).toBe('instance');
    }
    ok(target, { type: 'redo' });
    expect(text(target)).toBe(expected);
    return { target, before };
  }

  function expandedCount(document: DocumentV6, instance: string): number {
    const result = expandInstance(document, instance);
    return result !== null && result.ok ? result.expansion.nodes.size : 0;
  }

  const pagesWithout = (pages: DocumentV6['pages'], page: string, removed: readonly string[]) =>
    pages.map((entry) =>
      entry.id === page
        ? { ...entry, children: entry.children.filter((id) => !removed.includes(id)) }
        : entry,
    );

  it('deleteNodes of a source detaches every remaining instance on every page in ID order', () => {
    const { before } = expectDeleted(
      { type: 'deleteNodes', ids: ['s1'] },
      ['i1', 'i2', 'i4'],
      S1_SUBTREE,
      'page-1',
      pagesWithout((JSON.parse(SYMBOLS) as DocumentV6).pages, 'page-1', ['s1']),
    );
    expect(before.nodes.s1).toBeDefined();
  });

  it('an instance deleted with its source is deleted, not detached', () => {
    expectDeleted(
      { type: 'deleteNodes', ids: ['i1', 's1'] },
      ['i2', 'i4'],
      [...S1_SUBTREE, 'i1'],
      'page-1',
      pagesWithout((JSON.parse(SYMBOLS) as DocumentV6).pages, 'page-1', ['s1', 'i1']),
    );
  });

  it('the delete of an ancestor of a source detaches its instances', () => {
    const { target, drawn } = counted();
    const [group] = ok(target, { type: 'groupNodes', ids: ['s1', 'i3'], kind: 'group' });
    const before = documentOf(target);
    const base = drawn();
    ok(target, { type: 'deleteNodes', ids: [group!] });
    const ids = (from: number) => Array.from({ length: 6 }, (_, i) => `n${base + from + i + 1}`);
    expect(text(target)).toBe(
      expectedText(
        before,
        {
          ...detachedNodes(before, 'i1', ids(0)),
          ...detachedNodes(before, 'i2', ids(6)),
          ...detachedNodes(before, 'i4', ids(12)),
        },
        [group!, ...S1_SUBTREE, 'i3'],
        before.pages.map((page) => (page.id === 'page-1' ? { ...page, children: ['i1'] } : page)),
      ),
    );
    // s2, on page-2, stays a source without instances.
    expect(documentOf(target).nodes.s2?.type).toBe('symbol');
  });

  it('removePage of a source page detaches its instances on other pages', () => {
    const value = JSON.parse(SYMBOLS) as Json;
    // page-1 holds s1, i1 and i3: i1 and i3 are deleted; s1's i2 and i4 on page-2 detach.
    const page1 = ['s1', 'i1', 'i3', ...S1_ORDER];
    expectDeleted({ type: 'removePage', id: 'page-1' }, ['i2', 'i4'], page1, 'page-2', [
      value.pages[1]!,
    ] as DocumentV6['pages']);
    // page-2 holds s2, whose instance i3 on page-1 detaches (an empty frame).
    const page2 = ['g1', 'i2', 'r2', 'f2', 'i4', 's2', 'd1', 'd1-r'];
    expectDeleted({ type: 'removePage', id: 'page-2' }, ['i3'], page2, 'page-1', [
      value.pages[0]!,
    ] as DocumentV6['pages']);
  });

  it('deletes instances, and a symbol whose instances are all deleted with it, detaching none', () => {
    const { target, drawn } = counted();
    ok(target, { type: 'deleteNodes', ids: ['i1', 'i3'] });
    ok(target, { type: 'setActivePage', id: 'page-2' });
    ok(target, { type: 'deleteNodes', ids: ['s2'] });
    ok(target, { type: 'deleteNodes', ids: ['g1', 'f2'] });
    ok(target, { type: 'removePage', id: 'page-1' });
    const after = documentOf(target);
    expect(Object.values(after.nodes).filter((entry) => entry.type === 'instance')).toEqual([]);
    expect(Object.values(after.nodes).filter((entry) => entry.type === 'frame')).toHaveLength(1);
    expect(after.nodes.s1).toBeUndefined();
    expect(drawn()).toBe(0);
  });

  // The `cut` part of the rule (U1 note 6 lifted by M7-U5) is tested in `m7-u5-clipboard.test.ts`.

  it('a failing automatic detach fails the delete with nothing drawn (M7-X3)', () => {
    const document = overflowing();
    let drawn = 0;
    const context = { ids: () => `n${++drawn}`, activePage: 'p' };
    expect(applyEdit(document, { type: 'deleteNodes', ids: ['S'] }, context)).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/I',
    });
    // Deleting the instance with its source detaches nothing.
    const both = applyEdit(document, { type: 'deleteNodes', ids: ['S', 'I'] }, context);
    expect(both.ok).toBe(true);
    expect(drawn).toBe(0);
  });

  it('reports the delete’s own failure before an invalid expansion to detach (section 5.4)', () => {
    const document = overflowing(true);
    let drawn = 0;
    const context = { ids: () => `n${++drawn}`, activePage: 'p' };
    // Deleting the mask path leaves `mr` as the mask source; the source's instance is invalid.
    expect(applyEdit(document, { type: 'deleteNodes', ids: ['mp', 'S'] }, context)).toEqual({
      ok: false,
      code: 'editor.invalid-mask-source',
      path: '/nodes/M/children/0',
    });
    expect(applyEdit(document, { type: 'deleteNodes', ids: ['S'] }, context)).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/I',
    });
    expect(drawn).toBe(0);
  });

  it('checks editor.duplicate-id last, after the detach is built', () => {
    const target = createEditor({ document: JSON.parse(SYMBOLS) as unknown, ids: () => 'i1' });
    const before = text(target);
    expect(run(target, { type: 'deleteNodes', ids: ['s1'] })).toEqual({
      ok: false,
      code: 'editor.duplicate-id',
    });
    expect(run(target, { type: 'removePage', id: 'page-1' })).toEqual({
      ok: false,
      code: 'editor.duplicate-id',
    });
    expect(text(target)).toBe(before);
    // Without an instance to detach the delete draws nothing.
    ok(target, { type: 'deleteNodes', ids: ['i3', 's1-r'] });
  });
});
