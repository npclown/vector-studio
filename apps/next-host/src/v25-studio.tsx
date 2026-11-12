import {
  EditorPanels,
  EditorToolbar,
  ExportPanel,
  ImportPanel,
  LayerTree,
  PageList,
  PropertyPanel,
  StylesPanel,
  ZoomMenu,
  useEditorSelector,
  usePanelErrors,
} from '@vector-studio/ui';
import { useEffect, useState, type ReactNode } from 'react';
import { ArtboardLabels, ArtboardList, ArtboardPresets } from './v25-artboards';
import { PathDebugPanel } from './v25-path-debug';
import { ViewToggles } from './v38-rulers';

// V-25 (editor UI usability, slice 1): next-host's full-window "studio" layout, the default for a
// person opening the page. The canvas fills the space between a top bar (file controls, the
// icon toolbar, the zoom menu), a left sidebar (pages, artboards, then the layer tree filling the
// rest; slice 2 adds the artboards, src/v25-artboards.tsx) and
// a right sidebar (properties, then the extension panels), with a one-line status bar below.
// `?test=1`, `?bench=1` and `?layout=legacy` keep the M8 layout, so every headed spec, the
// M8-N3 budget and the bench measurements see the page they were written for. V-30:
// `?test=1&layout=studio` shows the studio with the test hook, for the studio's own specs.

/**
 * Whether the page shows the studio layout: not under `?test=1`, `?bench=1` or `?layout=legacy`,
 * except `?test=1&layout=studio` (V-30's export spec).
 */
export function studioLayout(search: string): boolean {
  const query = new URLSearchParams(search);
  if (query.get('test') === '1' && query.get('layout') === 'studio') return true;
  return (
    query.get('test') !== '1' && query.get('bench') !== '1' && query.get('layout') !== 'legacy'
  );
}

/** A canvas size in whole CSS px. */
export type StudioCanvasSize = Readonly<{ width: number; height: number }>;

/** The smallest canvas the studio creates, so a collapsed window keeps a renderer. */
const MIN_CANVAS = 64;
/** Resizes settle this long before the canvas follows (each size change recreates its renderer). */
const RESIZE_SETTLE_MS = 120;

/** The whole-pixel canvas size for a cell of `width` × `height` CSS px. */
export function canvasSizeFor(width: number, height: number): StudioCanvasSize {
  return {
    width: Math.max(MIN_CANVAS, Math.floor(width)),
    height: Math.max(MIN_CANVAS, Math.floor(height)),
  };
}

/** The element's content size, following resizes once they settle; null before it is measured. */
function useSettledSize(): [(element: HTMLDivElement | null) => void, StudioCanvasSize | null] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [size, setSize] = useState<StudioCanvasSize | null>(null);
  useEffect(() => {
    if (element === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const measure = () => {
      const next = canvasSizeFor(element.clientWidth, element.clientHeight);
      setSize((current) =>
        current !== null && current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(measure, RESIZE_SETTLE_MS);
    });
    observer.observe(element);
    return () => {
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
    };
  }, [element]);
  return [setElement, size];
}

/** What the status bar shows besides the editor's own state; repeated errors show once. */
export type StudioStatusProps = Readonly<{
  errors: readonly string[];
  /** The persistence status label and its discard control, when there is one. */
  persistence: ReactNode;
  /** The last file action's status, or ''. */
  file: string;
}>;

function StudioStatus({ errors, persistence, file }: StudioStatusProps) {
  const count = useEditorSelector(
    (snapshot) =>
      snapshot.document.pages.find((value) => value.id === snapshot.activePage)?.children.length ??
      0,
  );
  const selected = useEditorSelector((snapshot) => snapshot.selection.length);
  const scopeName = useEditorSelector((snapshot) =>
    snapshot.scope === null ? null : (snapshot.document.nodes[snapshot.scope]?.name ?? ''),
  );
  const panelErrors = usePanelErrors();
  return (
    <footer className="vs-status" data-testid="studio-status">
      <span>
        {count} {count === 1 ? 'layer' : 'layers'}
        {selected > 0 ? `, ${selected} selected` : ''}
      </span>
      {scopeName === null ? null : <span>Inside {scopeName} (Esc to leave)</span>}
      {persistence}
      {file === '' ? null : <span>File {file}</span>}
      {[...new Set([...errors, ...panelErrors.map((error) => `${error.code} ${error.panel}`)])].map(
        (error) => (
          <span key={error} className="vs-error">
            {error}
          </span>
        ),
      )}
    </footer>
  );
}

/** Props of `StudioShell`. */
export type StudioShellProps = StudioStatusProps &
  Readonly<{
    /** The canvas host for a canvas of `size`. */
    canvas: (size: StudioCanvasSize) => ReactNode;
    /** The host's file controls, at the start of the top bar. */
    fileControls: ReactNode;
  }>;

/** The studio layout (V-25); see the module comment. */
export function StudioShell({ canvas, fileControls, ...status }: StudioShellProps) {
  const [cell, size] = useSettledSize();
  // V-39 U4: the Local styles panel takes the right column when nothing is selected.
  const nothingSelected = useEditorSelector((snapshot) => snapshot.selection.length === 0);
  return (
    <div className="vs-studio" data-testid="studio">
      <style>{STUDIO_CSS}</style>
      <header className="vs-topbar">
        <div className="vs-topbar-start">
          <strong className="vs-brand">Vector Studio</strong>
          {fileControls}
        </div>
        <EditorToolbar />
        <div className="vs-topbar-end">
          <ViewToggles />
          <ZoomMenu />
        </div>
      </header>
      <aside className="vs-left" aria-label="pages, artboards and layers">
        <section className="vs-pages">
          <h2 className="vs-heading">Pages</h2>
          <PageList />
        </section>
        <section className="vs-artboards">
          <h2 className="vs-heading">Artboards</h2>
          <ArtboardList />
        </section>
        <section className="vs-layers">
          <h2 className="vs-heading">Layers</h2>
          <LayerTree height="100%" />
        </section>
      </aside>
      <div ref={cell} className="vs-canvas" data-testid="studio-canvas">
        {size === null ? null : canvas(size)}
        {size === null ? null : <ArtboardLabels />}
      </div>
      <aside className="vs-right" aria-label="design">
        <ArtboardPresets />
        <PropertyPanel />
        {nothingSelected && <StylesPanel />}
        <PathDebugPanel />
        <EditorPanels />
        <ImportPanel />
        <ExportPanel />
      </aside>
      <StudioStatus {...status} />
    </div>
  );
}

// The studio's styles, scoped under `.vs-studio`. The UI package's components carry inline
// layout styles only, so these give them the studio's look: flat controls, one accent colour,
// compact rows. Light theme only in this slice.
const STUDIO_CSS = `
.vs-studio {
  --vs-bg: #ffffff;
  --vs-canvas-bg: #e8e8e8;
  --vs-border: #e2e2e2;
  --vs-text: #1e1e1e;
  --vs-muted: #737373;
  --vs-hover: #f0f0f0;
  --vs-accent: #0d99ff;
  --vs-accent-soft: #e5f4ff;
  --vs-danger: #c4302b;
  position: fixed;
  inset: 0;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr) 280px;
  grid-template-rows: 44px minmax(0, 1fr) 24px;
  grid-template-areas: 'top top top' 'left canvas right' 'status status status';
  background: var(--vs-bg);
  color: var(--vs-text);
  font: 12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
}
.vs-studio button {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 2px 6px;
  cursor: pointer;
}
.vs-studio button:hover:not(:disabled) { background: var(--vs-hover); }
.vs-studio button:disabled { color: #c4c4c4; cursor: default; }
.vs-studio button[aria-pressed='true'] { background: var(--vs-accent-soft); color: var(--vs-accent); }
.vs-studio button:focus-visible { outline: 2px solid var(--vs-accent); outline-offset: -2px; }
.vs-studio input, .vs-studio select {
  font: inherit;
  color: inherit;
  border: 1px solid var(--vs-border);
  border-radius: 4px;
  padding: 2px 4px;
  background: var(--vs-bg);
  min-width: 0;
}
.vs-studio input:hover, .vs-studio select:hover { border-color: #c4c4c4; }
.vs-studio input:focus, .vs-studio select:focus { outline: none; border-color: var(--vs-accent); }
.vs-studio input[aria-invalid='true'] { border-color: var(--vs-danger); }
.vs-studio fieldset { border: 0; border-top: 1px solid var(--vs-border); margin: 0; padding: 8px 12px; }
.vs-studio legend { font-weight: 600; padding: 0; }
.vs-studio h2 { font-size: inherit; }

.vs-topbar {
  grid-area: top;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border-bottom: 1px solid var(--vs-border);
}
.vs-topbar-start, .vs-topbar-end { display: flex; align-items: center; gap: 4px; min-width: 0; }
.vs-topbar-end { justify-content: flex-end; }
.vs-topbar-start button { white-space: nowrap; }
.vs-brand { font-size: 13px; margin-right: 8px; white-space: nowrap; }
.vs-icon-button { width: 32px; height: 32px; display: grid; place-items: center; padding: 0 !important; }
.vs-icon-text { font-size: 11px; max-width: 30px; overflow: hidden; text-overflow: ellipsis; }
.vs-divider { width: 1px; height: 20px; margin: 0 4px; background: var(--vs-border); }
.vs-refusal { color: var(--vs-danger); margin-left: 8px; white-space: nowrap; }
.vs-zoom-button { min-width: 64px; }
.vs-menu {
  display: flex;
  flex-direction: column;
  min-width: 200px;
  margin-top: 4px;
  padding: 4px;
  background: #1e1e1e;
  color: #fff;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}
.vs-menu .vs-menu-item { display: flex; justify-content: space-between; gap: 16px; padding: 6px 8px; text-align: left; }
.vs-menu .vs-menu-item:hover:not(:disabled) { background: var(--vs-accent); }
.vs-menu .vs-menu-item:disabled { color: #6b6b6b; }
.vs-menu-shortcut { opacity: 0.6; }
.vs-menu-separator { height: 1px; margin: 4px 0; background: #3a3a3a; }
.vs-context-menu { min-width: 220px; }

.vs-left, .vs-right { min-height: 0; overflow-y: auto; background: var(--vs-bg); }
.vs-left {
  grid-area: left;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--vs-border);
}
.vs-right { grid-area: right; border-left: 1px solid var(--vs-border); }
.vs-path-debug { border-top: 1px solid var(--vs-border); padding: 4px 12px 8px; }
.vs-path-debug .vs-heading { display: flex; justify-content: space-between; padding: 6px 0; }
.vs-path-debug textarea { width: 100%; box-sizing: border-box; font: 11px/1.3 ui-monospace, monospace; resize: vertical; }
.vs-heading { margin: 0; padding: 10px 12px 6px; font-weight: 600; }
.vs-pages { border-bottom: 1px solid var(--vs-border); padding-bottom: 6px; max-height: 40%; overflow-y: auto; }
.vs-pages [role='group'][aria-label='pages'] { flex-direction: column; align-items: stretch; gap: 0 !important; padding: 0 4px !important; }
.vs-pages nav { flex-direction: column; gap: 0 !important; }
.vs-pages nav button { text-align: left; padding: 4px 8px; }
.vs-pages [role='group'][aria-label='pages'] > button { text-align: left; color: var(--vs-muted); }
.vs-artboards { border-bottom: 1px solid var(--vs-border); padding-bottom: 6px; max-height: 30%; overflow-y: auto; }
.vs-artboard-list { list-style: none; margin: 0; padding: 0 4px; }
.vs-artboard-list button, .vs-presets button { display: flex; width: 100%; justify-content: space-between; gap: 8px; text-align: left; padding: 4px 8px; }
.vs-muted { color: var(--vs-muted); font-size: 11px; }
.vs-empty, .vs-hint { margin: 0; padding: 0 12px 6px; color: var(--vs-muted); }
.vs-presets { border-bottom: 1px solid var(--vs-border); padding: 0 4px 8px; }
.vs-presets .vs-heading { padding-left: 8px; padding-right: 8px; }
.vs-presets .vs-hint { padding: 0 8px 4px; }
.vs-artboard-label {
  font-size: 11px !important;
  color: var(--vs-muted) !important;
  background: transparent !important;
  padding: 0 0 2px !important;
  border: 0 !important;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.vs-artboard-label:hover, .vs-artboard-label[aria-pressed='true'] { color: var(--vs-accent) !important; }
.vs-artboard-input { font-size: 11px !important; padding: 0 2px !important; }
.vs-layers { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.vs-layers > [data-testid='layers'] { flex: 1; min-height: 0; }
.vs-layers [role='toolbar'][aria-label='arrange'] { padding: 0 8px 4px; gap: 2px !important; flex-wrap: wrap; }
.vs-layers [role='toolbar'][aria-label='arrange'] button { color: var(--vs-muted); }
.vs-layers li { align-items: center; gap: 4px !important; padding-right: 4px; }
.vs-layers li:hover { background: var(--vs-hover); }
.vs-layers li[data-selected='true'] { background: var(--vs-accent-soft); }
.vs-layers li > button[data-testid^='layer-name-'] {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: transparent !important;
  color: inherit !important;
}
.vs-layers li > button[data-testid^='layer-name-']:first-child { margin-left: 16px; }
.vs-layers li > button[data-testid^='layer-toggle-'] { width: 16px; padding: 0; color: var(--vs-muted); }
.vs-layers li > span { color: var(--vs-muted); font-size: 11px; }
/* V31-U1: lock and eye buttons, revealed on hover or focus by opacity; an active one stays. */
.vs-layers li > button[data-layer-flag] {
  width: 20px;
  height: 20px;
  padding: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vs-muted);
  background: transparent !important;
  opacity: 0;
}
.vs-layers li:hover > button[data-layer-flag],
.vs-layers li:focus-within > button[data-layer-flag],
.vs-layers li > button[data-layer-flag][data-active='true'] { opacity: 1; }
.vs-layers li > button[data-layer-flag]:hover { color: inherit; }
.vs-layers [data-layer-flag-text] {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.vs-layers li > input { flex: 1; width: auto !important; }

.vs-right [data-testid='appearance-panel'] > p { padding: 12px; color: var(--vs-muted); margin: 0; }
.vs-right section[data-panel] button { text-align: left; }
[data-testid='styles-panel'] { padding: 4px 12px 8px; }
.vs-right section[data-panel] { border-top: 1px solid var(--vs-border); padding: 4px 12px 8px; }
.vs-right section[data-panel] > h2 button { padding: 6px 0; font-weight: 600; }

.vs-canvas {
  grid-area: canvas;
  position: relative;
  overflow: hidden;
  background: var(--vs-canvas-bg);
}
.vs-canvas canvas { border: 0 !important; }

.vs-status {
  grid-area: status;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 12px;
  border-top: 1px solid var(--vs-border);
  color: var(--vs-muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
}
.vs-status button { font-size: 11px; padding: 0 4px; border: 1px solid var(--vs-border); }
.vs-error { color: var(--vs-danger); }
`;
