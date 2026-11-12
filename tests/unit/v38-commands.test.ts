import { serializeDocument, type LayoutGrid } from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FRAME_FILL,
  createCounterIdSource,
  createEditor,
  type Command,
  type Editor,
  type EditorEvent,
} from '../../packages/editor-core/src/index.js';

// V-38 contract, V38-A03 (V38-C1 to C3; C4's chords are in m2-keymap.test.ts): `setGuides`,
// layout grids through `setNodeProps`, the two session flags, and detach keeping a symbol's grids.

const SCHEMA = 8;
const START = { horizontal: 'start', vertical: 'start' } as const;
const RED = { r: 1, g: 0, b: 0, a: 0.1 };
const GRID: LayoutGrid = { type: 'grid', size: 10, color: RED, visible: true };

const base = (id: string, parent: string) => ({
  id,
  name: id,
  parent,
  frame: { x: 0, y: 0, width: 100, height: 100 },
  rotation: 0,
  constraints: START,
  opacity: 1,
  visible: true,
  effects: [],
});

const DOCUMENT = {
  schemaVersion: SCHEMA,
  id: 'doc',
  pages: [
    { id: 'p1', name: 'p1', children: ['F', 'r'] },
    { id: 'p2', name: 'p2', children: [] },
  ],
  nodes: {
    F: { ...base('F', 'p1'), type: 'frame', children: [], fill: DEFAULT_FRAME_FILL, stroke: null },
    r: {
      ...base('r', 'p1'),
      type: 'rectangle',
      cornerRadii: [0, 0, 0, 0],
      fill: RED,
      stroke: null,
    },
  },
};

const editor = (): Editor => createEditor({ ids: createCounterIdSource('n'), document: DOCUMENT });
const text = (target: Editor) => serializeDocument(target.query({ type: 'document' }));
const depth = (target: Editor) => target.query({ type: 'history' }).undoDepth;
const pick = (result: ReturnType<Editor['execute']>) =>
  result.ok ? 'ok' : `${result.code} ${result.path ?? ''}`.trim();
const run = (target: Editor, command: Command) => pick(target.execute(command));

describe('V38-A03 setGuides', () => {
  it('replaces a page’s guides as one undo step; equal guides record none', () => {
    const target = editor();
    const before = text(target);
    const guides = [
      { axis: 'x', value: 10 },
      { axis: 'y', value: -5 },
    ] as const;
    expect(run(target, { type: 'setGuides', page: 'p2', guides })).toBe('ok');
    expect(target.query({ type: 'document' }).pages[1]!.guides).toEqual(guides);
    expect(depth(target)).toBe(1);
    expect(run(target, { type: 'setGuides', page: 'p2', guides: [...guides] })).toBe('ok');
    expect(depth(target)).toBe(1);
    const after = text(target);
    expect(run(target, { type: 'undo' })).toBe('ok');
    expect(text(target)).toBe(before);
    expect(run(target, { type: 'redo' })).toBe('ok');
    expect(text(target)).toBe(after);
    // An empty list removes the key.
    expect(run(target, { type: 'setGuides', page: 'p2', guides: [] })).toBe('ok');
    expect('guides' in target.query({ type: 'document' }).pages[1]!).toBe(false);
    expect(text(target)).toBe(before);
  });

  it('refuses in order: page type, unknown page, then the guide values', () => {
    const target = editor();
    const bad = [{ axis: 'x', value: Number.POSITIVE_INFINITY }] as never;
    expect(run(target, { type: 'setGuides', page: 3 as never, guides: bad })).toBe(
      'editor.invalid-command /page',
    );
    expect(run(target, { type: 'setGuides', page: 'nope', guides: bad })).toBe(
      'editor.unknown-page',
    );
    expect(run(target, { type: 'setGuides', page: 'p1', guides: bad })).toBe(
      'document.invalid-field /guides/0/value',
    );
    expect(run(target, { type: 'setGuides', page: 'p1', guides: {} as never })).toBe(
      'document.invalid-field /guides',
    );
    expect(depth(target)).toBe(0);
  });
});

describe('V38-A03 layout grids through setNodeProps', () => {
  it('sets, validates and removes a frame’s grids', () => {
    const target = editor();
    expect(run(target, { type: 'setNodeProps', id: 'F', props: { layoutGrids: [GRID] } })).toBe(
      'ok',
    );
    const node = target.query({ type: 'node', id: 'F' });
    expect(node?.type === 'frame' && node.layoutGrids).toEqual([GRID]);
    expect(
      run(target, {
        type: 'setNodeProps',
        id: 'F',
        props: { layoutGrids: [{ ...GRID, size: -1 }] },
      }),
    ).toBe('document.invalid-field /nodes/F/layoutGrids/0/size');
    expect(run(target, { type: 'setNodeProps', id: 'r', props: { layoutGrids: [GRID] } })).toBe(
      'editor.invalid-command /props/layoutGrids',
    );
    expect(run(target, { type: 'setNodeProps', id: 'x', props: { layoutGrids: [GRID] } })).toBe(
      'editor.unknown-node',
    );
    expect(run(target, { type: 'setNodeProps', id: 'F', props: { layoutGrids: [] } })).toBe('ok');
    expect('layoutGrids' in target.query({ type: 'node', id: 'F' })!).toBe(false);
  });

  it('detaching an instance keeps its symbol’s grids', () => {
    const target = editor();
    run(target, { type: 'setNodeProps', id: 'F', props: { layoutGrids: [GRID] } });
    const symbol = target.execute({ type: 'createSymbol', ids: ['r'] });
    if (!symbol.ok) throw new Error(symbol.code);
    const id = symbol.ids[0]!;
    expect(run(target, { type: 'setNodeProps', id, props: { layoutGrids: [GRID] } })).toBe('ok');
    const instance = target.execute({ type: 'createInstance', symbol: id });
    if (!instance.ok) throw new Error(instance.code);
    const detached = target.execute({ type: 'detachInstances', ids: instance.ids });
    if (!detached.ok) throw new Error(detached.code);
    // The frame takes the instance's ID.
    const frame = target.query({ type: 'node', id: instance.ids[0]! });
    expect(frame?.type).toBe('frame');
    expect(frame?.type === 'frame' && frame.layoutGrids).toEqual([GRID]);
  });

  it('pastes grids at the current version and refuses them in an older fragment', () => {
    const target = editor();
    run(target, { type: 'setNodeProps', id: 'F', props: { layoutGrids: [GRID] } });
    expect(run(target, { type: 'copy', ids: ['F'] })).toBe('ok');
    const copied = target.query({ type: 'clipboard' })!;
    expect(run(target, { type: 'paste', text: copied })).toBe('ok');
    const older = copied.replace(`"schemaVersion":${SCHEMA}`, '"schemaVersion":6');
    expect(older).not.toBe(copied);
    // Below v7 the fragment's nodes carry no `effects` either; drop them so only the grids differ.
    const stripped = older.replaceAll(',"effects":[]', '');
    expect(run(target, { type: 'paste', text: stripped })).toMatch(
      /^document\.invalid-field \/nodes\/[^/]+\/layoutGrids$/u,
    );
  });
});

describe('V38-A03 session flags', () => {
  it('defaults, queries, snapshot fields, events and no history', () => {
    const target = editor();
    const seen: EditorEvent[] = [];
    target.subscribe((event) => seen.push(event));
    expect(target.query({ type: 'rulersVisible' })).toBe(false);
    expect(target.query({ type: 'layoutGridsVisible' })).toBe(true);
    expect(run(target, { type: 'setRulersVisible', visible: true })).toBe('ok');
    expect(run(target, { type: 'setRulersVisible', visible: true })).toBe('ok');
    expect(run(target, { type: 'setLayoutGridsVisible', visible: false })).toBe('ok');
    expect(target.getSnapshot()).toMatchObject({ rulersVisible: true, layoutGridsVisible: false });
    expect(seen.map((event) => (event.type === 'session' ? event.field : event.type))).toEqual([
      'rulersVisible',
      'layoutGridsVisible',
    ]);
    expect(depth(target)).toBe(0);
    expect(run(target, { type: 'setRulersVisible', visible: 1 as never })).toBe(
      'editor.invalid-command /visible',
    );
    // Both survive a load, as `snapping` does.
    expect(run(target, { type: 'loadDocument', document: DOCUMENT })).toBe('ok');
    expect(target.query({ type: 'rulersVisible' })).toBe(true);
    expect(target.query({ type: 'layoutGridsVisible' })).toBe(false);
  });
});
