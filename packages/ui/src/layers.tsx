import {
  useActivePage,
  useEditorCommands,
  useEditorSelector,
  usePages,
  useSelection,
  type Command,
  type CommandResult,
  type EditorSnapshot,
} from '@vector-studio/react';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import {
  createLayerRowCache,
  layerRows,
  mountedIndexes,
  windowRange,
  type LayerRow,
  pageActions,
  pageButtons,
  renameNodeEdit,
  renamePageEdit,
  reorderActions,
  rowClickCommand,
  runPageAction,
  toggleExpanded,
  visibilityCommand,
  type FieldEdit,
} from './layer-model.js';
import { countRender } from './render-probe.js';
import { runAction, type ActionButton } from './toolbar-model.js';

// MVP M8 contract, section 7.2 (M8-L2 to L4, M8-Q7 (a)): the page list and the layer tree. Each
// control commits through one public command, so a document edit is one undo step; an invalid
// name sends nothing and marks its textbox `aria-invalid`; a refused command shows its code.

const ROW = { display: 'flex', gap: 8 } as const;
// next-host's `Pages` nav at 17a2b0a had this padding; it now pads the whole page list.
const PAGES = { display: 'flex', gap: 8, padding: '0 8px' } as const;
// A rename textbox no wider than a typical page button, so row 2 keeps its width budget, in the
// browser's control font like the buttons around it, so row 2 keeps its height (M8-N3; M8-U6).
const NAME_INPUT = { width: '8em' } as const;
// M8-N3: the layer tree has a fixed height of 240 px by default; its list scrolls.
const TREE_HEIGHT = 240;
const LIST = { flex: 1, minHeight: 0, overflowY: 'auto', margin: 0, padding: 0 } as const;
const LIST_ROWS = { margin: 0, padding: 0 } as const;
const INDENT = 12;

const documentOf = (snapshot: EditorSnapshot) => snapshot.document;

/** Shows the code of the last refused command until the next command succeeds. */
function useRefusal(): [string | null, (result: CommandResult | null) => void] {
  const [refusal, setRefusal] = useState<string | null>(null);
  return [refusal, (result) => setRefusal(result !== null && !result.ok ? result.code : null)];
}

type Draft = Readonly<{ id: string; value: string; invalid: boolean }>;

/**
 * A rename textbox's state: `start` opens it on a target, `commit` (Enter or blur) applies the
 * edit once, `cancel` (Escape) closes it without sending.
 */
function useRename(
  edit: (id: string, value: string) => FieldEdit,
  send: (command: Command) => void,
) {
  const [draft, setDraft] = useState<Draft | null>(null);
  // Enter closes the textbox, and the browser may then blur it: commit only once per opening.
  const open = useRef<string | null>(null);
  return {
    draft,
    start: (id: string, value: string) => {
      open.current = id;
      setDraft({ id, value, invalid: false });
    },
    change: (value: string) => {
      setDraft((current) => (current === null ? null : { ...current, value, invalid: false }));
    },
    commit: () => {
      if (draft === null || open.current !== draft.id) return;
      const result = edit(draft.id, draft.value);
      if (result.invalid) {
        setDraft({ ...draft, invalid: true });
        return;
      }
      open.current = null;
      setDraft(null);
      if (result.command !== null) send(result.command);
    },
    cancel: () => {
      open.current = null;
      setDraft(null);
    },
  };
}

function NameInput({
  label,
  draft,
  onChange,
  onCommit,
  onCancel,
}: Readonly<{
  label: string;
  draft: Draft;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}>) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') onCommit();
    else if (event.key === 'Escape') onCancel();
  };
  return (
    <input
      type="text"
      aria-label={label}
      aria-invalid={draft.invalid}
      // A double-click opened it to type in.
      autoFocus
      value={draft.value}
      style={NAME_INPUT}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onCommit}
    />
  );
}

function Actions({
  buttons,
  onRun,
}: Readonly<{ buttons: readonly ActionButton[]; onRun: (button: ActionButton) => void }>) {
  return buttons.map((button) => (
    <button
      key={button.testId}
      type="button"
      data-testid={button.testId}
      disabled={button.disabled}
      onClick={() => onRun(button)}
    >
      {button.label}
    </button>
  ));
}

/**
 * The page list (MVP M8 contract, M8-L2): exactly one button per page, in order, inside one
 * element (`data-testid="pages"`), the active one pressed (`setActivePage`); a double-click
 * replaces that page's button with a rename textbox (`renamePage` on Enter or blur, Escape
 * cancels). The add and remove buttons (`add-page`, `remove-page`) sit outside that element;
 * a refused command shows its code (`pages-refusal`).
 */
export function PageList() {
  const execute = useEditorCommands();
  const pages = usePages();
  const active = useActivePage();
  const [refusal, show] = useRefusal();
  const rename = useRename(
    (id, value) => {
      const page = pages.find((entry) => entry.id === id);
      return page === undefined ? { invalid: false, command: null } : renamePageEdit(page, value);
    },
    (command) => show(execute(command)),
  );
  const { draft } = rename;
  return (
    <div role="group" aria-label="pages" style={PAGES}>
      <nav data-testid="pages" style={ROW}>
        {pageButtons(pages, active).map((button) =>
          draft !== null && draft.id === button.id ? (
            <NameInput
              key={button.testId}
              label="page name"
              draft={draft}
              onChange={rename.change}
              onCommit={rename.commit}
              onCancel={rename.cancel}
            />
          ) : (
            <button
              key={button.testId}
              type="button"
              data-testid={button.testId}
              aria-pressed={button.pressed}
              onClick={() => show(execute(button.command))}
              onDoubleClick={() => rename.start(button.id, button.label)}
            >
              {button.label}
            </button>
          ),
        )}
      </nav>
      <Actions
        buttons={pageActions(pages, active)}
        onRun={(button) => show(runPageAction(execute, button))}
      />
      {refusal === null ? null : (
        <output role="status" data-testid="pages-refusal">
          {refusal}
        </output>
      )}
    </div>
  );
}

/** Props of `LayerTree` (V-25). */
export type LayerTreeProps = Readonly<{
  /** The tree's CSS height: 240 px by default (M8-N3), or e.g. `'100%'` to fill its parent. */
  height?: number | string;
}>;

/** Shift or Mod (Ctrl or Meta), as the canvas reads them, toggles a row in the selection. */
const toggles = (event: MouseEvent) => event.shiftKey || event.ctrlKey || event.metaKey;

/** What a row's controls call; one stable object per tree, reading the latest state from refs. */
type RowActions = Readonly<{
  toggle: (id: string) => void;
  click: (id: string, event: MouseEvent) => void;
  startRename: (id: string, name: string) => void;
  toggleVisible: (row: LayerRow) => void;
  renameChange: (value: string) => void;
  renameCommit: () => void;
  renameCancel: () => void;
}>;

type RowProps = Readonly<{
  row: LayerRow;
  /** 0-based position in the list; `aria-posinset` is one more. */
  index: number;
  count: number;
  /** The measured row height, or null before the measurement (rows in normal flow). */
  height: number | null;
  /** The rename draft when it names this row, otherwise null. */
  draft: Draft | null;
  actions: RowActions;
}>;

/**
 * One row (V-20 contract, lever L2): memoized, so it renders only when its row object (reused by
 * the row cache while its node, depth, expansion and selection are unchanged), its position, the
 * row count, the measured height or its own rename draft change. Its handlers are stable.
 */
const LayerRowItem = memo(function LayerRowItem({
  row,
  index,
  count,
  height,
  draft,
  actions,
}: RowProps) {
  countRender('layer-row');
  const placed =
    height === null
      ? null
      : ({ position: 'absolute', top: index * height, left: 0, right: 0, height } as const);
  return (
    <li
      data-testid={row.testId}
      data-depth={row.depth}
      data-selected={row.selected}
      data-index={index}
      aria-setsize={count}
      aria-posinset={index + 1}
      style={{
        ...ROW,
        ...placed,
        boxSizing: 'border-box',
        listStyle: 'none',
        paddingLeft: row.depth * INDENT,
        opacity: row.visible ? 1 : 0.5,
      }}
    >
      {row.expandable ? (
        <button
          type="button"
          data-testid={`layer-toggle-${row.id}`}
          aria-expanded={row.expanded}
          aria-label={row.expanded ? 'collapse' : 'expand'}
          onClick={() => actions.toggle(row.id)}
        >
          {row.expanded ? '▾' : '▸'}
        </button>
      ) : null}
      {draft !== null ? (
        <NameInput
          label="layer name"
          draft={draft}
          onChange={actions.renameChange}
          onCommit={actions.renameCommit}
          onCancel={actions.renameCancel}
        />
      ) : (
        <button
          type="button"
          data-testid={`layer-name-${row.id}`}
          aria-pressed={row.selected}
          onClick={(event) => actions.click(row.id, event)}
          onDoubleClick={() => actions.startRename(row.id, row.name)}
        >
          {row.name}
        </button>
      )}
      <span>{row.type}</span>
      <button
        type="button"
        data-testid={`layer-visible-${row.id}`}
        onClick={() => actions.toggleVisible(row)}
      >
        {row.visible ? 'hide' : 'show'}
      </button>
    </li>
  );
});

/** The index of the row that contains `target`, from its `data-index`, or null. */
function rowIndexOf(target: EventTarget | null): number | null {
  if (!(target instanceof Element)) return null;
  const item = target.closest('li[data-index]');
  if (item === null) return null;
  const index = Number(item.getAttribute('data-index'));
  return Number.isInteger(index) ? index : null;
}

/**
 * The layer tree (MVP M8 contract, M8-L3 and L4; fixed height 240 px, M8-N3): the active page's
 * nodes front first, indented by depth, each row (`layer-<id>`) with its name and type. A
 * container's caret (`layer-toggle-<id>`) expands or collapses it (React state); an instance's
 * expansion is not listed. Clicking a name selects the node (`setSelection [id]`), with Shift or
 * Mod it toggles it; selected rows are marked (`data-selected`, a pressed name). A double-click
 * renames (`setNodeProps name` on Enter or blur), `layer-visible-<id>` hides or shows the node
 * (`setNodeProps visible`), and the forward, backward, front and back buttons reorder the
 * selection (`reorderNodes`). A refused command shows its code (`layers-refusal`).
 *
 * V-20 contract (levers L2 and L3, section 4): the list is windowed. Every row has one height,
 * measured once from the first mounted row; rows sit at index × height inside a list of
 * count × height, so the scroll range is that of every row. Only the rows in the viewport plus
 * `OVERSCAN_ROWS` on each side are mounted, with the first and last rows, the row of an open
 * rename and the focused row (and its neighbours, so Tab and Shift+Tab always find the next
 * row). Before the measurement, and in `renderToString`, the first `UNMEASURED_ROWS` rows are
 * mounted in normal flow.
 *
 * V-25: `height` sets the tree's height (default 240 px, M8-N3); a host that sizes the tree
 * itself passes `'100%'` and gives the parent a definite height.
 */
export function LayerTree({ height = TREE_HEIGHT }: LayerTreeProps = {}) {
  countRender('layers');
  const execute = useEditorCommands();
  const document = useEditorSelector(documentOf);
  const active = useActivePage();
  const selection = useSelection();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [refusal, show] = useRefusal();
  const [cache] = useState(createLayerRowCache);
  const rows = useMemo(
    () => layerRows(document, active, expanded, selection, cache),
    [document, active, expanded, selection, cache],
  );
  const rename = useRename(
    (id, value) => {
      const row = rows.find((entry) => entry.id === id);
      return row === undefined ? { invalid: false, command: null } : renameNodeEdit(row, value);
    },
    (command) => show(execute(command)),
  );
  const { draft } = rename;

  // The latest values for the stable row actions.
  // Assigned after commit, so a render React discards never leaves its values here.
  const latest = useRef({ execute, selection, show, rename });
  useLayoutEffect(() => {
    latest.current = { execute, selection, show, rename };
  });
  const [actions] = useState<RowActions>(() => ({
    toggle: (id) => setExpanded((current) => toggleExpanded(current, id)),
    click: (id, event) => {
      const { execute: run, selection: current, show: report } = latest.current;
      report(run(rowClickCommand(current, id, toggles(event))));
    },
    startRename: (id, name) => latest.current.rename.start(id, name),
    toggleVisible: (row) => {
      const { execute: run, show: report } = latest.current;
      report(run(visibilityCommand(row)));
    },
    renameChange: (value) => latest.current.rename.change(value),
    renameCommit: () => latest.current.rename.commit(),
    renameCancel: () => latest.current.rename.cancel(),
  }));

  // The window: the measured row height, the list's scroll offset and height, the focused row.
  const list = useRef<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState<number | null>(null);
  const [view, setView] = useState({ scrollTop: 0, height: 0 });
  // The focused row by ID, so it stays pinned when rows above it are added or removed.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (rowHeight !== null) return;
    const element = list.current;
    const first = element?.querySelector('li');
    if (element === null || element === undefined || first === null || first === undefined) return;
    const height = first.getBoundingClientRect().height;
    if (!(height > 0)) return;
    setRowHeight(height);
    setView({ scrollTop: element.scrollTop, height: element.clientHeight });
  });
  const onScroll = () => {
    const element = list.current;
    if (element === null) return;
    setView({ scrollTop: element.scrollTop, height: element.clientHeight });
  };
  // A list that changes height (a refusal shown or cleared, a resized column) or that was hidden
  // at mount updates its viewport; the render after it measures the row height if still unset.
  useEffect(() => {
    const element = list.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setView((current) =>
        current.height === element.clientHeight && current.scrollTop === element.scrollTop
          ? current
          : { scrollTop: element.scrollTop, height: element.clientHeight },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const count = rows.length;
  const range = windowRange(count, rowHeight, view.scrollTop, view.height);
  const indexOf = (id: string | null) => {
    if (id === null) return null;
    const index = rows.findIndex((row) => row.id === id);
    return index < 0 ? null : index;
  };
  const indexes = mountedIndexes(
    range,
    count,
    rowHeight !== null,
    indexOf(focusedId),
    indexOf(draft?.id ?? null),
  );

  return (
    <section
      aria-label="layers"
      data-testid="layers"
      style={{ display: 'flex', flexDirection: 'column', height, boxSizing: 'border-box' }}
    >
      <div role="toolbar" aria-label="arrange" style={ROW}>
        <Actions
          buttons={reorderActions(selection)}
          onRun={(button) => show(runAction(execute, button))}
        />
      </div>
      {refusal === null ? null : (
        <output role="status" data-testid="layers-refusal">
          {refusal}
        </output>
      )}
      <div ref={list} data-testid="layer-list-viewport" style={LIST} onScroll={onScroll}>
        <ul
          aria-label="layer list"
          style={
            rowHeight === null
              ? LIST_ROWS
              : { ...LIST_ROWS, position: 'relative', height: count * rowHeight }
          }
          onFocus={(event) => {
            const index = rowIndexOf(event.target);
            setFocusedId(index === null ? null : (rows[index]?.id ?? null));
          }}
          onBlur={(event) => {
            if (rowIndexOf(event.relatedTarget) === null) setFocusedId(null);
          }}
        >
          {indexes.map((index) => {
            const row = rows[index]!;
            return (
              <LayerRowItem
                key={row.id}
                row={row}
                index={index}
                count={count}
                height={rowHeight}
                draft={draft !== null && draft.id === row.id ? draft : null}
                actions={actions}
              />
            );
          })}
        </ul>
      </div>
    </section>
  );
}
