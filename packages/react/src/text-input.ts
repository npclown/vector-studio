import type {
  CommandResult,
  Editor,
  EditorEvent,
  InputEvent,
  Modifiers,
  TextEditOverlay,
} from '@vector-studio/editor-core';

// MVP M6b contract, section 6 (M6b-H1 to H5): `EditorCanvas`'s hidden textarea, the input sink
// of text edit mode. It joins the canvas's focus target (M6b-H2), maps `beforeinput` and the
// composition events to the editor's text input kinds (M6b-H3), holds only the active
// composition (M6b-H4) and runs the host side of a forced end (M6b-H5). Kept apart from the
// component, over structural element and event types, so it runs and is tested without a DOM,
// as canvas-input.ts is.

/**
 * The least `font-size` of the textarea in CSS px. `inputRect` is the axis-aligned box of the
 * focus caret's page segment, so its height shrinks with rotation (0 at 90°, M6b-U2 note 5);
 * the floor keeps the textarea a line box, so the IME still reads a caret rectangle at the
 * caret's top-left.
 */
export const MIN_INPUT_FONT_PX = 1;

/** The textarea as the host uses it. */
export type TextareaLike = {
  value: string;
  setSelectionRange(start: number, end: number): void;
  focus(options?: Readonly<{ preventScroll?: boolean }>): void;
  blur(): void;
  readonly style: { left: string; top: string; fontSize: string; height: string };
};

/** The canvas as the host uses it: focus, and its content box inside the wrapper. */
export type CanvasBoxLike = Readonly<{
  focus(options?: Readonly<{ preventScroll?: boolean }>): void;
  offsetLeft: number;
  offsetTop: number;
  clientLeft: number;
  clientTop: number;
  clientWidth: number;
  clientHeight: number;
}>;

export type BeforeInputLike = Readonly<{
  inputType: string;
  data: string | null;
  cancelable: boolean;
  preventDefault(): void;
}>;

export type CompositionLike = Readonly<{ data: string | null }>;

/** Runs `task` when a posted `MessageChannel` message runs (M6b-H4). */
export type Scheduler = (task: () => void) => void;

export type TextInputHostDeps = Readonly<{
  textarea: () => TextareaLike | null;
  canvas: () => CanvasBoxLike | null;
  /** `document.hasFocus()` when a blur is handled (M6b-H2). */
  documentHasFocus: () => boolean;
  /** `document.activeElement`. */
  activeElement: () => unknown;
}>;

export type InputPlacement = Readonly<{ left: number; top: number; fontSize: number }>;

/** The content box of the canvas inside the wrapper, in CSS px. */
export type CanvasBox = Readonly<{ left: number; top: number; width: number; height: number }>;

/**
 * M6b-H1: the textarea's place and `font-size` in the wrapper, from `inputRect` mapped with the
 * event-time viewport (M2-I4) and clamped to the canvas box; `font-size` is `inputRect.height ×
 * zoom` with the floor `MIN_INPUT_FONT_PX`. Outside edit mode it rests at the box's top-left.
 */
export function textInputPlacement(
  overlay: TextEditOverlay | null,
  viewport: Readonly<{ position: Readonly<{ x: number; y: number }>; zoom: number }>,
  box: CanvasBox,
): InputPlacement {
  if (overlay === null) return { left: box.left, top: box.top, fontSize: MIN_INPUT_FONT_PX };
  const { position, zoom } = viewport;
  const rect = overlay.inputRect;
  const fontSize = Math.max(rect.height * zoom, MIN_INPUT_FONT_PX);
  const clamp = (value: number, low: number, high: number) =>
    Math.min(Math.max(value, low), Math.max(low, high));
  return {
    left: clamp(box.left + (rect.x - position.x) * zoom, box.left, box.left + box.width - 1),
    top: clamp(box.top + (rect.y - position.y) * zoom, box.top, box.top + box.height - fontSize),
    fontSize,
  };
}

/**
 * A `Scheduler` over one `MessageChannel`, created on call so importing this module touches no
 * browser global; `close` releases the channel.
 */
export function createMessageScheduler(): Readonly<{ post: Scheduler; close(): void }> {
  const channel = new MessageChannel();
  const tasks: (() => void)[] = [];
  channel.port1.onmessage = () => tasks.shift()?.();
  return {
    post: (task) => {
      tasks.push(task);
      channel.port2.postMessage(null);
    },
    close: () => {
      tasks.length = 0;
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    },
  };
}

const NO_MODIFIERS: Modifiers = { shift: false, alt: false, meta: false, ctrl: false };

function isEnterKey(event: Readonly<{ key: string; code?: string }>): boolean {
  return event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
}

export class TextInputHost {
  /** Between a `compositionstart` and its `compositionend`, as the host saw them. */
  private composing = false;
  /** M6b-H5's flag: drop the next `compositionend` and any `compositionupdate` before it. */
  private dropping = false;
  /** A composition input of the host is running, so its own `textEdit` events are not H5's. */
  private sending = false;
  /** M6b-H5's own blur is running: it runs neither the M6b-H2 reset nor an exit. */
  private blurring = false;
  /** M6b-H4: the pending empty runs only while its token is current. */
  private clearToken = 0;
  /** The modifiers of a passed-through Enter keydown with no keydown since (M6b-H3). */
  private passedEnter: Modifiers | null = null;
  private editing = false;
  private post: Scheduler = (task) => queueMicrotask(task);

  constructor(
    private readonly editor: Editor,
    private readonly deps: TextInputHostDeps,
  ) {}

  /** Whether M6b-H5's own blur is running; the blur listeners skip it. */
  get hostBlurring(): boolean {
    return this.blurring;
  }

  /** Whether text edit mode is set. */
  get active(): boolean {
    return this.editor.getSnapshot().textEdit !== null;
  }

  /**
   * Subscribes to the editor (focus, placement and the M6b-H5 trigger) and returns the cleanup.
   * `post` schedules M6b-H4's empty.
   */
  attach(post: Scheduler): () => void {
    this.post = post;
    this.editing = false;
    this.syncTextEdit();
    const stop = this.editor.subscribe((event) => this.onEvent(event));
    return () => {
      stop();
      this.clearToken += 1;
    };
  }

  /** Focuses the textarea without scrolling, unless it has focus. */
  focusInput(): void {
    const textarea = this.deps.textarea();
    if (textarea === null || this.deps.activeElement() === textarea) return;
    textarea.focus({ preventScroll: true });
  }

  /** After each keydown result (M6b-H3's Enter case): remembers a passed-through Enter. */
  keyResult(keydown: Extract<InputEvent, { kind: 'keydown' }>, result: CommandResult): void {
    this.passedEnter =
      result.ok && result.passThrough === true && isEnterKey(keydown) ? keydown.modifiers : null;
  }

  /** M6b-H3: `beforeinput` on the textarea. */
  beforeInput(event: BeforeInputLike): void {
    switch (event.inputType) {
      case 'insertText':
        event.preventDefault();
        this.passedEnter = null;
        this.send({ kind: 'textinput', text: event.data ?? '' });
        return;
      case 'insertCompositionText':
      case 'deleteCompositionText':
        return;
      case 'insertLineBreak':
      case 'insertParagraph': {
        if (event.cancelable) event.preventDefault();
        const enter = this.passedEnter;
        this.passedEnter = null;
        // The browser's line break after a passed-through Enter that no rule-3 Enter followed
        // (section 5.1): the Enter edit action.
        if (enter !== null) {
          this.send({
            kind: 'keydown',
            key: 'Enter',
            code: 'Enter',
            repeat: false,
            composing: false,
            modifiers: { ...NO_MODIFIERS, shift: enter.shift },
          });
        }
        return;
      }
      default:
        if (event.cancelable) event.preventDefault();
    }
  }

  compositionStart(): void {
    // M6b-H4: a start before the posted message keeps the textarea; the H5 flag clears here.
    this.clearToken += 1;
    this.dropping = false;
    this.composing = true;
    const result = this.sendComposition({ kind: 'compositionstart' });
    if (!result.ok) this.forcedEnd();
  }

  compositionUpdate(event: CompositionLike): void {
    if (this.dropping) return;
    const result = this.sendComposition({ kind: 'compositionupdate', data: event.data ?? '' });
    if (!result.ok) this.forcedEnd();
  }

  compositionEnd(event: CompositionLike): void {
    this.scheduleClear();
    this.composing = false;
    if (this.dropping) {
      this.dropping = false;
      return;
    }
    const result = this.sendComposition({ kind: 'compositionend', data: event.data ?? '' });
    if (!result.ok) this.forcedEnd();
  }

  /**
   * M6b-H2, on a blur that leaves the target or a window blur, before the M2 reset: a
   * composition the host is in ends by `endComposition` with the drop flag already set, so this
   * host-caused end runs no M6b-H5 blur, empty or refocus (and the reset's `pointercancel` finds
   * no composition to end).
   */
  endForBlur(): void {
    if (!this.composing || !this.active) return;
    this.dropping = true;
    this.composing = false;
    this.editor.execute({ type: 'endComposition' });
  }

  /**
   * M6b-H2, after the reset of a blur that leaves the target: exits edit mode only for an element
   * blur, when the document still has focus; otherwise it is a window blur (Alt+Tab) and edit
   * mode stays.
   */
  exitForBlur(): void {
    if (this.active && this.deps.documentHasFocus()) this.editor.execute({ type: 'exitTextEdit' });
  }

  private send(event: InputEvent): CommandResult {
    return this.editor.execute({ type: 'input', event });
  }

  private sendComposition(event: InputEvent): CommandResult {
    this.sending = true;
    try {
      return this.send(event);
    } finally {
      this.sending = false;
    }
  }

  private scheduleClear(): void {
    const token = (this.clearToken += 1);
    this.post(() => {
      if (token === this.clearToken) this.empty();
    });
  }

  private empty(): void {
    const textarea = this.deps.textarea();
    if (textarea === null) return;
    textarea.value = '';
    textarea.setSelectionRange(0, 0);
  }

  /**
   * M6b-H5, in its order: the drop flag first (Chrome may commit synchronously inside `blur()`),
   * the host's own blur, the empty, then focus on the textarea while edit mode is set, else on
   * the canvas.
   */
  private forcedEnd(): void {
    this.dropping = true;
    this.composing = false;
    const textarea = this.deps.textarea();
    if (textarea !== null) {
      this.blurring = true;
      try {
        textarea.blur();
      } finally {
        this.blurring = false;
      }
    }
    this.empty();
    if (this.active) this.focusInput();
    else this.deps.canvas()?.focus({ preventScroll: true });
  }

  private onEvent(event: EditorEvent): void {
    if (event.type === 'session' && event.field === 'textEdit') {
      this.syncTextEdit();
      return;
    }
    if (!this.editing) return;
    if (event.type === 'session') {
      if (
        event.field === 'viewport' ||
        event.field === 'viewportSize' ||
        event.field === 'textLayout'
      ) {
        this.place();
      }
    } else if (event.type === 'document') {
      this.place();
    }
  }

  /** The M6b-H5 trigger, and M6b-H1's focus on entry and exit. */
  private syncTextEdit(): void {
    const state = this.editor.getSnapshot().textEdit;
    // The editor ended the composition (a session `textEdit` event the host did not cause
    // through `compositionend`).
    if (this.composing && !this.sending && (state === null || state.composition === null)) {
      this.forcedEnd();
    }
    const textarea = this.deps.textarea();
    if (state !== null && !this.editing) this.focusInput();
    else if (state === null && this.editing && textarea !== null) {
      // On exit focus returns to the canvas only when the textarea still has focus.
      if (this.deps.activeElement() === textarea)
        this.deps.canvas()?.focus({ preventScroll: true });
    }
    this.editing = state !== null;
    this.place();
  }

  /** M6b-H1: the textarea at the focus caret, with the event-time viewport. */
  private place(): void {
    const textarea = this.deps.textarea();
    const canvas = this.deps.canvas();
    if (textarea === null || canvas === null) return;
    const overlay = this.editing ? this.editor.query({ type: 'textEditOverlay' }) : null;
    const placement = textInputPlacement(overlay, this.editor.getSnapshot().viewport, {
      left: canvas.offsetLeft + canvas.clientLeft,
      top: canvas.offsetTop + canvas.clientTop,
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });
    textarea.style.left = `${placement.left}px`;
    textarea.style.top = `${placement.top}px`;
    textarea.style.fontSize = `${placement.fontSize}px`;
    textarea.style.height = `${placement.fontSize}px`;
  }
}
