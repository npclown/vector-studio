// docs/plans/viz-schema-v8.md: real v7 inputs still read into v8 everywhere a document, an
// envelope or a fragment comes in, and v7 is rejected where only the latest version is read.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  migrateV7toV8,
  parseDocument,
  parseEnvelope,
  serializeDocument,
  validateAnyDocument,
  validateDocument,
  validateFragmentTree,
  type DocumentV7,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
import { createEditor } from '../../packages/editor-core/src/index.js';
import { v7Value } from '../support/schema-v7.js';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, 'tests/fixtures', file), 'utf8');

type Json = Record<string, unknown>;
const v6 = (): Json => JSON.parse(read('m4-appearance/appearance.v6.json')) as Json;
/** The v6 appearance fixture as v7 wrote it: `effects: []` on every node, `schemaVersion: 7`. */
const v7 = (): Json => {
  const value = v6();
  const nodes = value.nodes as Record<string, Json>;
  return {
    ...value,
    schemaVersion: 7,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([key, node]) => [key, { ...node, effects: [] }]),
    ),
  };
};
const unsupported = { ok: false, code: 'document.unsupported-version', path: '/schemaVersion' };

describe('schema v8 scaffold', () => {
  it('reads a v7 document into v8: the version, `fills` for `fill` and `blendMode` (V35-S1)', () => {
    const input = v7();
    const any = validateAnyDocument(input);
    const parsed = parseDocument(JSON.stringify(input));
    const migrated = migrateV7toV8(input as unknown as DocumentV7);
    for (const result of [any, parsed, migrated]) {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.schemaVersion).toBe(8);
      expect(JSON.parse(serializeDocument(result.document))).toEqual(v7Value(v6()));
    }
  });

  it('rejects v7 and v9 where only the latest version is read', () => {
    const input = v7();
    for (const version of [7, 9]) {
      expect(validateDocument({ ...input, schemaVersion: version })).toEqual(unsupported);
      expect(validateFragmentTree({ ...input, schemaVersion: version })).toEqual(unsupported);
    }
    expect(parseDocument(JSON.stringify({ ...input, schemaVersion: 9 }))).toEqual(unsupported);
  });

  it('reads a v7 document inside a persistence envelope', () => {
    const input = v7();
    const page = (input.pages as { id: string }[])[0]!.id;
    const result = parseEnvelope(
      JSON.stringify({ envelopeVersion: 1, lastOpenPageId: page, document: input }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope.document.schemaVersion).toBe(8);
  });

  it('pastes a fragment written at schema v7 and copies at v8', () => {
    const editor = createEditor({
      document: {
        schemaVersion: 7,
        id: 'd',
        pages: [{ id: 'p', name: 'P', children: ['r'] }],
        nodes: {
          r: {
            id: 'r',
            name: 'R',
            parent: 'p',
            frame: { x: 0, y: 0, width: 10, height: 10 },
            rotation: 0,
            constraints: { horizontal: 'start', vertical: 'start' },
            opacity: 1,
            visible: true,
            type: 'rectangle',
            cornerRadii: [0, 0, 0, 0],
            fill: { r: 1, g: 0, b: 0, a: 1 },
            stroke: null,
            effects: [],
          },
        },
      },
    });
    expect(editor.execute({ type: 'copy', ids: ['r'] }).ok).toBe(true);
    const text = editor.query({ type: 'clipboard' })!;
    expect(text).toContain('"schemaVersion":8,');
    const at = (version: number) =>
      text.replace('"schemaVersion":8,', `"schemaVersion":${version},`);
    expect(editor.execute({ type: 'paste', text: at(7) }).ok).toBe(true);
    expect(editor.execute({ type: 'paste', text: at(9) })).toEqual(unsupported);
  });
});
