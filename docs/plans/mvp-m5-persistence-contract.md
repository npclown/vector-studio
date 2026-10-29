# MVP M5 contract: persistence

Status: APPROVED 2026-10-29 after independent review round 1 (APPROVED WITH FOLLOW-UPS, applied); Full tier (persisted format, new package and boundary-policy entry, a public query, product behavior). Visualization-track item [V-11](d9-visualization-track.md#status-index), milestone M5 of the [MVP editor plan](mvp-editor-plan.md#m5-persistence). It was drafted while the user's acceptance of the M3 exit ([V-10](d9-visualization-track.md#status-index), [exit record](../evidence/m3-exit-2026-10-29.md)) was pending; the user accepted the M3 exit on 2026-10-29, so implementation starts at M5-U1 (section 12). The user approved M5-Q4 (a) `fake-indexeddb` on 2026-10-29.

Owners: this file owns M5 scope, the persistence envelope and its codes, the IndexedDB adapter's API and codes, the autosave and restore rules, the `committedDocument` query, acceptance criteria M5-A01 to M5-A11 and the units. Product behavior stays in [`requirements.md`](../requirements.md#persistence) (Persistence), which this contract does not change; package boundaries in [`ARCHITECTURE.md`](../../ARCHITECTURE.md#dependency-direction); the migration policy in MVP-Q2 ([plan, section 9](mvp-editor-plan.md#9-open-questions)); the P5, M1, M2 and M3 rules stay in force.

## 1. Scope

In scope: a persistence envelope `{ document, lastOpenPageId }` with its text form and parse codes in `model`; host-controlled save and load in next-host (save to a file, open a file); a new optional package `@vector-studio/persistence-idb` (an IndexedDB store and an autosave scheduler) with its boundary-policy entry; the host composition that wires `editor.subscribe` to autosave; restore of document content and the last open page; one additive `editor-core` query (M5-Q9); a next-host headed reload spec.

Scope note: the MVP plan says `model` "defines only the envelope type and its parse codes"; this contract reads that as also covering `serializeEnvelope`, `parseEnvelope`, `ENVELOPE_VERSION` and the `scanJson` `maxDepth` option, because host save and load and the adapter must share one serializer and one parser.

Out of scope: restoring selection, hover, zoom, viewport, tool, scope, path edit mode, panels or history (requirements: "Do not restore transient selection, hover, zoom, or panel state initially"; ARCHITECTURE, state classification); undo history across reloads; multi-tab coordination beyond M5-Q7 (a); several documents in one store (a document list or picker); `navigator.storage.persist()` and eviction handling; server or cloud persistence, import and export formats other than the envelope; collaboration; a schema change (M5 adds no document field, so `schemaVersion` stays 2 and no migration is added). Performance note (no gate): every autosave serializes the whole document; M5 makes no performance claim (M9).

### 1.1 Starting point (main at d004b31)

- **Model.** `parseDocument(text)` (`packages/model/src/parse.ts:73`) checks, in order: `JSON.parse` (`document.malformed-json` at `''`), a plain object (`document.invalid-field` at `''`) and `schemaVersion` 1 or 2 (`document.unsupported-version` at `/schemaVersion`, `parse.ts:167`), then `scanJson` (`json-scan.ts:31`: a repeated key, or nesting deeper than `MAX_DEPTH = 256`; a repeated key at `/nodes/<id>` is `document.duplicate-id`, any other finding `document.invalid-field`, `parse.ts:84-92`), then the field rules. `validateAnyDocument` (`parse.ts:109`) validates a v1 or v2 value and migrates v1 (`migrateV1toV2`, `parse.ts:422`); `serializeDocument` (`serialize.ts:128`) writes canonical v2 text with fixed key order. The model imports nothing (`tooling/boundary-policy.mjs`, model entry).
- **Editor.** `subscribe` (`packages/editor-core/src/editor.ts:1092`) delivers `EditorEvent`s (`types.ts:545`): `document` events with `cause` `command`, `gesture-update`, `gesture-commit`, `gesture-cancel`, `undo`, `redo` or `load` (`types.ts:542`), and `session` events by field. Gesture updates change the live document without history (`editor.ts:1558`); a commit records one step (`commitGestureState`, `editor.ts:1600`); a gesture that was replaced back to its base ends with no event (`editor.ts:1606`). Delivery is queued, so "the snapshot a listener reads may already be newer than its event" (`editor.ts:1861`). `loadDocument` validates like the constructor (model, then extension checks, then clip depth, `editor.ts:1017-1026`), fails without any change, clears history and activates the **first** page (`editor.ts:773`, `1682`); when that page is the one already active it keeps selected IDs that still exist (`editor.ts:1699-1707`). No query returns the committed document during a gesture (`types.ts:456`).
- **Host.** next-host creates the editor synchronously (`apps/next-host/app/page.tsx:395`) and loads `?fixture=` documents with `response.json()` and `loadDocument` on the value (`page.tsx:318-320`), which bypasses the duplicate-key scan. There is no save, open or storage code, and no IndexedDB writes anywhere in the repository (`tests/gpu/viz-v2-path-data.spec.ts:914` only counts `indexedDB.databases()`).
- **Tests.** Unit tests run in Vitest under Node (`vitest.config.ts`), which has no `indexedDB`; no fake IndexedDB package is installed.

## 2. Persistence envelope (model)

```ts
type PersistenceEnvelope = Readonly<{ document: DocumentV2; lastOpenPageId: string }>;
type EnvelopeResult =
  | Readonly<{ ok: true; envelope: PersistenceEnvelope }>
  | Readonly<{ ok: false; code: EnvelopeErrorCode | ModelErrorCode; path: string }>;
```

- **M5-E1 beside, not inside.** The envelope wraps a document; the document's own schema, fields and `serializeDocument` text are unchanged, and `lastOpenPageId` never enters the document, its history or `EditorSnapshot.document` (MVP-Q2 (a); ARCHITECTURE: "Host/persistence envelope ... separate from document edit history").
- **M5-E2 own version.** The text form carries `envelopeVersion: 1`, independent of `schemaVersion`, because the envelope changes on its own schedule (for example a later requirement that restores the viewport) while document migrations stay in `parseDocument` (M5-Q2). The in-memory type has no version field; `ENVELOPE_VERSION = 1` is exported.
- **M5-E3 text form.** `serializeEnvelope(envelope)` writes `{ "envelopeVersion": 1, "lastOpenPageId": …, "document": { … } }` in that key order, two-space indentation and a final newline, with the document object in the key order of `serializeDocument` (M5-Q1 (a): the document is an embedded object, not an embedded string). It validates nothing, as `serializeDocument` does. `parseEnvelope(serializeEnvelope(e))` deep-equals `e`, and `serializeDocument` of the parsed document equals `serializeDocument(e.document)` byte for byte.
- **M5-E4 parse.** `parseEnvelope(text: string): EnvelopeResult` returns no partial envelope. It accepts a v1 or v2 document inside and returns v2 (migrating v1, as `validateAnyDocument`). `scanJson` gains an optional `maxDepth` (default `MAX_DEPTH`), and the envelope is scanned at `MAX_DEPTH + 1`, so a document accepted alone is accepted inside an envelope.

### 2.1 Envelope codes and their order

New `ENVELOPE_ERROR_CODES`, exported from `model` beside `DOCUMENT_ERROR_CODES` and not added to `EditorErrorCode` (the editor never sees an envelope):

| Code | When |
| --- | --- |
| `envelope.malformed-json` | The text is not JSON (and, in the adapter, a stored value that is not a string) |
| `envelope.unsupported-version` | `envelopeVersion` is missing or not exactly 1, at `/envelopeVersion` |
| `envelope.invalid-field` | The top level is not a plain object (`''`); a missing or unknown top-level key; `lastOpenPageId` not a valid ID (`isValidId`); a scan finding outside `/document` |
| `envelope.unknown-page` | `lastOpenPageId` names no page of the (migrated) document, at `/lastOpenPageId` (M5-Q3) |

`parseEnvelope` checks in this order and returns the first failure: (1) `JSON.parse` → `envelope.malformed-json` at `''`; (2) not a plain object → `envelope.invalid-field` at `''`; (3) `envelopeVersion` → `envelope.unsupported-version`; (4) the scan at `MAX_DEPTH + 1`: a finding **under `/document`** (a finding path of length at least 2 whose first element is `document`) gets the document's code with `/document` prefixed (a repeated key at `/document/nodes/<id>` is `document.duplicate-id`, any other `document.invalid-field`), any other finding, a repeated top-level `document` key included, is `envelope.invalid-field`; (5) top-level keys exactly `envelopeVersion`, `lastOpenPageId`, `document` (missing before unknown, as `readRecord`), then `lastOpenPageId` → `envelope.invalid-field`; (6) `validateAnyDocument(value.document)` → its `document.*` code with its path prefixed by `/document` (for example `document.unsupported-version` at `/document/schemaVersion`); (7) `envelope.unknown-page`. `parseDocument` and `serializeDocument` are unchanged.

## 3. Host save and load

- **Save** (next-host toolbar "Save file"): downloads `serializeEnvelope` of the `envelope()` value of M5-S2 (the committed document and the active page) as `document.vstudio.json` through a Blob URL.
- **Open** ("Open file", an `<input type="file">`): reads the file as text and runs the restore of section 5.2 (`parseEnvelope`, then `loadDocument`, then `setActivePage`). A failure shows `code path` in the page status and loads nothing. A successful open is a `load` and so schedules an autosave when autosave is attached.
- A host may persist anywhere else with the same two functions; the model owns the format, the host owns where it goes (requirements, "Host-controlled persistence").

## 4. `@vector-studio/persistence-idb`

### 4.1 Package and boundary

- New workspace package `packages/persistence-idb`, `private`, ESM, built by `tsc --build` like `model`, with `lib` including `DOM` for the IndexedDB types. Its manifest names `@vector-studio/model` only. Root `tsconfig.json` gains its reference and root `devDependencies` its `workspace:*` entry, as for the other packages.
- `tooling/boundary-policy.mjs`, in the unit that creates the package: `boundaries` gains `['@vector-studio/persistence-idb', new Set(['@vector-studio/contracts', '@vector-studio/model'])]` (ARCHITECTURE: "persistence adapters -> model, contracts"; `contracts` is allowed but unused); `externalDenied` gains it with `react`, `react-dom`, `next` and the fake IndexedDB package of M5-Q4 (so neither manifest nor source may name the fake); `packageDirectories` gains `packages/persistence-idb`; the next-host entry gains `@vector-studio/persistence-idb`. It imports no `editor-core` or React, and its only browser global is the default `globalThis.indexedDB`, read only when no factory is injected.

### 4.2 Store

```ts
type PersistenceErrorCode = 'persistence.unavailable' | 'persistence.read-failed' | 'persistence.write-failed';
type StoreFailure = Readonly<{ ok: false; code: PersistenceErrorCode | EnvelopeErrorCode | ModelErrorCode; path: string }>;
function openDocumentStore(options?: { indexedDB?: IDBFactory; databaseName?: string; key?: string }):
  Promise<Readonly<{ ok: true; store: DocumentStore }> | StoreFailure>;
interface DocumentStore {
  read(): Promise<Readonly<{ ok: true; envelope: PersistenceEnvelope | null }> | StoreFailure>;
  write(envelope: PersistenceEnvelope): Promise<Readonly<{ ok: true; written: boolean }> | StoreFailure>;
  clear(): Promise<Readonly<{ ok: true }> | StoreFailure>;
  close(): void;
}
```

- **Layout (M5-Q10).** Database `databaseName` (default `vector-studio`) at IndexedDB version 1, object store `envelopes` created in `upgradeneeded`, one record under `key` (default `default`) whose value is the envelope **text** from `serializeEnvelope`, so a store entry and a saved file share one format and one parser. The IndexedDB version is the database layout, not the envelope or document version.
- **Factory.** The store uses the injected `indexedDB` factory; only when none is injected does it read `globalThis.indexedDB`, its only global. Tests inject a fake (M5-Q4). No factory, an `open` error or a `blocked` open is `persistence.unavailable` at `''`; a connection that still opens after `blocked` is closed at once. On `versionchange` the store closes its connection; a later call returns `persistence.unavailable`.
- **Read.** One `readonly` transaction `get(key)`. A request or transaction error is `persistence.read-failed`; no record is `{ ok: true, envelope: null }`; a value that is not a string is `envelope.malformed-json` at `''`; a string goes through `parseEnvelope` and fails with its codes. A failed read returns no envelope and changes nothing in the store.
- **Write.** `serializeEnvelope`, then one `readwrite` transaction `put(text, key)`, resolved on the transaction's `complete` event. A write whose text equals the store's **last-text cache** resolves `{ ok: true, written: false }` without a transaction. A successful read of a record or write sets the cache; a failed read leaves it unset or as it was, and `clear()` and a failed write reset it to empty, so the next write always runs. An error or abort (for example `QuotaExceededError`) is `persistence.write-failed`, and the entry keeps its previous value (IndexedDB transactions are atomic). `clear` deletes the record in one `readwrite` transaction.
- **Ordering.** Read-write transactions on one store run in creation order (IndexedDB), so of several writes from one store the last one created is the final value.

### 4.3 Autosave scheduler and the host wiring

```ts
function createAutosave(options: {
  store: DocumentStore; envelope: () => PersistenceEnvelope;
  delayMs?: number; maxWaitMs?: number;              // defaults 500 and 2000 (M5-Q6)
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  onResult?: (result: Awaited<ReturnType<DocumentStore['write']>>) => void;
}): Readonly<{ schedule(): void; flush(): Promise<void>; dispose(): void }>;
```

- **M5-S1 debounce.** `schedule()` marks the store dirty and (re)starts a trailing timer of `delayMs`; a write starts when the timer fires or `maxWaitMs` after the first unsaved `schedule()`, whichever is first. A write reads `envelope()` when it starts, never when it was scheduled. At most one write is in flight; a `schedule()` during a write starts a new timer after it. `flush()` waits for any write in flight, then writes if dirty, and repeats until the store is clean with no write in flight (a failed write ends the loop and resolves); it never starts a second concurrent write. A failed write keeps the store dirty and is retried on the next `schedule()` or `flush()`; every result goes to `onResult`. `dispose()` clears the timers and ignores later calls; it does not cancel a write in flight.
- **M5-S2 committed transactions only.** The host composition subscribes: `editor.subscribe(event => …)` calls `schedule()` for a `document` event whose `cause` is `command`, `gesture-commit`, `undo`, `redo` or `load`, and for a `session` event with field `activePage` (M5-Q5); a `gesture-update` or `gesture-cancel` event, every other session field and diagnostics schedule nothing. `envelope()` returns `{ document: editor.query({ type: 'committedDocument' }), lastOpenPageId: editor.getSnapshot().activePage }`, so a write that starts during a later gesture still writes the committed document and never a gesture update.
- **M5-S3 `committedDocument` query** (editor-core, additive, M5-Q9): `{ type: 'committedDocument' }` returns the active gesture's pre-gesture document while a gesture is active, else the current document; it is a frozen `DocumentV2`, needs no event, and changes no other behavior. Without it the live document would be written mid-gesture, and an event-derived "gesture in flight" flag would stick after a gesture replaced back to its base, which ends without an event (`editor.ts:1606`).
- The event mapping lives in next-host (`apps/next-host/src/m5-persistence.ts`, a pure function over `EditorEvent`), because the adapter may not import `editor-core` (M5-Q8). On `visibilitychange` to `hidden` the host calls `flush()`, best effort: the browser may end the page before the transaction completes.

## 5. Restore

### 5.1 What is restored

Document content (the envelope's document) and the last open page. After a restore the editor state is that of `loadDocument` followed by `setActivePage`: history empty, selection empty (`restoreEnvelope` runs `setSelection { ids: [] }` after `loadDocument`, because a load that keeps the active page keeps surviving selected IDs, `editor.ts:1699-1707`), the active tool kept but reset, scope and path edit mode null, viewport and `snapping` unchanged (not restored; at the page's start the camera is `{ position: { x: 0, y: 0 }, zoom: 1 }`, `DEFAULT_VIEWPORT`, `editor.ts:180`, and `snapping` is true), overlay and snap null. Hover and panels are host state and are not restored.

### 5.2 Restore order and failure

`restoreEnvelope(editor, text)` in next-host (shared by the IndexedDB restore and "Open file") and the IndexedDB restore stop at the first failure, in this order:

1. `persistence.unavailable`, then `persistence.read-failed` (IndexedDB restore only);
2. no record: nothing to restore, which is not a failure (autosave attaches, the default document stays);
3. a non-string value (`envelope.malformed-json` at `''`), then the `parseEnvelope` order of section 2.1;
4. `loadDocument { document }`: the model's rules again, then the editor's own load checks in their order (`document.unknown-custom-type`, `document.invalid-custom-data`, `editor.clip-depth`; `editor.ts:1017-1026`);
5. `setActivePage { id: lastOpenPageId }`, which cannot fail after step 3 (`loadDocument` activates the first page, `editor.ts:1682`), then `setSelection { ids: [] }` (section 5.1).

A failure loads nothing: the editor's document, revision, history and session stay as they were, no event is raised, and the stored entry is left byte for byte. **A corrupt store entry is never overwritten automatically** (M5-Q11 (a)): after a failed IndexedDB restore, autosave is not attached for the page's lifetime; the page shows the code and path and offers "Discard stored document" (`clear`, then autosave attaches). An entry written by a newer build (`envelope.unsupported-version` or `document.unsupported-version`) is kept for that build.

### 5.3 next-host composition

Persistence is off by default and on only with `?persist=1` (M5-Q12), so the P5, M1, M2 and M3 headed specs never read or write a store. With it, the page opens the store (database `vector-studio-next-host`), restores (section 5.2), then creates the autosave and subscribes, in that order, so no autosave runs before the restore has finished or failed. When no record exists and the revision has moved since the page loaded (edits during the read), the attach schedules one write. `?persist=1` with `?fixture=` is not allowed: persistence wins, the fixture is ignored and the status says so. Because `reactStrictMode` is on (`apps/next-host/next.config.mjs:4`), the effect's cleanup unsubscribes, disposes the autosave and closes the store, so a remount leaves one subscription and one connection. Edits made before the restore finishes are replaced by a successful restore (disclosed; the status shows `restoring` until then). The status shows `persist: restoring | restored | empty | saved <n> | error <code> <path>`; the `?test=1` hook gains `persistence: { flush(): Promise<void> }`.

## 6. Multi-tab and concurrent writes

Two tabs of one origin share the entry. Under M5-Q7 (a), M5 does not coordinate them: each tab restores what was stored when it opened, and the last completed write wins, so a tab's edits can replace another tab's without notice. An entry is never torn (one atomic `put` per write, section 4.2). Within one tab, M5-S1 allows one write in flight and section 4.2 keeps the last created write. This is disclosed in the exit record; coordination is backlog.

## 7. Acceptance criteria

Unit tests use exact values and committed fixtures under `tests/fixtures/m5-persistence/`; adapter tests use the fake IndexedDB of M5-Q4 through the injected factory and Vitest fake timers.

| ID | Criterion | Method |
| --- | --- | --- |
| M5-A01 | Envelope text: `serializeEnvelope` of each fixture equals the committed text byte for byte (key order, indentation, final newline); `parseEnvelope(serializeEnvelope(e))` deep-equals `e` for every M1 v2 fixture with each page as `lastOpenPageId`; the embedded document re-serializes byte-identically; a v1 document inside migrates to the committed v2 text | Unit tests on fixtures |
| M5-A02 | Envelope codes: each code of section 2.1 and each prefixed document code with its literal path; the seven-step order (one fixture per adjacent pair of steps, failing both, gives the earlier); a document at JSON container depth 256 (`MAX_DEPTH`, not `MAX_TREE_DEPTH`) parses alone and inside an envelope, one level deeper fails both; a repeated node key gives `document.duplicate-id` at `/document/nodes/<id>`, a repeated top-level key `envelope.invalid-field` | Unit tests |
| M5-A03 | `model` stays free of imports; `parseDocument`, `serializeDocument` and every P5 and M1 model fixture are unchanged; `scanJson` without `maxDepth` behaves as before | Unit tests, `pnpm check:boundaries` |
| M5-A04 | Store with the fake IndexedDB: empty read gives `null`; write then read deep-equals; overwrite; `clear`; an unchanged write gives `written: false` and no transaction; injected factory absent, `open` error and `blocked` give `persistence.unavailable`; an aborted read and write give their codes and leave the entry; a non-string value and each corrupt-text class give the model codes with no envelope and the entry byte for byte unchanged; two writes keep the later | Unit tests (fake IndexedDB) |
| M5-A05 | Autosave scheduler with fake timers: trailing `delayMs`, `maxWaitMs` under a schedule every 100 ms, `envelope()` read at write start, one write in flight, a schedule during a write, `flush`, retry after a failed write, `dispose`, `onResult` | Unit tests (fake timers, fake IndexedDB) |
| M5-A06 | Host wiring with a real editor: commands, undo, redo, gesture commits through `input`, `loadDocument` and page switches each lead to one write after the debounce; a drag of many `pointermove`s writes nothing until its commit, and a write forced mid-drag (`flush`) holds the pre-gesture document; a cancelled drag and a drag replaced back to its base write nothing new; selection, tool, viewport, snapping, scope and path edit changes write nothing | Unit tests |
| M5-A07 | `committedDocument`: the pre-gesture document during a gesture (update, `replace`, after a host command cancels it), the current document otherwise; frozen; no event; every other query and the snapshot unchanged | Unit tests |
| M5-A08 | Restore: content and last open page per section 5.1 with literal session values; each failure of section 5.2 (one per step and code class) loads nothing (document, revision, history, session and event list unchanged), shows its code, leaves the entry unchanged and attaches no autosave; "Discard stored document" clears and attaches | Unit tests (fake IndexedDB) |
| M5-A09 | Boundary: the policy entry, `externalDenied` and `packageDirectories` of section 4.1; fixture manifests and sources show that `persistence-idb` importing `editor-core`, `react` or the fake IndexedDB package fails, and next-host importing `persistence-idb` passes; `pnpm check:boundaries` passes | Unit tests, `pnpm check:boundaries` |
| M5-A10 | Headed next-host spec with `?persist=1`, in Chrome and Edge: draw on page 1, add page 2 and draw there, `flush`, reload: the serialized document equals the one before the reload, page 2 is active, selection empty, camera `{ position: { x: 0, y: 0 }, zoom: 1 }`, undo depth 0; "Save file" downloads text that `parseEnvelope` accepts, and "Open file" of it after a change restores it; a corrupt entry (malformed text, and a document with a bad field) written by the spec, then reload: the status shows the code, the document is the default empty one, and after an edit the entry is unchanged; the P5, M1, M2 and M3 headed specs still pass | Headed spec on the main PC; other headed runs NOT RUN unless a unit needs them |
| M5-A11 | Independent `reviewer` review of each unit; the exit record lists evidence for M5-A01 to A10, the M5-Q7 disclosure and the section 5.3 restore-race disclosure, and the user accepts it | Review record |

The plan's exit gate is M5-A04 and M5-A08 (unit tests with a fake IndexedDB), M5-A10 (headed reload restores the document and page) and M5-A02, M5-A04 and M5-A08 (a corrupt entry fails with the model's codes and loads nothing).

## 8. Units

| Unit | Content | Tier |
| --- | --- | --- |
| M5-U1 | `model`: envelope type, `serializeEnvelope`, `parseEnvelope`, `ENVELOPE_ERROR_CODES`, `scanJson` `maxDepth`, fixtures (A01 to A03) | Full (persisted format, public API) |
| M5-U2 | `editor-core`: the `committedDocument` query (A07) | Full (public API) |
| M5-U3 | `packages/persistence-idb`: store, autosave scheduler, codes; boundary-policy entry, tsconfig and manifest wiring; the `fake-indexeddb` dev dependency (M5-Q4 (a), approved 2026-10-29) (A04, A05, A09) | Full (new package, boundary) |
| M5-U4 | next-host: event mapping, `restoreEnvelope`, `?persist=1` composition, Save and Open, discard, status and test hook (A06, A08) | Full (product behavior in the host composition) |
| M5-U5 | Headed spec `tests/m5-next-host/`, `playwright.m5-next-host.config.ts`, `test:m5-next-host` (A10) | Light |
| M5-U6 | Exit record (A11) | Full |

Order: U1 and U2 (independent), then U3, then U4, then U5, then U6. Every unit runs `pnpm check`; headed runs are on the user's main PC or NOT RUN. The D10 WIP limit of two units waiting for review applies.

## 9. Risks

- **Silent overwrite across tabs** (section 6) until coordination exists; disclosed, not hidden.
- **Lost last edits.** A debounced write pending when the tab closes may not complete; `flush` on `hidden` narrows the window, `maxWaitMs` bounds it under continuous edits. Not a durability guarantee.
- **Fake fidelity.** A fake IndexedDB may differ from Chrome and Edge in event timing and errors; M5-A10 runs the real one. Quota and eviction are not exercised.
- **Restore race** (section 5.3): edits made in the first milliseconds are replaced by a successful restore; with no record, the attach schedules one write if the revision has moved since the page loaded, so those edits are saved.
- **Autosave off after a failed restore** (section 5.2, M5-Q11 (a)): autosave stays off for the page's lifetime, so later edits are lost on reload unless the user saves a file or discards the entry. The exit record repeats this disclosure.
- **Envelope churn.** A later requirement that restores the viewport bumps `envelopeVersion` and needs a migration in `parseEnvelope`, by the rule of MVP-Q2 applied to the envelope.

## 10. Open questions

| ID | Question | Recommendation |
| --- | --- | --- |
| M5-Q1 | Envelope text form | (a) the document as an embedded JSON object: a saved file stays readable and diffable, and one scan keeps the duplicate-key and depth rules (codes prefixed `/document`). (b) the document as an embedded string: `parseDocument` reused unchanged, at the cost of escaped, unreadable files |
| M5-Q2 | Does the envelope have its own version? | (a) yes, `envelopeVersion: 1`, independent of `schemaVersion`; document migrations stay in the model's document parse. (b) reuse `schemaVersion`: every document bump would also version the envelope |
| M5-Q3 | `lastOpenPageId` naming no page | (a) `envelope.unknown-page`, load nothing: the writer always pairs a document with its own active page, so a mismatch means corruption. (b) fall back to the first page |
| M5-Q4 | Fake IndexedDB for unit tests (new dev dependency; **(a) approved by the user 2026-10-29**) | (a) `fake-indexeddb`, exact version pinned at approval, in root `devDependencies` only, imported only by `tests/unit/m5-*.test.ts` and denied in `persistence-idb` by `externalDenied`. (b) if declined: a hand-written fake of the subset the store uses under `tests/support/`, no new dependency, lower fidelity (the plan's exit gate then rests more on M5-A10) |
| M5-Q5 | What schedules a write | (a) committed document events (`command`, `gesture-commit`, `undo`, `redo`, `load`) and `activePage` changes, so a page switch alone is restored; never `gesture-update` or `gesture-cancel`. (b) document events only |
| M5-Q6 | Debounce values | (a) 500 ms trailing, 2,000 ms maximum wait, host-configurable |
| M5-Q7 | Multi-tab and concurrent writes | (a) last writer wins, disclosed, backlog. (b) single writer by the Web Locks API (a second tab restores but does not autosave). (c) a write generation in the record, refusing a write over a newer one. None changes a requirement; (a) keeps M5 small |
| M5-Q8 | Where `editor.subscribe` is wired | (a) the host composition (next-host), as the MVP plan says; the adapter stays free of `editor-core` and exposes `schedule` and `flush` |
| M5-Q9 | How autosave avoids writing gesture updates | (a) the additive `committedDocument` query (M5-S3). (b) no `editor-core` change: an event-derived hold flag, with the disclosed hole that a gesture replaced back to its base ends without an event and leaves the hold set until the next document event |
| M5-Q10 | Store layout | (a) one database, one store `envelopes`, one record per host key holding the envelope text; IndexedDB version 1 |
| M5-Q11 | After a failed restore | (a) keep the entry and keep autosave off until the user discards it, so a corrupt or newer-build entry is never lost by accident. (b) start autosaving over it |
| M5-Q12 | next-host opt-in | (a) `?persist=1`, so earlier headed specs and the default page stay storage-free |

No question narrows or changes a requirement. M5-Q1 to M5-Q3 and M5-Q5 to M5-Q12 are adopted as recommended under the user's standing rule of 2026-10-24 ("추천안 자동 채택", 2026-10-29). M5-Q4 (the `fake-indexeddb` dev dependency) needed the user's explicit approval; the user chose (a) on a decision card on 2026-10-29 at 01:10Z, so (b) is not used.

## 11. Validation of this contract

Documentation only: Markdown formatting (`npx prettier --check`) and local links were checked, and claims about existing code are grounded by `file:line`. No product, browser, GPU or benchmark run is claimed.

## 12. Gate

This contract was drafted on 2026-10-29 while the user's acceptance of the M3 exit (M3-U5, [exit record](../evidence/m3-exit-2026-10-29.md)) was pending; the user accepted it on 2026-10-29 at 01:10Z. The main line M1 to M3 was waiting on the user's acceptance of the M3 exit, and M4 needs rendering items E23 to E25 (R-G, R-D, R-O), which have now started on the [rendering track](d9-rendering-track.md#status-index); so under [MVP plan section 7](mvp-editor-plan.md#7-order-and-parallelism) (M1 -> M5; M5 "may be taken whenever the main line is blocked", there on review) M5 runs next. Implementation starts at M5-U1 only after both (1) this contract is approved by independent review (done 2026-10-29) and (2) the user has accepted the M3 exit, the second by the MVP plan's milestone order and the pattern of the M2 and M3 gates; approval alone does not start implementation. M5-U3 adds the fake IndexedDB dependency, which the user approved on 2026-10-29 (M5-Q4 (a)). The M5 exit is the user's acceptance of the M5-U6 record.

## 13. Progress

| Unit | State |
| --- | --- |
| M5-U1 | Done: envelope type, `serializeEnvelope`, `parseEnvelope`, `ENVELOPE_ERROR_CODES`, `scanJson` `maxDepth`, fixtures (A01 to A03); independent review round 1 READY WITH FOLLOW-UPS, applied |
| M5-U2 | Done: the `committedDocument` query (A07); independent review round 1 READY WITH FOLLOW-UPS, applied |
| M5-U3 | Done: `packages/persistence-idb` store, autosave scheduler and codes, boundary-policy entry, `fake-indexeddb` 6.2.5 (A04, A05, A09); independent review round 1 READY WITH FOLLOW-UPS, applied; round 2 READY WITH FOLLOW-UPS (notes only), applied |
| M5-U4 | Not started |
| M5-U5 | Not started |
| M5-U6 | Not started |

M5-U1 notes (2026-10-29, Primary decisions recorded from its review): (1) `document.malformed-json` cannot occur inside an envelope (step 1 parses the whole text, and the document validator never returns it), so A02 tests every other document code with its prefixed path. (2) "Exactly 1" is the JSON number 1: the text `1.0` is accepted; `"1"`, `true` and `[1]` are rejected. (3) A `document` value that is not an object fails at step 6 as `document.invalid-field` at `/document`; a top-level value that is not an object (`null`, a number, a boolean, a string, an array) is `envelope.invalid-field` at `''`. (4) Results are not frozen, as with `parseDocument`; `Readonly` is a type-level promise. (5) The model also exports the types `ScanOptions` (the `scanJson` options parameter), `EnvelopeErrorCode`, `EnvelopeResult` and `PersistenceEnvelope`. (6) `serializeEnvelope` writes the document in `serializeDocument`'s key order through an internal helper; `serializeDocument` output is unchanged (A03). The committed canonical envelopes were built from the M1 fixture text, not by `serializeEnvelope`, so the byte checks are independent. (7) The fixtures under `tests/fixtures/m5-persistence/` are listed in `.prettierignore`, as the P5 and M1 fixtures are, because some are intentionally invalid JSON.

M5-U2 notes (2026-10-29, Primary decisions recorded from its review): (1) The query returns the same frozen object, not a copy: `query document` and `snapshot.document` outside a gesture, and the document recorded at the gesture's begin during one. (2) Every command, undo, redo, `loadDocument`, cut, page removal and tool or input reset cancels an active gesture (`interrupt()`) before it changes the document, so the recorded base is never stale; after a host command that cancels a gesture the query returns that command's result applied to the pre-gesture document. A failed command or an undo with empty history leaves the gesture running and the query on its base. (3) Update, `replace`, the M3 path `edit` gestures and the M2 rotate and scale gestures share the one gesture state, so one code path covers them; the tests cover a select-tool drag, an extension-tool `replace` (including a replace back to base followed by a host command, the M5-Q9 case), an anchor drag in path edit mode and the cancelling and non-cancelling commands above.

M5-U3 notes (2026-10-29, Primary decisions recorded from its reviews): (1) `fake-indexeddb` is pinned to 6.2.5 in the root `devDependencies` (M5-Q4 (a)); 6.2.6 was under two weeks old at the time. The lockfile adds only it (no dependencies) and the workspace importer. (2) Dedupe cache: a read that finds no record empties the cache; a read that finishes while a write or clear is pending leaves it alone (close to redundant under IndexedDB transaction order, kept as a guard; the test pins only the end result); the cache is consulted only when no write or clear is pending, so a write equal to the cached text is never skipped behind a different in-flight write or a clear. (3) Codes: a failed `clear` is `persistence.write-failed`; a `serializeEnvelope` throw resolves `persistence.write-failed` with no transaction and an emptied cache; a store call that throws at once is `read-failed` or `write-failed`; an `open` that throws is `persistence.unavailable`; `close()` makes later calls `persistence.unavailable`, as after `versionchange`. A write already in flight when `versionchange` arrives completes. (4) Autosave: a change counts as saved only when a write that started after it succeeds, so a throw from `envelope()`, a rejected write or a throwing `onResult` keeps it unsaved; each is caught and reported to `onResult` as `persistence.write-failed`, and no rejection escapes the timer path. A failed write with no new `schedule()` starts no timer. (5) The max-wait runs from the first unsaved `schedule()`, also one made during a write; if it runs out during a write, the next write starts when that write ends; otherwise the 500 ms trailing timer starts then. `flush` stops after any failed write, including one already in flight when it was called. (6) The default timers are the global `setTimeout` and `clearTimeout`, read at call time: ECMAScript host timers, not browser globals, so `globalThis.indexedDB` stays the package's only browser global. (7) Not handled, disclosed: a connection the browser closes on its own (`onclose`) makes later calls `read-failed` or `write-failed` rather than `unavailable`, and a database already at version 1 without the `envelopes` store fails every call the same way. (8) Extra exports beyond section 4.2: `PERSISTENCE_ERROR_CODES`, `DATABASE_VERSION`, `OBJECT_STORE_NAME`, the `DEFAULT_*` layout and timing constants, and the result and option types. (9) The `blocked` test wraps the fake factory to ask for version 2 while a connection is held, since the adapter's own version-1 open cannot be blocked.
