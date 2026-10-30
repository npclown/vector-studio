import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  isValidId,
  MAX_TREE_DEPTH,
  migrateV1toV2,
  normalizeRotation,
  parseDocument,
  serializeDocument,
  validateAnyDocument,
  validateDocument,
  validateNode,
  type DocumentV1,
  type DocumentV6,
  type ParseResult,
  type ParseResultV2,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';

// MVP M1-U1 (M1 contract, section 2): schema v2, the v1 migration and the new codes
// (M1-A01 model half, M1-A02). Since M1-U2 `parseDocument`, `validateDocument`,
// `validateNode` and `serializeDocument` have the section 2.1 meaning. Since M7-U1 they return
// and write schema v3, since M6a-U1 schema v4 and since M7-U7 schema v5, which differs from v2 in
// its version only for these fixtures, which hold no instance (M7 contract, section 2.1; M6a
// contract, sections 2.1 and 9), so a v2 fixture read as its committed v5 migration under
// `m7-symbols/migrated`. Since M4-U1 they return and write schema v6, whose strokes gain the
// M4-M1 keys (M4 contract, section 2.1), so a v2 fixture reads as its committed v6 migration
// under `m4-appearance/migrated`.

const root = path.resolve(import.meta.dirname, '../..');
const p5 = path.join(root, 'tests/fixtures/p5-model');
const m1 = path.join(root, 'tests/fixtures/m1-model');
const m7 = path.join(root, 'tests/fixtures/m7-symbols/migrated');
const m6 = path.join(root, 'tests/fixtures/m6-text/migrated');
const m4 = path.join(root, 'tests/fixtures/m4-appearance/migrated');
const v6Name = (name: string) => `${name.replace(/\.v2$/, '')}.v6`;
// Every top-level v1 fixture has a migrated v2 fixture.
const MIGRATED = (await readdir(p5, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  .map((entry) => entry.name.replace(/\.json$/, ''))
  .sort();

function read(dir: string, name: string): Promise<string> {
  return readFile(path.join(dir, `${name}.json`), 'utf8');
}

function parsed(text: string): DocumentV6 {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function failure(result: ParseResult | ParseResultV2): { code: string; path: string } {
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('document');
  return result.ok ? { code: 'none', path: '' } : { code: result.code, path: result.path };
}

const START = { horizontal: 'start', vertical: 'start' } as const;

function base(id: string, parent: string) {
  return {
    id,
    name: id,
    parent,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
  };
}

function rect(id: string, parent: string) {
  return {
    ...base(id, parent),
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fill: null,
    stroke: null,
  };
}

/** A chain of `depth` nested groups on one page, with a rectangle at the bottom. */
function chain(depth: number): Record<string, unknown> {
  const nodes: Record<string, unknown> = {};
  let parent = 'p';
  for (let level = 0; level < depth; level += 1) {
    const id = `g${level}`;
    nodes[id] = {
      ...base(id, parent),
      type: 'group',
      children: [level + 1 < depth ? `g${level + 1}` : 'leaf'],
    };
    parent = id;
  }
  nodes.leaf = rect('leaf', parent);
  return {
    schemaVersion: 2,
    id: 'd',
    pages: [{ id: 'p', name: 'P', children: [depth > 0 ? 'g0' : 'leaf'] }],
    nodes,
  };
}

describe('M1-A01 migration and round trip', () => {
  it.each(MIGRATED)(
    'migrates the v1 fixture %s byte for byte to its committed v2 fixture',
    async (name) => {
      const v1 = await read(p5, name);
      const v2 = await read(m1, `${name}.v2`);
      expect(serializeDocument(parsed(v1))).toBe(await read(m4, v6Name(name)));
      const migrated = migrateV1toV2(JSON.parse(v1) as DocumentV1);
      expect(migrated.ok && migrated.document).toEqual(JSON.parse(v2));
    },
  );

  it.each([...MIGRATED.map((name) => `${name}.v2`), 'containers'])(
    'reads the v2 fixture %s as its v6 migration, which round-trips',
    async (name) => {
      const text = await read(m1, name);
      const document = parsed(text);
      expect(serializeDocument(document)).toBe(await read(m4, v6Name(name)));
      expect(parsed(serializeDocument(document))).toEqual(document);
    },
  );

  it('covers every v2 node type, several pages and a custom node inside a group in a frame', async () => {
    const document = parsed(await read(m1, 'containers'));
    const types = new Set(Object.values(document.nodes).map((node) => node.type));
    expect([...types].sort()).toEqual(
      ['custom', 'ellipse', 'frame', 'group', 'line', 'maskGroup', 'path', 'rectangle'].sort(),
    );
    expect(document.pages).toHaveLength(2);
    const star = document.nodes.star!;
    expect(star.type).toBe('custom');
    expect(document.nodes[star.parent]!.type).toBe('group');
    expect(document.nodes[document.nodes[star.parent]!.parent]!.type).toBe('frame');
  });

  it('adds only rotation, constraints and rectangle corner radii', async () => {
    const v1 = JSON.parse(await read(p5, 'shapes')) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    const v2 = JSON.parse(await read(m1, 'shapes.v2')) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    for (const [key, node] of Object.entries(v2.nodes)) {
      const { rotation, constraints, cornerRadii, ...rest } = node;
      expect(rotation).toBe(0);
      expect(constraints).toEqual(START);
      expect(cornerRadii).toEqual(node.type === 'rectangle' ? [0, 0, 0, 0] : undefined);
      expect(rest).toEqual(v1.nodes[key]);
    }
  });

  it('validates in-memory v6 only through validateDocument', async () => {
    const v1 = JSON.parse(await read(p5, 'shapes')) as unknown;
    const v2 = JSON.parse(await read(m1, 'shapes.v2')) as unknown;
    const v3 = JSON.parse(await read(m7, 'shapes.v3')) as unknown;
    const v4 = JSON.parse(await read(m6, 'shapes.v4')) as unknown;
    const v5 = JSON.parse(await read(m7, 'shapes.v5')) as unknown;
    const v6 = await read(m4, 'shapes.v6');
    for (const old of [v1, v2, v3, v4, v5]) {
      expect(failure(validateDocument(old))).toEqual({
        code: 'document.unsupported-version',
        path: '/schemaVersion',
      });
    }
    const result = validateDocument(JSON.parse(v6));
    expect(result.ok && serializeDocument(result.document)).toBe(v6);
  });

  it('accepts in-memory v1 and v2 values through validateAnyDocument', async () => {
    const v1 = JSON.parse(await read(p5, 'shapes')) as unknown;
    const v2 = JSON.parse(await read(m1, 'shapes.v2')) as unknown;
    const fromV1 = validateAnyDocument(v1);
    const fromV2 = validateAnyDocument(v2);
    expect(fromV1.ok && fromV2.ok && fromV1.document).toEqual(fromV2.ok && fromV2.document);
  });
});

describe('M1-A02 malformed v2 documents', () => {
  const expected: Record<string, [string, string]> = {
    'container-opacity': ['document.invalid-field', '/nodes/g1/opacity'],
    'cyclic-parent': ['document.cyclic-parent', '/nodes/f1/parent'],
    'dangling-container-child': ['document.dangling-reference', '/nodes/g1/children/2'],
    'duplicate-page-id': ['document.duplicate-id', '/pages/1/id'],
    'empty-group': ['document.invalid-field', '/nodes/g2/children'],
    'invalid-mask-source': ['document.invalid-mask-source', '/nodes/mg1/children/0'],
    'line-points': ['document.invalid-field', '/nodes/l1/points/2'],
    'nul-id': ['document.invalid-field', '/id'],
    'unsupported-version': ['document.unsupported-version', '/schemaVersion'],
  };

  it('has one committed fixture per case', async () => {
    const names = (await readdir(path.join(m1, 'malformed'))).map((file) =>
      file.replace(/\.json$/, ''),
    );
    expect(names.sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s fails with its code and path', async (name, [code, at]) => {
    const text = await read(path.join(m1, 'malformed'), name);
    expect(failure(parseDocument(text))).toEqual({ code, path: at });
    expect(failure(validateAnyDocument(JSON.parse(text)))).toEqual({ code, path: at });
  });

  it('fails the migration of a v1 document with U+0000 in an ID', async () => {
    const v1 = JSON.parse(await read(p5, 'shapes')) as {
      pages: { id: string }[];
      nodes: Record<string, { parent: string }>;
    };
    const page = 'page\u00001';
    v1.pages[0]!.id = page;
    for (const node of Object.values(v1.nodes)) node.parent = page;
    expect(failure(parseDocument(JSON.stringify(v1)))).toEqual({
      code: 'document.invalid-field',
      path: '/pages/0/id',
    });
    expect(failure(migrateV1toV2(v1 as unknown as DocumentV1))).toEqual({
      code: 'document.invalid-field',
      path: '/pages/0/id',
    });
    expect([isValidId('a'), isValidId('a\u0000b')]).toEqual([true, false]);
  });

  it(`allows a tree depth of ${MAX_TREE_DEPTH} and rejects one more`, () => {
    expect(validateAnyDocument(chain(MAX_TREE_DEPTH)).ok).toBe(true);
    expect(failure(validateAnyDocument(chain(MAX_TREE_DEPTH + 1)))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/leaf/parent',
    });
  });

  it('rejects a mask group whose first child is not a path, and a document without pages', () => {
    const document = {
      schemaVersion: 2,
      id: 'd',
      pages: [{ id: 'p', name: 'P', children: ['m'] }],
      nodes: { m: { ...base('m', 'p'), type: 'maskGroup', children: ['r'] }, r: rect('r', 'm') },
    };
    expect(failure(validateAnyDocument(document))).toEqual({
      code: 'document.invalid-mask-source',
      path: '/nodes/m/children/0',
    });
    expect(failure(validateAnyDocument({ ...document, pages: [] }))).toEqual({
      code: 'document.invalid-field',
      path: '/pages',
    });
  });

  it('rejects a parent that is a leaf and a v1 field missing from a v2 node', () => {
    const leafParent = {
      schemaVersion: 2,
      id: 'd',
      pages: [{ id: 'p', name: 'P', children: ['a'] }],
      nodes: { a: rect('a', 'p'), b: rect('b', 'a') },
    };
    expect(failure(validateAnyDocument(leafParent))).toEqual({
      code: 'document.dangling-reference',
      path: '/nodes/b/parent',
    });
    const withoutRotation: Record<string, unknown> = { ...rect('a', 'p') };
    delete withoutRotation.rotation;
    expect(failure(validateAnyDocument({ ...leafParent, nodes: { a: withoutRotation } }))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/a/rotation',
    });
  });
});

describe('rotation normalization (M1-S1)', () => {
  it.each([
    [0, 0],
    [-0, 0],
    [Math.PI, Math.PI],
    [-Math.PI, Math.PI],
    [3 * Math.PI, Math.PI],
    [Math.PI / 2, Math.PI / 2],
    [2 * Math.PI, 0],
  ])('normalizes %f to %f', (input, output) => {
    expect(Object.is(normalizeRotation(input), output)).toBe(true);
  });

  it('keeps every result in (−π, π] and is idempotent', () => {
    for (let index = -1000; index <= 1000; index += 1) {
      const t = normalizeRotation(index * 0.37);
      expect(t > -Math.PI && t <= Math.PI).toBe(true);
      expect(normalizeRotation(t)).toBe(t);
    }
  });

  it('normalizes rotation on parse and rejects a non-finite one in a node', () => {
    const node = { ...rect('a', 'p'), rotation: 4 * Math.PI + 1 };
    const result = validateNode(node);
    expect(result.ok && result.node.rotation).toBeCloseTo(1, 12);
    expect(validateNode({ ...node, rotation: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/rotation',
    });
  });
});

// A loosely typed view of a fixture, for mutating it into malformed cases.
type LooseNode = Record<string, unknown> & {
  children: unknown[];
  constraints: Record<string, unknown>;
  cornerRadii: unknown[];
};
type LooseDocument = {
  pages: (Record<string, unknown> & { children: unknown[] })[];
  nodes: Record<string, LooseNode>;
};

describe('M1-A02 field and tree rules, inline cases', () => {
  async function containers(): Promise<LooseDocument> {
    return JSON.parse(await read(m1, 'containers')) as LooseDocument;
  }

  const at = (d: LooseDocument, id: string): LooseNode => d.nodes[id]!;

  it.each<[string, (d: LooseDocument) => void, string, string]>([
    [
      'a negative corner radius',
      (d) => (at(d, 'r1').cornerRadii[2] = -1),
      'document.invalid-field',
      '/nodes/r1/cornerRadii/2',
    ],
    [
      'an unknown constraint',
      (d) => (at(d, 'r1').constraints.vertical = 'middle'),
      'document.invalid-field',
      '/nodes/r1/constraints/vertical',
    ],
    [
      'an unknown key in constraints',
      (d) => (at(d, 'r1').constraints.extra = 'start'),
      'document.invalid-field',
      '/nodes/r1/constraints/extra',
    ],
    [
      'an unknown arrow',
      (d) => (at(d, 'l1').endArrow = 'circle'),
      'document.invalid-field',
      '/nodes/l1/endArrow',
    ],
    [
      'an unknown page key',
      (d) => (d.pages[1]!.extra = 1),
      'document.invalid-field',
      '/pages/1/extra',
    ],
    [
      'U+0000 in a node key',
      (d) => {
        d.nodes['e\u00001'] = { ...at(d, 'e1'), id: 'e\u00001' };
        delete d.nodes.e1;
        d.pages[0]!.children[2] = 'e\u00001';
      },
      'document.invalid-field',
      '/pages/0/children/2',
    ],
    [
      'U+0000 in a children entry',
      (d) => (at(d, 'g1').children[0] = 'e\u00002'),
      'document.invalid-field',
      '/nodes/g1/children/0',
    ],
    [
      'a node in a page and a container',
      (d) => d.pages[0]!.children.push('e2'),
      'document.dangling-reference',
      '/nodes/g1/children/0',
    ],
    [
      'an empty mask group',
      (d) => {
        at(d, 'mg1').children = [];
        at(d, 'm-src').parent = 'f1';
        at(d, 'm-r').parent = 'f1';
        at(d, 'f1').children.push('m-src', 'm-r');
      },
      'document.invalid-field',
      '/nodes/mg1/children',
    ],
    [
      'a sparse children array',
      (d) => (d.pages[1]!.children = new Array<unknown>(1)),
      'document.invalid-field',
      '/pages/1/children/0',
    ],
  ])('rejects %s', async (_name, mutate, code, path) => {
    const document = await containers();
    mutate(document);
    expect(failure(validateAnyDocument(document))).toEqual({ code, path });
  });

  it('rejects a duplicate node key and nesting deeper than the text bound', async () => {
    const text = await read(m1, 'containers');
    const duplicated = text.replace('"r3": {', '"r3": {"id": "r3"}, "r3": {');
    expect(failure(parseDocument(duplicated))).toEqual({
      code: 'document.duplicate-id',
      path: '/nodes/r3',
    });
    const deep = `${'['.repeat(300)}${']'.repeat(300)}`;
    const nested = text.replace('"points": 5', `"points": 5, "deep": ${deep}`);
    expect(failure(parseDocument(nested)).code).toBe('document.invalid-field');
  });

  it('writes negative zero as 0', async () => {
    const document = await containers();
    at(document, 'r1').rotation = -0;
    at(document, 'r1').cornerRadii[3] = -0;
    const result = validateAnyDocument(document);
    if (!result.ok) throw new Error(result.code);
    const reread = JSON.parse(serializeDocument(result.document)) as LooseDocument;
    expect(Object.is(at(reread, 'r1').rotation, 0)).toBe(true);
    expect(Object.is(at(reread, 'r1').cornerRadii[3], 0)).toBe(true);
    expect(Object.is(result.document.nodes.r1!.rotation, 0)).toBe(true);
  });
});
