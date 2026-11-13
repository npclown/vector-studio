import type {
  PathStroke,
  RenderCamera,
  RendererSceneSynchronization,
  SceneAffine,
  SceneBlendMode,
  SceneClip,
  ScenePaint,
  ScenePathGeometry,
  SceneTextRun,
  SceneRejectionReason,
  TextLayoutResult,
} from '@vector-studio/contracts';
import type {
  AutoLayout,
  LayoutSizing,
  Arrow,
  BindingKey,
  BindingRef,
  Color,
  Constraints,
  CornerRadii,
  DocumentErrorCode,
  DocumentV8,
  Effect,
  FillRule,
  Frame,
  JsonValue,
  ModelErrorCode,
  NodeOverride,
  NodeV8,
  PageV2,
  Paint,
  BlendMode,
  ContainerBlendMode,
  Fill,
  FillPaint,
  ImageAsset,
  ImageMimeType,
  ImageScaleMode,
  PathVerb,
  Stroke,
  TextNodeV8,
  TextRun,
  Guide,
  PageGrid,
  LayoutGrid,
} from '@vector-studio/model';

// Public command, query and event shapes (P5 plan, sections 4.1 to 4.3; MVP M1 contract,
// sections 3 and 4).

export type ToolName =
  | 'select'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'frame'
  | 'path'
  | 'text'
  /** V-40: the freehand pencil and the regular polygon tools. */
  | 'pencil'
  | 'polygon'
  /** V-39 contract, E7. */
  | 'eyedropper';

/**
 * A built-in tool name or a registered extension tool ID (MVP M2 contract, section 7; M2-Q13).
 * `string & {}` keeps the built-in names visible to editors while any string is accepted.
 */
export type ToolId = ToolName | (string & {});

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
      /**
       * Set by the host from `KeyboardEvent.keyCode === 229` (MVP M6b contract, section 5.1,
       * rule 1): an IME is processing the key. Read in text edit mode only.
       */
      ime?: boolean;
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
  | Readonly<{ kind: 'pointercancel'; modifiers: Modifiers }>
  /**
   * Text from `beforeinput` `insertText` (MVP M6b contract, section 5.3, M6b-Q3 (a)), valid in
   * text edit mode only; outside it fails with `editor.no-text-edit`. It never reaches a tool.
   */
  | Readonly<{ kind: 'textinput'; text: string }>
  /**
   * IME composition (MVP M6b contract, sections 5.3 and 7), valid in text edit mode only:
   * `compositionstart` begins the text gesture over the selection, each `compositionupdate`
   * replaces the composing text with its normalized `data` (cause `gesture-update`), and
   * `compositionend` replaces with its own `data`, then commits. Outside edit mode each fails
   * with `editor.no-text-edit`; none reaches a tool.
   */
  | Readonly<{ kind: 'compositionstart' }>
  | Readonly<{ kind: 'compositionupdate'; data: string }>
  | Readonly<{ kind: 'compositionend'; data: string }>;

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

/**
 * An anchor of a path's anchor model (MVP M3 contract, section 2): subpath `subpath` (from 0)
 * and its anchor `anchor` (from 0), both integers in range.
 */
export type PathAnchorRef = Readonly<{ subpath: number; anchor: number }>;

/**
 * Path edit mode (MVP M3 contract, section 4): the edited `path` node and its anchor selection,
 * canonical (sorted by `(subpath, anchor)` without repeats). Session state, never history.
 */
export type PathEditState = Readonly<{ id: string; anchors: readonly PathAnchorRef[] }>;

/**
 * An anchor of the path overlay in page space (section 5.1): `in` and `out` are its visible
 * handles only (its anchor or the other end of that side's segment is selected), else null;
 * `mirrored` is the section 2 test on both handles, visible or not.
 */
export type PathEditAnchor = PathAnchor & Readonly<{ selected: boolean; mirrored: boolean }>;

/**
 * The `pathOverlay` query (section 5.1): the edited path's anchor model in page space, one entry
 * per anchor (anchor 0 of an explicitly closed subpath once), from which the select tool picks
 * its edit-mode targets.
 */
export type PathEditOverlay = Readonly<{
  id: string;
  subpaths: readonly Readonly<{ closed: boolean; anchors: readonly PathEditAnchor[] }>[];
}>;

/** Which line a caret at a soft wrap is drawn on (MVP M6b contract, section 2). */
export type TextAffinity = 'downstream' | 'upstream';

/**
 * A text caret (M6b contract, section 2): `anchor` and `focus` are UTF-16 offsets on stops
 * (section 4.1); `affinity` matters only when collapsed at a soft wrap.
 */
export type TextCaret = Readonly<{ anchor: number; focus: number; affinity: TextAffinity }>;

/** The style a new text node takes (M6b-S2): one run's family, size and colour. */
export type TextStyle = Readonly<{ family: string; size: number; color: Color }>;

/** A text node the text tool placed but nothing created yet (M6b contract, section 3.2). */
export type TextEditPending = Readonly<{
  parent: string;
  index: number;
  /** Page space, rotation 0. */
  frame: Frame;
  sizing: 'autoWidth' | 'autoHeight';
  style: TextStyle;
}>;

/**
 * Text edit mode (M6b-S1): session state, never history. Exactly one of `id` and `pending` is
 * null; `anchor` and `focus` are on stops of the edited text.
 */
export type TextEditState = Readonly<{
  id: string | null;
  pending: TextEditPending | null;
  anchor: number;
  focus: number;
  affinity: TextAffinity;
  composition: Readonly<{ start: number; end: number }> | null;
}>;

/** Four page points in order: a box's top-left, top-right, bottom-right and bottom-left. */
export type Quad = readonly [PagePoint, PagePoint, PagePoint, PagePoint];

/**
 * The `textEditOverlay` query (M6b contract, section 4.5), in page space: the collapsed caret
 * (null for a non-empty selection), the selection's quads per line, the composition underline
 * segments, and `inputRect`, the axis-aligned top-left and height of the focus caret's segment.
 */
export type TextEditOverlay = Readonly<{
  id: string | null;
  caret: readonly [PagePoint, PagePoint] | null;
  selection: readonly Quad[];
  composition: readonly (readonly [PagePoint, PagePoint])[];
  inputRect: Readonly<{ x: number; y: number; height: number }>;
}>;

/** Tool state the host UI draws over the canvas; it is never document content. */
export type ToolOverlay =
  | Readonly<{ kind: 'marquee'; frame: Frame }>
  | Readonly<{ kind: 'path'; anchors: readonly PathAnchor[] }>
  /**
   * The eyedropper's hover (V-39 contract, E7): the pointer's last page point and the colour
   * `sampleColor` gives there, or null over nothing.
   */
  | Readonly<{ kind: 'eyedropper'; point: PagePoint; color: Color | null }>;

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
  /** V35-S5: replaces all fills by this one fill (opacity 1, `normal`), or none. */
  fill?: FillPaint | null;
  /** V35-S5: replaces the fills; with `fill` it is `editor.invalid-command`. */
  fills?: readonly Fill[];
  blendMode?: ContainerBlendMode;
  stroke?: Stroke | null;
  opacity?: number;
  visible?: boolean;
  /** V31-E4: `false` removes the key (V31-S1). */
  locked?: boolean;
  /** Custom nodes only. */
  data?: JsonValue;
  /** Rectangles only. */
  cornerRadii?: CornerRadii;
  /** Lines only. */
  startArrow?: Arrow;
  endArrow?: Arrow;
  constraints?: Constraints;
  /** Frames and symbols only (V-38 contract, V38-C2); an empty list removes them. */
  layoutGrids?: readonly LayoutGrid[];
}>;

/**
 * A stroke patch of `setStyle` (MVP M4 contract, section 4.2): any subset of the stroke keys,
 * merged over the node's stroke, or over `DEFAULT_PATH_STROKE` (line, path, custom) or
 * `DEFAULT_SHAPE_STROKE` (other types) when it has none.
 */
export type StrokePatch = Readonly<Partial<Stroke>>;

/**
 * The appearance `setStyle` sets (section 4.2): at least one key. A key applies to each listed
 * node whose type has that prop, and other nodes are left unchanged; `stroke: null` removes it.
 */
export type StyleProps = Readonly<{
  fill?: FillPaint | null;
  fills?: readonly Fill[];
  /** V35-C1: `passThrough` applies to groups, mask groups, frames, symbols and instances only. */
  blendMode?: ContainerBlendMode;
  stroke?: StrokePatch | null;
  opacity?: number;
  cornerRadii?: CornerRadii;
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

/**
 * V-32 contract, V32-E1: an image asset as a command takes it. The host reads `width` and
 * `height` from the file header and computes `key`, the lowercase hex SHA-256 of the decoded
 * bytes, so commands stay synchronous.
 */
export type ImageAssetInput = Readonly<{
  key: string;
  mimeType: ImageMimeType;
  width: number;
  height: number;
  data: string;
}>;

/** Commands that change the document; each successful one is one transaction. */
export type DocumentCommand =
  | (Readonly<{
      type: 'createRectangle';
      frame: Frame;
      name?: string;
      fill?: FillPaint | null;
      fills?: readonly Fill[];
      stroke?: Stroke | null;
      cornerRadii?: CornerRadii;
    }> &
      Placement)
  | (Readonly<{
      type: 'createEllipse';
      frame: Frame;
      name?: string;
      fill?: FillPaint | null;
      fills?: readonly Fill[];
      stroke?: Stroke | null;
    }> &
      Placement)
  | (Readonly<{
      type: 'createLine';
      /** Page-space endpoints. */
      start: PagePoint;
      end: PagePoint;
      name?: string;
      stroke?: Stroke | null;
      startArrow?: Arrow;
      endArrow?: Arrow;
    }> &
      Placement)
  | (Readonly<{
      type: 'createFrame';
      frame: Frame;
      name?: string;
      fill?: FillPaint | null;
      fills?: readonly Fill[];
      stroke?: Stroke | null;
    }> &
      Placement)
  | (Readonly<{
      type: 'createPath';
      verbs: readonly PathVerb[];
      /** Interleaved page-space x, y; the frame is their bounding box (plan section 3.1). */
      points: readonly number[];
      fillRule?: FillRule;
      name?: string;
      fill?: FillPaint | null;
      fills?: readonly Fill[];
      stroke?: Stroke | null;
    }> &
      Placement)
  | (Readonly<{
      type: 'createCustomNode';
      customType: string;
      frame: Frame;
      /** Defaults to the extension's `defaults()`. */
      data?: JsonValue;
      name?: string;
      fill?: FillPaint | null;
      fills?: readonly Fill[];
      stroke?: Stroke | null;
    }> &
      Placement)
  | Readonly<{
      type: 'setFrames';
      /** Parent-local frames; `rotation` defaults to the node's current one. */
      frames: readonly Readonly<{ id: string; frame: Frame; rotation?: number }>[];
    }>
  | Readonly<{ type: 'setNodeProps'; id: string; props: NodeProps }>
  /**
   * V-31 contract, V31-E4: sets `locked` and/or `visible` on nodes of the active page in one
   * transaction (one undo step); `locked: false` removes the key; returns empty `ids`.
   */
  | Readonly<{ type: 'setLayerState'; ids: readonly string[]; locked?: boolean; visible?: boolean }>
  /**
   * Sets appearance on nodes of the active page at any depth in one transaction (MVP M4
   * contract, section 4.2); returns empty `ids`, and a change of no value records no step.
   */
  | Readonly<{ type: 'setStyle'; ids: readonly string[]; style: StyleProps }>
  | Readonly<{ type: 'deleteNodes'; ids: readonly string[] }>
  | Readonly<{ type: 'groupNodes'; ids: readonly string[]; kind: 'group' | 'maskGroup' }>
  /**
   * E41 contract, section 6: appends the default effect of `kind` to each node (one step); past
   * E41-S3's and V36-S2's limits (8 effects, one layer blur, one background blur) it refuses with
   * `editor.effect-limit`.
   */
  | Readonly<{ type: 'addEffect'; ids: readonly string[]; kind: Effect['kind'] }>
  /**
   * Patches the effect at `index` of each listed node that has one (a toggle sets `visible`). A
   * `kind` patch changes the kind within its family (V-36 contract, section 6): shadows keep
   * their fields, blurs their radius, and a node whose effect is in the other family is left
   * unchanged.
   */
  | Readonly<{
      type: 'setEffect';
      ids: readonly string[];
      index: number;
      patch: Readonly<{
        kind?: Effect['kind'];
        visible?: boolean;
        color?: Color;
        offsetX?: number;
        offsetY?: number;
        radius?: number;
      }>;
    }>
  /** Removes the effect at `index` of each listed node that has one. */
  | Readonly<{ type: 'removeEffect'; ids: readonly string[]; index: number }>
  /**
   * V-35 contract, V35-C1: appends a fill (the default paint, opacity 1, `normal`) to each
   * listed node that takes fills (one step); at 16 fills it refuses with `editor.fill-limit`.
   */
  | Readonly<{ type: 'addFill'; ids: readonly string[] }>
  /** Patches the fill at `index` (bottom first) of each listed node that has one. */
  | Readonly<{
      type: 'setFill';
      ids: readonly string[];
      index: number;
      patch: Readonly<{
        paint?: FillPaint;
        visible?: boolean;
        opacity?: number;
        blendMode?: BlendMode;
      }>;
    }>
  /** Removes the fill at `index` of each listed node that has one. */
  | Readonly<{ type: 'removeFill'; ids: readonly string[]; index: number }>
  /** Moves the fill at `from` to `to` on each listed node that has both indices. */
  | Readonly<{ type: 'moveFill'; ids: readonly string[]; from: number; to: number }>
  /**
   * V-34 contract, section 5: patches the auto layout of the listed frames that have it (`null`
   * removes it) and the `layoutSizing` of every listed node, in one transaction.
   */
  | Readonly<{
      type: 'setLayout';
      ids: readonly string[];
      autoLayout?: Partial<AutoLayout> | null;
      layoutSizing?: Partial<LayoutSizing>;
    }>
  /**
   * V-34 section 5: frames get an inferred auto layout; other nodes of one parent are wrapped in
   * a new auto-layout frame (returns its ID).
   */
  | Readonly<{ type: 'addAutoLayout'; ids: readonly string[] }>
  /** V-34 section 5: removes the auto layout of each listed frame that has it. */
  | Readonly<{ type: 'removeAutoLayout'; ids: readonly string[] }>
  /** E41 contract, section 2: replaces sibling shapes by one path, the `op` of their areas. */
  | Readonly<{
      type: 'booleanNodes';
      ids: readonly string[];
      op: 'union' | 'subtract' | 'intersect' | 'exclude';
    }>
  | Readonly<{ type: 'ungroupNodes'; id: string }>
  | Readonly<{ type: 'moveNodes'; ids: readonly string[]; parent: string; index: number }>
  // Symbol commands (MVP M7 contract, section 5).
  /**
   * Makes a source of sibling nodes of the active page: one `frame` becomes a `symbol` in place
   * (same ID); otherwise a new `symbol` wraps the nodes as `groupNodes` does. Returns its ID.
   */
  | Readonly<{ type: 'createSymbol'; ids: readonly string[] }>
  /**
   * Creates an instance of `symbol` (a source on any page). `frame` is in page space; by default
   * the source's size, its top-left the source's page bounds' top-left moved by the bounds width
   * plus 40 along x. Returns the instance's ID.
   */
  | (Readonly<{ type: 'createInstance'; symbol: string; frame?: Frame }> & Placement)
  /**
   * Turns instances of the active page into frames with the same IDs, holding copies of their
   * expansions with fresh IDs (section 5.2). Returns empty `ids`; the selection is unchanged.
   */
  | Readonly<{ type: 'detachInstances'; ids: readonly string[] }>
  /**
   * Sets the text of the source text node `node` inside instance `id` (MVP M6a contract, section
   * 9, M7-T3): canonical `runs`, sizes in the source's space; runs equal to the source node's
   * remove the override. Needs no text layout. Returns empty `ids`.
   */
  | Readonly<{ type: 'setInstanceText'; id: string; node: string; runs: readonly TextRun[] }>
  /** Removes the text override of `node` in instance `id`, or every one without `node`. */
  | Readonly<{ type: 'clearInstanceText'; id: string; node?: string }>
  // Variant and override commands (V-37 contract, sections 4.1 and 4.2).
  /**
   * Moves two or more sibling symbols of the active page, none in a set, into a new
   * `symbolSet`, each with `variant { 'Property 1': <value from its name> }`. Returns the set's ID.
   */
  | Readonly<{ type: 'combineAsVariants'; ids: readonly string[] }>
  /** Replaces the `variant` of each listed symbol of a set in one step; returns empty `ids`. */
  | Readonly<{
      type: 'setVariantProperties';
      updates: readonly Readonly<{ id: string; variant: Readonly<Record<string, string>> }>[];
    }>
  /**
   * Makes instance `id` refer to the variant of its set that has its current variant's values
   * with `values` applied; overrides carry by layer path. Returns empty `ids`.
   */
  | Readonly<{ type: 'setInstanceVariant'; id: string; values: Readonly<Record<string, string>> }>
  /**
   * Sets property overrides of the source node `node` (the source itself included) inside
   * instance `id`; a value equal to the source node's removes that field. Returns empty `ids`.
   */
  | Readonly<{ type: 'setInstanceOverride'; id: string; node: string; props: NodeOverride }>
  /** Removes the property and text overrides of `node` in instance `id`, or every one. */
  | Readonly<{ type: 'resetInstanceOverrides'; id: string; node?: string }>
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
  /**
   * Pastes a fragment (MVP M2 contract, section 6; M7 contract, section 6): `text` when given,
   * else the in-memory clipboard. The roots go on top of the scope, else a single selected frame
   * or symbol, else the active page, at their page placement, or with their joint page bounds
   * centred on `at`; fresh IDs. A pasted source is a new source; an instance refers to its
   * pasted source, else is linked to its carried source or pasted detached as a frame. Returns
   * the pasted roots in paint order and selects them. A creating command: inside a gesture it
   * goes through `update` once.
   *
   * Plain text (MVP M6b contract, section 9): outside text edit mode, unmarked text that is
   * non-empty after the section 9.1 normalization creates one `autoWidth` text node in the text
   * tool style whose box centre is `pointer` (the host's last pointer position over the canvas,
   * in page space), else `at`, else the viewport centre, in the paste target, selected; empty
   * text is `editor.unsupported-clipboard`. In text edit mode the normalized text, or the texts
   * of a fragment's `text` nodes joined by LF, replaces the selection as one step (`at` and
   * `pointer` are not used) and returns the edited node's ID.
   */
  | Readonly<{ type: 'paste'; text?: string; at?: PagePoint; pointer?: PagePoint }>
  // Path commands (MVP M3 contract, section 3) on one `path` node of the active page at any
  // depth; re-normalized after the edit (section 3.1). Relative commands: inside a gesture they
  // go through `replace`, never `update`.
  /** Moves the listed anchors and their handles by the page vector `(dx, dy)`. */
  | Readonly<{
      type: 'movePathAnchors';
      id: string;
      anchors: readonly PathAnchorRef[];
      dx: number;
      dy: number;
    }>
  /**
   * Moves the anchor's `side` handle to the page point `to` (a line there becomes a cubic), with
   * `mirror` (default false) the opposite handle to its reflection through the anchor; `to: null`
   * retracts the handle (and with `mirror` the opposite one) onto the anchor.
   */
  | Readonly<{
      type: 'setPathHandle';
      id: string;
      anchor: PathAnchorRef;
      side: 'in' | 'out';
      to: PagePoint | null;
      mirror?: boolean;
    }>
  /**
   * Splits segment `segment` of subpath `subpath` at `0 < t < 1`; the new anchor is anchor
   * `segment + 1` (a line into two lines, a cubic by de Casteljau).
   */
  | Readonly<{ type: 'insertPathAnchor'; id: string; subpath: number; segment: number; t: number }>
  /**
   * Removes the listed anchors, joining their neighbours with the outer handles kept; a subpath
   * left with fewer than 2 anchors is dropped, and removing every subpath fails.
   */
  | Readonly<{ type: 'removePathAnchors'; id: string; anchors: readonly PathAnchorRef[] }>
  /** Closes an open subpath of at least 2 anchors with a straight closing segment. */
  | Readonly<{ type: 'closePathSubpath'; id: string; subpath: number }>
  /**
   * Opens a closed subpath by removing segment `segment` (default the closing segment); the
   * open subpath starts at the anchor after it.
   */
  | Readonly<{ type: 'openPathSubpath'; id: string; subpath: number; segment?: number }>
  // Text commands (MVP M6a contract, section 6.1). Offsets are UTF-16 units into the node text
  // and may not split a surrogate pair; a command on a node in an auto mode refits its auto
  // dimensions with the growth anchor (section 6.2) and needs the editor's `textLayout` port.
  /**
   * Creates a text node at the page-space `frame` (M1 section 4.1) with canonical `runs`;
   * defaults `autoWidth`, `left`, letter spacing 0, line height 1.2, name `Text`. Auto
   * dimensions come from the layout, anchored on the given frame. Returns its ID.
   */
  | (Readonly<{
      type: 'createText';
      frame: Frame;
      runs: readonly TextRun[];
      sizing?: TextNodeV8['sizing'];
      align?: TextNodeV8['align'];
      letterSpacing?: number;
      lineHeight?: number;
    }> &
      Placement)
  /** Replaces `[start, end)` with `text` in the style of the character before `start`. */
  | Readonly<{ type: 'setText'; id: string; start: number; end: number; text: string }>
  /** Sets `family`, `size` or `color` over `[start, end)` (`0, 0` on an empty node only). */
  | Readonly<{
      type: 'setTextStyle';
      id: string;
      start: number;
      end: number;
      style: Readonly<Partial<Pick<TextRun, 'family' | 'size' | 'color'>>>;
    }>
  /** Sets at least one of the node's text props; `autoWidth` drops the stored width. */
  | Readonly<{
      type: 'setTextProps';
      id: string;
      sizing?: TextNodeV8['sizing'];
      align?: TextNodeV8['align'];
      letterSpacing?: number;
      lineHeight?: number;
    }>
  /**
   * Refits the auto dimensions of the listed text nodes, by default every text node of the
   * document, as one step; with no frame change no step is recorded.
   */
  | Readonly<{ type: 'refitText'; ids?: readonly string[] }>
  // V-32 contract, V32-E2: images.
  /**
   * Adds one rectangle per asset with the image as its fill, at the image's natural size, to the
   * active page (or the frame under `at` with `adoptIntoFrames`); the first is centred on `at`
   * (default: the viewport centre), the next ones offset by (20, 20) each. `names` has one name
   * per asset. The new rectangles become the selection. Returns their IDs.
   */
  | Readonly<{
      type: 'insertImages';
      assets: readonly ImageAssetInput[];
      at?: PagePoint;
      names?: readonly string[];
    }>
  /**
   * Sets the topmost fill's paint of each listed node that takes fills to the image (adding a
   * fill when it has none; mode `fill` by default). Nodes without fills are skipped; none
   * qualifying is `editor.image-no-target`. Returns empty `ids`.
   */
  | Readonly<{
      type: 'setImageFill';
      ids: readonly string[];
      asset: ImageAssetInput;
      scaleMode?: ImageScaleMode;
    }>
  /** Changes mode or scale of each listed node whose topmost fill is an image paint. */
  | Readonly<{
      type: 'setImagePaint';
      ids: readonly string[];
      scaleMode?: ImageScaleMode;
      scale?: number;
    }>
  // V-39 contract, section 3: colour styles, variables, modes and bindings. A change of a
  // style's paint, a variable's value or the active mode rewrites every bound node (E1).
  /** Appends a colour style; returns its ID. */
  | Readonly<{ type: 'createColorStyle'; name: string; paint: Paint }>
  | Readonly<{ type: 'updateColorStyle'; id: string; name?: string; paint?: Paint }>
  /** Removes a style; its users keep their values, detached (V39-Q7). */
  | Readonly<{ type: 'removeColorStyle'; id: string }>
  /**
   * Appends a variable of `kind` with `value` in every mode, creating the set with one mode
   * `Mode 1` when there is none; returns its ID.
   */
  | Readonly<{
      type: 'createVariable';
      name: string;
      kind: 'color' | 'number';
      value: Color | number;
    }>
  /** Renames, or sets the values of the listed modes (by mode ID). */
  | Readonly<{
      type: 'updateVariable';
      id: string;
      name?: string;
      values?: Readonly<Record<string, Color | number>>;
    }>
  | Readonly<{ type: 'removeVariable'; id: string }>
  /** Appends a mode whose values copy the active mode's; returns its ID. */
  | Readonly<{ type: 'addVariableMode'; name: string }>
  | Readonly<{ type: 'renameVariableMode'; id: string; name: string }>
  | Readonly<{ type: 'removeVariableMode'; id: string }>
  /** Sets the active mode. */
  | Readonly<{ type: 'setVariableMode'; id: string }>
  /**
   * Binds `key` of the listed nodes (active page, any depth) to a style or variable, setting the
   * property to its resolved value, or with `ref: null` detaches it (V39-E2). Returns the IDs it
   * changed.
   */
  | Readonly<{
      type: 'bindProperty';
      ids: readonly string[];
      key: BindingKey;
      ref: BindingRef | null;
    }>
  | Readonly<{ type: 'addPage'; name?: string; index?: number }>
  | Readonly<{ type: 'removePage'; id: string }>
  | Readonly<{ type: 'renamePage'; id: string; name: string }>
  /**
   * Replaces the guides of `page` (V-38 contract, V38-C1) as one step; guides equal to the
   * page's record no step. Each guide is validated as a load would (V38-S1).
   */
  | Readonly<{ type: 'setGuides'; page: string; guides: readonly Guide[] }>
  /**
   * Sets the canvas background and grid of `page` (V-41 contract, V41-C1) as one step: an absent
   * key leaves its field, `null` removes it (the default); no change records no step.
   */
  | Readonly<{
      type: 'setPageCanvas';
      page: string;
      background?: Color | null;
      grid?: PageGrid | null;
    }>
  | Readonly<{ type: 'movePage'; id: string; index: number }>;

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';
export type ReorderOp = 'forward' | 'backward' | 'front' | 'back';

/** Commands that are never recorded in history. */
export type SessionCommand =
  | Readonly<{ type: 'setSelection'; ids: readonly string[] }>
  | Readonly<{ type: 'setActivePage'; id: string }>
  | Readonly<{ type: 'setTool'; tool: ToolId }>
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
  /** Shows or hides the host's rulers and guides (V-38 contract, V38-C3). */
  | Readonly<{ type: 'setRulersVisible'; visible: boolean }>
  /** Shows or hides layout grids, and with them snapping to grid lines (V38-C3, V38-N1). */
  | Readonly<{ type: 'setLayoutGridsVisible'; visible: boolean }>
  /**
   * Enters a container (group, mask group or frame) of the active page, or leaves every scope
   * with null (M2 contract, section 5).
   */
  | Readonly<{ type: 'setScope'; id: string | null }>
  /**
   * Serializes the subtrees of `ids` (default the selection) as a fragment into the in-memory
   * clipboard (M2 contract, section 6; fragment version 2 with the carried sources of copied
   * instances, M7 contract, section 6); an empty selection changes nothing. Returns the copied
   * roots in paint order (none for an empty selection). In text edit mode (MVP M6b contract,
   * section 9.2) it copies the selected plain text instead (`ids` is not read) and returns
   * `[id]`, or nothing with a collapsed caret.
   */
  | Readonly<{ type: 'copy'; ids?: readonly string[] }>
  // Path edit mode (MVP M3 contract, section 4).
  /**
   * Enters edit mode on a `path` of the active page at any depth: cancels an active gesture,
   * activates the select tool, selects `[id]` with an empty anchor selection. A no-op on the
   * path already in edit mode.
   */
  | Readonly<{ type: 'enterPathEdit'; id: string }>
  /** Ends edit mode and keeps the selection; a no-op outside edit mode. */
  | Readonly<{ type: 'exitPathEdit' }>
  /** Sets the anchor selection of the edited path, stored canonical. */
  | Readonly<{ type: 'setPathSelection'; anchors: readonly PathAnchorRef[] }>
  // Text edit mode (MVP M6b contract, sections 2 and 3.1).
  /**
   * Enters text edit mode on a text node of the active page at any depth: ends an active
   * gesture, activates the select tool, selects `[id]` and sets the caret (default: all text
   * selected; one offset given sets a collapsed caret there). On the node already in edit mode
   * it only sets the caret.
   */
  | Readonly<{ type: 'enterTextEdit'; id: string; anchor?: number; focus?: number }>
  /** Ends text edit mode and keeps the selection; a no-op outside edit mode. */
  | Readonly<{ type: 'exitTextEdit' }>
  /**
   * Sets the caret of the edited node; `affinity` defaults to `downstream`. Fails with
   * `editor.gesture-active` during a composition (section 7.1).
   */
  | Readonly<{ type: 'setTextSelection'; anchor: number; focus: number; affinity?: TextAffinity }>
  /** Commits an active composition (section 7.3); a no-op without one. */
  | Readonly<{ type: 'endComposition' }>
  /** Sets the text tool style (M6b-S2), a full `TextStyle`. */
  | Readonly<{ type: 'setTextToolStyle'; style: TextStyle }>
  /** V-40: sets the polygon tool's side count, an integer from 3 to 60. */
  | Readonly<{ type: 'setPolygonSides'; sides: number }>;

export type Command =
  | DocumentCommand
  | SessionCommand
  | Readonly<{ type: 'loadDocument'; document: unknown }>
  | Readonly<{ type: 'undo' }>
  | Readonly<{ type: 'redo' }>
  /**
   * `copy` and `deleteNodes` as one transaction (M2 contract, section 6); a failed cut changes
   * neither the document nor the clipboard. Returns the cut (now removed) roots in paint order.
   * In text edit mode (MVP M6b contract, section 9.2) it copies and deletes the selected text as
   * one step and returns `[id]`, or nothing with a collapsed caret.
   */
  | Readonly<{ type: 'cut'; ids?: readonly string[] }>
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
  // MVP M4 contract, section 4.4: right after `editor.clip-depth` in precedence.
  | 'editor.isolation-depth'
  // MVP M2 contract, section 4.4.
  | 'editor.no-viewport-size'
  | 'editor.too-few-nodes'
  | 'editor.invalid-scope'
  | 'editor.invalid-keymap'
  | 'editor.empty-clipboard'
  | 'editor.invalid-clipboard'
  | 'editor.unsupported-clipboard'
  // MVP M3 contract, section 3.5.
  | 'editor.not-a-path'
  | 'editor.invalid-path-ref'
  | 'editor.too-few-anchors'
  | 'editor.empty-path'
  | 'editor.no-path-edit'
  // MVP M7 contract, section 5.5.
  | 'editor.not-a-symbol'
  | 'editor.not-an-instance'
  | 'editor.nested-symbol'
  | 'editor.invalid-expansion'
  | 'editor.expansion-limit'
  // MVP M6a contract, sections 5 and 6.1.
  | 'editor.not-a-text-node'
  | 'editor.invalid-text-range'
  | 'editor.no-text-layout'
  // MVP M6b contract, sections 3.1 and 7.1.
  | 'editor.no-text-edit'
  | 'editor.gesture-active'
  // E41 contract, section 2.
  | 'editor.boolean-unsupported'
  | 'editor.boolean-empty'
  | 'editor.boolean-too-large'
  | 'editor.boolean-failed'
  // E41 contract, section 6.
  | 'editor.effect-limit'
  // V-33 SVG import contract, section 2.
  | 'editor.invalid-svg'
  | 'editor.empty-svg'
  // V-39 contract, section 3 (V39-E3).
  | 'editor.unknown-style'
  | 'editor.unknown-variable'
  | 'editor.unknown-mode'
  | 'editor.binding-type'
  | 'editor.binding-range'
  | 'editor.table-limit'
  | 'editor.last-mode'
  /** V-35 contract, V35-C1: `addFill` past 16 fills. */
  | 'editor.fill-limit'
  // V-32 contract, V32-E1, M4: an invalid asset, a dangling image key, or a key with other data;
  // the image table over its limit; `setImageFill` or `setImagePaint` with no target node.
  | 'editor.image-invalid'
  | 'editor.image-too-large'
  | 'editor.image-no-target'
  // V-37 contract, section 6.4.
  | 'editor.invalid-variant'
  | 'editor.no-such-variant'
  | 'editor.invalid-override';

/**
 * `consumed` is present on `input` results only (M2-I3): whether navigation, the tool or a key
 * binding acted on the event, so a host calls `preventDefault` only then. `passThrough` (MVP
 * M6b contract, section 5.2, M6b-Q2 (a)) comes only with `consumed: false` on a text edit mode
 * keydown the editor leaves to text input: the host neither prevents it nor runs its own
 * shortcut for it.
 */
export type CommandResult =
  | Readonly<{ ok: true; ids: readonly string[]; consumed?: boolean; passThrough?: true }>
  | Readonly<{ ok: false; code: EditorErrorCode; path?: string; consumed?: boolean }>;

export type HistoryState = Readonly<{ undoDepth: number; redoDepth: number }>;

export type EditorSnapshot = Readonly<{
  document: DocumentV8;
  /** The page tools, hit testing and the projector work on (M1 contract, section 3). */
  activePage: string;
  /** Increases by one for every document change, including gesture updates, undo and redo. */
  revision: number;
  selection: readonly string[];
  tool: ToolId;
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
  /** Whether the host shows rulers and guides (V-38 contract, V38-C3); false by default. */
  rulersVisible: boolean;
  /** Whether layout grids show and snap (V38-C3, V38-N1); true by default. */
  layoutGridsVisible: boolean;
  /** The entered container of the active page (M2 contract, section 5), or null. */
  scope: string | null;
  /** Path edit mode (M3 contract, section 4), or null. */
  pathEdit: PathEditState | null;
  /** Text edit mode (M6b contract, M6b-S1), or null. */
  textEdit: TextEditState | null;
  /** The style the text tool gives a new node (M6b-S2). */
  textStyle: TextStyle;
  /** V-40: the side count the polygon tool draws with, 3 to 60; 3 by default. */
  polygonSides: number;
  /** The eyedropper's last pick (V-39 contract, E7), or null. */
  pickedColor: Color | null;
}>;

export type Query =
  | Readonly<{ type: 'document' }>
  /**
   * The committed document (M5 contract, M5-S3): the active gesture's pre-gesture document while
   * a gesture is active, else the current document. Frozen; it raises no event.
   */
  | Readonly<{ type: 'committedDocument' }>
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
  /** V-38 contract, V38-C3. */
  | Readonly<{ type: 'rulersVisible' }>
  | Readonly<{ type: 'layoutGridsVisible' }>
  /** The entered container, or null. */
  | Readonly<{ type: 'scope' }>
  /**
   * The in-memory clipboard's text, or null (M2 contract, section 6): fragment text, or the
   * plain text of a text edit mode copy or cut (MVP M6b contract, section 9.2).
   */
  | Readonly<{ type: 'clipboard' }>
  /** Path edit mode, or null (M3 contract, section 4). */
  | Readonly<{ type: 'pathEdit' }>
  /** The edited path's anchors and visible handles in page space, or null (section 5.1). */
  | Readonly<{ type: 'pathOverlay' }>
  /**
   * The layout of a text node through the editor's cache (M6a contract, section 5), or null
   * without a port or for an ID that names no text node.
   */
  | Readonly<{ type: 'textLayout'; id: string }>
  /** Text edit mode, or null (M6b contract, M6b-S1). */
  | Readonly<{ type: 'textEdit' }>
  /** The caret, selection and composition of text edit mode in page space, or null (4.5). */
  | Readonly<{ type: 'textEditOverlay' }>
  /**
   * The registered extensions (MVP M8 contract, M8-X1): a frozen list of `ExtensionSummary`
   * sorted by extension ID. It raises no event and is the same value for the editor's lifetime.
   */
  | Readonly<{ type: 'extensions' }>
  /**
   * The export scene of `ids` on the active page, or of its top-level nodes when `ids` is
   * omitted, or null when nothing would draw (V-30 export contract, V30-S1 to S4).
   */
  | Readonly<{ type: 'exportScene'; ids?: readonly string[] }>
  /** The SVG text of the same export, or null (V30-S5). */
  | Readonly<{ type: 'exportSvg'; ids?: readonly string[] }>
  /**
   * The colour under the page point on the active page at the current zoom, or null (V-39
   * contract, E6): the paint of the topmost painted part, a gradient evaluated at the point,
   * node and ancestor opacity not applied.
   */
  | Readonly<{ type: 'sampleColor'; point: PagePoint }>
  /** The eyedropper's last pick, or null (V-39 contract, E7). */
  | Readonly<{ type: 'pickedColor' }>
  /**
   * The effect kinds a panel offers (V-36 contract, section 6), in panel order: all four under
   * `projectEffects: 'v1'`, else E41's drop shadow and layer blur. Frozen; it raises no event and
   * is the same value for the editor's lifetime.
   */
  | Readonly<{ type: 'effectKinds' }>
  /**

   * The deepest visible source node of the instance `id` under `point` (page space), or null
   * (V-37 section 6.3).
   */
  | Readonly<{ type: 'instanceLayerAt'; id: string; point: PagePoint }>
  /**
   * The page-space corners of the rotated frame of source node `node` as the expansion of
   * instance `id` places it, or null (V-37 section 6.3).
   */
  | Readonly<{ type: 'instanceLayerCorners'; id: string; node: string }>;

/**
 * What one registered extension contributes (MVP M8 contract, M8-X1), as the `extensions` query
 * returns it. Each list is sorted by code unit: `nodeTypes` holds custom node types, `commands`
 * command IDs, `tools` tool IDs and `bindings` the canonical chords of the extension's keymap
 * layer (as the `keymap` query writes them, `action: null` bindings included). Frozen.
 */
export type ExtensionSummary = Readonly<{
  /** The extension's ID. */
  id: string;
  /** The `customType` of each node type the extension registered. */
  nodeTypes: readonly string[];
  /** The ID of each command the extension registered. */
  commands: readonly string[];
  /** The ID of each tool the extension registered. */
  tools: readonly string[];
  /** The canonical chord of each binding in the extension's keymap layer. */
  bindings: readonly string[];
}>;

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
  /**
   * V-25 slice 9 (the property panel's X, Y, W and H): for a selection of one node, the box the
   * handles sit on in that node's own unrotated axes, relative to its frame's top-left corner:
   * its content box (V-26: a path's curve, a group's children), else `{ 0, 0, width, height }`.
   * Null for several nodes.
   */
  content: Frame | null;
}>;

/**
 * One node of an export scene (V-30 export contract, V30-S3): a container, a path (primitives
 * are turned into their outline paths) or text. `transform` is parent-local, page-space for a
 * root. Nodes with `visible: false` are not in the scene, except a mask source, which only clips.
 */
export type ExportNode = Readonly<{
  id: string;
  transform: SceneAffine;
  opacity: number;
  /** V35-E1: the scene node's blend mode, absent for the default of its kind. */
  blendMode?: SceneBlendMode;
}> &
  (
    | Readonly<{ kind: 'container'; children: readonly string[]; clip: SceneClip }>
    | Readonly<{
        kind: 'path';
        geometry: ScenePathGeometry;
        fill: ScenePaint | null;
        stroke: PathStroke | null;
      }>
    | Readonly<{ kind: 'text'; lang: string; runs: readonly SceneTextRun[] }>
  );

/** What an export draws (V30-S1 to S4). */
export type ExportScene = Readonly<{
  /** Page space, whole units, at least 1 × 1 (V30-S4); content outside it is cut off. */
  bounds: Frame;
  /** Every node of the roots' subtrees, by scene ID; a container's children name them. */
  nodes: ReadonlyMap<string, ExportNode>;
  /** The roots in paint order, back to front. */
  rootOrder: readonly string[];
  /**
   * V32-E4: the document's image entries that the nodes' image paints name; absent without any.
   * An image paint's `image` is a key of it.
   */
  images?: Readonly<Record<string, ImageAsset>>;
}>;

export type QueryResult<Q extends Query> = Q extends { type: 'document' | 'committedDocument' }
  ? DocumentV8
  : Q extends { type: 'node' }
    ? NodeV8 | null
    : Q extends { type: 'selection' }
      ? readonly string[]
      : Q extends { type: 'tool' }
        ? ToolId
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
                          : Q extends { type: 'snapping' | 'rulersVisible' | 'layoutGridsVisible' }
                            ? boolean
                            : Q extends { type: 'scope' }
                              ? string | null
                              : Q extends { type: 'clipboard' }
                                ? string | null
                                : Q extends { type: 'pathEdit' }
                                  ? PathEditState | null
                                  : Q extends { type: 'pathOverlay' }
                                    ? PathEditOverlay | null
                                    : Q extends { type: 'textLayout' }
                                      ? TextLayoutResult | null
                                      : Q extends { type: 'textEdit' }
                                        ? TextEditState | null
                                        : Q extends { type: 'textEditOverlay' }
                                          ? TextEditOverlay | null
                                          : Q extends { type: 'extensions' }
                                            ? readonly ExtensionSummary[]
                                            : Q extends { type: 'exportScene' }
                                              ? ExportScene | null
                                              : Q extends { type: 'exportSvg' }
                                                ? string | null
                                                : Q extends { type: 'sampleColor' | 'pickedColor' }
                                                  ? Color | null
                                                  : Q extends { type: 'effectKinds' }
                                                    ? readonly Effect['kind'][]
                                                    : Q extends { type: 'instanceLayerAt' }
                                                      ? string | null
                                                      : Q extends { type: 'instanceLayerCorners' }
                                                        ? readonly PagePoint[] | null
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
        /** V-38 contract, V38-C3. */
        | 'rulersVisible'
        | 'layoutGridsVisible'
        | 'scope'
        | 'pathEdit'
        /** The text layout port's generation changed (M6a contract, section 5). */
        | 'textLayout'
        /** Text edit mode and the text tool style (M6b contract, M6b-S1 and S2). */
        | 'textEdit'
        | 'textStyle'
        /** The polygon tool's side count (V-40). */
        | 'polygonSides'
        /** The eyedropper's last pick (V-39 contract, E7). */
        | 'pickedColor';
    }>
  | DiagnosticEvent;

/**
 * A structured diagnostic from the scene projector (plan section 4.5). The text variant (MVP M6c
 * contract, M6c-P3) tells that the editor has no layout port, so the text units `nodeIds` (sorted
 * scene IDs: text nodes and expanded instance text) project nothing; it is raised at most once
 * per renderer attachment and active page, again after a load or a page switch.
 */
export type DiagnosticEvent =
  | Readonly<{
      type: 'diagnostic';
      /** `renderer-unsupported` is a host capability fact; `scene-rejected` any other rejection. */
      code: 'editor.scene-rejected' | 'editor.renderer-unsupported';
      reason: SceneRejectionReason;
      nodeIds: readonly string[];
    }>
  | Readonly<{
      type: 'diagnostic';
      code: 'editor.text-unavailable';
      reason: 'no-text-layout';
      nodeIds: readonly string[];
    }>
  /**
   * V-35 contract, V35-C4: `ungroupNodes` released the children of a group whose blend mode was
   * not `passThrough`; the group's mode is gone with it. `nodeIds` is the removed group.
   */
  | Readonly<{
      type: 'diagnostic';
      code: 'editor.ungroup-blend';
      reason: 'blend-dropped';
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

/**
 * The gesture API an extension tool receives (MVP M2 contract, sections 4 and 7): `update`
 * applies an absolute command to the live document, `replace` restores the pre-gesture document
 * and applies its commands in order; commit records one undo step, cancel restores. It acts only
 * while its tool is the active tool.
 */
export type ToolGesture = Readonly<{
  readonly active: boolean;
  /** Returns false while another gesture is active, or when the tool is not active. */
  begin(): boolean;
  /**
   * A relative command (`rotateNodes`, the arrange commands, the path commands) fails: it goes
   * through `replace`.
   */
  update(command: DocumentCommand): CommandResult;
  replace(commands: readonly DocumentCommand[]): CommandResult;
  commit(): void;
  cancel(): void;
}>;

/** What an extension tool receives: the extension API plus the gesture API (no `edit`). */
export type ToolApi = ExtensionApi & Readonly<{ gesture: ToolGesture }>;

/**
 * An extension tool (MVP M2 contract, section 7); its `id` is the extension's ID or starts with
 * it and a dot. `input` gets the events a built-in tool gets (M2-I2) and returns `true` to
 * consume one; `reset` drops drag and overlay state and must issue no command; `overlay` is the
 * state the host draws, surfaced as the editor's `overlay`.
 */
export type ExtensionTool = Readonly<{
  id: string;
  input(event: InputEvent, api: ToolApi): boolean | void;
  reset(): void;
  overlay?(): ToolOverlay | null;
}>;

export type Extension = Readonly<{
  id: string;
  nodeTypes?: readonly CustomNodeType[];
  commands?: readonly ExtensionCommand[];
  /** Tools `setTool` can activate by ID (MVP M2 contract, section 7). */
  tools?: readonly ExtensionTool[];
  /**
   * The extension's keymap layer (M2 contract, section 7): built-in actions and the extension's
   * own commands only.
   */
  bindings?: readonly KeyBinding[];
}>;
