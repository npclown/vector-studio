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
  useEditor,
  useEditorCommands,
  useEditorSelector,
} from '@vector-studio/react';
import { useEffect, useState } from 'react';
import { SelectionOverlay } from '../src/overlay';
import { createWebGpuRenderer } from '../src/webgpu-renderer';

// P5-U6 (P5 plan, section 6): the P5 editor page. Its static module graph is React and the
// editor packages only; the renderer is created in the canvas effect (see webgpu-renderer.ts).
// M1-U5 (M1 contract, M1-A12): every M1 tool, the group commands, a page switcher, and the M1
// containers fixture with `?fixture=containers`, shown at zoom 2.

const WIDTH = 960;
const HEIGHT = 640;
const TOOLS: readonly ToolName[] = ['select', 'rectangle', 'ellipse', 'line', 'frame', 'path'];
const FIXTURE_URL = '/m1-containers.json';
const FIXTURE_CAMERA = { position: { x: -20, y: -20 }, zoom: 2 };

/** Test hook for the headed P5 and M1 specs: present only with `?test=1`. */
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
  const group = (kind: 'group' | 'maskGroup') => {
    const result = execute({ type: 'groupNodes', ids: selection, kind });
    if (result.ok) execute({ type: 'setSelection', ids: result.ids });
  };
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
        data-testid="group"
        disabled={selection.length === 0}
        onClick={() => group('group')}
      >
        group
      </button>
      <button
        type="button"
        data-testid="mask"
        disabled={selection.length < 2}
        onClick={() => group('maskGroup')}
      >
        mask
      </button>
      <button
        type="button"
        data-testid="ungroup"
        disabled={selection.length !== 1}
        onClick={() => execute({ type: 'ungroupNodes', id: selection[0]! })}
      >
        ungroup
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

function Pages() {
  const execute = useEditorCommands();
  const pages = useEditorSelector((snapshot) => snapshot.document.pages);
  const active = useEditorSelector((snapshot) => snapshot.activePage);
  return (
    <nav data-testid="pages" style={{ display: 'flex', gap: 8, padding: '0 8px' }}>
      {pages.map((page) => (
        <button
          key={page.id}
          type="button"
          data-testid={`page-${page.id}`}
          aria-pressed={page.id === active}
          onClick={() => execute({ type: 'setActivePage', id: page.id })}
        >
          {page.name}
        </button>
      ))}
    </nav>
  );
}

function Status({
  errors,
  renderer,
  fixture,
}: {
  errors: readonly string[];
  renderer: string;
  fixture: string;
}) {
  const revision = useEditorSelector((snapshot) => snapshot.revision);
  const page = useEditorSelector((snapshot) => snapshot.activePage);
  const count = useEditorSelector(
    (snapshot) =>
      snapshot.document.pages.find((value) => value.id === snapshot.activePage)?.children.length ??
      0,
  );
  const selected = useEditorSelector((snapshot) => snapshot.selection.length);
  return (
    <p
      data-testid="status"
      data-revision={revision}
      data-page={page}
      data-nodes={count}
      data-selected={selected}
      data-renderer={renderer}
      data-fixture={fixture}
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
  const editor = useEditor();
  const execute = useEditorCommands();
  const snapshot = useEditorSelector((value) => value);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [renderer, setRenderer] = useState('pending');
  const [fixture, setFixture] = useState('none');
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('fixture') !== 'containers') return;
    let live = true;
    setFixture('loading');
    void (async () => {
      try {
        const response = await fetch(FIXTURE_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${FIXTURE_URL}`);
        const document: unknown = await response.json();
        if (!live) return;
        const result = execute({ type: 'loadDocument', document });
        if (!result.ok) throw new Error(`loadDocument: ${result.code} ${result.path ?? ''}`);
        execute({ type: 'setViewport', camera: FIXTURE_CAMERA });
        setFixture('loaded');
      } catch (error) {
        if (!live) return;
        setFixture('error');
        setErrors((list) => [...list, String(error)]);
      }
    })();
    return () => {
      live = false;
    };
  }, [execute]);
  // The handle box follows the snapshot: this component re-renders on every editor change.
  const handles = editor.query({ type: 'handles' });
  return (
    <>
      <Toolbar />
      <Pages />
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
        <SelectionOverlay snapshot={snapshot} handles={handles} width={WIDTH} height={HEIGHT} />
      </EditorCanvas>
      <Status errors={errors} renderer={renderer} fixture={fixture} />
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
