import type {
  Command,
  CommandResult,
  DocumentV6,
  NodeV6,
  PageV6,
  ReorderOp,
} from '@vector-studio/react';
import type { ActionButton } from './toolbar-model.js';

// MVP M8 contract, section 7.2 (M8-L2 to L4): the layer panel's pure parts, internal to the
// package and unit-tested as functions with a real editor (M8-Q3 (a)). layers.tsx renders them.

/**
 * A text field's edit: `invalid` marks the field `aria-invalid` and sends nothing; otherwise
 * `command` is sent, or nothing when it is null (the value is unchanged).
 */
export type FieldEdit = Readonly<{ invalid: boolean; command: Command | null }>;

const UNCHANGED: FieldEdit = Object.freeze({ invalid: false, command: null });
const INVALID: FieldEdit = Object.freeze({ invalid: true, command: null });

/** A name is invalid when it is empty or only white space; it is committed as typed. */
const blank = (name: string): boolean => name.trim() === '';

// ---------------------------------------------------------------------------------------------
// Pages (M8-L2)

/** One page button: test ID `page-<id>`, the page name as its label, pressed when active. */
export type PageButton = Readonly<{
  id: string;
  testId: string;
  label: string;
  pressed: boolean;
  command: Command;
}>;

/** The page buttons, one per page in document order, the active one pressed (`setActivePage`). */
export function pageButtons(pages: readonly PageV6[], active: string): readonly PageButton[] {
  return pages.map((page) => ({
    id: page.id,
    testId: `page-${page.id}`,
    label: page.name,
    pressed: page.id === active,
    command: { type: 'setActivePage', id: page.id },
  }));
}

/** The rename of a page to `name` (`renamePage`): blank is invalid, the same name sends nothing. */
export function renamePageEdit(page: PageV6, name: string): FieldEdit {
  if (blank(name)) return INVALID;
  if (name === page.name) return UNCHANGED;
  return { invalid: false, command: { type: 'renamePage', id: page.id, name } };
}

/**
 * The add and remove buttons outside the page list: `add-page` (`addPage` at the end, then the
 * new page becomes active) and `remove-page` (`removePage` of the active page, disabled while it
 * is the only page). Neither changes the selection; `runPageAction` switches pages.
 */
export function pageActions(pages: readonly PageV6[], active: string): readonly ActionButton[] {
  return [
    {
      testId: 'add-page',
      label: 'add page',
      disabled: false,
      command: { type: 'addPage' },
      selectAfter: null,
    },
    {
      testId: 'remove-page',
      label: 'remove page',
      disabled: pages.length < 2,
      command: pages.length < 2 ? null : { type: 'removePage', id: active },
      selectAfter: null,
    },
  ];
}

/**
 * Runs a page action; after a successful `addPage` it activates the new page (`setActivePage`,
 * a session command, so the add stays one undo step). Returns the command's result, or null
 * for a disabled button (nothing is sent).
 */
export function runPageAction(
  execute: (command: Command) => CommandResult,
  button: ActionButton,
): CommandResult | null {
  if (button.command === null) return null;
  const result = execute(button.command);
  if (result.ok && button.command.type === 'addPage' && result.ids[0] !== undefined) {
    execute({ type: 'setActivePage', id: result.ids[0] });
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Layer tree (M8-L3, L4)

/** One row of the layer tree. */
export type LayerRow = Readonly<{
  id: string;
  /** Test ID `layer-<id>`. */
  testId: string;
  name: string;
  type: NodeV6['type'];
  /** 0 for a child of the page, one more per container above it. */
  depth: number;
  /** A group, mask group, frame or symbol: a node with children. */
  expandable: boolean;
  /** Expanded (React state, never document or history); false for a node without children. */
  expanded: boolean;
  selected: boolean;
  visible: boolean;
}>;

const childrenOf = (node: NodeV6): readonly string[] | null =>
  'children' in node ? node.children : null;

/**
 * The rows of the active page, front first (the last child on top) and depth first: an expanded
 * container's children follow its row, also front first, one level deeper. An instance is a
 * leaf: its expansion is no document node and is not listed (M7). An unknown page gives none.
 */
export function layerRows(
  document: DocumentV6,
  activePage: string,
  expanded: ReadonlySet<string>,
  selection: readonly string[],
  cache: LayerRowCache | null = null,
): readonly LayerRow[] {
  const page = document.pages.find((entry) => entry.id === activePage);
  if (page === undefined) return [];
  const selected = new Set(selection);
  const rows: LayerRow[] = [];
  const next: LayerRowCache['entries'] = new Map();
  const visit = (ids: readonly string[], depth: number) => {
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const node = document.nodes[ids[index]!];
      if (node === undefined) continue;
      const children = childrenOf(node);
      const open = children !== null && expanded.has(node.id);
      const isSelected = selected.has(node.id);
      const previous = cache?.entries.get(node.id);
      const row =
        previous !== undefined &&
        previous.node === node &&
        previous.row.depth === depth &&
        previous.row.expanded === open &&
        previous.row.selected === isSelected
          ? previous.row
          : {
              id: node.id,
              testId: `layer-${node.id}`,
              name: node.name,
              type: node.type,
              depth,
              expandable: children !== null,
              expanded: open,
              selected: isSelected,
              visible: node.visible,
            };
      if (cache !== null) next.set(node.id, { node, row });
      rows.push(row);
      if (open) visit(children, depth + 1);
    }
  };
  visit(page.children, 0);
  if (cache !== null) cache.entries = next;
  return rows;
}

/**
 * V-20 contract, lever L2: the rows of the last `layerRows` call that used this cache. A row whose
 * node object, depth, expanded and selected state are unchanged is returned as the same object,
 * so a memoized row component skips its render. The walk itself runs on every call.
 */
export type LayerRowCache = { entries: Map<string, Readonly<{ node: NodeV6; row: LayerRow }>> };

/** An empty row cache, one per layer tree. */
export function createLayerRowCache(): LayerRowCache {
  return { entries: new Map() };
}

// ---------------------------------------------------------------------------------------------
// The windowed list (V-20 contract, lever L3 and section 4)

/** Rows mounted before the row height is measured, and when there is no layout. */
export const UNMEASURED_ROWS = 32;
/** Rows mounted beyond each edge of the list's viewport. */
export const OVERSCAN_ROWS = 8;

/**
 * The half-open range `[start, end)` of row indexes the list mounts: the rows that intersect the
 * viewport `[scrollTop, scrollTop + viewportHeight)` plus `OVERSCAN_ROWS` on each side, clamped to
 * the rows. Before a measurement (`rowHeight` null or not positive) the first `UNMEASURED_ROWS`.
 * Pinned rows (an open rename, the focused row) are mounted besides this range.
 */
export function windowRange(
  count: number,
  rowHeight: number | null,
  scrollTop: number,
  viewportHeight: number,
): Readonly<{ start: number; end: number }> {
  if (rowHeight === null || !(rowHeight > 0)) {
    return { start: 0, end: Math.min(count, UNMEASURED_ROWS) };
  }
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight);
  return {
    start: Math.max(0, Math.min(count, first - OVERSCAN_ROWS)),
    end: Math.max(0, Math.min(count, last + OVERSCAN_ROWS)),
  };
}

/** The expanded set after the row's expand or collapse toggle (React state). */
export function toggleExpanded(expanded: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(expanded);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * A row click (M8-L3): selects the row alone (`setSelection [id]`); with Shift or Mod (Ctrl or
 * Meta, as the canvas reads them) it toggles the row in the selection, keeping the others in
 * order and appending a newly added row.
 */
export function rowClickCommand(
  selection: readonly string[],
  id: string,
  toggle: boolean,
): Command {
  if (!toggle) return { type: 'setSelection', ids: [id] };
  return {
    type: 'setSelection',
    ids: selection.includes(id) ? selection.filter((other) => other !== id) : [...selection, id],
  };
}

/** The row's visibility toggle (M8-L4): `setNodeProps visible` with the opposite value. */
export function visibilityCommand(row: LayerRow): Command {
  return { type: 'setNodeProps', id: row.id, props: { visible: !row.visible } };
}

/** The rename of a row's node (`setNodeProps name`): blank is invalid, the same name sends nothing. */
export function renameNodeEdit(row: LayerRow, name: string): FieldEdit {
  if (blank(name)) return INVALID;
  if (name === row.name) return UNCHANGED;
  return { invalid: false, command: { type: 'setNodeProps', id: row.id, props: { name } } };
}

const REORDER: readonly (readonly [ReorderOp, string])[] = [
  ['forward', 'forward'],
  ['backward', 'backward'],
  ['front', 'front'],
  ['back', 'back'],
];

/**
 * The reorder buttons on the selection (M8-L4, M8-Q7 (a)): `reorder-forward`, `reorder-backward`,
 * `reorder-front` and `reorder-back`, each one `reorderNodes`, disabled with no selection. A
 * reorder that moves nothing records no step (editor-core).
 */
export function reorderActions(selection: readonly string[]): readonly ActionButton[] {
  return REORDER.map(([op, label]) => ({
    testId: `reorder-${op}`,
    label,
    disabled: selection.length === 0,
    command: selection.length === 0 ? null : { type: 'reorderNodes', ids: selection, op },
    selectAfter: null,
  }));
}
