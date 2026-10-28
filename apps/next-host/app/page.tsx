'use client';

import {
  createEditor,
  starExtension,
  type Editor,
  type EditorEvent,
  type Platform,
  type ToolName,
} from '@vector-studio/editor-core';
import {
  EditorCanvas,
  EditorProvider,
  useEditor,
  useEditorCommands,
  useEditorSelector,
} from '@vector-studio/react';
import { useEffect, useState, type PointerEvent } from 'react';
import { inRotateZone, zoomLabel } from '../src/m2-geometry';
import { SelectionOverlay } from '../src/overlay';
import { createWebGpuRenderer } from '../src/webgpu-renderer';

// P5-U6 (P5 plan, section 6): the P5 editor page. Its static module graph is React and the
// editor packages only; the renderer is created in the canvas effect (see webgpu-renderer.ts).
// M1-U5 (M1 contract, M1-A12): every M1 tool, the group commands, a page switcher, and the M1
// containers fixture with `?fixture=containers`, shown at zoom 2.
// M2-U8 (M2 contract, M2-A13): the default keymap and the DOM clipboard events through
// EditorCanvas, zoom controls with the current zoom, the snap overlay, the scope indicator and
// the rotate cursor; the toolbar's ungroup selects the released children as the `ungroup` action
// does (M2-U1 note 3). The toolbar lists the built-in tools only (M2-U7 note 8).

const WIDTH = 960;
const HEIGHT = 640;
const TOOLS: readonly ToolName[] = ['select', 'rectangle', 'ellipse', 'line', 'frame', 'path'];
const FIXTURE_URL = '/m1-containers.json';
const FIXTURE_CAMERA = { position: { x: -20, y: -20 }, zoom: 2 };
/** A rotate cursor (a circular arrow) with a standard fallback; the hotspot is its centre. */
const ROTATE_CURSOR =
  'url("data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">' +
      '<path d="M15 5.5A7 7 0 1 0 17 11" fill="none" stroke="#fff" stroke-width="4"/>' +
      '<path d="M15 5.5A7 7 0 1 0 17 11" fill="none" stroke="#000" stroke-width="2"/>' +
      '<path d="M17.5 1.5v6h-6z" fill="#000" stroke="#fff"/></svg>',
  ) +
  '") 10 10, crosshair';

/** `Mod` is Meta on macOS (M2 contract, section 7); the editor reads no browser global itself. */
function hostPlatform(): Platform {
  return typeof navigator !== 'undefined' && /^Mac/u.test(navigator.platform) ? 'mac' : 'other';
}

/** Test hook for the headed P5, M1 and M2 specs: present only with `?test=1`. */
declare global {
  interface Window {
    __p5Host?: Readonly<{ editor: Editor; events: readonly EditorEvent[] }>;
  }
}

function Toolbar() {
  const editor = useEditor();
  const execute = useEditorCommands();
  const tool = useEditorSelector((snapshot) => snapshot.tool);
  const history = useEditorSelector((snapshot) => snapshot.history);
  const selection = useEditorSelector((snapshot) => snapshot.selection);
  const group = (kind: 'group' | 'maskGroup') => {
    const result = execute({ type: 'groupNodes', ids: selection, kind });
    if (result.ok) execute({ type: 'setSelection', ids: result.ids });
  };
  // As the `ungroup` action: the released children become the selection (M2-U1 note 3).
  const ungroup = () => {
    const id = selection[0]!;
    const node = editor.query({ type: 'node', id });
    const released = node !== null && 'children' in node ? node.children : [];
    const result = execute({ type: 'ungroupNodes', id });
    if (result.ok) execute({ type: 'setSelection', ids: released });
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
        onClick={ungroup}
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
      <ZoomControls />
    </div>
  );
}

/**
 * M2 contract, section 3: the zoom commands and the current zoom, in the toolbar row so the
 * canvas keeps its place (the M1 spec measures it once).
 */
function ZoomControls() {
  const execute = useEditorCommands();
  const zoom = useEditorSelector((snapshot) => snapshot.viewport.zoom);
  const selected = useEditorSelector((snapshot) => snapshot.selection.length);
  const buttons = [
    ['zoom-in', 'zoom in', () => execute({ type: 'zoomBy', factor: 2 })],
    ['zoom-out', 'zoom out', () => execute({ type: 'zoomBy', factor: 0.5 })],
    ['zoom-fit', 'fit', () => execute({ type: 'zoomTo', target: 'fit' })],
    ['zoom-selection', 'selection', () => execute({ type: 'zoomTo', target: 'selection' })],
    ['zoom-actual', '100%', () => execute({ type: 'zoomTo', target: 'actual' })],
  ] as const;
  return (
    <span role="group" aria-label="zoom" style={{ display: 'flex', gap: 8 }}>
      {buttons.map(([id, label, run]) => (
        <button
          key={id}
          type="button"
          data-testid={id}
          disabled={id === 'zoom-selection' && selected === 0}
          onClick={run}
        >
          {label}
        </button>
      ))}
      <output data-testid="zoom" data-zoom={zoom} style={{ alignSelf: 'center' }}>
        {zoomLabel(zoom)}
      </output>
    </span>
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
  const scope = useEditorSelector((snapshot) => snapshot.scope);
  const scopeName = useEditorSelector((snapshot) =>
    snapshot.scope === null ? null : (snapshot.document.nodes[snapshot.scope]?.name ?? null),
  );
  return (
    <p
      data-testid="status"
      data-revision={revision}
      data-page={page}
      data-nodes={count}
      data-selected={selected}
      data-renderer={renderer}
      data-fixture={fixture}
      data-scope={scope ?? ''}
      style={{ padding: 8 }}
    >
      revision {revision}, {count} nodes, {selected} selected
      <span data-testid="scope-label" style={{ display: 'block' }}>
        scope: {scope === null ? 'page' : `${scopeName ?? ''} (${scope})`}
      </span>
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
  // The rotate cursor over the select tool's rotate zone while no button is held (hover only:
  // EditorCanvas forwards no move without a press). Set only when it changes.
  const [rotating, setRotating] = useState(false);
  const hover = (event: PointerEvent<HTMLDivElement>) => {
    const canvas = event.currentTarget.querySelector('canvas');
    if (canvas === null || event.buttons !== 0) return;
    const current = editor.getSnapshot();
    const box = editor.query({ type: 'handles' });
    let zone = false;
    if (current.tool === 'select' && box !== null) {
      const { position, zoom } = current.viewport;
      const rect = canvas.getBoundingClientRect();
      const point = {
        x: position.x + (event.clientX - rect.left - canvas.clientLeft) / zoom,
        y: position.y + (event.clientY - rect.top - canvas.clientTop) / zoom,
      };
      zone = inRotateZone(box, point, zoom);
    }
    setRotating(zone);
  };
  return (
    <>
      <Toolbar />
      <Pages />
      <div
        data-testid="canvas-host"
        data-cursor={rotating ? 'rotate' : 'default'}
        style={{ width: WIDTH, cursor: rotating ? ROTATE_CURSOR : undefined }}
        onPointerMove={hover}
        onPointerLeave={() => setRotating(false)}
      >
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
      </div>
      <Status errors={errors} renderer={renderer} fixture={fixture} />
    </>
  );
}

export default function Page() {
  const [editor] = useState(() =>
    createEditor({ extensions: [starExtension], platform: hostPlatform() }),
  );
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
