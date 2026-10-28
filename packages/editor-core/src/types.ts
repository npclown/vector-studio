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

export type ToolName = 'select' | 'rectangle' | 'ellipse' | 'line' | 'frame' | 'path';

export type PagePoint = Readonly<{ x: number; y: number }>;
export type Modifiers = Readonly<{ shift: boolean; alt: boolean; meta: boolean; ctrl: boolean }>;

/**
 * Pointer, key and wheel input with page-space points (P5; MVP M2 contract, M2-I1). Navigation,
 * the active tool and the keymap receive it in the M2-I2 order.
 */
export type InputEvent =
  | Readonly<{
      kind: 'pointerdown';
      point: PagePoint;
      modifiers: Modifiers;
      /** 0 primary (default), 1 middle; other buttons are ignored and not consumed. */
      button?: number;
    }>
  | Readonly<{ kind: 'pointermove' | 'pointerup'; point: PagePoint; modifiers: Modifiers }>
  | Readonly<{
      kind: 'keydown';
      key: string;
      /** `KeyboardEvent.code`. */
      code?: string;
      repeat?: boolean;
      /** `KeyboardEvent.isComposing`. */
      composing?: boolean;
      modifiers: Modifiers;
    }>
  | Readonly<{ kind: 'keyup'; key: string; code?: string; modifiers: Modifiers }>
  /** CSS pixels; the host converts line and page delta modes. */
  | Readonly<{
      kind: 'wheel';
      point: PagePoint;
      deltaX: number;
      deltaY: number;
      modifiers: Modifiers;
    }>
  | Readonly<{ kind: 'doubleclick'; point: PagePoint; modifiers: Modifiers }>
  | Readonly<{ kind: 'pointercancel'; modifiers: Modifiers }>;

/** Which `EditorOptions.platform` `Mod` resolves for: `Meta` on `mac`, else `Ctrl`. */
export type Platform = 'mac' | 'other';

/**
 * A key binding (M2 contract, section 7): a chord of `+`-separated modifiers (`Mod`, `Ctrl`,
 * `Meta`, `Alt`, `Shift`) and one key token, and a built-in action name or an extension command
 * ID; `action: null` unbinds the chord in a later layer.
 */
export type KeyBinding = Readonly<{ chord: string; action: string | null; args?: JsonValue }>;

/** The CSS pixel size of the canvas the viewport shows. */
export type ViewportSize = Readonly<{ width: number; height: number }>;

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

/** A page-space segment of the snap overlay. */
export type Segment = Readonly<{ a: PagePoint; b: PagePoint }>;

/**
 * The snap overlay (M2 contract, section 4.2), in page space: alignment guides, equal-spacing
 * gaps and the snapped rotation angle of the current gesture update. Null when nothing snapped;
 * cleared when the gesture commits or cancels.
 */
export type SnapOverlay = Readonly<{
  guides: readonly Segment[];
  gaps: readonly Segment[];
  /**
   * The resulting page rotation of a one-node rotation that snapped (angle snap or Shift step),
   * the stepped angle of a several-node Shift rotation, else null.
   */
  angle: number | null;
}>;

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
  /**
   * Rotates by `angle` (radians, clockwise) about the page point `pivot`, by default the centre
   * of the `handles` box (MVP M2 contract, section 4.1). A relative command: inside a gesture it
   * goes through `replace`, never `update`.
   */
  | Readonly<{ type: 'rotateNodes'; ids: readonly string[]; angle: number; pivot?: PagePoint }>
  // Arrange commands (MVP M2 contract, section 4.3), in page space: a node's box is the
  // page-aligned bounds of its rotated frame, and its move is a page vector turned into its
  // parent space. `alignNodes`, `distributeNodes`, `reorderNodes` and `nudgeNodes` are relative
  // commands: inside a gesture they go through `replace`, never `update`.
  /** Aligns the boxes to the edge or centre of their union, or one node to its frame ancestor. */
  | Readonly<{ type: 'alignNodes'; ids: readonly string[]; edge: AlignEdge }>
  /** Spaces at least 3 boxes evenly between the outer two, which stay. */
  | Readonly<{ type: 'distributeNodes'; ids: readonly string[]; axis: DistributeAxis }>
  /** Moves the nodes within their own parents; the last child is on top. */
  | Readonly<{ type: 'reorderNodes'; ids: readonly string[]; op: ReorderOp }>
  /** Moves the nodes by the page vector `(dx, dy)`. */
  | Readonly<{ type: 'nudgeNodes'; ids: readonly string[]; dx: number; dy: number }>
  /**
   * Copies each subtree with fresh IDs directly above its original, moved by the page `offset`
   * (default `{ x: 0, y: 0 }`); returns the copies' root IDs in paint order.
   */
  | Readonly<{ type: 'duplicateNodes'; ids: readonly string[]; offset?: PagePoint }>
  | Readonly<{ type: 'addPage'; name?: string; index?: number }>
  | Readonly<{ type: 'removePage'; id: string }>
  | Readonly<{ type: 'renamePage'; id: string; name: string }>
  | Readonly<{ type: 'movePage'; id: string; index: number }>;

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';
export type ReorderOp = 'forward' | 'backward' | 'front' | 'back';

/** Commands that are never recorded in history. */
export type SessionCommand =
  | Readonly<{ type: 'setSelection'; ids: readonly string[] }>
  | Readonly<{ type: 'setActivePage'; id: string }>
  | Readonly<{ type: 'setTool'; tool: ToolName }>
  | Readonly<{ type: 'setViewport'; camera: RenderCamera }>
  | Readonly<{ type: 'input'; event: InputEvent }>
  // MVP M2 contract, sections 3 and 7.
  | Readonly<{ type: 'setViewportSize'; width: number; height: number }>
  /** `about` is a page point; it defaults to the viewport centre. */
  | Readonly<{ type: 'zoomBy'; factor: number; about?: PagePoint }>
  | Readonly<{ type: 'zoomTo'; target: 'fit' | 'selection' | 'actual' }>
  /** Replaces the host keymap layer. */
  | Readonly<{ type: 'setKeymap'; bindings: readonly KeyBinding[] }>
  /** Turns snapping on or off (M2 contract, section 4.2); Ctrl or Meta held also disables it. */
  | Readonly<{ type: 'setSnapping'; enabled: boolean }>
  /**
   * Enters a container (group, mask group or frame) of the active page, or leaves every scope
   * with null (M2 contract, section 5).
   */
  | Readonly<{ type: 'setScope'; id: string | null }>;

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
  | 'editor.clip-depth'
  // MVP M2 contract, section 4.4.
  | 'editor.no-viewport-size'
  | 'editor.too-few-nodes'
  | 'editor.invalid-scope'
  | 'editor.invalid-keymap';

/**
 * `consumed` is present on `input` results only (M2-I3): whether navigation, the tool or a key
 * binding acted on the event, so a host calls `preventDefault` only then.
 */
export type CommandResult =
  | Readonly<{ ok: true; ids: readonly string[]; consumed?: boolean }>
  | Readonly<{ ok: false; code: EditorErrorCode; path?: string; consumed?: boolean }>;

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
  /** Null until the host sends `setViewportSize`. */
  viewportSize: ViewportSize | null;
  /** The effective key bindings in canonical form, sorted by chord. */
  keymap: readonly KeyBinding[];
  history: HistoryState;
  /** The active tool's overlay, as the `overlay` query returns it after the last command. */
  overlay: ToolOverlay | null;
  /** The snap overlay of the active gesture (M2 contract, section 4.2), or null. */
  snap: SnapOverlay | null;
  /** Whether snapping is on; true by default. */
  snapping: boolean;
  /** The entered container of the active page (M2 contract, section 5), or null. */
  scope: string | null;
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
  | Readonly<{ type: 'pages' }>
  /** The select tool's resize handle box for the selection (M1-U5). */
  | Readonly<{ type: 'handles' }>
  | Readonly<{ type: 'viewportSize' }>
  /** The effective key bindings in canonical form, sorted by chord. */
  | Readonly<{ type: 'keymap' }>
  /** The snap overlay of the active gesture, or null. */
  | Readonly<{ type: 'snap' }>
  | Readonly<{ type: 'snapping' }>
  /** The entered container, or null. */
  | Readonly<{ type: 'scope' }>;

/**
 * The select tool's resize handle box for the selection, in page space (M1 contract, section
 * 4.4), as the tool picks its handles. The box is the node's own rotated frame for a single node
 * that is not a page-root node with rotation 0; for any other selection it is the page-aligned
 * bounds of the selected nodes' rotated frames. Null for an empty selection. The result is a
 * frozen value computed from the current document, page and selection.
 */
export type SelectionHandles = Readonly<{
  /** Top-left, top-right, bottom-right and bottom-left, in the box's own axes. */
  corners: readonly [PagePoint, PagePoint, PagePoint, PagePoint];
  /** The box's page rotation in radians, normalized to (−π, π]; 0 for a page-aligned box. */
  rotation: number;
  /**
   * The active handles, clockwise from the top-left corner (corners and edge midpoints): a
   * handle is active when it scales an axis of nonzero size, so a box of height 0 (a horizontal
   * line) has no top or bottom edge handle and keeps only its left and right ones and corners.
   */
  handles: readonly PagePoint[];
}>;

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
                  : Q extends { type: 'handles' }
                    ? SelectionHandles | null
                    : Q extends { type: 'viewportSize' }
                      ? ViewportSize | null
                      : Q extends { type: 'keymap' }
                        ? readonly KeyBinding[]
                        : Q extends { type: 'snap' }
                          ? SnapOverlay | null
                          : Q extends { type: 'snapping' }
                            ? boolean
                            : Q extends { type: 'scope' }
                              ? string | null
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
      field:
        | 'selection'
        | 'tool'
        | 'viewport'
        | 'overlay'
        | 'activePage'
        | 'viewportSize'
        | 'keymap'
        | 'snap'
        | 'snapping'
        | 'scope';
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
  /**
   * The extension's keymap layer (M2 contract, section 7): built-in actions and the extension's
   * own commands only.
   */
  bindings?: readonly KeyBinding[];
}>;
