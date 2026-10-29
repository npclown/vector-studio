import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnvelope, serializeEnvelope, type PersistenceEnvelope } from '@vector-studio/model';
import {
  createAutosave,
  DEFAULT_DELAY_MS,
  DEFAULT_MAX_WAIT_MS,
  openDocumentStore,
  type DocumentStore,
  type WriteResult,
} from '@vector-studio/persistence-idb';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// MVP M5-U3 (M5 contract, section 4.3, M5-S1): the autosave scheduler under Vitest fake timers
// (M5-A05). Only setTimeout, clearTimeout and Date are faked, so fake-indexeddb's setImmediate
// scheduling still runs. Most cases use a store double whose writes resolve by hand, so the
// write in flight is under the test's control; the last case uses the real store on the fake.

const root = path.resolve(import.meta.dirname, '../..');
const m5 = path.join(root, 'tests/fixtures/m5-persistence');

async function envelope(name: string): Promise<PersistenceEnvelope> {
  const result = parseEnvelope(await readFile(path.join(m5, `${name}.envelope.json`), 'utf8'));
  if (!result.ok) throw new Error(`${result.code} at ${result.path}`);
  return result.envelope;
}

const WRITTEN: WriteResult = { ok: true, written: true };
const FAILED: WriteResult = { ok: false, code: 'persistence.write-failed', path: '' };

type Call = { at: number; envelope: PersistenceEnvelope; resolve: (result: WriteResult) => void };

/** A store double: each write waits until the test resolves it. */
function double(): { store: DocumentStore; calls: Call[]; maxInFlight: () => number } {
  const calls: Call[] = [];
  let inFlight = 0;
  let max = 0;
  const store: DocumentStore = {
    read: () => Promise.resolve({ ok: true, envelope: null }),
    write: (value) =>
      new Promise<WriteResult>((resolve) => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        calls.push({
          at: Date.now(),
          envelope: value,
          resolve: (result) => {
            inFlight -= 1;
            resolve(result);
          },
        });
      }),
    clear: () => Promise.resolve({ ok: true }),
    close: () => undefined,
  };
  return { store, calls, maxInFlight: () => max };
}

/** Lets resolved writes and their continuations run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

let empty: PersistenceEnvelope;
let shapes: PersistenceEnvelope;
let containers: PersistenceEnvelope;

beforeEach(async () => {
  empty = await envelope('empty');
  shapes = await envelope('shapes');
  containers = await envelope('containers');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('M5-A05 autosave debounce', () => {
  it('has the defaults 500 and 2000 ms', () => {
    expect([DEFAULT_DELAY_MS, DEFAULT_MAX_WAIT_MS]).toEqual([500, 2000]);
  });

  it('writes once, delayMs after the last schedule', async () => {
    const { store, calls } = double();
    const autosave = createAutosave({ store, envelope: () => empty });
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(300);
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(499);
    expect(calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((call) => call.at)).toEqual([800]);
    calls[0]!.resolve(WRITTEN);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(1);
  });

  it('writes maxWaitMs after the first unsaved schedule under a schedule every 100 ms', async () => {
    const { store, calls } = double();
    const autosave = createAutosave({ store, envelope: () => empty });
    for (let step = 0; step < 20; step += 1) {
      autosave.schedule();
      await vi.advanceTimersByTimeAsync(step < 19 ? 100 : 99);
    }
    expect([Date.now(), calls.length]).toEqual([1999, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((call) => call.at)).toEqual([2000]);
  });

  it('uses injected timers with delayMs and maxWaitMs', () => {
    const set = vi.fn<(fn: () => void, ms: number) => unknown>(() => Symbol('timer'));
    const clear = vi.fn();
    const { store } = double();
    const autosave = createAutosave({
      store,
      envelope: () => empty,
      delayMs: 50,
      maxWaitMs: 400,
      timers: { set, clear },
    });
    autosave.schedule();
    autosave.schedule();
    expect(set.mock.calls.map(([, ms]) => ms)).toEqual([400, 50, 50]);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(set.mock.results[1]!.value);
  });

  it('reads envelope() when the write starts, not when scheduled', async () => {
    const { store, calls } = double();
    let current = empty;
    const read = vi.fn(() => current);
    const autosave = createAutosave({ store, envelope: read });
    autosave.schedule();
    current = shapes;
    await vi.advanceTimersByTimeAsync(499);
    expect(read).toHaveBeenCalledTimes(0);
    current = containers;
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(calls[0]!.envelope).toBe(containers);
  });
});

describe('M5-A05 autosave write in flight', () => {
  it('keeps one write in flight and starts a new timer after it for a schedule during it', async () => {
    const { store, calls, maxInFlight } = double();
    let current = empty;
    const autosave = createAutosave({ store, envelope: () => current });
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.length).toBe(1);
    current = shapes;
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.length).toBe(1);
    calls[0]!.resolve(WRITTEN);
    await settle();
    expect(Date.now()).toBe(1500);
    await vi.advanceTimersByTimeAsync(499);
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((call) => [call.at, call.envelope])).toEqual([
      [500, empty],
      [2000, shapes],
    ]);
    expect(maxInFlight()).toBe(1);
  });

  it('keeps the maximum wait anchored to the first unsaved schedule across a write', async () => {
    const { store, calls } = double();
    const autosave = createAutosave({ store, envelope: () => empty });
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    // The write started at 500 is in flight; the first unsaved schedule is at 600.
    await vi.advanceTimersByTimeAsync(100);
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(1800);
    calls[0]!.resolve(WRITTEN);
    await settle();
    expect(Date.now()).toBe(2400);
    // Under a schedule every 100 ms the next write starts at 600 + 2000, not 2400 + 2000.
    while (calls.length < 2 && Date.now() < 6000) {
      autosave.schedule();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(calls.map((call) => call.at)).toEqual([500, 2600]);
  });

  it('starts the next write as soon as the write in flight ends once the maximum wait ran out', async () => {
    const { store, calls } = double();
    const autosave = createAutosave({ store, envelope: () => empty });
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(100);
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(2400);
    expect(calls.length).toBe(1);
    calls[0]!.resolve(WRITTEN);
    await settle();
    expect(calls.map((call) => call.at)).toEqual([500, 3000]);
    calls[1]!.resolve(WRITTEN);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(2);
  });

  it('flush writes now and clears the timers', async () => {
    const { store, calls } = double();
    const autosave = createAutosave({ store, envelope: () => empty });
    autosave.schedule();
    const flushed = autosave.flush();
    expect(calls.map((call) => call.at)).toEqual([0]);
    calls[0]!.resolve(WRITTEN);
    await flushed;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(1);
  });

  it('flush waits for the write in flight, then writes while dirty, never two at once', async () => {
    const { store, calls, maxInFlight } = double();
    let current = empty;
    const autosave = createAutosave({ store, envelope: () => current });
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    current = shapes;
    autosave.schedule();
    let done = false;
    const flushed = autosave.flush().then(() => {
      done = true;
    });
    await settle();
    expect([calls.length, done]).toEqual([1, false]);
    calls[0]!.resolve(WRITTEN);
    await settle();
    expect([calls.length, done]).toEqual([2, false]);
    expect(calls[1]!.envelope).toBe(shapes);
    current = containers;
    autosave.schedule();
    calls[1]!.resolve(WRITTEN);
    await settle();
    expect([calls.length, done]).toEqual([3, false]);
    expect(calls[2]!.envelope).toBe(containers);
    calls[2]!.resolve(WRITTEN);
    await flushed;
    expect([calls.length, done, maxInFlight()]).toEqual([3, true, 1]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(3);
  });

  it('flush on a clean scheduler writes nothing', async () => {
    const { store, calls } = double();
    const autosave = createAutosave({ store, envelope: () => empty });
    await autosave.flush();
    expect(calls.length).toBe(0);
  });
});

describe('M5-A05 autosave failure, dispose and onResult', () => {
  it('keeps the store dirty after a failed write and retries on the next schedule or flush', async () => {
    const { store, calls } = double();
    const results: WriteResult[] = [];
    const autosave = createAutosave({
      store,
      envelope: () => empty,
      onResult: (result) => results.push(result),
    });
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    calls[0]!.resolve(FAILED);
    await settle();
    // No retry of its own.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls.length).toBe(1);
    // flush retries; a failed write ends the flush loop.
    const flushed = autosave.flush();
    expect(calls.length).toBe(2);
    calls[1]!.resolve(FAILED);
    await flushed;
    expect(calls.length).toBe(2);
    // schedule retries after the debounce.
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.length).toBe(3);
    calls[2]!.resolve(WRITTEN);
    await settle();
    await autosave.flush();
    expect(calls.length).toBe(3);
    expect(results).toEqual([FAILED, FAILED, WRITTEN]);
  });

  it('flush ends when the write in flight fails', async () => {
    const { store, calls } = double();
    const autosave = createAutosave({ store, envelope: () => empty });
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    const flushed = autosave.flush();
    calls[0]!.resolve(FAILED);
    await flushed;
    expect(calls.length).toBe(1);
  });

  it('passes every result to onResult, including an unchanged write', async () => {
    const { store, calls } = double();
    const results: WriteResult[] = [];
    const autosave = createAutosave({
      store,
      envelope: () => empty,
      onResult: (result) => results.push(result),
    });
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    calls[0]!.resolve(WRITTEN);
    await settle();
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    calls[1]!.resolve({ ok: true, written: false });
    await settle();
    expect(results).toEqual([WRITTEN, { ok: true, written: false }]);
  });

  it('keeps the change unsaved when envelope() throws, and a later flush writes it', async () => {
    const { store, calls } = double();
    const results: WriteResult[] = [];
    let throwing = true;
    const autosave = createAutosave({
      store,
      envelope: () => {
        if (throwing) {
          throwing = false;
          throw new Error('envelope unavailable');
        }
        return shapes;
      },
      onResult: (result) => results.push(result),
    });
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    expect([calls.length, results]).toEqual([0, [FAILED]]);
    const flushed = autosave.flush();
    expect(calls.length).toBe(1);
    expect(calls[0]!.envelope).toBe(shapes);
    calls[0]!.resolve(WRITTEN);
    await flushed;
    expect(results).toEqual([FAILED, WRITTEN]);
  });

  it('reports a rejected store write and a throwing onResult without an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      let rejecting = true;
      const writes: PersistenceEnvelope[] = [];
      const store: DocumentStore = {
        ...double().store,
        write: (value) => {
          writes.push(value);
          if (rejecting) {
            rejecting = false;
            return Promise.reject(new Error('store broke'));
          }
          return Promise.resolve(WRITTEN);
        },
      };
      const results: WriteResult[] = [];
      const autosave = createAutosave({
        store,
        envelope: () => empty,
        onResult: (result) => {
          results.push(result);
          throw new Error('listener broke');
        },
      });
      autosave.schedule();
      await vi.advanceTimersByTimeAsync(500);
      expect(results).toEqual([FAILED]);
      await autosave.flush();
      expect([writes.length, results]).toEqual([2, [FAILED, WRITTEN]]);
      await autosave.flush();
      expect(writes.length).toBe(2);
      // Let any stray rejection reach the process.
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('dispose clears the timers and ignores later calls', async () => {
    const { store, calls } = double();
    const read = vi.fn(() => empty);
    const autosave = createAutosave({ store, envelope: read });
    autosave.schedule();
    autosave.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    autosave.schedule();
    await autosave.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect([calls.length, read.mock.calls.length]).toEqual([0, 0]);
  });

  it('dispose does not cancel a write in flight, and starts no timer after it', async () => {
    const { store, calls } = double();
    const results: WriteResult[] = [];
    const autosave = createAutosave({
      store,
      envelope: () => empty,
      onResult: (result) => results.push(result),
    });
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(500);
    autosave.schedule();
    autosave.dispose();
    calls[0]!.resolve(WRITTEN);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect([calls.length, results]).toEqual([1, [WRITTEN]]);
  });
});

describe('M5-A05 autosave on the fake IndexedDB store', () => {
  it('writes the envelope read at write start after the debounce, then skips an unchanged one', async () => {
    const factory = new IDBFactory();
    const opened = await openDocumentStore({ indexedDB: factory });
    if (!opened.ok) throw new Error(opened.code);
    const results: WriteResult[] = [];
    let current = empty;
    const autosave = createAutosave({
      store: opened.store,
      envelope: () => current,
      onResult: (result) => results.push(result),
    });
    autosave.schedule();
    current = shapes;
    await vi.advanceTimersByTimeAsync(500);
    await autosave.flush();
    expect(results).toEqual([WRITTEN]);
    expect(await opened.store.read()).toEqual({ ok: true, envelope: shapes });
    autosave.schedule();
    await autosave.flush();
    expect(results).toEqual([WRITTEN, { ok: true, written: false }]);
    current = containers;
    autosave.schedule();
    await vi.advanceTimersByTimeAsync(499);
    expect(results.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await autosave.flush();
    expect(results).toEqual([WRITTEN, { ok: true, written: false }, WRITTEN]);
    const read = await opened.store.read();
    expect(read.ok && read.envelope !== null && serializeEnvelope(read.envelope)).toBe(
      serializeEnvelope(containers),
    );
    autosave.dispose();
    opened.store.close();
  });
});
