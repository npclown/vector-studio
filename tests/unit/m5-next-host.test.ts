import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  createCounterIdSource,
  createEditor,
  starExtension,
  type Command,
  type Editor,
  type EditorEvent,
  type ExtensionTool,
  type PagePoint,
} from '@vector-studio/editor-core';
import {
  parseEnvelope,
  serializeDocument,
  type DocumentV5,
  type PersistenceEnvelope,
} from '@vector-studio/model';
import { openDocumentStore } from '@vector-studio/persistence-idb';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

// MVP M5-U4 (M5 contract, sections 3, 4.3 and 5): the next-host persistence composition in Node
// with a real editor, the fake IndexedDB of M5-Q4 (a) through the injected factory, and a
// hand-driven clock injected as the autosave timers. M5-A06: which editor events lead to a write
// (M5-S2), and that a write never holds a gesture update. M5-A08: the restore of section 5.1 with
// literal session values; each failure of section 5.2 loads nothing, shows its code, leaves the
// entry byte for byte and attaches no autosave; "Discard stored document" clears and attaches.

const root = path.resolve(import.meta.dirname, '../..');
const m5 = path.join(root, 'tests/fixtures/m5-persistence');

type RestoreResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: string; path: string }>;
type PersistStatus =
  | Readonly<{ state: 'restoring' | 'restored' | 'empty' }>
  | Readonly<{ state: 'saved'; count: number }>
  | Readonly<{ state: 'error'; stage: string; code: string; path: string }>;
type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
type Session = Readonly<{
  ready: Promise<void>;
  status(): PersistStatus;
  attached(): boolean;
  flush(): Promise<void>;
  discard(): Promise<void>;
  dispose(): void;
}>;
const host = (await import(path.join(root, 'apps/next-host/src/m5-persistence.ts'))) as {
  PERSIST_DATABASE_NAME: string;
  SAVE_FILE_NAME: string;
  schedulesWrite: (event: EditorEvent) => boolean;
  persistenceEnvelope: (editor: Editor) => PersistenceEnvelope;
  saveFileText: (editor: Editor) => string;
  restoreEnvelope: (editor: Editor, text: string) => RestoreResult;
  persistStatusLabel: (status: PersistStatus) => string;
  offersDiscard: (status: PersistStatus | null) => boolean;
  persistQuery: (search: string) => Readonly<{ persist: boolean; fixtureIgnored: boolean }>;
  attachPersistence: (
    editor: Editor,
    options?: {
      indexedDB?: IDBFactory;
      databaseName?: string;
      timers?: Timers;
      baseRevision?: number;
      onStatus?: (status: PersistStatus) => void;
    },
  ) => Session;
};

const DB = 'vector-studio-next-host';
const STORE = 'envelopes';
const KEY = 'default';
const none = { shift: false, alt: false, meta: false, ctrl: false };
const read = (name: string): string => readFileSync(path.join(m5, name), 'utf8');

// ---------------------------------------------------------------------------------------------
// A clock driven by hand, injected as the autosave timers.

type Clock = Timers & { now: number; pending(): number; advance(ms: number): void };

function clock(): Clock {
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const value: Clock = {
    now: 0,
    set(fn, ms) {
      next += 1;
      due.set(next, { at: value.now + ms, fn });
      return next;
    },
    clear(handle) {
      due.delete(handle as number);
    },
    pending: () => due.size,
    advance(ms) {
      const end = value.now + ms;
      for (;;) {
        let first: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of due) if (first === null || entry[1].at < first[1].at) first = entry;
        if (first === null || first[1].at > end) break;
        due.delete(first[0]);
        value.now = first[1].at;
        first[1].fn();
      }
      value.now = end;
    },
  };
  return value;
}

/** Lets fake IndexedDB requests and their continuations run (it schedules by setImmediate). */
async function idle(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------------------------
// Raw access to the fake database, beside the adapter.

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(String(request.error)));
  });
}

async function rawOpen(factory: IDBFactory, withStore = true): Promise<IDBDatabase> {
  const request = factory.open(DB, 1);
  request.onupgradeneeded = () => {
    if (withStore) request.result.createObjectStore(STORE);
  };
  return done(request);
}

async function rawPut(factory: IDBFactory, value: unknown): Promise<void> {
  const database = await rawOpen(factory);
  const tx = database.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(value, KEY);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error(String(tx.error)));
  });
  database.close();
}

async function rawGet(factory: IDBFactory): Promise<unknown> {
  const database = await rawOpen(factory);
  const value: unknown = await done(
    database.transaction(STORE, 'readonly').objectStore(STORE).get(KEY),
  );
  database.close();
  return value;
}

// ---------------------------------------------------------------------------------------------
// Editors and the composition under test.

function ok(target: Editor, command: Command): readonly string[] {
  const result = target.execute(command);
  if (!result.ok) throw new Error(`${command.type}: ${result.code} ${result.path ?? ''}`);
  return result.ids;
}

function pointer(
  target: Editor,
  kind: 'pointerdown' | 'pointermove' | 'pointerup',
  point: PagePoint,
): void {
  ok(target, { type: 'input', event: { kind, point, modifiers: none } });
}

/**
 * `ext.slide` (as in the M5-U2 tests): a press begins a gesture, a move `replace`s with a nudge
 * of `id` by the offset from the press (zero offset: back to the base), a release commits.
 */
function slideTool(id: () => string): ExtensionTool {
  let start: PagePoint | null = null;
  return {
    id: 'ext.slide',
    input(event, api) {
      if (event.kind === 'pointerdown') {
        if (!api.gesture.begin()) return false;
        start = event.point;
        return true;
      }
      if (start === null) return false;
      if (event.kind === 'pointermove') {
        const dx = event.point.x - start.x;
        const dy = event.point.y - start.y;
        api.gesture.replace(
          dx === 0 && dy === 0 ? [] : [{ type: 'nudgeNodes', ids: [id()], dx, dy }],
        );
        return true;
      }
      if (event.kind === 'pointerup') {
        api.gesture.commit();
        start = null;
        return true;
      }
      return false;
    },
    reset() {
      start = null;
    },
  };
}

function newEditor(extensions = true): Editor {
  const target = createEditor({
    ids: createCounterIdSource('n'),
    extensions: extensions
      ? [starExtension, { id: 'ext.slide', tools: [slideTool(() => slideTarget)] }]
      : [],
  });
  ok(target, { type: 'setSnapping', enabled: false });
  return target;
}

/** The node `ext.slide` nudges. */
let slideTarget = '';

type Harness = {
  factory: IDBFactory;
  editor: Editor;
  time: Clock;
  session: Session;
  statuses: PersistStatus[];
  events: EditorEvent[];
  /** Successful write results so far (`saved <n>`). */
  saved(): number;
};

async function harness(
  options: { factory?: IDBFactory; editor?: Editor; wait?: boolean } = {},
): Promise<Harness> {
  const factory = options.factory ?? new IDBFactory();
  const editor = options.editor ?? newEditor();
  const time = clock();
  const statuses: PersistStatus[] = [];
  const events: EditorEvent[] = [];
  editor.subscribe((event) => events.push(event));
  const session = host.attachPersistence(editor, {
    indexedDB: factory,
    timers: time,
    onStatus: (status) => statuses.push(status),
  });
  if (options.wait !== false) await session.ready;
  const saved = () => {
    let count = 0;
    for (const status of statuses) if (status.state === 'saved') count = status.count;
    return count;
  };
  return { factory, editor, time, session, statuses, events, saved };
}

/** Advances past the 500 ms debounce, lets the write finish, and returns the writes it made. */
async function settle(h: Harness): Promise<number> {
  const before = h.saved();
  h.time.advance(499);
  await idle(10);
  expect(h.saved()).toBe(before);
  h.time.advance(1);
  await idle();
  return h.saved() - before;
}

async function expectStored(h: Harness): Promise<void> {
  expect(await rawGet(h.factory)).toBe(host.saveFileText(h.editor));
}

/** Nothing scheduled, and no write after the longest wait. */
async function expectNoWrite(h: Harness): Promise<void> {
  const before = h.saved();
  expect(h.time.pending()).toBe(0);
  h.time.advance(5000);
  await idle();
  expect(h.saved()).toBe(before);
}

function rect(h: Harness, x = 0): string {
  return ok(h.editor, { type: 'createRectangle', frame: { x, y: 0, width: 100, height: 100 } })[0]!;
}

function committed(target: Editor): DocumentV5 {
  return target.query({ type: 'committedDocument' });
}

// ---------------------------------------------------------------------------------------------

describe('M5-A06 host wiring: committed transactions schedule writes', () => {
  it('maps document causes and session fields as M5-S2', () => {
    const causes = [
      ['command', true],
      ['gesture-update', false],
      ['gesture-commit', true],
      ['gesture-cancel', false],
      ['undo', true],
      ['redo', true],
      ['load', true],
    ] as const;
    for (const [cause, expected] of causes) {
      const event: EditorEvent = { type: 'document', cause, revision: 1, touched: [] };
      expect(host.schedulesWrite(event), cause).toBe(expected);
    }
    const fields = [
      'selection',
      'tool',
      'viewport',
      'overlay',
      'activePage',
      'viewportSize',
      'keymap',
      'snap',
      'snapping',
      'scope',
      'pathEdit',
    ] as const;
    for (const field of fields) {
      expect(host.schedulesWrite({ type: 'session', field }), field).toBe(field === 'activePage');
    }
    expect(
      host.schedulesWrite({
        type: 'diagnostic',
        code: 'editor.scene-rejected',
      } as unknown as EditorEvent),
    ).toBe(false);
  });

  it('writes the committed document and active page once after the debounce for each change', async () => {
    const h = await harness();
    expect(h.statuses).toEqual([{ state: 'restoring' }, { state: 'empty' }]);
    expect(h.session.attached()).toBe(true);
    // Nothing moved during the read: the attach schedules nothing.
    await expectNoWrite(h);
    expect(await rawGet(h.factory)).toBeUndefined();

    let page = '';
    const steps: readonly [string, () => void][] = [
      ['command', () => rect(h)],
      ['undo', () => ok(h.editor, { type: 'undo' })],
      ['redo', () => ok(h.editor, { type: 'redo' })],
      [
        'gesture commit',
        () => {
          ok(h.editor, { type: 'setTool', tool: 'rectangle' });
          pointer(h.editor, 'pointerdown', { x: 200, y: 200 });
          pointer(h.editor, 'pointermove', { x: 260, y: 240 });
          pointer(h.editor, 'pointerup', { x: 260, y: 240 });
          ok(h.editor, { type: 'setTool', tool: 'select' });
        },
      ],
      [
        'loadDocument',
        () => {
          const parsed = parseEnvelope(read('shapes.envelope.json'));
          if (!parsed.ok) throw new Error(parsed.code);
          ok(h.editor, { type: 'loadDocument', document: parsed.envelope.document });
        },
      ],
      ['addPage', () => (page = ok(h.editor, { type: 'addPage', name: 'Page 2' })[0]!)],
      ['page switch', () => ok(h.editor, { type: 'setActivePage', id: page })],
    ];
    let count = 0;
    for (const [name, run] of steps) {
      run();
      expect(await settle(h), name).toBe(1);
      count += 1;
      expect(h.saved()).toBe(count);
      await expectStored(h);
    }
    const stored = parseEnvelope((await rawGet(h.factory)) as string);
    expect(h.editor.getSnapshot().activePage).toBe(page);
    expect(stored.ok && stored.envelope.lastOpenPageId).toBe(page);
    expect(stored.ok && stored.envelope.document.pages.map((page) => page.name)).toEqual([
      'Page 1',
      'Page 2',
    ]);
    // The status counts the writes.
    expect(h.statuses.at(-1)).toEqual({ state: 'saved', count: 7 });
    expect(host.persistStatusLabel(h.statuses.at(-1)!)).toBe('persist: saved 7');
    h.session.dispose();
  });

  it('a drag of many moves writes nothing until its commit; a forced write holds the pre-gesture document', async () => {
    const h = await harness();
    const id = rect(h);
    expect(await settle(h)).toBe(1);
    const before = serializeDocument(committed(h.editor));

    pointer(h.editor, 'pointerdown', { x: 50, y: 50 });
    for (let i = 1; i <= 40; i += 1) pointer(h.editor, 'pointermove', { x: 50 + i, y: 50 + i });
    expect(
      h.events.filter((e) => e.type === 'document' && e.cause === 'gesture-update').length,
    ).toBe(40);
    expect(h.editor.getSnapshot().document.nodes[id]!.frame.x).toBe(40);
    await expectNoWrite(h);

    // A change scheduled before a drag, then flushed mid-drag, writes the committed document.
    pointer(h.editor, 'pointerup', { x: 90, y: 90 });
    expect(await settle(h)).toBe(1);
    const moved = serializeDocument(committed(h.editor));
    ok(h.editor, { type: 'setSelection', ids: [] });
    const second = rect(h, 400);
    const scheduled = serializeDocument(committed(h.editor));
    pointer(h.editor, 'pointerdown', { x: 450, y: 50 });
    for (let i = 1; i <= 20; i += 1) pointer(h.editor, 'pointermove', { x: 450 + i, y: 50 });
    expect(h.editor.getSnapshot().document.nodes[second]!.frame.x).toBe(420);
    await h.session.flush();
    const stored = parseEnvelope((await rawGet(h.factory)) as string);
    expect(stored.ok && serializeDocument(stored.envelope.document)).toBe(scheduled);
    expect(stored.ok && stored.envelope.document.nodes[second]!.frame.x).toBe(400);
    expect(scheduled).not.toBe(moved);
    expect(before).not.toBe(moved);
    // The commit then writes once more, with the drag.
    pointer(h.editor, 'pointerup', { x: 470, y: 50 });
    expect(await settle(h)).toBe(1);
    const last = parseEnvelope((await rawGet(h.factory)) as string);
    expect(last.ok && last.envelope.document.nodes[second]!.frame.x).toBe(420);
    h.session.dispose();
  });

  it('a cancelled drag and a drag replaced back to its base write nothing new', async () => {
    const h = await harness();
    const id = rect(h);
    expect(await settle(h)).toBe(1);
    const stored = await rawGet(h.factory);

    pointer(h.editor, 'pointerdown', { x: 50, y: 50 });
    pointer(h.editor, 'pointermove', { x: 80, y: 80 });
    ok(h.editor, { type: 'input', event: { kind: 'keydown', key: 'Escape', modifiers: none } });
    pointer(h.editor, 'pointerup', { x: 80, y: 80 });
    expect(h.events.some((e) => e.type === 'document' && e.cause === 'gesture-cancel')).toBe(true);
    expect(h.editor.getSnapshot().document.nodes[id]!.frame.x).toBe(0);
    await expectNoWrite(h);

    slideTarget = id;
    ok(h.editor, { type: 'setTool', tool: 'ext.slide' });
    const count = h.events.length;
    pointer(h.editor, 'pointerdown', { x: 10, y: 10 });
    pointer(h.editor, 'pointermove', { x: 30, y: 10 });
    pointer(h.editor, 'pointermove', { x: 10, y: 10 });
    pointer(h.editor, 'pointerup', { x: 10, y: 10 });
    // Replaced back to its base: two gesture updates and no commit event.
    expect(
      h.events
        .slice(count)
        .filter((e) => e.type === 'document')
        .map((e) => e.type === 'document' && e.cause),
    ).toEqual(['gesture-update', 'gesture-update']);
    await expectNoWrite(h);
    expect(await rawGet(h.factory)).toBe(stored);
    expect(h.saved()).toBe(1);
    h.session.dispose();
  });

  it('selection, tool, viewport, snapping, scope and path edit changes write nothing', async () => {
    const h = await harness();
    const frame = ok(h.editor, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 300, height: 300 },
    })[0]!;
    const shape = ok(h.editor, {
      type: 'createPath',
      verbs: ['move', 'line', 'line'],
      points: [400, 0, 500, 0, 500, 100],
    })[0]!;
    expect(await settle(h)).toBe(1);
    const stored = await rawGet(h.factory);
    const fields: string[] = [];
    h.editor.subscribe((event) => {
      if (event.type === 'session') fields.push(event.field);
    });
    ok(h.editor, { type: 'setSelection', ids: [shape] });
    ok(h.editor, { type: 'setTool', tool: 'ellipse' });
    ok(h.editor, { type: 'setTool', tool: 'select' });
    ok(h.editor, { type: 'setViewport', camera: { position: { x: 5, y: 7 }, zoom: 2 } });
    ok(h.editor, { type: 'setSnapping', enabled: true });
    ok(h.editor, { type: 'setScope', id: frame });
    ok(h.editor, { type: 'setScope', id: null });
    ok(h.editor, { type: 'enterPathEdit', id: shape });
    ok(h.editor, { type: 'exitPathEdit' });
    expect(new Set(fields)).toEqual(
      new Set(['selection', 'tool', 'viewport', 'snapping', 'scope', 'pathEdit']),
    );
    await expectNoWrite(h);
    expect(await rawGet(h.factory)).toBe(stored);
    h.session.dispose();
  });

  it('the save file text is the envelope that parses back; open restores it', () => {
    const editor = newEditor();
    ok(editor, { type: 'createRectangle', frame: { x: 1, y: 2, width: 3, height: 4 } });
    const page = ok(editor, { type: 'addPage', name: 'Two' })[0]!;
    ok(editor, { type: 'setActivePage', id: page });
    const text = host.saveFileText(editor);
    expect(host.SAVE_FILE_NAME).toBe('document.vstudio.json');
    const parsed = parseEnvelope(text);
    expect(parsed.ok && parsed.envelope).toEqual(host.persistenceEnvelope(editor));
    const other = newEditor();
    expect(host.restoreEnvelope(other, text)).toEqual({ ok: true });
    expect(host.saveFileText(other)).toBe(text);
    expect(other.getSnapshot().activePage).toBe(page);
  });
});

// ---------------------------------------------------------------------------------------------

/** An envelope with two pages, page 2 active, and a rectangle on each. */
function twoPageEnvelope(): PersistenceEnvelope {
  const source = newEditor();
  ok(source, { type: 'createRectangle', frame: { x: 0, y: 0, width: 10, height: 10 } });
  const page = ok(source, { type: 'addPage', name: 'Page 2' })[0]!;
  ok(source, { type: 'setActivePage', id: page });
  ok(source, { type: 'createEllipse', frame: { x: 20, y: 20, width: 30, height: 30 } });
  return host.persistenceEnvelope(source);
}

async function store(factory: IDBFactory, envelope: PersistenceEnvelope): Promise<string> {
  const opened = await openDocumentStore({ indexedDB: factory, databaseName: DB });
  if (!opened.ok) throw new Error(opened.code);
  const written = await opened.store.write(envelope);
  if (!written.ok) throw new Error(written.code);
  opened.store.close();
  return (await rawGet(factory)) as string;
}

/** An editor with a moved session: a selection, a tool, a camera and snapping off. */
function busyEditor(extensions = true): Editor {
  const target = newEditor(extensions);
  const id = ok(target, {
    type: 'createRectangle',
    frame: { x: 0, y: 0, width: 50, height: 50 },
  })[0]!;
  ok(target, { type: 'setSelection', ids: [id] });
  ok(target, { type: 'setTool', tool: 'ellipse' });
  ok(target, { type: 'setViewport', camera: { position: { x: 10, y: 20 }, zoom: 2 } });
  return target;
}

/** 33 nested frames: the model accepts them, the editor's clip depth does not. */
function clipDepthEnvelope(): string {
  const source = newEditor();
  let parent: string | undefined;
  for (let level = 0; level < 32; level += 1) {
    [parent] = ok(source, {
      type: 'createFrame',
      frame: { x: 0, y: 0, width: 10, height: 10 },
      ...(parent === undefined ? {} : { parent }),
    });
  }
  const envelope = host.persistenceEnvelope(source);
  const document = structuredClone(envelope.document) as unknown as {
    nodes: Record<string, { id: string; parent: string; children: string[] }>;
  };
  const inner = document.nodes[parent!]!;
  document.nodes.deep = { ...structuredClone(inner), id: 'deep', parent: parent!, children: [] };
  inner.children = ['deep'];
  return JSON.stringify({ envelopeVersion: 1, lastOpenPageId: envelope.lastOpenPageId, document });
}

function starEnvelope(points: number): string {
  const value = JSON.parse(read('ext-star.envelope.json')) as {
    document: { nodes: { n2: { data: { points: number } } } };
  };
  value.document.nodes.n2.data.points = points;
  return JSON.stringify(value);
}

describe('M5-A08 restore: content and last open page', () => {
  it('restores the document and page with an empty selection and history; the rest of the session is kept', async () => {
    const factory = new IDBFactory();
    const envelope = twoPageEnvelope();
    const text = await store(factory, envelope);
    const editor = busyEditor();
    const h = await harness({ factory, editor });
    expect(h.statuses).toEqual([{ state: 'restoring' }, { state: 'restored' }]);
    expect(host.persistStatusLabel({ state: 'restored' })).toBe('persist: restored');
    const snapshot = editor.getSnapshot();
    expect(serializeDocument(snapshot.document)).toBe(serializeDocument(envelope.document));
    expect(snapshot.activePage).toBe(envelope.lastOpenPageId);
    expect(snapshot.activePage).toBe(envelope.document.pages[1]!.id);
    expect(snapshot.selection).toEqual([]);
    expect(snapshot.history).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(snapshot.tool).toBe('ellipse');
    expect(snapshot.viewport).toEqual({ position: { x: 10, y: 20 }, zoom: 2 });
    expect(snapshot.snapping).toBe(false);
    expect(snapshot.scope).toBeNull();
    expect(snapshot.pathEdit).toBeNull();
    expect(snapshot.overlay).toBeNull();
    expect(snapshot.snap).toBeNull();
    // The restore itself writes nothing; the entry is unchanged and autosave is attached.
    expect(h.session.attached()).toBe(true);
    await expectNoWrite(h);
    expect(await rawGet(factory)).toBe(text);
    rect(h, 200);
    expect(await settle(h)).toBe(1);
    await expectStored(h);
    h.session.dispose();
  });

  it('empties a selection that a load on the same page would keep', () => {
    const editor = newEditor();
    const shapes = read('shapes.envelope.json');
    expect(host.restoreEnvelope(editor, shapes)).toEqual({ ok: true });
    ok(editor, { type: 'setSelection', ids: ['r1', 'r2'] });
    ok(editor, { type: 'setTool', tool: 'rectangle' });
    expect(host.restoreEnvelope(editor, shapes)).toEqual({ ok: true });
    expect(editor.getSnapshot().selection).toEqual([]);
    expect(editor.getSnapshot().activePage).toBe('page-1');
    expect(editor.getSnapshot().tool).toBe('rectangle');
  });

  it('replaces edits made during the read with the stored document; with no record it saves them', async () => {
    const factory = new IDBFactory();
    const envelope = twoPageEnvelope();
    await store(factory, envelope);
    const h = await harness({ factory, wait: false });
    rect(h, 300);
    await h.session.ready;
    expect(serializeDocument(h.editor.getSnapshot().document)).toBe(
      serializeDocument(envelope.document),
    );
    await expectNoWrite(h);
    h.session.dispose();

    const empty = await harness({ wait: false });
    expect(empty.session.status()).toEqual({ state: 'restoring' });
    rect(empty, 300);
    await empty.session.ready;
    expect(empty.session.status()).toEqual({ state: 'empty' });
    expect(await settle(empty)).toBe(1);
    await expectStored(empty);
    empty.session.dispose();
  });
});

type Case = Readonly<{
  name: string;
  /** The stored value; a string is the entry text. */
  value?: unknown;
  factory?: () => Promise<IDBFactory>;
  editor?: () => Editor;
  code: string;
  path: string;
}>;

const failures: readonly Case[] = [
  {
    name: 'open fails',
    factory: () =>
      Promise.resolve({
        open() {
          throw new Error('denied');
        },
      } as unknown as IDBFactory),
    code: 'persistence.unavailable',
    path: '',
  },
  {
    name: 'read fails (no envelopes store at version 1)',
    factory: async () => {
      const factory = new IDBFactory();
      (await rawOpen(factory, false)).close();
      return factory;
    },
    code: 'persistence.read-failed',
    path: '',
  },
  { name: 'a non-string value', value: 42, code: 'envelope.malformed-json', path: '' },
  {
    name: 'malformed text',
    value: read('malformed/malformed-json.json'),
    code: 'envelope.malformed-json',
    path: '',
  },
  {
    name: 'not an object',
    value: read('malformed/not-object.json'),
    code: 'envelope.invalid-field',
    path: '',
  },
  {
    name: 'a newer envelope',
    value: read('malformed/unsupported-version.json'),
    code: 'envelope.unsupported-version',
    path: '/envelopeVersion',
  },
  {
    name: 'a repeated node key',
    value: read('malformed/duplicate-node-id.json'),
    code: 'document.duplicate-id',
    path: '/document/nodes/r1',
  },
  {
    name: 'an unknown top-level key',
    value: read('malformed/unknown-key.json'),
    code: 'envelope.invalid-field',
    path: '/viewport',
  },
  {
    name: 'a document with a bad field',
    value: read('malformed/document-invalid-field.json'),
    code: 'document.invalid-field',
    path: '/document/nodes/r1/opacity',
  },
  {
    name: 'a newer document',
    value: read('malformed/document-unsupported-version.json'),
    code: 'document.unsupported-version',
    path: '/document/schemaVersion',
  },
  {
    name: 'an unknown page',
    value: read('malformed/unknown-page.json'),
    code: 'envelope.unknown-page',
    path: '/lastOpenPageId',
  },
  {
    name: 'an unregistered custom type',
    value: read('ext-star.envelope.json'),
    editor: () => busyEditor(false),
    code: 'document.unknown-custom-type',
    path: '/document/nodes/n2/customType',
  },
  {
    name: 'invalid custom data',
    value: starEnvelope(2),
    code: 'document.invalid-custom-data',
    path: '/document/nodes/n2/data',
  },
  {
    name: 'clip depth',
    value: clipDepthEnvelope(),
    code: 'editor.clip-depth',
    path: '/document/nodes/deep/parent',
  },
];

describe('M5-A08 restore failures load nothing and attach no autosave', () => {
  for (const entry of failures) {
    it(`${entry.name}: ${entry.code}`, async () => {
      const factory = entry.factory === undefined ? new IDBFactory() : await entry.factory();
      if (entry.value !== undefined) await rawPut(factory, entry.value);
      const editor = (entry.editor ?? busyEditor)();
      const before = editor.getSnapshot();
      const h = await harness({ factory, editor });
      const status = h.session.status();
      expect(status.state).toBe('error');
      if (status.state !== 'error') return;
      expect(status.code).toBe(entry.code);
      expect(status.path).toBe(entry.path);
      expect(host.persistStatusLabel(status)).toBe(
        `persist: error ${status.code} ${status.path}`.trimEnd(),
      );
      // Loads nothing: the same snapshot object (document, revision, history, session), no event.
      expect(editor.getSnapshot()).toBe(before);
      expect(h.events).toEqual([]);
      expect(h.session.attached()).toBe(false);
      const offered = entry.code !== 'persistence.unavailable';
      expect(host.offersDiscard(status)).toBe(offered);
      // An edit afterwards writes nothing; the entry stays byte for byte.
      rect(h, 500);
      await expectNoWrite(h);
      if (entry.value !== undefined) expect(await rawGet(factory)).toBe(entry.value);
      // "Open file" of the same text fails the same way for every parse and load class.
      if (typeof entry.value === 'string') {
        const middle = editor.getSnapshot();
        const result = host.restoreEnvelope(editor, entry.value);
        expect(result.ok).toBe(false);
        if (!result.ok) expect([result.code, result.path]).toEqual([status.code, status.path]);
        expect(editor.getSnapshot()).toBe(middle);
      }
      h.session.dispose();
    });
  }

  it('"Discard stored document" clears the entry and attaches autosave', async () => {
    const factory = new IDBFactory();
    const corrupt = read('malformed/document-invalid-field.json');
    await rawPut(factory, corrupt);
    const h = await harness({ factory });
    expect(h.session.status()).toMatchObject({ state: 'error', stage: 'restore' });
    rect(h, 10);
    await expectNoWrite(h);
    expect(await rawGet(factory)).toBe(corrupt);
    await h.session.discard();
    expect(h.session.attached()).toBe(true);
    expect(h.statuses.at(-1)).toEqual({ state: 'empty' });
    expect(host.offersDiscard(h.session.status())).toBe(false);
    // The edit made after the failed restore moved the revision: the attach saves it.
    expect(await settle(h)).toBe(1);
    await expectStored(h);
    rect(h, 200);
    expect(await settle(h)).toBe(1);
    await expectStored(h);
    // A second discard does nothing once autosave is attached.
    await h.session.discard();
    await expectStored(h);
    h.session.dispose();
  });
});

/** The fake factory, with `onTransaction` called for each transaction the adapter creates. */
function hooked(
  real: IDBFactory,
  onTransaction: (mode: IDBTransactionMode, tx: IDBTransaction) => void,
): IDBFactory {
  return {
    open(name: string, version?: number) {
      const request = real.open(name, version);
      // Registered before the adapter's `onsuccess`, so it runs first.
      request.addEventListener('success', () => {
        const database = request.result;
        const original = database.transaction.bind(database);
        database.transaction = ((stores: string | string[], mode?: IDBTransactionMode) => {
          const tx = original(stores, mode);
          onTransaction(mode ?? 'readonly', tx);
          return tx;
        }) as typeof database.transaction;
      });
      return request;
    },
  } as unknown as IDBFactory;
}

describe('M5-A08 discard failure, cleanup during the read and a throwing restore', () => {
  it('a failed discard offers Discard again and attaches nothing', async () => {
    const real = new IDBFactory();
    const corrupt = read('malformed/malformed-json.json');
    await rawPut(real, corrupt);
    let failClears = true;
    const factory = hooked(real, (mode, tx) => {
      if (mode === 'readwrite' && failClears) queueMicrotask(() => tx.abort());
    });
    const h = await harness({ factory });
    expect(h.session.status()).toMatchObject({ state: 'error', stage: 'restore' });
    await h.session.discard();
    const status = h.session.status();
    expect(status).toEqual({
      state: 'error',
      stage: 'discard',
      code: 'persistence.write-failed',
      path: '',
    });
    expect(host.offersDiscard(status)).toBe(true);
    expect(h.session.attached()).toBe(false);
    rect(h, 10);
    await expectNoWrite(h);
    expect(await rawGet(real)).toBe(corrupt);
    // Offered again: a discard that now succeeds attaches.
    failClears = false;
    await h.session.discard();
    expect(h.session.attached()).toBe(true);
    expect(h.session.status()).toEqual({ state: 'empty' });
    h.session.dispose();
  });

  it('a cleanup between the open and the read loads nothing and closes the connection', async () => {
    const real = new IDBFactory();
    await store(real, twoPageEnvelope());
    let session: Session | null = null;
    const factory = hooked(real, (mode) => {
      // The read's transaction: the page unmounts while the read is pending.
      if (mode === 'readonly') session?.dispose();
    });
    const editor = busyEditor();
    const before = editor.getSnapshot();
    const statuses: PersistStatus[] = [];
    const events: EditorEvent[] = [];
    editor.subscribe((event) => events.push(event));
    session = host.attachPersistence(editor, {
      indexedDB: factory,
      timers: clock(),
      onStatus: (status) => statuses.push(status),
    });
    await session.ready;
    await idle();
    expect(editor.getSnapshot()).toBe(before);
    expect(events).toEqual([]);
    expect(statuses).toEqual([{ state: 'restoring' }]);
    expect(session.attached()).toBe(false);
    const deleting = real.deleteDatabase(DB);
    let blocked = false;
    deleting.onblocked = () => {
      blocked = true;
    };
    await done(deleting);
    expect(blocked).toBe(false);
  });

  it('a throw during the restore is a failed restore, not an unhandled rejection', async () => {
    const factory = new IDBFactory();
    await store(factory, twoPageEnvelope());
    const editor = busyEditor();
    const original = editor.execute.bind(editor);
    editor.execute = (command) => {
      if (command.type === 'loadDocument') throw new Error('editor failure');
      return original(command);
    };
    const before = editor.getSnapshot();
    const h = await harness({ factory, editor });
    expect(h.session.status()).toEqual({
      state: 'error',
      stage: 'restore',
      code: 'persistence.read-failed',
      path: '',
    });
    expect(h.session.attached()).toBe(false);
    expect(editor.getSnapshot()).toBe(before);
    rect(h, 10);
    await expectNoWrite(h);
    h.session.dispose();
  });
});

describe('M5-A08 composition: opt-in, strict-mode remount and the status', () => {
  it('is off by default, on with ?persist=1, and wins over ?fixture=', () => {
    expect(host.persistQuery('')).toEqual({ persist: false, fixtureIgnored: false });
    expect(host.persistQuery('?fixture=containers')).toEqual({
      persist: false,
      fixtureIgnored: false,
    });
    expect(host.persistQuery('?persist=1&test=1')).toEqual({
      persist: true,
      fixtureIgnored: false,
    });
    expect(host.persistQuery('?persist=1&fixture=path-edit')).toEqual({
      persist: true,
      fixtureIgnored: true,
    });
    expect(host.persistQuery('?persist=true')).toEqual({ persist: false, fixtureIgnored: false });
    expect(host.PERSIST_DATABASE_NAME).toBe(DB);
  });

  it('labels each status', () => {
    expect(host.persistStatusLabel({ state: 'restoring' })).toBe('persist: restoring');
    expect(host.persistStatusLabel({ state: 'empty' })).toBe('persist: empty');
    expect(host.persistStatusLabel({ state: 'saved', count: 3 })).toBe('persist: saved 3');
    expect(
      host.persistStatusLabel({
        state: 'error',
        stage: 'restore',
        code: 'envelope.unknown-page',
        path: '/lastOpenPageId',
      }),
    ).toBe('persist: error envelope.unknown-page /lastOpenPageId');
    expect(host.offersDiscard(null)).toBe(false);
    expect(
      host.offersDiscard({
        state: 'error',
        stage: 'write',
        code: 'persistence.write-failed',
        path: '',
      }),
    ).toBe(false);
  });

  it('a remount leaves one subscription and one connection; dispose closes it', async () => {
    const factory = new IDBFactory();
    const editor = newEditor();
    const time = clock();
    const first: PersistStatus[] = [];
    const second: PersistStatus[] = [];
    // As reactStrictMode: mount, clean up at once, mount again.
    const a = host.attachPersistence(editor, {
      indexedDB: factory,
      timers: time,
      onStatus: (s) => first.push(s),
    });
    a.dispose();
    const b = host.attachPersistence(editor, {
      indexedDB: factory,
      timers: time,
      onStatus: (s) => second.push(s),
    });
    await Promise.all([a.ready, b.ready]);
    expect(a.attached()).toBe(false);
    expect(b.attached()).toBe(true);
    expect(first).toEqual([{ state: 'restoring' }]);
    expect(second).toEqual([{ state: 'restoring' }, { state: 'empty' }]);
    ok(editor, { type: 'createRectangle', frame: { x: 0, y: 0, width: 5, height: 5 } });
    // One subscription: one timer pair (trailing and max wait), one write.
    expect(time.pending()).toBe(2);
    time.advance(500);
    await idle();
    expect(second.at(-1)).toEqual({ state: 'saved', count: 1 });
    expect(first).toEqual([{ state: 'restoring' }]);
    expect(await rawGet(factory)).toBe(host.saveFileText(editor));
    b.dispose();
    // Every connection is closed: deleting the database is not blocked.
    const deleting = factory.deleteDatabase(DB);
    let blocked = false;
    deleting.onblocked = () => {
      blocked = true;
    };
    await done(deleting);
    expect(blocked).toBe(false);
    // After dispose, edits schedule nothing.
    ok(editor, { type: 'createRectangle', frame: { x: 0, y: 0, width: 5, height: 5 } });
    expect(time.pending()).toBe(0);
    await b.flush();
  });
});
