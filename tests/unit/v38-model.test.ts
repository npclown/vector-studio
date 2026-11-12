import {
  MAX_GUIDES,
  MAX_LAYOUT_GRIDS,
  parseDocument,
  serializeDocument,
  validateAnyDocument,
  validateDocument,
  validateGuides,
  validateNode,
  type LayoutGrid,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';

// V-38 contract, V38-A01: optional page `guides` (V38-S1) and frame or symbol `layoutGrids`
// (V38-S2): parse, validation at each path, canonical order without empty lists, round trip, and
// no field from a migrated older document.

type Loose = Record<string, unknown>;

const START = { horizontal: 'start', vertical: 'start' } as const;
const RED = { r: 1, g: 0, b: 0, a: 0.1 };
const GRID: LayoutGrid = { type: 'grid', size: 10, color: RED, visible: true };
const COLUMNS: LayoutGrid = {
  type: 'columns',
  count: 5,
  align: 'stretch',
  size: 100,
  gutter: 20,
  offset: 20,
  color: RED,
  visible: false,
};

const frame = (extra: Loose = {}, type = 'frame'): Loose => ({
  id: 'f',
  name: 'F',
  parent: 'p',
  frame: { x: 0, y: 0, width: 400, height: 300 },
  rotation: 0,
  constraints: START,
  opacity: 1,
  visible: true,
  type,
  children: [],
  fill: null,
  stroke: null,
  effects: [],
  ...extra,
});

const documentOf = (page: Loose = {}, node: Loose = frame()): Loose => ({
  schemaVersion: 8,
  id: 'd',
  pages: [{ id: 'p', name: 'P', children: ['f'], ...page }],
  nodes: { f: node },
});

const failure = (value: unknown) => {
  const result = validateDocument(value);
  return result.ok ? 'ok' : `${result.code} ${result.path}`;
};

describe('V38-A01 guides and layout grids in the document', () => {
  it('reads guides and grids and keeps them on the page and node', () => {
    const guides = [
      { axis: 'x', value: 10 },
      { axis: 'y', value: -2.5 },
      { axis: 'x', value: 10 },
    ];
    const result = validateDocument(
      documentOf({ guides }, frame({ layoutGrids: [GRID, COLUMNS] })),
    );
    if (!result.ok) throw new Error(`${result.code} ${result.path}`);
    expect(result.document.pages[0]!.guides).toEqual(guides);
    const node = result.document.nodes.f!;
    expect(node.type === 'frame' && node.layoutGrids).toEqual([GRID, COLUMNS]);
  });

  it('accepts grids on a symbol and refuses them elsewhere', () => {
    expect(failure(documentOf({}, frame({ layoutGrids: [GRID] }, 'symbol')))).toBe('ok');
    const group = frame({ layoutGrids: [GRID] }, 'group');
    delete group.fill;
    delete group.stroke;
    expect(failure(documentOf({}, group))).toBe('document.invalid-field /nodes/f/layoutGrids');
  });

  it('drops empty lists and writes none', () => {
    const result = validateDocument(documentOf({ guides: [] }, frame({ layoutGrids: [] })));
    if (!result.ok) throw new Error(result.code);
    expect('guides' in result.document.pages[0]!).toBe(false);
    expect('layoutGrids' in result.document.nodes.f!).toBe(false);
    const raw = JSON.parse(serializeDocument(result.document)) as {
      pages: Loose[];
      nodes: { f: Loose };
    };
    expect(Object.keys(raw.pages[0]!)).toEqual(['id', 'name', 'children']);
    expect('layoutGrids' in raw.nodes.f).toBe(false);
  });

  it('writes canonical key order and round-trips', () => {
    const value = documentOf(
      { guides: [{ value: 3, axis: 'y' }] },
      frame({
        layoutGrids: [
          { visible: true, color: RED, size: 8, type: 'grid' },
          { ...COLUMNS, type: 'rows', align: 'end' },
        ],
      }),
    );
    const result = validateDocument(value);
    if (!result.ok) throw new Error(result.code);
    const text = serializeDocument(result.document);
    const raw = JSON.parse(text) as {
      pages: (Loose & { guides: Loose[] })[];
      nodes: { f: Loose & { layoutGrids: Loose[] } };
    };
    expect(Object.keys(raw.pages[0]!)).toEqual(['id', 'name', 'children', 'guides']);
    expect(Object.keys(raw.pages[0]!.guides[0]!)).toEqual(['axis', 'value']);
    const keys = Object.keys(raw.nodes.f);
    expect(keys.slice(-4)).toEqual(['stroke', 'layoutGrids', 'blendMode', 'effects']);
    expect(raw.nodes.f.layoutGrids.map((grid) => Object.keys(grid))).toEqual([
      ['type', 'size', 'color', 'visible'],
      ['type', 'count', 'align', 'size', 'gutter', 'offset', 'color', 'visible'],
    ]);
    const again = parseDocument(text);
    expect(again.ok && serializeDocument(again.document)).toBe(text);
  });

  it('fails each bad value at its path', () => {
    const guide = (value: unknown) => failure(documentOf({ guides: [value] }));
    expect(guide({ axis: 'z', value: 0 })).toBe('document.invalid-field /pages/0/guides/0/axis');
    expect(guide({ axis: 'x', value: 2e7 })).toBe('document.invalid-field /pages/0/guides/0/value');
    expect(guide({ axis: 'x' })).toBe('document.invalid-field /pages/0/guides/0/value');
    expect(guide({ axis: 'x', value: 0, extra: 1 })).toBe(
      'document.invalid-field /pages/0/guides/0/extra',
    );
    expect(failure(documentOf({ guides: {} }))).toBe('document.invalid-field /pages/0/guides');
    const many = Array.from({ length: MAX_GUIDES + 1 }, () => ({ axis: 'x', value: 0 }));
    expect(failure(documentOf({ guides: many }))).toBe('document.invalid-field /pages/0/guides');

    const grid = (value: unknown) => failure(documentOf({}, frame({ layoutGrids: [value] })));
    const at = (key: string) => `document.invalid-field /nodes/f/layoutGrids/0/${key}`;
    expect(grid({ ...GRID, size: 0 })).toBe(at('size'));
    expect(grid({ ...GRID, size: 1e5 })).toBe(at('size'));
    expect(grid({ ...GRID, type: 'dots' })).toBe(at('type'));
    expect(grid({ ...GRID, count: 2 })).toBe(at('count'));
    expect(grid({ ...COLUMNS, count: 0 })).toBe(at('count'));
    expect(grid({ ...COLUMNS, count: 1.5 })).toBe(at('count'));
    expect(grid({ ...COLUMNS, align: 'left' })).toBe(at('align'));
    expect(grid({ ...COLUMNS, size: 0 })).toBe(at('size'));
    expect(grid({ ...COLUMNS, gutter: -1 })).toBe(at('gutter'));
    expect(grid({ ...COLUMNS, offset: -1 })).toBe(at('offset'));
    expect(grid({ ...COLUMNS, color: { ...RED, a: 2 } })).toBe(at('color/a'));
    expect(grid({ ...COLUMNS, visible: 1 })).toBe(at('visible'));
    const grids = Array.from({ length: MAX_LAYOUT_GRIDS + 1 }, () => GRID);
    expect(failure(documentOf({}, frame({ layoutGrids: grids })))).toBe(
      'document.invalid-field /nodes/f/layoutGrids',
    );
  });

  it('refuses the fields in a document of an older version', () => {
    const v6 = (value: Loose) => {
      const node = (value.nodes as { f: Loose }).f;
      const rest = { ...node };
      delete rest.effects;
      return { ...value, schemaVersion: 6, nodes: { f: rest } };
    };
    const guides = validateAnyDocument(v6(documentOf({ guides: [{ axis: 'x', value: 1 }] })));
    expect(guides.ok ? 'ok' : guides.path).toBe('/pages/0/guides');
    const grids = validateAnyDocument(v6(documentOf({}, frame({ layoutGrids: [GRID] }))));
    expect(grids.ok ? 'ok' : grids.path).toBe('/nodes/f/layoutGrids');
    const plain = validateAnyDocument(v6(documentOf()));
    expect(plain.ok && 'guides' in plain.document.pages[0]!).toBe(false);
    // A v7 input has neither key either: it reads into v8 without them (docs/plans/viz-schema-v8.md).
    const v7 = (value: Loose) => ({ ...value, schemaVersion: 7 });
    const older = validateAnyDocument(v7(documentOf({ guides: [{ axis: 'x', value: 1 }] })));
    expect(older.ok ? 'ok' : older.path).toBe('/pages/0/guides');
    const read = validateAnyDocument(v7(documentOf()));
    expect(read.ok && read.document.schemaVersion).toBe(8);
    expect(read.ok && 'guides' in read.document.pages[0]!).toBe(false);
  });

  it('validates guides and a node for the commands', () => {
    expect(validateGuides([{ axis: 'y', value: -0 }])).toEqual({
      ok: true,
      guides: [{ axis: 'y', value: 0 }],
    });
    expect(validateGuides([{ axis: 'y', value: Number.NaN }])).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/0/value',
    });
    const node = validateNode(frame({ layoutGrids: [COLUMNS] }));
    expect(node.ok && node.node.type === 'frame' && node.node.layoutGrids).toEqual([COLUMNS]);
  });
});
