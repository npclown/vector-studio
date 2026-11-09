import type { Command, DocumentV7, EditorSnapshot, Frame } from '@vector-studio/editor-core';
import {
  useActivePage,
  useEditorCommands,
  useEditorSelector,
  useSelection,
  useTool,
  useViewport,
} from '@vector-studio/react';
import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { nodePageCorners } from './m2-geometry';

// V-25 slice 2 (artboards): an artboard is a top-level frame of the active page, as in Figma; no
// new node type or schema field (V-25 plan). The studio layout shows each artboard's name above
// its top-left corner on the canvas (click selects, Shift or Mod toggles, double-click renames),
// lists the artboards in the left sidebar (click selects and zooms to it), and offers size presets
// while the frame tool is active (a click creates the artboard beside the others). Every edit is
// one public command, so one undo step; the zoom and selection are session commands.

/** One artboard: a top-level frame of the active page, front first. */
export type Artboard = Readonly<{ id: string; name: string; frame: Frame }>;

/** The active page's artboards (its top-level frames), front first like the layer tree. */
export function artboardsOf(document: DocumentV7, page: string): readonly Artboard[] {
  const children = document.pages.find((entry) => entry.id === page)?.children ?? [];
  const boards: Artboard[] = [];
  for (const id of [...children].reverse()) {
    const node = document.nodes[id];
    if (node?.type === 'frame') boards.push({ id, name: node.name, frame: node.frame });
  }
  return boards;
}

/** A frame size preset. */
export type ArtboardPreset = Readonly<{ name: string; width: number; height: number }>;

/** The frame tool's size presets, in page units (CSS px for screens, points for paper). */
export const ARTBOARD_PRESETS: readonly ArtboardPreset[] = Object.freeze([
  { name: 'Desktop', width: 1440, height: 1024 },
  { name: 'Laptop', width: 1280, height: 832 },
  { name: 'Tablet', width: 834, height: 1194 },
  { name: 'Phone', width: 393, height: 852 },
  { name: 'A4', width: 595, height: 842 },
  { name: 'Letter', width: 612, height: 792 },
  { name: 'Square', width: 1080, height: 1080 },
]);

/** The gap between a new artboard and the ones beside it, in page units. */
export const ARTBOARD_GAP = 100;

/**
 * Where a new artboard of `width` × `height` goes: right of the page's top-level frames' bounds
 * (axis-aligned, rotation ignored), top-aligned with them, `ARTBOARD_GAP` apart; with none, centred
 * in the view (or at the origin before the view has a size).
 */
export function newArtboardFrame(
  boards: readonly Artboard[],
  width: number,
  height: number,
  view: Readonly<{ x: number; y: number; zoom: number; width: number; height: number }> | null,
): Frame {
  if (boards.length > 0) {
    const right = Math.max(...boards.map((board) => board.frame.x + board.frame.width));
    const top = Math.min(...boards.map((board) => board.frame.y));
    return { x: right + ARTBOARD_GAP, y: top, width, height };
  }
  if (view === null) return { x: 0, y: 0, width, height };
  const cx = view.x + view.width / view.zoom / 2;
  const cy = view.y + view.height / view.zoom / 2;
  return { x: Math.round(cx - width / 2), y: Math.round(cy - height / 2), width, height };
}

/** The commands that create a preset artboard: the frame, then (session) select it and fit. */
export function presetCommands(
  preset: ArtboardPreset,
  frame: Frame,
): Readonly<{ create: Command; after: (id: string) => readonly Command[] }> {
  return {
    create: { type: 'createFrame', frame, name: preset.name },
    after: (id) => [
      { type: 'setSelection', ids: [id] },
      { type: 'setTool', tool: 'select' },
      { type: 'zoomTo', target: 'selection' },
    ],
  };
}

/** A selection click on an artboard: Shift or Mod toggles it in the selection, else selects it. */
export function artboardClickIds(
  selection: readonly string[],
  id: string,
  toggle: boolean,
): readonly string[] {
  if (!toggle) return [id];
  return selection.includes(id) ? selection.filter((entry) => entry !== id) : [...selection, id];
}

/** A rename: the trimmed name, or null when it is empty or unchanged (nothing is sent). */
export function renameCommand(board: Artboard, value: string): Command | null {
  const name = value.trim();
  if (name === '' || name === board.name) return null;
  return { type: 'setNodeProps', id: board.id, props: { name } };
}

/**
 * The rename guard: `open` starts an opening for an artboard; the first `close` of that opening
 * returns its command (`value` null cancels, giving null) and ends it, so a later close of the
 * same opening (the blur of a textbox that Enter or Escape already closed) returns null.
 */
export function createRenameGuard() {
  let open: string | null = null;
  return {
    open(id: string): void {
      open = id;
    },
    close(board: Artboard, value: string | null): Command | null {
      if (open !== board.id) return null;
      open = null;
      return value === null ? null : renameCommand(board, value);
    },
  };
}

const documentOf = (snapshot: EditorSnapshot) => snapshot.document;
const toggles = (event: MouseEvent) => event.shiftKey || event.ctrlKey || event.metaKey;

function useArtboards(): readonly Artboard[] {
  const document = useEditorSelector(documentOf);
  const page = useActivePage();
  return artboardsOf(document, page);
}

/**
 * The artboard names over the canvas, each at its artboard's top-left corner in canvas CSS px
 * (rotated artboards included, label unrotated), above the canvas overlay. Only the labels take
 * pointer events.
 */
export function ArtboardLabels() {
  const execute = useEditorCommands();
  const document = useEditorSelector(documentOf);
  const boards = useArtboards();
  const selection = useSelection();
  const { position, zoom } = useViewport();
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  // Enter or Escape closes the textbox, and the browser then blurs it as it unmounts: the guard
  // lets only the first close of an opening act (as `useRename` in packages/ui/src/layers.tsx).
  const [guard] = useState(createRenameGuard);
  const layer = useRef<HTMLDivElement>(null);
  /**
   * Gives the keyboard back to the canvas, so shortcuts work after a label click or rename. The
   * labels are mounted as the canvas host's sibling inside the studio's canvas cell (v25-studio.tsx),
   * so the cell holds the one canvas.
   */
  const focusCanvas = () => layer.current?.parentElement?.querySelector('canvas')?.focus();
  /** Ends a rename; `refocus` (Enter, Escape, or a blur to nowhere) returns focus to the canvas. */
  const close = (board: Artboard, value: string | null, refocus: boolean) => {
    const command = guard.close(board, value);
    setRenaming(null);
    if (command !== null) execute(command);
    if (refocus) focusCanvas();
  };
  return (
    <div
      ref={layer}
      className="vs-artboard-labels"
      data-testid="artboard-labels"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      {boards.map((board) => {
        const corner = nodePageCorners(document, board.id)?.[0];
        if (corner === undefined) return null;
        const left = (corner.x - position.x) * zoom;
        const top = (corner.y - position.y) * zoom;
        const style = {
          position: 'absolute',
          left,
          top,
          transform: 'translateY(-100%)',
          pointerEvents: 'auto',
          maxWidth: Math.max(48, board.frame.width * zoom),
        } as const;
        if (renaming?.id === board.id) {
          return (
            <input
              key={board.id}
              aria-label="artboard name"
              className="vs-artboard-input"
              autoFocus
              value={renaming.value}
              style={style}
              onChange={(event) => setRenaming({ id: board.id, value: event.target.value })}
              onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                if (event.key === 'Enter') close(board, renaming.value, true);
                else if (event.key === 'Escape') close(board, null, true);
              }}
              // A blur to another control (a field the user clicked) leaves focus there.
              onBlur={(event) => close(board, renaming.value, event.relatedTarget === null)}
            />
          );
        }
        return (
          <button
            key={board.id}
            type="button"
            className="vs-artboard-label"
            data-testid={`artboard-label-${board.id}`}
            aria-pressed={selection.includes(board.id)}
            title={`${board.name} (${board.frame.width} × ${board.frame.height})`}
            style={style}
            // The label never takes focus from the canvas, so the canvas shortcuts keep working.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              execute({
                type: 'setSelection',
                ids: artboardClickIds(selection, board.id, toggles(event)),
              });
              focusCanvas();
            }}
            onDoubleClick={() => {
              guard.open(board.id);
              setRenaming({ id: board.id, value: board.name });
            }}
          >
            {board.name}
          </button>
        );
      })}
    </div>
  );
}

/** The left sidebar's artboard list: a click selects the artboard and zooms to it. */
export function ArtboardList() {
  const execute = useEditorCommands();
  const boards = useArtboards();
  const selection = useSelection();
  if (boards.length === 0) {
    return (
      <p className="vs-empty">No artboards yet. Press F or pick a size with the frame tool.</p>
    );
  }
  return (
    <ul className="vs-artboard-list" aria-label="artboards">
      {boards.map((board) => (
        <li key={board.id}>
          <button
            type="button"
            data-testid={`artboard-${board.id}`}
            aria-pressed={selection.includes(board.id)}
            onClick={() => {
              execute({ type: 'setSelection', ids: [board.id] });
              execute({ type: 'zoomTo', target: 'selection' });
            }}
          >
            <span>{board.name}</span>
            <span className="vs-muted">
              {Math.round(board.frame.width)} × {Math.round(board.frame.height)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The frame tool's size presets, shown at the top of the right sidebar while it is active. */
export function ArtboardPresets() {
  const execute = useEditorCommands();
  const tool = useTool();
  const boards = useArtboards();
  const viewport = useViewport();
  const size = useEditorSelector((snapshot) => snapshot.viewportSize);
  if (tool !== 'frame') return null;
  const view =
    size === null
      ? null
      : { x: viewport.position.x, y: viewport.position.y, zoom: viewport.zoom, ...size };
  return (
    <section className="vs-presets" aria-label="Frame presets" data-testid="artboard-presets">
      <h2 className="vs-heading">Frame</h2>
      <p className="vs-hint">Drag on the canvas, or pick a size:</p>
      {ARTBOARD_PRESETS.map((preset) => (
        <button
          key={preset.name}
          type="button"
          data-testid={`artboard-preset-${preset.name}`}
          onClick={() => {
            const { create, after } = presetCommands(
              preset,
              newArtboardFrame(boards, preset.width, preset.height, view),
            );
            const result = execute(create);
            if (!result.ok) return;
            for (const command of after(result.ids[0]!)) execute(command);
          }}
        >
          <span>{preset.name}</span>
          <span className="vs-muted">
            {preset.width} × {preset.height}
          </span>
        </button>
      ))}
    </section>
  );
}
