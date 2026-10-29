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
  let dirty = false;
  // A `schedule()` arrived while a write was in flight: its timers start after that write.
  let scheduledDuringWrite = false;
  let trailing: { handle: unknown } | null = null;
  let maxWait: { handle: unknown } | null = null;
  // Resolves true when the write succeeded.
  let inFlight: Promise<boolean> | null = null;

  const clearTimers = (): void => {
    if (trailing !== null) timers.clear(trailing.handle);
    if (maxWait !== null) timers.clear(maxWait.handle);
    trailing = null;
    maxWait = null;
  };

  const startTimers = (): void => {
    if (trailing !== null) timers.clear(trailing.handle);
    trailing = { handle: timers.set(fire, delayMs) };
    // The maximum wait counts from the first unsaved `schedule()`.
    if (maxWait === null) maxWait = { handle: timers.set(fire, maxWaitMs) };
  };

  function fire(): void {
    clearTimers();
    if (disposed || inFlight !== null || !dirty) return;
    void startWrite();
  }

  function startWrite(): Promise<boolean> {
    clearTimers();
    dirty = false;
    // The envelope is read when the write starts, never when it was scheduled.
    const write = store.write(envelope());
    const running = write.then((result) => {
      if (!result.ok) dirty = true;
      onResult?.(result);
      return result.ok;
    });
    inFlight = running.finally(() => {
      inFlight = null;
      if (scheduledDuringWrite) {
        scheduledDuringWrite = false;
        if (!disposed) startTimers();
      }
    });
    return inFlight;
  }

  return {
    schedule(): void {
      if (disposed) return;
      dirty = true;
      if (inFlight !== null) {
        scheduledDuringWrite = true;
        return;
      }
      startTimers();
    },

    async flush(): Promise<void> {
      if (disposed) return;
      for (;;) {
        if (inFlight !== null) {
          if (!(await inFlight)) return;
          continue;
        }
        if (disposed || !dirty) return;
        scheduledDuringWrite = false;
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
