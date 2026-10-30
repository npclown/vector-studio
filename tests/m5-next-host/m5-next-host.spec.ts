import { readFile } from 'node:fs/promises';
import type { Editor, EditorEvent } from '@vector-studio/editor-core';
import {
  parseEnvelope,
  serializeDocument,
  serializeEnvelope,
  type DocumentV6,
} from '@vector-studio/model';
import { expect, test, type Page } from '@playwright/test';

// M5-U5 (MVP M5 contract, section 7): M5-A10, the next-host page's `?persist=1` composition with
// the browser's own IndexedDB in headed Chrome and Edge. A drawing on page 1 and on an added
// page 2 is flushed and the page reloaded: the serialized document is the one before the reload,
// page 2 is active, and selection, camera and history are those of a fresh load (section 5.1).
// "Save file" downloads envelope text that `parseEnvelope` accepts, and "Open file" of it after
// a change restores it. A corrupt entry written by the spec into the page's database (malformed
// text, and a document with a bad field) fails the restore with its code, loads nothing, and is
// left byte for byte after an edit (M5-Q11 (a)). `?persist=1&fixture=` ignores the fixture, and
// the test hook's `persistence.flush` writes the entry (M5-U4 notes 7 and 9). Each test runs in
// a fresh browser context, so it starts from an empty IndexedDB; the first test checks that.
//
// The `chromium-smoke` project (M5_NEXT_HOST_CHROMIUM, playwright.m5-next-host.config.ts) runs
// headless where the renderer may fail to start: persistence and input do not depend on it. It
// is a functional smoke run of the spec, not M5-A10 evidence.

declare global {
  interface Window {
    /** The next-host page's test hook, present with `?test=1` (apps/next-host/app/page.tsx). */
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
  }
}

/** The hook's M5 member (section 5.3), declared apart so the shared `__p5Host` type stays one. */
type PersistenceHook = Readonly<{ persistence: Readonly<{ flush(): Promise<void> }> }>;
type Point = Readonly<{ x: number; y: number }>;

/** The page's database and the adapter's layout (M5 contract, sections 4.2 and 5.3). */
const DATABASE = 'vector-studio-next-host';
const STORE = 'envelopes';
const KEY = 'default';
/** Past the autosave's 500 ms debounce and 2,000 ms maximum wait (M5-Q6). */
const AFTER_AUTOSAVE_MS = 2_500;
/**
 * The editor's empty document. `node-1` and `node-2` follow editor-core's default counter ID
 * source (`createCounterIdSource('node-')`, used by `emptyDocument`, editor.ts:444).
 */
const DEFAULT_DOCUMENT: DocumentV6 = {
  schemaVersion: 6,
  id: 'node-1',
  pages: [{ id: 'node-2', name: 'Page 1', children: [] }],
  nodes: {},
};
const DEFAULT_CAMERA = { position: { x: 0, y: 0 }, zoom: 1 };
/** Cameras set before a flush, Save or Open, so the checks after them show what is not restored. */
const PANNED_CAMERA = { position: { x: 40, y: -30 }, zoom: 2 };
const OTHER_CAMERA = { position: { x: -25, y: 15 }, zoom: 0.5 };

/**
 * The renderer state after a load: ready with no `error` element in the headed projects; in the
 * headless smoke project only past `pending`, since the renderer may fail to start there.
 */
async function rendererSettled(page: Page) {
  const status = page.getByTestId('status');
  if (test.info().project.name === 'chromium-smoke') {
    await expect(status).not.toHaveAttribute('data-renderer', 'pending', { timeout: 30_000 });
  } else {
    await expect(status).toHaveAttribute('data-renderer', 'ready', { timeout: 30_000 });
    await expect(page.getByTestId('error')).toHaveCount(0);
  }
}

/** Sets the camera through the session command (a session change, which schedules no write). */
async function setCamera(page: Page, camera: typeof DEFAULT_CAMERA) {
  const ok = await page.evaluate(
    (value) => window.__p5Host!.editor.execute({ type: 'setViewport', camera: value }).ok,
    camera,
  );
  expect(ok).toBe(true);
  expect((await session(page)).viewport).toEqual(camera);
}

/** Opens the page, waits for the hook and the renderer state, and returns a page-to-screen map. */
async function open(page: Page, query: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/?test=1${query}`);
  await page.waitForFunction(() => window.__p5Host !== undefined);
  const status = page.getByTestId('status');
  await rendererSettled(page);
  /** A page point on screen with the current camera and canvas content box, read at call time. */
  const screen = async (p: Point): Promise<Point> => {
    const { origin, position, zoom } = await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      const rect = canvas.getBoundingClientRect();
      return {
        origin: { x: rect.left + canvas.clientLeft, y: rect.top + canvas.clientTop },
        ...window.__p5Host!.editor.query({ type: 'viewport' }),
      };
    });
    return { x: origin.x + (p.x - position.x) * zoom, y: origin.y + (p.y - position.y) * zoom };
  };
  return { errors, status, screen };
}

/** Waits for the persistence status to reach `state` (section 5.3). */
async function persistState(page: Page, state: string) {
  await expect(page.getByTestId('persist-status')).toHaveAttribute('data-persist', state, {
    timeout: 30_000,
  });
}

async function documentOf(page: Page): Promise<DocumentV6> {
  const text = await page.evaluate(() =>
    JSON.stringify(window.__p5Host!.editor.query({ type: 'document' })),
  );
  return JSON.parse(text) as DocumentV6;
}

/** The canonical document text (`serializeDocument`), compared byte for byte. */
async function serialized(page: Page): Promise<string> {
  return serializeDocument(await documentOf(page));
}

async function session(page: Page) {
  return page.evaluate(() => {
    const value = window.__p5Host!.editor.getSnapshot();
    return {
      activePage: value.activePage,
      selection: [...value.selection],
      viewport: value.viewport,
      undoDepth: value.history.undoDepth,
    };
  });
}

async function flush(page: Page) {
  await page.evaluate(() => (window.__p5Host as unknown as PersistenceHook).persistence.flush());
}

async function drag(page: Page, from: Point, to: Point) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

/** Draws one rectangle on the active page with the rectangle tool; returns its ID. */
async function drawRectangle(
  page: Page,
  screen: (p: Point) => Promise<Point>,
  from: Point,
  to: Point,
): Promise<string> {
  const before = await session(page);
  const children = (await documentOf(page)).pages.find((p) => p.id === before.activePage)!.children;
  await page.getByTestId('tool-rectangle').click();
  await drag(page, await screen(from), await screen(to));
  const after = await documentOf(page);
  const added = after.pages
    .find((p) => p.id === before.activePage)!
    .children.filter((id) => !children.includes(id));
  expect(added).toHaveLength(1);
  expect(after.nodes[added[0]!]?.type).toBe('rectangle');
  return added[0]!;
}

/** Adds a page through the editor command (the page has no add-page button) and switches to it. */
async function addPage(page: Page): Promise<string> {
  const result = await page.evaluate(() => {
    const value = window.__p5Host!.editor.execute({ type: 'addPage' });
    return value.ok ? value.ids : null;
  });
  expect(result).not.toBeNull();
  expect(result).toHaveLength(1);
  const id = result![0]!;
  await page.getByTestId(`page-${id}`).click();
  await expect(page.getByTestId('status')).toHaveAttribute('data-page', id);
  return id;
}

/** The page database's names, from `indexedDB.databases()`. */
async function databases(page: Page): Promise<string[]> {
  return page.evaluate(async () =>
    (await indexedDB.databases()).map((info) => info.name ?? '').sort(),
  );
}

/**
 * Writes `value` into the page's entry directly, creating the database at version 1 with the
 * adapter's object store when it does not exist yet (the adapter's layout, section 4.2).
 */
async function writeEntry(page: Page, value: string) {
  await page.evaluate(
    async ({ database, store, key, value }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        request.onblocked = () => reject(new Error('blocked'));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(store, 'readwrite');
          transaction.objectStore(store).put(value, key);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('IndexedDB transaction failed'));
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('IndexedDB transaction failed'));
        });
      } finally {
        db.close();
      }
    },
    { database: DATABASE, store: STORE, key: KEY, value },
  );
}

/** Reads the page's entry directly; the database must exist (the store has opened it). */
async function readEntry(page: Page): Promise<unknown> {
  return page.evaluate(
    async ({ database, store, key }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      });
      try {
        return await new Promise<unknown>((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
        });
      } finally {
        db.close();
      }
    },
    { database: DATABASE, store: STORE, key: KEY },
  );
}

test('M5-A10: a reload restores the document and the last open page', async ({ page }) => {
  // A fresh context: before any `?persist=1` page, the origin has no page database.
  await open(page, '');
  expect(await databases(page)).not.toContain(DATABASE);

  const { errors, screen } = await open(page, '&persist=1');
  await persistState(page, 'empty');
  expect(await documentOf(page)).toEqual(DEFAULT_DOCUMENT);

  // Draw on page 1, add page 2 and draw there.
  const page1 = (await session(page)).activePage;
  await drawRectangle(page, screen, { x: 100, y: 100 }, { x: 220, y: 180 });
  const page2 = await addPage(page);
  expect(page2).not.toBe(page1);
  await drawRectangle(page, screen, { x: 300, y: 200 }, { x: 380, y: 260 });
  const drawn = await documentOf(page);
  expect(drawn.pages.map((p) => p.children.length)).toEqual([1, 1]);
  // Pan and zoom before the flush: the camera after the reload must still be the default one.
  await setCamera(page, PANNED_CAMERA);

  await flush(page);
  // The state alone may come from the debounce; the entry content check below is what counts.
  await persistState(page, 'saved');
  const before = await serialized(page);
  // The entry holds that document and page 2, in the envelope text form.
  const entry = await readEntry(page);
  expect(typeof entry).toBe('string');
  const stored = parseEnvelope(entry as string);
  expect(stored.ok).toBe(true);
  if (!stored.ok) return;
  expect(stored.envelope.lastOpenPageId).toBe(page2);
  expect(serializeDocument(stored.envelope.document)).toBe(before);

  await page.reload();
  await page.waitForFunction(() => window.__p5Host !== undefined);
  await rendererSettled(page);
  await persistState(page, 'restored');
  expect(await serialized(page)).toBe(before);
  expect(await session(page)).toEqual({
    activePage: page2,
    selection: [],
    viewport: DEFAULT_CAMERA,
    undoDepth: 0,
  });
  await expect(page.getByTestId('status')).toHaveAttribute('data-page', page2);
  await expect(page.getByTestId(`page-${page2}`)).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('M5-A10: Save file downloads an envelope and Open file restores it', async ({ page }) => {
  const { errors, screen } = await open(page, '&persist=1');
  await persistState(page, 'empty');
  await drawRectangle(page, screen, { x: 100, y: 100 }, { x: 220, y: 180 });
  const page2 = await addPage(page);
  await drawRectangle(page, screen, { x: 300, y: 200 }, { x: 380, y: 260 });
  // A camera at save time; the envelope does not carry it (section 5.1).
  await setCamera(page, PANNED_CAMERA);
  const saved = await serialized(page);

  const downloading = page.waitForEvent('download');
  await page.getByTestId('save-file').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('document.vstudio.json');
  const text = await readFile(await download.path(), 'utf8');
  const parsed = parseEnvelope(text);
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.envelope.lastOpenPageId).toBe(page2);
  expect(serializeDocument(parsed.envelope.document)).toBe(saved);
  // The download is the canonical envelope text (section 2, M5-E3).
  expect(text).toBe(serializeEnvelope(parsed.envelope));
  await expect(page.getByTestId('file-status')).toHaveText('file: saved');

  // A change: another rectangle on page 2, in view at the panned camera, then back to page 1.
  await drawRectangle(page, screen, { x: 120, y: 40 }, { x: 160, y: 80 });
  const page1 = (await documentOf(page)).pages[0]!.id;
  await page.getByTestId(`page-${page1}`).click();
  expect(await serialized(page)).not.toBe(saved);
  // Another camera before Open: a load keeps the current viewport (section 5.1), so after Open
  // the camera is this one, not the one at save time.
  await setCamera(page, OTHER_CAMERA);

  await page.getByTestId('open-file').setInputFiles({
    name: 'document.vstudio.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });
  await expect(page.getByTestId('file-status')).toHaveText('file: opened');
  expect(await serialized(page)).toBe(saved);
  expect(await session(page)).toEqual({
    activePage: page2,
    selection: [],
    viewport: OTHER_CAMERA,
    undoDepth: 0,
  });
  expect(errors).toEqual([]);
});

const CORRUPT: readonly Readonly<{ name: string; text: string; code: string; path: string }>[] = [
  {
    name: 'malformed text',
    text: '{"envelopeVersion": 1,',
    code: 'envelope.malformed-json',
    path: '',
  },
  {
    name: 'a document with a bad field',
    // A valid envelope of the default document whose page name is a number.
    text: serializeEnvelope({
      document: DEFAULT_DOCUMENT,
      lastOpenPageId: DEFAULT_DOCUMENT.pages[0]!.id,
    }).replace('"name": "Page 1"', '"name": 5'),
    code: 'document.invalid-field',
    path: '/document/pages/0/name',
  },
];

for (const corrupt of CORRUPT) {
  test(`M5-A10: a corrupt entry (${corrupt.name}) loads nothing and is kept`, async ({ page }) => {
    // The spec's own parse agrees with the code the page must show.
    expect(parseEnvelope(corrupt.text)).toEqual({
      ok: false,
      code: corrupt.code,
      path: corrupt.path,
    });
    await open(page, '');
    await writeEntry(page, corrupt.text);
    expect(await readEntry(page)).toBe(corrupt.text);

    // Reload with persistence: the restore fails with the code and loads nothing.
    const { errors, screen } = await open(page, '&persist=1');
    await persistState(page, 'error');
    const status = page.getByTestId('persist-status');
    await expect(status).toHaveAttribute('data-code', corrupt.code);
    await expect(status).toHaveAttribute('data-path', corrupt.path);
    await expect(status).toContainText(`persist: error ${corrupt.code} ${corrupt.path}`.trimEnd());
    await expect(page.getByTestId('persist-discard')).toBeVisible();
    expect(await documentOf(page)).toEqual(DEFAULT_DOCUMENT);
    expect(await session(page)).toEqual({
      activePage: DEFAULT_DOCUMENT.pages[0]!.id,
      selection: [],
      viewport: DEFAULT_CAMERA,
      undoDepth: 0,
    });

    // After an edit, past the autosave's delays and a flush, the entry is byte for byte the same.
    await drawRectangle(page, screen, { x: 100, y: 100 }, { x: 220, y: 180 });
    await page.waitForTimeout(AFTER_AUTOSAVE_MS);
    await flush(page);
    expect(await readEntry(page)).toBe(corrupt.text);
    await expect(status).toHaveAttribute('data-persist', 'error');
    await expect(status).toHaveAttribute('data-code', corrupt.code);
    expect(errors).toEqual([]);
  });
}

test('M5 section 5.3: persist=1 ignores fixture= and persistence.flush writes', async ({
  page,
}) => {
  // Without `?persist=1`, flush resolves at once and creates no database.
  await open(page, '');
  await flush(page);
  expect(await databases(page)).not.toContain(DATABASE);

  const { errors, status, screen } = await open(page, '&persist=1&fixture=containers');
  await expect(status).toHaveAttribute('data-fixture', 'ignored');
  await expect(page.getByTestId('fixture-ignored')).toHaveText(
    'fixture ignored: persist=1 wins over fixture=',
  );
  await persistState(page, 'empty');
  expect(await documentOf(page)).toEqual(DEFAULT_DOCUMENT);
  expect(await readEntry(page)).toBeUndefined();

  // An edit, then a flush through the hook (well before the 500 ms debounce could matter):
  // the entry holds the edited document and the active page.
  await drawRectangle(page, screen, { x: 100, y: 100 }, { x: 220, y: 180 });
  await flush(page);
  await persistState(page, 'saved');
  const entry = await readEntry(page);
  expect(typeof entry).toBe('string');
  const stored = parseEnvelope(entry as string);
  expect(stored.ok).toBe(true);
  if (!stored.ok) return;
  expect(serializeDocument(stored.envelope.document)).toBe(await serialized(page));
  expect(stored.envelope.lastOpenPageId).toBe((await session(page)).activePage);
  expect(errors).toEqual([]);
});
