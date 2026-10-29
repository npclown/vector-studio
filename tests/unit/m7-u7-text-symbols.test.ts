import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  migrateV4toV5,
  parseDocument,
  parseEnvelope,
  serializeDocument,
  serializeEnvelope,
  validateAnyDocument,
  validateDocument,
  validateFragmentTree,
  validateNode,
  type DocumentV4,
  type DocumentV5,
  type InstanceNodeV5,
  type NodeV5,
  type TextNode,
  type TextRun,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import {
  createEditor,
  type Command,
  type CommandResult,
  type Editor,
  type IdSource,
} from '../../packages/editor-core/src/index.js';
import { internalsOf } from '../../packages/editor-core/src/editor.js';
import {
  ExpansionCache,
  expandInstance,
  type Expansion,
} from '../../packages/editor-core/src/expansion.js';
import { createFakeTextLayout } from '../support/fake-text-layout.js';

// MVP M7-U7 (M6a contract, section 9, M7-T1 to M7-T3; criterion M7-A12): text inside symbols, its
// expansion under the instance scale, the instance text overrides with their schema v5 field,
// migration, load codes, commands, key upkeep, detach and paste. The fixture
// `m7-symbols/text-symbols.v5.json` holds source `s1` (100 x 40: autoWidth text `t1`, group `g1`
// of fixed text `t2` and rectangle `r1`), instances `i1` (scale 1, `t1` overridden), `i2` (scale
// 2, `t2` overridden), `i3` (150 x 40, none) and a page text `tp` on page 1; source `s2`
// (autoHeight text `t3`), `i4` of `s1` (both texts overridden) and `i5` of `s2` on page 2. Every
// command leaves a document `validateDocument` accepts; a failed one changes nothing and draws no
// ID; each success is one undo step whose undo and redo are byte-identical.

const root = path.resolve(import.meta.dirname, '../..');
const fixtures = path.join(root, 'tests/fixtures');
const read = (file: string) => readFileSync(path.join(fixtures, file), 'utf8');
const TEXT_SYMBOLS = read('m7-symbols/text-symbols.v5.json');
const black = { r: 0, g: 0, b: 0, a: 1 };
const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };

const run = (text: string, size = 10, color = black, family = 'Test'): TextRun => ({
  text,
  family,
  size,
  color,
});

function parsed(text: string): DocumentV5 {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

type Json = {
  schemaVersion: number;
  id: string;
  pages: { id: string; name: string; children: string[] }[];
  nodes: Record<string, Record<string, unknown> & { textOverrides?: Record<string, unknown> }>;
};
const json = (): Json => JSON.parse(TEXT_SYMBOLS) as Json;

/** An editor on `document` whose ID source counts its draws (`n1`, `n2`, ...), with or without a port. */
function counted(document: unknown = json(), port = true): { target: Editor; drawn: () => number } {
  let count = 0;
  const ids: IdSource = () => `n${++count}`;
  const target = createEditor({
    document,
    ids,
    ...(port ? { textLayout: createFakeTextLayout() } : {}),
  });
  return { target, drawn: () => count };
}

/** An editor with the default ID source, so that rule (1) of M7 section 6 can link a paste. */
const ownIds = () => createEditor({ document: json(), textLayout: createFakeTextLayout() });

const documentOf = (target: Editor) => target.query({ type: 'document' });
const text = (target: Editor) => serializeDocument(documentOf(target));
const nodeOf = (target: Editor, id: string) => documentOf(target).nodes[id]!;
const overridesOf = (target: Editor, id: string) =>
  (nodeOf(target, id) as InstanceNodeV5).textOverrides;

function execute(target: Editor, command: Command): CommandResult {
  const result = target.execute(command);
  expect(validateDocument(JSON.parse(text(target))).ok).toBe(true);
  return result;
}

function ok(target: Editor, command: Command): readonly string[] {
  const result = execute(target, command);
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
  const history = target.query({ type: 'history' });
  const count = drawn();
  expect(execute(target, command)).toEqual({ ok: false, ...failure });
  expect(documentOf(target)).toBe(document);
  expect(text(target)).toBe(before);
  expect(target.query({ type: 'history' })).toEqual(history);
  expect(drawn()).toBe(count);
}

/**
 * Runs `command` as one undo step and checks that undo restores the text before it and redo the
 * text after it, byte for byte. Returns the text after.
 */
function oneStep(target: Editor, command: Command): string {
  const before = text(target);
  const { undoDepth } = target.query({ type: 'history' });
  ok(target, command);
  const after = text(target);
  expect(after).not.toBe(before);
  expect(target.query({ type: 'history' })).toEqual({ undoDepth: undoDepth + 1, redoDepth: 0 });
  ok(target, { type: 'undo' });
  expect(text(target)).toBe(before);
  ok(target, { type: 'redo' });
  expect(text(target)).toBe(after);
  return after;
}

function expanded(document: DocumentV5, id: string): Expansion {
  const result = expandInstance(document, id);
  if (result === null || !result.ok) throw new Error(`no expansion of ${id}`);
  return result.expansion;
}
const expandedText = (document: DocumentV5, instance: string, node: string) =>
  expanded(document, instance).nodes.get(node) as TextNode;

describe('M7-T3 schema v5: the instance override field (M6a contract, section 9)', () => {
  it('round-trips the text-symbols fixture byte for byte, also through the envelope', () => {
    const value = parsed(TEXT_SYMBOLS);
    expect(serializeDocument(value)).toBe(TEXT_SYMBOLS);
    expect(parsed(serializeDocument(value))).toEqual(value);
    for (const page of value.pages) {
      const envelope = { document: value, lastOpenPageId: page.id };
      const envelopeText = serializeEnvelope(envelope);
      const result = parseEnvelope(envelopeText);
      expect(result).toEqual({ ok: true, envelope });
      expect(result.ok && serializeEnvelope(result.envelope)).toBe(envelopeText);
    }
  });

  it('writes textOverrides after symbol, keys in code unit order, each value exactly { runs }', () => {
    const raw = JSON.parse(TEXT_SYMBOLS) as Json;
    expect(Object.keys(raw.nodes.i4!).slice(-3)).toEqual(['type', 'symbol', 'textOverrides']);
    expect(Object.keys(raw.nodes.i4!.textOverrides!)).toEqual(['t1', 't2']);
    expect(raw.nodes.i3!.textOverrides).toEqual({});
    const override = raw.nodes.i4!.textOverrides!.t1 as { runs: Record<string, object>[] };
    expect(Object.keys(override)).toEqual(['runs']);
    for (const entry of override.runs) {
      expect(Object.keys(entry)).toEqual(['text', 'family', 'size', 'color']);
    }
    // An in-memory value in another key order, keys unsorted, serializes to the same text.
    const value = parsed(TEXT_SYMBOLS);
    const i4 = value.nodes.i4 as InstanceNodeV5;
    const { textOverrides, symbol, ...rest } = i4;
    const shuffled = {
      ...value,
      nodes: {
        ...value.nodes,
        i4: {
          textOverrides: { t2: textOverrides.t2!, t1: textOverrides.t1! },
          ...rest,
          symbol,
        },
      },
    } as DocumentV5;
    expect(serializeDocument(shuffled)).toBe(TEXT_SYMBOLS);
    // A read sorts the keys too.
    const reversed = json();
    const t = reversed.nodes.i4!.textOverrides!;
    reversed.nodes.i4!.textOverrides = { t2: t.t2, t1: t.t1 };
    const sorted = validateDocument(reversed);
    expect(
      sorted.ok && Object.keys((sorted.document.nodes.i4 as InstanceNodeV5).textOverrides),
    ).toEqual(['t1', 't2']);
  });

  it('keeps a "__proto__" key as data', () => {
    const value = json();
    (value.nodes.s1 as { children: string[] }).children.push('__proto__');
    const node = { ...value.nodes.t1!, id: '__proto__', name: 'p' };
    const source = JSON.stringify(value)
      .replace('"nodes":{', `"nodes":{"__proto__":${JSON.stringify(node)},`)
      .replace(
        '"textOverrides":{}',
        `"textOverrides":{"__proto__":{"runs":[${JSON.stringify(run('o'))}]}}`,
      );
    const document = parsed(source);
    const overrides = (document.nodes.i3 as InstanceNodeV5).textOverrides;
    expect(Object.hasOwn(overrides, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(overrides)).toBe(Object.prototype);
    expect(expandedText(document, 'i3', '__proto__').runs[0]!.text).toBe('o');
    const again = parsed(serializeDocument(document));
    expect(again).toEqual(document);
  });

  const MALFORMED: Record<string, [string, string]> = {
    'override-unknown-key': ['document.invalid-symbol', '/nodes/i1/textOverrides/nope'],
    'override-not-text': ['document.invalid-symbol', '/nodes/i1/textOverrides/r1'],
    'override-other-source': ['document.invalid-symbol', '/nodes/i1/textOverrides/t3'],
    'override-page-text': ['document.invalid-symbol', '/nodes/i1/textOverrides/tp'],
    'override-source-key': ['document.invalid-symbol', '/nodes/i1/textOverrides/s1'],
    'override-extra-key': ['document.invalid-field', '/nodes/i1/textOverrides/t1/box'],
    'override-no-runs': ['document.invalid-field', '/nodes/i1/textOverrides/t1/runs'],
    'override-runs-empty': ['document.invalid-field', '/nodes/i1/textOverrides/t1/runs'],
    'override-size-0': ['document.invalid-field', '/nodes/i1/textOverrides/t1/runs/0/size'],
    'override-text-cr': ['document.invalid-field', '/nodes/i1/textOverrides/t1/runs/0/text'],
    'override-runs-equal-adjacent': ['document.invalid-field', '/nodes/i1/textOverrides/t1/runs/1'],
    'override-not-object': ['document.invalid-field', '/nodes/i1/textOverrides'],
    'override-missing': ['document.invalid-field', '/nodes/i1/textOverrides'],
    'override-in-v4': ['document.invalid-field', '/nodes/i1/textOverrides'],
  };

  it('has one committed malformed fixture per override case', () => {
    const names = readdirSync(path.join(fixtures, 'm7-symbols/malformed'))
      .filter((file) => file.startsWith('override-'))
      .map((file) => file.replace(/\.json$/, ''));
    expect(names.sort()).toEqual(Object.keys(MALFORMED).sort());
  });

  it.each(Object.entries(MALFORMED))(
    '%s fails with its code and path at every document entry point',
    (name, [code, at]) => {
      const fixtureText = read(`m7-symbols/malformed/${name}.json`);
      const value = JSON.parse(fixtureText) as Json;
      const expected = { ok: false, code, path: at };
      expect(parseDocument(fixtureText)).toEqual(expected);
      expect(validateAnyDocument(value)).toEqual(expected);
      const envelope = parseEnvelope(
        JSON.stringify({ envelopeVersion: 1, lastOpenPageId: 'page-1', document: value }),
      );
      expect(envelope).toEqual({ ok: false, code, path: `/document${at}` });
      if (value.schemaVersion === 5) expect(validateDocument(value)).toEqual(expected);
      // The editor refuses it on load.
      expect(() => createEditor({ document: value })).toThrow(`${code} at ${at}`);
    },
  );

  it('checks the field rules first, then M7-S2, M7-S3, the keys, M7-S5 and the group rules', () => {
    // An override field rule before a dangling instance symbol (M7-S2).
    const fieldFirst = json();
    (fieldFirst.nodes.i1!.textOverrides!.t1 as { runs: { size: number }[] }).runs[0]!.size = 0;
    fieldFirst.nodes.i3!.symbol = 'nope';
    expect(validateDocument(fieldFirst)).toMatchObject({
      path: '/nodes/i1/textOverrides/t1/runs/0/size',
    });
    // M7-S2 before the key check.
    const dangling = json();
    dangling.nodes.i1!.textOverrides!.nope = { runs: [run('a')] };
    dangling.nodes.i3!.symbol = 'nope';
    expect(validateDocument(dangling)).toEqual({
      ok: false,
      code: 'document.dangling-reference',
      path: '/nodes/i3/symbol',
    });
    // M7-S3 before the key check.
    const nested = json();
    nested.nodes.i1!.textOverrides!.nope = { runs: [run('a')] };
    nested.nodes.s2!.children = ['t3', 'x'];
    nested.nodes.x = { ...nested.nodes.i3!, id: 'x', name: 'x', parent: 's2', textOverrides: {} };
    expect(validateDocument(nested)).toEqual({
      ok: false,
      code: 'document.invalid-symbol',
      path: '/nodes/x/parent',
    });
    // The key check before the group rules.
    const empty = json();
    empty.nodes.i1!.textOverrides!.nope = { runs: [run('a')] };
    empty.pages[0]!.children.push('e');
    empty.nodes.e = { ...empty.nodes.g1!, id: 'e', name: 'e', parent: 'page-1', children: [] };
    expect(validateDocument(empty)).toEqual({
      ok: false,
      code: 'document.invalid-symbol',
      path: '/nodes/i1/textOverrides/nope',
    });
  });

  it('validateFragmentTree skips the key check with M7-S2; validateNode reads the field only', () => {
    const value = json();
    value.nodes.i1!.textOverrides!.nope = { runs: [run('a')] };
    expect(validateFragmentTree(value).ok).toBe(true);
    const node = validateNode(value.nodes.i1);
    expect(node.ok && (node.node as InstanceNodeV5).textOverrides.nope).toEqual({
      runs: [run('a')],
    });
    expect(validateNode({ ...value.nodes.i1, textOverrides: { t1: { runs: [] } } })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/textOverrides/t1/runs',
    });
    expect(validateNode({ ...value.nodes.i1, textOverrides: undefined })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/textOverrides',
    });
  });
});

describe('M7-T3 migration v4 to v5 (M7-Q11 (a))', () => {
  /** Every committed v4 document fixture outside malformed/ directories and its v5 name. */
  const v4Fixtures = (() => {
    const out: string[] = [];
    for (const entry of readdirSync(fixtures, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path
        .relative(fixtures, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join('/');
      if (file.split('/').includes('malformed')) continue;
      let value: unknown;
      try {
        value = JSON.parse(read(file));
      } catch {
        continue;
      }
      const record = value as { schemaVersion?: unknown; document?: { schemaVersion?: unknown } };
      if (record.schemaVersion === 4 || record.document?.schemaVersion === 4) out.push(file);
    }
    return out.sort();
  })();
  const v5Of = (file: string) =>
    `m7-symbols/migrated/${path.basename(file).replace(/\.v4\.json$/, '')}.v5.json`;

  it('finds the v4 text fixtures, their migrations and envelopes', () => {
    expect(v4Fixtures).toContain('m6-text/text.v4.json');
    expect(v4Fixtures).toContain('m6-text/text-in-symbol.v4.json');
    expect(v4Fixtures).toContain('m6-text/migrated/symbols.v4.json');
    expect(v4Fixtures).toContain('m6-text/migrated/shapes.envelope.v4.json');
    expect(v4Fixtures).toHaveLength(15);
  });

  it.each(v4Fixtures)('migrates %s byte for byte to its committed v5 text', (file) => {
    const v4 = read(file);
    const v5 = read(v5Of(file));
    if (file.includes('.envelope.')) {
      const result = parseEnvelope(v4);
      expect(result.ok && serializeEnvelope(result.envelope)).toBe(v5);
    } else {
      expect(serializeDocument(parsed(v4))).toBe(v5);
      const migrated = migrateV4toV5(JSON.parse(v4) as DocumentV4);
      expect(migrated.ok && serializeDocument(migrated.document)).toBe(v5);
    }
    // Only the version changes and every instance gains an empty override map.
    const indent = file.includes('.envelope.') ? '    ' : '  ';
    expect(v5).toBe(
      v4
        .replace(`${indent}"schemaVersion": 4,`, `${indent}"schemaVersion": 5,`)
        .replace(
          /^( +)("symbol": "[^"]*")\n/gm,
          (_match, space: string, line: string) =>
            `${space}${line},\n${space}"textOverrides": {}\n`,
        ),
    );
  });

  it('adds textOverrides: {} to every instance and changes nothing else', () => {
    const v4 = JSON.parse(read('m6-text/migrated/symbols.v4.json')) as DocumentV4;
    const migrated = migrateV4toV5(v4);
    expect(migrated.ok).toBe(true);
    const nodes = migrated.ok ? migrated.document.nodes : {};
    for (const [id, node] of Object.entries(v4.nodes)) {
      expect(nodes[id]).toEqual(node.type === 'instance' ? { ...node, textOverrides: {} } : node);
    }
  });

  it('rejects textOverrides on a v4 instance, also through migrateV4toV5, and accepts no v6', () => {
    const value = JSON.parse(read('m7-symbols/malformed/override-in-v4.json')) as DocumentV4;
    const at = { ok: false, code: 'document.invalid-field', path: '/nodes/i1/textOverrides' };
    expect(migrateV4toV5(value)).toEqual(at);
    expect(validateDocument(value)).toEqual({
      ok: false,
      code: 'document.unsupported-version',
      path: '/schemaVersion',
    });
    expect(parseDocument(JSON.stringify({ ...json(), schemaVersion: 6 }))).toEqual({
      ok: false,
      code: 'document.unsupported-version',
      path: '/schemaVersion',
    });
  });

  it('loads a v4 document with text in a symbol (M7-T1), migrated', () => {
    const { target } = counted(JSON.parse(read('m6-text/text-in-symbol.v4.json')));
    expect(text(target)).toBe(read('m7-symbols/migrated/text-in-symbol.v5.json'));
  });
});

describe('M7-T2 expansion of text under the instance scale', () => {
  const document = parsed(TEXT_SYMBOLS);
  const source = (id: string) => document.nodes[id] as TextNode;

  it('at scale 1 copies the source objects, an overridden node taking the override runs only', () => {
    const { nodes } = expanded(document, 'i1');
    expect(nodes.get('t1')).toEqual({ ...source('t1'), runs: [run('xy', 10, red)] });
    expect(nodes.get('t1')).not.toBe(document.nodes.t1);
    for (const id of ['g1', 't2', 'r1']) expect(nodes.get(id)).toBe(document.nodes[id]);
    // Without overrides every expanded node is the source's own object.
    const plain = { ...json(), nodes: { ...json().nodes } };
    plain.nodes.i3 = { ...plain.nodes.i3!, frame: { x: 0, y: 0, width: 100, height: 40 } };
    const flat = parsed(JSON.stringify(plain));
    for (const [id, node] of expanded(flat, 'i3').nodes) expect(node).toBe(flat.nodes[id]);
  });

  it('a uniform scale multiplies the sizes and keeps the modes and the mapped frame, never refit', () => {
    const { nodes } = expanded(document, 'i2');
    expect(nodes.get('t1')).toEqual({
      ...source('t1'),
      frame: { x: 0, y: 0, width: 20, height: 24 },
      runs: [run('ab', 20)],
    });
    expect(nodes.get('t2')).toEqual({
      ...source('t2'),
      frame: { x: 0, y: 0, width: 120, height: 40 },
      // The override's runs, in the source's space, scale too.
      runs: [run('zz', 24)],
    });
  });

  it('a non-uniform scale switches auto modes to fixed with sizes times the square root', () => {
    const { nodes } = expanded(document, 'i3');
    const s = Math.sqrt(1.5);
    expect(nodes.get('t1')).toEqual({
      ...source('t1'),
      frame: { x: 0, y: 0, width: 15, height: 12 },
      sizing: 'fixed',
      runs: [run('ab', 10 * s)],
    });
    expect(nodes.get('t2')).toMatchObject({
      sizing: 'fixed',
      align: 'center',
      frame: { x: 0, y: 0, width: 90, height: 20 },
      runs: [run('cd', 10 * s), run('가', 20 * s, red)],
    });
  });

  it('sizes above 4096 make the expansion invalid; sizes below 0.5 are valid', () => {
    const big = json();
    big.nodes.i3!.frame = { x: 0, y: 0, width: 100 * 410, height: 40 * 410 };
    const tooBig = parsed(JSON.stringify(big));
    // t1 at 4100 fails first, in the source's pre-order.
    expect(expandInstance(tooBig, 'i3')).toEqual({
      ok: false,
      code: 'editor.invalid-expansion',
      path: '/nodes/i3',
      node: 't1',
    });
    expect(() => createEditor({ document: big })).toThrow('editor.invalid-expansion at /nodes/i3');
    const small = json();
    small.nodes.i3!.frame = { x: 0, y: 0, width: 1, height: 0.4 };
    const tiny = parsed(JSON.stringify(small));
    expect(expandedText(tiny, 'i3', 't1').runs[0]!.size).toBeCloseTo(0.1, 12);
  });

  it('a command that scales an expanded size above 4096 fails with editor.invalid-expansion', () => {
    const setup = counted();
    fails(
      setup,
      {
        type: 'setFrames',
        frames: [{ id: 'i1', frame: { x: 0, y: 0, width: 100 * 410, height: 40 * 410 } }],
      },
      { code: 'editor.invalid-expansion', path: '/nodes/i1' },
    );
    // An override run alone can cross it too: 12 x 350 in i2's t2.
    fails(
      setup,
      {
        type: 'setInstanceText',
        id: 'i2',
        node: 't2',
        runs: [run('zz', 2100)],
      },
      { code: 'editor.invalid-expansion', path: '/nodes/i2' },
    );
  });
});

describe('M7-A12 overrides and propagation', () => {
  it('an instance text differs from its source while the source props reach it', () => {
    const { target } = counted();
    oneStep(target, {
      type: 'setTextProps',
      id: 't1',
      align: 'center',
      lineHeight: 2,
      letterSpacing: 0.5,
    });
    let document = documentOf(target);
    const t1 = document.nodes.t1 as TextNode;
    for (const instance of ['i1', 'i3']) {
      expect(expandedText(document, instance, 't1')).toMatchObject({
        align: 'center',
        lineHeight: 2,
        letterSpacing: 0.5,
      });
    }
    // i1 keeps its own text; i3 takes the source's, its frame the mapped source frame.
    expect(expandedText(document, 'i1', 't1')).toEqual({ ...t1, runs: [run('xy', 10, red)] });
    expect(expandedText(document, 'i3', 't1').runs).toEqual([run('ab', 10 * Math.sqrt(1.5))]);
    // Sizing and width reach the instance too.
    oneStep(target, { type: 'setTextProps', id: 't1', sizing: 'fixed' });
    oneStep(target, {
      type: 'setFrames',
      frames: [{ id: 't2', frame: { x: 0, y: 0, width: 50, height: 20 } }],
    });
    document = documentOf(target);
    expect(expandedText(document, 'i1', 't1').sizing).toBe('fixed');
    expect(expandedText(document, 'i2', 't2')).toMatchObject({
      frame: { x: 0, y: 0, width: 100, height: 40 },
      runs: [run('zz', 24)],
    });
  });

  it('a source text or style edit updates the instances without an override only', () => {
    const { target } = counted();
    oneStep(target, { type: 'setText', id: 't1', start: 2, end: 2, text: 'c' });
    oneStep(target, { type: 'setTextStyle', id: 't1', start: 0, end: 1, style: { color: blue } });
    const document = documentOf(target);
    expect((document.nodes.t1 as TextNode).runs).toEqual([run('a', 10, blue), run('bc')]);
    expect(expandedText(document, 'i1', 't1').runs).toEqual([run('xy', 10, red)]);
    expect(expandedText(document, 'i4', 't1').runs).toEqual([run('q', 8), run('r', 8, blue)]);
    expect(expandedText(document, 'i2', 't1').runs).toEqual([run('a', 20, blue), run('bc', 20)]);
    // The instances keep their override objects.
    expect(overridesOf(target, 'i1')).toEqual({ t1: { runs: [run('xy', 10, red)] } });
  });

  it('survives a round trip of the editor document', () => {
    const { target } = counted();
    ok(target, { type: 'setInstanceText', id: 'i3', node: 't2', runs: [run('new')] });
    const saved = text(target);
    const { target: again } = counted(JSON.parse(saved));
    expect(text(again)).toBe(saved);
    expect(overridesOf(again, 'i3')).toEqual({ t2: { runs: [run('new')] } });
  });
});

describe('M7-T3 setInstanceText and clearInstanceText', () => {
  it('sets an override as one step without a port, keys in order', () => {
    const { target } = counted(json(), false);
    const after = oneStep(target, {
      type: 'setInstanceText',
      id: 'i3',
      node: 't2',
      runs: [run('one'), run('two', 12)],
    });
    expect(overridesOf(target, 'i3')).toEqual({ t2: { runs: [run('one'), run('two', 12)] } });
    oneStep(target, { type: 'setInstanceText', id: 'i3', node: 't1', runs: [run('z')] });
    expect(Object.keys(overridesOf(target, 'i3'))).toEqual(['t1', 't2']);
    expect(after).toContain('"textOverrides": {\n        "t2"');
    // The result is the instance's expansion; the source is unchanged.
    expect(expandedText(documentOf(target), 'i3', 't2').runs).toEqual([
      run('one', 10 * Math.sqrt(1.5)),
      run('two', 12 * Math.sqrt(1.5)),
    ]);
    expect(nodeOf(target, 't2')).toEqual(parsed(TEXT_SYMBOLS).nodes.t2);
  });

  it('replaces an existing override, and runs equal to the source remove it', () => {
    const { target } = counted();
    oneStep(target, { type: 'setInstanceText', id: 'i1', node: 't1', runs: [run('new')] });
    expect(overridesOf(target, 'i1')).toEqual({ t1: { runs: [run('new')] } });
    oneStep(target, { type: 'setInstanceText', id: 'i1', node: 't1', runs: [run('ab')] });
    expect(overridesOf(target, 'i1')).toEqual({});
  });

  it('records no step when nothing changes', () => {
    const { target } = counted();
    for (const command of [
      { type: 'setInstanceText', id: 'i1', node: 't1', runs: [run('xy', 10, red)] },
      { type: 'setInstanceText', id: 'i3', node: 't1', runs: [run('ab')] },
      { type: 'clearInstanceText', id: 'i3' },
      { type: 'clearInstanceText', id: 'i1', node: 't2' },
    ] as Command[]) {
      const document = documentOf(target);
      expect(execute(target, command)).toEqual({ ok: true, ids: [] });
      expect(documentOf(target)).toBe(document);
      expect(target.query({ type: 'history' })).toEqual({ undoDepth: 0, redoDepth: 0 });
    }
  });

  it('fails in the section 9 order, changing nothing and drawing no ID', () => {
    const setup = counted(json(), false);
    const set = (rest: Record<string, unknown>) =>
      ({ type: 'setInstanceText', id: 'i1', node: 't1', runs: [run('a')], ...rest }) as Command;
    const cases: [Command, Readonly<{ code: string; path?: string }>][] = [
      [set({ id: 5 }), { code: 'editor.invalid-command', path: '/id' }],
      [set({ node: 5 }), { code: 'editor.invalid-command', path: '/node' }],
      // The shape before the nodes.
      [set({ id: 'zz', node: undefined }), { code: 'editor.invalid-command', path: '/node' }],
      [set({ id: 'zz' }), { code: 'editor.unknown-node' }],
      [set({ id: 't1' }), { code: 'editor.not-an-instance' }],
      [set({ id: 's1', node: 'zz' }), { code: 'editor.not-an-instance' }],
      [set({ node: 'zz' }), { code: 'editor.not-a-text-node', path: '/node' }],
      [set({ node: 'r1' }), { code: 'editor.not-a-text-node', path: '/node' }],
      [set({ node: 'g1' }), { code: 'editor.not-a-text-node', path: '/node' }],
      [set({ node: 's1' }), { code: 'editor.not-a-text-node', path: '/node' }],
      [set({ node: 't3' }), { code: 'editor.not-a-text-node', path: '/node' }],
      [set({ node: 'tp' }), { code: 'editor.not-a-text-node', path: '/node' }],
      // The node before the runs.
      [set({ node: 'r1', runs: [] }), { code: 'editor.not-a-text-node', path: '/node' }],
      [set({ runs: 'a' }), { code: 'document.invalid-field', path: '/runs' }],
      [set({ runs: undefined }), { code: 'document.invalid-field', path: '/runs' }],
      [set({ runs: [] }), { code: 'document.invalid-field', path: '/runs' }],
      [set({ runs: [run('a\rb')] }), { code: 'document.invalid-field', path: '/runs/0/text' }],
      [set({ runs: [run('a'), run('b')] }), { code: 'document.invalid-field', path: '/runs/1' }],
      [set({ runs: [run('a', 0)] }), { code: 'document.invalid-field', path: '/runs/0/size' }],
      [set({ runs: [run('a', 5000)] }), { code: 'document.invalid-field', path: '/runs/0/size' }],
      [
        set({ runs: [{ ...run('a'), lang: 'ko' }] }),
        { code: 'document.invalid-field', path: '/runs/0/lang' },
      ],
      // The authored size floor after the model's rules.
      [set({ runs: [run('a', 0.25)] }), { code: 'editor.invalid-command', path: '/runs/0/size' }],
      [
        set({ runs: [run('a', 0.25), run('b\r', 1)] }),
        { code: 'document.invalid-field', path: '/runs/1/text' },
      ],
    ];
    for (const [command, failure] of cases) fails(setup, command, failure);
  });

  it('clears one override or all, each as one step', () => {
    const { target } = counted();
    oneStep(target, { type: 'clearInstanceText', id: 'i4', node: 't2' });
    expect(Object.keys(overridesOf(target, 'i4'))).toEqual(['t1']);
    ok(target, { type: 'undo' });
    oneStep(target, { type: 'clearInstanceText', id: 'i4' });
    expect(overridesOf(target, 'i4')).toEqual({});
    expect(expandedText(documentOf(target), 'i4', 't1').runs).toEqual([run('ab')]);
  });

  it('clearInstanceText fails in the same order', () => {
    const setup = counted(json(), false);
    const cases: [Command, Readonly<{ code: string; path?: string }>][] = [
      [
        { type: 'clearInstanceText', id: 5 } as unknown as Command,
        { code: 'editor.invalid-command', path: '/id' },
      ],
      [
        { type: 'clearInstanceText', id: 'i4', node: 5 } as unknown as Command,
        { code: 'editor.invalid-command', path: '/node' },
      ],
      [{ type: 'clearInstanceText', id: 'zz' }, { code: 'editor.unknown-node' }],
      [{ type: 'clearInstanceText', id: 'r1', node: 'zz' }, { code: 'editor.not-an-instance' }],
      [
        { type: 'clearInstanceText', id: 'i4', node: 'r1' },
        { code: 'editor.not-a-text-node', path: '/node' },
      ],
      [
        { type: 'clearInstanceText', id: 'i5', node: 't1' },
        { code: 'editor.not-a-text-node', path: '/node' },
      ],
    ];
    for (const [command, failure] of cases) fails(setup, command, failure);
  });
});

describe('M7-T3 keeping keys valid', () => {
  it('deleting a source text node drops its keys in the same step', () => {
    const { target } = counted();
    oneStep(target, { type: 'deleteNodes', ids: ['t1'] });
    expect(overridesOf(target, 'i1')).toEqual({});
    expect(Object.keys(overridesOf(target, 'i4'))).toEqual(['t2']);
    expect(Object.keys(overridesOf(target, 'i2'))).toEqual(['t2']);
  });

  it('moving a text node, or a group holding one, out of its source drops the keys', () => {
    const { target } = counted();
    oneStep(target, { type: 'moveNodes', ids: ['t1'], parent: 'page-1', index: 0 });
    expect(overridesOf(target, 'i1')).toEqual({});
    expect(Object.keys(overridesOf(target, 'i4'))).toEqual(['t2']);
    ok(target, { type: 'undo' });
    oneStep(target, { type: 'moveNodes', ids: ['g1'], parent: 'page-1', index: 0 });
    expect(overridesOf(target, 'i2')).toEqual({});
    expect(Object.keys(overridesOf(target, 'i4'))).toEqual(['t1']);
  });

  it('moving a text node into another source drops its keys in the first', () => {
    const { target } = counted();
    const [made] = ok(target, { type: 'createSymbol', ids: ['tp'] });
    oneStep(target, { type: 'moveNodes', ids: ['t1'], parent: made!, index: 0 });
    expect(nodeOf(target, 't1').parent).toBe(made);
    expect(overridesOf(target, 'i1')).toEqual({});
    expect(Object.keys(overridesOf(target, 'i4'))).toEqual(['t2']);
  });

  it('a gesture update, a replace and the commit keep the keys valid, as one step', () => {
    const { target } = counted();
    const before = text(target);
    const { gesture } = internalsOf(target);
    expect(gesture.begin()).toBe(true);
    // The update deletes t1 in the live document and drops its keys there.
    expect(gesture.update({ type: 'deleteNodes', ids: ['t1'] }).ok).toBe(true);
    expect(overridesOf(target, 'i1')).toEqual({});
    expect(Object.keys(overridesOf(target, 'i4'))).toEqual(['t2']);
    expect(validateDocument(JSON.parse(text(target))).ok).toBe(true);
    // The replace starts again from the pre-gesture document: t1 and its keys return, and the
    // move of g1 out of s1 drops the t2 keys.
    expect(
      gesture.replace([{ type: 'moveNodes', ids: ['g1'], parent: 'page-1', index: 0 }]).ok,
    ).toBe(true);
    expect(Object.keys(overridesOf(target, 'i1'))).toEqual(['t1']);
    expect(overridesOf(target, 'i2')).toEqual({});
    expect(Object.keys(overridesOf(target, 'i4'))).toEqual(['t1']);
    expect(validateDocument(JSON.parse(text(target))).ok).toBe(true);
    gesture.commit();
    const after = text(target);
    expect(target.query({ type: 'history' })).toEqual({ undoDepth: 1, redoDepth: 0 });
    ok(target, { type: 'undo' });
    expect(text(target)).toBe(before);
    ok(target, { type: 'redo' });
    expect(text(target)).toBe(after);
  });

  it('moves within the source and ungrouping keep the keys', () => {
    const { target } = counted();
    oneStep(target, { type: 'ungroupNodes', id: 'g1' });
    expect(nodeOf(target, 't2').parent).toBe('s1');
    expect(Object.keys(overridesOf(target, 'i2'))).toEqual(['t2']);
    expect(Object.keys(overridesOf(target, 'i4'))).toEqual(['t1', 't2']);
  });
});

describe('M7-T3 detach copies the override runs', () => {
  it('detaches i1 with the override text in its copy of t1, and i2 with scaled override runs', () => {
    const { target } = counted();
    oneStep(target, { type: 'detachInstances', ids: ['i1', 'i2'] });
    const document = documentOf(target);
    // IDs in pages order, each expansion in the source's pre-order: t1, g1, t2, r1.
    expect((document.nodes.n1 as TextNode).runs).toEqual([run('xy', 10, red)]);
    expect((document.nodes.n3 as TextNode).runs).toEqual([run('cd'), run('가', 20, red)]);
    expect((document.nodes.n5 as TextNode).runs).toEqual([run('ab', 20)]);
    expect(document.nodes.n7).toMatchObject({ type: 'text', runs: [run('zz', 24)] });
  });
});

describe('M7-T3 the M7-X4 cache with overrides', () => {
  it('recomputes only the source child whose override changed, and reuses the rest', () => {
    const { target } = counted();
    const after = (command: Command): DocumentV5 => {
      ok(target, command);
      return documentOf(target);
    };
    const cache = new ExpansionCache();
    const nodesOf = (result: ReturnType<ExpansionCache['expand']>) =>
      result?.ok ? result.expansion.nodes : new Map<string, NodeV5>();
    // s1 has two direct children, t1 and g1 (holding t2 and r1): one subtree each. i2 is at
    // scale 2, so every copy is a new object and reuse shows as object identity.
    const first = cache.expand(documentOf(target), 'i2');
    expect(cache.computed).toBe(2);
    // An override of t1 recomputes t1 only.
    const second = cache.expand(
      after({ type: 'setInstanceText', id: 'i2', node: 't1', runs: [run('one')] }),
      'i2',
    );
    expect(cache.computed).toBe(3);
    for (const id of ['g1', 't2', 'r1']) {
      expect(nodesOf(second).get(id)).toBe(nodesOf(first).get(id));
    }
    expect((nodesOf(second).get('t1') as TextNode).runs).toEqual([run('one', 20)]);
    // A new override of t2 (inside g1, through the text-to-child map) recomputes g1 only.
    const third = cache.expand(
      after({ type: 'setInstanceText', id: 'i2', node: 't2', runs: [run('new')] }),
      'i2',
    );
    expect(cache.computed).toBe(4);
    expect(nodesOf(third).get('t1')).toBe(nodesOf(second).get('t1'));
    expect(nodesOf(third).get('r1')).not.toBe(nodesOf(second).get('r1'));
    expect((nodesOf(third).get('t2') as TextNode).runs).toEqual([run('new', 20)]);
    // A change of the instance that keeps its scale and override objects reuses both subtrees.
    const renamed = cache.expand(
      after({ type: 'setNodeProps', id: 'i2', props: { name: 'renamed' } }),
      'i2',
    );
    expect(renamed).not.toBe(third);
    expect(cache.computed).toBe(4);
    for (const id of ['t1', 'g1', 't2', 'r1']) {
      expect(nodesOf(renamed).get(id)).toBe(nodesOf(third).get(id));
    }
    // Another instance's override leaves this entry alone.
    const other = after({ type: 'setInstanceText', id: 'i3', node: 't1', runs: [run('q')] });
    expect(cache.expand(other, 'i2')).toBe(renamed);
    expect(cache.computed).toBe(4);
    // Clearing both overrides recomputes both subtrees.
    const cleared = cache.expand(after({ type: 'clearInstanceText', id: 'i2' }), 'i2');
    expect(cache.computed).toBe(6);
    expect((nodesOf(cleared).get('t1') as TextNode).runs).toEqual([run('ab', 20)]);
  });

  it('a detach after setInstanceText copies the new runs, scaled with the instance', () => {
    const { target } = counted();
    ok(target, { type: 'setInstanceText', id: 'i3', node: 't2', runs: [run('new', 10, blue)] });
    ok(target, { type: 'setInstanceText', id: 'i1', node: 't1', runs: [run('fresh')] });
    const expected = expandedText(documentOf(target), 'i3', 't2').runs;
    expect(expected).toEqual([run('new', 10 * Math.sqrt(1.5), blue)]);
    oneStep(target, { type: 'detachInstances', ids: ['i1', 'i3'] });
    const document = documentOf(target);
    // IDs in pages order (i1, then i3), each expansion in the source's pre-order: t1, g1, t2, r1.
    expect((document.nodes.n1 as TextNode).runs).toEqual([run('fresh')]);
    expect((document.nodes.n7 as TextNode).runs).toEqual(expected);
  });
});

describe('M7-T3 paste and duplicate', () => {
  const MARKER = 'vector-studio/fragment\n';
  type Body = {
    fragmentVersion: number;
    schemaVersion: number;
    roots: string[];
    nodes: Record<string, Record<string, unknown>>;
    sources: string[];
    sourceNodes: Record<string, Record<string, unknown>>;
  };
  const copied = (target: Editor, ids: string[]): Body => {
    ok(target, { type: 'copy', ids });
    return JSON.parse(target.query({ type: 'clipboard' })!.slice(MARKER.length)) as Body;
  };
  const marked = (body: Body) => MARKER + JSON.stringify(body);

  it('writes the overrides into the fragment at schema v5', () => {
    const { target } = counted();
    const body = copied(target, ['i1']);
    expect(body.schemaVersion).toBe(5);
    expect(body.nodes.i1!.textOverrides).toEqual({ t1: { runs: [run('xy', 10, red)] } });
    expect(body.sources).toEqual(['s1']);
  });

  it('remaps the keys to the copies when the source is pasted or duplicated with it', () => {
    const { target } = counted();
    copied(target, ['s1', 'i1']);
    const pasted = ok(target, { type: 'paste' });
    // s1 and its subtree take n1 to n5 in pre-order (s1, t1, g1, t2, r1), then i1 takes n6.
    expect(pasted).toEqual(['n1', 'n6']);
    expect(nodeOf(target, 'n6')).toMatchObject({ symbol: 'n1' });
    expect(overridesOf(target, 'n6')).toEqual({ n2: { runs: [run('xy', 10, red)] } });
    const duplicated = ok(target, { type: 'duplicateNodes', ids: ['s1', 'i2'] });
    const i2Copy = duplicated.find((id) => nodeOf(target, id).type === 'instance')!;
    const s1Copy = (nodeOf(target, i2Copy) as InstanceNodeV5).symbol;
    expect(duplicated).toContain(s1Copy);
    const g1Copy = (documentOf(target).nodes[s1Copy] as unknown as { children: string[] })
      .children[1]!;
    const t2Copy = (documentOf(target).nodes[g1Copy] as unknown as { children: string[] })
      .children[0]!;
    expect(nodeOf(target, t2Copy).type).toBe('text');
    expect(overridesOf(target, i2Copy)).toEqual({ [t2Copy]: { runs: [run('zz', 12)] } });
    // A duplicate of an instance alone keeps its source and its keys.
    const [alone] = ok(target, { type: 'duplicateNodes', ids: ['i1'] });
    expect(overridesOf(target, alone!)).toEqual(overridesOf(target, 'i1'));
  });

  it('a remapping paste and duplicate are one step each, undone and redone byte for byte', () => {
    const { target } = counted();
    copied(target, ['s1', 'i1']);
    oneStep(target, { type: 'paste' });
    expect(overridesOf(target, 'n6')).toEqual({ n2: { runs: [run('xy', 10, red)] } });
    oneStep(target, { type: 'duplicateNodes', ids: ['s1', 'i2'] });
    const instances = Object.values(documentOf(target).nodes).filter(
      (node): node is InstanceNodeV5 =>
        node.type === 'instance' && !['i1', 'i2', 'i3', 'i4', 'i5', 'n6'].includes(node.id),
    );
    expect(instances.length).toBe(1);
    const [key] = Object.keys(instances[0]!.textOverrides);
    expect(nodeOf(target, key!)).toMatchObject({ type: 'text', id: key });
    expect(key).not.toBe('t2');
  });

  it('keeps the keys when linked, by the own clipboard or by content', () => {
    const target = ownIds();
    ok(target, { type: 'setActivePage', id: 'page-2' });
    copied(target, ['i4']);
    ok(target, { type: 'setActivePage', id: 'page-1' });
    const [own] = ok(target, { type: 'paste' });
    expect(nodeOf(target, own!)).toMatchObject({ type: 'instance', symbol: 's1' });
    expect(overridesOf(target, own!)).toEqual(overridesOf(target, 'i4'));
    // Another editor on the same document links by content.
    const fragment = target.query({ type: 'clipboard' })!;
    const { target: other } = counted();
    const [linked] = ok(other, { type: 'paste', text: fragment });
    expect(nodeOf(other, linked!)).toMatchObject({ type: 'instance', symbol: 's1' });
    expect(overridesOf(other, linked!)).toEqual(overridesOf(target, 'i4'));
  });

  it('drops a linked key whose text node the source lost since the copy', () => {
    const target = ownIds();
    copied(target, ['i1']);
    ok(target, { type: 'deleteNodes', ids: ['t1'] });
    // Rule (1) links the own clipboard although the source changed; the stale key is dropped.
    const [pasted] = ok(target, { type: 'paste' });
    expect(nodeOf(target, pasted!)).toMatchObject({ type: 'instance', symbol: 's1' });
    expect(overridesOf(target, pasted!)).toEqual({});
    // With a host ID source the paste goes by content, which no longer matches: detached, with
    // the override applied to the carried source's text node.
    const { target: hosted } = counted();
    copied(hosted, ['i1']);
    ok(hosted, { type: 'deleteNodes', ids: ['t1'] });
    const [frame] = ok(hosted, { type: 'paste' });
    const document = documentOf(hosted);
    expect(document.nodes[frame!]!.type).toBe('frame');
    const copy = (document.nodes[frame!] as unknown as { children: string[] }).children[0]!;
    expect((document.nodes[copy] as TextNode).runs).toEqual([run('xy', 10, red)]);
  });

  it('applies the overrides when pasted detached', () => {
    const { target } = counted();
    const fragment = marked(copied(target, ['i1']));
    const { target: foreign } = counted({
      schemaVersion: 5,
      id: 'other',
      pages: [{ id: 'q', name: 'Q', children: [] }],
      nodes: {},
    });
    const [frame] = ok(foreign, { type: 'paste', text: fragment });
    const document = documentOf(foreign);
    expect(document.nodes[frame!]!.type).toBe('frame');
    const copy = (document.nodes[frame!] as unknown as { children: string[] }).children[0]!;
    expect((document.nodes[copy] as TextNode).runs).toEqual([run('xy', 10, red)]);
  });

  it('rejects a fragment key that names no text node of the copied or carried source', () => {
    const setup = counted();
    const body = copied(setup.target, ['i1']);
    for (const key of ['nope', 'r1', 's1']) {
      const edited = structuredClone(body);
      (edited.nodes.i1!.textOverrides as Record<string, unknown>)[key] = { runs: [run('a')] };
      fails(
        setup,
        { type: 'paste', text: marked(edited) },
        { code: 'document.invalid-symbol', path: `/nodes/i1/textOverrides/${key}` },
      );
    }
    const both = copied(setup.target, ['s1', 'i1']);
    (both.nodes.i1!.textOverrides as Record<string, unknown>).t3 = { runs: [run('a')] };
    fails(
      setup,
      { type: 'paste', text: marked(both) },
      { code: 'document.invalid-symbol', path: '/nodes/i1/textOverrides/t3' },
    );
    const bad = structuredClone(body);
    (bad.nodes.i1!.textOverrides as Record<string, { runs: TextRun[] }>).t1!.runs = [];
    fails(
      setup,
      { type: 'paste', text: marked(bad) },
      { code: 'document.invalid-field', path: '/nodes/i1/textOverrides/t1/runs' },
    );
  });

  it('reads an instance of fragment version 2 at schema v3 and v4 with empty overrides', () => {
    const setup = counted();
    const body = copied(setup.target, ['i3']);
    delete body.nodes.i3!.textOverrides;
    // At v4 the carried source holds text; the instance links to s1 by the own clipboard.
    const [linked] = ok(setup.target, {
      type: 'paste',
      text: marked({ ...body, schemaVersion: 4 }),
    });
    expect(nodeOf(setup.target, linked!)).toMatchObject({
      type: 'instance',
      symbol: 's1',
      textOverrides: {},
    });
    // At v3, a carried source without text, unknown here: pasted detached.
    const v3: Body = {
      ...body,
      schemaVersion: 3,
      nodes: { i3: { ...body.nodes.i3!, symbol: 'x' } },
      sources: ['x'],
      sourceNodes: { x: { ...body.sourceNodes.s1!, id: 'x', name: 'x', children: [] } },
    };
    const [detached] = ok(setup.target, { type: 'paste', text: marked(v3) });
    expect(nodeOf(setup.target, detached!)).toMatchObject({ type: 'frame', children: [] });
    const written = copied(setup.target, ['i1']);
    fails(
      setup,
      { type: 'paste', text: marked({ ...written, schemaVersion: 4 }) },
      { code: 'document.invalid-field', path: '/nodes/i1/textOverrides' },
    );
    // As a v4 document reads it: a missing key first, then the unknown key, then the values.
    const nameless = { ...written.nodes.i1! };
    delete nameless.name;
    fails(
      setup,
      {
        type: 'paste',
        text: marked({ ...written, schemaVersion: 4, nodes: { ...written.nodes, i1: nameless } }),
      },
      { code: 'document.invalid-field', path: '/nodes/i1/name' },
    );
    fails(
      setup,
      {
        type: 'paste',
        text: marked({
          ...written,
          schemaVersion: 4,
          nodes: { ...written.nodes, i1: { ...written.nodes.i1!, opacity: 5 } },
        }),
      },
      { code: 'document.invalid-field', path: '/nodes/i1/textOverrides' },
    );
  });
});

describe('M7-T1 text in sources through the commands', () => {
  it('creates text in a source, and each instance expands it at its scale', () => {
    const { target } = counted();
    const [id] = ok(target, {
      type: 'createText',
      frame: { x: 0, y: 0, width: 0, height: 0 },
      runs: [run('new')],
      parent: 's1',
    });
    const document = documentOf(target);
    expect(document.nodes[id!]!.parent).toBe('s1');
    expect(expandedText(document, 'i2', id!).runs).toEqual([run('new', 20)]);
    const [made] = ok(target, { type: 'createSymbol', ids: ['tp'] });
    const [instance] = ok(target, { type: 'createInstance', symbol: made! });
    expect(nodeOf(target, instance!)).toMatchObject({ type: 'instance', textOverrides: {} });
  });

  it('expands the overrides on every page', () => {
    const document = parsed(TEXT_SYMBOLS);
    expect(expandedText(document, 'i4', 't2').runs).toEqual([run('')]);
    expect(expandedText(document, 'i5', 't3').runs).toEqual([run('gh\nij')]);
    const node: NodeV5 = document.nodes.i5!;
    expect(node.type).toBe('instance');
  });
});
