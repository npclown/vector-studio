import type {
  Command,
  CommandResult,
  EditorSnapshot,
  KeyBinding,
  PagePoint,
  SelectionHandles,
} from '@vector-studio/react';
import { booleanActions } from './boolean-model.js';
import { chordLabel, macKeymap, shortcutFor } from './editor-toolbar-model.js';
import { runAction, symbolActions, type ActionButton } from './toolbar-model.js';

// V-25 slice 10 (editor UI usability): the pure parts of `CanvasContextMenu`, the canvas's right
// click menu (Figma). Every item runs a public command the toolbar, the layer tree or a keymap
// action already runs; the menu adds no editor behaviour.

/** What a clipboard item does besides its command: the system clipboard (best effort). */
export type ContextMenuClipboard = 'copy' | 'cut' | 'paste';

/** One menu item: test ID `context-<id>`, disabled when it would do nothing. */
export type ContextMenuItem = Readonly<{
  testId: string;
  label: string;
  /** The item's shortcut as a person reads it, or null. */
  shortcut: string | null;
  disabled: boolean;
  /** Set for copy, cut and paste: the component also reads or writes the system clipboard. */
  clipboard?: ContextMenuClipboard;
  /** Runs the item; null for a disabled item (nothing is sent). */
  run: ((execute: (command: Command) => CommandResult) => CommandResult | null) | null;
}>;

/** The menu: groups of items, shown with a separator between groups. */
export type ContextMenuModel = readonly (readonly ContextMenuItem[])[];

/** The editor state the menu depends on. */
export type ContextMenuInput = Readonly<{
  snapshot: EditorSnapshot;
  /** The page point the menu was opened at: where "Paste here" puts the paste. */
  point: PagePoint;
}>;

/**
 * The chord of the clipboard keymap action `action` when a layer binds it (the built-in
 * `copy`, `cut` and `paste` actions are unbound by default), else the browser's own chord for
 * `key`, which the canvas handles as a DOM clipboard event: ⌘ on a Mac keymap, Ctrl otherwise.
 */
function clipboardChord(keymap: readonly KeyBinding[], action: string, key: string): string {
  return (
    shortcutFor(keymap, action) ??
    chordLabel(`${macKeymap(keymap) ? 'Meta' : 'Ctrl'}+Key${key}`, macKeymap(keymap))
  );
}

function item(
  testId: string,
  label: string,
  shortcut: string | null,
  run: ContextMenuItem['run'],
  clipboard?: ContextMenuClipboard,
): ContextMenuItem {
  return {
    testId: `context-${testId}`,
    label,
    shortcut,
    disabled: run === null,
    ...(clipboard === undefined ? {} : { clipboard }),
    run,
  };
}

/** An item that runs one command, or none (disabled) when `command` is null. */
function single(command: Command | null): ContextMenuItem['run'] {
  return command === null ? null : (execute) => execute(command);
}

/** An item that runs a toolbar button (its command, then its selection follow-up). */
function fromButton(button: ActionButton): ContextMenuItem['run'] {
  return button.command === null ? null : (execute) => runAction(execute, button);
}

/** A command, then on success the selection of the IDs it returned (as the toolbar does). */
function thenSelect(command: Command): NonNullable<ContextMenuItem['run']> {
  return (execute) => {
    const result = execute(command);
    if (result.ok) execute({ type: 'setSelection', ids: result.ids });
    return result;
  };
}

/**
 * The delete item. In path edit mode it removes the selected anchors, as the Delete key does
 * there (removing every anchor deletes the path, M3-Q4), and is disabled with none selected;
 * otherwise it deletes the selected nodes.
 */
function deleteItem(snapshot: EditorSnapshot, shortcut: string | null): ContextMenuItem {
  const edit = snapshot.pathEdit;
  if (edit === null) {
    return item(
      'delete',
      'Delete',
      shortcut,
      single({ type: 'deleteNodes', ids: snapshot.selection }),
    );
  }
  return item(
    'delete',
    'Delete points',
    shortcut,
    edit.anchors.length === 0
      ? null
      : (execute) => {
          const result = execute({ type: 'removePathAnchors', id: edit.id, anchors: edit.anchors });
          if (result.ok || result.code !== 'editor.empty-path') return result;
          return execute({ type: 'deleteNodes', ids: [edit.id] });
        },
  );
}

/** The paste item: the in-memory clipboard pasted with its bounds centred on `point`. */
function pasteItem(keymap: readonly KeyBinding[], point: PagePoint): ContextMenuItem {
  return item(
    'paste',
    'Paste here',
    clipboardChord(keymap, 'paste', 'V'),
    (execute) => execute({ type: 'paste', at: point, pointer: point }),
    'paste',
  );
}

/**
 * The menu for the editor state (V-25 slice 10). With a selection: clipboard and edit items
 * (copy, cut, paste here, duplicate, delete), arrange (bring to front, forward, send backward,
 * to back), grouping (group, ungroup for one selected group or mask group, mask for two or
 * more), booleans (union, subtract, intersect, exclude, only when the selection qualifies,
 * E41), show or hide (hide when any selected node is visible), symbols (the toolbar's symbol,
 * instance and detach rules) and zoom to selection. Without one (empty canvas): paste here,
 * select all (the scope's children, else the page's), zoom to fit and zoom to 100%.
 */
export function contextMenuItems({ snapshot, point }: ContextMenuInput): ContextMenuModel {
  const { selection, keymap, document } = snapshot;
  const shortcut = (action: string, args = {}) => shortcutFor(keymap, action, args);
  if (selection.length === 0) {
    const parent =
      snapshot.scope === null
        ? document.pages.find((page) => page.id === snapshot.activePage)?.children
        : (document.nodes[snapshot.scope] as { children?: readonly string[] } | undefined)
            ?.children;
    const all = parent ?? [];
    return [
      [pasteItem(keymap, point)],
      [
        item(
          'select-all',
          'Select all',
          shortcut('selectAll'),
          all.length === 0 ? null : single({ type: 'setSelection', ids: all }),
        ),
      ],
      [
        item(
          'zoom-fit',
          'Zoom to fit',
          shortcut('zoomToFit'),
          single({ type: 'zoomTo', target: 'fit' }),
        ),
        item(
          'zoom-actual',
          'Zoom to 100%',
          shortcut('zoomTo100'),
          single({ type: 'zoomTo', target: 'actual' }),
        ),
      ],
    ];
  }
  const ids = selection;
  const nodes = ids.map((id) => document.nodes[id]);
  const first = nodes[0];
  const types = nodes.map((node) => node?.type ?? '');
  const reorder = (id: string, label: string, op: 'front' | 'forward' | 'backward' | 'back') =>
    item(id, label, shortcut('reorder', { op }), single({ type: 'reorderNodes', ids, op }));
  const group = first !== undefined && (first.type === 'group' || first.type === 'maskGroup');
  const anyVisible = nodes.some((node) => node?.visible !== false);
  const symbols = new Map(symbolActions(ids, types).map((button) => [button.testId, button]));
  const booleans = booleanActions(document, ids, keymap);
  const symbolItem = (id: string, label: string) =>
    item(id, label, null, fromButton(symbols.get(id)!));
  return [
    [
      item(
        'copy',
        'Copy',
        clipboardChord(keymap, 'copy', 'C'),
        single({ type: 'copy', ids }),
        'copy',
      ),
      item('cut', 'Cut', clipboardChord(keymap, 'cut', 'X'), single({ type: 'cut', ids }), 'cut'),
      pasteItem(keymap, point),
      item(
        'duplicate',
        'Duplicate',
        shortcut('duplicate'),
        thenSelect({ type: 'duplicateNodes', ids }),
      ),
      deleteItem(snapshot, shortcut('delete')),
    ],
    [
      reorder('front', 'Bring to front', 'front'),
      reorder('forward', 'Bring forward', 'forward'),
      reorder('backward', 'Send backward', 'backward'),
      reorder('back', 'Send to back', 'back'),
    ],
    [
      item(
        'group',
        'Group selection',
        shortcut('group'),
        thenSelect({ type: 'groupNodes', ids, kind: 'group' }),
      ),
      item(
        'ungroup',
        'Ungroup',
        shortcut('ungroup'),
        ids.length === 1 && group
          ? (execute) => {
              const released = first.children;
              const result = execute({ type: 'ungroupNodes', id: first.id });
              if (result.ok) execute({ type: 'setSelection', ids: released });
              return result;
            }
          : null,
      ),
      item(
        'mask',
        'Use as mask',
        shortcut('maskGroup'),
        ids.length >= 2 ? thenSelect({ type: 'groupNodes', ids, kind: 'maskGroup' }) : null,
      ),
    ],
    // E41 contract, section 6: the four booleans, shown only when the selection qualifies.
    ...(booleans.length === 0
      ? []
      : [
          booleans.map((action) =>
            item(`boolean-${action.op}`, action.label, action.shortcut, single(action.command)),
          ),
        ]),
    [
      item('visibility', anyVisible ? 'Hide' : 'Show', null, (execute) => {
        // One `setNodeProps` per node (each its own undo step), as the layer tree's toggle.
        let last: CommandResult | null = null;
        for (const id of ids) {
          const result = execute({ type: 'setNodeProps', id, props: { visible: !anyVisible } });
          if (!result.ok) return result;
          last = result;
        }
        return last;
      }),
    ],
    [
      symbolItem('create-symbol', 'Create symbol'),
      symbolItem('create-instance', 'Create instance'),
      symbolItem('detach', 'Detach instance'),
    ],
    [
      item(
        'zoom-selection',
        'Zoom to selection',
        shortcut('zoomToSelection'),
        single({ type: 'zoomTo', target: 'selection' }),
      ),
    ],
  ];
}

/** Page units, at zoom 1, around the selection box that still count as inside it. */
const BOX_MARGIN = 8;

/** Whether `point` lies inside the (possibly rotated) handle box grown by `margin`. */
export function insideSelectionBox(
  handles: SelectionHandles,
  point: PagePoint,
  margin: number,
): boolean {
  const [origin, right, , bottom] = handles.corners;
  const width = Math.hypot(right.x - origin.x, right.y - origin.y);
  const height = Math.hypot(bottom.x - origin.x, bottom.y - origin.y);
  const cos = Math.cos(handles.rotation);
  const sin = Math.sin(handles.rotation);
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const x = dx * cos + dy * sin;
  const y = -dx * sin + dy * cos;
  return x >= -margin && x <= width + margin && y >= -margin && y <= height + margin;
}

/**
 * Whether a right click at `point` first selects what lies under it, as a plain left click
 * there would (Figma): with the select tool, outside path and text edit mode, unless it lands
 * on or within `8 / zoom` page units of the selection box, where the selection stays (so a
 * right click on one node of a multiple selection keeps the whole selection).
 */
export function contextClickSelects(
  snapshot: EditorSnapshot,
  handles: SelectionHandles | null,
  point: PagePoint,
): boolean {
  if (snapshot.tool !== 'select' || snapshot.pathEdit !== null || snapshot.textEdit !== null) {
    return false;
  }
  if (handles === null || snapshot.selection.length === 0) return true;
  return !insideSelectionBox(handles, point, BOX_MARGIN / snapshot.viewport.zoom);
}
