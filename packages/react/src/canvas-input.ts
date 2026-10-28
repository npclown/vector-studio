import {
  eventChord,
  type CommandResult,
  type Editor,
  type InputEvent,
  type Modifiers,
  type PagePoint,
} from '@vector-studio/editor-core';

// MVP M2 contract, M2-I4: how `EditorCanvas` turns DOM input into editor `input` commands. Kept
// apart from the component, over structural event types, so it runs and is tested without a DOM.

/** Pixels per line for a wheel event in line mode (M2-I1). */
export const WHEEL_LINE_PX = 16;

type ModifierKeys = Readonly<{
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}>;

/** The canvas element as the mapping needs it. */
export type CanvasLike = Readonly<{
  getBoundingClientRect(): Readonly<{ left: number; top: number }>;
  clientLeft: number;
  clientTop: number;
}>;

export type PointerLike = ModifierKeys &
  Readonly<{
    button: number;
    clientX: number;
    clientY: number;
    pointerId: number;
    currentTarget: CanvasLike & Readonly<{ setPointerCapture(id: number): void; focus(): void }>;
    preventDefault(): void;
  }>;

export type MouseLike = ModifierKeys &
  Readonly<{ clientX: number; clientY: number; currentTarget: CanvasLike }>;

export type WheelLike = ModifierKeys &
  Readonly<{
    clientX: number;
    clientY: number;
    deltaX: number;
    deltaY: number;
    /** 0 pixels, 1 lines, 2 pages. */
    deltaMode: number;
    preventDefault(): void;
  }>;

export type KeyLike = ModifierKeys &
  Readonly<{
    key: string;
    code: string;
    repeat: boolean;
    isComposing: boolean;
    preventDefault(): void;
  }>;

/** The `clipboardData` of a DOM `copy`, `cut` or `paste` event, as the canvas uses it. */
export type ClipboardDataLike = Readonly<{
  getData(format: string): string;
  setData(format: string, data: string): void;
}>;

export type ClipboardEventLike = Readonly<{
  clipboardData: ClipboardDataLike | null;
  preventDefault(): void;
}>;

/** `navigator.clipboard` as the bound clipboard actions use it; absent outside a secure page. */
export type ClipboardWriter = Readonly<{ writeText?: unknown }>;

/** The built-in actions whose in-memory text is also written to the system clipboard. */
const CLIPBOARD_ACTIONS: ReadonlySet<string> = new Set(['copy', 'cut', 'paste']);

function modifiersOf(event: ModifierKeys): Modifiers {
  return { shift: event.shiftKey, alt: event.altKey, meta: event.metaKey, ctrl: event.ctrlKey };
}

const NO_MODIFIERS: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

export class CanvasInput {
  /** Whether a press was forwarded and its release has not come yet. */
  private dragging = false;
  /**
   * Whether input was forwarded since the last reset. A window blur also blurs the canvas, so
   * the reset runs once for both; with nothing forwarded, nothing can be held.
   */
  private armed = false;

  /**
   * `height` is the canvas height in CSS px, the size of a wheel page; `canvas` returns the
   * element for wheel events, which arrive through a native listener.
   */
  constructor(
    private readonly editor: Editor,
    private readonly height: () => number,
    private readonly canvas: () => CanvasLike | null,
    /** The system clipboard for the bound clipboard actions (`navigator.clipboard`), if any. */
    private readonly writer: () => ClipboardWriter | null | undefined = () => undefined,
  ) {}

  /**
   * A client point in page space with the editor's camera at event time, not the rendered one,
   * so a pan never reads a stale camera. The renderer draws in the content box, inside any
   * border the host styles on the canvas.
   */
  toPage(canvas: CanvasLike, clientX: number, clientY: number): PagePoint {
    const { position, zoom } = this.editor.getSnapshot().viewport;
    const rect = canvas.getBoundingClientRect();
    return {
      x: position.x + (clientX - rect.left - canvas.clientLeft) / zoom,
      y: position.y + (clientY - rect.top - canvas.clientTop) / zoom,
    };
  }

  private send(event: InputEvent): CommandResult {
    this.armed = true;
    return this.editor.execute({ type: 'input', event });
  }

  pointerDown(event: PointerLike): void {
    // Primary and middle buttons only; the middle press never starts the browser's autoscroll.
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    this.dragging = true;
    this.send({
      kind: 'pointerdown',
      point: this.toPage(event.currentTarget, event.clientX, event.clientY),
      button: event.button,
      modifiers: modifiersOf(event),
    });
  }

  /** Moves without a press are hover, and a release without one is not ours. */
  pointerMove(event: MouseLike): void {
    if (!this.dragging) return;
    this.send({
      kind: 'pointermove',
      point: this.toPage(event.currentTarget, event.clientX, event.clientY),
      modifiers: modifiersOf(event),
    });
  }

  pointerUp(event: MouseLike): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.send({
      kind: 'pointerup',
      point: this.toPage(event.currentTarget, event.clientX, event.clientY),
      modifiers: modifiersOf(event),
    });
  }

  /** A cancelled pointer (pen or touch, lost capture) of a forwarded press. */
  pointerCancel(event: ModifierKeys): void {
    if (!this.dragging) return;
    this.dragging = false;
    this.send({ kind: 'pointercancel', modifiers: modifiersOf(event) });
  }

  doubleClick(event: MouseLike): void {
    this.send({
      kind: 'doubleclick',
      point: this.toPage(event.currentTarget, event.clientX, event.clientY),
      modifiers: modifiersOf(event),
    });
  }

  /** `preventDefault` when consumed, so Ctrl+wheel and pinch do not zoom the browser page. */
  wheel(event: WheelLike): void {
    const canvas = this.canvas();
    if (canvas === null) return;
    const scale = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? this.height() : 1;
    const result = this.send({
      kind: 'wheel',
      point: this.toPage(canvas, event.clientX, event.clientY),
      deltaX: event.deltaX * scale,
      deltaY: event.deltaY * scale,
      modifiers: modifiersOf(event),
    });
    if (result.consumed === true) event.preventDefault();
  }

  keyDown(event: KeyLike): void {
    const keydown = {
      kind: 'keydown',
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      composing: event.isComposing,
      modifiers: modifiersOf(event),
    } as const;
    // The binding the keymap would run, looked up before the action can change the keymap.
    const chord = eventChord(keydown, keydown.modifiers);
    const action = this.editor
      .getSnapshot()
      .keymap.find((binding) => binding.chord === chord)?.action;
    const result = this.send(keydown);
    if (result.consumed === true) event.preventDefault();
    // A bound copy, cut or paste works on the in-memory clipboard; its text also goes to the
    // system clipboard when the page has one (M2 contract, section 6). The consumed keydown is
    // prevented, so no DOM clipboard event follows.
    if (result.ok && result.consumed === true && action != null && CLIPBOARD_ACTIONS.has(action)) {
      this.writeSystemClipboard();
    }
  }

  /** `writeText` of the in-memory text; a missing API, a throw or a rejection is ignored. */
  private writeSystemClipboard(): void {
    const text = this.editor.query({ type: 'clipboard' });
    if (text === null) return;
    try {
      const writer = this.writer();
      if (typeof writer?.writeText !== 'function') return;
      const pending: unknown = (writer.writeText as (text: string) => unknown).call(writer, text);
      const thenable = pending as { catch?: unknown } | null;
      if (typeof thenable?.catch === 'function') {
        (thenable.catch as (onRejected: () => void) => unknown).call(pending, () => undefined);
      }
    } catch {
      // A permission or focus refusal leaves the in-memory clipboard as the only copy.
    }
  }

  /**
   * A DOM `copy` or `cut` on the focused canvas (section 6): the command runs on the selection;
   * when it copied nothing (an empty selection, or a failure) the event is left to the browser,
   * otherwise it is prevented and carries the fragment as `text/plain`.
   */
  clipboardCopy(type: 'copy' | 'cut', event: ClipboardEventLike): void {
    const result = this.editor.execute({ type });
    if (!result.ok || result.ids.length === 0) return;
    event.preventDefault();
    event.clipboardData?.setData('text/plain', this.editor.query({ type: 'clipboard' }) ?? '');
  }

  /** A DOM `paste`: always `paste { text }`, the empty string without `text/plain`; prevented. */
  clipboardPaste(event: ClipboardEventLike): void {
    event.preventDefault();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    this.editor.execute({ type: 'paste', text });
  }

  keyUp(event: KeyLike): void {
    const result = this.send({
      kind: 'keyup',
      key: event.key,
      code: event.code,
      modifiers: modifiersOf(event),
    });
    if (result.consumed === true) event.preventDefault();
  }

  /**
   * Focus left the canvas's focus target, or the window blurred: a lost key-up or release can
   * no longer leave a drag running or Space held.
   */
  reset(): void {
    if (!this.armed) return;
    this.dragging = false;
    this.send({ kind: 'pointercancel', modifiers: NO_MODIFIERS });
    this.send({ kind: 'keyup', key: ' ', code: 'Space', modifiers: NO_MODIFIERS });
    this.armed = false;
  }
}

/** The part of an element or window the canvas listeners need. */
export type ListenerTarget = Readonly<{
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}>;

/** The viewport size effect: on mount and on every resize (M2 contract, section 3). */
export function syncViewportSize(editor: Editor, width: number, height: number): void {
  editor.execute({ type: 'setViewportSize', width, height });
}

/**
 * The canvas's native listeners (M2-I4, section 6), returning their cleanup. Wheel needs a
 * non-passive listener so that a consumed Ctrl+wheel or pinch can be prevented; `copy`, `cut`
 * and `paste` use the system clipboard through `clipboardData`. A window blur, or focus
 * leaving the canvas's focus target (`isFocusTarget` says whether a node belongs to it), resets
 * input, since a key-up or release may never arrive.
 */
export function attachCanvasListeners(
  canvas: ListenerTarget,
  view: ListenerTarget,
  input: CanvasInput,
  isFocusTarget: (node: unknown) => boolean,
): () => void {
  const onWheel = (event: Event) => input.wheel(event as WheelEvent);
  const onBlur = (event: Event) => {
    const next = (event as FocusEvent).relatedTarget;
    if (next !== null && next !== undefined && isFocusTarget(next)) return;
    input.reset();
  };
  const onWindowBlur = () => input.reset();
  // Clipboard events target the focused element, so these run only while the canvas has focus
  // (the M2-U6 headed probe: Chrome and Edge fire them on a focused canvas).
  const onCopy = (event: Event) => input.clipboardCopy('copy', event as ClipboardEvent);
  const onCut = (event: Event) => input.clipboardCopy('cut', event as ClipboardEvent);
  const onPaste = (event: Event) => input.clipboardPaste(event as ClipboardEvent);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('blur', onBlur);
  canvas.addEventListener('copy', onCopy);
  canvas.addEventListener('cut', onCut);
  canvas.addEventListener('paste', onPaste);
  view.addEventListener('blur', onWindowBlur);
  return () => {
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('blur', onBlur);
    canvas.removeEventListener('copy', onCopy);
    canvas.removeEventListener('cut', onCut);
    canvas.removeEventListener('paste', onPaste);
    view.removeEventListener('blur', onWindowBlur);
  };
}
