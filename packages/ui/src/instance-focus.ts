import { useEffect, useSyncExternalStore } from 'react';
import {
  useEditor,
  type DocumentV8,
  type Editor,
  type NodeV8,
  type PagePoint,
} from '@vector-studio/react';

// V-37 contract, section 6.3 (U4): the focused layer of an instance. The focus is UI state, not
// editor state: one store per editor, set by a double-click on the canvas (or a row of the
// property panel's Layers list) and cleared when the selection changes, on Escape, and when the
// layer leaves the source. Selection, scope and history are never touched.

/** The focused source layer of one instance. */
export type InstanceFocus = Readonly<{
  /** The instance the panel targets. Under a selected group it is an instance inside it. */
  instance: string;
  /** The source node ID of the focused layer (the source's own ID for its background). */
  layer: string;
  /** The selection the focus was made under; a different selection clears it. */
  selection: readonly string[];
}>;

const nodeAt = (document: DocumentV8, id: string): NodeV8 | undefined =>
  Object.hasOwn(document.nodes, id) ? document.nodes[id] : undefined;

/** The source ID of instance `id` (a symbol), or null when `id` is no instance of a symbol. */
export function sourceOf(document: DocumentV8, id: string): string | null {
  const node = nodeAt(document, id);
  if (node?.type !== 'instance') return null;
  return nodeAt(document, node.symbol)?.type === 'symbol' ? node.symbol : null;
}

/** Whether `layer` is the source of instance `instance` or inside its subtree. */
export function layerInSource(document: DocumentV8, instance: string, layer: string): boolean {
  const source = sourceOf(document, instance);
  if (source === null) return false;
  let at = nodeAt(document, layer);
  // The depth is bounded (M1-S3); the loop ends at the page, whose ID names no node.
  for (let steps = 0; at !== undefined && steps < 1024; steps += 1) {
    if (at.id === source) return true;
    at = nodeAt(document, at.parent);
  }
  return false;
}

/** Whether a selected group's subtree holds an instance, listed front first, depth first. */
function instancesUnder(document: DocumentV8, group: string): readonly string[] {
  const found: string[] = [];
  const visit = (id: string) => {
    const node = nodeAt(document, id);
    if (node === undefined || !node.visible) return;
    if (node.type === 'instance') found.push(id);
    else if (node.type === 'group' || node.type === 'maskGroup' || node.type === 'frame') {
      for (let i = node.children.length - 1; i >= 0; i -= 1) visit(node.children[i]!);
    }
  };
  visit(group);
  return found;
}

/**
 * Section 6.3: the instance and layer a double-click at a point focuses. With one selected
 * instance, its layer under the point; with one selected group, the layer of the innermost
 * instance under the point (the front-most instance of its subtree the point hits). `layerAt`
 * is the `instanceLayerAt` query. Null when the selection is neither or nothing is hit.
 */
export function resolveFocus(
  document: DocumentV8,
  selection: readonly string[],
  layerAt: (instance: string) => string | null,
): Readonly<{ instance: string; layer: string }> | null {
  if (selection.length !== 1) return null;
  const selected = nodeAt(document, selection[0]!);
  if (selected === undefined) return null;
  const candidates =
    selected.type === 'instance'
      ? [selected.id]
      : selected.type === 'group' || selected.type === 'maskGroup'
        ? instancesUnder(document, selected.id)
        : [];
  for (const instance of candidates) {
    const layer = layerAt(instance);
    if (layer !== null) return { instance, layer };
  }
  return null;
}

/**
 * The instance the panel shows its instance sections for: the focused one while the focus stands
 * (so a selected group shows the instance under the point), else the one selected instance.
 */
export function targetInstance(
  document: DocumentV8,
  selection: readonly string[],
  focus: InstanceFocus | null,
): string | null {
  if (focus !== null && sameSelection(focus.selection, selection)) return focus.instance;
  if (selection.length !== 1) return null;
  return nodeAt(document, selection[0]!)?.type === 'instance' ? selection[0]! : null;
}

const sameSelection = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

class FocusStore {
  private focus: InstanceFocus | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly editor: Editor) {
    editor.subscribe(() => this.check());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly get = (): InstanceFocus | null => this.focus;

  set(focus: InstanceFocus | null): void {
    if (focus === this.focus) return;
    this.focus = focus;
    for (const listener of [...this.listeners]) listener();
  }

  /** Drops the focus when the selection changed or the layer left the source. */
  private check(): void {
    const focus = this.focus;
    if (focus === null) return;
    const snapshot = this.editor.getSnapshot();
    if (
      !sameSelection(focus.selection, snapshot.selection) ||
      !layerInSource(snapshot.document, focus.instance, focus.layer)
    ) {
      this.set(null);
    }
  }
}

const stores = new WeakMap<Editor, FocusStore>();

function storeOf(editor: Editor): FocusStore {
  let store = stores.get(editor);
  if (store === undefined) {
    store = new FocusStore(editor);
    stores.set(editor, store);
  }
  return store;
}

/**
 * Section 6.3: focuses the layer under `point` after a double-click (call it once the editor
 * handled the input, `EditorCanvas`'s `onCanvasDoubleClick`). Returns whether a layer is focused;
 * a miss clears the focus.
 */
export function focusInstanceAt(editor: Editor, point: PagePoint): boolean {
  const { document, selection } = editor.getSnapshot();
  const found = resolveFocus(document, selection, (id) =>
    editor.query({ type: 'instanceLayerAt', id, point }),
  );
  storeOf(editor).set(found === null ? null : { ...found, selection });
  return found !== null;
}

/** Focuses `layer` of `instance` under the current selection (a row of the Layers list). */
export function setInstanceFocus(editor: Editor, instance: string, layer: string): void {
  storeOf(editor).set({ instance, layer, selection: editor.getSnapshot().selection });
}

/** The current focus of `editor`, or null (for hosts and tests that read it without a hook). */
export function getInstanceFocus(editor: Editor): InstanceFocus | null {
  return storeOf(editor).get();
}

/** Clears the focus. */
export function clearInstanceFocus(editor: Editor): void {
  storeOf(editor).set(null);
}

/** The focus of the nearest editor, or null; Escape clears it while it stands. */
export function useInstanceFocus(): InstanceFocus | null {
  const editor = useEditor();
  const store = storeOf(editor);
  const focus = useSyncExternalStore(store.subscribe, store.get, store.get);
  const active = focus !== null;
  useEffect(() => {
    if (!active) return;
    const onKey = focusKeyListener(editor);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, editor]);
  return focus;
}

/** Whether a key event's target is a text field, select or textarea. */
function isField(target: EventTarget | null): boolean {
  const tag = (target as { tagName?: unknown } | null)?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

/**
 * The window `keydown` listener of a standing focus: the first Escape clears only the focus. It
 * is consumed in the capture phase, before the canvas's keymap (exit scope, clear selection)
 * sees it; a text field, select or textarea keeps its own Escape.
 */
export function focusKeyListener(editor: Editor): (event: KeyboardEvent) => void {
  const store = storeOf(editor);
  return (event) => {
    if (event.key !== 'Escape' || isField(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    store.set(null);
  };
}
