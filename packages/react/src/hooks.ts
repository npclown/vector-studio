import type {
  HistoryState,
  NodeV7,
  PageV7,
  RenderCamera,
  ToolId,
} from '@vector-studio/editor-core';
import { useMemo } from 'react';
import { useEditorSelector } from './context.js';
import { historyEqual, nodeSelector, snapshotSelectors as select } from './store.js';

// MVP M8 contract, M8-H1: named hooks, each a `useEditorSelector` over one part of the snapshot
// (the selectors are in store.ts, where the unit tests drive them through the store adapter).
// The snapshot's parts are immutable values replaced on change, so each result keeps its
// reference between changes of that part.

/** The selected node IDs, `snapshot.selection` (MVP M8 contract, M8-H1). */
export function useSelection(): readonly string[] {
  return useEditorSelector(select.selection);
}

/** The ID of the active page, `snapshot.activePage` (MVP M8 contract, M8-H1). */
export function useActivePage(): string {
  return useEditorSelector(select.activePage);
}

/** The document's pages in order, `snapshot.document.pages` (MVP M8 contract, M8-H1). */
export function usePages(): readonly PageV7[] {
  return useEditorSelector(select.pages);
}

/** The active tool, `snapshot.tool` (MVP M8 contract, M8-H1). */
export function useTool(): ToolId {
  return useEditorSelector(select.tool);
}

/**
 * The undo and redo depths, `snapshot.history` (MVP M8 contract, M8-H1). The editor rebuilds
 * that object with every snapshot, so the hook keeps the previous one while both depths are
 * equal: the result is stable between history changes, as the other hooks' are.
 */
export function useHistory(): HistoryState {
  return useEditorSelector(select.history, historyEqual);
}

/** Whether snapping is on, `snapshot.snapping` (MVP M8 contract, M8-H1). */
export function useSnapping(): boolean {
  return useEditorSelector(select.snapping);
}

/** The viewport camera, `snapshot.viewport` (MVP M8 contract, M8-H1). */
export function useViewport(): RenderCamera {
  return useEditorSelector(select.viewport);
}

/** The entered container of the active page, or null, `snapshot.scope` (M8-H1). */
export function useScope(): string | null {
  return useEditorSelector(select.scope);
}

/**
 * The document node `id`, `snapshot.document.nodes[id]`, or null when the document has no node
 * with that ID (MVP M8 contract, M8-H1). Only the document's own keys are read, so an ID such as
 * `constructor` is null too.
 *
 * @param id The node ID.
 */
export function useNode(id: string): NodeV7 | null {
  return useEditorSelector(useMemo(() => nodeSelector(id), [id]));
}
