import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnvelope, type PersistenceEnvelope } from '@vector-studio/model';
import {
  DATABASE_VERSION,
  DEFAULT_DATABASE_NAME,
  DEFAULT_KEY,
  OBJECT_STORE_NAME,
  openDocumentStore,
  PERSISTENCE_ERROR_CODES,
  type DocumentStore,
  type StoreFailure,
} from '@vector-studio/persistence-idb';
import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

// MVP M5-U3 (M5 contract, section 4.2): the IndexedDB store against fake-indexeddb (M5-Q4 (a)),
// always through the injected factory (M5-A04). Each test uses its own in-memory factory.

const root = path.resolve(import.meta.dirname, '../..');
const m5 = path.join(root, 'tests/fixtures/m5-persistence');
// Since M4-U1 the canonical envelope text holds schema v6: the committed v2 envelope fixtures read
// as their v6 migrations, which differ in the document's version and the M4-M1 stroke keys (M7
// contract, section 2.1; M6a contract, sections 2.1 and 9; M4 contract, section 2.1).
const m4 = path.join(root, 'tests/fixtures/m4-appearance/migrated');

async function text(name: string): Promise<string> {
  if (/^[a-z-]+\.envelope$/.test(name)) return readFile(path.join(m4, `${name}.v6.json`), 'utf8');
  return readFile(path.join(m5, `${name}.json`), 'utf8');
}

async function envelope(name: string): Promise<PersistenceEnvelope> {
  const result = parseEnvelope(await text(name));
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.envelope;
}

async function opened(factory: IDBFactory, options: { key?: string } = {}): Promise<DocumentStore> {
  const result = await openDocumentStore({ indexedDB: factory, ...options });
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.store;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('request failed'));
  });
}

/** Opens the database directly, creating the object store as the adapter does. */
async function connect(factory: IDBFactory, name = DEFAULT_DATABASE_NAME): Promise<IDBDatabase> {
  const req = factory.open(name, DATABASE_VERSION);
  req.onupgradeneeded = () => req.result.createObjectStore(OBJECT_STORE_NAME);
  return request(req);
}

/** The raw stored value, read past the adapter. */
async function rawGet(
  factory: IDBFactory,
  key = DEFAULT_KEY,
  name = DEFAULT_DATABASE_NAME,
): Promise<unknown> {
  const database = await connect(factory, name);
  try {
    return await request(
      database.transaction(OBJECT_STORE_NAME, 'readonly').objectStore(OBJECT_STORE_NAME).get(key),
    );
  } finally {
    database.close();
  }
}

async function rawPut(factory: IDBFactory, value: unknown, key = DEFAULT_KEY): Promise<void> {
  const database = await connect(factory);
  try {
    const tx = database.transaction(OBJECT_STORE_NAME, 'readwrite');
    tx.objectStore(OBJECT_STORE_NAME).put(value, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error('aborted'));
    });
  } finally {
    database.close();
  }
}

/** Aborts the transaction of the next `method` request right after the adapter creates it. */
function abortNext(method: 'get' | 'put' | 'delete'): void {
  const prototype = IDBObjectStore.prototype as unknown as Record<
    typeof method,
    (this: IDBObjectStore, ...args: unknown[]) => IDBRequest
  >;
  const original = prototype[method];
  vi.spyOn(IDBObjectStore.prototype, method).mockImplementationOnce(function (
    this: IDBObjectStore,
    ...args: unknown[]
  ) {
    const req = original.apply(this, args);
    this.transaction.abort();
    return req;
  });
}

function failure(result: { ok: boolean }): StoreFailure {
  expect(result.ok).toBe(false);
  return result as StoreFailure;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('M5-A04 store layout and codes', () => {
  it('has the three persistence codes and the contract layout', () => {
    expect(PERSISTENCE_ERROR_CODES).toEqual([
      'persistence.unavailable',
      'persistence.read-failed',
      'persistence.write-failed',
    ]);
    expect([DEFAULT_DATABASE_NAME, DATABASE_VERSION, OBJECT_STORE_NAME, DEFAULT_KEY]).toEqual([
      'vector-studio',
      1,
      'envelopes',
      'default',
    ]);
  });

  it('creates one object store at IndexedDB version 1', async () => {
    const factory = new IDBFactory();
    (await opened(factory)).close();
    const database = await connect(factory);
    expect([database.version, [...database.objectStoreNames]]).toEqual([1, ['envelopes']]);
    database.close();
  });
});

describe('M5-A04 store read, write, overwrite and clear', () => {
  it('reads null from an empty store', async () => {
    const store = await opened(new IDBFactory());
    expect(await store.read()).toEqual({ ok: true, envelope: null });
  });

  it('writes the envelope text and reads back a deep-equal envelope', async () => {
    const factory = new IDBFactory();
    const store = await opened(factory);
    const shapes = await envelope('shapes.envelope');
    expect(await store.write(shapes)).toEqual({ ok: true, written: true });
    expect(await rawGet(factory)).toBe(await text('shapes.envelope'));
    expect(await store.read()).toEqual({ ok: true, envelope: shapes });
  });

  it('overwrites the one record', async () => {
    const factory = new IDBFactory();
    const store = await opened(factory);
    const empty = await envelope('empty.envelope');
    const containers = await envelope('containers.envelope');
    await store.write(empty);
    expect(await store.write(containers)).toEqual({ ok: true, written: true });
    expect(await rawGet(factory)).toBe(await text('containers.envelope'));
    expect(await store.read()).toEqual({ ok: true, envelope: containers });
  });

  it('clears the record, and the next write of the same text runs', async () => {
    const factory = new IDBFactory();
    const store = await opened(factory);
    const empty = await envelope('empty.envelope');
    await store.write(empty);
    expect(await store.clear()).toEqual({ ok: true });
    expect(await rawGet(factory)).toBeUndefined();
    expect(await store.read()).toEqual({ ok: true, envelope: null });
    expect(await store.write(empty)).toEqual({ ok: true, written: true });
    expect(await rawGet(factory)).toBe(await text('empty.envelope'));
  });

  it('uses the given database name and key', async () => {
    const factory = new IDBFactory();
    const result = await openDocumentStore({
      indexedDB: factory,
      databaseName: 'other-db',
      key: 'doc-2',
    });
    if (!result.ok) throw new Error(result.code);
    await result.store.write(await envelope('empty.envelope'));
    result.store.close();
    expect(await rawGet(factory, 'doc-2', 'other-db')).toBe(await text('empty.envelope'));
    expect(await rawGet(factory, 'default', 'other-db')).toBeUndefined();
    expect(await rawGet(factory)).toBeUndefined();
  });
});

describe('M5-A04 store last-text cache', () => {
  it('skips an unchanged write without a transaction', async () => {
    const store = await opened(new IDBFactory());
    const shapes = await envelope('shapes.envelope');
    await store.write(shapes);
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
    expect(await store.write(shapes)).toEqual({ ok: true, written: false });
    expect(transactions).toHaveBeenCalledTimes(0);
  });

  it('skips a write equal to the record just read', async () => {
    const factory = new IDBFactory();
    await rawPut(factory, await text('shapes.envelope'));
    const store = await opened(factory);
    await store.read();
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
    expect(await store.write(await envelope('shapes.envelope'))).toEqual({
      ok: true,
      written: false,
    });
    expect(transactions).toHaveBeenCalledTimes(0);
  });

  it('writes after a read of a v1 entry, whose stored text differs from the canonical text', async () => {
    const factory = new IDBFactory();
    await rawPut(factory, await readFile(path.join(m5, 'v1/empty.envelope.json'), 'utf8'));
    const store = await opened(factory);
    const read = await store.read();
    if (!read.ok || read.envelope === null) throw new Error('no envelope');
    expect(await store.write(read.envelope)).toEqual({ ok: true, written: true });
    expect(await rawGet(factory)).toBe(await text('empty.envelope'));
  });
});

describe('M5-A04 store unavailable', () => {
  it('is unavailable with no injected factory and no global indexedDB', async () => {
    expect('indexedDB' in globalThis).toBe(false);
    expect(await openDocumentStore()).toEqual({
      ok: false,
      code: 'persistence.unavailable',
      path: '',
    });
  });

  it('reads globalThis.indexedDB only when no factory is injected', async () => {
    const global = new IDBFactory();
    const injected = new IDBFactory();
    vi.stubGlobal('indexedDB', global);
    const empty = await envelope('empty.envelope');
    const fromGlobal = await openDocumentStore();
    if (!fromGlobal.ok) throw new Error(fromGlobal.code);
    await fromGlobal.store.write(empty);
    fromGlobal.store.close();
    const shapes = await envelope('shapes.envelope');
    const store = await opened(injected);
    await store.write(shapes);
    store.close();
    expect(await rawGet(global)).toBe(await text('empty.envelope'));
    expect(await rawGet(injected)).toBe(await text('shapes.envelope'));
  });

  it('is unavailable on an open error', async () => {
    const factory = new IDBFactory();
    // A database at a newer layout version makes the version 1 open fail with VersionError.
    const newer = await request(factory.open(DEFAULT_DATABASE_NAME, 2));
    newer.close();
    expect(await openDocumentStore({ indexedDB: factory })).toEqual({
      ok: false,
      code: 'persistence.unavailable',
      path: '',
    });
  });

  it('is unavailable when open throws', async () => {
    const factory = {
      open: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    } as unknown as IDBFactory;
    expect(await openDocumentStore({ indexedDB: factory })).toEqual({
      ok: false,
      code: 'persistence.unavailable',
      path: '',
    });
  });

  it('is unavailable on a blocked open and closes a connection that still opens', async () => {
    const factory = new IDBFactory();
    // A held connection that ignores versionchange blocks an upgrade. The adapter opens
    // version 1, which nothing can block, so the factory it is given asks for the next version.
    const held = await connect(factory);
    held.onversionchange = () => undefined;
    const blocking = {
      open: (name: string, version?: number) => factory.open(name, (version ?? 1) + 1),
    } as unknown as IDBFactory;
    const closed = vi.fn();
    const opened = openDocumentStore({ indexedDB: blocking });
    expect(await opened).toEqual({ ok: false, code: 'persistence.unavailable', path: '' });
    // Record each close: after the held connection closes, the adapter's request still opens.
    const original = (IDBDatabase.prototype as unknown as { close: (this: IDBDatabase) => void })
      .close;
    const closes = vi.spyOn(IDBDatabase.prototype, 'close').mockImplementation(function (
      this: IDBDatabase,
    ) {
      closed(this.version);
      original.call(this);
    });
    held.close();
    // The adapter's connection opens at version 2 and is closed at once, so a version 3 open
    // is not blocked.
    const later = factory.open(DEFAULT_DATABASE_NAME, 3);
    const blocked = vi.fn();
    later.onblocked = blocked;
    const database = await request(later);
    expect([database.version, blocked.mock.calls.length]).toEqual([3, 0]);
    expect(closed.mock.calls).toEqual([[1], [2]]);
    closes.mockRestore();
    database.close();
  });

  it('closes on versionchange, and a later call is unavailable', async () => {
    const factory = new IDBFactory();
    const store = await opened(factory);
    await store.write(await envelope('empty.envelope'));
    const newer = await request(factory.open(DEFAULT_DATABASE_NAME, 2));
    expect(newer.version).toBe(2);
    newer.close();
    const unavailable = { ok: false, code: 'persistence.unavailable', path: '' };
    expect(await store.read()).toEqual(unavailable);
    expect(await store.write(await envelope('shapes.envelope'))).toEqual(unavailable);
    expect(await store.clear()).toEqual(unavailable);
  });

  it('is unavailable after close', async () => {
    const store = await opened(new IDBFactory());
    store.close();
    expect(await store.read()).toEqual({
      ok: false,
      code: 'persistence.unavailable',
      path: '',
    });
  });
});

describe('M5-A04 store failed transactions', () => {
  it('gives read-failed for an aborted read and leaves the entry', async () => {
    const factory = new IDBFactory();
    const stored = await text('shapes.envelope');
    await rawPut(factory, stored);
    const store = await opened(factory);
    abortNext('get');
    const result = await store.read();
    expect(result).toEqual({ ok: false, code: 'persistence.read-failed', path: '' });
    expect(result).not.toHaveProperty('envelope');
    expect(await rawGet(factory)).toBe(stored);
  });

  it('gives write-failed for an aborted write, keeps the previous value and resets the cache', async () => {
    const factory = new IDBFactory();
    const store = await opened(factory);
    const empty = await envelope('empty.envelope');
    await store.write(empty);
    abortNext('put');
    expect(await store.write(await envelope('shapes.envelope'))).toEqual({
      ok: false,
      code: 'persistence.write-failed',
      path: '',
    });
    expect(await rawGet(factory)).toBe(await text('empty.envelope'));
    // The failed write emptied the cache, so a write of the stored text still runs.
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
    expect(await store.write(empty)).toEqual({ ok: true, written: true });
    expect(transactions).toHaveBeenCalledTimes(1);
  });

  it('keeps the later of two writes', async () => {
    const factory = new IDBFactory();
    const store = await opened(factory);
    const empty = await envelope('empty.envelope');
    const shapes = await envelope('shapes.envelope');
    const results = await Promise.all([store.write(empty), store.write(shapes)]);
    expect(results).toEqual([
      { ok: true, written: true },
      { ok: true, written: true },
    ]);
    expect(await rawGet(factory)).toBe(await text('shapes.envelope'));
    // A write equal to the cached text is not skipped while an earlier write is pending.
    const again = await Promise.all([store.write(shapes), store.write(empty), store.write(shapes)]);
    expect(again).toEqual([
      { ok: true, written: false },
      { ok: true, written: true },
      { ok: true, written: true },
    ]);
    expect(await rawGet(factory)).toBe(await text('shapes.envelope'));
  });
});

describe('M5-A04 store follow-ups: throws, versionchange, clear and pending writes', () => {
  it('resolves write-failed when the envelope cannot be serialized, without a transaction', async () => {
    const factory = new IDBFactory();
    const store = await opened(factory);
    await store.write(await envelope('empty.envelope'));
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const broken = { document: null, lastOpenPageId: 'page-1' } as unknown as PersistenceEnvelope;
    expect(await store.write(broken)).toEqual({
      ok: false,
      code: 'persistence.write-failed',
      path: '',
    });
    expect(transactions).toHaveBeenCalledTimes(0);
    expect(await rawGet(factory)).toBe(await text('empty.envelope'));
    // The failed write emptied the cache.
    expect(await store.write(await envelope('empty.envelope'))).toEqual({
      ok: true,
      written: true,
    });
  });

  it('completes a write in flight at a versionchange, then is unavailable', async () => {
    const factory = new IDBFactory();
    const store = await opened(factory);
    const writing = store.write(await envelope('shapes.envelope'));
    const newer = await request(factory.open(DEFAULT_DATABASE_NAME, 2));
    expect(await writing).toEqual({ ok: true, written: true });
    expect(await store.read()).toEqual({
      ok: false,
      code: 'persistence.unavailable',
      path: '',
    });
    expect(
      await request(
        newer
          .transaction(OBJECT_STORE_NAME, 'readonly')
          .objectStore(OBJECT_STORE_NAME)
          .get(DEFAULT_KEY),
      ),
    ).toBe(await text('shapes.envelope'));
    newer.close();
  });

  it('does not skip a write equal to a completed write while a later clear is pending', async () => {
    const factory = new IDBFactory();
    const store = await opened(factory);
    const empty = await envelope('empty.envelope');
    const writing = store.write(empty);
    const clearing = store.clear();
    expect(await writing).toEqual({ ok: true, written: true });
    const again = store.write(empty);
    expect(await clearing).toEqual({ ok: true });
    expect(await again).toEqual({ ok: true, written: true });
    expect(await rawGet(factory)).toBe(await text('empty.envelope'));
  });

  it('gives write-failed for a failed clear and leaves the entry', async () => {
    const factory = new IDBFactory();
    const store = await opened(factory);
    const empty = await envelope('empty.envelope');
    await store.write(empty);
    abortNext('delete');
    expect(await store.clear()).toEqual({ ok: false, code: 'persistence.write-failed', path: '' });
    expect(await rawGet(factory)).toBe(await text('empty.envelope'));
    // A failed clear also empties the cache.
    expect(await store.write(empty)).toEqual({ ok: true, written: true });
  });

  it('leaves the cache to the pending write when a read finishes during it', async () => {
    const factory = new IDBFactory();
    await rawPut(factory, await text('empty.envelope'));
    const store = await opened(factory);
    const empty = await envelope('empty.envelope');
    const shapes = await envelope('shapes.envelope');
    // The read is created first, so it finishes while the write is still pending.
    const reading = store.read();
    const writing = store.write(shapes);
    expect(await reading).toEqual({ ok: true, envelope: empty });
    expect(await writing).toEqual({ ok: true, written: true });
    expect(await store.write(shapes)).toEqual({ ok: true, written: false });
    expect(await store.write(empty)).toEqual({ ok: true, written: true });
    expect(await rawGet(factory)).toBe(await text('empty.envelope'));
  });
});

describe('M5-A04 store corrupt entries', () => {
  const unchanged = async (value: unknown, code: string, at: string): Promise<void> => {
    const factory = new IDBFactory();
    await rawPut(factory, value);
    const store = await opened(factory);
    const result = await store.read();
    expect(failure(result)).toEqual({ ok: false, code, path: at });
    expect(result).not.toHaveProperty('envelope');
    // A failed read leaves the cache unset, so the entry is still unchanged and a later write
    // would run.
    expect(await rawGet(factory)).toEqual(value);
    expect(await store.read()).toEqual({ ok: false, code, path: at });
    expect(await rawGet(factory)).toEqual(value);
  };

  it.each([
    ['a number', 42],
    ['an object', { envelopeVersion: 1 }],
    ['a null', null],
  ])('gives envelope.malformed-json at the root for %s value', async (_label, value) => {
    await unchanged(value, 'envelope.malformed-json', '');
  });

  it.each([
    ['malformed-json', 'envelope.malformed-json', ''],
    ['not-object', 'envelope.invalid-field', ''],
    ['unsupported-version', 'envelope.unsupported-version', '/envelopeVersion'],
    ['duplicate-top-key', 'envelope.invalid-field', '/document'],
    ['duplicate-node-id', 'document.duplicate-id', '/document/nodes/r1'],
    ['unknown-key', 'envelope.invalid-field', '/viewport'],
    ['nul-page-id', 'envelope.invalid-field', '/lastOpenPageId'],
    ['document-unsupported-version', 'document.unsupported-version', '/document/schemaVersion'],
    ['document-invalid-field', 'document.invalid-field', '/document/nodes/r1/opacity'],
    ['document-cyclic-parent', 'document.cyclic-parent', '/document/nodes/f1/parent'],
    ['unknown-page', 'envelope.unknown-page', '/lastOpenPageId'],
  ])('gives the model code for the %s text and leaves the entry', async (name, code, at) => {
    await unchanged(await text(`malformed/${name}`), code, at);
  });

  it('does not cache a failed read: a write over a corrupt entry still runs', async () => {
    const factory = new IDBFactory();
    await rawPut(factory, await text('malformed/unknown-page'));
    const store = await opened(factory);
    await store.read();
    expect(await store.write(await envelope('empty.envelope'))).toEqual({
      ok: true,
      written: true,
    });
  });
});
