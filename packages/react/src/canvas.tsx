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
  className?: string;
  style?: CSSProperties;
  /** Drawn over the canvas, for example the host's selection overlay. */
  children?: ReactNode;
}>;

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || createRenderer === undefined) return;
    // The effect may be torn down (StrictMode, unmount) before the factory resolves.
    let active = true;
    let release: (() => void) | null = null;
    createRenderer(canvas, { width, height, devicePixelRatio: window.devicePixelRatio }).then(
      (handle) => {
        if (!active) {
          handle.dispose();
          return;
        }
        const detach = editor.attachRenderer(handle.renderer);
        release = () => {
          detach();
          handle.dispose();
        };
      },
      (error: unknown) => {
        if (active) onError.current?.(error);
      },
    );
    return () => {
      active = false;
      release?.();
    };
  }, [editor, createRenderer, width, height]);

  const toPage = (event: PointerEvent<HTMLCanvasElement>): PagePoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: viewport.position.x + (event.clientX - rect.left) / viewport.zoom,
      y: viewport.position.y + (event.clientY - rect.top) / viewport.zoom,
    };
  };
  const pointer =
    (kind: 'pointerdown' | 'pointermove' | 'pointerup') =>
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (kind === 'pointerdown') {
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus();
      }
      // Moves without a pressed button are hover; P5 tools act only on drags.
      if (kind === 'pointermove' && event.buttons === 0) return;
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
