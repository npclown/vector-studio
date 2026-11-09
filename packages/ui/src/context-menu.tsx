import {
  useEditor,
  useEditorCommands,
  useEditorSelector,
  type CommandResult,
  type Editor,
  type PagePoint,
} from '@vector-studio/react';
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  contextClickSelects,
  contextMenuItems,
  type ContextMenuItem,
} from './context-menu-model.js';
import { nextMenuIndex } from './editor-toolbar-model.js';

// V-25 slice 10 (editor UI usability): the canvas's right click menu (Figma). The host opens it
// from the canvas's `contextmenu` event: `selectForContextMenu` first gives the press the
// selection a left click there would (unless it lands on the selection box), then the host
// renders `CanvasContextMenu` at the press. Items run public commands only. The component
// carries `vs-*` class names and no colours, so a host styles it as it does the zoom menu.

const NO_MODIFIERS = { shift: false, alt: false, meta: false, ctrl: false } as const;

/**
 * Gives a right click at page `point` the selection a plain left click there would (a node
 * under it selected, empty canvas clearing the selection), by sending that click as `input`
 * events, when `contextClickSelects` says so: the select tool, no path or text edit mode, and
 * the press not on or near the current selection box. Returns whether it sent the click. A host
 * must not call it while a primary press is held: the click's release would end that gesture.
 */
export function selectForContextMenu(editor: Editor, point: PagePoint): boolean {
  const snapshot = editor.getSnapshot();
  if (!contextClickSelects(snapshot, editor.query({ type: 'handles' }), point)) return false;
  editor.execute({
    type: 'input',
    event: { kind: 'pointerdown', point, button: 0, modifiers: NO_MODIFIERS },
  });
  editor.execute({ type: 'input', event: { kind: 'pointerup', point, modifiers: NO_MODIFIERS } });
  return true;
}

/** Where the menu opens: CSS px in its offset parent, and the page point of the press. */
export type CanvasContextMenuAt = Readonly<{ left: number; top: number; point: PagePoint }>;

/** Props of `CanvasContextMenu`. */
export type CanvasContextMenuProps = Readonly<{
  /** Where the menu is open, or null when it is closed. */
  at: CanvasContextMenuAt | null;
  /**
   * Called when the menu closes. `refocus` is true after a pick, Escape, Tab or a wheel: the host
   * returns focus to the canvas, so its shortcuts keep working.
   */
  onClose: (refocus: boolean) => void;
}>;

/** `navigator.clipboard` when the page may use it; absent outside a secure page. */
function systemClipboard(): Clipboard | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.clipboard;
}

/**
 * Runs an item. Copy and cut also write the in-memory text to the system clipboard; paste reads
 * the system clipboard's text first (as a Ctrl+V on the canvas pastes it) and falls back to the
 * in-memory clipboard when it cannot be read (no permission, or not a secure page). Both are
 * best effort.
 */
async function runItem(
  editor: Editor,
  execute: (command: Parameters<Editor['execute']>[0]) => CommandResult,
  entry: ContextMenuItem,
  point: PagePoint,
): Promise<CommandResult | null> {
  if (entry.run === null) return null;
  if (entry.clipboard === 'paste') {
    let text: string | null;
    try {
      text = (await systemClipboard()?.readText()) ?? null;
    } catch {
      text = null;
    }
    if (text !== null && text !== '') {
      return execute({ type: 'paste', text, at: point, pointer: point });
    }
    return entry.run(execute);
  }
  const result = entry.run(execute);
  if (entry.clipboard !== undefined && result?.ok === true && result.ids.length > 0) {
    const text = editor.query({ type: 'clipboard' });
    if (text !== null) {
      try {
        await systemClipboard()?.writeText(text);
      } catch {
        // The in-memory clipboard holds the copy; the system one is best effort.
      }
    }
  }
  return result;
}

/**
 * The canvas context menu (V-25 slice 10), at `at` in its offset parent and kept inside it.
 * With a selection: copy, cut, paste here, duplicate, delete; bring to front, forward, send
 * backward, to back; group, ungroup, use as mask; hide or show; create symbol, instance, detach;
 * zoom to selection. On empty canvas: paste here, select all, zoom to fit, zoom to 100%. Each
 * item shows its shortcut from the `keymap` query (copy, cut and paste the browser's chords)
 * and is disabled when it would do nothing. It follows the menu pattern: the first enabled item
 * takes focus, ArrowUp, ArrowDown, Home and End move between enabled items, Escape, Tab, a pick
 * or a wheel closes it (`onClose(true)`), and a press outside or a window blur closes it
 * (`onClose(false)`). A menu taller than its offset parent scrolls. A refused command shows its
 * code (`context-refusal`) after it closes.
 */
export function CanvasContextMenu({ at, onClose }: CanvasContextMenuProps) {
  const editor = useEditor();
  const execute = useEditorCommands();
  const snapshot = useEditorSelector((value) => value);
  const menu = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState<Readonly<{
    left: number;
    top: number;
    maxHeight?: number;
  }> | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const groups = at === null ? [] : contextMenuItems({ snapshot, point: at.point });
  const items = groups.flat();
  const enabled = items.map((entry) => !entry.disabled);
  // Kept inside the offset parent: to the left of the press when it would overflow on the right,
  // moved up when it would overflow at the bottom, then clamped to the parent's top-left corner.
  useLayoutEffect(() => {
    if (at === null || menu.current === null) {
      setOffset(null);
      return;
    }
    const element = menu.current;
    const parent = element.offsetParent as HTMLElement | null;
    const width = parent?.clientWidth ?? Infinity;
    const height = parent?.clientHeight ?? Infinity;
    const left = at.left + element.offsetWidth > width ? at.left - element.offsetWidth : at.left;
    const top = at.top + element.offsetHeight > height ? height - element.offsetHeight : at.top;
    // A cell shorter than the menu caps its height; the menu then scrolls.
    setOffset({
      left: Math.max(0, left),
      top: Math.max(0, top),
      ...(Number.isFinite(height) ? { maxHeight: height } : {}),
    });
  }, [at]);
  // Once placed (a hidden menu cannot take focus), the first enabled item takes focus.
  useEffect(() => {
    if (at === null || offset === null) return;
    setRefusal(null);
    const first = nextMenuIndex(enabled, -1, 'ArrowDown');
    if (first !== null) focusItem(first);
    // Only on opening; the items' enable state is read again on each key press.
  }, [offset]);
  useEffect(() => {
    if (at === null) return;
    // A press outside focuses its own target; a wheel focuses nothing, so the canvas gets focus.
    const outside = (event: Event) => {
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) {
        onClose(event.type === 'wheel');
      }
    };
    const blur = () => onClose(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('wheel', outside, true);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('wheel', outside, true);
      window.removeEventListener('blur', blur);
    };
  }, [at, onClose]);
  function focusItem(index: number) {
    menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[index]?.focus();
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys stay in the menu: the canvas's shortcuts must not run under it.
    event.stopPropagation();
    if (event.key === 'Escape' || event.key === 'Tab') {
      // Both hand focus back to the canvas, so its shortcuts keep working.
      event.preventDefault();
      onClose(true);
      return;
    }
    const buttons = [...(menu.current?.querySelectorAll('[role="menuitem"]') ?? [])];
    const next = nextMenuIndex(
      enabled,
      buttons.indexOf(document.activeElement as Element),
      event.key,
    );
    if (next === null) return;
    event.preventDefault();
    focusItem(next);
  };
  const pick = (entry: ContextMenuItem) => {
    if (at === null) return;
    const point = at.point;
    onClose(true);
    void runItem(editor, execute, entry, point).then((result) =>
      setRefusal(result !== null && !result.ok ? result.code : null),
    );
  };
  return (
    <>
      {at === null ? null : (
        <div
          ref={menu}
          role="menu"
          aria-label="canvas"
          className="vs-menu vs-context-menu"
          data-testid="context-menu"
          onKeyDown={onKeyDown}
          onContextMenu={(event) => event.preventDefault()}
          style={{
            position: 'absolute',
            left: offset?.left ?? at.left,
            top: offset?.top ?? at.top,
            maxHeight: offset?.maxHeight,
            overflowY: 'auto',
            boxSizing: 'border-box',
            margin: 0,
            zIndex: 20,
            visibility: offset === null ? 'hidden' : 'visible',
          }}
        >
          {groups.map((group, index) => (
            <Fragment key={group[0]!.testId}>
              {index === 0 ? null : <div role="separator" className="vs-menu-separator" />}
              {group.map((entry) => (
                <button
                  key={entry.testId}
                  type="button"
                  role="menuitem"
                  className="vs-menu-item"
                  data-testid={entry.testId}
                  tabIndex={-1}
                  disabled={entry.disabled}
                  onClick={() => pick(entry)}
                >
                  <span>{entry.label}</span>
                  <span className="vs-menu-shortcut">{entry.shortcut ?? ''}</span>
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      )}
      {refusal === null ? null : (
        <output
          role="status"
          className="vs-refusal"
          data-testid="context-refusal"
          style={{ position: 'absolute', left: 8, bottom: 8, zIndex: 20 }}
        >
          {refusal}
        </output>
      )}
    </>
  );
}
