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
import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  layerRows,
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
// M8-N3: the layer tree has a fixed height of 240 px; its list scrolls.
const TREE = {
  display: 'flex',
  flexDirection: 'column',
  height: 240,
  boxSizing: 'border-box',
} as const;
const LIST = { flex: 1, minHeight: 0, overflowY: 'auto', margin: 0, padding: 0 } as const;
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

/** Shift or Mod (Ctrl or Meta), as the canvas reads them, toggles a row in the selection. */
const toggles = (event: MouseEvent) => event.shiftKey || event.ctrlKey || event.metaKey;

/**
 * The layer tree (MVP M8 contract, M8-L3 and L4; fixed height 240 px, M8-N3): the active page's
 * nodes front first, indented by depth, each row (`layer-<id>`) with its name and type. A
 * container's caret (`layer-toggle-<id>`) expands or collapses it (React state); an instance's
 * expansion is not listed. Clicking a name selects the node (`setSelection [id]`), with Shift or
 * Mod it toggles it; selected rows are marked (`data-selected`, a pressed name). A double-click
 * renames (`setNodeProps name` on Enter or blur), `layer-visible-<id>` hides or shows the node
 * (`setNodeProps visible`), and the forward, backward, front and back buttons reorder the
 * selection (`reorderNodes`). A refused command shows its code (`layers-refusal`).
 */
export function LayerTree() {
  countRender('layers');
  const execute = useEditorCommands();
  const document = useEditorSelector(documentOf);
  const active = useActivePage();
  const selection = useSelection();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [refusal, show] = useRefusal();
  const rows = layerRows(document, active, expanded, selection);
  const rename = useRename(
    (id, value) => {
      const row = rows.find((entry) => entry.id === id);
      return row === undefined ? { invalid: false, command: null } : renameNodeEdit(row, value);
    },
    (command) => show(execute(command)),
  );
  const { draft } = rename;
  return (
    <section aria-label="layers" data-testid="layers" style={TREE}>
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
      <ul aria-label="layer list" style={LIST}>
        {rows.map((row) => {
          countRender('layer-row');
          return (
            <li
              key={row.id}
              data-testid={row.testId}
              data-depth={row.depth}
              data-selected={row.selected}
              style={{
                ...ROW,
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
                  onClick={() => setExpanded((current) => toggleExpanded(current, row.id))}
                >
                  {row.expanded ? '▾' : '▸'}
                </button>
              ) : null}
              {draft !== null && draft.id === row.id ? (
                <NameInput
                  label="layer name"
                  draft={draft}
                  onChange={rename.change}
                  onCommit={rename.commit}
                  onCancel={rename.cancel}
                />
              ) : (
                <button
                  type="button"
                  data-testid={`layer-name-${row.id}`}
                  aria-pressed={row.selected}
                  onClick={(event) =>
                    show(execute(rowClickCommand(selection, row.id, toggles(event))))
                  }
                  onDoubleClick={() => rename.start(row.id, row.name)}
                >
                  {row.name}
                </button>
              )}
              <span>{row.type}</span>
              <button
                type="button"
                data-testid={`layer-visible-${row.id}`}
                onClick={() => show(execute(visibilityCommand(row)))}
              >
                {row.visible ? 'hide' : 'show'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
