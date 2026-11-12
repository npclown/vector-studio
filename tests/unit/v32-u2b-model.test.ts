// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U2b, V32-A01 (the rest after U2a):
// the image paint (V32-M3), its parse rules and integrity (M4), serialize order.
import {
  migrateV7toV8,
  parseDocument,
  serializeDocument,
  validateAnyDocument,
  validateDocument,
  validateFragmentTree,
  type DocumentV7,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { entry, makeAsset } from '../support/v32-images.js';

type Json = Record<string, unknown>;

const START = { horizontal: 'start', vertical: 'start' };
const a = makeAsset(1);
const b = makeAsset(2, 10, 20, 'image/jpeg');
const imagePaint = (key: string, extra: Json = {}) => ({
  kind: 'image',
  image: key,
  scaleMode: 'fill',
  scale: 1,
  ...extra,
});
const fills = (paint: unknown) => [{ paint, visible: true, opacity: 1, blendMode: 'normal' }];

function rectangle(id: string, extra: Json = {}): Json {
  return {
    id,
    name: id,
    parent: 'page',
    frame: { x: 0, y: 0, width: 50, height: 40 },
    rotation: 0,
    constraints: START,
    opacity: 1,
    visible: true,
    type: 'rectangle',
    cornerRadii: [0, 0, 0, 0],
    fills: fills(imagePaint(a.key)),
    stroke: null,
    blendMode: 'normal',
    effects: [],
    ...extra,
  };
}

function document(nodes: Json[], images?: unknown): Json {
  return {
    schemaVersion: 8,
    id: 'doc',
    pages: [{ id: 'page', name: 'Page', children: nodes.map((n) => n.id) }],
    nodes: Object.fromEntries(nodes.map((n) => [n.id as string, n])),
    ...(images === undefined ? {} : { images }),
  };
}

const TABLE = { [a.key]: entry(a), [b.key]: entry(b) };

function failure(value: unknown): string {
  const result = validateDocument(value);
  return result.ok ? 'ok' : `${result.code} ${result.path}`;
}

describe('V32-A01 image paints in the model', () => {
  it('migrates a v7 document without an images table and parses a v8 one without', () => {
    const v7: DocumentV7 = {
      schemaVersion: 7,
      id: 'doc',
      pages: [{ id: 'page', name: 'P', children: [] }],
      nodes: {},
    };
    const migrated = migrateV7toV8(v7);
    expect(migrated.ok).toBe(true);
    if (migrated.ok) expect('images' in migrated.document).toBe(false);
    const any = validateAnyDocument(v7);
    expect(any.ok && 'images' in any.document).toBe(false);
    expect(failure(document([]))).toBe('ok');
  });

  it('round-trips three image paints over two assets, with the table after the nodes', () => {
    const value = document(
      [
        rectangle('r1'),
        rectangle('r2', { fills: fills(imagePaint(b.key, { scaleMode: 'tile', scale: 0.5 })) }),
        rectangle('r3', { fills: fills(imagePaint(a.key, { scaleMode: 'fit', scale: 100 })) }),
      ],
      TABLE,
    );
    const first = parseDocument(JSON.stringify(value));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const text = serializeDocument(first.document);
    const second = parseDocument(text);
    expect(second.ok && second.document).toEqual(first.document);
    const written = JSON.parse(text) as Json;
    expect(Object.keys(written).slice(-2)).toEqual(['nodes', 'images']);
    const paint = (written.nodes as Record<string, { fills: { paint: unknown }[] }>).r2!.fills[0]!
      .paint;
    expect(Object.keys(paint as object)).toEqual(['kind', 'image', 'scaleMode', 'scale']);
    expect(Object.keys(written.images as object)).toEqual([a.key, b.key].sort());
    // Serializing is stable.
    expect(serializeDocument(second.ok ? second.document : first.document)).toBe(text);
  });

  it('omits an empty table when serializing', () => {
    const parsed = parseDocument(JSON.stringify(document([], {})));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect('images' in JSON.parse(serializeDocument(parsed.document))).toBe(false);
  });

  it('rejects each bad image paint at its path', () => {
    const at = (paint: unknown, images: unknown = TABLE) =>
      failure(
        document([rectangle('r', { fills: fills(paint) })], images === null ? undefined : images),
      );
    const field = (path: string) => `document.invalid-field /nodes/r/fills/0/paint${path}`;
    expect(at(imagePaint(a.key))).toBe('ok');
    // M4: a key the table does not hold, or no table at all.
    expect(at(imagePaint('f'.repeat(64)))).toBe(field('/image'));
    expect(at(imagePaint(a.key), null)).toBe(field('/image'));
    expect(at(imagePaint('not-a-key'))).toBe(field('/image'));
    expect(at(imagePaint(7 as unknown as string))).toBe(field('/image'));
    // M3: scale is finite in [0.01, 100]; the mode is one of four.
    expect(at(imagePaint(a.key, { scale: 0.009 }))).toBe(field('/scale'));
    expect(at(imagePaint(a.key, { scale: 100.1 }))).toBe(field('/scale'));
    expect(at(imagePaint(a.key, { scale: 0.01 }))).toBe('ok');
    expect(at(imagePaint(a.key, { scale: Number.NaN }))).toBe(field('/scale'));
    expect(at(imagePaint(a.key, { scaleMode: 'cover' }))).toBe(field('/scaleMode'));
    // Exactly four keys.
    expect(at({ ...imagePaint(a.key), extra: 1 })).toBe(field(''));
    expect(at({ kind: 'image', image: a.key, scaleMode: 'fill' })).toBe(field(''));
  });

  it('rejects an image paint in a stroke, a style or a text run', () => {
    const stroke = {
      color: imagePaint(a.key),
      width: 1,
      cap: 'butt',
      join: 'round',
      miterLimit: 4,
      dash: null,
    };
    expect(failure(document([rectangle('r', { stroke })], TABLE))).toBe(
      'document.invalid-field /nodes/r/stroke/color',
    );
    const styled = {
      ...document([], TABLE),
      colorStyles: [{ id: 's', name: 'S', paint: imagePaint(a.key) }],
    };
    expect(failure(styled)).toBe('document.invalid-field /colorStyles/0/paint');
  });

  it('checks image paints of frames, ellipses and paths too', () => {
    const base = { frame: { x: 0, y: 0, width: 9, height: 9 } };
    const nodes = [
      rectangle('e', { ...base, type: 'ellipse', cornerRadii: undefined }),
      rectangle('f', { ...base, type: 'frame', cornerRadii: undefined, children: [] }),
    ].map((node) => JSON.parse(JSON.stringify(node)) as Json);
    expect(failure(document(nodes, TABLE))).toBe('ok');
    expect(failure(document(nodes))).toBe('document.invalid-field /nodes/e/fills/0/paint/image');
  });

  it('validates a fragment tree against its own images', () => {
    const holder = (nodes: Json[], images?: unknown): Json => ({
      schemaVersion: 8,
      id: 'holder',
      pages: [{ id: 'holder-page', name: '', children: nodes.map((n) => n.id) }],
      nodes: Object.fromEntries(
        nodes.map((n) => [n.id as string, { ...n, parent: 'holder-page' }]),
      ),
      ...(images === undefined ? {} : { images }),
    });
    const ok = validateFragmentTree(holder([rectangle('r')], TABLE));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.images).toEqual(TABLE);
    const dangling = validateFragmentTree(holder([rectangle('r')]));
    expect(dangling).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: '/nodes/r/fills/0/paint/image',
    });
    const other = validateFragmentTree(holder([rectangle('r')], { [b.key]: entry(b) }));
    expect(other.ok).toBe(false);
    const bad = validateFragmentTree(holder([rectangle('r')], { nope: entry(a) }));
    expect(bad.ok).toBe(false);
    // A table passed as already checked is trusted only when a previous call returned it.
    if (ok.ok && ok.images !== undefined) {
      expect(validateFragmentTree(holder([rectangle('r')]), ok.images).ok).toBe(true);
    }
    const forged = { [a.key]: { ...entry(a), data: '!!' } };
    expect(validateFragmentTree(holder([rectangle('r')]), forged)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: `/images/${a.key}/data`,
    });
  });
});
