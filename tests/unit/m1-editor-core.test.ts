import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseDocument,
  serializeDocument,
  type DocumentV2,
  type Frame,
  type NodeV2,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  DEFAULT_PATH_STROKE,
  DEFAULT_RECTANGLE_FILL,
  createCounterIdSource,
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type EditorEvent,
  type Extension,
} from '../../packages/editor-core/src/index.js';
// Source imports: the gesture API, the draft and the resize functions are package-internal.
import { Draft } from '../../packages/editor-core/src/draft.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import {
  approximateSize,
  mapNodeInPageSpace,
  resizeInOwnAxes,
  scaleAbout,
} from '../../packages/editor-core/src/resize.js';
import { RecordingRenderer } from '../support/p5-recording-renderer.js';

// MVP M1-U2 (M1 contract, sections 2.1, 3, 4 and the selection rule of section 6): pages,
// creation with placement, placement edits, group refit, grouping and reparenting, clip and
// tree depth, and the resize rules. M1-A01 (editor half) and M1-A03 to M1-A08.

const root = path.resolve(import.meta.dirname, '../..');
const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const none = { shift: false, alt: false, meta: false, ctrl: false };

function editor(document?: unknown, extensions: readonly Extension[] = [starExtension]): Editor {
  return createEditor({ ids: createCounterIdSource('n'), document, extensions });
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function text(target: Editor): string {
  return serializeDocument(target.query({ type: 'document' }));
}

function documentOf(target: Editor): DocumentV2 {
  return target.query({ type: 'document' });
}

function nodeOf(target: Editor, id: string): NodeV2 {
  const node = target.query({ type: 'node', id });
  if (node === null) throw new Error(`no node ${id}`);
  return node;
}

function events(target: Editor): EditorEvent[] {
  const seen: EditorEvent[] = [];
  target.subscribe((event) => seen.push(event));
  return seen;
}

/** Everything a failed command must leave unchanged. */
function state(target: Editor) {
  const snapshot = target.getSnapshot();
  return {
    text: text(target),
    revision: snapshot.revision,
    history: snapshot.history,
    selection: snapshot.selection,
    activePage: snapshot.activePage,
  };
}

function expectFailure(target: Editor, command: Command, code: string, at?: string) {
  const before = state(target);
  const seen = events(target);
  const result = target.execute(command);
  expect(result.ok).toBe(false);
  expect(!result.ok && result.code).toBe(code);
  if (at !== undefined) expect(!result.ok && result.path).toBe(at);
  expect(state(target)).toEqual(before);
  expect(seen).toEqual([]);
}

// Inline v2 documents.

type Loose = Record<string, unknown> & { id: string };

function base(id: string, parent: string, frame: Frame, rotation = 0) {
  return { id, name: id, parent, frame, rotation, constraints: START, opacity: 1, visible: true };
}

function rect(id: string, parent: string, frame: Frame, rotation = 0, extra: object = {}): Loose {
  return {
    ...base(id, parent, frame, rotation),
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: black,
    stroke: null,
    ...extra,
  };
}

function pathNode(id: string, parent: string, frame: Frame, rotation = 0): Loose {
  return {
    ...base(id, parent, frame, rotation),
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

function lineNode(id: string, parent: string, frame: Frame, rotation = 0): Loose {
  return {
    ...base(id, parent, frame, rotation),
    type: 'line',
    points: [0, 0, 1, 1],
    stroke: DEFAULT_PATH_STROKE,
    startArrow: 'none',
    endArrow: 'triangle',
  };
}

function container(
  type: 'group' | 'maskGroup' | 'frame',
  id: string,
  parent: string,
  children: string[],
  frame: Frame,
  rotation = 0,
): Loose {
  const node: Loose = { ...base(id, parent, frame, rotation), type, children };
  return type === 'frame' ? { ...node, fill: null, stroke: null } : node;
}

function doc(pages: [string, string[]][], nodes: Loose[]) {
  return {
    schemaVersion: 2,
    id: 'doc',
    pages: pages.map(([id, children]) => ({ id, name: id, children })),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });

// An independent page-placement oracle: the chain of section 5 transforms.

type M = [number, number, number, number, number, number];

function local(node: NodeV2): M {
  const { x, y, width: w, height: h } = node.frame;
  const t = node.rotation;
  if (t === 0) return [1, 0, 0, 1, x, y];
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [
    c,
    s,
    -s,
    c,
    x + w / 2 - (w / 2) * c + (h / 2) * s,
    y + h / 2 - (w / 2) * s - (h / 2) * c,
  ];
}

function mul(m: M, n: M): M {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function pageMatrix(document: DocumentV2, id: string): { m: M; rotation: number } {
  const chain: NodeV2[] = [];
  for (let node = document.nodes[id]; node !== undefined; node = document.nodes[node.parent]) {
    chain.unshift(node);
  }
  let m: M = [1, 0, 0, 1, 0, 0];
  let rotation = 0;
  for (const node of chain) {
    m = mul(m, local(node));
    rotation += node.rotation;
  }
  return { m, rotation };
}

function at(m: M, x: number, y: number) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** Page centre, page rotation (normalized), size and page points of a path or line. */
function placement(document: DocumentV2, id: string) {
  const node = document.nodes[id]!;
  const { m, rotation } = pageMatrix(document, id);
  const unit =
    node.type === 'path' ? node.path.points : node.type === 'line' ? node.points : ([] as number[]);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < unit.length; i += 2) {
    points.push(at(m, unit[i]! * node.frame.width, unit[i + 1]! * node.frame.height));
  }
  const turn = rotation - 2 * Math.PI * Math.round(rotation / (2 * Math.PI));
  return {
    centre: at(m, node.frame.width / 2, node.frame.height / 2),
    rotation: turn,
    width: node.frame.width,
    height: node.frame.height,
    points,
  };
}

function near(actual: number, expected: number) {
  const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);
}

function angleNear(actual: number, expected: number) {
  let d = actual - expected;
  d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
  expect(Math.abs(d), `${actual} vs ${expected}`).toBeLessThanOrEqual(1e-12);
}

/** M1-A05: every listed node keeps its page placement within the contract's tolerance. */
function expectSamePlacement(before: DocumentV2, after: DocumentV2, ids: readonly string[]) {
  for (const id of ids) {
    const a = placement(before, id);
    const b = placement(after, id);
    near(b.centre.x, a.centre.x);
    near(b.centre.y, a.centre.y);
    angleNear(b.rotation, a.rotation);
    expect(b.width).toBe(a.width);
    expect(b.height).toBe(a.height);
    a.points.forEach((point, index) => {
      near(b.points[index]!.x, point.x);
      near(b.points[index]!.y, point.y);
    });
  }
}

/** Undo gives the byte-identical text before the step, redo the one after. */
function expectUndoRedo(target: Editor, before: string) {
  const after = text(target);
  ok(target, { type: 'undo' });
  expect(text(target)).toBe(before);
  ok(target, { type: 'redo' });
  expect(text(target)).toBe(after);
}

describe('M1-A01 editor half: a migrated ext.star node nested in a group and a frame', () => {
  it('migrates, groups, frames, round-trips and re-runs validate on load while nested', async () => {
    const v1 = JSON.parse(
      await readFile(path.join(root, 'tests/fixtures/p5-model/ext-star.json'), 'utf8'),
    ) as unknown;
    const target = editor(v1);
    expect(documentOf(target).schemaVersion).toBe(2);
    const [group] = ok(target, { type: 'groupNodes', ids: ['n2'], kind: 'group' });
    const [frame] = ok(target, {
      type: 'createFrame',
      frame: f(20, 20, 160, 160),
      fill: null,
    });
    ok(target, { type: 'moveNodes', ids: [group!], parent: frame!, index: 0 });
    const document = documentOf(target);
    expect(document.nodes.n2!.parent).toBe(group);
    expect(document.nodes[group!]!.parent).toBe(frame);
    // The star keeps its page frame: (50, 50) on the page, (30, 30) inside the frame.
    expect(document.nodes[group!]!.frame).toEqual(f(30, 30, 100, 100));
    expect(document.nodes.n2!.frame).toEqual(f(0, 0, 100, 100));

    const saved = text(target);
    const parsed = parseDocument(saved);
    expect(parsed.ok && serializeDocument(parsed.document)).toBe(saved);
    expect(parsed.ok && parsed.document).toEqual(document);

    const seen: unknown[] = [];
    const counting: Extension = {
      id: 'ext.star',
      nodeTypes: [
        {
          ...starExtension.nodeTypes![0]!,
          validate: (data) => {
            seen.push(data);
            return starExtension.nodeTypes![0]!.validate(data);
          },
        },
      ],
    };
    const reloaded = editor(JSON.parse(saved), [counting]);
    expect(text(reloaded)).toBe(saved);
    expect(seen).toEqual([{ innerRatio: 0.5, points: 5 }]);

    const broken = JSON.parse(saved) as { nodes: { n2: { data: unknown } } };
    broken.nodes.n2.data = { points: 2, innerRatio: 0.5 };
    expect(() => editor(broken)).toThrow('document.invalid-custom-data at /nodes/n2/data');
    expect(reloaded.execute({ type: 'loadDocument', document: broken })).toEqual({
      ok: false,
      code: 'document.invalid-custom-data',
      path: '/nodes/n2/data',
    });
    expect(() => editor(JSON.parse(saved), [])).toThrow(
      'document.unknown-custom-type at /nodes/n2/customType',
    );
  });

  it('loads the containers fixture and checks its nested star', async () => {
    const text = await readFile(path.join(root, 'tests/fixtures/m1-model/containers.json'), 'utf8');
    const target = editor(JSON.parse(text));
    expect(serializeDocument(documentOf(target))).toBe(text);
    expect(target.query({ type: 'activePage' })).toBe('page-1');
    expect(target.query({ type: 'pages' }).map((page) => page.id)).toEqual(['page-1', 'page-2']);
  });
});

describe('M1-A03 pages and the active page', () => {
  it('adds, renames, moves and removes pages, each as one transaction', () => {
    const target = editor();
    const seen = events(target);
    const texts = [text(target)];
    expect(ok(target, { type: 'addPage' })).toEqual(['n3']);
    texts.push(text(target));
    expect(ok(target, { type: 'addPage', name: 'Cover', index: 0 })).toEqual(['n4']);
    texts.push(text(target));
    ok(target, { type: 'renamePage', id: 'n3', name: 'Third' });
    texts.push(text(target));
    ok(target, { type: 'movePage', id: 'n4', index: 2 });
    texts.push(text(target));
    expect(target.query({ type: 'pages' })).toEqual([
      { id: 'n2', name: 'Page 1', children: [] },
      { id: 'n3', name: 'Third', children: [] },
      { id: 'n4', name: 'Cover', children: [] },
    ]);
    // Adding a page does not change the active page.
    expect(target.query({ type: 'activePage' })).toBe('n2');
    ok(target, { type: 'removePage', id: 'n3' });
    texts.push(text(target));
    expect(documentOf(target).pages.map((page) => page.id)).toEqual(['n2', 'n4']);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 5, redoDepth: 0 });
    expect(seen.map((event) => event.type === 'document' && event.cause)).toEqual(
      Array<string>(5).fill('command'),
    );
    for (let i = texts.length - 2; i >= 0; i -= 1) {
      ok(target, { type: 'undo' });
      expect(text(target)).toBe(texts[i]);
    }
    for (let i = 1; i < texts.length; i += 1) {
      ok(target, { type: 'redo' });
      expect(text(target)).toBe(texts[i]);
    }
  });

  it('names a new page "Page N" after the new page count', () => {
    const target = editor();
    ok(target, { type: 'addPage' });
    ok(target, { type: 'addPage' });
    ok(target, { type: 'removePage', id: 'n3' });
    ok(target, { type: 'addPage', index: 1 });
    expect(documentOf(target).pages.map((page) => page.name)).toEqual([
      'Page 1',
      'Page 3',
      'Page 3',
    ]);
  });

  it('deletes the nodes of a removed page', () => {
    const target = editor();
    const [page] = ok(target, { type: 'addPage' });
    ok(target, { type: 'setActivePage', id: page! });
    const [a] = ok(target, { type: 'createRectangle', frame: f(0, 0, 1, 1) });
    const [g] = ok(target, { type: 'groupNodes', ids: [a!], kind: 'group' });
    ok(target, { type: 'setActivePage', id: 'n2' });
    const seen = events(target);
    ok(target, { type: 'removePage', id: page! });
    expect(documentOf(target).nodes).toEqual({});
    expect(seen[0]).toEqual({ type: 'document', cause: 'command', revision: 4, touched: [a, g] });
  });

  it.each<[string, Command, string]>([
    ['removing the only page', { type: 'removePage', id: 'n2' }, 'editor.last-page'],
    ['removing an unknown page', { type: 'removePage', id: 'zz' }, 'editor.unknown-page'],
    [
      'renaming an unknown page',
      { type: 'renamePage', id: 'zz', name: 'x' },
      'editor.unknown-page',
    ],
    ['moving an unknown page', { type: 'movePage', id: 'zz', index: 0 }, 'editor.unknown-page'],
    ['moving out of range', { type: 'movePage', id: 'n2', index: 1 }, 'editor.invalid-index'],
    ['adding out of range', { type: 'addPage', index: 2 }, 'editor.invalid-index'],
    ['adding at a fractional index', { type: 'addPage', index: 0.5 }, 'editor.invalid-index'],
    ['a non-string name', { type: 'addPage', name: 3 } as never, 'editor.invalid-command'],
    ['activating an unknown page', { type: 'setActivePage', id: 'zz' }, 'editor.unknown-page'],
    ['activating a node', { type: 'setActivePage', id: 'n1' }, 'editor.unknown-page'],
  ])('%s fails without change', (_label, command, code) => {
    const target = editor();
    expectFailure(target, command, code);
  });

  it('switches the active page: selection cleared, tool reset, session event, no history', () => {
    const target = editor();
    const [a] = ok(target, { type: 'createRectangle', frame: f(0, 0, 10, 10) });
    const [page] = ok(target, { type: 'addPage' });
    ok(target, { type: 'setSelection', ids: [a!] });
    ok(target, { type: 'setTool', tool: 'path' });
    ok(target, {
      type: 'input',
      event: { kind: 'pointerdown', point: { x: 1, y: 1 }, modifiers: none },
    });
    ok(target, {
      type: 'input',
      event: { kind: 'pointerup', point: { x: 1, y: 1 }, modifiers: none },
    });
    expect(target.query({ type: 'overlay' })).not.toBeNull();
    const history = target.query({ type: 'history' });
    const revision = target.query({ type: 'revision' });
    const seen = events(target);
    ok(target, { type: 'setActivePage', id: page! });
    expect(target.query({ type: 'activePage' })).toBe(page);
    expect(target.getSnapshot().activePage).toBe(page);
    expect(target.query({ type: 'selection' })).toEqual([]);
    expect(target.query({ type: 'tool' })).toBe('path');
    expect(target.query({ type: 'overlay' })).toBeNull();
    expect(target.query({ type: 'history' })).toEqual(history);
    expect(target.query({ type: 'revision' })).toBe(revision);
    expect(seen).toEqual([
      { type: 'session', field: 'activePage' },
      { type: 'session', field: 'selection' },
      { type: 'session', field: 'overlay' },
    ]);
    // The same page again is a no-op.
    const quiet = events(target);
    ok(target, { type: 'setActivePage', id: page! });
    expect(quiet).toEqual([]);
    // Creation without a parent uses the active page's root.
    const [b] = ok(target, { type: 'createRectangle', frame: f(0, 0, 10, 10) });
    expect(nodeOf(target, b!).parent).toBe(page);
  });

  it('cancels an active gesture first', () => {
    const target = editor();
    const [a] = ok(target, { type: 'createRectangle', frame: f(0, 0, 10, 10) });
    const [page] = ok(target, { type: 'addPage' });
    const { gesture } = internalsOf(target);
    gesture.begin();
    gesture.update({ type: 'setFrames', frames: [{ id: a!, frame: f(5, 5, 10, 10) }] });
    ok(target, { type: 'setActivePage', id: page! });
    expect(gesture.active).toBe(false);
    expect(nodeOf(target, a!).frame).toEqual(f(0, 0, 10, 10));
  });

  it('falls back to the page at the removed index, else the last one', () => {
    const target = editor();
    const [p2] = ok(target, { type: 'addPage' });
    const [p3] = ok(target, { type: 'addPage' });
    ok(target, { type: 'setActivePage', id: p2! });
    const seen = events(target);
    ok(target, { type: 'removePage', id: p2! });
    expect(target.query({ type: 'activePage' })).toBe(p3);
    expect(seen.map((event) => (event.type === 'session' ? event.field : event.type))).toEqual([
      'document',
      'activePage',
    ]);
    ok(target, { type: 'removePage', id: p3! });
    expect(target.query({ type: 'activePage' })).toBe('n2');
    // Undoing the removal keeps the active page; undoing the add of the active page falls back.
    ok(target, { type: 'undo' });
    ok(target, { type: 'setActivePage', id: p3! });
    ok(target, { type: 'undo' });
    ok(target, { type: 'undo' });
    expect(documentOf(target).pages.map((page) => page.id)).toEqual(['n2', p2]);
    expect(target.query({ type: 'activePage' })).toBe(p2);
    // A load activates the first page.
    ok(target, { type: 'loadDocument', document: JSON.parse(text(target)) });
    expect(target.query({ type: 'activePage' })).toBe('n2');
  });

  it('accepts a selection of active-page nodes at any depth, ancestors winning', () => {
    const target = editor();
    const [a] = ok(target, { type: 'createRectangle', frame: f(0, 0, 10, 10) });
    const [b] = ok(target, { type: 'createRectangle', frame: f(20, 0, 10, 10) });
    const [g] = ok(target, { type: 'groupNodes', ids: [a!], kind: 'group' });
    ok(target, { type: 'setSelection', ids: [a!] });
    expect(target.query({ type: 'selection' })).toEqual([a]);
    ok(target, { type: 'setSelection', ids: [a!, b!, g!] });
    expect(target.query({ type: 'selection' })).toEqual([b, g]);
    const [page] = ok(target, { type: 'addPage' });
    ok(target, { type: 'setActivePage', id: page! });
    expectFailure(target, { type: 'setSelection', ids: [b!] }, 'editor.unknown-node');
    // Moving a selected node under another selected node normalizes the selection.
    ok(target, { type: 'setActivePage', id: 'n2' });
    ok(target, { type: 'setSelection', ids: [b!, g!] });
    ok(target, { type: 'moveNodes', ids: [b!], parent: g!, index: 0 });
    expect(target.query({ type: 'selection' })).toEqual([g]);
  });

  it('commands may name nodes on another page', () => {
    const target = editor();
    const [a] = ok(target, { type: 'createRectangle', frame: f(0, 0, 10, 10) });
    const [page] = ok(target, { type: 'addPage' });
    ok(target, { type: 'setActivePage', id: page! });
    ok(target, { type: 'setNodeProps', id: a!, props: { name: 'Far' } });
    expect(nodeOf(target, a!).name).toBe('Far');
  });

  it('sends a snapshot under the new page identity on a page switch', () => {
    const target = editor();
    ok(target, { type: 'createRectangle', frame: f(0, 0, 10, 10) });
    const [page] = ok(target, { type: 'addPage' });
    const renderer = new RecordingRenderer();
    target.attachRenderer(renderer);
    ok(target, { type: 'setActivePage', id: page! });
    const last = renderer.calls.filter((call) => call.method !== 'setCamera').at(-1)!;
    expect(last.method).toBe('replaceSnapshot');
    if (last.method !== 'replaceSnapshot') return;
    expect(last.input.identity).toEqual({ documentId: 'n1', pageId: page });
    expect(last.input.rootOrder).toEqual([]);
    ok(target, { type: 'createRectangle', frame: f(5, 5, 10, 10) });
    expect(renderer.mirror.readRetainedScene()!.rootOrder).toHaveLength(1);
  });
});

describe('M1-A04 creation commands', () => {
  it('creates every node type with the literal expected document and defaults', () => {
    const target = editor();
    ok(target, { type: 'createEllipse', frame: f(10, 20, 30, 40) });
    ok(target, { type: 'createLine', start: { x: 40, y: 20 }, end: { x: 10, y: 60 } });
    ok(target, { type: 'createFrame', frame: f(100, 100, 200, 100) });
    ok(target, {
      type: 'createRectangle',
      frame: f(120, 130, 10, 20),
      cornerRadii: [1, 2, 3, 4],
      rotation: 0.5,
      parent: 'n5',
    });
    ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [110, 110, 150, 110, 150, 190],
      parent: 'n5',
      index: 0,
    });
    ok(target, { type: 'createCustomNode', customType: 'ext.star', frame: f(0, 300, 50, 50) });
    ok(target, {
      type: 'createLine',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      startArrow: 'line',
      endArrow: 'triangle',
      stroke: null,
      name: 'Arrow',
    });
    const expected: DocumentV2 = {
      schemaVersion: 2,
      id: 'n1',
      pages: [{ id: 'n2', name: 'Page 1', children: ['n3', 'n4', 'n5', 'n8', 'n9'] }],
      nodes: {
        n3: {
          ...base('n3', 'n2', f(10, 20, 30, 40)),
          name: 'Ellipse',
          type: 'ellipse',
          fill: DEFAULT_RECTANGLE_FILL,
          stroke: null,
        },
        n4: {
          ...base('n4', 'n2', f(10, 20, 30, 40)),
          name: 'Line',
          type: 'line',
          points: [1, 0, 0, 1],
          stroke: DEFAULT_PATH_STROKE,
          startArrow: 'none',
          endArrow: 'none',
        },
        n5: {
          ...base('n5', 'n2', f(100, 100, 200, 100)),
          name: 'Frame',
          type: 'frame',
          children: ['n7', 'n6'],
          fill: DEFAULT_FRAME_FILL,
          stroke: null,
        },
        n6: {
          ...base('n6', 'n5', f(20, 30, 10, 20), 0.5),
          name: 'Rectangle',
          type: 'rectangle',
          cornerRadii: [1, 2, 3, 4],
          fill: DEFAULT_RECTANGLE_FILL,
          stroke: null,
        },
        n7: {
          ...base('n7', 'n5', f(10, 10, 40, 80)),
          name: 'Path',
          type: 'path',
          path: {
            verbs: ['move', 'line', 'line', 'close'],
            points: [0, 0, 1, 0, 1, 1],
            fillRule: 'nonzero',
          },
          fill: null,
          stroke: DEFAULT_PATH_STROKE,
        },
        n8: {
          ...base('n8', 'n2', f(0, 300, 50, 50)),
          name: 'ext.star',
          type: 'custom',
          customType: 'ext.star',
          data: { points: 5, innerRatio: 0.5 },
          fill: null,
          stroke: DEFAULT_PATH_STROKE,
        },
        n9: {
          ...base('n9', 'n2', f(0, 0, 10, 0)),
          name: 'Arrow',
          type: 'line',
          points: [0, 0, 1, 0],
          stroke: null,
          startArrow: 'line',
          endArrow: 'triangle',
        },
      },
    };
    expect(documentOf(target)).toEqual(expected);
    expect(DEFAULT_FRAME_FILL).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  it('maps page-space input into a rotated, nested parent', () => {
    const target = editor();
    const [outer] = ok(target, {
      type: 'createFrame',
      frame: f(100, 50, 300, 200),
      rotation: 0.4,
    });
    const [inner] = ok(target, {
      type: 'createFrame',
      frame: f(150, 80, 120, 90),
      rotation: -1.1,
      parent: outer!,
    });
    const [r] = ok(target, {
      type: 'createRectangle',
      frame: f(170, 100, 30, 20),
      rotation: 0.25,
      parent: inner!,
    });
    const points = [160, 90, 200, 95, 190, 140];
    const [p] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line'],
      points,
      rotation: 0.3,
      parent: inner!,
    });
    const [l] = ok(target, {
      type: 'createLine',
      start: { x: 155, y: 85 },
      end: { x: 210, y: 150 },
      parent: inner!,
    });
    const document = documentOf(target);
    // Stored rotations are the page rotation minus the parent chain's (0.4 − 1.5 = −1.1).
    near(document.nodes[inner!]!.rotation, -1.5);
    near(document.nodes[r!]!.rotation, 0.25 + 1.1);
    // Page placement equals the requested one.
    const rp = placement(document, r!);
    near(rp.centre.x, 185);
    near(rp.centre.y, 110);
    angleNear(rp.rotation, 0.25);
    expect([rp.width, rp.height]).toEqual([30, 20]);
    const pp = placement(document, p!);
    angleNear(pp.rotation, 0.3);
    pp.points.forEach((point, index) => {
      near(point.x, points[index * 2]!);
      near(point.y, points[index * 2 + 1]!);
    });
    const lp = placement(document, l!);
    angleNear(lp.rotation, 0);
    near(lp.points[0]!.x, 155);
    near(lp.points[0]!.y, 85);
    near(lp.points[1]!.x, 210);
    near(lp.points[1]!.y, 150);
  });

  it('creates into a group, which refits, and at an index', () => {
    const target = editor();
    const [a] = ok(target, { type: 'createRectangle', frame: f(0, 0, 10, 10) });
    const [g] = ok(target, { type: 'groupNodes', ids: [a!], kind: 'group' });
    const [star] = ok(target, {
      type: 'runCommand',
      id: 'ext.star.create',
      args: { frame: f(20, 0, 10, 10) },
    });
    expect(nodeOf(target, star!).parent).toBe('n2');
    const before = text(target);
    const [c] = ok(target, {
      type: 'createCustomNode',
      customType: 'ext.star',
      frame: f(-10, 5, 10, 10),
      parent: g!,
      index: 0,
    });
    expect(nodeOf(target, g!)).toMatchObject({ frame: f(-10, 0, 20, 15), children: [c, a] });
    expect(nodeOf(target, a!).frame).toEqual(f(10, 0, 10, 10));
    expect(nodeOf(target, c!).frame).toEqual(f(0, 5, 10, 10));
    expectUndoRedo(target, before);
  });

  it.each<[string, (ids: Record<string, string>) => Command, string, string | undefined]>([
    [
      'an unknown parent',
      () => ({ type: 'createRectangle', frame: f(0, 0, 1, 1), parent: 'zz' }),
      'editor.unknown-node',
      undefined,
    ],
    [
      'a leaf parent',
      (ids) => ({ type: 'createRectangle', frame: f(0, 0, 1, 1), parent: ids.r! }),
      'editor.invalid-parent',
      '/parent',
    ],
    [
      'an index out of range',
      (ids) => ({ type: 'createEllipse', frame: f(0, 0, 1, 1), parent: ids.frame!, index: 1 }),
      'editor.invalid-index',
      undefined,
    ],
    [
      'an index before an unknown parent',
      () => ({ type: 'createEllipse', frame: f(0, 0, 1, 1), parent: 'zz', index: 9 }),
      'editor.unknown-node',
      undefined,
    ],
    [
      'a non-finite rotation',
      () => ({ type: 'createEllipse', frame: f(0, 0, 1, 1), rotation: Infinity }),
      'document.invalid-field',
      '/rotation',
    ],
    [
      'an invalid field before an invalid parent',
      (ids) => ({ type: 'createRectangle', frame: f(0, 0, -1, 1), parent: ids.r! }),
      'document.invalid-field',
      '/frame/width',
    ],
    [
      'a negative corner radius',
      () => ({ type: 'createRectangle', frame: f(0, 0, 1, 1), cornerRadii: [0, -1, 0, 0] }),
      'document.invalid-field',
      '/cornerRadii/1',
    ],
    [
      'an unknown arrow',
      () => ({
        type: 'createLine',
        start: { x: 0, y: 0 },
        end: { x: 1, y: 1 },
        endArrow: 'circle' as never,
      }),
      'document.invalid-field',
      '/endArrow',
    ],
    [
      'a line without an end',
      () => ({ type: 'createLine', start: { x: 0, y: 0 } }) as never,
      'editor.invalid-command',
      '/end',
    ],
    [
      'a non-path below a mask source',
      (ids) => ({ type: 'createRectangle', frame: f(0, 0, 1, 1), parent: ids.mask!, index: 0 }),
      'editor.invalid-mask-source',
      '/index',
    ],
  ])('rejects %s', (_label, command, code, at) => {
    const target = editor();
    const [r] = ok(target, { type: 'createRectangle', frame: f(0, 0, 1, 1) });
    const [frame] = ok(target, { type: 'createFrame', frame: f(0, 0, 10, 10) });
    const [s] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 5, 0, 5, 5],
    });
    const [mask] = ok(target, { type: 'groupNodes', ids: [s!], kind: 'maskGroup' });
    expectFailure(target, command({ r: r!, frame: frame!, mask: mask! }), code, at);
  });

  it('creates a path at index 0 of a mask group as its new source', () => {
    const target = editor();
    const [s] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 5, 0, 5, 5],
    });
    const [mask] = ok(target, { type: 'groupNodes', ids: [s!], kind: 'maskGroup' });
    const [t] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 5, 0, 5, 5],
      parent: mask!,
      index: 0,
    });
    expect(nodeOf(target, mask!)).toMatchObject({ name: 'Mask group', children: [t, s] });
  });
});

/** M1-A05 fixture: rotated and nested containers, one node near 10^6 page units. */
function nested() {
  return doc(
    [['p', ['F', 'B']]],
    [
      container('frame', 'F', 'p', ['G', 'R2'], f(100, 200, 400, 300), 0.3),
      container('group', 'G', 'F', ['R', 'P', 'L'], f(50, 40, 120, 90), -0.7),
      rect('R', 'G', f(10, 5, 40, 30), 0.2),
      pathNode('P', 'G', f(60, 50, 60, 40), 1.1),
      lineNode('L', 'G', f(0, 60, 30, 20), -2.4),
      rect('R2', 'F', f(300, 200, 50, 50)),
      container('group', 'H', 'F', ['K'], f(-30, -20, 30, 30), 2.9),
      rect('K', 'H', f(0, 0, 30, 30), -0.5),
      rect('B', 'p', f(999000, -999000, 10, 10), 2.5),
    ],
  );
}

function nestedDocument() {
  const value = nested();
  // H is a third child of F, under G and R2.
  (value.nodes.F!.children as string[]).push('H');
  return value;
}

describe('M1-A05 grouping and reparenting keep page placement', () => {
  const all = ['F', 'G', 'R', 'P', 'L', 'R2', 'H', 'K', 'B'];

  it('groupNodes inside a rotated group', () => {
    const target = editor(nestedDocument());
    const before = documentOf(target);
    const beforeText = text(target);
    const [n] = ok(target, { type: 'groupNodes', ids: ['L', 'R'], kind: 'group' });
    const after = documentOf(target);
    expectSamePlacement(before, after, ['R', 'P', 'L', 'K', 'B']);
    // The container takes the topmost member's place; members keep their relative order.
    expect(after.nodes.G).toMatchObject({ children: ['P', n] });
    expect(after.nodes[n!]).toMatchObject({
      type: 'group',
      name: 'Group',
      rotation: 0,
      constraints: START,
      children: ['R', 'L'],
    });
    expectUndoRedo(target, beforeText);
  });

  it('ungroupNodes composes the container into its children', () => {
    const target = editor(nestedDocument());
    const before = documentOf(target);
    const beforeText = text(target);
    expect(ok(target, { type: 'ungroupNodes', id: 'G' })).toEqual([]);
    const after = documentOf(target);
    expect(after.nodes.G).toBeUndefined();
    expect(after.nodes.F).toMatchObject({ children: ['R', 'P', 'L', 'R2', 'H'] });
    expectSamePlacement(before, after, ['R', 'P', 'L', 'K']);
    expectUndoRedo(target, beforeText);
  });

  it('moveNodes into and out of rotated containers, with pre-order kept', () => {
    const target = editor(nestedDocument());
    const before = documentOf(target);
    const beforeText = text(target);
    // Listed in reverse; K's group H stays because R2 and K go, the descendant R of G is ignored.
    ok(target, { type: 'moveNodes', ids: ['B', 'K', 'P', 'R2'], parent: 'G', index: 1 });
    const after = documentOf(target);
    expect(after.nodes.G).toMatchObject({ children: ['R', 'P', 'R2', 'K', 'B', 'L'] });
    // H was left empty and is deleted.
    expect(after.nodes.H).toBeUndefined();
    expectSamePlacement(before, after, ['R', 'P', 'L', 'R2', 'K', 'B']);
    expectUndoRedo(target, beforeText);

    ok(target, { type: 'moveNodes', ids: ['G'], parent: 'p', index: 0 });
    expectSamePlacement(before, documentOf(target), ['R', 'P', 'L', 'R2', 'K', 'B']);
    ok(target, { type: 'moveNodes', ids: ['F'], parent: 'p', index: 1 });
    expect(documentOf(target).pages[0]!.children).toEqual(['G', 'F']);
    for (const id of all.filter((id) => id !== 'H'))
      expect(documentOf(target).nodes[id]).toBeDefined();
  });

  it.each<[string, Command, string]>([
    [
      'into a descendant',
      { type: 'moveNodes', ids: ['G'], parent: 'R', index: 0 },
      'editor.invalid-parent',
    ],
    [
      'into itself',
      { type: 'moveNodes', ids: ['G'], parent: 'G', index: 0 },
      'editor.invalid-parent',
    ],
    [
      'into its own subtree',
      { type: 'moveNodes', ids: ['F'], parent: 'H', index: 0 },
      'editor.invalid-parent',
    ],
    [
      'into a leaf',
      { type: 'moveNodes', ids: ['B'], parent: 'R', index: 0 },
      'editor.invalid-parent',
    ],
    [
      'to another page',
      { type: 'moveNodes', ids: ['B'], parent: 'q', index: 0 },
      'editor.invalid-parent',
    ],
    [
      'out of range',
      { type: 'moveNodes', ids: ['B'], parent: 'G', index: 4 },
      'editor.invalid-index',
    ],
    [
      'to an unknown parent',
      { type: 'moveNodes', ids: ['B'], parent: 'zz', index: 9 },
      'editor.unknown-node',
    ],
    [
      'an unknown node',
      { type: 'moveNodes', ids: ['zz'], parent: 'G', index: 9 },
      'editor.unknown-node',
    ],
    ['nothing', { type: 'moveNodes', ids: [], parent: 'G', index: 0 }, 'editor.invalid-command'],
    [
      'a fractional index',
      { type: 'moveNodes', ids: ['B'], parent: 'G', index: 0.5 },
      'editor.invalid-index',
    ],
    [
      'different parents',
      { type: 'groupNodes', ids: ['R', 'R2'], kind: 'group' },
      'editor.not-siblings',
    ],
    ['an empty group', { type: 'groupNodes', ids: [], kind: 'group' }, 'editor.not-siblings'],
    [
      'an unknown kind',
      { type: 'groupNodes', ids: ['R'], kind: 'frame' } as never,
      'editor.invalid-command',
    ],
    [
      'an unknown member',
      { type: 'groupNodes', ids: ['R', 'zz'], kind: 'group' },
      'editor.unknown-node',
    ],
    ['ungrouping a frame', { type: 'ungroupNodes', id: 'F' }, 'editor.not-a-group'],
    ['ungrouping a leaf', { type: 'ungroupNodes', id: 'R' }, 'editor.not-a-group'],
    ['ungrouping a page', { type: 'ungroupNodes', id: 'p' }, 'editor.unknown-node'],
  ])('rejects %s', (_label, command, code) => {
    const value = nestedDocument();
    value.pages.push({ id: 'q', name: 'q', children: [] });
    expectFailure(editor(value), command, code);
  });

  it('keeps placement within 1e-9 near 10^6 page units', () => {
    const value = doc(
      [['p', ['a', 'b']]],
      [rect('a', 'p', f(999990, -999990, 7, 3), 1.3), rect('b', 'p', f(-999999, 999999, 1, 1), -2)],
    );
    const target = editor(value);
    const before = documentOf(target);
    const [g] = ok(target, { type: 'groupNodes', ids: ['a', 'b'], kind: 'group' });
    ok(target, {
      type: 'setFrames',
      frames: [{ id: g!, frame: nodeOf(target, g!).frame, rotation: 0.9 }],
    });
    ok(target, {
      type: 'setFrames',
      frames: [{ id: g!, frame: nodeOf(target, g!).frame, rotation: 0 }],
    });
    ok(target, { type: 'ungroupNodes', id: g! });
    expectSamePlacement(before, documentOf(target), ['a', 'b']);
  });
});

describe('M1-A06 group refit, empty groups and mask sources', () => {
  it('refits a rotated group with the section 4.2 formula, children unmoved on the page', () => {
    const value = doc(
      [['p', ['G']]],
      [
        container('group', 'G', 'p', ['A', 'B'], f(100, 50, 80, 40), 0.6),
        rect('A', 'G', f(0, 0, 80, 40)),
        rect('B', 'G', f(10, 10, 20, 10)),
      ],
    );
    const target = editor(value);
    const before = documentOf(target);
    ok(target, { type: 'setFrames', frames: [{ id: 'B', frame: f(-20, -10, 20, 10) }] });
    const after = documentOf(target);
    // b = (−20, −10, 100, 50); c = (40, 20), c' = (50, 25); p' = p + c − R·c + R·b + R·c' − c'.
    const cos = Math.cos(0.6);
    const sin = Math.sin(0.6);
    const R = (x: number, y: number) => ({ x: x * cos - y * sin, y: x * sin + y * cos });
    const Rc = R(40, 20);
    const Rb = R(-20, -10);
    const Rc2 = R(50, 25);
    near(after.nodes.G!.frame.x, 100 + 40 - Rc.x + Rb.x + Rc2.x - 50);
    near(after.nodes.G!.frame.y, 50 + 20 - Rc.y + Rb.y + Rc2.y - 25);
    expect([after.nodes.G!.frame.width, after.nodes.G!.frame.height]).toEqual([100, 50]);
    expect(after.nodes.A!.frame).toEqual(f(20, 10, 80, 40));
    expect(after.nodes.B!.frame).toEqual(f(0, 0, 20, 10));
    expectSamePlacement(before, after, ['A']);
    // B is where the command put it in the old group frame.
    const requested = placement(
      {
        ...before,
        nodes: { ...before.nodes, B: { ...before.nodes.B!, frame: f(-20, -10, 20, 10) } },
      },
      'B',
    );
    near(placement(after, 'B').centre.x, requested.centre.x);
    near(placement(after, 'B').centre.y, requested.centre.y);
  });

  it('refits an unrotated group exactly, innermost first', () => {
    const value = doc(
      [['p', ['G']]],
      [
        container('group', 'G', 'p', ['H', 'X'], f(10, 10, 50, 50)),
        container('group', 'H', 'G', ['Y'], f(0, 0, 10, 10)),
        rect('Y', 'H', f(0, 0, 10, 10)),
        rect('X', 'G', f(0, 0, 50, 50)),
      ],
    );
    const target = editor(value);
    const seen = events(target);
    ok(target, { type: 'setFrames', frames: [{ id: 'Y', frame: f(-5, -10, 10, 10) }] });
    const after = documentOf(target);
    // H refits to Y first ((-5, -10, 10, 10) in G), then G to H and X; both shifts are exact.
    expect(after.nodes.Y!.frame).toEqual(f(0, 0, 10, 10));
    expect(after.nodes.G!.frame).toEqual(f(5, 0, 55, 60));
    expect(after.nodes.H!.frame).toEqual(f(0, 0, 10, 10));
    expect(after.nodes.X!.frame).toEqual(f(5, 10, 50, 50));
    expect(seen[0]).toMatchObject({ touched: ['G', 'H', 'X', 'Y'] });
  });

  it('a gesture refits only at commit, as one undo step', () => {
    const value = doc(
      [['p', ['G']]],
      [
        container('group', 'G', 'p', ['X', 'Y'], f(0, 0, 30, 10)),
        rect('X', 'G', f(0, 0, 10, 10)),
        rect('Y', 'G', f(20, 0, 10, 10)),
      ],
    );
    const target = editor(value);
    const before = text(target);
    const { gesture } = internalsOf(target);
    gesture.begin();
    for (const x of [30, 40, 50]) {
      gesture.update({ type: 'setFrames', frames: [{ id: 'Y', frame: f(x, 0, 10, 10) }] });
      expect(nodeOf(target, 'G').frame).toEqual(f(0, 0, 30, 10));
    }
    gesture.commit();
    expect(nodeOf(target, 'G').frame).toEqual(f(0, 0, 60, 10));
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
    expectUndoRedo(target, before);
  });

  it('deletes groups left without children, cascading, and subtrees with their nodes', () => {
    const value = doc(
      [['p', ['G', 'Z']]],
      [
        container('group', 'G', 'p', ['H'], f(0, 0, 10, 10)),
        container('group', 'H', 'G', ['X'], f(0, 0, 10, 10)),
        rect('X', 'H', f(0, 0, 10, 10)),
        container('frame', 'Z', 'p', ['W'], f(0, 0, 10, 10)),
        container('group', 'W', 'Z', ['V'], f(0, 0, 10, 10)),
        rect('V', 'W', f(0, 0, 10, 10)),
      ],
    );
    const target = editor(value);
    const before = text(target);
    const seen = events(target);
    ok(target, { type: 'deleteNodes', ids: ['X'] });
    expect(Object.keys(documentOf(target).nodes).sort()).toEqual(['V', 'W', 'Z']);
    expect(seen[0]).toMatchObject({ touched: ['G', 'H', 'X'] });
    expectUndoRedo(target, before);
    // A frame left empty stays; a listed descendant goes with its listed ancestor.
    ok(target, { type: 'undo' });
    ok(target, { type: 'deleteNodes', ids: ['V', 'Z'] });
    expect(Object.keys(documentOf(target).nodes).sort()).toEqual(['G', 'H', 'X']);
    ok(target, { type: 'undo' });
    ok(target, { type: 'deleteNodes', ids: ['V'] });
    expect(nodeOf(target, 'Z')).toMatchObject({ children: [] });
    // moveNodes out of a group deletes it when it is left empty.
    ok(target, { type: 'moveNodes', ids: ['X'], parent: 'p', index: 0 });
    expect(documentOf(target).pages[0]!.children).toEqual(['X', 'Z']);
    expect(documentOf(target).nodes.G).toBeUndefined();
  });

  describe('mask sources', () => {
    function masked() {
      return editor(
        doc(
          [['p', ['M', 'Q']]],
          [
            container('maskGroup', 'M', 'p', ['S', 'R', 'T'], f(0, 0, 10, 10)),
            pathNode('S', 'M', f(0, 0, 10, 10)),
            rect('R', 'M', f(0, 0, 10, 10)),
            pathNode('T', 'M', f(0, 0, 10, 10)),
            pathNode('Q', 'p', f(0, 0, 10, 10)),
          ],
        ),
      );
    }

    it.each<[string, Command]>([
      ['deleting the source above a rectangle', { type: 'deleteNodes', ids: ['S'] }],
      ['moving the source away', { type: 'moveNodes', ids: ['S'], parent: 'p', index: 0 }],
      [
        'moving a rectangle below the source',
        { type: 'moveNodes', ids: ['R'], parent: 'M', index: 0 },
      ],
      ['grouping the source', { type: 'groupNodes', ids: ['S', 'R'], kind: 'group' }],
    ])('%s fails with editor.invalid-mask-source', (_label, command) => {
      expectFailure(masked(), command, 'editor.invalid-mask-source');
    });

    it('promotes the next path child to the source', () => {
      const target = masked();
      ok(target, { type: 'deleteNodes', ids: ['S', 'R'] });
      expect(nodeOf(target, 'M')).toMatchObject({ children: ['T'] });
      const other = masked();
      ok(other, { type: 'moveNodes', ids: ['Q'], parent: 'M', index: 0 });
      ok(other, { type: 'moveNodes', ids: ['S'], parent: 'p', index: 0 });
      expect(nodeOf(other, 'M')).toMatchObject({ children: ['Q', 'R', 'T'] });
    });

    it('needs a path as the bottom-most node of a new mask group', () => {
      const target = masked();
      expectFailure(
        target,
        { type: 'groupNodes', ids: ['R', 'T'], kind: 'maskGroup' },
        'editor.invalid-mask-source',
      );
      // Grouping S and T would leave R at the bottom of M, so M loses its source.
      expectFailure(
        target,
        { type: 'groupNodes', ids: ['T', 'S'], kind: 'maskGroup' },
        'editor.invalid-mask-source',
        '/nodes/M/children/0',
      );
      const loose = editor(
        doc(
          [['p', ['Q', 'Z']]],
          [pathNode('Q', 'p', f(0, 0, 10, 10)), rect('Z', 'p', f(5, 5, 10, 10))],
        ),
      );
      const [g] = ok(loose, { type: 'groupNodes', ids: ['Z', 'Q'], kind: 'maskGroup' });
      expect(nodeOf(loose, g!)).toMatchObject({
        type: 'maskGroup',
        name: 'Mask group',
        children: ['Q', 'Z'],
        frame: f(0, 0, 15, 15),
      });
      expect(documentOf(loose).pages[0]!.children).toEqual([g]);
    });
  });
});

/** `depth` nested containers of `type` on one page, each holding the next and `leaf` last. */
function chain(type: 'frame' | 'group', depth: number, leaf: boolean) {
  const nodes: Loose[] = [];
  let parent = 'p';
  for (let level = 0; level < depth; level += 1) {
    const id = `c${level}`;
    const children = level + 1 < depth ? [`c${level + 1}`] : leaf ? ['leaf'] : [];
    nodes.push(container(type, id, parent, children, f(0, 0, 10, 10)));
    parent = id;
  }
  if (leaf) nodes.push(rect('leaf', parent, f(0, 0, 10, 10)));
  const value = doc([['p', depth > 0 ? ['c0', 'r', 's'] : ['leaf', 'r', 's']]], nodes);
  value.nodes.r = rect('r', 'p', f(0, 0, 10, 10));
  value.nodes.s = pathNode('s', 'p', f(0, 0, 10, 10));
  // `s` sits below the chain in paint order, as the bottom-most member of a mask group.
  value.pages[0]!.children = depth > 0 ? ['s', 'c0', 'r'] : ['s', 'leaf', 'r'];
  return value;
}

describe('M1-A07 clip depth and tree depth', () => {
  it('32 nested frames succeed, the innermost empty and filled; a 33rd fails', () => {
    const target = editor();
    let parent: string | undefined;
    for (let level = 0; level < 32; level += 1) {
      [parent] = ok(target, {
        type: 'createFrame',
        frame: f(0, 0, 100, 100),
        ...(parent === undefined ? {} : { parent }),
      });
    }
    expect(nodeOf(target, parent!)).toMatchObject({ children: [], fill: DEFAULT_FRAME_FILL });
    expectFailure(
      target,
      { type: 'createFrame', frame: f(0, 0, 10, 10), parent: parent! },
      'editor.clip-depth',
      '/parent',
    );
    // A leaf inside the 32nd frame sits at clip depth 32, which is allowed.
    ok(target, { type: 'createRectangle', frame: f(0, 0, 10, 10), parent: parent! });
    // Moving a frame into the 32nd frame or wrapping the chain in a mask group fails.
    const [loose] = ok(target, { type: 'createFrame', frame: f(0, 0, 10, 10) });
    expectFailure(
      target,
      { type: 'moveNodes', ids: [loose!], parent: parent!, index: 0 },
      'editor.clip-depth',
    );
    const [source] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 5, 0, 5, 5],
      index: 0,
    });
    const outer = documentOf(target).pages[0]!.children[1]!;
    expectFailure(
      target,
      { type: 'groupNodes', ids: [source!, outer], kind: 'maskGroup' },
      'editor.clip-depth',
    );
    ok(target, { type: 'groupNodes', ids: [source!, outer], kind: 'group' });
  });

  it('32 nested mask groups succeed and a 33rd fails', () => {
    const target = editor();
    let [inner] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 5, 0, 5, 5],
    });
    for (let level = 0; level < 32; level += 1) {
      const [source] = ok(target, {
        type: 'createPath',
        verbs: ['move', 'line', 'line', 'close'],
        points: [0, 0, 5, 0, 5, 5],
        index: 0,
      });
      [inner] = ok(target, { type: 'groupNodes', ids: [source!, inner!], kind: 'maskGroup' });
    }
    const [source] = ok(target, {
      type: 'createPath',
      verbs: ['move', 'line', 'line', 'close'],
      points: [0, 0, 5, 0, 5, 5],
      index: 0,
    });
    expectFailure(
      target,
      { type: 'groupNodes', ids: [source!, inner!], kind: 'maskGroup' },
      'editor.clip-depth',
    );
  });

  it('loads 32 nested frames and rejects 33, loading nothing', () => {
    expect(() => editor(chain('frame', 32, true))).not.toThrow();
    expect(() => editor(chain('frame', 33, false))).toThrow(
      'editor.clip-depth at /nodes/c32/parent',
    );
    const target = editor(chain('frame', 32, false));
    expectFailure(
      target,
      { type: 'loadDocument', document: chain('frame', 33, true) },
      'editor.clip-depth',
      '/nodes/c32/parent',
    );
  });

  it('allows a tree depth of 256 and rejects 257 for create, move and group', () => {
    const target = editor(chain('group', 256, true));
    expect(nodeOf(target, 'leaf').parent).toBe('c255');
    expectFailure(
      target,
      { type: 'groupNodes', ids: ['leaf'], kind: 'group' },
      'document.invalid-field',
      '/nodes/leaf/parent',
    );
    const [deep] = ok(target, { type: 'createFrame', frame: f(0, 0, 10, 10), parent: 'c255' });
    expectFailure(
      target,
      { type: 'createRectangle', frame: f(0, 0, 1, 1), parent: deep! },
      'document.invalid-field',
      '/parent',
    );
    expectFailure(
      target,
      { type: 'moveNodes', ids: ['r'], parent: deep!, index: 0 },
      'document.invalid-field',
      '/nodes/r/parent',
    );
    ok(target, { type: 'moveNodes', ids: ['r'], parent: 'c255', index: 0 });
  });
});

describe('M1-A08 resize rules', () => {
  it('scales a rotated single node in its own axes about the opposite handle', () => {
    // The top-left handle stays put while the box doubles in width.
    expect(resizeInOwnAxes(f(10, 20, 100, 50), 0, 0, 0, 2, 1)).toEqual(f(10, 20, 200, 50));
    expect(resizeInOwnAxes(f(10, 20, 100, 50), 0, 1, 1, 0.5, 2)).toEqual(f(60, -30, 50, 100));
    const frame = f(0, 0, 100, 50);
    const turned = resizeInOwnAxes(frame, Math.PI / 2, 0, 0, 2, 1);
    near(turned.x, -50);
    near(turned.y, 50);
    expect([turned.width, turned.height]).toEqual([200, 50]);
    // Through setFrames, with the rotation kept.
    const target = editor(doc([['p', ['a']]], [rect('a', 'p', frame, Math.PI / 2)]));
    const before = documentOf(target);
    ok(target, { type: 'setFrames', frames: [{ id: 'a', frame: turned }] });
    const anchor = (document: DocumentV2) => at(pageMatrix(document, 'a').m, 0, 0);
    near(anchor(documentOf(target)).x, anchor(before).x);
    near(anchor(documentOf(target)).y, anchor(before).y);
    expect(nodeOf(target, 'a').rotation).toBe(Math.PI / 2);
  });

  it('follows the approximation with literal values', () => {
    expect(approximateSize(10, 20, 0, 2, 3)).toEqual({ width: 20, height: 60 });
    expect(approximateSize(10, 20, Math.PI, 2, 3)).toEqual({ width: 20, height: 60 });
    expect(approximateSize(10, 20, -Math.PI, 2, 3)).toEqual({ width: 20, height: 60 });
    expect(approximateSize(10, 20, Math.PI / 2, 2, 3)).toEqual({ width: 30, height: 40 });
    expect(approximateSize(10, 20, -Math.PI / 2, 2, 3)).toEqual({ width: 30, height: 40 });
    const size = approximateSize(10, 20, Math.PI / 6, 2, 1);
    expect(size.width).toBeCloseTo(10 * Math.sqrt(3.25), 12);
    expect(size.height).toBeCloseTo(20 * Math.sqrt(1.75), 12);
    // A multi-selection maps each node by the page-space box scale: centre exact, rotation kept.
    const value = doc([['p', ['a']]], [rect('a', 'p', f(30, 40, 10, 20), Math.PI / 6)]);
    const parsed = parseDocument(JSON.stringify(value));
    if (!parsed.ok) throw new Error(parsed.code);
    const draft = new Draft(parsed.document);
    mapNodeInPageSpace(draft, 'a', scaleAbout(2, 1, { x: 10, y: 0 }));
    const mapped = draft.node('a')!;
    expect(mapped.rotation).toBe(Math.PI / 6);
    near(mapped.frame.x + mapped.frame.width / 2, 10 + 2 * 25);
    near(mapped.frame.y + mapped.frame.height / 2, 50);
    near(mapped.frame.width, 10 * Math.sqrt(3.25));
    near(mapped.frame.height, 20 * Math.sqrt(1.75));
  });

  /** A group at the page origin, so its local space is page space. */
  function resizable() {
    return doc(
      [['p', ['G']]],
      [
        container('group', 'G', 'p', ['Z', 'R', 'Q', 'Q2', 'P', 'L', 'F', 'H'], f(0, 0, 100, 100)),
        rect('Z', 'G', f(0, 0, 100, 100)),
        rect('R', 'G', f(10, 10, 20, 20)),
        rect('Q', 'G', f(40, 40, 20, 10), Math.PI / 2),
        rect('Q2', 'G', f(40, 60, 20, 10), -Math.PI / 2),
        pathNode('P', 'G', f(60, 60, 20, 20), Math.PI / 4),
        lineNode('L', 'G', f(10, 70, 20, 10), 0.3),
        container('frame', 'F', 'G', ['C'], f(0, 50, 50, 50)),
        {
          ...rect('C', 'F', f(10, 10, 10, 10)),
          constraints: { horizontal: 'end', vertical: 'start' },
        },
        container('group', 'H', 'G', ['K'], f(60, 10, 20, 20), 0.4),
        rect('K', 'H', f(0, 0, 20, 20)),
      ],
    );
  }

  it('maps a group resize: exact cases, ±π/2 swaps, exact path and line skew, frames', () => {
    const target = editor(resizable());
    const before = documentOf(target);
    const beforeText = text(target);
    ok(target, { type: 'setFrames', frames: [{ id: 'G', frame: f(0, 0, 200, 100) }] });
    const after = documentOf(target);
    const nodes = after.nodes;
    // The bounds stay the box, so no refit shift: literal values.
    expect(nodes.G!.frame).toEqual(f(0, 0, 200, 100));
    expect(nodes.Z!.frame).toEqual(f(0, 0, 200, 100));
    expect(nodes.R!.frame).toEqual(f(20, 10, 40, 20));
    expect(nodes.Q!.frame).toEqual(f(90, 35, 20, 20));
    expect(nodes.Q2!.frame).toEqual(f(90, 55, 20, 20));
    expect([nodes.Q!.rotation, nodes.Q2!.rotation]).toEqual([Math.PI / 2, -Math.PI / 2]);
    // A frame maps like a leaf, then its children follow their constraints: C keeps its offset
    // from the right edge.
    expect(nodes.F!.frame).toEqual(f(0, 50, 100, 50));
    expect(nodes.C!.frame).toEqual(f(60, 10, 10, 10));
    // Paths and lines map their points through the full affine, rotation kept.
    for (const id of ['P', 'L']) {
      expect(nodes[id]!.rotation).toBe(before.nodes[id]!.rotation);
      const was = placement(before, id).points;
      placement(after, id).points.forEach((point, index) => {
        near(point.x, 2 * was[index]!.x);
        near(point.y, was[index]!.y);
      });
    }
    // A nested rotated group keeps its rotation; its child maps by the approximation at θ = 0.4.
    expect(nodes.H!.rotation).toBe(0.4);
    const k = placement(after, 'K');
    const kWas = placement(before, 'K');
    near(k.centre.x, 2 * kWas.centre.x);
    near(k.centre.y, kWas.centre.y);
    const expected = approximateSize(20, 20, 0.4, 2, 1);
    near(k.width, expected.width);
    near(k.height, expected.height);
    expectUndoRedo(target, beforeText);
  });

  it('does not scale a group axis whose old size is 0, and refits after', () => {
    const target = editor(
      doc(
        [['p', ['G']]],
        [container('group', 'G', 'p', ['a'], f(5, 0, 0, 20)), rect('a', 'G', f(0, 0, 0, 20))],
      ),
    );
    ok(target, { type: 'setFrames', frames: [{ id: 'G', frame: f(5, 0, 10, 40) }] });
    expect(nodeOf(target, 'a').frame).toEqual(f(0, 0, 0, 40));
    // The requested width cannot hold: the refit returns the group to its children's bounds.
    expect(nodeOf(target, 'G').frame).toEqual(f(5, 0, 0, 40));
  });

  it('applies each constraint mode on a frame resize', () => {
    const child = (id: string, h: string, v: string, frame = f(10, 20, 20, 10), rotation = 0) => ({
      ...rect(id, 'F', frame, rotation),
      constraints: { horizontal: h, vertical: v },
    });
    const target = editor(
      doc(
        [['p', ['F', 'F2']]],
        [
          container('frame', 'F', 'p', ['s', 'e', 'se', 'c', 'sc', 'rot'], f(0, 0, 100, 100)),
          child('s', 'start', 'start'),
          child('e', 'end', 'end'),
          child('se', 'startEnd', 'startEnd'),
          child('c', 'center', 'center'),
          child('sc', 'scale', 'scale'),
          child('rot', 'startEnd', 'start', f(40, 40, 20, 10), Math.PI / 2),
          container('frame', 'F2', 'p', ['z'], f(0, 0, 0, 100)),
          {
            ...rect('z', 'F2', f(0, 10, 0, 10)),
            constraints: { horizontal: 'scale', vertical: 'scale' },
          },
        ],
      ),
    );
    const before = text(target);
    ok(target, {
      type: 'setFrames',
      frames: [
        { id: 'F', frame: f(0, 0, 200, 50) },
        { id: 'F2', frame: f(0, 0, 50, 200) },
      ],
    });
    const nodes = documentOf(target).nodes;
    expect(nodes.s!.frame).toEqual(f(10, 20, 20, 10));
    expect(nodes.e!.frame).toEqual(f(110, -30, 20, 10));
    // startEnd: both offsets kept; the height clamps at 0.
    expect(nodes.se!.frame).toEqual(f(10, 20, 120, 0));
    expect(nodes.c!.frame).toEqual(f(60, -5, 20, 10));
    expect(nodes.sc!.frame).toEqual(f(20, 10, 40, 5));
    // A rotated stretched child follows the approximation (θ = π/2 swaps the scales).
    near(nodes.rot!.frame.x, 90);
    near(nodes.rot!.frame.y, -10);
    near(nodes.rot!.frame.width, 20);
    near(nodes.rot!.frame.height, 110);
    // On a frame axis of size 0, scale does not scale.
    expect(nodes.z!.frame).toEqual(f(0, 20, 0, 20));
    expectUndoRedo(target, before);
  });

  it('moves a container subtree rigidly for position and rotation alone', () => {
    const target = editor(resizable());
    const before = documentOf(target);
    ok(target, {
      type: 'setFrames',
      frames: [{ id: 'G', frame: f(30, -20, 100, 100), rotation: 1 }],
    });
    const after = documentOf(target);
    for (const id of ['Z', 'R', 'Q', 'P', 'L', 'F', 'C', 'H', 'K']) {
      expect(after.nodes[id]).toEqual(before.nodes[id]);
    }
    expect(after.nodes.G!.rotation).toBe(1);
  });

  it('rejects a container named with its descendant in one setFrames', () => {
    const target = editor(resizable());
    expectFailure(
      target,
      {
        type: 'setFrames',
        frames: [
          { id: 'G', frame: f(0, 0, 10, 10) },
          { id: 'K', frame: f(0, 0, 10, 10) },
        ],
      },
      'editor.invalid-command',
      '/frames',
    );
  });
});

describe('M1 node props and failure precedence', () => {
  it('sets the new props and rejects props a node type does not have', () => {
    const target = editor();
    const [r] = ok(target, { type: 'createRectangle', frame: f(0, 0, 10, 10) });
    const [l] = ok(target, { type: 'createLine', start: { x: 0, y: 0 }, end: { x: 5, y: 5 } });
    const [g] = ok(target, { type: 'groupNodes', ids: [r!], kind: 'group' });
    ok(target, {
      type: 'setNodeProps',
      id: r!,
      props: { cornerRadii: [1, 2, 3, 4], constraints: { horizontal: 'scale', vertical: 'end' } },
    });
    ok(target, {
      type: 'setNodeProps',
      id: l!,
      props: { startArrow: 'line', endArrow: 'triangle' },
    });
    expect(nodeOf(target, r!)).toMatchObject({
      cornerRadii: [1, 2, 3, 4],
      constraints: { horizontal: 'scale', vertical: 'end' },
    });
    expect(nodeOf(target, l!)).toMatchObject({ startArrow: 'line', endArrow: 'triangle' });
    expectFailure(
      target,
      { type: 'setNodeProps', id: l!, props: { cornerRadii: [0, 0, 0, 0] } },
      'editor.invalid-command',
      '/props/cornerRadii',
    );
    expectFailure(
      target,
      { type: 'setNodeProps', id: g!, props: { fill: null } },
      'editor.invalid-command',
      '/props/fill',
    );
    expectFailure(
      target,
      { type: 'setNodeProps', id: g!, props: { opacity: 0.5 } },
      'document.invalid-field',
      `/nodes/${g!}/opacity`,
    );
    expectFailure(
      target,
      {
        type: 'setNodeProps',
        id: r!,
        props: { constraints: { horizontal: 'middle', vertical: 'start' } as never },
      },
      'document.invalid-field',
      `/nodes/${r!}/constraints/horizontal`,
    );
    expectFailure(
      target,
      { type: 'setFrames', frames: [{ id: r!, frame: f(0, 0, 1, 1), rotation: NaN }] },
      'document.invalid-field',
      `/nodes/${r!}/rotation`,
    );
    // Rotation is normalized by every command.
    ok(target, {
      type: 'setFrames',
      frames: [{ id: r!, frame: f(0, 0, 10, 10), rotation: 3 * Math.PI }],
    });
    expect(nodeOf(target, r!).rotation).toBe(Math.PI);
  });

  it('orders shape, unknown, container-with-descendant, then field failures', () => {
    const target = editor(
      doc(
        [['p', ['G']]],
        [container('group', 'G', 'p', ['a'], f(0, 0, 10, 10)), rect('a', 'G', f(0, 0, 10, 10))],
      ),
    );
    const bad = f(0, 0, -1, 1);
    expectFailure(
      target,
      {
        type: 'setFrames',
        frames: [
          { id: 'a', frame: bad },
          { id: 'a', frame: bad },
        ],
      },
      'editor.invalid-command',
    );
    expectFailure(
      target,
      {
        type: 'setFrames',
        frames: [
          { id: 'a', frame: bad },
          { id: 'zz', frame: bad },
        ],
      },
      'editor.unknown-node',
    );
    expectFailure(
      target,
      {
        type: 'setFrames',
        frames: [
          { id: 'a', frame: bad },
          { id: 'G', frame: bad },
        ],
      },
      'editor.invalid-command',
    );
    expectFailure(
      target,
      { type: 'setFrames', frames: [{ id: 'a', frame: bad }] },
      'document.invalid-field',
      '/nodes/a/frame/width',
    );
  });

  it('makes every M1 command one transaction with byte-identical undo and redo', () => {
    const target = editor(nestedDocument());
    const script: Command[] = [
      { type: 'addPage', name: 'Two' },
      { type: 'createEllipse', frame: f(10, 10, 20, 20), parent: 'G' },
      { type: 'createLine', start: { x: 0, y: 0 }, end: { x: 30, y: 40 }, parent: 'F', index: 0 },
      { type: 'createFrame', frame: f(500, 500, 50, 50), rotation: 0.7 },
      { type: 'groupNodes', ids: ['R', 'P'], kind: 'group' },
      { type: 'moveNodes', ids: ['R2', 'B'], parent: 'G', index: 0 },
      { type: 'setFrames', frames: [{ id: 'G', frame: f(50, 40, 200, 45), rotation: 0.1 }] },
      { type: 'setFrames', frames: [{ id: 'F', frame: f(100, 200, 250, 350) }] },
      { type: 'setNodeProps', id: 'L', props: { endArrow: 'line' } },
      { type: 'ungroupNodes', id: 'G' },
      { type: 'deleteNodes', ids: ['K', 'R'] },
      { type: 'renamePage', id: 'p', name: 'One' },
      { type: 'movePage', id: 'p', index: 1 },
      { type: 'removePage', id: 'p' },
    ];
    const texts = [text(target)];
    for (const command of script) {
      const depth = target.query({ type: 'history' }).undoDepth;
      ok(target, command);
      expect(target.query({ type: 'history' }).undoDepth).toBe(depth + 1);
      texts.push(text(target));
      const parsed = parseDocument(texts.at(-1)!);
      expect(parsed.ok).toBe(true);
    }
    for (let i = texts.length - 2; i >= 0; i -= 1) {
      ok(target, { type: 'undo' });
      expect(text(target)).toBe(texts[i]);
    }
    for (let i = 1; i < texts.length; i += 1) {
      ok(target, { type: 'redo' });
      expect(text(target)).toBe(texts[i]);
    }
  });

  it('moves a nested selection member by the page delta through the select tool', () => {
    const target = editor(
      doc(
        [['p', ['r', 'F']]],
        [
          rect('r', 'p', f(0, 0, 20, 20)),
          container('frame', 'F', 'p', ['a'], f(100, 100, 200, 200), Math.PI / 2),
          rect('a', 'F', f(10, 10, 20, 20)),
        ],
      ),
    );
    const before = placement(documentOf(target), 'a');
    ok(target, { type: 'setSelection', ids: ['r', 'a'] });
    const send = (kind: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number) =>
      ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
    // The press hits the root rectangle, which is selected, so the whole selection moves.
    send('pointerdown', 10, 10);
    send('pointermove', 20, 10);
    send('pointerup', 20, 10);
    const after = placement(documentOf(target), 'a');
    near(after.centre.x, before.centre.x + 10);
    near(after.centre.y, before.centre.y);
    expect(nodeOf(target, 'r').frame).toEqual(f(10, 0, 20, 20));
    // In the frame's space (turned by π/2) the page delta (10, 0) is (0, −10), up to rounding.
    const local = nodeOf(target, 'a').frame;
    near(local.x, 10);
    near(local.y, 0);
    expect(target.query({ type: 'history' }).undoDepth).toBe(1);
  });
});

/** `depth` nested mask groups, each with a path source and the next mask group above it. */
function maskChain(depth: number) {
  const nodes: Loose[] = [];
  let parent = 'p';
  for (let level = 0; level < depth; level += 1) {
    const id = `m${level}`;
    const children = level + 1 < depth ? [`s${level}`, `m${level + 1}`] : [`s${level}`];
    nodes.push(container('maskGroup', id, parent, children, f(0, 0, 10, 10)));
    nodes.push(pathNode(`s${level}`, id, f(0, 0, 10, 10)));
    parent = id;
  }
  nodes.push(container('maskGroup', 'loose', 'p', ['ls'], f(0, 0, 10, 10)));
  nodes.push(pathNode('ls', 'loose', f(0, 0, 10, 10)));
  return doc([['p', ['m0', 'loose']]], nodes);
}

describe('M1-U2 review fixes', () => {
  function pointerDrag(target: Editor, from: [number, number], to: [number, number]) {
    const send = (kind: 'pointerdown' | 'pointermove' | 'pointerup', [x, y]: [number, number]) =>
      ok(target, { type: 'input', event: { kind, point: { x, y }, modifiers: none } });
    send('pointerdown', from);
    send('pointermove', to);
    send('pointerup', to);
  }

  function gestureResize(value: unknown, id: string, frames: Frame[]) {
    const target = editor(value);
    const { gesture } = internalsOf(target);
    expect(gesture.begin()).toBe(true);
    for (const frame of frames) {
      const result = gesture.update({ type: 'setFrames', frames: [{ id, frame }] });
      expect(result.ok).toBe(true);
    }
    gesture.commit();
    return target;
  }

  it.each<[string, () => ReturnType<typeof doc>, string]>([
    [
      'a frame with a startEnd child',
      () =>
        doc(
          [['p', ['F']]],
          [
            container('frame', 'F', 'p', ['c'], f(0, 0, 100, 50)),
            rect('c', 'F', f(10, 10, 80, 20), 0, {
              constraints: { horizontal: 'startEnd', vertical: 'start' },
            }),
          ],
        ),
      'F',
    ],
    [
      'a group with a rotated child',
      () =>
        doc(
          [['p', ['G']]],
          [
            container('group', 'G', 'p', ['a', 'b'], f(0, 0, 100, 50)),
            rect('a', 'G', f(0, 0, 100, 20)),
            rect('b', 'G', f(30, 20, 40, 30), 0.5),
          ],
        ),
      'G',
    ],
  ])('a gesture resize of %s depends only on its last update', (_, value, id) => {
    const start = value().nodes[id]!.frame as Frame;
    const wide = { ...start, width: 200 };
    const direct = editor(value());
    ok(direct, { type: 'setFrames', frames: [{ id, frame: wide }] });
    const viaGesture = gestureResize(value(), id, [{ ...start, width: 5 }, wide]);
    expect(text(viaGesture)).toBe(text(direct));
    expect(viaGesture.query({ type: 'history' }).undoDepth).toBe(1);
    // Through zero width and back to the start size commits the start document.
    const back = gestureResize(value(), id, [{ ...start, width: 0 }, start]);
    expect(text(back)).toBe(text(editor(value())));
  });

  it('keeps the startEnd child at 180 after a gesture 100 → 5 → 200', () => {
    const target = gestureResize(
      doc(
        [['p', ['F']]],
        [
          container('frame', 'F', 'p', ['c'], f(0, 0, 100, 50)),
          rect('c', 'F', f(10, 10, 80, 20), 0, {
            constraints: { horizontal: 'startEnd', vertical: 'start' },
          }),
        ],
      ),
      'F',
      [f(0, 0, 5, 50), f(0, 0, 200, 50)],
    );
    expect(nodeOf(target, 'c').frame).toEqual(f(10, 10, 180, 20));
  });

  it('failed groupNodes and addPage draw no ID', () => {
    const value = doc(
      [['p', ['M']]],
      [
        container('maskGroup', 'M', 'p', ['S', 'R'], f(0, 0, 10, 10)),
        pathNode('S', 'M', f(0, 0, 10, 10)),
        rect('R', 'M', f(0, 0, 10, 10)),
      ],
    );
    const target = editor(value);
    expectFailure(
      target,
      { type: 'groupNodes', ids: ['S', 'R'], kind: 'group' },
      'editor.invalid-mask-source',
      '/nodes/M/children/0',
    );
    expectFailure(
      target,
      { type: 'groupNodes', ids: ['R'], kind: 'maskGroup' },
      'editor.invalid-mask-source',
      '/children/0',
    );
    expectFailure(
      target,
      { type: 'groupNodes', ids: ['S', 'M'], kind: 'group' },
      'editor.not-siblings',
    );
    expectFailure(target, { type: 'addPage', index: 5 }, 'editor.invalid-index');
    // The first ID the source hands out is still unused.
    expect(ok(target, { type: 'addPage' })).toEqual(['n1']);
    const [g] = ok(target, { type: 'groupNodes', ids: ['M'], kind: 'group' });
    expect(g).toBe('n2');
    expect(nodeOf(target, g!)).toMatchObject({ children: ['M'], parent: 'p' });
  });

  it('a reorder within a rotated group keeps frames and rotations exactly', () => {
    const value = doc(
      [['p', ['G']]],
      [
        container('group', 'G', 'p', ['a', 'b'], f(0, 0, 100, 100), 0.7),
        rect('a', 'G', f(12.3, 4.5, 40, 30), 0.3),
        rect('b', 'G', f(50, 50, 50, 50)),
      ],
    );
    const target = editor(value);
    const before = documentOf(target);
    ok(target, { type: 'moveNodes', ids: ['a'], parent: 'G', index: 1 });
    const after = documentOf(target);
    expect(after.nodes.G).toMatchObject({ children: ['b', 'a'], frame: before.nodes.G!.frame });
    expect(after.nodes.a!.frame).toEqual(before.nodes.a!.frame);
    expect(after.nodes.a!.rotation).toBe(0.3);
    expect(after.nodes.b).toEqual(before.nodes.b);
  });

  it('loads 32 nested mask groups and rejects 33', () => {
    expect(() => editor(maskChain(32))).not.toThrow();
    expect(() => editor(maskChain(33))).toThrow('editor.clip-depth at /nodes/m32/parent');
    const target = editor(maskChain(32));
    expectFailure(
      target,
      { type: 'loadDocument', document: maskChain(33) },
      'editor.clip-depth',
      '/nodes/m32/parent',
    );
  });

  it('rejects a frame or mask group inside the 32nd nested mask group', () => {
    const target = editor(maskChain(32));
    expectFailure(
      target,
      { type: 'createFrame', frame: f(0, 0, 5, 5), parent: 'm31' },
      'editor.clip-depth',
      '/parent',
    );
    expectFailure(
      target,
      { type: 'moveNodes', ids: ['loose'], parent: 'm31', index: 1 },
      'editor.clip-depth',
      '/nodes/loose/parent',
    );
    // One level up, the mask group fits; a leaf fits in the 32nd.
    ok(target, { type: 'moveNodes', ids: ['loose'], parent: 'm30', index: 2 });
    ok(target, { type: 'createRectangle', frame: f(0, 0, 5, 5), parent: 'm31' });
  });

  it('offers resize handles for rotated and nested selections (M1-U4)', () => {
    const value = () =>
      doc(
        [['p', ['r', 'G']]],
        [
          rect('r', 'p', f(0, 0, 100, 100)),
          container('group', 'G', 'p', ['a'], f(200, 0, 100, 100)),
          rect('a', 'G', f(0, 0, 100, 100)),
        ],
      );
    // Page root, rotation 0: the corner handle resizes.
    const plain = editor(value());
    ok(plain, { type: 'setSelection', ids: ['r'] });
    pointerDrag(plain, [100, 100], [150, 150]);
    expect(nodeOf(plain, 'r').frame).toEqual(f(0, 0, 150, 150));
    // Rotated: the handle at local (0, 0) sits at page (100, 100) and scales in the node's axes.
    const turned = editor(value());
    ok(turned, {
      type: 'setFrames',
      frames: [{ id: 'r', frame: f(0, 0, 100, 100), rotation: Math.PI }],
    });
    ok(turned, { type: 'setSelection', ids: ['r'] });
    pointerDrag(turned, [99, 99], [149, 149]);
    expect(nodeOf(turned, 'r')).toMatchObject({ frame: f(0, 0, 150, 150), rotation: Math.PI });
    // Nested: the corner handle resizes the child, and its group refits at commit.
    const nested = editor(value());
    ok(nested, { type: 'setSelection', ids: ['a'] });
    pointerDrag(nested, [300, 100], [350, 150]);
    expect(nodeOf(nested, 'a').frame).toEqual(f(0, 0, 150, 150));
    expect(nodeOf(nested, 'G').frame).toEqual(f(200, 0, 150, 150));
  });
});
