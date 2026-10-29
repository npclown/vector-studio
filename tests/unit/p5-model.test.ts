import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DOCUMENT_ERROR_CODES,
  isValidId,
  MAX_DEPTH,
  parseDocument,
  serializeDocument,
  validateAnyDocument,
  validateNode,
  type DocumentV3,
  type ParseResult,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
import { boundaries, evaluatePackageBoundaries } from '../../tooling/boundary-policy.mjs';

// P5-U1 (P5 editor-slice plan, sections 3 and 7): P5-A06 to P5-A08 for the document model. Since
// MVP M1-U2 the model reads schema v1 and v2 and returns and writes v2 (M1 contract, section
// 2.1): the v1 fixtures here parse to v2, so their round trip goes through the committed v2
// fixtures of tests/fixtures/m1-model, and the in-memory v1 cases use `validateAnyDocument`.

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(root, 'tests/fixtures/p5-model');
const migrated = path.join(root, 'tests/fixtures/m7-symbols/migrated');
const VALID = ['empty', 'shapes', 'ext-star'] as const;

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtures, `${name}.json`), 'utf8');
}

// Since M7-U1 a v1 document migrates through v2 to the committed v3 fixture (M7 contract,
// section 2.1).
async function migratedFixture(name: string): Promise<string> {
  return readFile(path.join(migrated, `${name}.v3.json`), 'utf8');
}

function parsed(text: string): DocumentV3 {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function failure(result: ParseResult): { code: string; path: string } {
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('document');
  return result.ok ? { code: 'none', path: '' } : { code: result.code, path: result.path };
}

const black = { r: 0, g: 0, b: 0, a: 1 };

function smallDocument(): Record<string, unknown> {
  return structuredClone({
    schemaVersion: 1,
    id: 'd',
    pages: [{ id: 'p', name: 'Page', children: ['a', 'b'] }],
    nodes: {
      a: {
        id: 'a',
        name: 'A',
        parent: 'p',
        frame: { x: 1, y: 2, width: 3, height: 4 },
        opacity: 1,
        visible: true,
        type: 'rectangle',
        fill: black,
        stroke: null,
      },
      b: {
        id: 'b',
        name: 'B',
        parent: 'p',
        frame: { x: 0, y: 0, width: 10, height: 10 },
        opacity: 0.5,
        visible: false,
        type: 'path',
        path: { verbs: ['move', 'line', 'close'], points: [0, 0, 1, 1], fillRule: 'nonzero' },
        fill: null,
        stroke: { color: black, width: 1, cap: 'butt', join: 'miter', miterLimit: 4 },
      },
    },
  });
}

function customNode(data: unknown): Record<string, unknown> {
  return {
    id: 'c',
    name: 'C',
    parent: 'p',
    frame: { x: 0, y: 0, width: 1, height: 1 },
    opacity: 1,
    visible: true,
    type: 'custom',
    customType: 'ext.test',
    data,
    fill: null,
    stroke: null,
  };
}

/** `values` with a hole at `index`, as a sparse array. */
function holed(values: unknown[], index: number): unknown[] {
  const copy = new Array<unknown>(values.length);
  values.forEach((value, at) => {
    if (at !== index) copy[at] = value;
  });
  return copy;
}

type Edit =
  | readonly ['set', string, unknown]
  | readonly ['delete', string]
  | readonly ['push', string, unknown];

/** A copy of `smallDocument()` with each edit applied at its JSON Pointer. */
function edited(...edits: readonly Edit[]): Record<string, unknown> {
  const doc = smallDocument();
  for (const edit of edits) {
    const parts = edit[1].split('/').slice(1);
    const last = parts.pop()!;
    let target = doc;
    for (const part of parts) target = target[part] as Record<string, unknown>;
    if (edit[0] === 'set') target[last] = edit[2];
    else if (edit[0] === 'delete') delete target[last];
    else (target[last] as unknown[]).push(edit[2]);
  }
  return doc;
}

describe('P5-A06 JSON round trip', () => {
  it.each(VALID)(
    'serialize(parse(t)) is the committed v3 fixture and parse(serialize(d)) deep-equals d for %s',
    async (name) => {
      const text = await fixture(name);
      const document = parsed(text);
      const v3 = await migratedFixture(name);
      expect(serializeDocument(document)).toBe(v3);
      expect(serializeDocument(parsed(v3))).toBe(v3);
      expect(parsed(serializeDocument(document))).toEqual(document);
    },
  );

  it('preserves IDs, frames, path data and paint order', async () => {
    const shapes = parsed(await fixture('shapes'));
    expect(shapes.id).toBe('doc-shapes');
    expect(shapes.pages[0]!.children).toEqual(['r1', 'r2', 'p1', 'p2', 'r3']);
    expect(Object.keys(shapes.nodes).sort()).toEqual(['p1', 'p2', 'r1', 'r2', 'r3']);
    expect(shapes.nodes.r2?.frame).toEqual({ x: -30.5, y: 0, width: 0, height: 12.25 });
    expect(shapes.nodes.r3?.frame).toEqual({ x: 1e-7, y: 123456.789, width: 0.1, height: 0.3 });
    const p2 = shapes.nodes.p2;
    expect(p2?.type === 'path' && p2.path).toEqual({
      verbs: ['move', 'cubic', 'move', 'line'],
      points: [0, 0, 0.25, 0, 0.75, 0, 1, 0, 0, 0, 0.1, 0],
      fillRule: 'evenodd',
    });
  });

  it('round-trips the ext.star custom node as opaque data', async () => {
    const star = parsed(await fixture('ext-star'));
    expect(star.pages[0]!.children).toEqual(['n10', 'n2']);
    const node = star.nodes.n2;
    expect(node?.type === 'custom' && [node.customType, node.data]).toEqual([
      'ext.star',
      { innerRatio: 0.5, points: 5 },
    ]);
  });

  it('emits keys in the fixed order, independent of input order', () => {
    const document = smallDocument();
    const reordered = {
      nodes: Object.fromEntries(Object.entries(document.nodes as object).reverse()),
      pages: document.pages,
      id: document.id,
      schemaVersion: 1,
    };
    const a = validateAnyDocument(document);
    const b = validateAnyDocument(reordered);
    if (!a.ok || !b.ok) throw new Error('fixture invalid');
    const text = serializeDocument(a.document);
    expect(serializeDocument(b.document)).toBe(text);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'schemaVersion',
      'id',
      'pages',
      'nodes',
    ]);
    expect(Object.keys((JSON.parse(text) as { nodes: { b: object } }).nodes.b)).toEqual([
      'id',
      'name',
      'parent',
      'frame',
      'rotation',
      'constraints',
      'opacity',
      'visible',
      'type',
      'path',
      'fill',
      'stroke',
    ]);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('normalizes negative zero, including inside custom data', () => {
    const text = JSON.stringify(
      edited(['set', '/nodes/c', customNode({ nested: [0] })], ['push', '/pages/0/children', 'c']),
    )
      .replace('"x":1', '"x":-0')
      .replace('"nested":[0]', '"nested":[-0]');
    const document = parsed(text);
    expect(Object.is(document.nodes.a?.frame.x, 0)).toBe(true);
    expect(serializeDocument(document)).toContain('"x": 0,');
    const custom = document.nodes.c;
    const nested = custom?.type === 'custom' ? (custom.data as { nested: number[] }).nested : [];
    expect(Object.is(nested[0], 0)).toBe(true);
  });

  it('keeps a "__proto__" ID as data', () => {
    const text = JSON.stringify(smallDocument())
      .replace('"a":{"id":"a"', '"__proto__":{"id":"__proto__"')
      .replace('"children":["a"', '"children":["__proto__"');
    const document = parsed(text);
    expect(Object.hasOwn(document.nodes, '__proto__')).toBe(true);
    expect(serializeDocument(parsed(serializeDocument(document)))).toBe(
      serializeDocument(document),
    );
  });

  it('returns a copy that shares nothing with the input', () => {
    const input = smallDocument();
    const result = validateAnyDocument(input);
    if (!result.ok) throw new Error('fixture invalid');
    const nodes = input.nodes as Record<string, { frame: object }>;
    expect(result.document.nodes.a?.frame).toEqual(nodes.a?.frame);
    expect(result.document.nodes.a?.frame).not.toBe(nodes.a?.frame);
    expect(result.document.pages[0]).not.toBe((input.pages as object[])[0]);
  });
});

describe('P5-A07 validation codes', () => {
  it('lists the section 3.3 codes, the two schema v2 codes of MVP M1 and the v3 code of M7', () => {
    expect(DOCUMENT_ERROR_CODES).toEqual([
      'document.malformed-json',
      'document.unsupported-version',
      'document.invalid-field',
      'document.duplicate-id',
      'document.dangling-reference',
      'document.unknown-custom-type',
      'document.invalid-custom-data',
      'document.cyclic-parent',
      'document.invalid-mask-source',
      'document.invalid-symbol',
    ]);
  });

  it.each([
    ['malformed-json', 'document.malformed-json', ''],
    ['unsupported-version', 'document.unsupported-version', '/schemaVersion'],
    ['invalid-field', 'document.invalid-field', '/nodes/r2/opacity'],
    ['duplicate-id', 'document.duplicate-id', '/nodes/r1'],
    ['dangling-reference', 'document.dangling-reference', '/pages/0/children/4'],
  ])('returns its code for the %s fixture', async (name, code, at) => {
    expect(failure(parseDocument(await fixture(`malformed/${name}`)))).toEqual({ code, path: at });
  });

  it('covers exactly the model codes with committed fixtures', async () => {
    const names = (await readdir(path.join(fixtures, 'malformed'))).sort();
    expect(names.map((name) => `document.${name.replace(/\.json$/u, '')}`)).toEqual(
      DOCUMENT_ERROR_CODES.slice(0, 5).slice().sort(),
    );
  });

  it.each<[string, Edit[], string, string]>([
    [
      'schemaVersion missing',
      [['delete', '/schemaVersion']],
      'unsupported-version',
      '/schemaVersion',
    ],
    [
      'schemaVersion "1"',
      [['set', '/schemaVersion', '1']],
      'unsupported-version',
      '/schemaVersion',
    ],
    [
      'schemaVersion 1.5',
      [['set', '/schemaVersion', 1.5]],
      'unsupported-version',
      '/schemaVersion',
    ],
    ['unknown top-level field', [['set', '/selection', []]], 'invalid-field', '/selection'],
    ['unknown node field', [['set', '/nodes/a/rotation', 0]], 'invalid-field', '/nodes/a/rotation'],
    ['missing node field', [['delete', '/nodes/a/visible']], 'invalid-field', '/nodes/a/visible'],
    ['missing stroke', [['delete', '/nodes/a/stroke']], 'invalid-field', '/nodes/a/stroke'],
    ['empty document id', [['set', '/id', '']], 'invalid-field', '/id'],
    [
      'two pages',
      [['push', '/pages', { id: 'q', name: '', children: [] }]],
      'invalid-field',
      '/pages',
    ],
    ['node id differs from key', [['set', '/nodes/a/id', 'z']], 'invalid-field', '/nodes/a/id'],
    ['unknown node type', [['set', '/nodes/a/type', 'ellipse']], 'invalid-field', '/nodes/a/type'],
    [
      'negative width',
      [['set', '/nodes/a/frame/width', -1]],
      'invalid-field',
      '/nodes/a/frame/width',
    ],
    ['color above 1', [['set', '/nodes/a/fill/g', 1.01]], 'invalid-field', '/nodes/a/fill/g'],
    [
      'miter limit below 1',
      [['set', '/nodes/b/stroke/miterLimit', 0.5]],
      'invalid-field',
      '/nodes/b/stroke/miterLimit',
    ],
    [
      'unknown cap',
      [['set', '/nodes/b/stroke/cap', 'flat']],
      'invalid-field',
      '/nodes/b/stroke/cap',
    ],
    [
      'rectangle with a path stroke',
      [
        [
          'set',
          '/nodes/a/stroke',
          { color: black, width: 1, cap: 'butt', join: 'miter', miterLimit: 4 },
        ],
      ],
      'invalid-field',
      '/nodes/a/stroke/cap',
    ],
    [
      'point outside the unit box',
      [['set', '/nodes/b/path/points/2', 1.5]],
      'invalid-field',
      '/nodes/b/path/points/2',
    ],
    [
      'point count mismatch',
      [['push', '/nodes/b/path/points', 0]],
      'invalid-field',
      '/nodes/b/path/points',
    ],
    [
      'line before move',
      [['set', '/nodes/b/path/verbs/0', 'line']],
      'invalid-field',
      '/nodes/b/path/verbs/0',
    ],
    [
      'line after close',
      [['push', '/nodes/b/path/verbs', 'line']],
      'invalid-field',
      '/nodes/b/path/verbs/3',
    ],
    [
      'unknown fill rule',
      [['set', '/nodes/b/path/fillRule', 'odd']],
      'invalid-field',
      '/nodes/b/path/fillRule',
    ],
    [
      'page id equals a node id',
      [
        ['set', '/pages/0/id', 'a'],
        ['set', '/nodes/a/parent', 'a'],
        ['set', '/nodes/b/parent', 'a'],
      ],
      'duplicate-id',
      '/nodes/a',
    ],
    [
      'parent names nothing',
      [['set', '/nodes/a/parent', 'x']],
      'dangling-reference',
      '/nodes/a/parent',
    ],
    [
      'parent is another node',
      [['set', '/nodes/a/parent', 'b']],
      'dangling-reference',
      '/nodes/a/parent',
    ],
    [
      'node in no children list',
      [['set', '/pages/0/children', ['a']]],
      'dangling-reference',
      '/nodes/b/parent',
    ],
    [
      'child listed twice',
      [['push', '/pages/0/children', 'a']],
      'dangling-reference',
      '/pages/0/children/2',
    ],
    [
      'child "__proto__" names no node',
      [['set', '/pages/0/children/0', '__proto__']],
      'dangling-reference',
      '/pages/0/children/0',
    ],
  ])('%s', (_label, edits, code, at) => {
    expect(failure(validateAnyDocument(edited(...edits)))).toEqual({
      code: `document.${code}`,
      path: at,
    });
  });

  it('rejects a duplicate key outside nodes as invalid-field', () => {
    const text = JSON.stringify(smallDocument()).replace('"x":1,', '"x":1,"x":2,');
    expect(failure(parseDocument(text))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/a/frame/x',
    });
  });

  it.each([
    ['an escaped equal key', '{"k":1,"\\u006b":2}', 'invalid-field', '/nodes/c/data/k'],
    ['an escaped node ID', null, 'duplicate-id', '/nodes/a'],
    ['braces, commas and quotes inside strings', '{"s":"{,}[\\"]","t":"\\\\","s2":"}"}', null, ''],
    ['empty containers', '{"a":{},"b":[],"c":[{},[]],"d":{"a":[]}}', null, ''],
    [
      'the same key in sibling objects',
      '{"a":{"z":1},"b":{"z":1},"q":[{"z":1},{"z":2}]}',
      null,
      '',
    ],
    [
      'a repeat inside an array element',
      '{"q":[{},{},{"z":1,"z":2}]}',
      'invalid-field',
      '/nodes/c/data/q/2/z',
    ],
  ])('scans %s', (_label, data, code, at) => {
    let text: string;
    if (data === null) {
      text = JSON.stringify(smallDocument()).replace('"b":{"id":"b"', '"\\u0061":{"id":"a"');
    } else {
      const doc = edited(['set', '/nodes/c', customNode(0)], ['push', '/pages/0/children', 'c']);
      text = JSON.stringify(doc).replace('"data":0', `"data":${data}`);
      expect(() => JSON.parse(text) as unknown).not.toThrow();
    }
    const result = parseDocument(text);
    if (code === null) expect(result.ok).toBe(true);
    else expect(failure(result)).toEqual({ code: `document.${code}`, path: at });
  });

  it('rejects nesting deeper than MAX_DEPTH in text, in linear time', () => {
    const doc = edited(['set', '/nodes/c', customNode(0)], ['push', '/pages/0/children', 'c']);
    const deep = (n: number) =>
      JSON.stringify(doc).replace('"data":0', `"data":${'['.repeat(n)}${']'.repeat(n)}`);
    // The document, nodes and node objects are three levels above the data.
    expect(parseDocument(deep(MAX_DEPTH - 3)).ok).toBe(true);
    const tooDeep = failure(parseDocument(deep(MAX_DEPTH - 2)));
    expect(tooDeep.code).toBe('document.invalid-field');
    expect(tooDeep.path).toBe(`/nodes/c/data${'/0'.repeat(MAX_DEPTH - 3)}`);
    expect(failure(parseDocument(deep(20000))).code).toBe('document.invalid-field');
  });

  it('rejects deep or cyclic in-memory custom data', () => {
    let nested: unknown = 0;
    for (let i = 0; i < 10000; i += 1) nested = [nested];
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    for (const data of [nested, cyclic]) {
      const doc = edited(['set', '/nodes/c', customNode(data)], ['push', '/pages/0/children', 'c']);
      expect(failure(validateAnyDocument(doc)).code).toBe('document.invalid-field');
    }
  });

  it.each<[string, Edit[], string]>([
    ['points', [['set', '/nodes/b/path/points', new Array(4)]], '/nodes/b/path/points/0'],
    ['children', [['set', '/pages/0/children', holed(['a', 'x', 'b'], 1)]], '/pages/0/children/1'],
    [
      'verbs',
      [['set', '/nodes/b/path/verbs', holed(['move', 'line', 'close'], 1)]],
      '/nodes/b/path/verbs/1',
    ],
  ])('rejects a sparse %s array', (_label, edits, at) => {
    expect(failure(validateAnyDocument(edited(...edits)))).toEqual({
      code: 'document.invalid-field',
      path: at,
    });
  });

  it('rejects sparse custom data', () => {
    const doc = edited(
      ['set', '/nodes/c', customNode(holed([1, 0, 2], 1))],
      ['push', '/pages/0/children', 'c'],
    );
    expect(failure(validateAnyDocument(doc))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/c/data/1',
    });
  });

  it('rejects an empty node key', () => {
    const text = JSON.stringify(smallDocument()).replace('"a":{"id":"a"', '"":{"id":""');
    expect(failure(parseDocument(text))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes//id',
    });
  });

  it('rejects a non-object document and non-JSON custom data', () => {
    expect(failure(parseDocument('[]'))).toEqual({ code: 'document.invalid-field', path: '' });
    const doc = edited(
      ['set', '/nodes/c', customNode({ f: () => 0 })],
      ['push', '/pages/0/children', 'c'],
    );
    expect(failure(validateAnyDocument(doc))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/c/data/f',
    });
  });

  it('accepts only non-empty string IDs', () => {
    expect([isValidId('a'), isValidId(''), isValidId(1), isValidId(null)]).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('validateNode', () => {
  it('applies the document field rules to one v2 node', () => {
    const node = {
      ...(smallDocument().nodes as Record<string, Record<string, unknown>>).a!,
      rotation: 0,
      constraints: { horizontal: 'start', vertical: 'start' },
      cornerRadii: [0, 0, 0, 0],
    };
    const result = validateNode(node);
    expect(result.ok && result.node).toEqual(node);
    expect(failure(validateNode({ ...node, opacity: 2 }) as ParseResult)).toEqual({
      code: 'document.invalid-field',
      path: '/opacity',
    });
    expect(failure(validateNode({ ...node, id: '' }) as ParseResult)).toEqual({
      code: 'document.invalid-field',
      path: '/id',
    });
  });
});

describe('P5-A08 no session state in the document', () => {
  const FORBIDDEN =
    /selection|viewport|camera|zoom|history|undo|redo|cache|mesh|hover|tool|revision/iu;

  function keys(value: unknown, into: Set<string>): Set<string> {
    if (Array.isArray(value)) value.forEach((entry) => keys(entry, into));
    else if (typeof value === 'object' && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        into.add(key);
        // Custom data keys belong to the extension; only the schema's keys are checked.
        if (key !== 'data' && key !== 'nodes') keys(entry, into);
        if (key === 'nodes') Object.values(entry as object).forEach((node) => keys(node, into));
      }
    }
    return into;
  }

  it.each(VALID)('serialized %s has only schema keys', async (name) => {
    const text = serializeDocument(parsed(await fixture(name)));
    const found = [...keys(JSON.parse(text), new Set())];
    expect(found.filter((key) => FORBIDDEN.test(key))).toEqual([]);
    const schema = new Set(
      'schemaVersion id pages nodes name children parent frame x y width height rotation constraints horizontal vertical opacity visible type cornerRadii fill stroke color r g b a cap join miterLimit path verbs points fillRule customType data'.split(
        ' ',
      ),
    );
    expect(found.filter((key) => !schema.has(key))).toEqual([]);
  });
});

describe('P5-U1 model package boundary', () => {
  const policy = boundaries as Map<string, Set<string>>;
  const evaluate = evaluatePackageBoundaries as (input: {
    manifest: { name: string; dependencies?: Record<string, string> };
    sources: { path: string; text: string }[];
    packageRoots: Map<string, string>;
  }) => string[];
  const packageRoots = new Map([
    ['@vector-studio/model', path.join(root, 'packages/model')],
    ['@vector-studio/contracts', path.join(root, 'packages/contracts')],
  ]);

  it('allows the model no workspace dependency', () => {
    expect([...policy.get('@vector-studio/model')!]).toEqual([]);
  });

  it('rejects a seeded model -> contracts edge', () => {
    const source = {
      path: path.join(root, 'packages/model/src/seeded.ts'),
      text: "import type { SceneColor } from '@vector-studio/contracts';\n",
    };
    expect(
      evaluate({
        manifest: {
          name: '@vector-studio/model',
          dependencies: { '@vector-studio/contracts': 'workspace:*' },
        },
        sources: [source],
        packageRoots,
      }),
    ).toEqual([
      '@vector-studio/model: manifest dependency on @vector-studio/contracts is forbidden',
      `${source.path}: source import of @vector-studio/contracts is forbidden`,
    ]);
  });

  it('imports only its own modules', async () => {
    const directory = path.join(root, 'packages/model/src');
    for (const name of await readdir(directory)) {
      const text = await readFile(path.join(directory, name), 'utf8');
      for (const match of text.matchAll(/(?:from\s+|import\s*\(?\s*)['"]([^'"]+)['"]/gu)) {
        expect(match[1], name).toMatch(/^\.\/[\w-]+\.js$/u);
      }
    }
  });
});
