import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  MAX_EFFECT_OFFSET,
  MAX_EFFECT_RADIUS,
  MAX_EFFECTS,
  migrateV6toV7,
  parseDocument,
  parseEnvelope,
  serializeDocument,
  serializeEnvelope,
  validateAnyDocument,
  validateDocument,
  validateFragmentTree,
  validateNode,
  type DocumentV6,
  type DocumentV7,
  type Effect,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { createEditor } from '../../packages/editor-core/src/index.js';
import { v7Text, v7Value } from '../support/schema-v7.js';

// E41-U4 (E41 contract, section 3, E41-A01): schema v7 adds `effects` to every node. Parse,
// validate (E41-S2, E41-S3, each refusal), migrate v6 to v7, serialize round trip.

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, 'tests/fixtures', file), 'utf8');

type Loose = Record<string, unknown>;

const START = { horizontal: 'start', vertical: 'start' } as const;
const black = { r: 0, g: 0, b: 0, a: 1 };
const SHADOW: Effect = {
  kind: 'dropShadow',
  visible: true,
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offsetX: 0,
  offsetY: 4,
  radius: 8,
};
const BLUR: Effect = { kind: 'layerBlur', visible: false, radius: 4 };

const rect = (id: string, effects: unknown, extra: Loose = {}): Loose => ({
  id,
  name: id,
  parent: 'p',
  frame: { x: 0, y: 0, width: 100, height: 50 },
  rotation: 0,
  constraints: START,
  opacity: 1,
  visible: true,
  type: 'rectangle',
  cornerRadii: [0, 0, 0, 0],
  fill: black,
  stroke: null,
  effects,
  ...extra,
});

const documentOf = (effects: unknown): Loose => ({
  schemaVersion: 7,
  id: 'd',
  pages: [{ id: 'p', name: 'P', children: ['r'] }],
  nodes: { r: rect('r', effects) },
});

function parsed(text: string): DocumentV7 {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

/** The document entry points, each with its path relative to the document. */
function everyEntryPoint(value: Loose) {
  const pick = (result: { ok: boolean; code?: string; path?: string }) => ({
    ok: result.ok,
    code: result.code,
    path: result.path,
  });
  const envelope = parseEnvelope(
    JSON.stringify({ envelopeVersion: 1, lastOpenPageId: 'p', document: value }),
  );
  return [
    pick(parseDocument(JSON.stringify(value))),
    pick(validateDocument(value)),
    pick(validateAnyDocument(value)),
    pick(validateFragmentTree(value)),
    {
      ...pick(envelope),
      path: envelope.ok ? undefined : envelope.path.replace(/^\/document/, ''),
    },
  ];
}

describe('E41-A01 schema v7 effects (E41-S1 to E41-S3)', () => {
  it('pins the limits', () => {
    expect([MAX_EFFECTS, MAX_EFFECT_RADIUS, MAX_EFFECT_OFFSET]).toEqual([8, 1000, 10_000]);
  });

  it('reads both kinds, every flag, the limits themselves and an empty list', () => {
    const effects: Effect[] = [
      SHADOW,
      { ...SHADOW, visible: false, offsetX: -MAX_EFFECT_OFFSET, offsetY: MAX_EFFECT_OFFSET },
      { ...SHADOW, radius: 0, color: { r: 1, g: 0.5, b: 0, a: 0 } },
      { ...SHADOW, radius: MAX_EFFECT_RADIUS },
      BLUR,
      { ...SHADOW, offsetX: 1.5, offsetY: -2.25 },
      { ...SHADOW, offsetX: 0, offsetY: 0 },
      { ...SHADOW, color: black },
    ];
    expect(effects).toHaveLength(MAX_EFFECTS);
    for (const list of [[], [BLUR], [{ ...BLUR, radius: MAX_EFFECT_RADIUS }], effects]) {
      const result = validateDocument(documentOf(list));
      expect(result.ok && result.document.nodes.r!.effects).toEqual(list);
    }
  });

  it('writes effects last in each node, each effect in its key order, and round-trips', () => {
    const value = documentOf([
      { radius: 2, offsetY: 1, offsetX: 0, color: black, visible: true, kind: 'dropShadow' },
      { radius: 3, visible: true, kind: 'layerBlur' },
    ]);
    const result = validateDocument(value);
    if (!result.ok) throw new Error(result.code);
    const text = serializeDocument(result.document);
    const raw = JSON.parse(text) as { nodes: { r: Loose & { effects: Loose[] } } };
    expect(Object.keys(raw.nodes.r).at(-1)).toBe('effects');
    expect(raw.nodes.r.effects.map((effect) => Object.keys(effect))).toEqual([
      ['kind', 'visible', 'color', 'offsetX', 'offsetY', 'radius'],
      ['kind', 'visible', 'radius'],
    ]);
    expect(parsed(text)).toEqual(result.document);
    expect(serializeDocument(parsed(text))).toBe(text);
    const envelope = { document: result.document, lastOpenPageId: 'p' };
    expect(parseEnvelope(serializeEnvelope(envelope))).toEqual({ ok: true, envelope });
  });

  it('normalizes negative zero in offsets and radii', () => {
    const result = validateDocument(
      documentOf([
        { ...SHADOW, offsetX: -0, offsetY: -0, radius: -0 },
        { ...BLUR, radius: -0 },
      ]),
    );
    if (!result.ok) throw new Error(result.code);
    const text = serializeDocument(result.document);
    expect(text).not.toContain('-0');
  });

  const at = (rest: string) => `/nodes/r/effects${rest}`;
  const REFUSALS: [string, unknown, string][] = [
    ['a missing list', undefined, '/nodes/r/effects'],
    ['null', null, at('')],
    ['an object', {}, at('')],
    ['nine effects', Array(9).fill(SHADOW), at('')],
    ['a non-object effect', [5], at('/0')],
    ['an unknown kind', [{ ...SHADOW, kind: 'innerShadow' }], at('/0/kind')],
    ['a missing kind', [{ visible: true, radius: 1 }], at('/0/kind')],
    ['a second layer blur', [BLUR, SHADOW, BLUR], at('/2')],
    ['a shadow key on a blur', [{ ...BLUR, color: black }], at('/0/color')],
    ['a missing blur radius', [{ kind: 'layerBlur', visible: true }], at('/0/radius')],
    ['a missing shadow color', [{ ...SHADOW, color: undefined }], at('/0/color')],
    ['an extra shadow key', [{ ...SHADOW, spread: 2 }], at('/0/spread')],
    ['a non-boolean visible', [{ ...SHADOW, visible: 1 }], at('/0/visible')],
    ['a negative radius', [{ ...SHADOW, radius: -1 }], at('/0/radius')],
    ['a radius above 1000', [{ ...BLUR, radius: 1000.5 }], at('/0/radius')],
    ['a non-finite radius', [{ ...SHADOW, radius: Infinity }], at('/0/radius')],
    ['an offset below -10000', [{ ...SHADOW, offsetX: -10_001 }], at('/0/offsetX')],
    ['an offset above 10000', [{ ...SHADOW, offsetY: 10_001 }], at('/0/offsetY')],
    ['a NaN offset', [{ ...SHADOW, offsetY: Number.NaN }], at('/0/offsetY')],
    ['a colour channel above 1', [{ ...SHADOW, color: { ...black, a: 2 } }], at('/0/color/a')],
    ['a colour with an extra key', [{ ...SHADOW, color: { ...black, x: 0 } }], at('/0/color/x')],
  ];

  it.each(REFUSALS)('refuses %s at its path, at every entry point', (_name, effects, p) => {
    const value = documentOf(effects);
    if (effects === undefined) delete (value.nodes as { r: Loose }).r.effects;
    // NaN and Infinity do not survive JSON, so the text entry points see null there.
    const expected = { ok: false, code: 'document.invalid-field', path: p };
    const [text, ...values] = everyEntryPoint(value);
    for (const result of values) expect(result).toEqual(expected);
    if (JSON.stringify(effects)?.includes('null') !== true || effects === null) {
      expect(text).toEqual(expected);
    }
    expect(() => createEditor({ document: value })).toThrow(`document.invalid-field at ${p}`);
    expect(validateNode((value.nodes as { r: Loose }).r)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: p.slice('/nodes/r'.length),
    });
  });

  it('refuses an effects key below v7, at the node key check', () => {
    for (const version of [2, 3, 4, 5, 6]) {
      const value: Loose = { ...documentOf([]), schemaVersion: version };
      const node = (value.nodes as { r: Loose }).r;
      if (version < 6) node.stroke = null;
      expect(validateAnyDocument(value), `v${version}`).toMatchObject({
        ok: false,
        code: 'document.invalid-field',
      });
    }
  });

  it('accepts effects on every node type, containers and instances included', () => {
    const value = JSON.parse(v7Text(read('m4-appearance/appearance.v6.json'))) as {
      nodes: Record<string, Loose>;
    };
    const types = new Set<string>();
    for (const node of Object.values(value.nodes)) {
      node.effects = [SHADOW, BLUR];
      types.add(node.type as string);
    }
    for (const type of ['rectangle', 'ellipse', 'line', 'path', 'custom', 'frame', 'symbol']) {
      expect(types.has(type), type).toBe(true);
    }
    expect(types.has('text') && types.has('instance') && types.has('group')).toBe(true);
    const result = validateDocument(value);
    expect(result.ok).toBe(true);
  });
});

describe('E41-A01 migration v6 to v7 (E41-S1)', () => {
  it('adds effects: [] to every node and changes nothing else', () => {
    const v6 = JSON.parse(read('m4-appearance/appearance.v6.json')) as DocumentV6;
    const migrated = migrateV6toV7(v6);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;
    expect(migrated.document.schemaVersion).toBe(7);
    expect(Object.keys(migrated.document.nodes).sort()).toEqual(Object.keys(v6.nodes).sort());
    for (const [id, node] of Object.entries(v6.nodes)) {
      const { effects, ...rest } = migrated.document.nodes[id]!;
      expect(effects).toEqual([]);
      expect(rest).toEqual(node);
    }
    expect(serializeDocument(migrated.document)).toBe(
      v7Text(read('m4-appearance/appearance.v6.json')),
    );
  });

  it('validates the input with the v6 rules', () => {
    const value = { ...documentOf([]), schemaVersion: 6 } as unknown as DocumentV6;
    expect(migrateV6toV7(value)).toMatchObject({ ok: false, code: 'document.invalid-field' });
    const node = (value.nodes as unknown as { r: Loose }).r;
    delete node.effects;
    node.opacity = 2;
    expect(migrateV6toV7(value)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/r/opacity',
    });
  });

  it('loads every v1 to v6 document through the chain to v7', () => {
    for (const file of [
      'p5-model/shapes.json',
      'm1-model/containers.json',
      'm7-symbols/symbols.v3.json',
      'm6-text/text.v4.json',
      'm7-symbols/text-symbols.v5.json',
      'm4-appearance/host.v6.json',
    ]) {
      const document = parsed(read(file));
      expect(document.schemaVersion, file).toBe(7);
      for (const node of Object.values(document.nodes)) expect(node.effects, file).toEqual([]);
    }
  });

  it('upgrades a v6 value to the same document as the helper the tests use', () => {
    const v6 = JSON.parse(read('m4-appearance/host.v6.json')) as Loose;
    const result = validateAnyDocument(v6);
    expect(result.ok && result.document).toEqual(
      (validateDocument(v7Value(v6)) as { document: unknown }).document,
    );
  });
});

describe('E41-S10 an instance draws with its own effects, or else its source’s', () => {
  const symbols = (instance: Effect[], source: Effect[]) => {
    const value = JSON.parse(v7Text(read('m4-appearance/migrated/symbols.v6.json'))) as {
      nodes: Record<string, Loose>;
    };
    value.nodes.s1!.effects = source;
    value.nodes.i1!.effects = instance;
    return value;
  };

  it.each([
    ['none on either', [], [], []],
    ['the source’s when the instance has none', [], [SHADOW], [SHADOW]],
    ['the instance’s when it has some', [BLUR], [SHADOW], [BLUR]],
  ] as const)('detach keeps %s', (_name, instance, source, expected) => {
    const target = createEditor({ document: symbols([...instance], [...source]) });
    const result = target.execute({ type: 'detachInstances', ids: ['i1'] });
    expect(result.ok).toBe(true);
    const node = target.query({ type: 'node', id: 'i1' })!;
    expect(node.type).toBe('frame');
    expect(node.effects).toEqual(expected);
    // The source keeps its own.
    expect(target.query({ type: 'node', id: 's1' })!.effects).toEqual(source);
  });

  it.each([
    ['the source’s when the instance has none', [], [SHADOW], [SHADOW]],
    ['the instance’s when it has some', [BLUR], [SHADOW], [BLUR]],
  ] as const)('a detached paste keeps %s', (_name, instance, source, expected) => {
    const from = createEditor({ document: symbols([...instance], [...source]) });
    expect(from.execute({ type: 'copy', ids: ['i1'] }).ok).toBe(true);
    const text = from.query({ type: 'clipboard' })!;
    // A document without the symbol: the instance pastes as a frame (M7 section 5.2).
    const target = createEditor();
    const pasted = target.execute({ type: 'paste', text });
    expect(pasted.ok).toBe(true);
    const page = target.query({ type: 'document' }).pages[0]!;
    const node = target.query({ type: 'node', id: page.children[0]! })!;
    expect(node.type).toBe('frame');
    expect(node.effects).toEqual(expected);
  });
});
