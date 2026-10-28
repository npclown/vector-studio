import type {
  RenderCamera,
  RendererSceneSynchronization,
  ScenePathGeometry,
  SceneRejectionReason,
} from '@vector-studio/contracts';
import type {
  Arrow,
  Color,
  Constraints,
  CornerRadii,
  DocumentErrorCode,
  DocumentV2,
  FillRule,
  Frame,
  JsonValue,
  ModelErrorCode,
  NodeV2,
  PageV2,
  PathStroke,
  PathVerb,
  RectStroke,
} from '@vector-studio/model';

// Public command, query and event shapes (P5 plan, sections 4.1 to 4.3; MVP M1 contract,
// sections 3 and 4).

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

/** A prop that the node's type does not have is `editor.invalid-command`. */
export type NodeProps = Readonly<{
  name?: string;
  fill?: Color | null;
  stroke?: RectStroke | PathStroke | null;
  opacity?: number;
  visible?: boolean;
  /** Custom nodes only. */
  data?: JsonValue;
  /** Rectangles only. */
  cornerRadii?: CornerRadii;
  /** Lines only. */
  startArrow?: Arrow;
  endArrow?: Arrow;
  constraints?: Constraints;
}>;

/**
 * Optional placement of a new node (M1 contract, section 4.1). The command's frames and points
 * are in page space and are mapped into the parent's local space; `rotation` is the node's page
 * rotation (radians, clockwise), so its stored rotation is this minus the parent chain's.
 */
export type Placement = Readonly<{
  rotation?: number;
  /** A page or container; defaults to the active page. */
  parent?: string;
  /** Into the parent's children, `0..children.length`; defaults to the top. */
  index?: number;
}>;

/** Commands that change the document; each successful one is one transaction. */
export type DocumentCommand =
  | (Readonly<{
      type: 'createRectangle';
      frame: Frame;
      name?: string;
      fill?: Color | null;
      stroke?: RectStroke | null;
      cornerRadii?: CornerRadii;
    }> &
      Placement)
  | (Readonly<{
      type: 'createEllipse';
      frame: Frame;
      name?: string;
      fill?: Color | null;
      stroke?: RectStroke | null;
    }> &
      Placement)
  | (Readonly<{
      type: 'createLine';
      /** Page-space endpoints. */
      start: PagePoint;
      end: PagePoint;
      name?: string;
      stroke?: PathStroke | null;
      startArrow?: Arrow;
      endArrow?: Arrow;
    }> &
      Placement)
  | (Readonly<{
      type: 'createFrame';
      frame: Frame;
      name?: string;
      fill?: Color | null;
      stroke?: RectStroke | null;
    }> &
      Placement)
  | (Readonly<{
      type: 'createPath';
      verbs: readonly PathVerb[];
      /** Interleaved page-space x, y; the frame is their bounding box (plan section 3.1). */
      points: readonly number[];
      fillRule?: FillRule;
      name?: string;
      fill?: Color | null;
      stroke?: PathStroke | null;
    }> &
      Placement)
  | (Readonly<{
      type: 'createCustomNode';
      customType: string;
      frame: Frame;
      /** Defaults to the extension's `defaults()`. */
      data?: JsonValue;
      name?: string;
      fill?: Color | null;
      stroke?: PathStroke | null;
    }> &
      Placement)
  | Readonly<{
      type: 'setFrames';
      /** Parent-local frames; `rotation` defaults to the node's current one. */
      frames: readonly Readonly<{ id: string; frame: Frame; rotation?: number }>[];
    }>
  | Readonly<{ type: 'setNodeProps'; id: string; props: NodeProps }>
  | Readonly<{ type: 'deleteNodes'; ids: readonly string[] }>
  | Readonly<{ type: 'groupNodes'; ids: readonly string[]; kind: 'group' | 'maskGroup' }>
  | Readonly<{ type: 'ungroupNodes'; id: string }>
  | Readonly<{ type: 'moveNodes'; ids: readonly string[]; parent: string; index: number }>
  | Readonly<{ type: 'addPage'; name?: string; index?: number }>
  | Readonly<{ type: 'removePage'; id: string }>
  | Readonly<{ type: 'renamePage'; id: string; name: string }>
  | Readonly<{ type: 'movePage'; id: string; index: number }>;

/** Commands that are never recorded in history. */
export type SessionCommand =
  | Readonly<{ type: 'setSelection'; ids: readonly string[] }>
  | Readonly<{ type: 'setActivePage'; id: string }>
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
  | 'editor.unknown-command'
  | 'editor.extension-failed'
  // MVP M1 contract, section 4.3.1.
  | 'editor.unknown-page'
  | 'editor.invalid-index'
  | 'editor.last-page'
  | 'editor.invalid-parent'
  | 'editor.not-siblings'
  | 'editor.not-a-group'
  | 'editor.invalid-mask-source'
  | 'editor.clip-depth';

export type CommandResult =
  | Readonly<{ ok: true; ids: readonly string[] }>
  | Readonly<{ ok: false; code: EditorErrorCode; path?: string }>;

export type HistoryState = Readonly<{ undoDepth: number; redoDepth: number }>;

export type EditorSnapshot = Readonly<{
  document: DocumentV2;
  /** The page tools, hit testing and the projector work on (M1 contract, section 3). */
  activePage: string;
  /** Increases by one for every document change, including gesture updates, undo and redo. */
  revision: number;
  selection: readonly string[];
  tool: ToolName;
  viewport: RenderCamera;
  history: HistoryState;
  /** The active tool's overlay, as the `overlay` query returns it after the last command. */
  overlay: ToolOverlay | null;
}>;

export type Query =
  | Readonly<{ type: 'document' }>
  | Readonly<{ type: 'node'; id: string }>
  | Readonly<{ type: 'selection' }>
  | Readonly<{ type: 'tool' }>
  | Readonly<{ type: 'viewport' }>
  | Readonly<{ type: 'history' }>
  | Readonly<{ type: 'revision' }>
  | Readonly<{ type: 'overlay' }>
  | Readonly<{ type: 'activePage' }>
  | Readonly<{ type: 'pages' }>;

export type QueryResult<Q extends Query> = Q extends { type: 'document' }
  ? DocumentV2
  : Q extends { type: 'node' }
    ? NodeV2 | null
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
              : Q extends { type: 'activePage' }
                ? string
                : Q extends { type: 'pages' }
                  ? readonly PageV2[]
                  : number;

export type DocumentChangeCause =
  'command' | 'gesture-update' | 'gesture-commit' | 'gesture-cancel' | 'undo' | 'redo' | 'load';

export type EditorEvent =
  | Readonly<{
      type: 'document';
      cause: DocumentChangeCause;
      revision: number;
      /** IDs of the nodes the change created, changed or removed, sorted (pages excluded). */
      touched: readonly string[];
    }>
  | Readonly<{
      type: 'session';
      field: 'selection' | 'tool' | 'viewport' | 'overlay' | 'activePage';
    }>
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
