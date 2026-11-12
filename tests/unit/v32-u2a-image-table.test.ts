// V-32 contract (docs/plans/viz-v32-image-contract.md), unit U2a: the document's image table
// (V32-M1, M2) in the unreleased v8 (docs/plans/viz-schema-v8.md): parse, serialize, migration
// and the editor's document literals. Image paints, integrity and pruning (M3, M4) are U2b.
import { createHash } from 'node:crypto';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TABLE_BYTES,
  migrateV7toV8,
  parseDocument,
  serializeDocument,
  validateAnyDocument,
  validateDocument,
  type DocumentV7,
  type DocumentV8,
  type ImageAsset,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { createCounterIdSource, createEditor } from '../../packages/editor-core/src/index.js';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const GIF = [...Buffer.from('GIF89a')];
const WEBP = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')];

/** An asset whose data starts with `magic`, then `extra` zero bytes; keyed by its SHA-256. */
function asset(
  magic: readonly number[],
  mimeType: ImageAsset['mimeType'],
  extra = 9,
): [string, ImageAsset] {
  const bytes = Buffer.from([...magic, ...new Array<number>(extra).fill(0)]);
  const key = createHash('sha256').update(bytes).digest('hex');
  return [key, { mimeType, width: 64, height: 32, data: bytes.toString('base64') }];
}

const [pngKey, png] = asset(PNG, 'image/png');

function document(images?: unknown): Record<string, unknown> {
  return {
    schemaVersion: 8,
    id: 'doc',
    pages: [{ id: 'page', name: 'Page 1', children: [] }],
    nodes: {},
    ...(images === undefined ? {} : { images }),
  };
}

function rejected(images: unknown) {
  const result = validateDocument(document(images));
  return result.ok ? 'ok' : `${result.code} ${result.path}`;
}

describe('V32-M1 the image table', () => {
  it('a v8 document without images parses without a table and serializes without it', () => {
    const parsed = parseDocument(JSON.stringify(document()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect('images' in parsed.document).toBe(false);
    expect(Object.keys(JSON.parse(serializeDocument(parsed.document)) as object)).toEqual([
      'schemaVersion',
      'id',
      'pages',
      'nodes',
    ]);
  });

  it('a v7 document migrates without a table, and v7 cannot carry images', () => {
    const v7 = { ...document(), schemaVersion: 7 };
    const migrated = migrateV7toV8(v7 as unknown as DocumentV7);
    expect(migrated.ok && 'images' in migrated.document).toBe(false);
    const any = validateAnyDocument(v7);
    expect(any.ok && 'images' in any.document).toBe(false);
    const withImages = validateAnyDocument({ ...v7, images: {} });
    expect(withImages).toEqual({ ok: false, code: 'document.invalid-field', path: '/images' });
  });

  it('round-trips the four formats, keys in code unit order, after the nodes', () => {
    const entries = [
      asset(GIF, 'image/gif'),
      asset(PNG, 'image/png'),
      asset(JPEG, 'image/jpeg'),
      asset(WEBP, 'image/webp'),
    ];
    const parsed = parseDocument(JSON.stringify(document(Object.fromEntries(entries))));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const text = serializeDocument(parsed.document);
    const written = JSON.parse(text) as { images: Record<string, ImageAsset> };
    expect(Object.keys(written)).toEqual(['schemaVersion', 'id', 'pages', 'nodes', 'images']);
    expect(Object.keys(written.images)).toEqual(entries.map(([key]) => key).sort());
    expect(written.images).toEqual(Object.fromEntries(entries));
    const again = parseDocument(text);
    expect(again.ok && serializeDocument(again.document)).toBe(text);
  });

  it('rejects each malformed entry at its path', () => {
    const at = (key: string, field = '') => `document.invalid-field /images/${key}${field}`;
    expect(rejected([])).toBe('document.invalid-field /images');
    expect(rejected({ [pngKey.toUpperCase()]: png })).toBe(at(pngKey.toUpperCase()));
    expect(rejected({ abc: png })).toBe(at('abc'));
    expect(rejected({ [pngKey]: { ...png, extra: 1 } })).toBe(at(pngKey, '/extra'));
    expect(rejected({ [pngKey]: { ...png, mimeType: 'image/bmp' } })).toBe(at(pngKey, '/mimeType'));
    for (const width of [0, 1.5, 32769, Number.NaN]) {
      expect(rejected({ [pngKey]: { ...png, width } }), String(width)).toBe(at(pngKey, '/width'));
    }
    // More than 2^26 pixels.
    expect(rejected({ [pngKey]: { ...png, width: 8193, height: 8192 } })).toBe(
      at(pngKey, '/height'),
    );
    expect(rejected({ [pngKey]: { ...png, width: 8192, height: 8192 } })).toBe('ok');
  });

  it('checks the base64 text and the format magic, decoding only the head', () => {
    const at = `document.invalid-field /images/${pngKey}/data`;
    const data = (value: unknown) => rejected({ [pngKey]: { ...png, data: value } });
    expect(data('')).toBe(at);
    expect(data(png.data.slice(1))).toBe(at);
    expect(data(`${png.data.slice(0, -4)}AA*=`)).toBe(at);
    expect(data(`=${png.data.slice(1)}`)).toBe(at);
    expect(data(7)).toBe(at);
    // A JPEG body under a PNG type, and the reverse.
    expect(data(asset(JPEG, 'image/jpeg')[1].data)).toBe(at);
    expect(rejected({ [pngKey]: { ...png, mimeType: 'image/jpeg' } })).toBe(at);
    expect(rejected({ [pngKey]: { ...png, mimeType: 'image/webp' } })).toBe(at);
    // The tail is not decoded: a body that is not an image past its magic still parses.
    // 18 bytes, so the text has no padding and more groups can follow.
    const unpadded = asset(PNG, 'image/png', 10)[1].data;
    expect(data(`${unpadded}${'AAAA'.repeat(4)}`)).toBe('ok');
  });

  it('bounds one asset at 32 MiB and the table at 256 MiB of decoded bytes', () => {
    const at = `document.invalid-field /images/${pngKey}/data`;
    const head = png.data.slice(0, 12);
    const sized = (bytes: number) => head + 'A'.repeat((bytes / 3) * 4 - head.length);
    // Multiples of 3 bytes, so the text has no padding.
    const limit = Math.floor(MAX_IMAGE_BYTES / 3) * 3;
    expect(rejected({ [pngKey]: { ...png, data: sized(limit) } })).toBe('ok');
    expect(rejected({ [pngKey]: { ...png, data: sized(limit + 3) } })).toBe(at);
    // Nine assets of nearly 32 MiB pass 256 MiB at the ninth, in key order.
    const big = sized(limit);
    const keys = Array.from({ length: 9 }, (_, index) => index.toString(16).padStart(64, '0'));
    const table = Object.fromEntries(keys.map((key) => [key, { ...png, data: big }]));
    expect(9 * limit).toBeGreaterThan(MAX_IMAGE_TABLE_BYTES);
    expect(rejected(table)).toBe(`document.invalid-field /images/${keys[8]}`);
    expect(rejected(Object.fromEntries(Object.entries(table).slice(0, 8)))).toBe('ok');
  });
});

describe('V32-M4 document literals carry the table', () => {
  it('an editor keeps the images through commands, undo and redo', () => {
    const initial = { ...document({ [pngKey]: png }) } as unknown as DocumentV8;
    const target = createEditor({ document: initial, ids: createCounterIdSource('n') });
    const images = () => target.query({ type: 'document' }).images;
    expect(images()).toEqual({ [pngKey]: png });
    const created = target.execute({
      type: 'createRectangle',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      fill: { r: 1, g: 0, b: 0, a: 1 },
      stroke: null,
    });
    expect(created.ok).toBe(true);
    expect(images()).toEqual({ [pngKey]: png });
    expect(target.execute({ type: 'undo' }).ok).toBe(true);
    expect(images()).toEqual({ [pngKey]: png });
    expect(target.execute({ type: 'redo' }).ok).toBe(true);
    expect(images()).toEqual({ [pngKey]: png });
  });

  it('a new editor starts without a table', () => {
    const empty = createEditor().query({ type: 'document' });
    expect('images' in empty).toBe(false);
    const parsed = parseDocument(serializeDocument(empty));
    expect(parsed.ok && 'images' in parsed.document).toBe(false);
  });
});
