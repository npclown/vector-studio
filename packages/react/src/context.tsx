import type {
  Command,
  CommandResult,
  Editor,
  EditorSnapshot,
  Query,
  QueryResult,
} from '@vector-studio/editor-core';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { createQueryStore, createSelectorStore, createStoreMemo, type StoreMemo } from './store.js';

// P5-U6 (P5 plan, section 6): React bindings over the editor's public API. The host creates the
// editor; these components never create, mutate or reach into one.

const EditorContext = createContext<Editor | null>(null);

export type EditorProviderProps = Readonly<{ editor: Editor; children?: ReactNode }>;

/** Makes a host-created editor available to the hooks below. */
export function EditorProvider({ editor, children }: EditorProviderProps) {
  return <EditorContext.Provider value={editor}>{children}</EditorContext.Provider>;
}

/** The editor of the nearest `EditorProvider`; throws outside one. */
export function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (editor === null) throw new Error('useEditor: no EditorProvider above this component');
  return editor;
}

/**
 * A value derived from the editor snapshot, re-read after every editor event (MVP M8 contract,
 * M8-H2). The selector runs again only when the snapshot object changes (the snapshot and
 * everything in it are immutable values replaced on change); while `isEqual(previous, next)`
 * holds, the previous result is returned, so a selector that builds a fresh array or object can
 * pass a structural `isEqual` and stay stable between changes. `isEqual` defaults to
 * `Object.is`: a selector that returns a part of the snapshot or a primitive is stable as is.
 *
 * The selector must be pure, a function of the snapshot alone: it runs once per snapshot
 * object, so a selector that reads `editor.query` (or any other state) goes stale on events that
 * keep the snapshot, such as a `textLayout` session event. Use `useEditorQuery` for queries.
 *
 * @param selector Derives the value from the snapshot alone; it must be pure.
 * @param isEqual Whether the previous and the next result are equal; true keeps the previous.
 */
export function useEditorSelector<T>(
  selector: (snapshot: EditorSnapshot) => T,
  isEqual?: (previous: T, next: T) => boolean,
): T {
  const editor = useEditor();
  const memo = useStoreMemo<T>(editor);
  const store = useMemo(
    () => createSelectorStore(editor, selector, isEqual, memo),
    [editor, selector, isEqual, memo],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/**
 * The result of `editor.query(query)`, re-read after every editor event, including events that
 * do not replace the snapshot such as a `textLayout` session event (MVP M8 contract, M8-H3).
 * While `isEqual(previous, next)` holds the previous result is returned. The default equality is
 * structural for the `handles`, `pathOverlay`, `textEditOverlay`, `snap` and `extensions`
 * queries, whose results are rebuilt on each read, and `Object.is` for every other query (a
 * structural compare of a document-sized result would cost as much as the change).
 *
 * @param query The query to read; a new object with the same fields reads the same query.
 * @param isEqual Whether the previous and the next result are equal; true keeps the previous.
 */
export function useEditorQuery<Q extends Query>(
  query: Q,
  isEqual?: (previous: QueryResult<Q>, next: QueryResult<Q>) => boolean,
): QueryResult<Q> {
  const editor = useEditor();
  const memo = useStoreMemo<QueryResult<Q>>(editor);
  // Queries are small JSON objects, usually written inline: the store follows their content.
  const key = JSON.stringify(query);
  const store = useMemo(
    () => createQueryStore(editor, query, isEqual, memo),
    // `query` is read through `key`: a new object with the same content keeps the store.
    [editor, key, isEqual, memo],
  );
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** The memo of one hook call, replaced when the editor changes. */
function useStoreMemo<T>(editor: Editor): StoreMemo<T> {
  const ref = useRef<{ editor: Editor; memo: StoreMemo<T> } | null>(null);
  if (ref.current === null || ref.current.editor !== editor) {
    ref.current = { editor, memo: createStoreMemo<T>() };
  }
  return ref.current.memo;
}

/** The editor's `execute`, stable for the editor's lifetime. */
export function useEditorCommands(): (command: Command) => CommandResult {
  const editor = useEditor();
  return useCallback((command: Command) => editor.execute(command), [editor]);
}
