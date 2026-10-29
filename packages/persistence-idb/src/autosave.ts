import type { PersistenceEnvelope } from '@vector-studio/model';
import type { DocumentStore, WriteResult } from './store.js';

// MVP M5 contract, section 4.3 (M5-S1, M5-Q6 (a)): a trailing debounce with a maximum wait, at
// most one write in flight. The host decides what calls `schedule()` (M5-S2, M5-Q8 (a)); this
// package never imports `editor-core`.

export const DEFAULT_DELAY_MS = 500;
export const DEFAULT_MAX_WAIT_MS = 2000;

export type AutosaveTimers = {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type AutosaveOptions = {
  store: DocumentStore;
  envelope: () => PersistenceEnvelope;
  delayMs?: number;
  maxWaitMs?: number;
  timers?: AutosaveTimers;
  onResult?: (result: WriteResult) => void;
};

export type Autosave = Readonly<{
  schedule(): void;
  flush(): Promise<void>;
  dispose(): void;
}>;

// Read the globals at call time, so timers faked after creation are still used.
const globalTimers: AutosaveTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createAutosave(options: AutosaveOptions): Autosave {
  const { store, envelope, onResult } = options;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const timers = options.timers ?? globalTimers;

  let disposed = false;
  // Each `schedule()` is one change; the store is dirty while a change is not yet saved. A
  // change is saved only when a write that started after it succeeds.
  let changes = 0;
  let saved = 0;
  const isDirty = (): boolean => changes !== saved;
  // A `schedule()` arrived while a write was in flight: its trailing timer starts after that
  // write, while its maximum wait already runs from that first unsaved `schedule()`.
  let scheduledDuringWrite = false;
  // The maximum wait ran out during a write: the next write starts as soon as that one ends.
  let dueAfterWrite = false;
  let trailing: { handle: unknown } | null = null;
  let maxWait: { handle: unknown } | null = null;
  // Resolves true when the write succeeded; it never rejects.
  let inFlight: Promise<boolean> | null = null;

  const clearTimers = (): void => {
    if (trailing !== null) timers.clear(trailing.handle);
    if (maxWait !== null) timers.clear(maxWait.handle);
    trailing = null;
    maxWait = null;
  };

  const startTrailing = (): void => {
    if (trailing !== null) timers.clear(trailing.handle);
    trailing = { handle: timers.set(fire, delayMs) };
  };

  // The maximum wait counts from the first unsaved `schedule()`, so it starts only then.
  const startMaxWait = (): void => {
    if (maxWait === null) maxWait = { handle: timers.set(fire, maxWaitMs) };
  };

  function fire(): void {
    if (disposed) return;
    if (inFlight !== null) {
      // Only the maximum wait runs during a write.
      if (maxWait !== null) timers.clear(maxWait.handle);
      maxWait = null;
      dueAfterWrite = true;
      return;
    }
    clearTimers();
    if (isDirty()) void startWrite();
  }

  const FAILED: WriteResult = { ok: false, code: 'persistence.write-failed', path: '' };

  async function attempt(upTo: number): Promise<boolean> {
    let result: WriteResult;
    try {
      // The envelope is read when the write starts, never when it was scheduled.
      result = await store.write(envelope());
    } catch {
      result = FAILED;
    }
    if (result.ok) saved = upTo;
    try {
      onResult?.(result);
    } catch {
      // A throwing listener does not change the result or the scheduler.
    }
    return result.ok;
  }

  function afterWrite(): void {
    inFlight = null;
    const due = dueAfterWrite;
    const pending = scheduledDuringWrite;
    dueAfterWrite = false;
    scheduledDuringWrite = false;
    if (disposed || !isDirty()) {
      if (!isDirty()) clearTimers();
      return;
    }
    if (due) {
      void startWrite();
      return;
    }
    if (pending) startTrailing();
  }

  function startWrite(): Promise<boolean> {
    clearTimers();
    dueAfterWrite = false;
    scheduledDuringWrite = false;
    const running = attempt(changes).then((ok) => {
      afterWrite();
      return ok;
    });
    inFlight = running;
    return running;
  }

  return {
    schedule(): void {
      if (disposed) return;
      changes += 1;
      startMaxWait();
      if (inFlight !== null) {
        scheduledDuringWrite = true;
        return;
      }
      startTrailing();
    },

    async flush(): Promise<void> {
      if (disposed) return;
      for (;;) {
        if (inFlight !== null) {
          if (!(await inFlight)) return;
          continue;
        }
        if (disposed || !isDirty()) return;
        if (!(await startWrite())) return;
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimers();
    },
  };
}
