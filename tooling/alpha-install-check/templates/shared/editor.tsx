'use client';
// AR-U4 install check host (alpha release plan): the root README's usage, installed from the
// packed tarballs, plus a status line, a layer tree and window hooks the check driver reads.
// It is copied into a fresh app outside the workspace (Vite: src/editor.tsx, Next.js:
// app/editor.tsx) and compiles against the installed packages only.
import { useMemo, useState } from 'react';
import { createEditor, type Editor as VectorEditor } from '@vector-studio/editor-core';
import { EditorCanvas, EditorProvider, LayerTree } from '@vector-studio/ui';
import { createWebGpuRendererFactory } from '@vector-studio/webgpu-host';
import { geometryKernelUrl } from '@vector-studio/geometry-wasm/kernel';

type Frame = Readonly<{ width: number; height: number; rgba: ArrayLike<number> }>;

declare global {
  interface Window {
    __alphaEditor?: VectorEditor;
    /** The backend's diagnostics, in order. */
    __alphaDiagnostics?: unknown[];
    /** The next presented frame (with `?capture=1`, through the backend's test capture). */
    __alphaCapture?: () => Promise<Frame>;
  }
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const createRenderer = createWebGpuRendererFactory({
  wasm: geometryKernelUrl,
  // A function, so `location` is read in the browser only (the factory runs in the canvas effect).
  backendOptions: () => ({
    frameCaptureForTesting: new URLSearchParams(location.search).has('capture'),
  }),
  beforeInitialize: ({ backend, addRelease }) => {
    const diagnostics: unknown[] = [];
    window.__alphaDiagnostics = diagnostics;
    const subscription = backend.subscribeDiagnostics((diagnostic) => {
      diagnostics.push(diagnostic);
    });
    addRelease(() => subscription.dispose());
  },
  afterInitialize: ({ backend, addRelease }) => {
    window.__alphaCapture = async () => {
      // Two frames for the last change to settle, then the next presented frame.
      backend.invalidate({ reason: 'scene' });
      await nextFrame();
      await nextFrame();
      return backend.captureFrameForTesting({ timeoutMs: 30_000 });
    };
    addRelease(() => {
      delete window.__alphaCapture;
    });
  },
});

export function Editor() {
  const editor = useMemo(() => createEditor(), []);
  const [status, setStatus] = useState('pending');
  if (typeof window !== 'undefined') window.__alphaEditor = editor;
  return (
    <EditorProvider editor={editor}>
      <p data-testid="status" data-renderer={status}>
        {status}
      </p>
      <EditorCanvas
        width={800}
        height={600}
        createRenderer={createRenderer}
        onRendererReady={() => setStatus('ready')}
        onRendererError={(error) => setStatus(`error: ${String(error)}`)}
      />
      <LayerTree />
    </EditorProvider>
  );
}
