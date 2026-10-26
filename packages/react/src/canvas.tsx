import type { RendererSceneSynchronization } from '@vector-studio/contracts';
import type { Modifiers, PagePoint } from '@vector-studio/editor-core';
import { useEffect, useRef, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { useEditor, useEditorCommands, useEditorSelector } from './context.js';

// P5-U6 (P5 plan, section 6): a headless canvas. It renders a <canvas> and turns pointer and key
// input into editor `input` commands in page space. The renderer is created only inside an
// effect, through a host-supplied factory, so this module and its importers never touch browser
// globals at import time, and the WebGPU backend stays a host choice.

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

function modifiersOf(event: {
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): Modifiers {
  return { shift: event.shiftKey, alt: event.altKey, meta: event.metaKey, ctrl: event.ctrlKey };
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
  const execute = useEditorCommands();
  const viewport = useEditorSelector((snapshot) => snapshot.viewport);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onError = useRef(onRendererError);
  onError.current = onRendererError;
  const onReady = useRef(onRendererReady);
  onReady.current = onRendererReady;
  const dragging = useRef(false);

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

  const toPage = (event: PointerEvent<HTMLCanvasElement>): PagePoint => {
    // The renderer draws in the content box, inside any border the host styles on the canvas.
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: viewport.position.x + (event.clientX - rect.left - canvas.clientLeft) / viewport.zoom,
      y: viewport.position.y + (event.clientY - rect.top - canvas.clientTop) / viewport.zoom,
    };
  };
  const pointer =
    (kind: 'pointerdown' | 'pointermove' | 'pointerup') =>
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (kind === 'pointerdown') {
        // P5 tools use the primary button only.
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
        dragging.current = true;
      } else if (!dragging.current) {
        // Moves without a press are hover, and a release without one is not ours.
        return;
      }
      if (kind === 'pointerup') dragging.current = false;
      execute({
        type: 'input',
        event: { kind, point: toPage(event), modifiers: modifiersOf(event) },
      });
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
        onPointerDown={pointer('pointerdown')}
        onPointerMove={pointer('pointermove')}
        onPointerUp={pointer('pointerup')}
        onPointerCancel={() => {
          // A cancelled pointer (pen or touch, lost capture) cancels the drag, as Escape does.
          if (!dragging.current) return;
          dragging.current = false;
          execute({
            type: 'input',
            event: {
              kind: 'keydown',
              key: 'Escape',
              modifiers: { shift: false, alt: false, meta: false, ctrl: false },
            },
          });
        }}
        onKeyDown={(event) => {
          const result = execute({
            type: 'input',
            event: { kind: 'keydown', key: event.key, modifiers: modifiersOf(event) },
          });
          if (result.ok && event.key === 'Escape') event.preventDefault();
        }}
      />
      {children === undefined ? null : (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>{children}</div>
      )}
    </div>
  );
}
