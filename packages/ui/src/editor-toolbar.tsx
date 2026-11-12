import {
  placeImagesFromPicker,
  subscribeImageNotices,
  useEditor,
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
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { booleanNotice, booleanQualifies, type BooleanOpName } from './boolean-model.js';
import {
  actionName,
  actionShortcut,
  actionTitle,
  imageNoticeText,
  macKeymap,
  nextMenuIndex,
  placeImageTitle,
  polygonSidesCommit,
  polygonSidesStep,
  shortcutFor,
  toolTitle,
  withShortcut,
  zoomPercent,
} from './editor-toolbar-model.js';
import { Icon, hasIcon } from './icons.js';
import {
  editActions,
  runAction,
  symbolActions,
  toolButtons,
  toolbarTools,
  zoomActions,
  type ActionButton,
} from './toolbar-model.js';

// V-25 (editor UI usability, slice 1): a one-row icon toolbar and a zoom menu for a full-window
// editor. Same commands, enable rules and test IDs as the M8 toolbar rows (toolbar-model.ts);
// each button names itself (`aria-label`) and shows its keymap shortcut in its tooltip. The
// components carry `vs-*` class names and no colours, so a host styles them.

const EXTENSIONS = { type: 'extensions' } as const;
const PATH_OVERLAY = { type: 'pathOverlay' } as const;
const KEYMAP = { type: 'keymap' } as const;

const ROW = { display: 'flex', alignItems: 'center', gap: 2 } as const;

const BOOLEAN_BUTTONS: readonly (readonly [BooleanOpName, string])[] = [
  ['union', 'Union selection'],
  ['subtract', 'Subtract selection'],
  ['intersect', 'Intersect selection'],
  ['exclude', 'Exclude overlap'],
];

const selectedTypes = (snapshot: EditorSnapshot): readonly string[] =>
  snapshot.selection.map((id) => snapshot.document.nodes[id]?.type ?? '');
const sameTypes = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((type, index) => type === b[index]);

function useRefusal(): [string | null, (result: CommandResult | null) => void] {
  const [refusal, setRefusal] = useState<string | null>(null);
  return [
    refusal,
    (result) =>
      setRefusal(result !== null && !result.ok ? (booleanNotice(result) ?? result.code) : null),
  ];
}

/** `#RRGGBB` of a picked colour's straight channels (V-39 contract, V39-U1). */
export function pickedHex(color: Readonly<{ r: number; g: number; b: number }>): string {
  const byte = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`.toUpperCase();
}

const pickedOf = (snapshot: EditorSnapshot) => snapshot.pickedColor;

/**
 * V39-U1: an eyedropper pick with nothing selected copies `#RRGGBB` (best effort) and shows
 * `Copied #RRGGBB` for 2 s. Each pick is a new snapshot value, so picking one colour twice
 * shows the notice again.
 */
function usePickNotice(): string | null {
  const editor = useEditor();
  const picked = useEditorSelector(pickedOf);
  const first = useRef(picked);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (picked === null || picked === first.current) return;
    // The eyedropper keeps the selection, so the current one is the one it applied to.
    if (editor.getSnapshot().selection.length > 0) return;
    const hex = pickedHex(picked);
    const clipboard = (globalThis as { navigator?: Navigator }).navigator?.clipboard;
    clipboard?.writeText(hex).catch(() => {});
    setNotice(`Copied ${hex}`);
    const timer = setTimeout(() => setNotice(null), 2000);
    return () => clearTimeout(timer);
  }, [editor, picked]);
  return notice;
}

/**
 * V32-H2: files a paste, drop or the Place image picker skipped show `Skipped: <names>`
 * (`editor.image-unsupported-file`) for 4 s.
 */
function useImageNotice(): string | null {
  const editor = useEditor();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeImageNotices(editor, (value) => {
      setNotice(imageNoticeText(value.files));
      clearTimeout(timer);
      timer = setTimeout(() => setNotice(null), 4000);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [editor]);
  return notice;
}

function IconButton({
  testId,
  name,
  icon,
  pressed,
  disabled,
  onClick,
}: Readonly<{
  testId: string;
  name: string;
  icon: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}>) {
  return (
    <button
      type="button"
      className="vs-icon-button"
      data-testid={testId}
      aria-label={name}
      title={name}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {hasIcon(icon) ? <Icon name={icon} /> : <span className="vs-icon-text">{icon}</span>}
    </button>
  );
}

const Divider = () => <span aria-hidden className="vs-divider" />;

/** Props of `EditorToolbar` (V-25). */
export type EditorToolbarProps = Readonly<{
  /** Host controls placed after the toolbar's own, inside it. */
  children?: ReactNode;
}>;

/**
 * The one-row icon toolbar (V-25): the built-in and extension tools (`tool-<id>`, the active one
 * pressed), then undo and redo, group, ungroup and mask, symbol, instance and detach, toggle
 * closed and delete, and the four booleans (`boolean-<op>`, E41-U3b, enabled for a selection
 * that qualifies), with the M8 rows' commands, enable rules and test IDs. Each button's
 * tooltip names it and its shortcut from the `keymap` query. A refused command shows its code
 * (`toolbar-refusal`). Host controls follow as `children`.
 */
export function EditorToolbar({ children }: EditorToolbarProps) {
  const editor = useEditor();
  const execute = useEditorCommands();
  const tool = useTool();
  const history = useHistory();
  const selection = useSelection();
  const first = useNode(selection[0] ?? '');
  const types = useEditorSelector(selectedTypes, sameTypes);
  const pathOverlay = useEditorQuery(PATH_OVERLAY);
  const extensions = useEditorQuery(EXTENSIONS);
  const keymap = useEditorQuery(KEYMAP);
  const [refusal, show] = useRefusal();
  const picked = usePickNotice();
  const imageNotice = useImageNotice();
  const edits = editActions({ selection, history, first, pathOverlay });
  const byId = new Map(
    [...edits, ...symbolActions(selection, types)].map((button) => [button.testId, button]),
  );
  const groups: readonly (readonly [string, readonly string[]])[] = [
    ['history', ['undo', 'redo']],
    ['grouping', ['group', 'ungroup', 'mask']],
    ['symbols', ['create-symbol', 'create-instance', 'detach']],
    ['edit', ['toggle-closed', 'delete']],
  ];
  const run = (button: ActionButton) => show(runAction(execute, button));
  // E41-U3b: the four booleans, enabled when the selection qualifies (E41 section 2.1).
  const qualifies = useEditorSelector((snapshot) =>
    booleanQualifies(snapshot.document, snapshot.selection),
  );
  return (
    <div role="toolbar" aria-label="tools" className="vs-toolbar" style={ROW}>
      <span role="group" aria-label="tool" style={ROW}>
        {toolButtons(toolbarTools(extensions), tool).map((button) => (
          <IconButton
            key={button.testId}
            testId={button.testId}
            name={toolTitle(button.label, keymap)}
            icon={button.label}
            pressed={button.pressed}
            onClick={() => show(execute(button.command))}
          />
        ))}
      </span>
      {tool === 'polygon' ? <PolygonSidesField onResult={show} /> : null}
      {groups.map(([label, ids]) => (
        <span key={label} role="group" aria-label={label} style={ROW}>
          <Divider />
          {ids.map((id) => {
            const button = byId.get(id)!;
            return (
              <IconButton
                key={id}
                testId={id}
                name={actionTitle(id, keymap)}
                icon={id}
                disabled={button.disabled}
                onClick={() => run(button)}
              />
            );
          })}
        </span>
      ))}
      <span role="group" aria-label="boolean" style={ROW}>
        <Divider />
        {BOOLEAN_BUTTONS.map(([op, label]) => (
          <IconButton
            key={op}
            testId={`boolean-${op}`}
            name={withShortcut(label, shortcutFor(keymap, 'boolean', { op }))}
            icon={`boolean-${op}`}
            disabled={!qualifies}
            onClick={() => show(execute({ type: 'booleanNodes', ids: selection, op }))}
          />
        ))}
      </span>
      <span role="group" aria-label="image" style={ROW}>
        <Divider />
        <IconButton
          testId="place-image"
          name={placeImageTitle(macKeymap(keymap))}
          icon="place-image"
          // The picker opens from this click (the user activation), then the files are placed.
          onClick={() => {
            void placeImagesFromPicker(editor).then(
              (outcome) => show(outcome === null ? null : outcome.result),
              () => undefined,
            );
          }}
        />
      </span>
      {children}
      {imageNotice === null ? null : (
        <output role="status" className="vs-refusal" data-testid="image-notice">
          {imageNotice}
        </output>
      )}
      {picked === null ? null : (
        <output role="status" className="vs-notice" data-testid="eyedropper-notice">
          {picked}
        </output>
      )}
      {refusal === null ? null : (
        <output role="status" className="vs-refusal" data-testid="toolbar-refusal">
          {refusal}
        </output>
      )}
    </div>
  );
}

const polygonSidesOf = (snapshot: EditorSnapshot): number => snapshot.polygonSides;

/**
 * V-40: the polygon tool's side count (`polygon-sides`, 3 to 60), shown while the polygon tool is
 * active. Typed text applies on Enter or blur (Escape reverts it); ArrowUp and ArrowDown step the
 * count at once. A value outside the range or not a whole number is refused by `setPolygonSides`
 * (the refusal shows), and the field shows the session's count again.
 */
function PolygonSidesField({ onResult }: Readonly<{ onResult: (result: CommandResult) => void }>) {
  const execute = useEditorCommands();
  const sides = useEditorSelector(polygonSidesOf);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const value = polygonSidesCommit(draft, sides);
    setDraft(null);
    if (value !== null) onResult(execute({ type: 'setPolygonSides', sides: value }));
  };
  return (
    <span role="group" aria-label="polygon" style={ROW}>
      <Divider />
      <label className="vs-polygon-sides" style={ROW}>
        Sides
        <input
          data-testid="polygon-sides"
          type="number"
          min={3}
          max={60}
          step={1}
          value={draft ?? String(sides)}
          style={{ width: '3.5em' }}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') setDraft(null);
            // ArrowUp and ArrowDown step the session count by one at once (within 3 to 60).
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault();
              const next = polygonSidesStep(sides, event.key);
              setDraft(null);
              if (next !== null) onResult(execute({ type: 'setPolygonSides', sides: next }));
            }
          }}
        />
      </label>
    </span>
  );
}

/**
 * The zoom menu (V-25): a button with the zoom as a whole percentage (`zoom`, `data-zoom` the
 * exact value) that opens a menu of zoom in, zoom out, fit, selection and 100% (the M8 row 2
 * commands and test IDs), each with its shortcut. It follows the menu button pattern: opening
 * (click, or ArrowDown on the button) focuses the first enabled item, ArrowUp, ArrowDown, Home
 * and End move between enabled items, Escape or a pick closes it with focus back on the button,
 * and Tab or a press outside closes it.
 * A refused command shows its code (`zoom-refusal`).
 */
export function ZoomMenu() {
  const execute = useEditorCommands();
  const zoom = useViewport().zoom;
  const selection = useSelection();
  const keymap = useEditorQuery(KEYMAP);
  const [open, setOpen] = useState(false);
  const [refusal, show] = useRefusal();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const buttons = zoomActions(selection.length);
  /** Closes the menu; `refocus` returns focus to its button (Escape, a pick). */
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const focusItem = (index: number) => {
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[index]?.focus();
  };
  // On open, focus moves to the first enabled item (the WAI-ARIA menu button pattern).
  useEffect(() => {
    if (!open) return;
    const first = nextMenuIndex(
      buttons.map((button) => !button.disabled),
      -1,
      'ArrowDown',
    );
    if (first !== null) focusItem(first);
    // Only on opening; the items' enable state is read again on each key press.
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      close(event.key === 'Escape');
      return;
    }
    const items = [...(menu.current?.querySelectorAll('[role="menuitem"]') ?? [])];
    const current = items.indexOf(document.activeElement as Element);
    const next = nextMenuIndex(
      buttons.map((button) => !button.disabled),
      current,
      event.key,
    );
    if (next === null) return;
    event.preventDefault();
    focusItem(next);
  };
  return (
    <div ref={root} className="vs-zoom" style={{ position: 'relative' }}>
      <button
        ref={trigger}
        type="button"
        className="vs-zoom-button"
        data-testid="zoom"
        data-zoom={zoom}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Zoom"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {zoomPercent(zoom)}
        <span aria-hidden className="vs-caret">
          ▾
        </span>
      </button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label="zoom"
          className="vs-menu"
          onKeyDown={onMenuKeyDown}
          style={{ position: 'absolute', right: 0, zIndex: 10 }}
        >
          {buttons.map((button) => (
            <button
              key={button.testId}
              type="button"
              role="menuitem"
              className="vs-menu-item"
              data-testid={button.testId}
              tabIndex={-1}
              disabled={button.disabled}
              onClick={() => {
                show(runAction(execute, button));
                close(true);
              }}
            >
              <span>{actionName(button.testId)}</span>
              <span className="vs-menu-shortcut">
                {actionShortcut(button.testId, keymap) ?? ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}
      {refusal === null ? null : (
        <output role="status" className="vs-refusal" data-testid="zoom-refusal">
          {refusal}
        </output>
      )}
    </div>
  );
}
