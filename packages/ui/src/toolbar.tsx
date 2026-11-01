import {
  useEditorCommands,
  useEditorQuery,
  useEditorSelector,
  useHistory,
  useNode,
  useSelection,
  useTool,
  useViewport,
  type CommandResult,
  type EditorSnapshot,
} from '@vector-studio/react';
import { useState, type ReactNode } from 'react';
import {
  editActions,
  runAction,
  symbolActions,
  toolButtons,
  toolbarTools,
  zoomActions,
  zoomLabel,
  type ActionButton,
} from './toolbar-model.js';

// MVP M8 contract, section 7.1 (M8-L1, M8-Q10 (a)): the toolbar as two fixed rows, each its own
// component, so a host places them and adds its own controls beside them (`children`, after the
// row's controls). The rows keep next-host's test IDs, labels and enable rules at 17a2b0a.

const EXTENSIONS = { type: 'extensions' } as const;
const PATH_OVERLAY = { type: 'pathOverlay' } as const;
// The 17a2b0a styles: row 1 is next-host's toolbar div; row 2, like the zoom and symbol groups,
// has no padding of its own (next-host's row 2 put the page list's padding beside it).
const ROW_1 = { display: 'flex', gap: 8, padding: 8 } as const;
const GROUP = { display: 'flex', gap: 8 } as const;

/** The selected nodes' types, '' for a missing node, compared element by element. */
const selectedTypes = (snapshot: EditorSnapshot): readonly string[] =>
  snapshot.selection.map((id) => snapshot.document.nodes[id]?.type ?? '');
const sameTypes = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((type, index) => type === b[index]);

/** Shows the code of the row's last refused command until its next command succeeds. */
function useRefusal(): [string | null, (result: CommandResult | null) => void] {
  const [refusal, setRefusal] = useState<string | null>(null);
  return [refusal, (result) => setRefusal(result !== null && !result.ok ? result.code : null)];
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

/** Props of a toolbar row (MVP M8 contract, M8-L1). */
export type ToolbarRowProps = Readonly<{
  /** Host controls placed after the row's own, inside the row. */
  children?: ReactNode;
}>;

/**
 * Toolbar row 1 (MVP M8 contract, M8-L1): the built-in tools, then each registered extension
 * tool by ID from the `extensions` query (`tool-<id>` test IDs, `aria-pressed` on the active
 * tool), then group, mask, ungroup, undo, redo, delete and toggle closed with next-host's enable
 * rules; a refused command shows its code (`tools-refusal`). Host controls follow as `children`.
 */
export function ToolbarPrimaryRow({ children }: ToolbarRowProps) {
  const execute = useEditorCommands();
  const tool = useTool();
  const history = useHistory();
  const selection = useSelection();
  const first = useNode(selection[0] ?? '');
  const pathOverlay = useEditorQuery(PATH_OVERLAY);
  const extensions = useEditorQuery(EXTENSIONS);
  const [refusal, show] = useRefusal();
  return (
    <div role="toolbar" aria-label="tools" style={ROW_1}>
      {toolButtons(toolbarTools(extensions), tool).map((button) => (
        <button
          key={button.testId}
          type="button"
          data-testid={button.testId}
          aria-pressed={button.pressed}
          onClick={() => show(execute(button.command))}
        >
          {button.label}
        </button>
      ))}
      <Actions
        buttons={editActions({ selection, history, first, pathOverlay })}
        onRun={(button) => show(runAction(execute, button))}
      />
      {children}
      {refusal === null ? null : (
        <output role="status" data-testid="tools-refusal">
          {refusal}
        </output>
      )}
    </div>
  );
}

/**
 * Toolbar row 2 (MVP M8 contract, M8-L1): the zoom controls (zoom in, zoom out, fit, selection,
 * 100% and the current zoom in `zoom`) and the symbol, instance and detach buttons
 * (`create-symbol`, `create-instance`, `detach`) with next-host's enable rules; a refused
 * command shows its code (`view-refusal`). Host controls follow as `children`.
 */
export function ToolbarSecondaryRow({ children }: ToolbarRowProps) {
  const execute = useEditorCommands();
  const zoom = useViewport().zoom;
  const selection = useSelection();
  const types = useEditorSelector(selectedTypes, sameTypes);
  const [refusal, show] = useRefusal();
  const onRun = (button: ActionButton) => show(runAction(execute, button));
  return (
    <div role="toolbar" aria-label="view and symbols" style={GROUP}>
      <span role="group" aria-label="zoom" style={GROUP}>
        <Actions buttons={zoomActions(selection.length)} onRun={onRun} />
        <output data-testid="zoom" data-zoom={zoom} style={{ alignSelf: 'center' }}>
          {zoomLabel(zoom)}
        </output>
      </span>
      <span role="group" aria-label="symbols" style={GROUP}>
        <Actions buttons={symbolActions(selection, types)} onRun={onRun} />
      </span>
      {children}
      {refusal === null ? null : (
        <output role="status" data-testid="view-refusal">
          {refusal}
        </output>
      )}
    </div>
  );
}
