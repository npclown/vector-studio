import {
  CanvasContextMenu,
  selectForContextMenu,
  type CanvasContextMenuAt,
} from '@vector-studio/ui';
import type { Editor } from '@vector-studio/react';
import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from 'react';

// V-25 slice 10: next-host's studio opens `CanvasContextMenu` from a right click on its canvas
// host. The press first gets the selection a left click there would (`selectForContextMenu`),
// then the menu opens at the press, in the canvas cell. The M8 layout (`?test=1`, `?bench=1`,
// `?layout=legacy`) keeps the browser's own menu, so no spec sees a change.

/** The canvas host's right click handler and the menu to render inside the host. */
export type StudioContextMenu = Readonly<{
  onContextMenu: ((event: MouseEvent<HTMLDivElement>) => void) | undefined;
  menu: ReactNode;
}>;

/** The page point under a client point, by the editor's camera now and the canvas's box. */
function pagePoint(editor: Editor, canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const { position, zoom } = editor.getSnapshot().viewport;
  const rect = canvas.getBoundingClientRect();
  return {
    x: position.x + (clientX - rect.left - canvas.clientLeft) / zoom,
    y: position.y + (clientY - rect.top - canvas.clientTop) / zoom,
  };
}

/** The studio's context menu; with `enabled` false it does nothing (the browser's menu shows). */
export function useStudioContextMenu(editor: Editor, enabled: boolean): StudioContextMenu {
  const [at, setAt] = useState<CanvasContextMenuAt | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const onClose = useCallback((refocus: boolean) => {
    setAt(null);
    if (refocus) canvas.current?.focus({ preventScroll: true });
  }, []);
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const host = event.currentTarget;
    const element = host.querySelector('canvas');
    // Only a press on the canvas itself; the menu's own items and other children keep theirs.
    if (element === null || event.target !== element) return;
    // Text edit mode keeps the browser's menu for its hidden textarea's text.
    if (editor.getSnapshot().textEdit !== null) return;
    event.preventDefault();
    canvas.current = element;
    const parent = (host.offsetParent as HTMLElement | null) ?? host;
    const box = parent.getBoundingClientRect();
    // The menu key or Shift+F10 on the focused canvas: no pointer position (a right button press
    // reports button 2; a Mac Ctrl+click button 0 with Ctrl). The menu opens at the canvas's
    // centre and the selection stays.
    const keyboard = event.button !== 2 && !event.ctrlKey;
    const canvasBox = element.getBoundingClientRect();
    const clientX = keyboard ? canvasBox.left + canvasBox.width / 2 : event.clientX;
    const clientY = keyboard ? canvasBox.top + canvasBox.height / 2 : event.clientY;
    const point = pagePoint(editor, element, clientX, clientY);
    // No click while the primary button is held: its release would end that drag.
    if (!keyboard && (event.buttons & 1) === 0) selectForContextMenu(editor, point);
    setAt({
      left: clientX - box.left - parent.clientLeft,
      top: clientY - box.top - parent.clientTop,
      point,
    });
  };
  return {
    onContextMenu: enabled ? onContextMenu : undefined,
    menu: enabled ? <CanvasContextMenu at={at} onClose={onClose} /> : null,
  };
}
