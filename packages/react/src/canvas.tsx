import type { RendererSceneSynchronization } from '@vector-studio/contracts';
import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  CanvasInput,
  attachCanvasListeners,
  syncViewportSize,
  type KeyLike,
} from './canvas-input.js';
import { useEditor } from './context.js';
import { MIN_INPUT_FONT_PX, TextInputHost, createMessageScheduler } from './text-input.js';

// P5-U6 (P5 plan, section 6): a headless canvas. It renders a <canvas> and turns pointer and key
// input into editor `input` commands in page space. The renderer is created only inside an
// effect, through a host-supplied factory, so this module and its importers never touch browser
// globals at import time, and the WebGPU backend stays a host choice. M2-U1 (MVP M2 contract,
// M2-I4): wheel, middle button, key-up, double-click and pointercancel input, the viewport
// size, event-time camera mapping and the blur reset; the mapping lives in canvas-input.ts.
// M2-U6 (section 6): DOM copy, cut and paste on the focused canvas, and the system clipboard
// write of the bound clipboard actions.
// M6b-U7 (MVP M6b contract, section 6): the hidden textarea beside the canvas (M6b-H1), one
// focus target with it (M6b-H2), its `beforeinput` and composition mapping, reset and forced end
// (M6b-H3 to H5) in text-input.ts.

/** What a host factory returns: the renderer to attach, and how to release it. */
export type RendererHandle = Readonly<{
  renderer: RendererSceneSynchronization;
  dispose(): void;
}>;

export type CanvasSize = Readonly<{ width: number; height: number; devicePixelRatio: number }>;

export type RendererFactory = (
  canvas: HTMLCanvasElement,
  size: CanvasSize,
) => Promise<RendererHandle>;

export type EditorCanvasProps = Readonly<{
  /** CSS pixels. */
  width: number;
  height: number;
  createRenderer?: RendererFactory;
  onRendererError?: (error: unknown) => void;
  /** Called once the factory's renderer is attached to the editor. */
  onRendererReady?: () => void;
  className?: string;
  style?: CSSProperties;
  /** Drawn over the canvas, for example the host's selection overlay. */
  children?: ReactNode;
}>;

/**
 * Renderer creation per canvas, chained: a creation waits until the previous one has settled
 * and been released, so two renderers never configure one canvas context at once (StrictMode
 * runs every effect twice in development, and a size change re-runs it).
 */
const creations = new WeakMap<HTMLCanvasElement, Promise<void>>();

/** M6b-H1's fixed textarea styles; its place, `font-size` and height are set at event time. */
const TEXTAREA_STYLE: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: 1,
  height: MIN_INPUT_FONT_PX,
  fontSize: MIN_INPUT_FONT_PX,
  lineHeight: 1,
  margin: 0,
  padding: 0,
  border: 0,
  opacity: 0,
  resize: 'none',
  overflow: 'hidden',
  pointerEvents: 'none',
};

/** Attributes React's textarea type does not list (M6b-H1). */
const TEXTAREA_EXTRA: Record<string, string> = { writingsuggestions: 'false' };

/** A React keyboard event as `CanvasInput` reads it, `keyCode` included (M6b-H2). */
function keyOf(event: KeyboardEvent): KeyLike {
  return {
    key: event.key,
    code: event.code,
    repeat: event.repeat,
    isComposing: event.nativeEvent.isComposing,
    keyCode: event.nativeEvent.keyCode,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    preventDefault: () => event.preventDefault(),
  };
}

export function EditorCanvas({
  width,
  height,
  createRenderer,
  onRendererError,
  onRendererReady,
  className,
  style,
  children,
}: EditorCanvasProps) {
  const editor = useEditor();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const heightRef = useRef(height);
  heightRef.current = height;
  const { input, text } = useMemo(() => {
    const input = new CanvasInput(
      editor,
      () => heightRef.current,
      () => canvasRef.current,
      // Read at use, so importing this module touches no browser global.
      () => (typeof navigator === 'undefined' ? undefined : navigator.clipboard),
    );
    const text = new TextInputHost(editor, {
      textarea: () => textareaRef.current,
      canvas: () => canvasRef.current,
      documentHasFocus: () => document.hasFocus(),
      activeElement: () => document.activeElement,
    });
    input.text = text;
    return { input, text };
  }, [editor]);
  const onError = useRef(onRendererError);
  onError.current = onRendererError;
  const onReady = useRef(onRendererReady);
  onReady.current = onRendererReady;

  useEffect(() => syncViewportSize(editor, width, height), [editor, width, height]);

  // Wheel, the blur of the canvas and the textarea, the clipboard events, the textarea's
  // `beforeinput` and composition events and the window blur (canvas-input.ts, text-input.ts).
  // The canvas and the textarea are one focus target; focus moving within it is not a blur.
  useEffect(() => {
    const canvas = canvasRef.current;
    const textarea = textareaRef.current;
    if (canvas === null || textarea === null) return;
    const detach = attachCanvasListeners(
      canvas,
      window,
      input,
      (node) => node === canvas || node === textarea,
      textarea,
    );
    const scheduler = createMessageScheduler();
    const detachText = text.attach(scheduler.post);
    return () => {
      detachText();
      scheduler.close();
      detach();
    };
  }, [input, text]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || createRenderer === undefined) return;
    // The effect may be torn down (StrictMode, unmount) before the factory resolves.
    let active = true;
    let release: (() => void) | null = null;
    const previous = creations.get(canvas) ?? Promise.resolve();
    const current = previous.then(async () => {
      if (!active) return;
      try {
        const handle = await createRenderer(canvas, {
          width,
          height,
          devicePixelRatio: window.devicePixelRatio,
        });
        if (!active) {
          handle.dispose();
          return;
        }
        const detach = editor.attachRenderer(handle.renderer);
        release = () => {
          detach();
          handle.dispose();
        };
        onReady.current?.();
      } catch (error) {
        if (active) onError.current?.(error);
      }
    });
    creations.set(canvas, current);
    return () => {
      active = false;
      release?.();
      release = null;
    };
  }, [editor, createRenderer, width, height]);

  return (
    <div style={{ position: 'relative', width, height }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        tabIndex={0}
        className={className}
        style={{ display: 'block', width, height, touchAction: 'none', ...style }}
        onPointerDown={(event) => input.pointerDown(event)}
        onMouseDown={(event) => input.mouseDown(event)}
        onPointerMove={(event) => input.pointerMove(event)}
        onPointerLeave={() => input.pointerLeave()}
        onPointerUp={(event) => input.pointerUp(event)}
        onPointerCancel={(event) => input.pointerCancel(event)}
        onDoubleClick={(event) => input.doubleClick(event)}
        onKeyDown={(event) => input.keyDown(keyOf(event))}
        onKeyUp={(event) => input.keyUp(keyOf(event))}
      />
      <textarea
        ref={textareaRef}
        aria-label="Text input"
        tabIndex={-1}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        {...TEXTAREA_EXTRA}
        style={TEXTAREA_STYLE}
        onKeyDown={(event) => input.keyDown(keyOf(event))}
        onKeyUp={(event) => input.keyUp(keyOf(event))}
      />
      {children === undefined ? null : (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{children}</div>
      )}
    </div>
  );
}
