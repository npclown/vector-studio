import type { CommandResult, Editor, EditorEvent } from '@vector-studio/editor-core';
import {
  parseEnvelope,
  serializeEnvelope,
  type EnvelopeErrorCode,
  type ModelErrorCode,
  type PersistenceEnvelope,
} from '@vector-studio/model';
import {
  createAutosave,
  openDocumentStore,
  type Autosave,
  type AutosaveTimers,
  type DocumentStore,
  type PersistenceErrorCode,
  type WriteResult,
} from '@vector-studio/persistence-idb';

// M5-U4 (MVP M5 contract, sections 3, 4.3 and 5): the next-host persistence composition, kept
// free of React and the DOM so it is unit tested in Node with an injected IndexedDB factory.
// The adapter may not import `editor-core` (M5-Q8 (a)), so the event mapping, the envelope
// source and the restore live here; page.tsx only wires them to the page.

/** The page's database (section 5.3); the store's record key stays the adapter default. */
export const PERSIST_DATABASE_NAME = 'vector-studio-next-host';
/** The "Save file" download name (section 3). */
export const SAVE_FILE_NAME = 'document.vstudio.json';

type EditorFailureCode = Extract<CommandResult, { ok: false }>['code'];
export type PersistenceCode =
  PersistenceErrorCode | EnvelopeErrorCode | ModelErrorCode | EditorFailureCode;
export type RestoreResult =
  Readonly<{ ok: true }> | Readonly<{ ok: false; code: PersistenceCode; path: string }>;

/**
 * M5-S2 (M5-Q5 (a)): a committed document change (`command`, `gesture-commit`, `undo`, `redo`,
 * `load`) or an `activePage` change schedules a write; a gesture update or cancel, every other
 * session field and diagnostics schedule nothing.
 */
const COMMITTED_CAUSES: ReadonlySet<string> = new Set([
  'command',
  'gesture-commit',
  'undo',
  'redo',
  'load',
]);

export function schedulesWrite(event: EditorEvent): boolean {
  if (event.type === 'document') return COMMITTED_CAUSES.has(event.cause);
  if (event.type === 'session') return event.field === 'activePage';
  return false;
}

/**
 * The autosave and "Save file" source (M5-S2): the committed document, never a gesture update,
 * and the active page.
 */
export function persistenceEnvelope(editor: Editor): PersistenceEnvelope {
  return {
    document: editor.query({ type: 'committedDocument' }),
    lastOpenPageId: editor.getSnapshot().activePage,
  };
}

/** The "Save file" text: the envelope text of section 2, as stored. */
export function saveFileText(editor: Editor): string {
  return serializeEnvelope(persistenceEnvelope(editor));
}

/**
 * Steps 4 and 5 of section 5.2 on a parsed envelope: `loadDocument`, then `setActivePage`, then
 * `setSelection { ids: [] }` (section 5.1). A failed load changes nothing and raises no event.
 */
export function loadEnvelope(editor: Editor, envelope: PersistenceEnvelope): RestoreResult {
  const loaded = editor.execute({ type: 'loadDocument', document: envelope.document });
  // The editor's path points into the document; inside an envelope it gets the `/document`
  // prefix, as the parse codes of section 2.1 do.
  if (!loaded.ok) {
    return { ok: false, code: loaded.code, path: `/document${loaded.path ?? ''}` };
  }
  // Neither can fail after a successful parse and load (section 5.2, step 5); a failure is
  // still reported rather than ignored.
  for (const command of [
    { type: 'setActivePage', id: envelope.lastOpenPageId },
    { type: 'setSelection', ids: [] },
  ] as const) {
    const result = editor.execute(command);
    if (!result.ok) return { ok: false, code: result.code, path: result.path ?? '' };
  }
  return { ok: true };
}

/**
 * `restoreEnvelope(editor, text)` (section 5.2, steps 3 to 5), shared by "Open file" and, after
 * the store's own parse, the IndexedDB restore: `parseEnvelope`, then `loadEnvelope`. The first
 * failure is returned and nothing is loaded.
 */
export function restoreEnvelope(editor: Editor, text: string): RestoreResult {
  const parsed = parseEnvelope(text);
  if (!parsed.ok) return { ok: false, code: parsed.code, path: parsed.path };
  return loadEnvelope(editor, parsed.envelope);
}

/** Where a persistence failure happened; only a failed restore or discard offers "Discard". */
export type PersistStage = 'open' | 'restore' | 'write' | 'discard';
export type PersistStatus =
  | Readonly<{ state: 'restoring' | 'restored' | 'empty' }>
  | Readonly<{ state: 'saved'; count: number }>
  | Readonly<{ state: 'error'; stage: PersistStage; code: PersistenceCode; path: string }>;

/** The section 5.3 status text: `persist: restoring | restored | empty | saved <n> | error <code> <path>`. */
export function persistStatusLabel(status: PersistStatus): string {
  switch (status.state) {
    case 'saved':
      return `persist: saved ${status.count}`;
    case 'error':
      return `persist: error ${status.code} ${status.path}`.trimEnd();
    default:
      return `persist: ${status.state}`;
  }
}

/** "Discard stored document" is offered after a failed restore (M5-Q11 (a)) or a failed discard. */
export function offersDiscard(status: PersistStatus | null): boolean {
  return status?.state === 'error' && (status.stage === 'restore' || status.stage === 'discard');
}

/** Section 5.3 (M5-Q12 (a)): persistence only with `?persist=1`; it wins over `?fixture=`. */
export function persistQuery(
  search: string,
): Readonly<{ persist: boolean; fixtureIgnored: boolean }> {
  const params = new URLSearchParams(search);
  const persist = params.get('persist') === '1';
  return { persist, fixtureIgnored: persist && params.get('fixture') !== null };
}

export type PersistenceOptions = {
  /** The IndexedDB factory; tests inject a fake. Absent, the adapter reads `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
  databaseName?: string;
  key?: string;
  delayMs?: number;
  maxWaitMs?: number;
  timers?: AutosaveTimers;
  /** The revision when the page loaded; defaults to the revision at the call. */
  baseRevision?: number;
  onStatus?: (status: PersistStatus) => void;
  /** E26-U1b: the bench's write-start hook wraps the opened store (`?bench=1` only). */
  wrapStore?: (store: DocumentStore) => DocumentStore;
  /**
   * E26-U6a: whether a canvas press is in progress. While it reads true a due autosave write
   * waits (the autosave's `holdWhile`); the host calls `release()` when the press ends.
   */
  pressed?: () => boolean;
};

export type PersistenceSession = Readonly<{
  /** Resolves when the open and restore have finished or failed (and autosave is attached, if it is). */
  ready: Promise<void>;
  status(): PersistStatus;
  /** Whether autosave is attached (never after a failed restore until a discard). */
  attached(): boolean;
  flush(): Promise<void>;
  /** "Discard stored document": `clear`, then autosave attaches. Only after a failed restore. */
  discard(): Promise<void>;
  /** E26-U6a: the press ended; starts a write the press held, if any. No-op otherwise. */
  release(): void;
  /** Unsubscribes, disposes the autosave and closes the store; safe under a strict-mode remount. */
  dispose(): void;
}>;

/**
 * The `?persist=1` composition (section 5.3): open the store, restore (section 5.2), then create
 * the autosave and subscribe, in that order, so no autosave runs before the restore has finished
 * or failed. After a failed restore autosave stays off until "Discard stored document".
 */
export function attachPersistence(
  editor: Editor,
  options: PersistenceOptions = {},
): PersistenceSession {
  const baseRevision = options.baseRevision ?? editor.getSnapshot().revision;
  let disposed = false;
  let store: DocumentStore | null = null;
  let autosave: Autosave | null = null;
  let unsubscribe: (() => void) | null = null;
  let saved = 0;
  let discarding = false;
  let current: PersistStatus = { state: 'restoring' };

  const report = (status: PersistStatus): void => {
    if (disposed) return;
    current = status;
    options.onStatus?.(status);
  };
  const failed = (stage: PersistStage, result: { code: PersistenceCode; path: string }): void =>
    report({ state: 'error', stage, code: result.code, path: result.path });

  const onResult = (result: WriteResult): void => {
    if (result.ok) {
      saved += 1;
      report({ state: 'saved', count: saved });
    } else failed('write', result);
  };

  /** Creates the autosave and subscribes; with no record, saves edits made during the read. */
  const attach = (target: DocumentStore, empty: boolean): void => {
    const scheduler = createAutosave({
      store: target,
      envelope: () => persistenceEnvelope(editor),
      ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.pressed === undefined ? {} : { holdWhile: options.pressed }),
      onResult,
    });
    autosave = scheduler;
    unsubscribe = editor.subscribe((event) => {
      if (schedulesWrite(event)) scheduler.schedule();
    });
    if (empty && editor.getSnapshot().revision !== baseRevision) scheduler.schedule();
  };

  const start = async (): Promise<void> => {
    report({ state: 'restoring' });
    const opened = await openDocumentStore({
      ...(options.indexedDB === undefined ? {} : { indexedDB: options.indexedDB }),
      databaseName: options.databaseName ?? PERSIST_DATABASE_NAME,
      ...(options.key === undefined ? {} : { key: options.key }),
    });
    if (disposed) {
      if (opened.ok) opened.store.close();
      return;
    }
    if (!opened.ok) {
      failed('open', opened);
      return;
    }
    store = options.wrapStore === undefined ? opened.store : options.wrapStore(opened.store);
    const read = await store.read();
    if (disposed) return;
    if (!read.ok) {
      failed('restore', read);
      return;
    }
    if (read.envelope === null) {
      report({ state: 'empty' });
      attach(store, true);
      return;
    }
    const loaded = loadEnvelope(editor, read.envelope);
    if (!loaded.ok) {
      failed('restore', loaded);
      return;
    }
    report({ state: 'restored' });
    attach(store, false);
  };

  // A throw from the adapter or the editor ends the restore as a failure, never as an unhandled
  // rejection; autosave stays off as after any failed restore.
  const ready = start().catch(() => {
    failed('restore', { code: 'persistence.read-failed', path: '' });
  });

  return {
    ready,
    status: () => current,
    attached: () => autosave !== null,
    flush: () => (autosave === null || disposed ? Promise.resolve() : autosave.flush()),
    async discard(): Promise<void> {
      const target = store;
      if (disposed || discarding || target === null || autosave !== null) return;
      if (!offersDiscard(current)) return;
      discarding = true;
      let cleared: Awaited<ReturnType<DocumentStore['clear']>>;
      try {
        cleared = await target.clear();
      } catch {
        cleared = { ok: false, code: 'persistence.write-failed', path: '' };
      } finally {
        discarding = false;
      }
      if (disposed) return;
      if (!cleared.ok) {
        failed('discard', cleared);
        return;
      }
      report({ state: 'empty' });
      attach(target, true);
    },
    release(): void {
      if (!disposed) autosave?.release();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      autosave?.dispose();
      store?.close();
    },
  };
}

/** E26-U6a: the frame and task scheduling of the press release; tests inject their own. */
export type PressReleaseScheduler = Readonly<{
  requestFrame(callback: () => void): unknown;
  cancelFrame(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

const browserScheduler: PressReleaseScheduler = {
  requestFrame: (callback) => requestAnimationFrame(() => callback()),
  cancelFrame: (handle) => cancelAnimationFrame(handle as number),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type PressGate = Readonly<{
  /** `PersistenceOptions.pressed`: whether a canvas press is in progress. */
  pressed: () => boolean;
  /** `EditorCanvasProps.onPressChange`. */
  onPressChange: (pressed: boolean) => void;
  /** Cancels a pending release (the persistence effect's cleanup). */
  cancel: () => void;
}>;

/**
 * E26-U6a (E26 contract, section 5): the host side of the autosave hold. A press sets the flag;
 * its end clears the flag, then releases the session after the next animation frame and one
 * task, so the held write serializes the document in the frame after the commit, not in the
 * pointerup task before its paint. A press that starts within that deferral keeps the write
 * held (the release then does nothing, and the second press's end releases it). With no
 * session, nothing is scheduled. A frame never comes in a hidden tab; the host's
 * `visibilitychange` flush, which is not held, writes then.
 */
export function createPressGate(
  session: () => PersistenceSession | null,
  scheduler: PressReleaseScheduler = browserScheduler,
): PressGate {
  let pressed = false;
  let frame: { handle: unknown } | null = null;
  let task: { handle: unknown } | null = null;
  const cancel = (): void => {
    if (frame !== null) scheduler.cancelFrame(frame.handle);
    if (task !== null) scheduler.clearTimeout(task.handle);
    frame = null;
    task = null;
  };
  return {
    pressed: () => pressed,
    onPressChange: (next: boolean): void => {
      pressed = next;
      if (next || session() === null) return;
      // The flag clears before the release, so the autosave reads the press as over.
      cancel();
      frame = {
        handle: scheduler.requestFrame(() => {
          frame = null;
          task = {
            handle: scheduler.setTimeout(() => {
              task = null;
              session()?.release();
            }, 0),
          };
        }),
      };
    },
    cancel,
  };
}
