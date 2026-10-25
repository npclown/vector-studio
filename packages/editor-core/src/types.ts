import type {
  RenderCamera,
  RendererSceneSynchronization,
  ScenePathGeometry,
  SceneRejectionReason,
} from '@vector-studio/contracts';
import type {
  Color,
  DocumentErrorCode,
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

/** A path-tool anchor; `in` and `out` are its handles, null for a corner. */
export type PathAnchor = Readonly<{
  point: PagePoint;
  in: PagePoint | null;
  out: PagePoint | null;
}>;

/** Tool state the host UI draws over the canvas; it is never document content. */
export type ToolOverlay =
  | Readonly<{ kind: 'marquee'; frame: Frame }>
  | Readonly<{ kind: 'path'; anchors: readonly PathAnchor[] }>;

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
  | Readonly<{
      type: 'createCustomNode';
      customType: string;
      frame: Frame;
      /** Defaults to the extension's `defaults()`. */
      data?: JsonValue;
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
  | Readonly<{ type: 'redo' }>
  /** Runs a registered extension command (P5 plan, section 5). */
  | Readonly<{ type: 'runCommand'; id: string; args?: JsonValue }>;

/**
 * Model codes come from `loadDocument` and from node validation in commands; the two custom
 * codes come from the extension checks of `editor-core`.
 */
export type EditorErrorCode =
  | ModelErrorCode
  | Exclude<DocumentErrorCode, ModelErrorCode>
  | 'editor.invalid-command'
  | 'editor.unknown-node'
  | 'editor.unknown-tool'
  | 'editor.duplicate-id'
  | 'editor.nothing-to-undo'
  | 'editor.nothing-to-redo'
  | 'editor.invalid-camera'
  | 'editor.unknown-command';

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
  | Readonly<{ type: 'revision' }>
  | Readonly<{ type: 'overlay' }>;

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
            : Q extends { type: 'overlay' }
              ? ToolOverlay | null
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
  | Readonly<{ type: 'session'; field: 'selection' | 'tool' | 'viewport' }>
  | DiagnosticEvent;

/** A structured diagnostic from the scene projector (plan section 4.5). */
export type DiagnosticEvent = Readonly<{
  type: 'diagnostic';
  /** `renderer-unsupported` is a host capability fact; `scene-rejected` is any other rejection. */
  code: 'editor.scene-rejected' | 'editor.renderer-unsupported';
  reason: SceneRejectionReason;
  nodeIds: readonly string[];
}>;

export interface Editor {
  execute(command: Command): CommandResult;
  query<Q extends Query>(query: Q): QueryResult<Q>;
  /** The listener runs after each change; the returned function unsubscribes. */
  subscribe(listener: (event: EditorEvent) => void): () => void;
  /** An immutable value, replaced on every change (for `useSyncExternalStore`). */
  getSnapshot(): EditorSnapshot;
  /**
   * Keeps `renderer` synchronized with the document and viewport, starting with a full snapshot;
   * replaces any renderer attached before. The returned function detaches it.
   */
  attachRenderer(renderer: RendererSceneSynchronization): () => void;
}

/** Returns a fresh ID on each call; IDs it returns that already exist are skipped. */
export type IdSource = () => string;

/**
 * The whole editor surface an extension receives (P5 plan, section 5): no store, renderer, GPU
 * or WASM handle, and no other extension's internals.
 */
export type ExtensionApi = Readonly<{
  execute(command: Command): CommandResult;
  query<Q extends Query>(query: Q): QueryResult<Q>;
}>;

/** A custom node type; `customType` is the extension's ID or starts with it and a dot. */
export type CustomNodeType = Readonly<{
  customType: string;
  /** Whether `data` is valid for this type; a throw counts as invalid. */
  validate(data: JsonValue): boolean;
  defaults(): JsonValue;
  /** Path geometry in frame-local page units; the style is the node's own fill and stroke. */
  toScene(data: JsonValue, frame: Frame): Omit<ScenePathGeometry, 'kind'>;
}>;

/** An extension command; its ID is the extension's ID or starts with it and a dot. */
export type ExtensionCommand = Readonly<{
  id: string;
  run(args: JsonValue | undefined, api: ExtensionApi): CommandResult;
}>;

export type Extension = Readonly<{
  id: string;
  nodeTypes?: readonly CustomNodeType[];
  commands?: readonly ExtensionCommand[];
}>;
