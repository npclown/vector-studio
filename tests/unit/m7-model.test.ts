import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DOCUMENT_ERROR_CODES,
  MAX_TREE_DEPTH,
  migrateV1toV2,
  migrateV2toV3,
  migrateV3toV4,
  parseDocument,
  parseEnvelope,
  serializeDocument,
  serializeEnvelope,
  validateAnyDocument,
  validateDocument,
  validateFragmentTree,
  validateNode,
  type DocumentV1,
  type DocumentV2,
  type DocumentV4,
  type EnvelopeResult,
  type FragmentTreeResult,
  type ParseResult,
  type ParseResultV3,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';

// MVP M7-U1 (M7 contract, section 2): schema v3 with `symbol` and `instance`, the M7-S rules and
// codes, the version-only migration, the serialize order and `validateFragmentTree` (M7-A01).
// Since M6a-U1 the model returns and writes schema v4 (M6a contract, section 2.1): a v3 fixture
// reads as its committed v4 migration under `m6-text/migrated`, and `validateDocument` and
// `validateFragmentTree` take a v3 value with its version set to 4.

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(root, 'tests/fixtures');
const m7 = path.join(fixtures, 'm7-symbols');
/** The committed v4 migration of a v3 fixture file. */
const v4 = (file: string) =>
  `m6-text/migrated/${path.basename(file).replace(/(\.v3)?\.json$/, '')}.v4.json`;

function read(file: string): Promise<string> {
  return readFile(path.join(fixtures, file), 'utf8');
}

function parsed(text: string): DocumentV4 {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

type Failed = { code: string; path: string };

function failure(
  result: ParseResult | ParseResultV3 | FragmentTreeResult | EnvelopeResult,
): Failed {
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('document');
  expect(result).not.toHaveProperty('nodes');
  return result.ok ? { code: 'none', path: '' } : { code: result.code, path: result.path };
}

/** Every committed v2 document fixture and its committed v3 migration under `m7-symbols`. */
const MIGRATIONS = [
  ['m1-model/empty.v2.json', 'empty'],
  ['m1-model/shapes.v2.json', 'shapes'],
  ['m1-model/ext-star.v2.json', 'ext-star'],
  ['m1-model/containers.json', 'containers'],
  ['m3-path-edit/path-edit.json', 'path-edit'],
] as const;
/** Every committed v2 envelope fixture (M5), migrated the same way. */
const ENVELOPES = ['empty', 'shapes', 'ext-star', 'containers'] as const;
/** Every committed valid v3 fixture. */
const V3_FIXTURES = [
  'm7-symbols/symbols.v3.json',
  ...MIGRATIONS.map(([, name]) => `m7-symbols/migrated/${name}.v3.json`),
  'm7-symbols/depth/tree-256.json',
  'm7-symbols/depth/clip-32.json',
  'm7-symbols/depth/clip-33.json',
];

const START = { horizontal: 'start', vertical: 'start' } as const;
const F = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

function base(id: string, parent: string) {
  return {
    id,
    name: id,
    parent,
    frame: F(0, 0, 10, 10),
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
  };
}

const rect = (id: string, parent: string) => ({
  ...base(id, parent),
  type: 'rectangle',
  cornerRadii: [0, 0, 0, 0],
  fill: null,
  stroke: null,
});
const symbol = (id: string, parent: string, children: string[] = []) => ({
  ...base(id, parent),
  type: 'symbol',
  children,
  fill: null,
  stroke: null,
});
const instance = (id: string, parent: string, source: string) => ({
  ...base(id, parent),
  type: 'instance',
  symbol: source,
});
const group = (id: string, parent: string, children: string[]) => ({
  ...base(id, parent),
  type: 'group',
  children,
});

function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

type Loose = {
  schemaVersion: number;
  id: string;
  pages: unknown[];
  nodes: Record<string, unknown>;
};

function document(nodes: Record<string, unknown>, children: string[], version = 4): Loose {
  return { schemaVersion: version, id: 'd', pages: [{ id: 'p', name: 'P', children }], nodes };
}

/**
 * All four document entry points, each with the path of `failure` relative to the document;
 * `validateDocument` reads the value at the latest version.
 */
function everyEntryPoint(value: Loose): Failed[] {
  const text = JSON.stringify(value);
  const envelope = failure(
    parseEnvelope(JSON.stringify({ envelopeVersion: 1, lastOpenPageId: 'p', document: value })),
  );
  return [
    failure(parseDocument(text)),
    failure(validateDocument({ ...value, schemaVersion: 4 })),
    failure(validateAnyDocument(value)),
    { code: envelope.code, path: envelope.path.replace(/^\/document/, '') },
  ];
}

describe('M7-A01 migration v2 to v3', () => {
  it.each(MIGRATIONS)(
    'migrates the v2 fixture %s byte for byte to its committed v3 text',
    async (file, name) => {
      const v2 = await read(file);
      const v3 = await read(`m7-symbols/migrated/${name}.v3.json`);
      expect(serializeDocument(parsed(v2))).toBe(await read(v4(`${name}.v3.json`)));
      const migrated = migrateV2toV3(JSON.parse(v2) as DocumentV2);
      expect(migrated.ok && migrated.document).toEqual(JSON.parse(v3));
      const latest = migrated.ok ? migrateV3toV4(migrated.document) : migrated;
      expect(latest.ok && serializeDocument(latest.document)).toBe(serializeDocument(parsed(v3)));
      // Only the version changes (M7-Q12 (a)); the M3 host fixture is not in canonical text form.
      expect(JSON.parse(v3)).toEqual({ ...(JSON.parse(v2) as object), schemaVersion: 3 });
    },
  );

  it.each(ENVELOPES)('migrates the v2 envelope fixture %s byte for byte', async (name) => {
    const v2 = await read(`m5-persistence/${name}.envelope.json`);
    const v3 = await read(`m7-symbols/migrated/${name}.envelope.v3.json`);
    const result = parseEnvelope(v2);
    expect(result.ok && serializeEnvelope(result.envelope)).toBe(
      await read(`m6-text/migrated/${name}.envelope.v4.json`),
    );
    expect(v3).toBe(v2.replace('"schemaVersion": 2,', '"schemaVersion": 3,'));
  });

  it.each(['empty', 'shapes', 'ext-star'])(
    'migrates the v1 fixture %s through v2 to its committed v3 text',
    async (name) => {
      const v1 = await read(`p5-model/${name}.json`);
      const v3 = await read(`m7-symbols/migrated/${name}.v3.json`);
      expect(serializeDocument(parsed(v1))).toBe(await read(v4(`${name}.v3.json`)));
      const v2 = migrateV1toV2(JSON.parse(v1) as DocumentV1);
      expect(v2.ok && v2.document.schemaVersion).toBe(2);
      const chained = v2.ok ? migrateV2toV3(v2.document) : v2;
      expect(chained.ok && chained.document).toEqual(JSON.parse(v3));
    },
  );

  it('rejects a v3 node type in a v2 document, also through migrateV2toV3', () => {
    const v2 = document({ s: symbol('s', 'p') }, ['s'], 2);
    expect(failure(parseDocument(JSON.stringify(v2)))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/s/type',
    });
    expect(failure(validateAnyDocument(v2))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/s/type',
    });
    expect(failure(migrateV2toV3(v2 as unknown as DocumentV2))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/s/type',
    });
  });

  it('accepts versions 1 to 4 and validateDocument only 4 (since M6a-U1)', async () => {
    const v1 = JSON.parse(await read('p5-model/shapes.json')) as unknown;
    const v2 = JSON.parse(await read('m1-model/shapes.v2.json')) as unknown;
    const v3 = JSON.parse(await read('m7-symbols/migrated/shapes.v3.json')) as unknown;
    const latest = JSON.parse(await read(v4('shapes.v3.json'))) as unknown;
    const unsupported = { code: 'document.unsupported-version', path: '/schemaVersion' };
    expect(failure(validateDocument(v1))).toEqual(unsupported);
    expect(failure(validateDocument(v2))).toEqual(unsupported);
    expect(failure(validateDocument(v3))).toEqual(unsupported);
    const all = [
      validateAnyDocument(v1),
      validateAnyDocument(v2),
      validateAnyDocument(v3),
      validateDocument(latest),
    ];
    for (const result of all)
      expect(result.ok && result.document).toEqual(all[3]!.ok && all[3]!.document);
    expect(all[3]!.ok && all[3]!.document.schemaVersion).toBe(4);
  });

  it.each(['p5-model', 'm1-model', 'm7-symbols'])(
    'fails the %s unsupported-version fixture at schemaVersion 5 (since M6a-U1)',
    async (dir) => {
      const text = await read(`${dir}/malformed/unsupported-version.json`);
      expect((JSON.parse(text) as { schemaVersion: number }).schemaVersion).toBe(5);
      expect(failure(parseDocument(text))).toEqual({
        code: 'document.unsupported-version',
        path: '/schemaVersion',
      });
    },
  );

  it('fails the M5 document-unsupported-version envelope at schemaVersion 5', async () => {
    const text = await read('m5-persistence/malformed/document-unsupported-version.json');
    expect(
      (JSON.parse(text) as { document: { schemaVersion: number } }).document.schemaVersion,
    ).toBe(5);
    expect(failure(parseEnvelope(text))).toEqual({
      code: 'document.unsupported-version',
      path: '/document/schemaVersion',
    });
  });
});

describe('M7-A01 round trip and serialize order (section 7)', () => {
  it.each(V3_FIXTURES)('round-trips %s byte for byte as its v4 migration', async (file) => {
    const text = await read(v4(file));
    const value = parsed(await read(file));
    expect(serializeDocument(value)).toBe(text);
    expect(parsed(serializeDocument(value))).toEqual(value);
    for (const page of value.pages) {
      const envelope = { document: value, lastOpenPageId: page.id };
      const result = parseEnvelope(serializeEnvelope(envelope));
      expect(result).toEqual({ ok: true, envelope });
      expect(result.ok && serializeDocument(result.envelope.document)).toBe(text);
    }
  });

  it('covers sources and instances on two pages, a cross-page instance, an empty source and a detached frame', async () => {
    const value = parsed(await read('m7-symbols/symbols.v3.json'));
    const nodes = value.nodes;
    const pageOf = (id: string): string => {
      let at = id;
      while (Object.hasOwn(nodes, at)) at = nodes[at]!.parent;
      return at;
    };
    expect(value.pages.map((page) => page.id)).toEqual(['page-1', 'page-2']);
    const types = new Set(Object.values(nodes).map((node) => node.type));
    expect(types.has('symbol') && types.has('instance')).toBe(true);
    const instances = Object.values(nodes).filter((node) => node.type === 'instance');
    expect(instances.map((node) => [node.id, node.symbol, pageOf(node.id)])).toEqual([
      ['i1', 's1', 'page-1'],
      ['i2', 's1', 'page-2'],
      ['i3', 's2', 'page-1'],
      ['i4', 's1', 'page-2'],
    ]);
    expect([pageOf('s1'), pageOf('s2')]).toEqual(['page-1', 'page-2']);
    expect(nodes.s2).toMatchObject({ type: 'symbol', children: [] });
    expect(nodes.d1!.type).toBe('frame');
    // Instances inside a group and a frame; a rotated one.
    expect([nodes.i2!.parent, nodes.i4!.parent, nodes.i2!.rotation]).toEqual(['g1', 'f2', -1.25]);
  });

  it('writes symbol keys as a frame and instance keys as the base followed by symbol', async () => {
    const text = await read(v4('symbols.v3.json'));
    const raw = JSON.parse(text) as { nodes: Record<string, object> };
    const BASE = [
      'id',
      'name',
      'parent',
      'frame',
      'rotation',
      'constraints',
      'opacity',
      'visible',
      'type',
    ];
    expect(Object.keys(raw.nodes.s1!)).toEqual([...BASE, 'children', 'fill', 'stroke']);
    expect(Object.keys(raw.nodes.s1!)).toEqual(Object.keys(raw.nodes.d1!));
    expect(Object.keys(raw.nodes.i1!)).toEqual([...BASE, 'symbol']);
    // The order holds for an in-memory value built in another key order.
    const value = parsed(text);
    const { symbol: source, ...rest } = value.nodes.i1 as Extract<
      DocumentV4['nodes'][string],
      { type: 'instance' }
    >;
    const shuffled = {
      ...value,
      nodes: { ...value.nodes, i1: { symbol: source, ...rest } },
    } as DocumentV4;
    expect(serializeDocument(shuffled)).toBe(text);
  });
});

describe('M7-A01 malformed v3 documents (M7-S1 to M7-S5)', () => {
  const expected: Record<string, [string, string]> = {
    'dangling-symbol': ['document.dangling-reference', '/nodes/i/symbol'],
    'non-source-symbol': ['document.invalid-symbol', '/nodes/i/symbol'],
    'instance-in-symbol': ['document.invalid-symbol', '/nodes/i/parent'],
    'symbol-in-symbol': ['document.invalid-symbol', '/nodes/t/parent'],
    'instance-opacity': ['document.invalid-field', '/nodes/i/opacity'],
    'symbol-in-v2': ['document.invalid-field', '/nodes/s/type'],
    'tree-depth-257': ['document.invalid-field', '/nodes/i/parent'],
    'unsupported-version': ['document.unsupported-version', '/schemaVersion'],
  };

  it('has one committed fixture per case', async () => {
    const names = (await readdir(path.join(m7, 'malformed'))).map((file) =>
      file.replace(/\.json$/, ''),
    );
    expect(names.sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s fails with its code and path', async (name, [code, at]) => {
    const text = await read(`m7-symbols/malformed/${name}.json`);
    expect(failure(parseDocument(text))).toEqual({ code, path: at });
    expect(failure(validateAnyDocument(JSON.parse(text)))).toEqual({ code, path: at });
  });

  it('lists document.invalid-symbol after the schema v2 codes', () => {
    expect(DOCUMENT_ERROR_CODES.slice(-3)).toEqual([
      'document.cyclic-parent',
      'document.invalid-mask-source',
      'document.invalid-symbol',
    ]);
  });

  it.each(['dangling-symbol', 'non-source-symbol', 'tree-depth-257'])(
    'enforces M7-S2 and M7-S5 at every document entry point: %s',
    async (name) => {
      const value = JSON.parse(await read(`m7-symbols/malformed/${name}.json`)) as Loose;
      const [code, at] = expected[name]!;
      expect(everyEntryPoint(value)).toEqual(Array(4).fill({ code, path: at }));
    },
  );

  it(`puts the deepest expanded node at the instance depth plus the source height (${MAX_TREE_DEPTH} passes)`, async () => {
    const pass = parsed(await read('m7-symbols/depth/tree-256.json'));
    const fail = JSON.parse(await read('m7-symbols/malformed/tree-depth-257.json')) as {
      nodes: Record<string, { parent: string }>;
    };
    const depth = (nodes: Record<string, { parent: string }>, id: string) => {
      let count = 0;
      for (let at = nodes[id]!.parent; Object.hasOwn(nodes, at); at = nodes[at]!.parent) count += 1;
      return count;
    };
    // tree-256: instance at 128, source at 0 with its leaf at 128, so the expanded leaf is at 256.
    expect([depth(pass.nodes, 'i'), depth(pass.nodes, 's'), depth(pass.nodes, 'leaf')]).toEqual([
      128, 0, 128,
    ]);
    // tree-depth-257: one more group above the instance; every document node stays far below 256.
    expect([depth(fail.nodes, 'i'), depth(fail.nodes, 'leaf')]).toEqual([129, 128]);
  });

  it('leaves the clip depth through an expansion to editor-core (M7-S5): both clip fixtures are valid models', async () => {
    for (const name of ['clip-32', 'clip-33']) {
      expect(parseDocument(await read(`m7-symbols/depth/${name}.json`)).ok).toBe(true);
    }
  });

  it.each<[string, Record<string, unknown>, string[], string, string]>([
    [
      'an instance naming a page',
      { s: symbol('s', 'p'), i: instance('i', 'p', 'p') },
      ['s', 'i'],
      'document.dangling-reference',
      '/nodes/i/symbol',
    ],
    [
      'an instance naming itself',
      { i: instance('i', 'p', 'i') },
      ['i'],
      'document.invalid-symbol',
      '/nodes/i/symbol',
    ],
    [
      'an instance naming another instance',
      { s: symbol('s', 'p'), i: instance('i', 'p', 's'), j: instance('j', 'p', 'i') },
      ['s', 'i', 'j'],
      'document.invalid-symbol',
      '/nodes/j/symbol',
    ],
    [
      'an instance with U+0000 in symbol',
      { i: instance('i', 'p', 's\u0000') },
      ['i'],
      'document.invalid-field',
      '/nodes/i/symbol',
    ],
    [
      'an instance with a non-string symbol',
      { i: { ...instance('i', 'p', 's'), symbol: 1 } },
      ['i'],
      'document.invalid-field',
      '/nodes/i/symbol',
    ],
    [
      'an instance without symbol',
      { i: without(instance('i', 'p', 's'), 'symbol') },
      ['i'],
      'document.invalid-field',
      '/nodes/i/symbol',
    ],
    [
      'an instance with children',
      { i: { ...instance('i', 'p', 's'), children: [] } },
      ['i'],
      'document.invalid-field',
      '/nodes/i/children',
    ],
    [
      'an instance with fill',
      { i: { ...instance('i', 'p', 's'), fill: null } },
      ['i'],
      'document.invalid-field',
      '/nodes/i/fill',
    ],
    [
      'a node that names an instance as its parent',
      { s: symbol('s', 'p'), i: instance('i', 'p', 's'), r: rect('r', 'i') },
      ['s', 'i'],
      'document.dangling-reference',
      '/nodes/r/parent',
    ],
    [
      'a symbol with opacity other than 1',
      { s: { ...symbol('s', 'p'), opacity: 0.5 } },
      ['s'],
      'document.invalid-field',
      '/nodes/s/opacity',
    ],
    [
      'a symbol without stroke',
      { s: without(symbol('s', 'p'), 'stroke') },
      ['s'],
      'document.invalid-field',
      '/nodes/s/stroke',
    ],
    [
      'an instance inside a group inside a symbol',
      { s: symbol('s', 'p', ['g']), g: group('g', 's', ['i']), i: instance('i', 'g', 's') },
      ['s'],
      'document.invalid-symbol',
      '/nodes/i/parent',
    ],
  ])('rejects %s', (_name, nodes, children, code, at) => {
    expect(failure(validateDocument(document(nodes, children)))).toEqual({ code, path: at });
  });

  it('accepts an instance and a symbol inside groups and frames, and an empty symbol', () => {
    const value = document(
      {
        g: group('g', 'p', ['s', 'i']),
        s: symbol('s', 'g'),
        i: instance('i', 'g', 's'),
        f: { ...base('f', 'p'), type: 'frame', children: ['j'], fill: null, stroke: null },
        j: instance('j', 'f', 's'),
      },
      ['g', 'f'],
    );
    expect(validateDocument(value).ok).toBe(true);
  });
});

describe('M7-A01 check order (section 2)', () => {
  // Read at the latest version, as `validateDocument` takes it.
  const deep = async () => ({
    ...(JSON.parse(await read('m7-symbols/malformed/tree-depth-257.json')) as Loose & {
      pages: { children: string[] }[];
      nodes: Record<string, Record<string, unknown>>;
    }),
    schemaVersion: 4,
  });

  it.each<[string, Record<string, unknown>, string[], Failed]>([
    [
      'M7-S4 (a field rule) before M7-S2',
      { i: { ...instance('i', 'p', 'nope'), opacity: 0.5 } },
      ['i'],
      { code: 'document.invalid-field', path: '/nodes/i/opacity' },
    ],
    [
      'ownership before M7-S2',
      { r: rect('r', 'p'), i: instance('i', 'p', 'r') },
      ['r', 'i', 'r'],
      { code: 'document.dangling-reference', path: '/pages/0/children/2' },
    ],
    [
      'M7-S2 before the cycle walk',
      {
        r: rect('r', 'p'),
        i: instance('i', 'p', 'r'),
        a: group('a', 'b', ['b']),
        b: group('b', 'a', ['a']),
      },
      ['r', 'i'],
      { code: 'document.invalid-symbol', path: '/nodes/i/symbol' },
    ],
    [
      'the cycle walk before M7-S3',
      {
        s: symbol('s', 'p', ['i']),
        i: instance('i', 's', 's'),
        a: group('a', 'b', ['b']),
        b: group('b', 'a', ['a']),
      },
      ['s'],
      { code: 'document.cyclic-parent', path: '/nodes/a/parent' },
    ],
  ])('%s', (_name, nodes, children, expected) => {
    expect(failure(validateDocument(document(nodes, children)))).toEqual(expected);
  });

  it('M7-S3 before the M7-S5 tree depth', async () => {
    const value = await deep();
    value.nodes.s!.children = [...(value.nodes.s!.children as string[]), 'j'];
    value.nodes.j = instance('j', 's', 's');
    expect(failure(validateDocument(value))).toEqual({
      code: 'document.invalid-symbol',
      path: '/nodes/j/parent',
    });
  });

  it('the M7-S5 tree depth before the group rules', async () => {
    const value = await deep();
    value.pages[0]!.children.push('e');
    value.nodes.e = group('e', 'p', []);
    expect(failure(validateDocument(value))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/i/parent',
    });
    // Without the deep instance the group rule is the failure.
    const shallow = document({ e: group('e', 'p', []) }, ['e']);
    expect(failure(validateDocument(shallow))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/e/children',
    });
  });
});

describe('M7-A01 validateFragmentTree (section 6)', () => {
  // A holder at the latest version; the unsupported-version fixture keeps its version.
  const holder = async (name: string) => {
    const value = JSON.parse(await read(name)) as Loose;
    return value.schemaVersion === 3 ? { ...value, schemaVersion: 4 } : value;
  };

  it('skips M7-S2 and M7-S5 only, and returns a node map, never a document', async () => {
    for (const name of ['dangling-symbol', 'non-source-symbol', 'tree-depth-257']) {
      const value = await holder(`m7-symbols/malformed/${name}.json`);
      const result = validateFragmentTree(value);
      expect(result.ok, name).toBe(true);
      expect(result).not.toHaveProperty('document');
      expect(Object.keys(result).sort()).toEqual(['nodes', 'ok']);
      expect(result.ok && Object.keys(result.nodes).sort()).toEqual(
        Object.keys(value.nodes).sort(),
      );
    }
  });

  it('returns the same normalized nodes as validateDocument', async () => {
    const value = await holder(v4('symbols.v3.json'));
    const tree = validateFragmentTree(value);
    const full = validateDocument(value);
    expect(tree.ok && full.ok && tree.nodes).toEqual(full.ok && full.document.nodes);
  });

  it.each<[string, string, string, string]>([
    ['instance-in-symbol', 'M7-S3', 'document.invalid-symbol', '/nodes/i/parent'],
    ['symbol-in-symbol', 'M7-S3', 'document.invalid-symbol', '/nodes/t/parent'],
    ['instance-opacity', 'M7-S4', 'document.invalid-field', '/nodes/i/opacity'],
    ['unsupported-version', 'the version', 'document.unsupported-version', '/schemaVersion'],
  ])('still rejects %s (%s)', async (name, _rule, code, at) => {
    const value = await holder(`m7-symbols/malformed/${name}.json`);
    expect(failure(validateFragmentTree(value))).toEqual({ code, path: at });
  });

  it('still runs the base tree depth, the group rules, ownership and the v2 and v3 version check', () => {
    const nodes: Record<string, unknown> = {};
    let parent = 'p';
    for (let level = 0; level <= MAX_TREE_DEPTH; level += 1) {
      nodes[`g${level}`] = group(`g${level}`, parent, [
        level < MAX_TREE_DEPTH ? `g${level + 1}` : 'leaf',
      ]);
      parent = `g${level}`;
    }
    nodes.leaf = rect('leaf', parent);
    expect(failure(validateFragmentTree(document(nodes, ['g0'])))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/leaf/parent',
    });
    expect(failure(validateFragmentTree(document({ e: group('e', 'p', []) }, ['e'])))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/e/children',
    });
    expect(failure(validateFragmentTree(document({ r: rect('r', 'p') }, ['r', 'r'])))).toEqual({
      code: 'document.dangling-reference',
      path: '/pages/0/children/1',
    });
    for (const version of [2, 3]) {
      expect(
        failure(validateFragmentTree(document({ r: rect('r', 'p') }, ['r'], version))),
      ).toEqual({ code: 'document.unsupported-version', path: '/schemaVersion' });
    }
  });
});

describe('M7-A01 validateNode on v3 nodes', () => {
  it('accepts a symbol and an instance and applies M7-S4', () => {
    expect(validateNode(symbol('s', 'p')).ok).toBe(true);
    expect(validateNode(instance('i', 'p', 's'))).toEqual({
      ok: true,
      node: instance('i', 'p', 's'),
    });
    expect(validateNode({ ...instance('i', 'p', 's'), opacity: 0 })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/opacity',
    });
  });
});
