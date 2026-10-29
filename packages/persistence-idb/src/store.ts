import { parseEnvelope, serializeEnvelope, type PersistenceEnvelope } from '@vector-studio/model';
import type { PersistenceErrorCode, StoreFailure } from './codes.js';

// MVP M5 contract, section 4.2 (M5-Q10 (a)): one database at IndexedDB version 1, one object
// store `envelopes`, one record under the host's key holding the envelope text of
// `serializeEnvelope`, so a store entry and a saved file share one format and one parser.

export const DEFAULT_DATABASE_NAME = 'vector-studio';
export const DEFAULT_KEY = 'default';
export const OBJECT_STORE_NAME = 'envelopes';
/** The database layout version; not the envelope or document version. */
export const DATABASE_VERSION = 1;

export type DocumentStoreOptions = {
  indexedDB?: IDBFactory;
  databaseName?: string;
  key?: string;
};

export type ReadResult =
  Readonly<{ ok: true; envelope: PersistenceEnvelope | null }> | StoreFailure;
export type WriteResult = Readonly<{ ok: true; written: boolean }> | StoreFailure;
export type ClearResult = Readonly<{ ok: true }> | StoreFailure;

export interface DocumentStore {
  read(): Promise<ReadResult>;
  write(envelope: PersistenceEnvelope): Promise<WriteResult>;
  clear(): Promise<ClearResult>;
  close(): void;
}

export type OpenResult = Readonly<{ ok: true; store: DocumentStore }> | StoreFailure;

function fail(code: PersistenceErrorCode): StoreFailure {
  return { ok: false, code, path: '' };
}

/**
 * Opens the store. The injected factory is used when given; only when none is injected is
 * `globalThis.indexedDB` read, the package's only browser global. No factory, an `open` error
 * or a `blocked` open is `persistence.unavailable` at `''`.
 */
export function openDocumentStore(options: DocumentStoreOptions = {}): Promise<OpenResult> {
  const factory =
    options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory | undefined }).indexedDB;
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  const key = options.key ?? DEFAULT_KEY;
  if (factory === undefined || factory === null) {
    return Promise.resolve(fail('persistence.unavailable'));
  }
  return new Promise<OpenResult>((resolve) => {
    let settled = false;
    const settle = (result: OpenResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, DATABASE_VERSION);
    } catch {
      settle(fail('persistence.unavailable'));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        database.createObjectStore(OBJECT_STORE_NAME);
      }
    };
    request.onerror = (event) => {
      event.preventDefault();
      settle(fail('persistence.unavailable'));
    };
    request.onblocked = () => {
      settle(fail('persistence.unavailable'));
    };
    request.onsuccess = () => {
      const database = request.result;
      // A connection that still opens after `blocked` (or after any earlier failure) is closed
      // at once: the caller was already told the store is unavailable.
      if (settled) {
        database.close();
        return;
      }
      settle({ ok: true, store: createStore(database, key) });
    };
  });
}

function createStore(database: IDBDatabase, key: string): DocumentStore {
  let closed = false;
  // The last text known to be the entry's value; null means unknown, so the next write runs.
  let lastText: string | null = null;
  // Writes and clears created but not yet ended. The cache is consulted only when none is
  // pending, so a write is never skipped against a value a pending transaction may replace.
  let pending = 0;

  const close = (): void => {
    if (closed) return;
    closed = true;
    lastText = null;
    database.close();
  };
  // Another connection asks for a newer layout: give way and become unavailable.
  database.onversionchange = () => close();

  const transaction = (mode: IDBTransactionMode): IDBTransaction =>
    database.transaction(OBJECT_STORE_NAME, mode);

  return {
    read(): Promise<ReadResult> {
      if (closed) return Promise.resolve(fail('persistence.unavailable'));
      return new Promise<ReadResult>((resolve) => {
        let request: IDBRequest;
        let tx: IDBTransaction;
        try {
          tx = transaction('readonly');
          request = tx.objectStore(OBJECT_STORE_NAME).get(key);
        } catch {
          resolve(fail('persistence.read-failed'));
          return;
        }
        let settled = false;
        const failed = (): void => {
          if (settled) return;
          settled = true;
          resolve(fail('persistence.read-failed'));
        };
        tx.onerror = failed;
        tx.onabort = failed;
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          const value: unknown = request.result;
          if (value === undefined) {
            // No record: nothing is known to be stored.
            if (pending === 0) lastText = null;
            resolve({ ok: true, envelope: null });
            return;
          }
          if (typeof value !== 'string') {
            resolve({ ok: false, code: 'envelope.malformed-json', path: '' });
            return;
          }
          const parsed = parseEnvelope(value);
          if (!parsed.ok) {
            resolve({ ok: false, code: parsed.code, path: parsed.path });
            return;
          }
          if (pending === 0) lastText = value;
          resolve({ ok: true, envelope: parsed.envelope });
        };
      });
    },

    write(envelope: PersistenceEnvelope): Promise<WriteResult> {
      if (closed) return Promise.resolve(fail('persistence.unavailable'));
      const text = serializeEnvelope(envelope);
      if (pending === 0 && lastText !== null && text === lastText) {
        return Promise.resolve({ ok: true, written: false });
      }
      return new Promise<WriteResult>((resolve) => {
        let tx: IDBTransaction;
        try {
          tx = transaction('readwrite');
          tx.objectStore(OBJECT_STORE_NAME).put(text, key);
        } catch {
          lastText = null;
          resolve(fail('persistence.write-failed'));
          return;
        }
        pending += 1;
        let settled = false;
        const failed = (): void => {
          if (settled) return;
          settled = true;
          pending -= 1;
          lastText = null;
          resolve(fail('persistence.write-failed'));
        };
        tx.onerror = failed;
        tx.onabort = failed;
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          pending -= 1;
          // Read-write transactions on one store complete in creation order, so the last one
          // to complete leaves its text in the cache.
          if (!closed) lastText = text;
          resolve({ ok: true, written: true });
        };
      });
    },

    clear(): Promise<ClearResult> {
      if (closed) return Promise.resolve(fail('persistence.unavailable'));
      lastText = null;
      return new Promise<ClearResult>((resolve) => {
        let tx: IDBTransaction;
        try {
          tx = transaction('readwrite');
          tx.objectStore(OBJECT_STORE_NAME).delete(key);
        } catch {
          resolve(fail('persistence.write-failed'));
          return;
        }
        pending += 1;
        let settled = false;
        const end = (result: ClearResult): void => {
          if (settled) return;
          settled = true;
          pending -= 1;
          lastText = null;
          resolve(result);
        };
        tx.onerror = () => end(fail('persistence.write-failed'));
        tx.onabort = () => end(fail('persistence.write-failed'));
        tx.oncomplete = () => end({ ok: true });
      });
    },

    close,
  };
}
