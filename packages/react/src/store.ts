import type {
  Editor,
  EditorSnapshot,
  HistoryState,
  NodeV8,
  PageV8,
  Query,
  QueryResult,
  RenderCamera,
  ToolId,
} from '@vector-studio/editor-core';

// MVP M8 contract, M8-H2 to M8-H4: the internal store adapters under the hooks. Each adapter is
// a `subscribe` and `getSnapshot` pair for `useSyncExternalStore`, built over the editor's
// public `subscribe`, `getSnapshot` and `query` only. This module is not part of the package
// entry; `tests/unit/m8-u2-react-api.test.ts` drives it directly with a real editor.

/** Whether two values are equal for a hook: true keeps the previous value. */
export type IsEqual<T> = (previous: T, next: T) => boolean;

/** A `subscribe` and `getSnapshot` pair for `useSyncExternalStore`. */
export type EditorStore<T> = Readonly<{
  /** Calls `onChange` after each editor event; the returned function unsubscribes. */
  subscribe: (onChange: () => void) => () => void;
  /** The current value, the same reference while it is equal to the previous one. */
  getSnapshot: () => T;
}>;

/**
 * The last value a hook returned, shared by the stores a hook builds across renders (a new
 * inline selector or query object builds a new store), so equality is judged against the value
 * the component last saw. `owner` is the store that wrote `value`: a store takes its no-reread
 * fast path only for a value it wrote itself, since another store's value (a different selector
 * or query, for example from a discarded render) is not its result.
 */
export type StoreMemo<T> = { has: boolean; value: T | undefined; owner: object | null };

/** A memo that holds no value yet. */
export function createStoreMemo<T>(): StoreMemo<T> {
  return { has: false, value: undefined, owner: null };
}

/**
 * Per editor: a counter of the events it raised, and the one `subscribe` every store of that
 * editor shares, so a store rebuilt on each render never makes React resubscribe.
 */
type EditorChannel = { version: number; subscribe: (onChange: () => void) => () => void };

const channels = new WeakMap<Editor, EditorChannel>();

function channelOf(editor: Editor): EditorChannel {
  let channel = channels.get(editor);
  if (channel === undefined) {
    const created: EditorChannel = {
      version: 0,
      // The counter is bumped before `onChange` too, so a listener added before the permanent
      // one below still sees the new version when React reads the store from `onChange`.
      subscribe: (onChange) =>
        editor.subscribe(() => {
          created.version += 1;
          onChange();
        }),
    };
    // One permanent listener for the editor's lifetime counts events raised while no component
    // is subscribed (between a render and its subscription). It holds only the counter.
    editor.subscribe(() => {
      created.version += 1;
    });
    channels.set(editor, created);
    channel = created;
  }
  return channel;
}

/**
 * Keeps `memo`'s value when `isEqual` holds, else stores `next`; either way `owner` becomes the
 * memo's owner. Returns the kept value.
 */
function keep<T>(memo: StoreMemo<T>, next: T, isEqual: IsEqual<T>, owner: object): T {
  if (!memo.has || !isEqual(memo.value as T, next)) {
    memo.value = next;
    memo.has = true;
  }
  memo.owner = owner;
  return memo.value as T;
}

/**
 * A store of `selector(editor.getSnapshot())` (M8-H2). The selector runs only when the snapshot
 * object differs from the one it last ran on, or when another store sharing `memo` wrote it
 * since; while `isEqual(previous, next)` holds (default
 * `Object.is`) the previous result is kept.
 */
export function createSelectorStore<T>(
  editor: Editor,
  selector: (snapshot: EditorSnapshot) => T,
  isEqual: IsEqual<T> = Object.is,
  memo: StoreMemo<T> = createStoreMemo<T>(),
): EditorStore<T> {
  const channel = channelOf(editor);
  const token = {};
  let seen: EditorSnapshot | null = null;
  return {
    subscribe: channel.subscribe,
    getSnapshot: () => {
      const snapshot = editor.getSnapshot();
      if (seen === snapshot && memo.has && memo.owner === token) return memo.value as T;
      const next = selector(snapshot);
      seen = snapshot;
      return keep(memo, next, isEqual, token);
    },
  };
}

/**
 * The queries whose default equality is structural (M8-H3): their results are rebuilt on each
 * read. Every other query returns a stored value, compared by `Object.is`, since a structural
 * compare of a document-sized result costs as much as the change.
 */
export const STRUCTURAL_QUERIES: ReadonlySet<Query['type']> = new Set<Query['type']>([
  'handles',
  'pathOverlay',
  'textEditOverlay',
  'snap',
  'extensions',
]);

/**
 * Structural equality of JSON-like values: primitives by `Object.is`, arrays by length and
 * element, plain objects by their own enumerable keys and values.
 */
export function structuralEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => structuralEqual(value, b[index]));
  }
  if (Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  return aKeys.every(
    (key) => Object.hasOwn(bRecord, key) && structuralEqual(aRecord[key], bRecord[key]),
  );
}

/** The default equality of `query` (M8-H3): structural for the five listed queries. */
export function defaultQueryEquality<Q extends Query>(query: Q): IsEqual<QueryResult<Q>> {
  return STRUCTURAL_QUERIES.has(query.type) ? structuralEqual : Object.is;
}

/**
 * A store of `editor.query(query)` (M8-H3). The query is re-read after each editor event (a
 * `textLayout` session event too, which does not replace the snapshot), and the previous result
 * is kept while `isEqual(previous, next)` holds (default `defaultQueryEquality(query)`).
 */
export function createQueryStore<Q extends Query>(
  editor: Editor,
  query: Q,
  isEqual: IsEqual<QueryResult<Q>> = defaultQueryEquality(query),
  memo: StoreMemo<QueryResult<Q>> = createStoreMemo<QueryResult<Q>>(),
): EditorStore<QueryResult<Q>> {
  const channel = channelOf(editor);
  const token = {};
  let read = -1;
  return {
    subscribe: channel.subscribe,
    getSnapshot: () => {
      if (read === channel.version && memo.has && memo.owner === token) {
        return memo.value as QueryResult<Q>;
      }
      const next = editor.query(query);
      read = channel.version;
      return keep(memo, next, isEqual, token);
    },
  };
}

/**
 * The selectors of the named hooks (M8-H1), each returning one part of the snapshot, so its
 * result keeps its reference between changes of that part.
 */
export const snapshotSelectors = Object.freeze({
  selection: (snapshot: EditorSnapshot): readonly string[] => snapshot.selection,
  activePage: (snapshot: EditorSnapshot): string => snapshot.activePage,
  pages: (snapshot: EditorSnapshot): readonly PageV8[] => snapshot.document.pages,
  tool: (snapshot: EditorSnapshot): ToolId => snapshot.tool,
  history: (snapshot: EditorSnapshot): HistoryState => snapshot.history,
  snapping: (snapshot: EditorSnapshot): boolean => snapshot.snapping,
  viewport: (snapshot: EditorSnapshot): RenderCamera => snapshot.viewport,
  scope: (snapshot: EditorSnapshot): string | null => snapshot.scope,
});

/**
 * The equality of `useHistory` (M8-H1): equal undo and redo depths. The editor builds a new
 * `history` object with every snapshot, so `Object.is` would change it on every event; with this
 * equality the hook keeps the first object of each pair of depths.
 */
export function historyEqual(previous: HistoryState, next: HistoryState): boolean {
  return previous.undoDepth === next.undoDepth && previous.redoDepth === next.redoDepth;
}

/**
 * The selector of `useNode(id)` (M8-H1): `snapshot.document.nodes[id]`, or null when the
 * document has no own node `id` (so `constructor` is null too).
 */
export function nodeSelector(id: string): (snapshot: EditorSnapshot) => NodeV8 | null {
  return (snapshot) =>
    Object.hasOwn(snapshot.document.nodes, id) ? (snapshot.document.nodes[id] ?? null) : null;
}
