'use client';

import {
  type Editor,
  type EditorEvent,
  type PathEditOverlay,
  type Platform,
  type TextStyle,
  type ToolName,
} from '@vector-studio/editor-core';
import {
  EditorCanvas,
  EditorProvider,
  useEditor,
  useEditorCommands,
  useEditorSelector,
} from '@vector-studio/react';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { inRotateZone, zoomLabel } from '../src/m2-geometry';
import { toggleClosedCommand } from '../src/m3-path-overlay';
import {
  attachPersistence,
  createPressGate,
  offersDiscard,
  PERSIST_DATABASE_NAME,
  persistQuery,
  persistStatusLabel,
  restoreEnvelope,
  saveFileText,
  SAVE_FILE_NAME,
  type PersistenceSession,
  type PersistStatus,
} from '../src/m5-persistence';
import {
  runHostEffect,
  textFixtureQuery,
  textTestHook,
  type HostCompositionState,
  type TestFontStatus,
  type TextTestHook,
} from '../src/m6a-text-host';
import {
  createTextEditLog,
  TEXT_EDIT_TOOL_STYLE,
  textEditMarkers,
  type TextEditMarkers,
  type TextEditTestHook,
} from '../src/m6b-text-edit';
import { BENCH_CANVAS, benchDatabaseName, pageBench } from '../src/e26-bench';
import { AppearancePanel } from '../src/m4-appearance-panel';
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
// M3-U4 (M3 contract, M3-A12): the path edit anchor overlay from the `pathOverlay` query, a
// toggle-closed button that runs what the unbound `togglePathClosed` action runs (M3-Q11), and
// the M3 path-edit fixture with `?fixture=path-edit`, shown at zoom 1.
// M5-U4 (M5 contract, sections 3 and 5.3): "Save file" and "Open file" (the envelope text), and
// with `?persist=1` only the IndexedDB restore and autosave (src/m5-persistence.ts), its status,
// "Discard stored document" after a failed restore, and the test hook's `persistence.flush`.
// M7-U6 (M7 contract, M7-A11): "symbol", "instance" and "detach" buttons for the `createSymbol`,
// `createInstance` and `detachInstances` commands beside the page switcher (no key is bound),
// and the M7 symbols fixture with `?fixture=symbols`, shown at zoom 2.
// M6a-U5 (M6a contract, section 5): the editor and its text-dom port are created together in a
// client effect (src/m6a-text-host.ts), never during render or prerender, and the effect's
// cleanup disposes the port, so the page prerenders a placeholder; `?fixture=text` registers the
// committed test font, waits for it to settle and loads the M6a text fixture at zoom 2; the test
// hook's `text` member exposes the port and the test font (M6a-A11).
// M4-U4 (M4 contract, section 8): the appearance panel (src/m4-appearance-panel.tsx) to the right
// of the canvas, so the toolbar rows and the canvas keep their place; one committed edit is one
// `setStyle` command. `?fixture=appearance` loads the M4 host fixture (H1 to H9, M4-A12) at zoom
// 1; the headed spec sets the camera to its pixel-centre position per DPR.
// E26-U1b (E26 contract, section 3.3): with `?bench=1` (src/e26-bench.ts) the canvas is the E26
// viewport, `doc=` loads a scenario document from `/e26-bench-doc.json` (exempt from the "persistence
// wins" rule), `persist=1` restores from a fresh per-run database and records every autosave
// write, and `window.__e26Bench` drives and measures the run. Without `?bench=1` none of it exists.
// M6b-U9 (M6b contract, sections 3.2, 4.5 and M6b-A12, A13): a "text" tool button (the `text`
// tool, `T`), the text edit caret, selection and composition underline drawn from the
// `textEditOverlay` query (src/m6b-text-edit.ts), re-read on every snapshot change and on each
// `textLayout` session event; `?fixture=text-edit` registers the test font, loads the M6b edit
// fixture at zoom 2 and sets the text tool style to the test font (M6b-Q7 (a)); the test hook's
// `textEdit` member logs DOM focus, prevention, key, input, composition and clipboard events.

const WIDTH = 960;
const HEIGHT = 640;
const TOOLS: readonly ToolName[] = [
  'select',
  'rectangle',
  'ellipse',
  'line',
  'frame',
  'path',
  'text',
];
/** The `?fixture=` documents and the camera each is shown at. */
const FIXTURES: Readonly<
  Record<
    string,
    Readonly<{
      url: string;
      camera: { position: { x: number; y: number }; zoom: number };
      /** Waits for the test font registration before loading (M6a-U5). */
      font?: true;
      /** The text tool style set after loading (M6b-U9). */
      textStyle?: TextStyle;
    }>
  >
> = {
  containers: { url: '/m1-containers.json', camera: { position: { x: -20, y: -20 }, zoom: 2 } },
  'path-edit': { url: '/m3-path-edit.json', camera: { position: { x: 0, y: 0 }, zoom: 1 } },
  symbols: { url: '/m7-symbols.json', camera: { position: { x: -20, y: -20 }, zoom: 2 } },
  text: { url: '/m6a-text.json', camera: { position: { x: -20, y: -20 }, zoom: 2 }, font: true },
  'text-edit': {
    url: '/m6b-text-edit.json',
    camera: { position: { x: 0, y: 0 }, zoom: 2 },
    font: true,
    textStyle: TEXT_EDIT_TOOL_STYLE,
  },
  appearance: { url: '/m4-appearance.json', camera: { position: { x: 0, y: 0 }, zoom: 1 } },
};
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

/**
 * Test hook for the headed P5, M1, M2, M3, M4, M5, M6a, M6b and M7 specs: present only with
 * `?test=1`.
 */
declare global {
  interface Window {
    __p5Host?: Readonly<{
      editor: Editor;
      events: readonly EditorEvent[];
      /** M5 contract, section 5.3; resolves at once without `?persist=1` or autosave. */
      persistence: Readonly<{ flush(): Promise<void> }>;
      /** M6a contract, section 5: the editor's text-dom port and the test font. */
      text: TextTestHook;
      /** M6b-U9: the DOM event log of text edit mode. */
      textEdit: TextEditTestHook;
    }>;
  }
}

/** The page's persistence state for the toolbar and status (section 5.3). */
type PersistenceView = Readonly<{
  /** null without `?persist=1`. */
  status: PersistStatus | null;
  discard(): void;
  /** E26-U6a: the canvas press state; a release starts a write the press held. */
  onPressChange(pressed: boolean): void;
}>;

/**
 * The `pathOverlay` query for the current document and path edit state. The query computes a new
 * value on each call (M3-U2 note 10), so it is memoized on its inputs rather than read through a
 * snapshot selector, which would see a new value on every read.
 */
function usePathOverlay(): PathEditOverlay | null {
  const editor = useEditor();
  const pathEdit = useEditorSelector((snapshot) => snapshot.pathEdit);
  const content = useEditorSelector((snapshot) => snapshot.document);
  const page = useEditorSelector((snapshot) => snapshot.activePage);
  return useMemo(
    () => (pathEdit === null ? null : editor.query({ type: 'pathOverlay' })),
    // The query reads the editor's current state, which these values identify.
    [editor, pathEdit, content, page],
  );
}

/**
 * The `textEditOverlay` query in CSS px, recomputed on every snapshot change and on each
 * `textLayout` session event: a font load moves the caret with no snapshot change (M6b
 * contract, section 4.5), so the generation is counted from the editor's events.
 */
function useTextEditMarkers(): TextEditMarkers | null {
  const editor = useEditor();
  const snapshot = useEditorSelector((value) => value);
  const [layouts, setLayouts] = useState(0);
  useEffect(
    () =>
      editor.subscribe((event) => {
        if (event.type === 'session' && event.field === 'textLayout') setLayouts((n) => n + 1);
      }),
    [editor],
  );
  return useMemo(
    () =>
      snapshot.textEdit === null
        ? null
        : textEditMarkers(editor.query({ type: 'textEditOverlay' }), snapshot.viewport),
    // The query reads the editor's current state, which the snapshot and the count identify.
    [editor, snapshot, layouts],
  );
}

function Toolbar({ onFileStatus }: { onFileStatus: (status: string) => void }) {
  const editor = useEditor();
  const execute = useEditorCommands();
  const tool = useEditorSelector((snapshot) => snapshot.tool);
  const history = useEditorSelector((snapshot) => snapshot.history);
  const selection = useEditorSelector((snapshot) => snapshot.selection);
  const toggleClosed = toggleClosedCommand(usePathOverlay());
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
      <button
        type="button"
        data-testid="toggle-closed"
        disabled={toggleClosed === null}
        onClick={() => {
          if (toggleClosed !== null) execute(toggleClosed);
        }}
      >
        toggle closed
      </button>
      <FileControls onFileStatus={onFileStatus} />
      <ZoomControls />
    </div>
  );
}

/**
 * M5 contract, section 3: "Save file" downloads the envelope text of the committed document and
 * the active page; "Open file" restores a file through `restoreEnvelope` (section 5.2) and shows
 * `code path` on failure, loading nothing.
 */
function FileControls({ onFileStatus }: { onFileStatus: (status: string) => void }) {
  const editor = useEditor();
  const input = useRef<HTMLInputElement>(null);
  const save = () => {
    const blob = new Blob([saveFileText(editor)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = SAVE_FILE_NAME;
    link.click();
    // Revoke well after the click has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    onFileStatus('saved');
  };
  const open = async (file: File) => {
    let text: string;
    try {
      text = await file.text();
    } catch {
      // A host-local status in the `code path` style; not a persistence code.
      onFileStatus('error file.read-failed');
      return;
    }
    const result = restoreEnvelope(editor, text);
    onFileStatus(result.ok ? 'opened' : `error ${result.code} ${result.path}`.trimEnd());
  };
  return (
    <span role="group" aria-label="file" style={{ display: 'flex', gap: 8 }}>
      <button type="button" data-testid="save-file" onClick={save}>
        Save file
      </button>
      <button type="button" data-testid="open-file-button" onClick={() => input.current?.click()}>
        Open file
      </button>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        data-testid="open-file"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          // Clear the input so the same file can be opened again.
          event.currentTarget.value = '';
          if (file !== undefined) void open(file);
        }}
      />
    </span>
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

/**
 * M7 contract, section 5: "symbol", "instance" and "detach" for the selection, in the page row so
 * the toolbar row and the canvas keep their place (the earlier specs measure them). The new
 * source or instance becomes the selection, as a group does; a detach keeps the selection, whose
 * IDs are now frames (section 5.2).
 */
function SymbolControls() {
  const execute = useEditorCommands();
  const selection = useEditorSelector((snapshot) => snapshot.selection);
  // The selected nodes' types as one string, so a detach (same IDs, new type) re-renders.
  const types = useEditorSelector((snapshot) =>
    snapshot.selection.map((id) => snapshot.document.nodes[id]?.type ?? '').join(' '),
  ).split(' ');
  const createSymbol = () => {
    const result = execute({ type: 'createSymbol', ids: selection });
    if (result.ok) execute({ type: 'setSelection', ids: result.ids });
  };
  const createInstance = () => {
    const result = execute({ type: 'createInstance', symbol: selection[0]! });
    if (result.ok) execute({ type: 'setSelection', ids: result.ids });
  };
  return (
    <span role="group" aria-label="symbols" style={{ display: 'flex', gap: 8 }}>
      <button
        type="button"
        data-testid="create-symbol"
        disabled={selection.length === 0}
        onClick={createSymbol}
      >
        symbol
      </button>
      <button
        type="button"
        data-testid="create-instance"
        disabled={selection.length !== 1 || types[0] !== 'symbol'}
        onClick={createInstance}
      >
        instance
      </button>
      <button
        type="button"
        data-testid="detach"
        disabled={selection.length === 0 || types.some((type) => type !== 'instance')}
        onClick={() => execute({ type: 'detachInstances', ids: selection })}
      >
        detach
      </button>
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
  file,
  persistence,
  textFont,
}: {
  errors: readonly string[];
  renderer: string;
  fixture: string;
  file: string;
  persistence: PersistenceView;
  textFont: TestFontStatus;
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
      data-text-font={textFont}
      style={{ padding: 8 }}
    >
      revision {revision}, {count} nodes, {selected} selected
      <span data-testid="scope-label" style={{ display: 'block' }}>
        scope: {scope === null ? 'page' : `${scopeName ?? ''} (${scope})`}
      </span>
      {fixture === 'ignored' && (
        <span data-testid="fixture-ignored" style={{ display: 'block' }}>
          fixture ignored: persist=1 wins over fixture=
        </span>
      )}
      {persistence.status !== null && (
        <span
          data-testid="persist-status"
          data-persist={persistence.status.state}
          data-code={persistence.status.state === 'error' ? persistence.status.code : ''}
          data-path={persistence.status.state === 'error' ? persistence.status.path : ''}
          style={{ display: 'block' }}
        >
          {persistStatusLabel(persistence.status)}{' '}
          {offersDiscard(persistence.status) && (
            <button type="button" data-testid="persist-discard" onClick={persistence.discard}>
              Discard stored document
            </button>
          )}
        </span>
      )}
      {file !== '' && (
        <span data-testid="file-status" style={{ display: 'block' }}>
          file: {file}
        </span>
      )}
      {errors.map((error) => (
        <span key={error} data-testid="error" style={{ display: 'block', color: '#b00' }}>
          {error}
        </span>
      ))}
    </p>
  );
}

function Surface({
  persistence,
  testFont,
  textFont,
}: {
  persistence: PersistenceView;
  testFont: Promise<'loaded' | 'error'> | null;
  textFont: TestFontStatus;
}) {
  const editor = useEditor();
  const execute = useEditorCommands();
  const snapshot = useEditorSelector((value) => value);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [renderer, setRenderer] = useState('pending');
  const [fixture, setFixture] = useState('none');
  const [file, setFile] = useState('');
  const bench = useMemo(() => pageBench(), []);
  const width = bench === null ? WIDTH : BENCH_CANVAS.width;
  const height = bench === null ? HEIGHT : BENCH_CANVAS.height;
  useEffect(() => {
    // E26-U1b: the bench loader, for `?bench=1&doc=` only; persistence does not win over it.
    const doc = bench?.query.doc ?? null;
    if (doc === null) return;
    let live = true;
    setFixture('loading');
    void (async () => {
      try {
        const url = `/e26-bench-doc.json?doc=${doc}`;
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        const document: unknown = await response.json();
        if (!live) return;
        const result = execute({ type: 'loadDocument', document });
        if (!result.ok) throw new Error(`loadDocument: ${result.code} ${result.path ?? ''}`);
        setFixture('bench-loaded');
      } catch (error) {
        if (!live) return;
        setFixture('error');
        setErrors((list) => [...list, String(error)]);
      }
    })();
    return () => {
      live = false;
    };
  }, [bench, execute]);
  useEffect(() => {
    if (bench !== null) return;
    // Section 5.3: with `?persist=1` the fixture is ignored, and the status says so.
    if (persistQuery(window.location.search).fixtureIgnored) {
      setFixture('ignored');
      return;
    }
    const name = new URLSearchParams(window.location.search).get('fixture');
    const entry = name === null || !Object.hasOwn(FIXTURES, name) ? undefined : FIXTURES[name];
    if (entry === undefined) return;
    const { url, camera, font, textStyle } = entry;
    let live = true;
    setFixture('loading');
    void (async () => {
      try {
        // M6a-U5: the fixture loads after the test font settles, loaded or not (the status shows
        // which), so its first layouts see the registered face.
        if (font === true && testFont !== null) await testFont;
        if (!live) return;
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        const document: unknown = await response.json();
        if (!live) return;
        const result = execute({ type: 'loadDocument', document });
        if (!result.ok) throw new Error(`loadDocument: ${result.code} ${result.path ?? ''}`);
        execute({ type: 'setViewport', camera });
        if (textStyle !== undefined) execute({ type: 'setTextToolStyle', style: textStyle });
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
  }, [bench, execute, testFont]);
  // The handle box follows the snapshot: this component re-renders on every editor change.
  const handles = editor.query({ type: 'handles' });
  const pathOverlay = usePathOverlay();
  const textEdit = useTextEditMarkers();
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
      <Toolbar onFileStatus={setFile} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Pages />
        <SymbolControls />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div
          data-testid="canvas-host"
          data-cursor={rotating ? 'rotate' : 'default'}
          style={{ width, cursor: rotating ? ROTATE_CURSOR : undefined }}
          onPointerMove={hover}
          onPointerLeave={() => setRotating(false)}
        >
          <EditorCanvas
            width={width}
            height={height}
            createRenderer={createWebGpuRenderer}
            onRendererError={(error) => {
              setRenderer('error');
              setErrors((list) => [...list, String(error)]);
            }}
            onRendererReady={() => setRenderer('ready')}
            onPressChange={persistence.onPressChange}
            style={{ border: '1px solid #ccc' }}
          >
            <SelectionOverlay
              snapshot={snapshot}
              handles={handles}
              pathOverlay={pathOverlay}
              textEdit={textEdit}
              width={width}
              height={height}
            />
          </EditorCanvas>
        </div>
        <AppearancePanel />
      </div>
      <Status
        errors={errors}
        renderer={renderer}
        fixture={fixture}
        file={file}
        persistence={persistence}
        textFont={textFont}
      />
    </>
  );
}

/**
 * Section 5.3: with `?persist=1`, open the store, restore, then attach autosave. The effect's
 * cleanup unsubscribes, disposes the autosave and closes the store, so a strict-mode remount
 * leaves one subscription and one connection. A hidden page flushes, best effort.
 */
function usePersistence(
  editor: Editor,
  baseRevision: number,
): PersistenceView & Readonly<{ session: { current: PersistenceSession | null } }> {
  const [status, setStatus] = useState<PersistStatus | null>(null);
  const session = useRef<PersistenceSession | null>(null);
  // E26-U6a: no autosave write starts while a canvas press is in progress.
  const gate = useMemo(() => createPressGate(() => session.current), []);
  useEffect(() => {
    if (!persistQuery(window.location.search).persist) return;
    // E26-U1b: a bench run restores from its own empty database and records its writes.
    const bench = pageBench();
    const current = attachPersistence(editor, {
      baseRevision,
      onStatus: setStatus,
      pressed: gate.pressed,
      ...(bench === null
        ? {}
        : {
            databaseName: benchDatabaseName(PERSIST_DATABASE_NAME),
            wrapStore: (store) => bench.wrapStore(store),
          }),
    });
    session.current = current;
    const hidden = () => {
      if (document.visibilityState === 'hidden') void current.flush();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      gate.cancel();
      current.dispose();
      if (session.current === current) session.current = null;
    };
  }, [editor, baseRevision, gate]);
  return {
    status,
    discard: () => void session.current?.discard(),
    onPressChange: gate.onPressChange,
    session,
  };
}

/** The page once its editor exists: the persistence, the test hook and the surface. */
function Host({ state, textFont }: { state: HostCompositionState; textFont: TestFontStatus }) {
  const { editor } = state.composition;
  // The revision when the page loaded (section 5.3: the attach saves edits made during the read).
  const baseRevision = useMemo(() => editor.getSnapshot().revision, [editor]);
  const persistence = usePersistence(editor, baseRevision);
  const { session } = persistence;
  useEffect(() => {
    const bench = pageBench();
    if (bench === null) return;
    bench.setEditor(editor);
    return () => bench.setEditor(null);
  }, [editor]);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('test') !== '1') return;
    const events: EditorEvent[] = [];
    const unsubscribe = editor.subscribe((event) => events.push(event));
    const textEdit = createTextEditLog(window, () => document.activeElement);
    window.__p5Host = {
      editor,
      events,
      persistence: { flush: () => session.current?.flush() ?? Promise.resolve() },
      text: textTestHook(state),
      textEdit: textEdit.hook,
    };
    return () => {
      unsubscribe();
      textEdit.dispose();
      delete window.__p5Host;
    };
  }, [editor, session, state]);
  return (
    <EditorProvider editor={editor}>
      <main>
        <Surface persistence={persistence} testFont={state.testFont} textFont={textFont} />
      </main>
    </EditorProvider>
  );
}

/**
 * M6a contract, section 5: the editor and its text-dom port are created in a client effect, so
 * the server and the first client render show a placeholder; the cleanup disposes the pair (under
 * strict mode the first pair is disposed and the second kept).
 */
export default function Page() {
  const [state, setState] = useState<HostCompositionState | null>(null);
  const [textFont, setTextFont] = useState<TestFontStatus>('none');
  const [hostError, setHostError] = useState<string | null>(null);
  useEffect(() => {
    let published: HostCompositionState | null = null;
    const cleanup = runHostEffect(
      {
        document,
        platform: hostPlatform(),
        textFixture: textFixtureQuery(window.location.search),
        publish: (value) => {
          published = value;
          setState(value);
        },
        onFontStatus: setTextFont,
      },
      setHostError,
    );
    return () => {
      cleanup();
      // No render keeps the disposed pair: a replacement published in the same flush wins.
      setState((current) => (current === published ? null : current));
    };
  }, []);
  if (state === null) {
    return (
      <main>
        <p
          data-testid="host-pending"
          data-host-error={hostError ?? undefined}
          style={{ padding: 8 }}
        >
          {hostError === null ? 'loading editor' : `editor failed: ${hostError}`}
        </p>
      </main>
    );
  }
  // Keyed per composition, so a replaced editor (Fast Refresh) resets the surface's state.
  return <Host key={state.id} state={state} textFont={textFont} />;
}
