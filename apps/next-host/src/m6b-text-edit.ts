import type { EditorSnapshot, TextEditOverlay, TextStyle } from '@vector-studio/editor-core';
import { TEST_FONT_FAMILY } from './m6a-text-host';

// M6b-U9 (MVP M6b contract, sections 4.5, 6 and M6b-A12, A13): the host side of the next-host
// page's text edit mode, kept free of React so it is unit tested in Node. The editor decides
// every behaviour and the react package's `EditorCanvas` owns the hidden textarea (M6b-H1 to
// H5); these helpers only draw the `textEditOverlay` query result in CSS pixels (the caret,
// the selection quads and the composition underline; M6b draws no text, M6-Q14 (a)), name the
// text tool style of the `?fixture=text-edit` document, and keep the DOM event log of the
// `?test=1` hook's `textEdit` member, which the headed spec reads for focus and prevention.

type Camera = EditorSnapshot['viewport'];
type Point = readonly [number, number];

/** A segment in CSS pixels over the canvas. */
export type Segment = Readonly<{ x1: number; y1: number; x2: number; y2: number }>;

/** The edit overlay at a camera: CSS px = (page − position) · zoom, as every overlay layer. */
export type TextEditMarkers = Readonly<{
  /** Edited node ID; null while a pending node has none (M6b-S1). */
  id: string | null;
  /** The collapsed caret, null for a non-empty selection. */
  caret: Segment | null;
  /** One four-point polygon per selection quad, in overlay order. */
  selection: readonly (readonly Point[])[];
  /** One underline segment per composition segment, in overlay order. */
  composition: readonly Segment[];
}>;

export function textEditMarkers(
  overlay: TextEditOverlay | null,
  camera: Camera,
): TextEditMarkers | null {
  if (overlay === null) return null;
  const { position, zoom } = camera;
  const at = (point: Readonly<{ x: number; y: number }>): Point => [
    (point.x - position.x) * zoom,
    (point.y - position.y) * zoom,
  ];
  const segment = (
    pair: readonly [Readonly<{ x: number; y: number }>, Readonly<{ x: number; y: number }>],
  ): Segment => {
    const [x1, y1] = at(pair[0]);
    const [x2, y2] = at(pair[1]);
    return { x1, y1, x2, y2 };
  };
  return {
    id: overlay.id,
    caret: overlay.caret === null ? null : segment(overlay.caret),
    selection: overlay.selection.map((quad) => quad.map(at)),
    composition: overlay.composition.map(segment),
  };
}

/**
 * The text tool style the `?fixture=text-edit` page sets after loading (M6b-Q7 (a): next-host
 * sets the committed test font for its fixture), so a pending node and a pasted text node lay
 * out in the registered face on every machine.
 */
export const TEXT_EDIT_TOOL_STYLE: TextStyle = {
  family: TEST_FONT_FAMILY,
  size: 20,
  color: { r: 0, g: 0, b: 0, a: 1 },
};

/** Where focus is, as the spec and the replayed traces name it (M6b-A10's `focused`). */
export type FocusName = 'textarea' | 'canvas' | 'panel' | 'body' | 'other';

/** One DOM event as the hook logs it, read after every handler of the page has run. */
export type TextEditLogEntry = Readonly<{
  type: string;
  /** The event target, by `FocusName`. */
  target: FocusName;
  /** Whether a handler prevented the default (read in the window's bubble phase). */
  prevented: boolean;
  /** Where focus is once the event has been handled. */
  focused: FocusName;
  key?: string;
  code?: string;
  keyCode?: number;
  inputType?: string;
  data?: string | null;
  /** `focusin` and `focusout`: the other side of the move. */
  related?: FocusName | null;
  /** Clipboard events: the types the event's data offers. */
  types?: readonly string[];
  /** Pointer and mouse events: the client point the page received. */
  clientX?: number;
  clientY?: number;
  /** Pointer and mouse events. */
  button?: number;
}>;

/** The DOM the log reads; the page passes `window`, tests a fake. */
export type LogTarget = Readonly<{
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}>;

/** The event types the log records, in the window's bubble phase. */
export const LOGGED_EVENTS = [
  'pointerdown',
  'mousedown',
  'pointerup',
  'keydown',
  'keyup',
  'beforeinput',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'focusin',
  'focusout',
  'copy',
  'cut',
  'paste',
] as const;

type ElementLike = Readonly<{
  tagName?: string;
  getAttribute?(name: string): string | null;
  closest?(selector: string): unknown;
}>;

/** Names an element by its role on the page: the textarea of M6b-H1, the canvas, the panel. */
export function focusName(element: unknown): FocusName {
  if (element === null || typeof element !== 'object') return 'other';
  const value = element as ElementLike;
  const tag = typeof value.tagName === 'string' ? value.tagName.toLowerCase() : '';
  if (tag === 'textarea' && value.getAttribute?.('aria-label') === 'Text input') return 'textarea';
  if (tag === 'canvas') return 'canvas';
  if (tag === 'body') return 'body';
  if (typeof value.closest === 'function' && value.closest('[data-testid="appearance-panel"]')) {
    return 'panel';
  }
  return 'other';
}

type EventFields = Readonly<{
  type: string;
  target?: unknown;
  defaultPrevented?: boolean;
  key?: unknown;
  code?: unknown;
  keyCode?: unknown;
  inputType?: unknown;
  data?: unknown;
  relatedTarget?: unknown;
  clientX?: unknown;
  clientY?: unknown;
  button?: unknown;
  clipboardData?: Readonly<{ types?: ArrayLike<string> }> | null;
}>;

/** One log entry of `event`, with focus read from `activeElement`. */
export function logEntry(event: EventFields, activeElement: unknown): TextEditLogEntry {
  const entry: Record<string, unknown> = {
    type: event.type,
    target: focusName(event.target),
    prevented: event.defaultPrevented === true,
    focused: focusName(activeElement),
  };
  if (typeof event.key === 'string') entry.key = event.key;
  if (typeof event.code === 'string') entry.code = event.code;
  if (typeof event.keyCode === 'number') entry.keyCode = event.keyCode;
  if (typeof event.inputType === 'string') entry.inputType = event.inputType;
  if (event.type === 'beforeinput' || event.type.startsWith('composition')) {
    entry.data = typeof event.data === 'string' ? event.data : null;
  }
  if (event.type === 'focusin' || event.type === 'focusout') {
    entry.related = event.relatedTarget == null ? null : focusName(event.relatedTarget);
  }
  if (event.type.startsWith('pointer') || event.type.startsWith('mouse')) {
    if (typeof event.clientX === 'number') entry.clientX = event.clientX;
    if (typeof event.clientY === 'number') entry.clientY = event.clientY;
    if (typeof event.button === 'number') entry.button = event.button;
  }
  if (event.clipboardData?.types !== undefined) {
    entry.types = Array.from(event.clipboardData.types);
  }
  return entry as TextEditLogEntry;
}

/** The `textEdit` member of the page's `?test=1` hook. */
export type TextEditTestHook = Readonly<{
  /** The DOM events since the hook was made or last cleared, oldest first. */
  log: readonly TextEditLogEntry[];
  clearLog(): void;
  /** Where focus is now. */
  focused(): FocusName;
}>;

/**
 * Starts the log on `target` (the window, so it runs after React's root listeners and the
 * textarea's own) and returns the hook member and its disposal.
 */
export function createTextEditLog(
  target: LogTarget,
  activeElement: () => unknown,
): Readonly<{ hook: TextEditTestHook; dispose(): void }> {
  const log: TextEditLogEntry[] = [];
  const listener = (event: Event) => {
    log.push(logEntry(event, activeElement()));
  };
  for (const type of LOGGED_EVENTS) target.addEventListener(type, listener);
  return {
    hook: {
      log,
      clearLog: () => {
        log.length = 0;
      },
      focused: () => focusName(activeElement()),
    },
    dispose: () => {
      for (const type of LOGGED_EVENTS) target.removeEventListener(type, listener);
    },
  };
}
