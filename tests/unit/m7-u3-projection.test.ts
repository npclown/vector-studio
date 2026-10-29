import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RenderChangeSet } from '@vector-studio/contracts';
import { validateDocument, type DocumentV3 } from '@vector-studio/model';
import { describe, expect, it, vi } from 'vitest';
import {
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import { ExpansionCache, expandInstance } from '../../packages/editor-core/src/expansion.js';
import { localTransform } from '../../packages/editor-core/src/geometry.js';
import {
  boundsOf,
  deepestHit,
  hitsAt,
  marqueeHits,
  selectionTarget,
  targetChain,
} from '../../packages/editor-core/src/hit-test.js';
import {
  SceneProjector,
  documentIdOf,
  projectNode,
  projectPage,
} from '../../packages/editor-core/src/projector.js';
import { boxOfFrame, snapSet } from '../../packages/editor-core/src/snap.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// MVP M7-U3 (M7 contract, section 4): instances project as frame units holding their expansion
// with the scene IDs of section 4.1, one unit for isolation, released after a source change, with
// snapshot reuse per M7-X4; hit testing, selection, marquee, snapping and scope follow section
// 4.3, and the projector and hit testing share the editor's expansion cache. Criteria M7-A03,
// M7-A04, M7-A05, and the artboard-target and marquee half of M7-A06.

const root = path.resolve(import.meta.dirname, '../..');
const fixture = (name: string) =>
  readFileSync(path.join(root, 'tests/fixtures/m7-symbols', name), 'utf8');
const SYMBOLS = fixture('symbols.v3.json');
const START = { horizontal: 'start', vertical: 'start' } as const;
const none = { shift: false, alt: false, meta: false, ctrl: false };
const noCustom = () => null;
/** An extension check that fails every node it sees (M7-X3). */
const FAILING = () => ({ code: 'editor.extension-failed' as const, path: '' });
const C = '\u0000content';
const BG = '\u0000background';
const BD = '\u0000border';
const at = (instance: string, node: string) => `${instance}\u0000@${node}`;
const black = { r: 0, g: 0, b: 0, a: 1 };
const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };

type JsonNode = Record<string, unknown> & {
  frame: { x: number; y: number; width: number; height: number };
};
type Json = {
  pages: { id: string; children: string[] }[];
  nodes: Record<string, JsonNode>;
};

/** The symbols fixture after `edit`, read by the model. */
function symbols(edit: (value: Json) => void = () => {}): DocumentV3 {
  const value = JSON.parse(SYMBOLS) as Json;
  edit(value);
  const result = validateDocument(value);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function base(id: string, parent: string, type: string, extra: Record<string, unknown>) {
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
    ...extra,
  };
}

const rect = (id: string, parent: string, frame: JsonNode['frame'], fill = red) =>
  base(id, parent, 'rectangle', { frame, cornerRadii: [0, 0, 0, 0], fill, stroke: null });

/**
 * One page: a 100 × 100 source `S` without fill or stroke (unless given) holding a red
 * rectangle `a` at (80, 40, 40, 20), which sticks out of the source's clip, and instance `I` of
 * it at (200, 0) with size `size`.
 */
function clipped(size = 100, sourceStroke: unknown = null, rotation = 0): DocumentV3 {
  const result = validateDocument({
    schemaVersion: 3,
    id: 'doc',
    pages: [{ id: 'p', name: 'Page 1', children: ['S', 'I'] }],
    nodes: {
      S: base('S', 'p', 'symbol', {
        frame: { x: 0, y: 0, width: 100, height: 100 },
        children: ['a'],
        fill: null,
        stroke: sourceStroke,
      }),
      a: rect('a', 'S', { x: 80, y: 40, width: 40, height: 20 }),
      I: base('I', 'p', 'instance', {
        frame: { x: 200, y: 0, width: size, height: size },
        rotation,
        symbol: 'S',
      }),
    },
  });
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

const star = starExtension.nodeTypes![0]!;
/** The star extension's geometry, as the editor's registry gives it. */
const starGeometry = (node: { type: string; customType?: string; data?: unknown; frame: never }) =>
  node.type === 'custom' && node.customType === 'ext.star'
    ? star.toScene(node.data as never, node.frame)
    : null;

/**
 * One page: a 100 × 100 source `S` without fill or stroke holding a mask group `M` (a path
 * triangle `mp` masking a red square `mr`, both 50 × 50) and a star `c` at (60, 60, 40, 40);
 * instance `I` of it at (200, 0), 200 × 200 (scale 2).
 */
function masked(): DocumentV3 {
  const square = { x: 0, y: 0, width: 50, height: 50 };
  const result = validateDocument({
    schemaVersion: 3,
    id: 'doc',
    pages: [{ id: 'p', name: 'Page 1', children: ['S', 'I'] }],
    nodes: {
      S: base('S', 'p', 'symbol', {
        frame: { x: 0, y: 0, width: 100, height: 100 },
        children: ['M', 'c'],
        fill: null,
        stroke: null,
      }),
      M: base('M', 'S', 'maskGroup', { frame: square, children: ['mp', 'mr'] }),
      mp: base('mp', 'M', 'path', {
        frame: square,
        path: {
          verbs: ['move', 'line', 'line', 'close'],
          points: [0, 0, 1, 0, 0, 1],
          fillRule: 'nonzero',
        },
        fill: null,
        stroke: null,
      }),
      mr: rect('mr', 'M', square),
      c: base('c', 'S', 'custom', {
        frame: { x: 60, y: 60, width: 40, height: 40 },
        customType: 'ext.star',
        data: { innerRatio: 0.5, points: 5 },
        fill: red,
        stroke: null,
      }),
      I: base('I', 'p', 'instance', {
        frame: { x: 200, y: 0, width: 200, height: 200 },
        symbol: 'S',
      }),
    },
  });
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function editorOf(document: unknown = JSON.parse(SYMBOLS)): Editor {
  return createEditor({ document });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function attached(
  document?: unknown,
  renderer = new RecordingRenderer(),
): { target: Editor; renderer: RecordingRenderer; events: EditorEvent[] } {
  const target = editorOf(document);
  const events: EditorEvent[] = [];
  target.subscribe((event) => events.push(event));
  target.attachRenderer(renderer);
  return { target, renderer, events };
}

const documentOf = (target: Editor) => target.query({ type: 'document' });

/** A fresh projection of the active page, with a fresh expansion cache and no memo. */
function fresh(target: Editor, omit: readonly string[] = []) {
  return projectPage(
    documentOf(target),
    target.query({ type: 'activePage' }),
    noCustom,
    new Set(omit),
  );
}

/** The renderer holds exactly a fresh projection of the active page minus `omit`. */
function expectSynchronized(
  target: Editor,
  renderer: RecordingRenderer,
  omit: readonly string[] = [],
) {
  const projection = fresh(target, omit);
  const scene = renderer.mirror.readRetainedScene();
  expect(scene).not.toBeNull();
  expect(scene!.rootOrder).toEqual(projection.rootOrder);
  expect(scene!.nodes.length).toBe(projection.nodes.size);
  for (const [id, snapshot] of projection.nodes) expect(scene!.getNode(id)).toEqual(snapshot);
}

/** The scene IDs the renderer holds, in no particular order. */
function heldIds(renderer: RecordingRenderer): string[] {
  return renderer.mirror.readRetainedScene()!.nodes.map((node) => node.id);
}

function lastChanges(renderer: RecordingRenderer): RenderChangeSet {
  const call = [...renderer.calls].reverse().find((entry) => entry.method === 'applyChanges');
  if (call?.method !== 'applyChanges') throw new Error('no change set');
  return call.input;
}

const sentIds = (changes: RenderChangeSet) => ({
  inserted: changes.inserted.map((node) => node.id).sort(),
  updated: changes.updated.map((node) => node.id).sort(),
  removed: [...changes.removed].sort(),
});

/** Of the instances `ids`, their document nodes serialized, to check nothing writes to them. */
const instanceText = (target: Editor, ids: readonly string[]) =>
  JSON.stringify(ids.map((id) => documentOf(target).nodes[id]));

describe('M7-A04 projection: scene structure and IDs (section 4.1)', () => {
  it('projects an instance as a frame unit with its expansion under the section 4.1 IDs', () => {
    const document = symbols();
    const projection = projectPage(document, 'page-1', noCustom);
    const i1 = document.nodes.i1!;
    const s1 = document.nodes.s1!;
    expect(projection.rootOrder).toEqual(['s1', 'i1', 'i3']);
    expect(projection.units).toEqual([
      's1',
      's1-r',
      's1-g',
      's1-e',
      's1-p',
      's1-f',
      's1-l',
      'i1',
      'i3',
    ]);
    const ids = [
      'i1',
      `i1${C}`,
      `i1${BG}`,
      `i1${BD}`,
      at('i1', 's1-r'),
      at('i1', 's1-g'),
      at('i1', 's1-e'),
      at('i1', 's1-p'),
      at('i1', 's1-f'),
      `${at('i1', 's1-f')}${C}`,
      `${at('i1', 's1-f')}${BG}`,
      at('i1', 's1-l'),
    ];
    expect(projection.unitIds.get('i1')).toEqual(ids);
    for (const id of ids) expect(documentIdOf(id)).toBe('i1');
    const node = (id: string) => projection.nodes.get(id)!;
    const inner = { transform: [1, 0, 0, 1, 0, 0], visible: true, opacity: 1 };
    const box = { kind: 'rectangle', width: 100, height: 80, cornerRadii: [0, 0, 0, 0] };
    expect(node('i1')).toEqual({
      id: 'i1',
      parentId: null,
      transform: localTransform(i1.frame, i1.rotation),
      visible: true,
      opacity: 1,
      kind: 'container',
      children: [`i1${C}`, `i1${BD}`],
      clip: null,
    });
    expect(node(`i1${C}`)).toEqual({
      id: `i1${C}`,
      parentId: 'i1',
      ...inner,
      kind: 'container',
      children: [`i1${BG}`, at('i1', 's1-r'), at('i1', 's1-g'), at('i1', 's1-f')],
      clip: { kind: 'rect', x: 0, y: 0, width: 100, height: 80 },
    });
    // The source's fill and stroke, the instance's size.
    expect(node(`i1${BG}`)).toEqual({
      id: `i1${BG}`,
      parentId: `i1${C}`,
      ...inner,
      kind: 'primitive',
      geometry: box,
      style: { fill: s1.type === 'symbol' ? s1.fill : null, stroke: null },
    });
    expect(node(`i1${BD}`)).toEqual({
      id: `i1${BD}`,
      parentId: 'i1',
      ...inner,
      kind: 'primitive',
      geometry: box,
      style: { fill: null, stroke: { color: black, width: 1 } },
    });
    expect(node(at('i1', 's1-g'))).toMatchObject({
      parentId: `i1${C}`,
      kind: 'container',
      children: [at('i1', 's1-e'), at('i1', 's1-p')],
      clip: null,
    });
    expect(node(at('i1', 's1-f'))).toMatchObject({
      parentId: `i1${C}`,
      kind: 'container',
      children: [`${at('i1', 's1-f')}${C}`],
    });
    expect(node(`${at('i1', 's1-f')}${C}`)).toMatchObject({
      parentId: at('i1', 's1-f'),
      children: [`${at('i1', 's1-f')}${BG}`, at('i1', 's1-l')],
      clip: { kind: 'rect', x: 0, y: 0, width: 80, height: 30 },
    });
    // At equal size each expanded leaf is the source node's projection under its expanded ID.
    for (const [leaf, parent] of [
      ['s1-r', `i1${C}`],
      ['s1-e', at('i1', 's1-g')],
      ['s1-p', at('i1', 's1-g')],
      ['s1-l', `${at('i1', 's1-f')}${C}`],
    ] as const) {
      expect(node(at('i1', leaf))).toEqual({
        ...projectNode(document.nodes[leaf]!, noCustom, parent),
        id: at('i1', leaf),
      });
    }
  });

  it('projects a symbol exactly as a frame', () => {
    const document = symbols();
    const asFrame = symbols((value) => {
      value.nodes.s1!.type = 'frame';
      // A frame cannot hold the instances' source; drop them for the comparison.
      value.pages[0]!.children = ['s1'];
      value.pages[1]!.children = ['f2', 's2', 'd1'];
      for (const id of ['i1', 'i2', 'i3', 'i4', 'g1', 'r2']) delete value.nodes[id];
      value.nodes.f2!.children = [];
    });
    const symbol = projectPage(document, 'page-1', noCustom);
    const frame = projectPage(asFrame, 'page-1', noCustom);
    for (const id of frame.nodes.keys()) expect(symbol.nodes.get(id)).toEqual(frame.nodes.get(id));
    expect(symbol.unitIds.get('s1')).toEqual(frame.unitIds.get('s1'));
  });

  it('scaled and rotated instances project their expansion from the cache', () => {
    const document = symbols();
    const projection = projectPage(document, 'page-2', noCustom);
    for (const id of ['i2', 'i4']) {
      const result = expandInstance(document, id)!;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const unit = projection.unitIds.get(id)!;
      expect(unit[0]).toBe(id);
      const instance = document.nodes[id]!;
      expect(projection.nodes.get(id)).toMatchObject({
        transform: localTransform(instance.frame, instance.rotation),
      });
      expect(projection.nodes.get(`${id}${C}`)).toMatchObject({
        clip: { kind: 'rect', x: 0, y: 0, ...{ width: instance.frame.width } },
      });
      for (const leaf of ['s1-r', 's1-e', 's1-p']) {
        const snapshot = projection.nodes.get(at(id, leaf))!;
        const parent = leaf === 's1-r' ? `${id}${C}` : at(id, 's1-g');
        expect(snapshot).toEqual({
          ...projectNode(result.expansion.nodes.get(leaf)!, noCustom, parent),
          id: at(id, leaf),
        });
      }
    }
    // i4 sits in frame f2's content; i2 in group g1.
    expect(projection.nodes.get('i4')!.parentId).toBe(`f2${C}`);
    expect(projection.nodes.get('i2')!.parentId).toBe('g1');
  });

  it('an empty source gives a frame unit of two nodes; a hidden instance keeps its visibility', () => {
    const projection = projectPage(symbols(), 'page-1', noCustom);
    expect(projection.unitIds.get('i3')).toEqual(['i3', `i3${C}`]);
    expect(projection.nodes.get('i3')).toMatchObject({ visible: false, children: [`i3${C}`] });
    expect(projection.nodes.get(`i3${C}`)).toMatchObject({ children: [] });
  });

  it('the renderer-core mirror accepts every fixture page projection', () => {
    for (const name of ['symbols.v3.json', 'depth/clip-32.json', 'depth/tree-256.json']) {
      const value = JSON.parse(fixture(name)) as { pages: { id: string }[] };
      const { target, renderer, events } = attached(value);
      for (const page of value.pages) {
        ok(target, { type: 'setActivePage', id: page.id });
        expectSynchronized(target, renderer);
      }
      expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
    }
  });

  it('projects a mask group and a custom node inside a source through the expansion', () => {
    const document = masked();
    const projection = projectPage(document, 'p', starGeometry as never);
    const result = expandInstance(document, 'I')!;
    if (!result.ok) throw new Error('invalid');
    expect(projection.nodes.get(`I${C}`)).toMatchObject({ children: [at('I', 'M'), at('I', 'c')] });
    expect(projection.nodes.get(at('I', 'M'))).toMatchObject({
      parentId: `I${C}`,
      kind: 'container',
      children: [at('I', 'mp'), at('I', 'mr')],
      clip: { kind: 'mask' },
    });
    for (const [id, parent] of [
      ['mp', at('I', 'M')],
      ['mr', at('I', 'M')],
      ['c', `I${C}`],
    ] as const) {
      expect(projection.nodes.get(at('I', id))).toEqual({
        ...projectNode(result.expansion.nodes.get(id)!, starGeometry as never, parent),
        id: at('I', id),
      });
    }
    // The star at scale 2 is drawn from its scaled frame.
    expect(result.expansion.nodes.get('c')!.frame).toEqual({
      x: 120,
      y: 120,
      width: 80,
      height: 80,
    });
    // Without the custom geometry the star projects nothing, in the source and the instance.
    const plain = projectPage(document, 'p', noCustom);
    expect(plain.nodes.has(at('I', 'c'))).toBe(false);
    expect(plain.nodes.get(`I${C}`)).toMatchObject({ children: [at('I', 'M')] });
    // The editor's renderer accepts it with the star extension.
    const target = createEditor({
      document: JSON.parse(JSON.stringify(document)),
      extensions: [starExtension],
    });
    const renderer = new RecordingRenderer();
    const events: EditorEvent[] = [];
    target.subscribe((event) => events.push(event));
    target.attachRenderer(renderer);
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
    expect(heldIds(renderer)).toEqual(expect.arrayContaining([at('I', 'M'), at('I', 'c')]));
  });

  it('never mutates the shared expansion node map', () => {
    const document = symbols();
    const cache = new ExpansionCache();
    const result = cache.expand(document, 'i4')!;
    if (!result.ok) throw new Error('invalid');
    const before = [...result.expansion.nodes.entries()];
    projectPage(document, 'page-2', noCustom, new Set(), new Map(), cache);
    projectPage(document, 'page-2', noCustom, new Set(), new Map(), cache);
    expect([...result.expansion.nodes.entries()]).toEqual(before);
    for (const [id, node] of before) expect(result.expansion.nodes.get(id)).toBe(node);
  });
});

describe('M7-A04 isolation and release (section 4.2)', () => {
  it('a rejected expansion excludes the instance as one unit and a source change releases it', () => {
    // Without stroked path support the stroked path `s1-p` is rejected, in the source and in
    // the instance's expansion.
    const renderer = new RecordingRenderer('supported', { pathStrokes: 'unsupported' });
    const { target, events } = attached(undefined, renderer);
    const rejected = events.filter((event) => event.type === 'diagnostic');
    expect(rejected).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.renderer-unsupported',
        reason: 'unsupported-feature',
        nodeIds: ['i1', 's1-p'],
      },
    ]);
    expectSynchronized(target, renderer, ['i1', 's1-p']);
    expect(heldIds(renderer).some((id) => documentIdOf(id) === 'i1')).toBe(false);
    // A change elsewhere in the source releases the instance, which is retried and rejected
    // again; s1-p, not touched, stays out without a retry.
    events.length = 0;
    ok(target, { type: 'setNodeProps', id: 's1-r', props: { fill: blue } });
    expectSynchronized(target, renderer, ['i1', 's1-p']);
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.renderer-unsupported',
        reason: 'unsupported-feature',
        nodeIds: ['i1'],
      },
    ]);
    events.length = 0;
    // Removing the stroke of s1-p releases s1-p and every instance of the source.
    ok(target, { type: 'setNodeProps', id: 's1-p', props: { stroke: null } });
    expectSynchronized(target, renderer);
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
    expect(heldIds(renderer)).toContain(at('i1', 's1-p'));
  });

  it('deleting the rejected source node releases the instance through its parent', () => {
    const renderer = new RecordingRenderer('supported', { pathStrokes: 'unsupported' });
    const { target, events } = attached(undefined, renderer);
    events.length = 0;
    ok(target, { type: 'deleteNodes', ids: ['s1-p'] });
    expectSynchronized(target, renderer);
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
    expect(heldIds(renderer)).toContain(at('i1', 's1-e'));
    // Undo brings the stroked path back: both are rejected again.
    ok(target, { type: 'undo' });
    expectSynchronized(target, renderer, ['i1', 's1-p']);
  });

  it('a change inside a nested frame of the source releases the instance', () => {
    // Without path fill support the fill-mode line s1-l, inside the nested frame s1-f, is
    // rejected, and with it i1.
    const renderer = new RecordingRenderer('supported', { pathFills: 'unsupported' });
    const { target, events } = attached(undefined, renderer);
    expect(events.filter((event) => event.type === 'diagnostic')).toMatchObject([
      { nodeIds: ['i1', 's1-l'] },
    ]);
    events.length = 0;
    // Without an arrowhead the line is in stroke mode: s1-l and i1 are released and accepted.
    ok(target, { type: 'setNodeProps', id: 's1-l', props: { endArrow: 'none' } });
    expectSynchronized(target, renderer);
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
  });

  it('a source moved into a group still releases its instances', () => {
    const renderer = new RecordingRenderer('supported', { pathStrokes: 'unsupported' });
    const { target, events } = attached(undefined, renderer);
    const [group] = ok(target, { type: 'groupNodes', ids: ['s1'], kind: 'group' });
    expect(documentOf(target).nodes.s1!.parent).toBe(group);
    expectSynchronized(target, renderer, ['i1', 's1-p']);
    events.length = 0;
    ok(target, { type: 'setNodeProps', id: 's1-p', props: { stroke: null } });
    expectSynchronized(target, renderer);
    expect(events.filter((event) => event.type === 'diagnostic')).toEqual([]);
    expect(heldIds(renderer)).toContain(at('i1', 's1-p'));
  });

  it('a change to a source on another page updates its instances on the active page', () => {
    const { target, renderer } = attached();
    ok(target, { type: 'setActivePage', id: 'page-2' });
    // s1 is on page 1; i2 and i4 are on page 2.
    renderer.calls.length = 0;
    ok(target, { type: 'setNodeProps', id: 's1', props: { fill: blue } });
    expectSynchronized(target, renderer);
    expect(sentIds(lastChanges(renderer))).toEqual({
      inserted: [],
      updated: [`i2${BG}`, `i4${BG}`],
      removed: [],
    });
  });

  it('excludes an instance whose expansion is invalid with one diagnostic (M7-X3)', () => {
    const renderer = new RecordingRenderer();
    const reports: unknown[] = [];
    // A check that fails every rebuilt copy: the scaled instances i2 and i4 are invalid.
    const cache = new ExpansionCache(FAILING);
    const projector = new SceneProjector(renderer, noCustom, (event) => reports.push(event), cache);
    const document = symbols();
    projector.replace(document, 'page-2');
    expect(reports).toEqual([
      {
        type: 'diagnostic',
        code: 'editor.scene-rejected',
        reason: 'invalid-value',
        nodeIds: ['i2', 'i4'],
      },
    ]);
    const held = heldIds(renderer);
    expect(held).toContain('g1');
    expect(held.some((id) => ['i2', 'i4'].includes(documentIdOf(id)))).toBe(false);
    // Reported once, not again on the next change.
    const next = symbols((value) => {
      value.nodes.r2!.visible = false;
    });
    projector.change(next, 'page-2', ['r2']);
    expect(reports).toHaveLength(1);
  });
});

describe('M7-A03 propagation', () => {
  /**
   * Runs `step` on the fixture with page `page` active and checks: the renderer holds a fresh
   * projection, no instance node changed, the last change set sent exactly `sent` (when given),
   * and undo restores the earlier projection.
   */
  function propagates(
    page: string,
    step: (target: Editor) => void,
    sent?: { inserted: string[]; updated: string[]; removed: string[] },
  ) {
    const { target, renderer } = attached();
    if (page !== 'page-1') ok(target, { type: 'setActivePage', id: page });
    const instances = ['i1', 'i2', 'i3', 'i4'];
    const before = instanceText(target, instances);
    const projection = fresh(target);
    renderer.calls.length = 0;
    step(target);
    expectSynchronized(target, renderer);
    expect(instanceText(target, instances)).toBe(before);
    if (sent !== undefined) expect(sentIds(lastChanges(renderer))).toEqual(sent);
    expect(target.execute({ type: 'undo' }).ok).toBe(true);
    expectSynchronized(target, renderer);
    expect(fresh(target).nodes).toEqual(projection.nodes);
  }

  it('a descendant property change sends only the changed expanded nodes', () => {
    propagates(
      'page-1',
      (target) => ok(target, { type: 'setNodeProps', id: 's1-e', props: { fill: red } }),
      { inserted: [], updated: [at('i1', 's1-e'), 's1-e'], removed: [] },
    );
    // Scaled instances recompute the subtree; the value-equal path keeps its object.
    propagates(
      'page-2',
      (target) => ok(target, { type: 'setNodeProps', id: 's1-e', props: { fill: red } }),
      { inserted: [], updated: [at('i2', 's1-e'), at('i4', 's1-e')], removed: [] },
    );
  });

  it('size, fill and stroke of the source', () => {
    // A wider source halves the scale of i2 and i4: every expanded node changes, the
    // instances' own frame nodes do not.
    const all = (id: string) => [
      at(id, 's1-e'),
      at(id, 's1-f'),
      `${at(id, 's1-f')}${BG}`,
      `${at(id, 's1-f')}${C}`,
      at(id, 's1-g'),
      at(id, 's1-l'),
      at(id, 's1-p'),
      at(id, 's1-r'),
    ];
    propagates(
      'page-2',
      (target) =>
        ok(target, {
          type: 'setFrames',
          frames: [{ id: 's1', frame: { x: 0, y: 0, width: 200, height: 80 } }],
        }),
      { inserted: [], updated: [...all('i2'), ...all('i4')], removed: [] },
    );
    propagates(
      'page-1',
      (target) => ok(target, { type: 'setNodeProps', id: 's1', props: { fill: red } }),
      { inserted: [], updated: [`i1${BG}`, `s1${BG}`], removed: [] },
    );
    propagates(
      'page-2',
      (target) => ok(target, { type: 'setNodeProps', id: 's1', props: { stroke: null } }),
      { inserted: [], updated: ['i2', 'i4'], removed: [`i2${BD}`, `i4${BD}`] },
    );
  });

  it('child create, move and delete', () => {
    propagates(
      'page-2',
      (target) =>
        ok(target, {
          type: 'createRectangle',
          frame: { x: 5, y: 5, width: 10, height: 10 },
          parent: 's1',
        }),
      {
        inserted: [at('i2', 'node-1'), at('i4', 'node-1')],
        updated: [`i2${C}`, `i4${C}`],
        removed: [],
      },
    );
    propagates(
      'page-1',
      (target) => ok(target, { type: 'moveNodes', ids: ['s1-r'], parent: 's1-f', index: 0 }),
      {
        inserted: [],
        updated: [
          `${at('i1', 's1-f')}${C}`,
          at('i1', 's1-r'),
          `i1${C}`,
          `s1${C}`,
          `s1-f${C}`,
          's1-r',
        ],
        removed: [],
      },
    );
    // The group refits around the moved ellipse; the ellipse's expanded copy is equal by value
    // in the group's new space and keeps its object, while the source's own leaf is new.
    propagates(
      'page-1',
      (target) =>
        ok(target, {
          type: 'setFrames',
          frames: [{ id: 's1-e', frame: { x: 2, y: 3, width: 20, height: 20 } }],
        }),
      {
        inserted: [],
        updated: [at('i1', 's1-g'), at('i1', 's1-p'), 's1-e', 's1-g', 's1-p'],
        removed: [],
      },
    );
    propagates('page-1', (target) => ok(target, { type: 'deleteNodes', ids: ['s1-r'] }), {
      inserted: [],
      updated: [`i1${C}`, `s1${C}`],
      removed: [at('i1', 's1-r'), 's1-r'],
    });
  });

  it('a path edit inside the source', () => {
    const move = {
      type: 'movePathAnchors',
      id: 's1-p',
      anchors: [{ subpath: 0, anchor: 0 }],
      dx: 2,
      dy: 1,
    } as const;
    propagates('page-1', (target) => ok(target, move), {
      inserted: [],
      updated: [at('i1', 's1-p'), 's1-p'],
      removed: [],
    });
    // Path commands act on the active page; the instances on page 2 follow at the switch back.
    propagates('page-2', (target) => {
      ok(target, { type: 'setActivePage', id: 'page-1' });
      ok(target, {
        type: 'movePathAnchors',
        id: 's1-p',
        anchors: [{ subpath: 0, anchor: 0 }],
        dx: 2,
        dy: 1,
      });
      ok(target, { type: 'setActivePage', id: 'page-2' });
    });
  });

  it('a gesture update and its commit inside the source', () => {
    const { target, renderer } = attached();
    ok(target, { type: 'setActivePage', id: 'page-2' });
    const before = instanceText(target, ['i2', 'i4']);
    const projection = fresh(target);
    const { gesture } = internalsOf(target);
    expect(gesture.begin()).toBe(true);
    for (const x of [12, 14]) {
      renderer.calls.length = 0;
      expect(
        gesture.update({
          type: 'setFrames',
          frames: [{ id: 's1-r', frame: { x, y: 10, width: 30, height: 20 } }],
        }).ok,
      ).toBe(true);
      // Projected live into the instances on the active page (M7-X5), only the moved node.
      expectSynchronized(target, renderer);
      expect(sentIds(lastChanges(renderer))).toEqual({
        inserted: [],
        updated: [at('i2', 's1-r'), at('i4', 's1-r')],
        removed: [],
      });
    }
    // The commit has nothing to refit and sends nothing more.
    renderer.calls.length = 0;
    gesture.commit();
    expectSynchronized(target, renderer);
    expect(renderer.calls.filter((call) => call.method === 'applyChanges')).toEqual([]);
    expect(instanceText(target, ['i2', 'i4'])).toBe(before);
    expect(target.execute({ type: 'undo' }).ok).toBe(true);
    expect(fresh(target).nodes).toEqual(projection.nodes);
    expectSynchronized(target, renderer);
  });

  it('a redo after undo and a page switch keep the projection', () => {
    const { target, renderer } = attached();
    ok(target, { type: 'setNodeProps', id: 's1-g', props: { visible: false } });
    ok(target, { type: 'undo' });
    ok(target, { type: 'redo' });
    expectSynchronized(target, renderer);
    ok(target, { type: 'setActivePage', id: 'page-2' });
    expectSynchronized(target, renderer);
  });
});

describe('M7-A05 hit testing (section 4.3)', () => {
  it('an instance is hit on its expanded nodes, background and border, and the hit names it', () => {
    const document = symbols();
    // s1-r's centre in i1 (page offset 140): an expanded node.
    expect(deepestHit(document, 'page-1', { x: 165, y: 20 }, 1, noCustom)).toBe('i1');
    expect(hitsAt(document, 'page-1', { x: 165, y: 20 }, 1, noCustom)).toEqual(['i1']);
    // The background only, and the border just outside the frame.
    expect(deepestHit(document, 'page-1', { x: 150, y: 40 }, 1, noCustom)).toBe('i1');
    expect(deepestHit(document, 'page-1', { x: 242, y: 40 }, 1, noCustom)).toBe('i1');
    expect(deepestHit(document, 'page-1', { x: 250, y: 40 }, 1, noCustom)).toBeNull();
    // The same points in the source hit its own nodes; the source is hit as a frame.
    expect(deepestHit(document, 'page-1', { x: 25, y: 20 }, 1, noCustom)).toBe('s1-r');
    expect(deepestHit(document, 'page-1', { x: 10, y: 40 }, 1, noCustom)).toBe('s1');
    expect(hitsAt(document, 'page-1', { x: 25, y: 20 }, 1, noCustom)).toEqual(['s1-r', 's1']);
    // A hidden instance is not hit.
    const shown = symbols((value) => {
      value.nodes.s2!.fill = red;
    });
    expect(deepestHit(shown, 'page-1', { x: 25, y: 140 }, 1, noCustom)).toBeNull();
  });

  it('hits only inside the instance content clip', () => {
    const document = clipped();
    // `a` sticks out of the source: hit inside the clip, not beyond it.
    expect(deepestHit(document, 'p', { x: 290, y: 50 }, 1, noCustom)).toBe('I');
    expect(deepestHit(document, 'p', { x: 310, y: 50 }, 1, noCustom)).toBeNull();
    expect(deepestHit(document, 'p', { x: 90, y: 50 }, 1, noCustom)).toBe('a');
    expect(deepestHit(document, 'p', { x: 110, y: 50 }, 1, noCustom)).toBeNull();
    // A resized instance scales its content: at 200 × 200 `a` covers x 160 to 200 there.
    const large = clipped(200);
    expect(deepestHit(large, 'p', { x: 200 + 170, y: 100 }, 1, noCustom)).toBe('I');
    expect(deepestHit(large, 'p', { x: 200 + 150, y: 100 }, 1, noCustom)).toBeNull();
  });

  it('hits through a mask group and a custom node inside the expansion', () => {
    const document = masked();
    const geometry = starGeometry as never;
    // Inside the scaled triangle mask and its square: the instance.
    expect(deepestHit(document, 'p', { x: 220, y: 20 }, 1, geometry)).toBe('I');
    // Inside the square but outside the mask: nothing (the source has no fill).
    expect(deepestHit(document, 'p', { x: 280, y: 80 }, 1, geometry)).toBeNull();
    // The star's centre, with its geometry; without it the star is not hit.
    expect(deepestHit(document, 'p', { x: 360, y: 160 }, 1, geometry)).toBe('I');
    expect(deepestHit(document, 'p', { x: 360, y: 160 }, 1, noCustom)).toBeNull();
    // The source's own nodes at the unscaled points.
    expect(deepestHit(document, 'p', { x: 10, y: 10 }, 1, geometry)).toBe('mr');
    expect(deepestHit(document, 'p', { x: 80, y: 80 }, 1, geometry)).toBe('c');
  });

  it('a rotated instance clips its content in its own axes', () => {
    const document = clipped(100, null, Math.PI / 3);
    const I = document.nodes.I!;
    const matrix = localTransform(I.frame, I.rotation);
    const page = (x: number, y: number) => ({
      x: matrix[0] * x + matrix[2] * y + matrix[4],
      y: matrix[1] * x + matrix[3] * y + matrix[5],
    });
    // `a` spans x 80 to 120 in the instance's space; the clip ends at 100.
    expect(deepestHit(document, 'p', page(90, 50), 1, noCustom)).toBe('I');
    expect(deepestHit(document, 'p', page(110, 50), 1, noCustom)).toBeNull();
    expect(deepestHit(document, 'p', page(50, 50), 1, noCustom)).toBeNull();
    // The projection clips the content to the same box under the rotated transform.
    const projection = projectPage(document, 'p', noCustom);
    expect(projection.nodes.get('I')).toMatchObject({ transform: matrix });
    expect(projection.nodes.get(`I${C}`)).toMatchObject({
      clip: { kind: 'rect', x: 0, y: 0, width: 100, height: 100 },
    });
  });

  it('a rotated, resized instance inside a group', () => {
    const document = symbols();
    const i2 = document.nodes.i2!;
    // s1-e at scale 2 is the circle of radius 20 about (120, 40) in i2's local space.
    const matrix = localTransform(i2.frame, i2.rotation);
    const page = (x: number, y: number) => ({
      x: matrix[0] * x + matrix[2] * y + matrix[4],
      y: matrix[1] * x + matrix[3] * y + matrix[5],
    });
    expect(deepestHit(document, 'page-2', page(120, 40), 1, noCustom)).toBe('i2');
    expect(selectionTarget(document, 'i2')).toBe('g1');
    expect(selectionTarget(document, 'i2', 'g1')).toBe('i2');
    expect(targetChain(document, 'i2')).toEqual(['i2', 'g1']);
    // i4, inside the top-level frame f2, is the artboard's child target.
    expect(deepestHit(document, 'page-2', { x: 330, y: 30 }, 1, noCustom)).toBe('i4');
    expect(selectionTarget(document, 'i4')).toBe('i4');
  });

  it('an invalid expansion is hit only on its background and border (M7-X3)', () => {
    const stroke = { color: black, width: 2 };
    const document = clipped(200, stroke);
    const valid = new ExpansionCache();
    const invalid = new ExpansionCache(FAILING);
    const inner = { x: 370, y: 100 };
    expect(deepestHit(document, 'p', inner, 1, noCustom, valid)).toBe('I');
    expect(deepestHit(document, 'p', inner, 1, noCustom, invalid)).toBeNull();
    expect(deepestHit(document, 'p', { x: 201, y: 100 }, 1, noCustom, invalid)).toBe('I');
  });

  it('hit testing and the projector share the editor cache: one expansion per change', () => {
    // Every expansion call of every cache is recorded with the cache it ran on, so a projector or
    // select tool that fell back to a cache of its own would show up as a second context.
    const spy = vi.spyOn(ExpansionCache.prototype, 'expand');
    try {
      const { target, renderer } = attached();
      ok(target, { type: 'setActivePage', id: 'page-2' });
      const cache = internalsOf(target).expansions;
      spy.mockClear();
      renderer.calls.length = 0;
      const start = cache.computed;
      ok(target, { type: 'setNodeProps', id: 's1-e', props: { fill: red } });
      // The projection ran on the change, through the same cache as the command's checks.
      expect(renderer.calls.some((call) => call.method === 'applyChanges')).toBe(true);
      expect(spy.mock.contexts.filter((context) => context !== cache)).toEqual([]);
      // The checks expand the changed subtree s1-g once per instance of s1 (i1, i2, i4); the
      // projection reuses them.
      const afterChange = cache.computed;
      expect(afterChange - start).toBe(3);
      spy.mockClear();
      const i2 = documentOf(target).nodes.i2!;
      const matrix = localTransform(i2.frame, i2.rotation);
      const point = {
        x: matrix[0] * 120 + matrix[2] * 40 + matrix[4],
        y: matrix[1] * 120 + matrix[3] * 40 + matrix[5],
      };
      for (const kind of ['pointerdown', 'pointerup'] as const) {
        ok(target, { type: 'input', event: { kind, point, modifiers: none } });
      }
      expect(target.query({ type: 'selection' })).toEqual(['g1']);
      // The click's hit test expanded i2 through the editor's cache, without recomputing.
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(spy.mock.contexts.filter((context) => context !== cache)).toEqual([]);
      expect(cache.computed).toBe(afterChange);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('M7-A05 selection, scope and marquee (section 4.3), M7-A06 artboard and marquee', () => {
  function click(target: Editor, point: { x: number; y: number }, kind = 'click') {
    if (kind === 'double') {
      ok(target, { type: 'input', event: { kind: 'doubleclick', point, modifiers: none } });
      return;
    }
    for (const event of ['pointerdown', 'pointerup'] as const) {
      ok(target, { type: 'input', event: { kind: event, point, modifiers: none } });
    }
  }

  it('selects an instance with the select tool, and a symbol acts as a top-level artboard', () => {
    const target = editorOf();
    click(target, { x: 165, y: 20 });
    expect(target.query({ type: 'selection' })).toEqual(['i1']);
    // A hit inside the top-level symbol targets its child on the chain (M7-A06).
    click(target, { x: 25, y: 20 });
    expect(target.query({ type: 'selection' })).toEqual(['s1-r']);
    click(target, { x: 80, y: 20 });
    expect(target.query({ type: 'selection' })).toEqual(['s1-g']);
    // On the symbol's own background, the symbol.
    click(target, { x: 10, y: 40 });
    expect(target.query({ type: 'selection' })).toEqual(['s1']);
    const document = documentOf(target);
    expect(selectionTarget(document, 's1-e')).toBe('s1-g');
    expect(selectionTarget(document, 's1')).toBe('s1');
    expect(selectionTarget(document, 's1-e', 's1')).toBe('s1-g');
    expect(targetChain(document, 's1-e')).toEqual(['s1-e', 's1-g']);
  });

  it('a double-click on an instance does nothing; setScope on it fails; a symbol is entered', () => {
    const target = editorOf();
    click(target, { x: 165, y: 20 });
    click(target, { x: 165, y: 20 }, 'double');
    expect(target.query({ type: 'scope' })).toBeNull();
    expect(target.query({ type: 'selection' })).toEqual(['i1']);
    expect(target.execute({ type: 'setScope', id: 'i1' })).toEqual({
      ok: false,
      code: 'editor.invalid-scope',
    });
    // A double-click on the group in the symbol enters the group as a frame child would.
    click(target, { x: 80, y: 20 }, 'double');
    expect(target.query({ type: 'scope' })).toBe('s1-g');
  });

  it('marquee: an instance intersects, a top-level symbol must be contained', () => {
    const document = symbols();
    // Overlapping part of s1 and part of i1.
    expect(marqueeHits(document, 'page-1', { x: 90, y: 10, width: 60, height: 10 })).toEqual([
      'i1',
    ]);
    // Containing s1 entirely; i3 is hidden.
    expect(marqueeHits(document, 'page-1', { x: -1, y: -1, width: 102, height: 200 })).toEqual([
      's1',
    ]);
    expect(marqueeHits(document, 'page-1', { x: -1, y: -1, width: 1000, height: 1000 })).toEqual([
      's1',
      'i1',
    ]);
    // Inside the symbol's scope, its children; inside a group in it, the group's.
    expect(marqueeHits(document, 'page-1', { x: 0, y: 0, width: 100, height: 80 }, 's1')).toEqual([
      's1-r',
      's1-g',
      's1-f',
    ]);
    expect(marqueeHits(document, 'page-1', { x: 0, y: 0, width: 60, height: 30 }, 's1-g')).toEqual([
      's1-e',
    ]);
    // A rotated instance in a scope by its rotated frame's bounds.
    const bounds = boundsOf(document, ['i2'])!;
    expect(
      marqueeHits(document, 'page-2', { x: bounds.x, y: bounds.y, width: 1, height: 1 }, 'g1'),
    ).toEqual(['i2']);
  });

  it('the select-tool marquee selects an instance by intersection', () => {
    const target = editorOf();
    for (const [kind, point] of [
      ['pointerdown', { x: 300, y: -10 }],
      ['pointermove', { x: 200, y: 10 }],
      ['pointerup', { x: 200, y: 10 }],
    ] as const) {
      ok(target, { type: 'input', event: { kind, point, modifiers: none } });
    }
    expect(target.query({ type: 'selection' })).toEqual(['i1']);
  });
});

describe('M7-A05 snapping (section 4.3)', () => {
  it('an instance is a candidate by its frame; symbols act as frames; no expanded node', () => {
    const document = symbols();
    const set = snapSet(document, 'page-1', null, []);
    // Page children and the children of the top-level symbol, in pre-order; i3 is hidden.
    expect(set.candidates.map((candidate) => candidate.id)).toEqual([
      's1',
      's1-r',
      's1-g',
      's1-f',
      'i1',
    ]);
    expect(set.candidates.find((candidate) => candidate.id === 'i1')!.box).toEqual(
      boxOfFrame(document.nodes.i1!.frame),
    );
    // Moving a node in the source: the symbol ancestor is a candidate as a frame ancestor.
    const moving = snapSet(document, 'page-1', 's1-g', ['s1-e']);
    // The scope's children but the moving node, the symbol's children but the moving node's
    // group ancestor, and the symbol as a frame ancestor; i1 is outside the scope.
    expect(moving.candidates.map((candidate) => candidate.id)).toEqual([
      's1',
      's1-r',
      's1-p',
      's1-f',
    ]);
  });

  it('a rotated instance snaps by its rotated frame bounds', () => {
    const document = symbols();
    const set = snapSet(document, 'page-2', 'g1', []);
    const i2 = set.candidates.find((candidate) => candidate.id === 'i2')!;
    expect(i2.box).toEqual(boxOfFrame(boundsOf(document, ['i2'])!));
    expect(i2.rotation).toBe(-1.25);
    expect(set.candidates.some((candidate) => candidate.id.includes('\u0000'))).toBe(false);
  });

  it('a move of an instance snaps to the source edge', () => {
    const target = editorOf();
    ok(target, { type: 'setSnapping', enabled: true });
    // Press on i1 at x 165 and drag 37 left: its left edge lands at 103, within 4 px of s1's
    // right edge at 100.
    for (const [kind, point] of [
      ['pointerdown', { x: 165, y: 20 }],
      ['pointermove', { x: 128, y: 20 }],
      ['pointerup', { x: 128, y: 20 }],
    ] as const) {
      ok(target, { type: 'input', event: { kind, point, modifiers: none } });
    }
    expect(documentOf(target).nodes.i1!.frame).toEqual({ x: 100, y: 0, width: 100, height: 80 });
  });
});

describe('M7 section 1.2: a symbol is an alignment target as a frame (U3 review S2)', () => {
  it('aligns a single child of a top-level symbol to the symbol', () => {
    const target = editorOf();
    ok(target, { type: 'alignNodes', ids: ['s1-g'], edge: 'left' });
    expect(documentOf(target).nodes['s1-g']!.frame).toEqual({ x: 0, y: 10, width: 40, height: 30 });
    ok(target, { type: 'alignNodes', ids: ['s1-g'], edge: 'bottom' });
    expect(documentOf(target).nodes['s1-g']!.frame).toEqual({ x: 0, y: 50, width: 40, height: 30 });
    // The instances follow; none of them changes.
    expect(documentOf(target).nodes.i1).toEqual(symbols().nodes.i1);
  });
});
