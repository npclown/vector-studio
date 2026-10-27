import type { Command, CommandResult, Editor, EditorSnapshot } from '@vector-studio/editor-core';
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

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
 * A value derived from the editor snapshot, re-read after every editor event. The snapshot and
 * everything in it are immutable values replaced on change, so a selector that returns a part
 * of it (or a primitive) is stable between changes, as `useSyncExternalStore` requires.
 */
export function useEditorSelector<T>(selector: (snapshot: EditorSnapshot) => T): T {
  const editor = useEditor();
  const subscribe = useCallback(
    (onChange: () => void) => editor.subscribe(() => onChange()),
    [editor],
  );
  const read = () => selector(editor.getSnapshot());
  return useSyncExternalStore(subscribe, read, read);
}

/** The editor's `execute`, stable for the editor's lifetime. */
export function useEditorCommands(): (command: Command) => CommandResult {
  const editor = useEditor();
  return useCallback((command: Command) => editor.execute(command), [editor]);
}
