import type { RenderCamera } from '@vector-studio/contracts';
import type {
  Color,
  DocumentV1,
  FillRule,
  Frame,
  JsonValue,
  ModelErrorCode,
  NodeV1,
  PathStroke,
  PathVerb,
  RectStroke,
} from '@vector-studio/model';

// Public command, query and event shapes (P5 plan, sections 4.1 to 4.3).

export type ToolName = 'select' | 'rectangle' | 'path';

export type PagePoint = Readonly<{ x: number; y: number }>;
export type Modifiers = Readonly<{ shift: boolean; alt: boolean; meta: boolean; ctrl: boolean }>;

/** Pointer and key input for the active tool, with page-space points. */
export type InputEvent =
  | Readonly<{
      kind: 'pointerdown' | 'pointermove' | 'pointerup';
      point: PagePoint;
      modifiers: Modifiers;
    }>
  | Readonly<{ kind: 'keydown'; key: string; modifiers: Modifiers }>;

export type NodeProps = Readonly<{
  name?: string;
  fill?: Color | null;
  stroke?: RectStroke | PathStroke | null;
  opacity?: number;
  visible?: boolean;
  /** Custom nodes only. */
  data?: JsonValue;
}>;

/** Commands that change the document; each successful one is one transaction. */
export type DocumentCommand =
  | Readonly<{
      type: 'createRectangle';
      frame: Frame;
      name?: string;
      fill?: Color | null;
      stroke?: RectStroke | null;
    }>
  | Readonly<{
      type: 'createPath';
      verbs: readonly PathVerb[];
      /** Interleaved page-space x, y; the frame is their bounding box (plan section 3.1). */
      points: readonly number[];
      fillRule?: FillRule;
      name?: string;
      fill?: Color | null;
      stroke?: PathStroke | null;
    }>
  | Readonly<{ type: 'setFrames'; frames: readonly Readonly<{ id: string; frame: Frame }>[] }>
  | Readonly<{ type: 'setNodeProps'; id: string; props: NodeProps }>
  | Readonly<{ type: 'deleteNodes'; ids: readonly string[] }>;

/** Commands that are never recorded in history. */
export type SessionCommand =
  | Readonly<{ type: 'setSelection'; ids: readonly string[] }>
  | Readonly<{ type: 'setTool'; tool: ToolName }>
  | Readonly<{ type: 'setViewport'; camera: RenderCamera }>
  | Readonly<{ type: 'input'; event: InputEvent }>;

export type Command =
  | DocumentCommand
  | SessionCommand
  | Readonly<{ type: 'loadDocument'; document: unknown }>
  | Readonly<{ type: 'undo' }>
  | Readonly<{ type: 'redo' }>;

/** Model codes come from `loadDocument` and from node validation in commands. */
export type EditorErrorCode =
  | ModelErrorCode
  | 'editor.invalid-command'
  | 'editor.unknown-node'
  | 'editor.unknown-tool'
  | 'editor.duplicate-id'
  | 'editor.nothing-to-undo'
  | 'editor.nothing-to-redo'
  | 'editor.invalid-camera';

export type CommandResult =
  | Readonly<{ ok: true; ids: readonly string[] }>
  | Readonly<{ ok: false; code: EditorErrorCode; path?: string }>;

export type HistoryState = Readonly<{ undoDepth: number; redoDepth: number }>;

export type EditorSnapshot = Readonly<{
  document: DocumentV1;
  /** Increases by one for every document change, including gesture updates, undo and redo. */
  revision: number;
  selection: readonly string[];
  tool: ToolName;
  viewport: RenderCamera;
  history: HistoryState;
}>;

export type Query =
  | Readonly<{ type: 'document' }>
  | Readonly<{ type: 'node'; id: string }>
  | Readonly<{ type: 'selection' }>
  | Readonly<{ type: 'tool' }>
  | Readonly<{ type: 'viewport' }>
  | Readonly<{ type: 'history' }>
  | Readonly<{ type: 'revision' }>;

export type QueryResult<Q extends Query> = Q extends { type: 'document' }
  ? DocumentV1
  : Q extends { type: 'node' }
    ? NodeV1 | null
    : Q extends { type: 'selection' }
      ? readonly string[]
      : Q extends { type: 'tool' }
        ? ToolName
        : Q extends { type: 'viewport' }
          ? RenderCamera
          : Q extends { type: 'history' }
            ? HistoryState
            : number;

export type DocumentChangeCause =
  'command' | 'gesture-update' | 'gesture-commit' | 'gesture-cancel' | 'undo' | 'redo' | 'load';

export type EditorEvent =
  | Readonly<{
      type: 'document';
      cause: DocumentChangeCause;
      revision: number;
      /** IDs of the nodes the change created, changed or removed, sorted. */
      touched: readonly string[];
    }>
  | Readonly<{ type: 'session'; field: 'selection' | 'tool' | 'viewport' }>;

export interface Editor {
  execute(command: Command): CommandResult;
  query<Q extends Query>(query: Q): QueryResult<Q>;
  /** The listener runs after each change; the returned function unsubscribes. */
  subscribe(listener: (event: EditorEvent) => void): () => void;
  /** An immutable value, replaced on every change (for `useSyncExternalStore`). */
  getSnapshot(): EditorSnapshot;
}

/** Returns a fresh ID on each call; IDs it returns that already exist are skipped. */
export type IdSource = () => string;
