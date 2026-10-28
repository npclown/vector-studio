'use client';

import {
  createEditor,
  starExtension,
  type Editor,
  type EditorEvent,
  type ToolName,
} from '@vector-studio/editor-core';
import {
  EditorCanvas,
  EditorProvider,
  useEditorCommands,
  useEditorSelector,
} from '@vector-studio/react';
import { useEffect, useState } from 'react';
import { SelectionOverlay } from '../src/overlay';
import { createWebGpuRenderer } from '../src/webgpu-renderer';

// P5-U6 (P5 plan, section 6): the P5 editor page. Its static module graph is React and the
// editor packages only; the renderer is created in the canvas effect (see webgpu-renderer.ts).

const WIDTH = 960;
const HEIGHT = 640;
const TOOLS: readonly ToolName[] = ['select', 'rectangle', 'path'];

/** Test hook for the headed P5-A09 and P5-A12 specs: present only with `?test=1`. */
declare global {
  interface Window {
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
  }
}

function Toolbar() {
  const execute = useEditorCommands();
  const tool = useEditorSelector((snapshot) => snapshot.tool);
  const history = useEditorSelector((snapshot) => snapshot.history);
  const selection = useEditorSelector((snapshot) => snapshot.selection);
  return (
    <div role="toolbar" style={{ display: 'flex', gap: 8, padding: 8 }}>
      {TOOLS.map((name) => (
        <button
          key={name}
          type="button"
          data-testid={`tool-${name}`}
          aria-pressed={tool === name}
          onClick={() => execute({ type: 'setTool', tool: name })}
        >
          {name}
        </button>
      ))}
      <button
        type="button"
        data-testid="star"
        onClick={() =>
          execute({
            type: 'runCommand',
            id: 'ext.star.create',
            args: { frame: { x: 360, y: 220, width: 160, height: 160 } },
          })
        }
      >
        star
      </button>
      <button
        type="button"
        data-testid="undo"
        disabled={history.undoDepth === 0}
        onClick={() => execute({ type: 'undo' })}
      >
        undo
      </button>
      <button
        type="button"
        data-testid="redo"
        disabled={history.redoDepth === 0}
        onClick={() => execute({ type: 'redo' })}
      >
        redo
      </button>
      <button
        type="button"
        data-testid="delete"
        disabled={selection.length === 0}
        onClick={() => execute({ type: 'deleteNodes', ids: selection })}
      >
        delete
      </button>
    </div>
  );
}

function Status({ errors, renderer }: { errors: readonly string[]; renderer: string }) {
  const revision = useEditorSelector((snapshot) => snapshot.revision);
  const count = useEditorSelector(
    (snapshot) =>
      snapshot.document.pages.find((page) => page.id === snapshot.activePage)?.children.length ?? 0,
  );
  const selected = useEditorSelector((snapshot) => snapshot.selection.length);
  return (
    <p
      data-testid="status"
      data-revision={revision}
      data-nodes={count}
      data-selected={selected}
      data-renderer={renderer}
      style={{ padding: 8 }}
    >
      revision {revision}, {count} nodes, {selected} selected
      {errors.map((error) => (
        <span key={error} data-testid="error" style={{ display: 'block', color: '#b00' }}>
          {error}
        </span>
      ))}
    </p>
  );
}

function Surface() {
  const snapshot = useEditorSelector((value) => value);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [renderer, setRenderer] = useState('pending');
  return (
    <>
      <Toolbar />
      <EditorCanvas
        width={WIDTH}
        height={HEIGHT}
        createRenderer={createWebGpuRenderer}
        onRendererError={(error) => {
          setRenderer('error');
          setErrors((list) => [...list, String(error)]);
        }}
        onRendererReady={() => setRenderer('ready')}
        style={{ border: '1px solid #ccc' }}
      >
        <SelectionOverlay snapshot={snapshot} width={WIDTH} height={HEIGHT} />
      </EditorCanvas>
      <Status errors={errors} renderer={renderer} />
    </>
  );
}

export default function Page() {
  const [editor] = useState(() => createEditor({ extensions: [starExtension] }));
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('test') !== '1') return;
    const events: EditorEvent[] = [];
    const unsubscribe = editor.subscribe((event) => events.push(event));
    window.__p5Host = { editor, events };
    return () => {
      unsubscribe();
      delete window.__p5Host;
    };
  }, [editor]);
  return (
    <EditorProvider editor={editor}>
      <main>
        <Surface />
      </main>
    </EditorProvider>
  );
}
