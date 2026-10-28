import type { RendererSceneSynchronization } from '@vector-studio/contracts';
import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type FocusEvent,
  type ReactNode,
} from 'react';
import { CanvasInput } from './canvas-input.js';
import { useEditor } from './context.js';

// P5-U6 (P5 plan, section 6): a headless canvas. It renders a <canvas> and turns pointer and key
// input into editor `input` commands in page space. The renderer is created only inside an
// effect, through a host-supplied factory, so this module and its importers never touch browser
// globals at import time, and the WebGPU backend stays a host choice. M2-U1 (MVP M2 contract,
// M2-I4): wheel, middle button, key-up, double-click and pointercancel input, the viewport
// size, event-time camera mapping and the blur reset; the mapping lives in canvas-input.ts.

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
  const heightRef = useRef(height);
  heightRef.current = height;
  const input = useMemo(
    () =>
      new CanvasInput(
        editor,
        () => heightRef.current,
        () => canvasRef.current,
      ),
    [editor],
  );
  const onError = useRef(onRendererError);
  onError.current = onRendererError;
  const onReady = useRef(onRendererReady);
  onReady.current = onRendererReady;

  // The viewport size, on mount and on every resize (M2 contract, section 3).
  useEffect(() => {
    editor.execute({ type: 'setViewportSize', width, height });
  }, [editor, width, height]);

  // Wheel needs a non-passive listener so that a consumed Ctrl+wheel or pinch can be prevented;
  // a window blur releases a drag and Space, whose key-up may never arrive.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (event: WheelEvent) => input.wheel(event);
    const onWindowBlur = () => input.reset();
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('blur', onWindowBlur);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [input]);

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

  /** The canvas is the focus target; focus moving within it is not a blur (M2-I4). */
  const onBlur = (event: FocusEvent<HTMLCanvasElement>) => {
    if (event.relatedTarget !== null && event.relatedTarget === canvasRef.current) return;
    input.reset();
  };

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
        onPointerMove={(event) => input.pointerMove(event)}
        onPointerUp={(event) => input.pointerUp(event)}
        onPointerCancel={(event) => input.pointerCancel(event)}
        onDoubleClick={(event) => input.doubleClick(event)}
        onKeyDown={(event) =>
          input.keyDown({
            key: event.key,
            code: event.code,
            repeat: event.repeat,
            isComposing: event.nativeEvent.isComposing,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            preventDefault: () => event.preventDefault(),
          })
        }
        onKeyUp={(event) =>
          input.keyUp({
            key: event.key,
            code: event.code,
            repeat: event.repeat,
            isComposing: event.nativeEvent.isComposing,
            shiftKey: event.shiftKey,
            altKey: event.altKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            preventDefault: () => event.preventDefault(),
          })
        }
        onBlur={onBlur}
      />
      {children === undefined ? null : (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{children}</div>
      )}
    </div>
  );
}
