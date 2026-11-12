// V-37 U1 (docs/plans/viz-v37-variants-overrides-contract.md, sections 2 and 5): the `symbolSet`
// node, a symbol's `variant`, an instance's `overrides` and rules V37-S1 to V37-S3 in the model,
// the canonical serialization, the fragment rules and the clipboard checks (V37-A01, V37-A02).
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  bindingKeyAllowed,
  migrateV7toV8,
  parseDocument,
  parseEnvelope,
  serializeDocument,
  serializeEnvelope,
  validateAnyDocument,
  validateDocument,
  validateFragmentTree,
  validateNode,
  type DocumentV7,
  type DocumentV8,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openDocumentStore } from '@vector-studio/persistence-idb';
import { createEditor, type Editor } from '../../packages/editor-core/src/index.js';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- fixtures are edited as untyped JSON */
type Json = Record<string, any>;

const dir = path.resolve(import.meta.dirname, '../fixtures/v37-variants');
const GOOD_TEXT = readFileSync(path.join(dir, 'variants.v8.json'), 'utf8');
const good = (): Json => JSON.parse(GOOD_TEXT) as Json;
const malformed = (name: string): string =>
  readFileSync(path.join(dir, 'malformed', `${name}.json`), 'utf8');

/** Every V37-S1 to S3 violation (V37-A02): fixture, model code, JSON Pointer path. */
const MALFORMED: readonly (readonly [string, string, string])[] = [
  ['set-child-not-symbol', 'document.invalid-symbol', '/nodes/r3/parent'],
  ['set-empty', 'document.invalid-field', '/nodes/set1/children'],
  ['set-in-symbol', 'document.invalid-symbol', '/nodes/set2/parent'],
  ['set-in-symbol-source', 'document.invalid-symbol', '/nodes/set2/parent'],
  ['symbol-in-set-symbol', 'document.invalid-symbol', '/nodes/sQ/parent'],
  ['variant-missing', 'document.invalid-field', '/nodes/sB/variant'],
  ['variant-outside-set', 'document.invalid-field', '/nodes/sP/variant'],
  ['variant-empty', 'document.invalid-field', '/nodes/sA/variant'],
  ['variant-17-entries', 'document.invalid-field', '/nodes/sA/variant'],
  ['variant-value-not-string', 'document.invalid-field', '/nodes/sA/variant/Size'],
  ['variant-name-empty', 'document.invalid-field', '/nodes/sA/variant/'],
  ['variant-name-equals', 'document.invalid-field', '/nodes/sA/variant/Si=ze'],
  ['variant-name-comma', 'document.invalid-field', '/nodes/sA/variant/Si,ze'],
  [
    'variant-name-65',
    'document.invalid-field',
    '/nodes/sA/variant/NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNN',
  ],
  ['variant-name-control', 'document.invalid-field', '/nodes/sA/variant/Si\u0007ze'],
  ['variant-name-lone-surrogate', 'document.invalid-field', '/nodes/sA/variant/Si\ud800ze'],
  ['variant-value-lone-surrogate', 'document.invalid-field', '/nodes/sA/variant/Size'],
  ['variant-not-object', 'document.invalid-field', '/nodes/sA/variant'],
  ['variant-value-empty', 'document.invalid-field', '/nodes/sA/variant/Size'],
  ['variant-value-65', 'document.invalid-field', '/nodes/sA/variant/Size'],
  ['variant-value-control', 'document.invalid-field', '/nodes/sA/variant/Size'],
  ['variant-names-differ', 'document.invalid-variant', '/nodes/sB/variant'],
  ['variant-names-fewer', 'document.invalid-variant', '/nodes/sB/variant'],
  ['variant-duplicate', 'document.invalid-variant', '/nodes/sB/variant'],
  ['override-unknown-key', 'document.invalid-symbol', '/nodes/inst1/overrides/ghost'],
  ['override-other-source', 'document.invalid-symbol', '/nodes/inst1/overrides/r2'],
  ['override-page-key', 'document.invalid-symbol', '/nodes/inst1/overrides/page-1'],
  ['override-empty-entry', 'document.invalid-field', '/nodes/inst1/overrides/r1'],
  ['override-unknown-field', 'document.invalid-field', '/nodes/inst1/overrides/r1/width'],
  ['override-fills-on-text', 'document.invalid-field', '/nodes/inst1/overrides/t1/fills'],
  ['override-stroke-on-text', 'document.invalid-field', '/nodes/inst1/overrides/t1/stroke'],
  ['override-opacity-on-source', 'document.invalid-field', '/nodes/inst1/overrides/sA/opacity'],
  ['override-visible-on-source', 'document.invalid-field', '/nodes/inst1/overrides/sA/visible'],
  ['override-effects-on-source', 'document.invalid-field', '/nodes/inst1/overrides/sA/effects'],
  ['override-opacity-2', 'document.invalid-field', '/nodes/inst1/overrides/r1/opacity'],
  ['override-visible-not-bool', 'document.invalid-field', '/nodes/inst1/overrides/r1/visible'],
  ['override-fills-not-paint', 'document.invalid-field', '/nodes/inst1/overrides/r1/fills/0/paint'],
  ['override-two-blurs', 'document.invalid-field', '/nodes/inst1/overrides/r1/effects/1'],
  ['overrides-not-object', 'document.invalid-field', '/nodes/inst1/overrides'],
  ['overrides-on-symbol', 'document.invalid-field', '/nodes/sP/overrides'],
  ['set-in-v7', 'document.invalid-field', '/nodes/set1/type'],
  ['variant-in-v7', 'document.invalid-field', '/nodes/sA/variant'],
  ['overrides-in-v7', 'document.invalid-field', '/nodes/inst1/overrides'],
];

/** The cases only the key rule of a document (V37-S3 keys and applicability) fails. */
const KEY_RULES = new Set([
  'override-unknown-key',
  'override-other-source',
  'override-page-key',
  'override-fills-on-text',
  'override-stroke-on-text',
  'override-opacity-on-source',
  'override-visible-on-source',
  'override-effects-on-source',
]);

const failed = (result: { ok: boolean; code?: string; path?: string }) =>
  result.ok ? { code: 'none', path: '' } : { code: result.code, path: result.path };

/** V-35's v7 node form: `fill` for `fills`, and no `blendMode`. Edits `value` and returns it. */
function asV7Nodes(value: Json): Json {
  for (const node of Object.values(value.nodes as Record<string, Json>)) {
    if (Object.hasOwn(node, 'fills')) {
      const fills = node.fills as Json[];
      node.fill = fills.length === 0 ? null : fills[0]!.paint;
      delete node.fills;
    }
    delete node.blendMode;
  }
  return value;
}

describe('V37-A01 round trips', () => {
  it('writes the variants document back byte for byte', () => {
    const parsed = parseDocument(GOOD_TEXT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeDocument(parsed.document)).toBe(GOOD_TEXT);
    for (const result of [validateDocument(good()), validateAnyDocument(good())]) {
      expect(result.ok && serializeDocument(result.document)).toBe(GOOD_TEXT);
    }
    const set = parsed.document.nodes.set1!;
    expect(set.type).toBe('symbolSet');
    expect(parsed.document.nodes.sA).toMatchObject({
      variant: { Size: 'Large', State: 'Default' },
    });
    expect(Object.keys((parsed.document.nodes.inst1 as { overrides: object }).overrides)).toEqual([
      'r1',
      'sA',
      't1',
    ]);
  });

  it('round-trips through the M5 envelope', () => {
    const document = parseDocument(GOOD_TEXT);
    if (!document.ok) throw new Error('fixture');
    const text = serializeEnvelope({ document: document.document, lastOpenPageId: 'page-1' });
    const back = parseEnvelope(text);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(serializeDocument(back.envelope.document)).toBe(GOOD_TEXT);
    expect(serializeEnvelope(back.envelope)).toBe(text);
  });

  it('reads a v7 document as v8 with the new fields absent', () => {
    const value = good();
    value.schemaVersion = 7;
    value.nodes.set1.type = 'frame';
    asV7Nodes(value);
    for (const id of ['sA', 'sB']) delete value.nodes[id].variant;
    delete value.nodes.inst1.overrides;
    const results = [
      validateAnyDocument(value),
      parseDocument(JSON.stringify(value)),
      migrateV7toV8(value as unknown as DocumentV7),
    ];
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.schemaVersion).toBe(8);
      expect(
        asV7Nodes({ ...JSON.parse(serializeDocument(result.document)), schemaVersion: 7 }),
      ).toEqual(value);
      expect(JSON.stringify(result.document)).not.toMatch(/"variant"|"overrides"/);
    }
  });

  it('writes the canonical form: sorted keys, last keys, empty overrides as absent', () => {
    const value = good();
    const shuffled = (record: Json) => Object.fromEntries(Object.entries(record).reverse());
    value.nodes.sA.variant = shuffled(value.nodes.sA.variant);
    value.nodes.inst1.overrides = shuffled(value.nodes.inst1.overrides);
    const result = validateDocument(value);
    expect(result.ok && serializeDocument(result.document)).toBe(GOOD_TEXT);

    const empty = good();
    empty.nodes.inst1.overrides = {};
    const plain = validateDocument(empty);
    if (!plain.ok) throw new Error('empty overrides read');
    expect(Object.hasOwn(plain.document.nodes.inst1!, 'overrides')).toBe(false);
    const nodes = (JSON.parse(serializeDocument(plain.document)) as Json).nodes as Json;
    expect(Object.keys(nodes.inst1)).toEqual([
      ...Object.keys(good().nodes.inst1).filter((key) => key !== 'overrides'),
    ]);
    expect(Object.keys(good().nodes.sA).at(-1)).toBe('variant');
    expect(Object.keys(good().nodes.inst1).at(-1)).toBe('overrides');
    // A set's keys are a frame's, `effects` last (V-35 key order).
    expect(Object.keys(good().nodes.set1)).toEqual(Object.keys(good().nodes.set1).sort(() => 0));
    expect(Object.keys(good().nodes.set1).slice(-5)).toEqual([
      'children',
      'fills',
      'stroke',
      'blendMode',
      'effects',
    ]);
  });

  it('reads an override written as `fill` by a v8 build before V-35 as V-35 reads a node, writes fills', () => {
    const green = { r: 0, g: 1, b: 0, a: 1 };
    const value = good();
    value.nodes.inst1.overrides = { r1: { fill: green }, t1: { opacity: 0.5 } };
    value.nodes.inst1.overrides.sA = { fill: null };
    const result = validateDocument(value);
    if (!result.ok) throw new Error(`read: ${result.code} at ${result.path}`);
    const overrides = (result.document.nodes.inst1 as Json).overrides as Json;
    expect(overrides.r1).toEqual({
      fills: [{ paint: green, visible: true, opacity: 1, blendMode: 'normal' }],
    });
    expect(overrides.sA).toEqual({ fills: [] });
    const text = serializeDocument(result.document);
    expect(text).not.toMatch(/"fill":/);
    const written = (JSON.parse(text) as Json).nodes.inst1.overrides as Json;
    expect(Object.keys(written.r1)).toEqual(['fills']);
    // Both keys, and a field V-37 leaves out (`blendMode`, V37-Q5), fail at the key.
    value.nodes.inst1.overrides = { r1: { fill: green, fills: [] } };
    expect(failed(validateDocument(value))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/inst1/overrides/r1/fill',
    });
    value.nodes.inst1.overrides = { r1: { blendMode: 'multiply' } };
    expect(failed(validateDocument(value))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/inst1/overrides/r1/blendMode',
    });
  });

  it('writes an override of one field as that field only', () => {
    const value = good();
    value.nodes.inst1.overrides = { r1: { visible: false } };
    const result = validateDocument(value);
    if (!result.ok) throw new Error('read');
    const text = serializeDocument(result.document);
    expect((JSON.parse(text) as Json).nodes.inst1.overrides).toEqual({ r1: { visible: false } });
  });
});

describe('V37-A01 IndexedDB round trip', () => {
  it('writes the variants document through the store and reads it back byte for byte', async () => {
    const parsed = parseEnvelope(
      serializeEnvelope({
        document: (() => {
          const result = parseDocument(GOOD_TEXT);
          if (!result.ok) throw new Error('fixture');
          return result.document;
        })(),
        lastOpenPageId: 'page-1',
      }),
    );
    if (!parsed.ok) throw new Error('envelope');
    const opened = await openDocumentStore({ indexedDB: new IDBFactory() });
    if (!opened.ok) throw new Error(opened.code);
    expect(await opened.store.write(parsed.envelope)).toEqual({ ok: true, written: true });
    const read = await opened.store.read();
    expect(read).toEqual({ ok: true, envelope: parsed.envelope });
    if (!read.ok || read.envelope === null) return;
    expect(serializeDocument(read.envelope.document)).toBe(GOOD_TEXT);
  });
});

describe('V37-A02 malformed documents (V37-S1 to V37-S3)', () => {
  it('has one fixture per table row', () => {
    const files = readdirSync(path.join(dir, 'malformed'))
      .map((file) => file.replace(/\.json$/, ''))
      .sort();
    expect(MALFORMED.map(([name]) => name).sort()).toEqual(files);
  });

  it.each(MALFORMED)('%s fails with %s at %s', (name, code, at) => {
    const text = malformed(name);
    expect(failed(parseDocument(text))).toEqual({ code, path: at });
    expect(failed(validateAnyDocument(JSON.parse(text)))).toEqual({ code, path: at });
    const value = JSON.parse(text) as Json;
    if (value.schemaVersion === 8) {
      expect(failed(validateDocument(value))).toEqual({ code, path: at });
    }
  });

  it('checks V37-S1 with the nesting loop, then V37-S2, then the keys, in that order', () => {
    // Both a set holding a rectangle and a bad override key: S1 comes first.
    const value = JSON.parse(malformed('set-child-not-symbol')) as Json;
    value.nodes.inst1.overrides.ghost = { opacity: 0.5 };
    expect(failed(validateDocument(value))).toEqual({
      code: 'document.invalid-symbol',
      path: '/nodes/r3/parent',
    });
    // A bad variant and a bad override key: S2 comes first.
    const second = JSON.parse(malformed('variant-duplicate')) as Json;
    second.nodes.inst1.overrides.ghost = { opacity: 0.5 };
    expect(failed(validateDocument(second))).toEqual({
      code: 'document.invalid-variant',
      path: '/nodes/sB/variant',
    });
    // A bad text key comes before a bad property key (M7-T3 then V37-S3).
    const third = good();
    third.nodes.inst1.overrides.ghost = { opacity: 0.5 };
    third.nodes.inst1.textOverrides.r1 = { runs: good().nodes.t1.runs };
    expect(failed(validateDocument(third))).toEqual({
      code: 'document.invalid-symbol',
      path: '/nodes/inst1/textOverrides/r1',
    });
  });

  it('accepts overrides on the source itself for fills and stroke, and on a frame or a group', () => {
    const value = good();
    value.nodes.inst1.overrides.sA = { fills: [], stroke: null };
    expect(validateDocument(value).ok).toBe(true);
    // A group in the source takes opacity and visibility but neither fill nor stroke.
    value.nodes.g1 = {
      ...value.nodes.r1,
      id: 'g1',
      type: 'group',
      parent: 'sA',
      children: [],
    };
    for (const key of ['cornerRadii', 'fills', 'stroke']) delete value.nodes.g1[key];
    value.nodes.g1.children = ['r4'];
    value.nodes.r4 = { ...value.nodes.r1, id: 'r4', parent: 'g1' };
    value.nodes.sA.children.push('g1');
    value.nodes.inst1.overrides.g1 = { opacity: 0.5, visible: false, effects: [] };
    expect(validateDocument(value).ok).toBe(true);
    value.nodes.inst1.overrides.g1 = { fills: [] };
    expect(failed(validateDocument(value))).toEqual({
      code: 'document.invalid-field',
      path: '/nodes/inst1/overrides/g1/fills',
    });
  });

  it('applies V37-S1 and V37-S2 to a fragment tree and skips the V37-S3 key rule', () => {
    for (const [name, code, at] of MALFORMED) {
      const value = JSON.parse(malformed(name)) as Json;
      if (value.schemaVersion !== 8) continue;
      const result = failed(validateFragmentTree(value));
      if (KEY_RULES.has(name)) expect(result).toEqual({ code: 'none', path: '' });
      else expect(result).toEqual({ code, path: at });
    }
    expect(validateFragmentTree(good()).ok).toBe(true);
  });

  it('validates one node with the V37-S2 shape and V37-S3 value rules', () => {
    const value = good();
    expect(validateNode(value.nodes.set1).ok).toBe(true);
    expect(validateNode(value.nodes.sA).ok).toBe(true);
    expect(validateNode(value.nodes.inst1).ok).toBe(true);
    const bad = { ...value.nodes.inst1, overrides: { r1: { opacity: 3 } } };
    expect(validateNode(bad)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/overrides/r1/opacity',
    });
    const badVariant = { ...value.nodes.sA, variant: { Size: 1 } };
    expect(validateNode(badVariant)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/variant/Size',
    });
  });
});

describe('V37-A02 fragments (V37 contract, section 5)', () => {
  const own = (): Editor => createEditor({ document: good() });
  const documentOf = (editor: Editor): DocumentV8 => editor.query({ type: 'document' });
  const fragmentOf = (editor: Editor): Json => {
    const text = editor.query({ type: 'clipboard' })!;
    return JSON.parse(text.slice(text.indexOf('\n') + 1)) as Json;
  };
  const marked = (body: Json): string => {
    const editor = own();
    editor.execute({ type: 'copy', ids: ['sP'] });
    const text = editor.query({ type: 'clipboard' })!;
    return `${text.slice(0, text.indexOf('\n'))}\n${JSON.stringify(body)}`;
  };

  it('copies a variant as a plain symbol and a set with its variants', () => {
    const editor = own();
    expect(editor.execute({ type: 'copy', ids: ['sA'] }).ok).toBe(true);
    const lone = fragmentOf(editor);
    expect(lone.nodes.sA).toBeDefined();
    expect(Object.hasOwn(lone.nodes.sA, 'variant')).toBe(false);
    expect(editor.execute({ type: 'copy', ids: ['set1'] }).ok).toBe(true);
    const whole = fragmentOf(editor);
    expect(whole.nodes.sA.variant).toEqual({ Size: 'Large', State: 'Default' });
    expect(whole.nodes.set1.type).toBe('symbolSet');
  });

  it('carries a variant source without its variant and keeps the instance overrides', () => {
    const editor = own();
    expect(editor.execute({ type: 'copy', ids: ['inst1'] }).ok).toBe(true);
    const fragment = fragmentOf(editor);
    expect(fragment.sources).toEqual(['sA']);
    expect(Object.hasOwn(fragment.sourceNodes.sA, 'variant')).toBe(false);
    expect(fragment.nodes.inst1.overrides).toEqual(good().nodes.inst1.overrides);
    // Pasted into the same document it links to the variant (rule (2) ignores the `variant`).
    const copy = editor.execute({ type: 'paste' });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    const pasted = documentOf(editor).nodes[copy.ids[0]!]!;
    expect(pasted).toMatchObject({ type: 'instance', symbol: 'sA' });
    expect((pasted as { overrides?: unknown }).overrides).toEqual(good().nodes.inst1.overrides);
    expect(validateDocument(JSON.parse(serializeDocument(documentOf(editor)))).ok).toBe(true);
  });

  it('copies an instance with its variant source and maps the override keys to the copies', () => {
    const editor = own();
    expect(editor.execute({ type: 'copy', ids: ['sA', 'inst1'] }).ok).toBe(true);
    const pasted = editor.execute({ type: 'paste' });
    expect(pasted.ok).toBe(true);
    if (!pasted.ok) return;
    const document = documentOf(editor);
    const [source, instance] = pasted.ids.map((id) => document.nodes[id]!);
    expect(source!.type).toBe('symbol');
    expect(Object.hasOwn(source!, 'variant')).toBe(false);
    const keys = Object.keys((instance as { overrides: object }).overrides);
    expect(keys).toHaveLength(3);
    for (const key of keys) {
      expect(document.nodes[key]).toBeDefined();
      expect(key === source!.id || document.nodes[key]!.parent !== 'page-1').toBe(true);
    }
    expect(validateDocument(JSON.parse(serializeDocument(document))).ok).toBe(true);
  });

  it('maps the override keys when a set and its instance are duplicated', () => {
    const editor = own();
    const result = editor.execute({ type: 'duplicateNodes', ids: ['set1', 'inst1'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const document = documentOf(editor);
    const copy = document.nodes[result.ids[1]!] as { symbol: string; overrides: object };
    expect(copy.symbol).not.toBe('sA');
    expect(document.nodes[copy.symbol]!.parent).toBe(result.ids[0]);
    for (const key of Object.keys(copy.overrides)) expect(document.nodes[key]).toBeDefined();
    expect(Object.keys(copy.overrides)).not.toContain('r1');
    expect(validateDocument(JSON.parse(serializeDocument(document))).ok).toBe(true);
  });

  it('rejects a root or carried root with a variant before the tree rules', () => {
    const editor = own();
    editor.execute({ type: 'copy', ids: ['inst1'] });
    const fragment = fragmentOf(editor);
    const withVariant = (where: 'nodes' | 'sourceNodes') => {
      const value = structuredClone(fragment);
      value[where].sA.variant = { Size: 'Large' };
      return value;
    };
    const target = createEditor();
    expect(target.execute({ type: 'paste', text: marked(withVariant('sourceNodes')) })).toEqual({
      ok: false,
      code: 'editor.invalid-clipboard',
      path: '/sourceNodes/sA/variant',
    });
    const root = own();
    root.execute({ type: 'copy', ids: ['sA'] });
    const lone = fragmentOf(root);
    lone.nodes.sA.variant = { Size: 'Large' };
    expect(root.execute({ type: 'paste', text: marked(lone) })).toEqual({
      ok: false,
      code: 'editor.invalid-clipboard',
      path: '/nodes/sA/variant',
    });
  });

  it('checks the override keys and fields against the copied or carried source', () => {
    const editor = own();
    editor.execute({ type: 'copy', ids: ['inst1'] });
    const fragment = fragmentOf(editor);
    const paste = (change: (value: Json) => void) => {
      const value = structuredClone(fragment);
      change(value);
      return createEditor({ document: good() }).execute({ type: 'paste', text: marked(value) });
    };
    const bad = (code: string, at: string) => ({ ok: false, code, path: at });
    expect(paste((v) => (v.nodes.inst1.overrides.ghost = { opacity: 0.5 }))).toEqual(
      bad('editor.invalid-clipboard', '/nodes/inst1/overrides/ghost'),
    );
    expect(paste((v) => (v.nodes.inst1.overrides.r2 = { opacity: 0.5 }))).toEqual(
      bad('editor.invalid-clipboard', '/nodes/inst1/overrides/r2'),
    );
    expect(paste((v) => (v.nodes.inst1.overrides.t1 = { fills: [] }))).toEqual(
      bad('editor.invalid-clipboard', '/nodes/inst1/overrides/t1/fills'),
    );
    expect(paste((v) => (v.nodes.inst1.overrides.sA = { visible: false }))).toEqual(
      bad('editor.invalid-clipboard', '/nodes/inst1/overrides/sA/visible'),
    );
    expect(paste((v) => (v.nodes.inst1.overrides.r1 = { opacity: 2 }))).toEqual(
      bad('document.invalid-field', '/nodes/inst1/overrides/r1/opacity'),
    );
    // With its source copied too, the keys are checked against the copy.
    const both = own();
    both.execute({ type: 'copy', ids: ['sA', 'inst1'] });
    const joint = fragmentOf(both);
    joint.nodes.inst1.overrides.ghost = { opacity: 0.5 };
    expect(both.execute({ type: 'paste', text: marked(joint) })).toEqual(
      bad('editor.invalid-clipboard', '/nodes/inst1/overrides/ghost'),
    );
  });

  it('reads fragments below v8 without the v8 fields and rejects them there', () => {
    const editor = own();
    editor.execute({ type: 'copy', ids: ['inst1'] });
    const fragment = fragmentOf(editor);
    const stripped = structuredClone(fragment);
    delete stripped.nodes.inst1.overrides;
    stripped.schemaVersion = 7;
    const target = createEditor({ document: good() });
    expect(target.execute({ type: 'paste', text: marked(stripped) }).ok).toBe(true);
    const written = structuredClone(fragment);
    written.schemaVersion = 7;
    expect(target.execute({ type: 'paste', text: marked(written) })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/inst1/overrides',
    });
    const set = own();
    set.execute({ type: 'copy', ids: ['set1'] });
    const old = fragmentOf(set);
    old.schemaVersion = 7;
    for (const id of ['sA', 'sB']) delete old.nodes[id].variant;
    expect(target.execute({ type: 'paste', text: marked(old) })).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/set1/type',
    });
  });
});

describe('V-37 a set takes paint bindings as a frame does (V39-S6)', () => {
  it('allows fill, stroke and strokeWidth bindings on a symbolSet', () => {
    for (const key of ['fill', 'stroke', 'strokeWidth'] as const) {
      expect(bindingKeyAllowed('symbolSet', key)).toBe(bindingKeyAllowed('frame', key));
      expect(bindingKeyAllowed('symbolSet', key)).toBe(true);
    }
  });
});
