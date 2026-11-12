import type {
  Command,
  CommandResult,
  ExtensionSummary,
  HistoryState,
  NodeV8,
  PathEditOverlay,
  ToolId,
  ToolName,
} from '@vector-studio/react';

// MVP M8 contract, section 7.1 (M8-L1): the toolbar's pure parts, internal to the package and
// unit-tested as functions (M8-Q3 (a)). The components in toolbar.tsx render these models.

/** The built-in tools, in toolbar order. */
export const BUILT_IN_TOOLS: readonly ToolName[] = Object.freeze([
  'select',
  'rectangle',
  'ellipse',
  'polygon',
  'line',
  'frame',
  'path',
  'pencil',
  'text',
  'eyedropper',
]);

/** The built-in tools, then each extension tool by ID, extensions in query order (sorted). */
export function toolbarTools(extensions: readonly ExtensionSummary[]): readonly ToolId[] {
  return [...BUILT_IN_TOOLS, ...extensions.flatMap((extension) => extension.tools)];
}

/**
 * Row 1 labels that differ from the tool ID. M8-N3 bounds row 1 by the 17a2b0a canvas row's
 * width (1268 px at 1280 x 900); the full word `eyedropper` (V-39) took the row to 1272 px, so
 * the M8 row names it `dropper`. The studio toolbar keeps `Eyedropper`.
 */
const TOOL_LABELS: Readonly<Partial<Record<ToolId, string>>> = { eyedropper: 'dropper' };

/** One tool button: test ID `tool-<id>`, its label (`TOOL_LABELS` or the ID), pressed if active. */
export type ToolButton = Readonly<{
  testId: string;
  label: string;
  pressed: boolean;
  command: Command;
}>;

/** The tool buttons of row 1. */
export function toolButtons(tools: readonly ToolId[], active: ToolId): readonly ToolButton[] {
  return tools.map((tool) => ({
    testId: `tool-${tool}`,
    label: TOOL_LABELS[tool] ?? tool,
    pressed: tool === active,
    command: { type: 'setTool', tool },
  }));
}

/**
 * What a button sets the selection to after its command succeeds: the command's result IDs
 * (a new group, symbol or instance), the given IDs (an ungroup's released children), or nothing.
 */
export type SelectAfter = 'result' | readonly string[] | null;

/** One action button: disabled when its enable rule fails, then `command` is null. */
export type ActionButton = Readonly<{
  testId: string;
  label: string;
  disabled: boolean;
  command: Command | null;
  selectAfter: SelectAfter;
}>;

function action(
  testId: string,
  label: string,
  command: Command | null,
  selectAfter: SelectAfter = null,
): ActionButton {
  return { testId, label, disabled: command === null, command, selectAfter };
}

/** The editor state row 1's action buttons depend on. */
export type EditActionInput = Readonly<{
  selection: readonly string[];
  history: HistoryState;
  /** The first selected node, for ungroup's released children. */
  first: NodeV8 | null;
  /** The `pathOverlay` query result. */
  pathOverlay: PathEditOverlay | null;
}>;

/**
 * Row 1's actions after the tools, with next-host's enable rules at 17a2b0a: group (one or
 * more selected), mask (two or more), ungroup (exactly one; selects the released children, as
 * the `ungroup` action does), undo and redo (a non-zero depth), delete (one or more) and toggle
 * closed (`toggleClosedCommand`).
 */
export function editActions(input: EditActionInput): readonly ActionButton[] {
  const { selection, history, first, pathOverlay } = input;
  const some = selection.length > 0;
  const released = first !== null && 'children' in first ? first.children : [];
  return [
    action(
      'group',
      'group',
      some ? { type: 'groupNodes', ids: selection, kind: 'group' } : null,
      'result',
    ),
    action(
      'mask',
      'mask',
      selection.length >= 2 ? { type: 'groupNodes', ids: selection, kind: 'maskGroup' } : null,
      'result',
    ),
    action(
      'ungroup',
      'ungroup',
      selection.length === 1 ? { type: 'ungroupNodes', id: selection[0]! } : null,
      released,
    ),
    action('undo', 'undo', history.undoDepth > 0 ? { type: 'undo' } : null),
    action('redo', 'redo', history.redoDepth > 0 ? { type: 'redo' } : null),
    action('delete', 'delete', some ? { type: 'deleteNodes', ids: selection } : null),
    action('toggle-closed', 'toggle closed', toggleClosedCommand(pathOverlay)),
  ];
}

/**
 * Row 2's zoom buttons (M2 contract, section 3): zoom in and out by 2, fit, selection (one or
 * more selected) and 100%.
 */
export function zoomActions(selected: number): readonly ActionButton[] {
  return [
    action('zoom-in', 'zoom in', { type: 'zoomBy', factor: 2 }),
    action('zoom-out', 'zoom out', { type: 'zoomBy', factor: 0.5 }),
    action('zoom-fit', 'fit', { type: 'zoomTo', target: 'fit' }),
    action(
      'zoom-selection',
      'selection',
      selected > 0 ? { type: 'zoomTo', target: 'selection' } : null,
    ),
    action('zoom-actual', '100%', { type: 'zoomTo', target: 'actual' }),
  ];
}

/** The zoom as a percentage with at most two decimals, as next-host shows it. */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 10_000) / 100}%`;
}

/**
 * Row 2's symbol buttons (M7 contract, section 5), with next-host's enable rules: symbol (one or
 * more selected), instance (exactly one symbol) and detach (one or more, all instances). The new
 * source or instance becomes the selection; a detach keeps it.
 *
 * @param selection The selected IDs.
 * @param types The selected nodes' types, in selection order ('' for a missing node).
 */
export function symbolActions(
  selection: readonly string[],
  types: readonly string[],
): readonly ActionButton[] {
  const some = selection.length > 0;
  return [
    action(
      'create-symbol',
      'symbol',
      some ? { type: 'createSymbol', ids: selection } : null,
      'result',
    ),
    action(
      'create-instance',
      'instance',
      selection.length === 1 && types[0] === 'symbol'
        ? { type: 'createInstance', symbol: selection[0]! }
        : null,
      'result',
    ),
    action(
      'detach',
      'detach',
      some && types.every((type) => type === 'instance')
        ? { type: 'detachInstances', ids: selection }
        : null,
    ),
  ];
}

/**
 * Runs a button's command and then its selection change; returns the command's result, or null
 * for a disabled button (nothing is sent). The selection change is a session command, so a
 * document command stays one undo step.
 */
export function runAction(
  execute: (command: Command) => CommandResult,
  button: ActionButton,
): CommandResult | null {
  if (button.command === null) return null;
  const result = execute(button.command);
  if (result.ok && button.selectAfter !== null) {
    const ids = button.selectAfter === 'result' ? result.ids : button.selectAfter;
    execute({ type: 'setSelection', ids });
  }
  return result;
}

/**
 * The command the `togglePathClosed` action runs for the path edit anchor selection (M3
 * contract, M3-Q11), as next-host's `toggleClosedCommand` at 17a2b0a, or null when the action
 * would be a no-op: no edit mode, no selected anchor, or anchors in more than one subpath. An
 * open subpath gets `closePathSubpath`; a closed one `openPathSubpath` at the lowest segment `k`
 * whose two ends `{k, (k + 1) mod n}` are exactly the selection, else without `segment` (its
 * closing segment).
 */
export function toggleClosedCommand(overlay: PathEditOverlay | null): Command | null {
  if (overlay === null) return null;
  const selected: { subpath: number; anchor: number }[] = [];
  overlay.subpaths.forEach((subpath, s) =>
    subpath.anchors.forEach((entry, a) => {
      if (entry.selected) selected.push({ subpath: s, anchor: a });
    }),
  );
  const subpath = selected[0]?.subpath;
  if (subpath === undefined || selected.some((ref) => ref.subpath !== subpath)) return null;
  const { id } = overlay;
  const { closed, anchors } = overlay.subpaths[subpath]!;
  if (!closed) return { type: 'closePathSubpath', id, subpath };
  const n = anchors.length;
  const chosen = new Set(selected.map((ref) => ref.anchor));
  let segment = -1;
  if (n >= 2) {
    for (let k = 0; k < n && segment < 0; k += 1) {
      const ends = new Set([k, (k + 1) % n]);
      if (ends.size === chosen.size && [...ends].every((a) => chosen.has(a))) segment = k;
    }
  }
  return segment < 0
    ? { type: 'openPathSubpath', id, subpath }
    : { type: 'openPathSubpath', id, subpath, segment };
}
