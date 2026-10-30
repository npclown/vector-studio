import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  DOCUMENT_ERROR_CODES,
  ENVELOPE_ERROR_CODES,
  ENVELOPE_VERSION,
  MAX_DEPTH,
  MAX_TREE_DEPTH,
  parseDocument,
  parseEnvelope,
  scanJson,
  serializeDocument,
  serializeEnvelope,
  type DocumentV6,
  type EnvelopeResult,
  type PersistenceEnvelope,
} from '@vector-studio/model';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The repository's executable boundary policy is JavaScript tooling.
import { boundaries } from '../../tooling/boundary-policy.mjs';

// MVP M5-U1 (M5 contract, section 2): the persistence envelope, its text form and codes, and the
// `scanJson` `maxDepth` option (M5-A01 to M5-A03). The committed envelope fixtures under
// tests/fixtures/m5-persistence were built from the committed M1 v2 fixtures (three header lines,
// then the document text indented by two spaces), not by `serializeEnvelope`. Since M4-U1 the
// model returns and writes schema v6, so they read as their committed v6 migrations under
// tests/fixtures/m4-appearance/migrated, which differ from them in the document's version and the
// M4-M1 stroke keys (M7 contract, section 2.1; M6a contract, section 2.1; M4 contract, section
// 2.1).

const root = path.resolve(import.meta.dirname, '../..');
const m5 = path.join(root, 'tests/fixtures/m5-persistence');
const m1 = path.join(root, 'tests/fixtures/m1-model');
const p5 = path.join(root, 'tests/fixtures/p5-model');
const m4 = path.join(root, 'tests/fixtures/m4-appearance/migrated');
const v6Name = (name: string) => `${name.replace(/\.v2$/, '')}.v6`;

/** Each committed envelope fixture, its M1 v2 document fixture and its last open page. */
const ENVELOPES = [
  ['empty', 'empty.v2', 'page-1'],
  ['shapes', 'shapes.v2', 'page-1'],
  ['ext-star', 'ext-star.v2', 'page-1'],
  ['containers', 'containers', 'page-2'],
] as const;
const V1 = ['empty', 'ext-star', 'shapes'] as const;

function read(dir: string, name: string): Promise<string> {
  return readFile(path.join(dir, `${name}.json`), 'utf8');
}

function parsedDocument(text: string): DocumentV6 {
  const result = parseDocument(text);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.document;
}

function parsed(text: string): PersistenceEnvelope {
  const result = parseEnvelope(text);
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.envelope;
}

function failure(result: EnvelopeResult): { code: string; path: string } {
  expect(result.ok).toBe(false);
  expect(result).not.toHaveProperty('envelope');
  return result.ok ? { code: 'none', path: '' } : { code: result.code, path: result.path };
}

/** A v2 document with one custom node `c` whose data is `0`, as compact text. */
function customDocumentText(): string {
  return JSON.stringify({
    schemaVersion: 2,
    id: 'd',
    pages: [{ id: 'p', name: 'P', children: ['c'] }],
    nodes: {
      c: {
        id: 'c',
        name: 'C',
        parent: 'p',
        frame: { x: 0, y: 0, width: 1, height: 1 },
        rotation: 0,
        constraints: { horizontal: 'start', vertical: 'start' },
        opacity: 1,
        visible: true,
        type: 'custom',
        customType: 'ext.test',
        data: 0,
        fill: null,
        stroke: null,
      },
    },
  });
}

/** The document at JSON container depth `depth`: document, nodes and node, then arrays. */
function documentAtDepth(depth: number): string {
  const arrays = depth - 3;
  return customDocumentText().replace(
    '"data":0',
    `"data":${'['.repeat(arrays)}${']'.repeat(arrays)}`,
  );
}

function envelopeText(documentText: string, lastOpenPageId = 'p'): string {
  return `{"envelopeVersion":1,"lastOpenPageId":${JSON.stringify(lastOpenPageId)},"document":${documentText}}`;
}

describe('M5-A01 envelope text and round trip', () => {
  it('exports the envelope version 1', () => {
    expect(ENVELOPE_VERSION).toBe(1);
  });

  it.each(ENVELOPES)(
    'serializes the %s envelope byte for byte to its committed fixture',
    async (name, documentName, page) => {
      const text = await read(m5, `${name}.envelope`);
      const v6 = await read(m4, `${name}.envelope.v6`);
      const document = parsedDocument(await read(m4, v6Name(documentName)));
      expect(serializeEnvelope({ document, lastOpenPageId: page })).toBe(v6);
      expect(serializeEnvelope(parsed(text))).toBe(v6);
      expect(serializeEnvelope(parsed(v6))).toBe(v6);
    },
  );

  it('writes envelopeVersion, lastOpenPageId and document in that order with a final newline', async () => {
    const text = serializeEnvelope({
      document: parsedDocument(await read(m1, 'empty.v2')),
      lastOpenPageId: 'page-1',
    });
    expect(
      text.startsWith(
        '{\n  "envelopeVersion": 1,\n  "lastOpenPageId": "page-1",\n  "document": {\n    "schemaVersion": 6,\n',
      ),
    ).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'envelopeVersion',
      'lastOpenPageId',
      'document',
    ]);
    expect(text.endsWith('\n  }\n}\n')).toBe(true);
  });

  it.each(ENVELOPES.map(([, documentName]) => documentName))(
    'round-trips the M1 fixture %s with each page as lastOpenPageId',
    async (documentName) => {
      const documentText = await read(m4, v6Name(documentName));
      const document = parsedDocument(await read(m1, documentName));
      expect(document.pages.length).toBeGreaterThan(0);
      for (const page of document.pages) {
        const envelope = { document, lastOpenPageId: page.id };
        const result = parseEnvelope(serializeEnvelope(envelope));
        expect(result).toEqual({ ok: true, envelope });
        expect(result.ok && serializeDocument(result.envelope.document)).toBe(documentText);
      }
    },
  );

  it('has two pages in the containers fixture, so a non-first page round-trips', async () => {
    const document = parsedDocument(await read(m1, 'containers'));
    expect(document.pages.map((page) => page.id)).toEqual(['page-1', 'page-2']);
  });

  it.each(V1)(
    'migrates the v1 document inside the %s envelope to the committed v6 text',
    async (name) => {
      const v1 = await read(path.join(m5, 'v1'), `${name}.envelope`);
      expect(
        (JSON.parse(v1) as { document: { schemaVersion: number } }).document.schemaVersion,
      ).toBe(1);
      const envelope = parsed(v1);
      expect(envelope.document.schemaVersion).toBe(6);
      expect(serializeEnvelope(envelope)).toBe(await read(m4, `${name}.envelope.v6`));
      expect(serializeDocument(envelope.document)).toBe(await read(m4, `${name}.v6`));
    },
  );

  it('does not validate on serialize, as serializeDocument', async () => {
    const document = parsedDocument(await read(m1, 'empty.v2'));
    const text = serializeEnvelope({ document, lastOpenPageId: 'page-9' });
    expect(failure(parseEnvelope(text))).toEqual({
      code: 'envelope.unknown-page',
      path: '/lastOpenPageId',
    });
  });

  it('keeps lastOpenPageId out of the document', async () => {
    const document = parsedDocument(await read(m1, 'containers'));
    const envelope = parsed(serializeEnvelope({ document, lastOpenPageId: 'page-2' }));
    expect(Object.keys(envelope.document)).toEqual(['schemaVersion', 'id', 'pages', 'nodes']);
    expect(Object.keys(envelope)).toEqual(['document', 'lastOpenPageId']);
  });
});

describe('M5-A02 envelope codes and their order', () => {
  const expected: Record<string, [string, string]> = {
    'malformed-json': ['envelope.malformed-json', ''],
    'not-object': ['envelope.invalid-field', ''],
    'missing-version': ['envelope.unsupported-version', '/envelopeVersion'],
    'unsupported-version': ['envelope.unsupported-version', '/envelopeVersion'],
    'duplicate-top-key': ['envelope.invalid-field', '/document'],
    'duplicate-node-id': ['document.duplicate-id', '/document/nodes/r1'],
    'duplicate-document-field': ['document.invalid-field', '/document/id'],
    'missing-page-id': ['envelope.invalid-field', '/lastOpenPageId'],
    'unknown-key': ['envelope.invalid-field', '/viewport'],
    'nul-page-id': ['envelope.invalid-field', '/lastOpenPageId'],
    'document-not-object': ['document.invalid-field', '/document'],
    'document-unsupported-version': ['document.unsupported-version', '/document/schemaVersion'],
    'document-invalid-field': ['document.invalid-field', '/document/nodes/r1/opacity'],
    'document-duplicate-page-id': ['document.duplicate-id', '/document/pages/1/id'],
    'document-dangling-reference': ['document.dangling-reference', '/document/pages/0/children/5'],
    'document-cyclic-parent': ['document.cyclic-parent', '/document/nodes/f1/parent'],
    'document-invalid-mask-source': [
      'document.invalid-mask-source',
      '/document/nodes/mg1/children/0',
    ],
    'unknown-page': ['envelope.unknown-page', '/lastOpenPageId'],
    // One fixture per adjacent pair of the seven steps of section 2.1, failing both: the earlier
    // step's failure is returned.
    'order-1-2': ['envelope.malformed-json', ''],
    'order-2-3': ['envelope.invalid-field', ''],
    'order-3-4': ['envelope.unsupported-version', '/envelopeVersion'],
    'order-4-5': ['document.duplicate-id', '/document/nodes/r1'],
    'order-5-6': ['envelope.invalid-field', '/viewport'],
    'order-6-7': ['document.invalid-field', '/document/nodes/r1/opacity'],
  };

  it('has the four envelope codes, apart from the document codes', () => {
    expect(ENVELOPE_ERROR_CODES).toEqual([
      'envelope.malformed-json',
      'envelope.unsupported-version',
      'envelope.invalid-field',
      'envelope.unknown-page',
    ]);
    expect(
      ENVELOPE_ERROR_CODES.filter((code) =>
        (DOCUMENT_ERROR_CODES as readonly string[]).includes(code),
      ),
    ).toEqual([]);
  });

  it('has one committed fixture per case', async () => {
    const names = (await readdir(path.join(m5, 'malformed'))).map((file) =>
      file.replace(/\.json$/, ''),
    );
    expect(names.sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))('%s fails with its code and path', async (name, [code, at]) => {
    const text = await read(path.join(m5, 'malformed'), name);
    expect(failure(parseEnvelope(text))).toEqual({ code, path: at });
  });

  it.each(['null', '1', 'true', '"text"', '[]'])(
    'fails a top-level %s with the envelope code at the root',
    (text) => {
      expect(failure(parseEnvelope(text))).toEqual({ code: 'envelope.invalid-field', path: '' });
    },
  );

  it('fails each order fixture at the later step once the earlier step is fixed', async () => {
    const later: Record<string, [string, string]> = {
      'order-2-3': ['envelope.unsupported-version', '/envelopeVersion'],
      'order-3-4': ['document.duplicate-id', '/document/nodes/r1'],
      'order-5-6': ['document.unsupported-version', '/document/schemaVersion'],
      'order-6-7': ['envelope.unknown-page', '/lastOpenPageId'],
    };
    const fix: Record<string, (text: string) => string> = {
      'order-2-3': (text) => JSON.stringify((JSON.parse(text) as unknown[])[0]),
      'order-3-4': (text) => text.replace('"envelopeVersion": 2', '"envelopeVersion": 1'),
      'order-5-6': (text) => {
        const value = JSON.parse(text) as Record<string, unknown>;
        delete value.viewport;
        return JSON.stringify(value);
      },
      'order-6-7': (text) => text.replace('"opacity": 2', '"opacity": 1'),
    };
    for (const [name, [code, at]] of Object.entries(later)) {
      const text = fix[name]!(await read(path.join(m5, 'malformed'), name));
      expect(failure(parseEnvelope(text))).toEqual({ code, path: at });
    }
    // order-1-2 and order-4-5: the later step alone is the not-object and unknown-key cases.
    const pair12 = (await read(path.join(m5, 'malformed'), 'order-1-2')).slice(1);
    expect(parseEnvelope(`[${pair12}]`)).toEqual({
      ok: false,
      code: 'envelope.invalid-field',
      path: '',
    });
    const pair45 = await read(path.join(m5, 'malformed'), 'order-4-5');
    expect(failure(parseEnvelope(pair45.replace('      "r1": null,\n', '')))).toEqual({
      code: 'envelope.invalid-field',
      path: '/viewport',
    });
  });

  it('requires envelopeVersion to be exactly the number 1', async () => {
    const text = await read(m5, 'empty.envelope');
    for (const version of ['"1"', '1.5', '0', 'null', 'true', '[1]']) {
      expect(
        failure(
          parseEnvelope(text.replace('"envelopeVersion": 1', `"envelopeVersion": ${version}`)),
        ),
      ).toEqual({
        code: 'envelope.unsupported-version',
        path: '/envelopeVersion',
      });
    }
    expect(parseEnvelope(text.replace('"envelopeVersion": 1', '"envelopeVersion": 1.0')).ok).toBe(
      true,
    );
  });

  it('reports a missing key before an unknown one, then an invalid page ID', async () => {
    const text = await read(m5, 'empty.envelope');
    const both = text.replace('"lastOpenPageId": "page-1"', '"extra": 0');
    expect(failure(parseEnvelope(both))).toEqual({
      code: 'envelope.invalid-field',
      path: '/lastOpenPageId',
    });
    const noDocument = '{"envelopeVersion":1,"lastOpenPageId":"page-1","doc":{}}';
    expect(failure(parseEnvelope(noDocument))).toEqual({
      code: 'envelope.invalid-field',
      path: '/document',
    });
    const escaped = text.replace('"envelopeVersion": 1,', '"envelopeVersion": 1,\n  "a/b~c": 0,');
    expect(failure(parseEnvelope(escaped))).toEqual({
      code: 'envelope.invalid-field',
      path: '/a~1b~0c',
    });
    for (const id of ['""', '7', 'null', '["page-1"]']) {
      const bad = text.replace('"lastOpenPageId": "page-1"', `"lastOpenPageId": ${id}`);
      expect(failure(parseEnvelope(bad))).toEqual({
        code: 'envelope.invalid-field',
        path: '/lastOpenPageId',
      });
    }
  });

  it('gives a scan finding outside /document the envelope code', async () => {
    const text = await read(m5, 'empty.envelope');
    const nested = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`;
    // The envelope object is depth 1, so an extra key's value reaches depth MAX_DEPTH + 2.
    const deep = text.replace(
      '"envelopeVersion": 1,',
      `"envelopeVersion": 1,\n  "extra": ${nested(MAX_DEPTH + 1)},`,
    );
    expect(failure(parseEnvelope(deep))).toEqual({
      code: 'envelope.invalid-field',
      path: `/extra${'/0'.repeat(MAX_DEPTH)}`,
    });
    const repeated = text.replace(
      '"envelopeVersion": 1,',
      '"envelopeVersion": 1,\n  "envelopeVersion": 1,',
    );
    expect(failure(parseEnvelope(repeated))).toEqual({
      code: 'envelope.invalid-field',
      path: '/envelopeVersion',
    });
  });

  it(`accepts a document at JSON depth ${MAX_DEPTH} alone and inside an envelope, and rejects one more in both`, () => {
    expect(MAX_DEPTH).toBe(256);
    expect(MAX_TREE_DEPTH).toBe(256);
    const atLimit = documentAtDepth(MAX_DEPTH);
    expect(scanJson(atLimit)).toBeNull();
    expect(parseDocument(atLimit).ok).toBe(true);
    const inside = parseEnvelope(envelopeText(atLimit));
    expect(inside.ok).toBe(true);
    expect(inside.ok && serializeDocument(inside.envelope.document)).toBe(
      serializeDocument(parsedDocument(atLimit)),
    );

    const tooDeep = documentAtDepth(MAX_DEPTH + 1);
    const dataPath = `/nodes/c/data${'/0'.repeat(MAX_DEPTH - 3)}`;
    expect(parseDocument(tooDeep)).toEqual({
      ok: false,
      code: 'document.invalid-field',
      path: dataPath,
    });
    expect(failure(parseEnvelope(envelopeText(tooDeep)))).toEqual({
      code: 'document.invalid-field',
      path: `/document${dataPath}`,
    });
  });

  it('prefixes a repeated node key with /document and gives a repeated top-level key the envelope code', () => {
    const documentText = customDocumentText().replace('"nodes":{', '"nodes":{"c":null,');
    expect(parseDocument(documentText)).toEqual({
      ok: false,
      code: 'document.duplicate-id',
      path: '/nodes/c',
    });
    expect(failure(parseEnvelope(envelopeText(documentText)))).toEqual({
      code: 'document.duplicate-id',
      path: '/document/nodes/c',
    });
    const twice = `{"envelopeVersion":1,"lastOpenPageId":"p","lastOpenPageId":"p","document":${customDocumentText()}}`;
    expect(failure(parseEnvelope(twice))).toEqual({
      code: 'envelope.invalid-field',
      path: '/lastOpenPageId',
    });
  });

  it('checks the page against the migrated v1 document', async () => {
    const v1 = await read(path.join(m5, 'v1'), 'shapes.envelope');
    expect(
      failure(parseEnvelope(v1.replace('"lastOpenPageId": "page-1"', '"lastOpenPageId": "r1"'))),
    ).toEqual({
      code: 'envelope.unknown-page',
      path: '/lastOpenPageId',
    });
    const v1Bad = v1.replace('"schemaVersion": 1', '"schemaVersion": 1,\n    "extra": 0');
    expect(failure(parseEnvelope(v1Bad))).toEqual({
      code: 'document.invalid-field',
      path: '/document/extra',
    });
  });
});

describe('M5-A03 model stays unchanged and import-free', () => {
  // SHA-256 of every P5 and M1 model fixture at main d004b31, before M5.
  const FIXTURE_HASHES: Record<string, string> = {
    'm1-model/containers.json': 'cd89637067dcd58961cd24c355ae05b82a0ef0f91711203feb76eeb1bfd037d4',
    'm1-model/empty.v2.json': 'df8580fa2d18d9fa65027cf4318f0889e1f9200637cc587bf700945d6158d89c',
    'm1-model/ext-star.v2.json': 'f4d314ddaaa2464f8873b94067c2e469f112c568a8ed26c74e8bf4af30e65b6b',
    'm1-model/malformed/container-opacity.json':
      'e87d29330a4065c7502edccd3a8200fad306c943191d5be92ccb15227631ae68',
    'm1-model/malformed/cyclic-parent.json':
      '0f1fdb2bdc7909fb037930ef12633c4df502363cdc25b2198a96ea211148fa8b',
    'm1-model/malformed/dangling-container-child.json':
      'c3e40c29669b575fdd7368d874c43e121056686e3dec99142e9b4dc936e6444c',
    'm1-model/malformed/duplicate-page-id.json':
      'd85f8cc6a7707c64d3412df0f228c6564b11584752d8d245ffb241be3bbd01f6',
    'm1-model/malformed/empty-group.json':
      'ff5b9ba23648f68b12ff0a3ebb58df6e7d55ae1c1563c99b1aabee254c0420f2',
    'm1-model/malformed/invalid-mask-source.json':
      '72a45a1adf239f8782aac59c7d0c06059129bed7c3099a09c1f1d7145161126d',
    'm1-model/malformed/line-points.json':
      '8dda4504a55205c351f5ae29639cb742932d0af9eadedc374fe292d77927b352',
    'm1-model/malformed/nul-id.json':
      'e6dc522209f7a492e37072be17090bb2431bf86909ce24445522b28b1e2431d4',
    'm1-model/malformed/unsupported-version.json':
      // Moved from schemaVersion 3 to 4 by M7-U1 (M7 contract, section 2.1), to 5 by M6a-U1 (M6a
      // contract, section 2.1), to 6 by M7-U7 (M6a contract, section 9), to 7 by M4-U1 (M4
      // contract, section 2.1).
      '19443ac30ab86707a7d7a98507177617a364fa817ac8a3419eb548a3f585971f',
    'm1-model/shapes.v2.json': '7d03fa27cb8ce892150eea79aba402a596a9dfd0f26a8115efc9c5fd90226948',
    'p5-model/empty.json': '5935aafb5604fd7847dfe5c1a6e843f021aaa523bfb26ff50fdf3c4d13b5dc7f',
    'p5-model/ext-star.json': '942ad8c439902aaf1c30bce6b0e8cf0690eeff2613c899372ab250a9f43b9246',
    'p5-model/malformed-custom/invalid-custom-data.json':
      '30ddf6c51aedff7b2f12f69bc5f34ca2c5a1ff76dc59a57de0d628388cf1913c',
    'p5-model/malformed-custom/unknown-custom-type.json':
      '597abc0e33013ee85ea3cc81ec182106403130d0bed25e39199f862e4c6dce20',
    'p5-model/malformed/dangling-reference.json':
      '597b3bcbebb5606c0e80e4aeadb9a72da53334ce1547fcf06b72dd0365b73a58',
    'p5-model/malformed/duplicate-id.json':
      '0f23642dc16ee4f598e05f90525442070ee5697e28fb2202e4cc4fb973877407',
    'p5-model/malformed/invalid-field.json':
      'f00d15dce4708d847313b221410473f3a2667ea2121f17de734119c9b585dbb8',
    'p5-model/malformed/malformed-json.json':
      '9677e620c8f60b085efd1cab642a751c49565d8d86fb8fa99f662f5efd158ee9',
    'p5-model/malformed/unsupported-version.json':
      // Moved from schemaVersion 3 to 4 by M7-U1 (M7 contract, section 2.1), to 5 by M6a-U1 (M6a
      // contract, section 2.1), to 6 by M7-U7 (M6a contract, section 9), to 7 by M4-U1 (M4
      // contract, section 2.1).
      '542c036673bb62925bf2aba70a9ae7d73930f4f36c06a5ab8591e1f5a94eef84',
    'p5-model/shapes.json': '82f2172b30188618e5e925cba612bc72ac439eeed189bdd0eae2eba63a9f0474',
  };

  async function listFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.relative(path.join(root, 'tests/fixtures'), path.join(entry.parentPath, entry.name)),
      )
      .map((file) => file.split(path.sep).join('/'));
  }

  it('keeps every P5 and M1 model fixture byte for byte', async () => {
    const files = [...(await listFiles(p5)), ...(await listFiles(m1))].sort();
    expect(files).toEqual(Object.keys(FIXTURE_HASHES).sort());
    for (const file of files) {
      const bytes = await readFile(path.join(root, 'tests/fixtures', file));
      expect([file, createHash('sha256').update(bytes).digest('hex')]).toEqual([
        file,
        FIXTURE_HASHES[file],
      ]);
    }
  });

  it('keeps parseDocument and serializeDocument on the M1 fixtures', async () => {
    for (const name of ['empty.v2', 'shapes.v2', 'ext-star.v2', 'containers']) {
      const text = await read(m1, name);
      expect(serializeDocument(parsedDocument(text))).toBe(await read(m4, v6Name(name)));
    }
    for (const name of V1) {
      expect(serializeDocument(parsedDocument(await read(p5, name)))).toBe(
        await read(m4, `${name}.v6`),
      );
    }
    // parseDocument still scans at MAX_DEPTH, not MAX_DEPTH + 1, and does not accept an envelope.
    expect(parseDocument(documentAtDepth(MAX_DEPTH + 1)).ok).toBe(false);
    expect(parseDocument(await read(m5, 'empty.envelope'))).toEqual({
      ok: false,
      code: 'document.unsupported-version',
      path: '/schemaVersion',
    });
  });

  it('keeps scanJson without maxDepth as before', () => {
    const nested = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`;
    expect(scanJson(nested(MAX_DEPTH))).toBeNull();
    expect(scanJson(nested(MAX_DEPTH + 1))).toEqual({
      kind: 'too-deep',
      path: Array.from({ length: MAX_DEPTH }, () => 0),
    });
    expect(scanJson(nested(MAX_DEPTH + 1), {})).toEqual(scanJson(nested(MAX_DEPTH + 1)));
    expect(scanJson('{"a":1,"b":{"c":2,"c":3}}')).toEqual({
      kind: 'duplicate-key',
      path: ['b', 'c'],
    });
    expect(scanJson('{"a":[{"x":1},{"x":2}]}')).toBeNull();
  });

  it('applies maxDepth when given', () => {
    const nested = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`;
    expect(scanJson(nested(MAX_DEPTH + 1), { maxDepth: MAX_DEPTH + 1 })).toBeNull();
    expect(scanJson(nested(MAX_DEPTH + 2), { maxDepth: MAX_DEPTH + 1 })).toEqual({
      kind: 'too-deep',
      path: Array.from({ length: MAX_DEPTH + 1 }, () => 0),
    });
    expect(scanJson('[[1]]', { maxDepth: 1 })).toEqual({ kind: 'too-deep', path: [0] });
    expect(scanJson('{"a":1,"a":2}', { maxDepth: 1 })).toEqual({
      kind: 'duplicate-key',
      path: ['a'],
    });
  });

  it('keeps the model free of imports', async () => {
    expect([...(boundaries as Map<string, Set<string>>).get('@vector-studio/model')!]).toEqual([]);
    const dir = path.join(root, 'packages/model/src');
    const sources = (await readdir(dir)).filter((file) => file.endsWith('.ts')).sort();
    expect(sources).toEqual([
      'envelope.ts',
      'index.ts',
      'json-scan.ts',
      'parse.ts',
      'serialize.ts',
      'types.ts',
    ]);
    for (const file of sources) {
      const text = await readFile(path.join(dir, file), 'utf8');
      const specifiers = [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1]!);
      expect([file, specifiers.filter((specifier) => !specifier.startsWith('./'))]).toEqual([
        file,
        [],
      ]);
      expect([file, /\bimport\s*\(|\brequire\s*\(/.test(text)]).toEqual([file, false]);
    }
    const manifest = JSON.parse(
      await readFile(path.join(root, 'packages/model/package.json'), 'utf8'),
    ) as Record<string, unknown>;
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      expect(manifest[field]).toBeUndefined();
    }
  });
});
