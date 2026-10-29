import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DOCUMENT_ERROR_CODES,
  MAX_TEXT_LENGTH,
  migrateV3toV4,
  parseDocument,
  parseEnvelope,
  serializeDocument,
  serializeEnvelope,
  validateAnyDocument,
  validateDocument,
  validateFragmentTree,
  validateNode,
  type DocumentV3,
  type DocumentV4,
  type EnvelopeResult,
  type FragmentTreeResult,
  type NodeResult,
  type ParseResult,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';

// MVP M6a-U1 (M6a contract, sections 2, 2.1 and 8): schema v4 with the `text` leaf, the M6a-S
// rules and bounds with their codes and paths and the section 2 check order (M6a-A01), the
// version-only migration from v3, the v5 rejection and the round trips (M6a-A02), and M6a-S7 on
// load and in `validateFragmentTree` (the model half of M6a-A13).

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(root, 'tests/fixtures');
const m6 = path.join(fixtures, 'm6-text');

function read(file: string): Promise<string> {
  return readFile(path.join(fixtures, file), 'utf8');
}

function parsed(text: string): DocumentV4 {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

type Failed = { code: string; path: string };

function failure(result: ParseResult | FragmentTreeResult | EnvelopeResult | NodeResult): Failed {
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('document');
  expect(result).not.toHaveProperty('nodes');
  return result.ok ? { code: 'none', path: '' } : { code: result.code, path: result.path };
}

/** Every committed v3 document fixture and the name of its committed v4 migration. */
const MIGRATIONS = [
  ['m7-symbols/symbols.v3.json', 'symbols'],
  ['m7-symbols/migrated/empty.v3.json', 'empty'],
  ['m7-symbols/migrated/shapes.v3.json', 'shapes'],
  ['m7-symbols/migrated/ext-star.v3.json', 'ext-star'],
  ['m7-symbols/migrated/containers.v3.json', 'containers'],
  ['m7-symbols/migrated/path-edit.v3.json', 'path-edit'],
  ['m7-symbols/depth/tree-256.json', 'tree-256'],
  ['m7-symbols/depth/clip-32.json', 'clip-32'],
  ['m7-symbols/depth/clip-33.json', 'clip-33'],
] as const;
/** The v1 and v2 document fixtures (P5, M1, M3), migrated through v3 to the same v4 texts. */
const OLDER = [
  ['p5-model/empty.json', 'empty'],
  ['p5-model/shapes.json', 'shapes'],
  ['p5-model/ext-star.json', 'ext-star'],
  ['m1-model/empty.v2.json', 'empty'],
  ['m1-model/shapes.v2.json', 'shapes'],
  ['m1-model/ext-star.v2.json', 'ext-star'],
  ['m1-model/containers.json', 'containers'],
  ['m3-path-edit/path-edit.json', 'path-edit'],
] as const;
const ENVELOPES = ['empty', 'shapes', 'ext-star', 'containers'] as const;
/** Every committed valid v4 document fixture. */
const V4_FIXTURES = [
  'm6-text/text.v4.json',
  ...MIGRATIONS.map(([, name]) => `m6-text/migrated/${name}.v4.json`),
];

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };

type Run = { text: string; family: string; size: number; color: typeof black };
const run = (text: string, family = 'Inter', size = 16, color = black): Run => ({
  text,
  family,
  size,
  color,
});

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

const textNode = (
  id: string,
  parent: string,
  runs: unknown = [run('a')],
  extra: Record<string, unknown> = {},
) => ({
  ...base(id, parent),
  type: 'text',
  runs,
  sizing: 'autoWidth',
  align: 'left',
  letterSpacing: 0,
  lineHeight: 1.2,
  ...extra,
});
const symbol = (id: string, parent: string, children: string[] = []) => ({
  ...base(id, parent),
  type: 'symbol',
  children,
  fill: null,
  stroke: null,
});
const group = (id: string, parent: string, children: string[], type = 'group') => ({
  ...base(id, parent),
  type,
  children,
});

type Loose = {
  schemaVersion: number;
  id: string;
  pages: unknown[];
  nodes: Record<string, unknown>;
};

function document(nodes: Record<string, unknown>, children: string[], version = 4): Loose {
  return { schemaVersion: version, id: 'd', pages: [{ id: 'p', name: 'P', children }], nodes };
}

/** A document with the one text node `t` on page `p`. */
const single = (runs: unknown = [run('a')], extra: Record<string, unknown> = {}) =>
  document({ t: textNode('t', 'p', runs, extra) }, ['t']);

/**
 * The five entry points of M6a-A01, each with the path of `failure` relative to the document:
 * `parseDocument`, `validateDocument`, `validateAnyDocument`, `parseEnvelope` and
 * `validateFragmentTree`.
 */
function everyEntryPoint(value: Loose): Failed[] {
  const envelope = failure(
    parseEnvelope(JSON.stringify({ envelopeVersion: 1, lastOpenPageId: 'p', document: value })),
  );
  return [
    failure(parseDocument(JSON.stringify(value))),
    failure(validateDocument(value)),
    failure(validateAnyDocument(value)),
    { code: envelope.code, path: envelope.path.replace(/^\/document/, '') },
    failure(validateFragmentTree(value)),
  ];
}

const fails = (value: Loose, path: string, code = 'document.invalid-field') =>
  expect(everyEntryPoint(value)).toEqual(Array(5).fill({ code, path }));

describe('M6a-A02 migration v3 to v4 (section 2.1)', () => {
  it.each(MIGRATIONS)(
    'migrates the v3 fixture %s byte for byte to its committed v4 text',
    async (file, name) => {
      const v3 = await read(file);
      const v4 = await read(`m6-text/migrated/${name}.v4.json`);
      expect(serializeDocument(parsed(v3))).toBe(v4);
      const migrated = migrateV3toV4(JSON.parse(v3) as DocumentV3);
      expect(migrated.ok && serializeDocument(migrated.document)).toBe(v4);
      // Only the version changes.
      expect(v4).toBe(v3.replace('"schemaVersion": 3,', '"schemaVersion": 4,'));
    },
  );

  it.each(OLDER)('migrates the older fixture %s to the committed v4 text', async (file, name) => {
    expect(serializeDocument(parsed(await read(file)))).toBe(
      await read(`m6-text/migrated/${name}.v4.json`),
    );
  });

  it('lists every committed v3 document fixture outside malformed/ directories', async () => {
    const entries = await readdir(fixtures, { withFileTypes: true, recursive: true });
    const v3: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path
        .relative(fixtures, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/');
      if (file.split('/').includes('malformed')) continue;
      let value: unknown;
      try {
        value = JSON.parse(await read(file));
      } catch {
        continue;
      }
      const record = value as { schemaVersion?: unknown; envelopeVersion?: unknown };
      if (record.envelopeVersion === undefined && record.schemaVersion === 3) v3.push(file);
    }
    expect(v3.sort()).toEqual(MIGRATIONS.map(([file]) => file).sort());
  });

  it.each(ENVELOPES)('migrates the envelope fixture %s byte for byte', async (name) => {
    const v4 = await read(`m6-text/migrated/${name}.envelope.v4.json`);
    for (const source of [
      `m5-persistence/${name}.envelope.json`,
      `m7-symbols/migrated/${name}.envelope.v3.json`,
    ]) {
      const result = parseEnvelope(await read(source));
      expect(result.ok && serializeEnvelope(result.envelope)).toBe(v4);
    }
    const v3 = await read(`m7-symbols/migrated/${name}.envelope.v3.json`);
    expect(v4).toBe(v3.replace('"schemaVersion": 3,', '"schemaVersion": 4,'));
  });

  it('rejects a text node in a v3 document, also through migrateV3toV4, and in a v2 one', async () => {
    const text = await read('m6-text/malformed/text-in-v3.json');
    const at = { code: 'document.invalid-field', path: '/nodes/t/type' };
    expect(failure(parseDocument(text))).toEqual(at);
    expect(failure(validateAnyDocument(JSON.parse(text)))).toEqual(at);
    expect(failure(migrateV3toV4(JSON.parse(text) as DocumentV3))).toEqual(at);
    expect(failure(validateAnyDocument({ ...single(), schemaVersion: 2 }))).toEqual(at);
    // `validateDocument` and `validateFragmentTree` read the latest version only.
    const unsupported = { code: 'document.unsupported-version', path: '/schemaVersion' };
    expect(failure(validateDocument(JSON.parse(text)))).toEqual(unsupported);
    expect(failure(validateFragmentTree(JSON.parse(text)))).toEqual(unsupported);
  });

  it.each([
    'p5-model/malformed/unsupported-version.json',
    'm1-model/malformed/unsupported-version.json',
    'm7-symbols/malformed/unsupported-version.json',
    'm6-text/malformed/unsupported-version.json',
  ])('fails %s at schemaVersion 5', async (file) => {
    const text = await read(file);
    expect((JSON.parse(text) as { schemaVersion: number }).schemaVersion).toBe(5);
    expect(failure(parseDocument(text))).toEqual({
      code: 'document.unsupported-version',
      path: '/schemaVersion',
    });
  });

  // `order-5-6` holds an unknown key as well, so its step 5 failure is checked in M5's tests.
  it.each(['document-unsupported-version', 'order-5-6'])(
    'holds document schemaVersion 5 in the M5 envelope %s',
    async (name) => {
      const text = await read(`m5-persistence/malformed/${name}.json`);
      expect(
        (JSON.parse(text) as { document: { schemaVersion: number } }).document.schemaVersion,
      ).toBe(5);
    },
  );

  it('fails the M5 document-unsupported-version envelope at its document version', async () => {
    const text = await read('m5-persistence/malformed/document-unsupported-version.json');
    expect(failure(parseEnvelope(text))).toEqual({
      code: 'document.unsupported-version',
      path: '/document/schemaVersion',
    });
  });

  it('accepts versions 1 to 4, validateDocument only 4', () => {
    const value = single();
    expect(validateDocument(value).ok).toBe(true);
    expect(validateAnyDocument(value).ok).toBe(true);
    for (const version of [1, 2, 3, 5]) {
      expect(failure(validateDocument({ ...value, schemaVersion: version }))).toEqual({
        code: 'document.unsupported-version',
        path: '/schemaVersion',
      });
    }
  });
});

describe('M6a-A02 round trip and serialize order (section 2)', () => {
  it.each(V4_FIXTURES)('round-trips %s byte for byte, also through the envelope', async (file) => {
    const text = await read(file);
    const value = parsed(text);
    expect(serializeDocument(value)).toBe(text);
    expect(parsed(serializeDocument(value))).toEqual(value);
    for (const page of value.pages) {
      const envelope = { document: value, lastOpenPageId: page.id };
      const envelopeText = serializeEnvelope(envelope);
      const result = parseEnvelope(envelopeText);
      expect(result).toEqual({ ok: true, envelope });
      expect(result.ok && serializeEnvelope(result.envelope)).toBe(envelopeText);
      expect(result.ok && serializeDocument(result.envelope.document)).toBe(text);
    }
  });

  it.each(ENVELOPES)('round-trips the v4 envelope fixture %s byte for byte', async (name) => {
    const text = await read(`m6-text/migrated/${name}.envelope.v4.json`);
    const result = parseEnvelope(text);
    expect(result.ok && serializeEnvelope(result.envelope)).toBe(text);
  });

  it('covers each sizing and alignment, several runs, LF, an empty node, nesting and symbols', async () => {
    const value = parsed(await read('m6-text/text.v4.json'));
    const texts = Object.values(value.nodes).filter((node) => node.type === 'text');
    expect(new Set(texts.map((node) => node.sizing))).toEqual(
      new Set(['autoWidth', 'autoHeight', 'fixed']),
    );
    expect(new Set(texts.map((node) => node.align))).toEqual(new Set(['left', 'center', 'right']));
    expect(value.nodes.t2).toMatchObject({
      runs: [{}, { size: 32 }, { text: '\nemoji 👩‍💻 soft\u00ad hy\u007f' }],
    });
    expect(value.nodes.t3).toMatchObject({ runs: [{ text: '' }] });
    expect([value.nodes.t4!.parent, value.nodes.t5!.parent]).toEqual(['g1', 'f1']);
    const types = new Set(Object.values(value.nodes).map((node) => node.type));
    expect(types.has('symbol') && types.has('instance')).toBe(true);
    // Accepted edge values: LF, DEL, U+00AD, a ZWJ emoji sequence, sizes 0.5 and 4096, letter
    // spacing -1 and 10, line height 0.1 and 10, opacity 0.5.
    const all = texts.flatMap((node) => node.runs.map((r) => r.text)).join('');
    for (const unit of ['\n', '\u007f', '­', '‍']) expect(all).toContain(unit);
    expect(value.nodes.t4).toMatchObject({ letterSpacing: -1, lineHeight: 0.1, opacity: 0.5 });
    expect(value.nodes.t3).toMatchObject({ letterSpacing: 10, lineHeight: 10 });
  });

  it('writes the base keys, then runs (text, family, size, color), sizing, align, letterSpacing, lineHeight', async () => {
    const text = await read('m6-text/text.v4.json');
    const raw = JSON.parse(text) as {
      nodes: Record<string, { runs: Record<string, object>[] } & Record<string, unknown>>;
    };
    expect(Object.keys(raw.nodes.t2!)).toEqual([
      'id',
      'name',
      'parent',
      'frame',
      'rotation',
      'constraints',
      'opacity',
      'visible',
      'type',
      'runs',
      'sizing',
      'align',
      'letterSpacing',
      'lineHeight',
    ]);
    for (const entry of raw.nodes.t2!.runs) {
      expect(Object.keys(entry)).toEqual(['text', 'family', 'size', 'color']);
      expect(Object.keys(entry.color!)).toEqual(['r', 'g', 'b', 'a']);
    }
    // The order holds for an in-memory value built in another key order.
    const value = parsed(text);
    const node = value.nodes.t2 as Extract<DocumentV4['nodes'][string], { type: 'text' }>;
    const { runs, lineHeight, ...rest } = node;
    const shuffled = {
      ...value,
      nodes: {
        ...value.nodes,
        t2: {
          lineHeight,
          runs: runs.map(({ text: t, family, size, color }) => ({
            color: { a: color.a, b: color.b, g: color.g, r: color.r },
            size,
            family,
            text: t,
          })),
          ...rest,
        },
      },
    } as DocumentV4;
    expect(serializeDocument(shuffled)).toBe(text);
  });
});

describe('M6a-A01 malformed text documents (M6a-S1 to M6a-S4, M6a-S7)', () => {
  const at = (rest: string) => `/nodes/t${rest}`;
  const expected: Record<string, [string, string]> = {
    'text-cr': ['document.invalid-field', at('/runs/0/text')],
    'text-tab': ['document.invalid-field', at('/runs/0/text')],
    'text-u2028': ['document.invalid-field', at('/runs/1/text')],
    'text-u202e': ['document.invalid-field', at('/runs/0/text')],
    'text-u2067': ['document.invalid-field', at('/runs/0/text')],
    'text-lone-surrogate': ['document.invalid-field', at('/runs/0/text')],
    'runs-empty': ['document.invalid-field', at('/runs')],
    'run-empty-second': ['document.invalid-field', at('/runs/1')],
    'runs-equal-adjacent': ['document.invalid-field', at('/runs/1')],
    'family-empty': ['document.invalid-field', at('/runs/0/family')],
    'family-129': ['document.invalid-field', at('/runs/0/family')],
    'size-0': ['document.invalid-field', at('/runs/0/size')],
    'size-4096.01': ['document.invalid-field', at('/runs/0/size')],
    'letter-spacing-low': ['document.invalid-field', at('/letterSpacing')],
    'letter-spacing-high': ['document.invalid-field', at('/letterSpacing')],
    'line-height-low': ['document.invalid-field', at('/lineHeight')],
    'line-height-high': ['document.invalid-field', at('/lineHeight')],
    'text-16385': ['document.invalid-field', at('/runs')],
    // Section 2 order: M6a-S4 over the node before the M6a-S1 scan.
    'text-16385-control': ['document.invalid-field', at('/runs')],
    'text-in-symbol': ['document.invalid-symbol', at('/parent')],
    'text-in-v3': ['document.invalid-field', at('/type')],
    'unsupported-version': ['document.unsupported-version', '/schemaVersion'],
  };
  /** The fixtures every entry point reads at v4; the other two fail on their version. */
  const atV4 = Object.keys(expected).filter(
    (name) => name !== 'text-in-v3' && name !== 'unsupported-version',
  );

  it('has one committed fixture per case', async () => {
    const names = (await readdir(path.join(m6, 'malformed'))).map((file) =>
      file.replace(/\.json$/, ''),
    );
    expect(names.sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s fails with its code and path', async (name, [code, p]) => {
    const text = await read(`m6-text/malformed/${name}.json`);
    expect(failure(parseDocument(text))).toEqual({ code, path: p });
    expect(failure(validateAnyDocument(JSON.parse(text)))).toEqual({ code, path: p });
  });

  it.each(atV4)('enforces %s at every entry point', async (name) => {
    const value = JSON.parse(await read(`m6-text/malformed/${name}.json`)) as Loose;
    const [code, p] = expected[name]!;
    fails(value, p, code);
  });

  it('holds 16,385 units in the over-long fixtures and adds no code', async () => {
    for (const name of ['text-16385', 'text-16385-control']) {
      const value = JSON.parse(await read(`m6-text/malformed/${name}.json`)) as {
        nodes: { t: { runs: Run[] } };
      };
      expect(value.nodes.t.runs.reduce((sum, r) => sum + r.text.length, 0)).toBe(
        MAX_TEXT_LENGTH + 1,
      );
    }
    expect(MAX_TEXT_LENGTH).toBe(16_384);
    expect(DOCUMENT_ERROR_CODES.at(-1)).toBe('document.invalid-symbol');
    expect(DOCUMENT_ERROR_CODES).toHaveLength(10);
  });
});

describe('M6a-A01 M6a-S1 content', () => {
  const controls = [
    ...Array.from({ length: 0x20 }, (_, unit) => unit).filter((unit) => unit !== 0x0a),
    ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i),
  ];
  const others = [0x2028, 0x2029, 0x200e, 0x200f, 0x061c, 0x202a, 0x202b, 0x202c, 0x202d];
  const isolates = [0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

  it.each([...controls, ...others, ...isolates].map((unit) => [unit.toString(16), unit]))(
    'rejects U+%s in a run text at its text',
    (_hex, unit) => {
      fails(
        single([run('a'), run(`b${String.fromCharCode(unit)}c`, 'Other')]),
        '/nodes/t/runs/1/text',
      );
    },
  );

  it.each([
    ['a lone high surrogate at the end', 'a\ud83d'],
    ['a lone high surrogate before a letter', '\ud83da'],
    ['a lone low surrogate', 'a\udc00'],
    ['a reversed pair', '\ude00\ud83d'],
  ])('rejects %s', (_name, text) => {
    fails(single([run(text)]), '/nodes/t/runs/0/text');
  });

  it('rejects a surrogate pair split across two runs at the first run: each run is checked alone', () => {
    fails(single([run('a\uD83D', 'F', 16), run('\uDE00b', 'F', 20)]), '/nodes/t/runs/0/text');
  });

  it('accepts LF, DEL, U+00AD, ZWJ, U+FEFF, a surrogate pair, RTL letters and one empty run', () => {
    for (const text of ['a\nb\n', '\n', '\u007f', 'soft­hyphen', '👩‍💻', '﻿', 'שלום', '']) {
      expect(validateDocument(single([run(text)])).ok, JSON.stringify(text)).toBe(true);
    }
  });
});

describe('M6a-A01 M6a-S2 runs, M6a-S3 fields and M6a-S4 bounds', () => {
  const red = { r: 1, g: 0, b: 0, a: 1 };

  it.each<[string, unknown, string]>([
    ['runs not an array', { 0: run('a') }, '/nodes/t/runs'],
    ['runs null', null, '/nodes/t/runs'],
    ['an empty first run before another', [run(''), run('a', 'Other')], '/nodes/t/runs/0'],
    [
      'equal colours by value, -0 and 0',
      [run('a', 'F', 1, { ...red, g: -0 }), run('b', 'F', 1, red)],
      '/nodes/t/runs/1',
    ],
    ['a run that is not an object', ['a'], '/nodes/t/runs/0'],
    ['a run without color', [{ text: 'a', family: 'F', size: 1 }], '/nodes/t/runs/0/color'],
    ['a run with an extra key', [{ ...run('a'), lang: 'ko' }], '/nodes/t/runs/0/lang'],
    ['a non-string text', [{ ...run('a'), text: 1 }], '/nodes/t/runs/0/text'],
    ['a non-string family', [{ ...run('a'), family: null }], '/nodes/t/runs/0/family'],
    ['a family with LF', [run('a', 'A\nB')], '/nodes/t/runs/0/family'],
    ['a family with U+0085', [run('a', 'A\u0085B')], '/nodes/t/runs/0/family'],
    ['a family with a lone surrogate', [run('a', 'A\ud800')], '/nodes/t/runs/0/family'],
    ['a negative size', [run('a', 'F', -1)], '/nodes/t/runs/0/size'],
    ['a size of -0', [run('a', 'F', -0)], '/nodes/t/runs/0/size'],
    ['an infinite size', [run('a', 'F', Infinity)], '/nodes/t/runs/0/size'],
    ['a string size', [{ ...run('a'), size: '16' }], '/nodes/t/runs/0/size'],
    ['a colour channel above 1', [run('a', 'F', 1, { ...red, r: 1.5 })], '/nodes/t/runs/0/color/r'],
    [
      'a straight alpha below 0',
      [run('a', 'F', 1, { ...red, a: -0.1 })],
      '/nodes/t/runs/0/color/a',
    ],
  ])('rejects %s', (_name, runs, p) => {
    fails(single(runs), p);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['an unknown sizing', { sizing: 'auto' }, '/nodes/t/sizing'],
    ['an unknown align', { align: 'justify' }, '/nodes/t/align'],
    ['a non-finite letter spacing', { letterSpacing: Infinity }, '/nodes/t/letterSpacing'],
    ['a string line height', { lineHeight: '1.2' }, '/nodes/t/lineHeight'],
    ['a fill', { fill: null }, '/nodes/t/fill'],
    ['children', { children: [] }, '/nodes/t/children'],
    ['a stored layout', { lines: [] }, '/nodes/t/lines'],
    ['a stored lang', { lang: 'ko' }, '/nodes/t/lang'],
  ])('rejects %s', (_name, extra, p) => {
    fails(single([run('a')], extra), p);
  });

  it('rejects a text node without runs or lineHeight at the missing key', () => {
    for (const key of ['runs', 'lineHeight']) {
      const node: Record<string, unknown> = textNode('t', 'p');
      delete node[key];
      fails(document({ t: node }, ['t']), `/nodes/t/${key}`);
    }
  });

  it('accepts the bounds: 16,384 units, sizes 4096 and just above 0, family 128 units, spacing and line height at their ends', () => {
    const half = MAX_TEXT_LENGTH / 2;
    const accepted = [
      single([run('a'.repeat(half)), run('b'.repeat(half), 'Other')]),
      single([run('😀'.repeat(MAX_TEXT_LENGTH / 2))]),
      single([run('a', 'F', 4096)]),
      single([run('a', 'F', Number.MIN_VALUE)]),
      single([run('a', 'F'.repeat(128))]),
      single([run('a', '"Noto Sans KR", serif')]),
      single([run('a', 'F\u007f')]),
      single([run('a')], { letterSpacing: -1, lineHeight: 0.1 }),
      single([run('a')], { letterSpacing: 10, lineHeight: 10 }),
      single([run('a', 'F', 1, red), run('b', 'F', 1, { ...red, a: 0.5 })]),
      single([run('a')], { opacity: 0.5, rotation: 1, visible: false }),
    ];
    for (const value of accepted) {
      const result = validateDocument(value);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    // One unit over: a surrogate pair counts two.
    fails(single([run('😀'.repeat(MAX_TEXT_LENGTH / 2)), run('a', 'Other')]), '/nodes/t/runs');
  });

  it('normalizes negative zero and copies the input', () => {
    const value = single([run('a', 'F', 1, { r: -0, g: 0, b: 0, a: 1 })], { letterSpacing: -0 });
    const result = validateDocument(value);
    expect(result.ok).toBe(true);
    const node = result.ok ? result.document.nodes.t : undefined;
    expect(Object.is(node?.type === 'text' && node.letterSpacing, 0)).toBe(true);
    expect(Object.is(node?.type === 'text' && node.runs[0]!.color.r, 0)).toBe(true);
    expect(node?.type === 'text' && node.runs).not.toBe((value.nodes.t as { runs: unknown }).runs);
  });
});

describe('M6a-A01 check order (section 2)', () => {
  it.each<[string, unknown, Record<string, unknown>, string]>([
    ['a base field before runs', [], { opacity: 2 }, '/nodes/t/opacity'],
    ['runs before sizing', [], { sizing: 'none' }, '/nodes/t/runs'],
    [
      "each run's fields before M6a-S4",
      [run('a'.repeat(MAX_TEXT_LENGTH)), run('b', 'F', 0)],
      {},
      '/nodes/t/runs/1/size',
    ],
    [
      "a run's fields in key order",
      [{ text: 1, family: '', size: 0, color: null }],
      {},
      '/nodes/t/runs/0/text',
    ],
    [
      'family before size',
      [{ text: 'a', family: '', size: 0, color: null }],
      {},
      '/nodes/t/runs/0/family',
    ],
    [
      'size before color',
      [{ text: 'a', family: 'F', size: 0, color: null }],
      {},
      '/nodes/t/runs/0/size',
    ],
    [
      'the run fields of a later run before M6a-S1',
      [run('\r'), run('a', '')],
      {},
      '/nodes/t/runs/1/family',
    ],
    ['M6a-S1 on every run before M6a-S2', [run('a'), run('b\r')], {}, '/nodes/t/runs/1/text'],
    ['M6a-S1 run by run', [run('a\t'), run('b\r', 'Other')], {}, '/nodes/t/runs/0/text'],
    ['M6a-S2 run by run', [run(''), run('a'), run('b')], {}, '/nodes/t/runs/0'],
    ['runs before the props', [run('a\r')], { lineHeight: 0 }, '/nodes/t/runs/0/text'],
    ['sizing before align', [run('a')], { sizing: 'x', align: 'x' }, '/nodes/t/sizing'],
    ['align before letterSpacing', [run('a')], { align: 'x', letterSpacing: 11 }, '/nodes/t/align'],
    [
      'letterSpacing before lineHeight',
      [run('a')],
      { letterSpacing: 11, lineHeight: 0 },
      '/nodes/t/letterSpacing',
    ],
  ])('%s', (_name, runs, extra, p) => {
    fails(single(runs, extra), p);
  });

  it('fails an over-long text holding a control at /runs, and with the control alone at its text', () => {
    fails(single([run(`${'a'.repeat(MAX_TEXT_LENGTH)}\r`)]), '/nodes/t/runs');
    fails(single([run(`${'a'.repeat(MAX_TEXT_LENGTH - 1)}\r`)]), '/nodes/t/runs/0/text');
  });

  it('a field rule of a text node before ownership; ownership before M6a-S7', () => {
    fails(
      document({ s: symbol('s', 'p', ['t']), t: textNode('t', 's', []) }, ['s', 's']),
      '/nodes/t/runs',
    );
    fails(
      document({ s: symbol('s', 'p', ['t']), t: textNode('t', 's') }, ['s', 's']),
      '/pages/0/children/1',
      'document.dangling-reference',
    );
  });

  it('the cycle walk before M6a-S7, M6a-S7 before the group rules, in node-map order with M7-S3', () => {
    const cycle = {
      s: symbol('s', 'p', ['t']),
      t: textNode('t', 's'),
      a: group('a', 'b', ['b']),
      b: group('b', 'a', ['a']),
    };
    fails(document(cycle, ['s']), '/nodes/a/parent', 'document.cyclic-parent');
    const empty = { s: symbol('s', 'p', ['t']), t: textNode('t', 's'), e: group('e', 'p', []) };
    fails(document(empty, ['s', 'e']), '/nodes/t/parent', 'document.invalid-symbol');
    const both = {
      s: symbol('s', 'p', ['t', 'i']),
      i: { ...base('i', 's'), type: 'instance', symbol: 's' },
      t: textNode('t', 's'),
    };
    fails(document(both, ['s']), '/nodes/i/parent', 'document.invalid-symbol');
  });
});

describe('M6a-A13 M6a-S7 (model half): no text node inside a symbol', () => {
  it('rejects a text node inside a group inside a symbol at every entry point', () => {
    const value = document(
      { s: symbol('s', 'p', ['g']), g: group('g', 's', ['t']), t: textNode('t', 'g') },
      ['s'],
    );
    fails(value, '/nodes/t/parent', 'document.invalid-symbol');
  });

  it('accepts a text node beside a symbol, inside a group, a frame and a mask group', () => {
    const mask = {
      ...base('m', 'k'),
      type: 'path',
      path: { verbs: ['move', 'line', 'close'], points: [0, 0, 1, 1], fillRule: 'nonzero' },
      fill: null,
      stroke: null,
    };
    const value = document(
      {
        s: symbol('s', 'p'),
        g: group('g', 'p', ['t1']),
        t1: textNode('t1', 'g'),
        f: { ...base('f', 'p'), type: 'frame', children: ['t2'], fill: null, stroke: null },
        t2: textNode('t2', 'f'),
        k: group('k', 'p', ['m', 't3'], 'maskGroup'),
        m: mask,
        t3: textNode('t3', 'k'),
      },
      ['s', 'g', 'f', 'k'],
    );
    expect(validateDocument(value).ok).toBe(true);
    expect(validateFragmentTree(value).ok).toBe(true);
  });

  it('never takes a text node as a mask source', () => {
    const value = document({ k: group('k', 'p', ['t'], 'maskGroup'), t: textNode('t', 'k') }, [
      'k',
    ]);
    fails(value, '/nodes/k/children/0', 'document.invalid-mask-source');
  });
});

describe('M6a-A01 validateNode on text nodes', () => {
  it('accepts a text node and reports paths relative to it', () => {
    expect(validateNode(textNode('t', 'p'))).toEqual({ ok: true, node: textNode('t', 'p') });
    expect(failure(validateNode(textNode('t', 'p', [run('a'), run('b')])))).toEqual({
      code: 'document.invalid-field',
      path: '/runs/1',
    });
    expect(failure(validateNode(textNode('t', 'p', [run('a ')])))).toEqual({
      code: 'document.invalid-field',
      path: '/runs/0/text',
    });
  });
});
