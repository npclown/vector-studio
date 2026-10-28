import type {
  CommandResult,
  Editor,
  InputEvent,
  Modifiers,
  PagePoint,
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
    const result = this.send({
      kind: 'keydown',
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      composing: event.isComposing,
      modifiers: modifiersOf(event),
    });
    if (result.consumed === true) event.preventDefault();
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
 * The canvas's native listeners (M2-I4), returning their cleanup. Wheel needs a non-passive
 * listener so that a consumed Ctrl+wheel or pinch can be prevented. A window blur, or focus
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
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('blur', onBlur);
  view.addEventListener('blur', onWindowBlur);
  return () => {
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('blur', onBlur);
    view.removeEventListener('blur', onWindowBlur);
  };
}
