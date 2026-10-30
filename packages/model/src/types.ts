// Document schemas (P5 editor-slice plan, section 3; MVP M1 contract, section 2). The model imports
// nothing, so these types mirror the matching `contracts` scene fields instead of importing them.
// Schema v6 (MVP M4 contract, section 2) is the document the model returns and writes; the v1 to
// v5 types describe the input of `migrateV1toV2` to `migrateV5toV6` only.

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** `[0, 1]` per channel. */
export type Color = Readonly<{ r: number; g: number; b: number; a: number }>;

/** In the parent's local space (page units under a page); `width` and `height` are at least 0. */
export type Frame = Readonly<{ x: number; y: number; width: number; height: number }>;

/** The fields of the primitive `SceneStroke`; `width` is in page units. */
export type RectStroke = Readonly<{ color: Color; width: number }>;

export type StrokeCap = 'butt' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

/** The fields of the contracts `PathStroke`; `width` is in page units, `miterLimit` at least 1. */
export type PathStroke = Readonly<{
  color: Color;
  width: number;
  cap: StrokeCap;
  join: StrokeJoin;
  miterLimit: number;
}>;

export type PathVerb = 'move' | 'line' | 'cubic' | 'close';
export type FillRule = 'nonzero' | 'evenodd';

/**
 * Interleaved x, y in the unit box `[0, 1]²` of the node's frame. `move` and `line` take one
 * point, `cubic` three and `close` none.
 */
export type PathData = Readonly<{
  verbs: readonly PathVerb[];
  points: readonly number[];
  fillRule: FillRule;
}>;

export type NodeBase = Readonly<{
  id: string;
  name: string;
  /** The ID of a page or of a node; in P5 always the page. */
  parent: string;
  frame: Frame;
  opacity: number;
  visible: boolean;
}>;

export type RectangleNode = NodeBase &
  Readonly<{ type: 'rectangle'; fill: Color | null; stroke: RectStroke | null }>;

export type PathNode = NodeBase &
  Readonly<{ type: 'path'; path: PathData; fill: Color | null; stroke: PathStroke | null }>;

/** `customType` and `data` are checked by the owning extension in `editor-core`, not here. */
export type CustomNode = NodeBase &
  Readonly<{
    type: 'custom';
    customType: string;
    data: JsonValue;
    fill: Color | null;
    stroke: PathStroke | null;
  }>;

export type NodeV1 = RectangleNode | PathNode | CustomNode;

/** `children` is in paint order: index 0 is painted first. */
export type PageV1 = Readonly<{ id: string; name: string; children: readonly string[] }>;

export type DocumentV1 = Readonly<{
  schemaVersion: 1;
  id: string;
  /** Exactly one page in P5. */
  pages: readonly [PageV1];
  nodes: Readonly<Record<string, NodeV1>>;
}>;

// Document schema v2 (MVP M1 contract, section 2). Frames are parent-local; `rotation` is radians,
// clockwise on screen, about the frame centre, normalized to (−π, π].

export type Constraint = 'start' | 'end' | 'startEnd' | 'center' | 'scale';
export type Constraints = Readonly<{ horizontal: Constraint; vertical: Constraint }>;
export type Arrow = 'none' | 'line' | 'triangle';
/** Top-left, top-right, bottom-right, bottom-left; each at least 0. */
export type CornerRadii = readonly [number, number, number, number];

export type NodeBaseV2 = Readonly<{
  id: string;
  name: string;
  /** A page or a container. */
  parent: string;
  frame: Frame;
  rotation: number;
  /** Effective only on a child of a frame. */
  constraints: Constraints;
  opacity: number;
  visible: boolean;
}>;

export type RectangleNodeV2 = NodeBaseV2 &
  Readonly<{
    type: 'rectangle';
    cornerRadii: CornerRadii;
    fill: Color | null;
    stroke: RectStroke | null;
  }>;

export type EllipseNode = NodeBaseV2 &
  Readonly<{ type: 'ellipse'; fill: Color | null; stroke: RectStroke | null }>;

export type LineNode = NodeBaseV2 &
  Readonly<{
    type: 'line';
    /** The two endpoints in the unit box of the frame. */
    points: readonly [number, number, number, number];
    stroke: PathStroke | null;
    startArrow: Arrow;
    endArrow: Arrow;
  }>;

export type PathNodeV2 = NodeBaseV2 &
  Readonly<{ type: 'path'; path: PathData; fill: Color | null; stroke: PathStroke | null }>;

export type CustomNodeV2 = NodeBaseV2 &
  Readonly<{
    type: 'custom';
    customType: string;
    data: JsonValue;
    fill: Color | null;
    stroke: PathStroke | null;
  }>;

/** A group or mask group has at least one child; a mask group's first child is a path. */
export type GroupNode = NodeBaseV2 &
  Readonly<{ type: 'group' | 'maskGroup'; children: readonly string[] }>;

export type FrameNode = NodeBaseV2 &
  Readonly<{
    type: 'frame';
    children: readonly string[];
    fill: Color | null;
    stroke: RectStroke | null;
  }>;

export type LeafNodeV2 = RectangleNodeV2 | EllipseNode | LineNode | PathNodeV2 | CustomNodeV2;
export type ContainerNode = GroupNode | FrameNode;
export type NodeV2 = LeafNodeV2 | ContainerNode;
export type NodeTypeV2 = NodeV2['type'];

export type PageV2 = PageV1;

export type DocumentV2 = Readonly<{
  schemaVersion: 2;
  id: string;
  /** One or more pages. */
  pages: readonly PageV2[];
  nodes: Readonly<Record<string, NodeV2>>;
}>;

// Document schema v3 (MVP M7 contract, section 2): v2 plus the symbol source and its instances.

/** A symbol source (M7-S1): the fields of a frame; never inside another symbol (M7-S3). */
export type SymbolNode = NodeBaseV2 &
  Readonly<{
    type: 'symbol';
    children: readonly string[];
    fill: Color | null;
    stroke: RectStroke | null;
  }>;

/**
 * An instance (M7-S2): a leaf whose content is the expansion of the `symbol` node it names, on
 * any page of the same document; never inside a symbol (M7-S3); opacity 1 (M7-S4).
 */
export type InstanceNode = NodeBaseV2 & Readonly<{ type: 'instance'; symbol: string }>;

export type LeafNodeV3 = LeafNodeV2 | InstanceNode;
export type ContainerNodeV3 = ContainerNode | SymbolNode;
export type NodeV3 = LeafNodeV3 | ContainerNodeV3;
export type NodeTypeV3 = NodeV3['type'];

export type PageV3 = PageV2;

export type DocumentV3 = Readonly<{
  schemaVersion: 3;
  id: string;
  /** One or more pages. */
  pages: readonly PageV3[];
  nodes: Readonly<Record<string, NodeV3>>;
}>;

// Document schema v4 (MVP M6a contract, section 2): v3 plus the text leaf.

/**
 * A style run (M6a-S1 to S3): `size` in page units in `(0, 4096]`, `color` straight alpha. The
 * node text is the concatenation of its runs' `text`.
 */
export type TextRun = Readonly<{ text: string; family: string; size: number; color: Color }>;

/**
 * A text leaf (M6a-S1 to S5): canonical runs (at least one; adjacent runs differ in style), at
 * most `MAX_TEXT_LENGTH` UTF-16 units in all. No layout is stored (M6a-S6); `frame` is stored
 * for every sizing mode.
 */
export type TextNode = NodeBaseV2 &
  Readonly<{
    type: 'text';
    runs: readonly TextRun[];
    sizing: 'autoWidth' | 'autoHeight' | 'fixed';
    align: 'left' | 'center' | 'right';
    /** In em of each run's size. */
    letterSpacing: number;
    /** A multiple of each run's size (CSS unitless). */
    lineHeight: number;
  }>;

export type LeafNodeV4 = LeafNodeV3 | TextNode;
export type ContainerNodeV4 = ContainerNodeV3;
export type NodeV4 = LeafNodeV4 | ContainerNodeV4;
export type NodeTypeV4 = NodeV4['type'];

export type PageV4 = PageV3;

export type DocumentV4 = Readonly<{
  schemaVersion: 4;
  id: string;
  /** One or more pages. */
  pages: readonly PageV4[];
  nodes: Readonly<Record<string, NodeV4>>;
}>;

// Document schema v5 (M6a contract, section 9, M7-T3): v4 with the text overrides of instances.

/** An instance's text for one text node of its source (M7-T3): canonical runs only. */
export type TextOverride = Readonly<{ runs: readonly TextRun[] }>;

/**
 * An instance at v5 (M7-T3): `textOverrides` is always present (`{}` when none), keyed by the
 * IDs of text nodes of its source's subtree in UTF-16 code unit order, sizes in the source's
 * space.
 */
export type InstanceNodeV5 = NodeBaseV2 &
  Readonly<{
    type: 'instance';
    symbol: string;
    textOverrides: Readonly<Record<string, TextOverride>>;
  }>;

export type LeafNodeV5 = LeafNodeV2 | TextNode | InstanceNodeV5;
export type ContainerNodeV5 = ContainerNodeV4;
export type NodeV5 = LeafNodeV5 | ContainerNodeV5;
export type NodeTypeV5 = NodeV5['type'];

export type PageV5 = PageV4;

export type DocumentV5 = Readonly<{
  schemaVersion: 5;
  id: string;
  /** One or more pages. */
  pages: readonly PageV5[];
  nodes: Readonly<Record<string, NodeV5>>;
}>;

// Document schema v6 (MVP M4 contract, section 2): v5 with paints, gradients, one stroke type and
// dashes on every filled and stroked node. Text runs keep `Color` and instances carry no paint.

/** One gradient stop: `offset` in `[0, 1]`, `color` straight alpha. */
export type GradientStop = Readonly<{ offset: number; color: Color }>;
export type GradientKind = 'linear' | 'radial';
export type GradientSpread = 'pad' | 'reflect' | 'repeat';

/**
 * A gradient in the unit box `[0, 1]²` of the node's frame (M4-S2, M4-Q2 (a)): `transform` maps
 * gradient space to the unit box, `x' = a·x + c·y + e`, `y' = b·x + d·y + f`; 1 to 16 stops with
 * non-decreasing offsets in `[0, 1]`. Mirrors the contracts `SceneGradient`.
 */
export type Gradient = Readonly<{
  kind: GradientKind;
  transform: readonly [number, number, number, number, number, number];
  stops: readonly GradientStop[];
  spread: GradientSpread;
}>;

/** A solid colour (exactly `r, g, b, a`) or one gradient (M4-S1). */
export type Paint = Color | Gradient;

/**
 * A dash pattern and phase in page units, the units of the stroke's width (M4-S4, mirroring
 * E24-S1): 1 to 16 entries, each at least 0, at least one above 0, a finite period.
 */
export type Dash = Readonly<{ pattern: readonly number[]; phase: number }>;

/** The one stroke type of every stroked node (M4-S3, M4-Q1 (a)); `color` holds a paint. */
export type Stroke = Readonly<{
  color: Paint;
  width: number;
  cap: StrokeCap;
  join: StrokeJoin;
  miterLimit: number;
  dash: Dash | null;
}>;

export type RectangleNodeV6 = NodeBaseV2 &
  Readonly<{
    type: 'rectangle';
    cornerRadii: CornerRadii;
    fill: Paint | null;
    stroke: Stroke | null;
  }>;

export type EllipseNodeV6 = NodeBaseV2 &
  Readonly<{ type: 'ellipse'; fill: Paint | null; stroke: Stroke | null }>;

export type LineNodeV6 = NodeBaseV2 &
  Readonly<{
    type: 'line';
    /** The two endpoints in the unit box of the frame. */
    points: readonly [number, number, number, number];
    stroke: Stroke | null;
    startArrow: Arrow;
    endArrow: Arrow;
  }>;

export type PathNodeV6 = NodeBaseV2 &
  Readonly<{ type: 'path'; path: PathData; fill: Paint | null; stroke: Stroke | null }>;

export type CustomNodeV6 = NodeBaseV2 &
  Readonly<{
    type: 'custom';
    customType: string;
    data: JsonValue;
    fill: Paint | null;
    stroke: Stroke | null;
  }>;

export type FrameNodeV6 = NodeBaseV2 &
  Readonly<{
    type: 'frame';
    children: readonly string[];
    fill: Paint | null;
    stroke: Stroke | null;
  }>;

/** A symbol source at v6: the fields of a v6 frame (M7-S1). */
export type SymbolNodeV6 = NodeBaseV2 &
  Readonly<{
    type: 'symbol';
    children: readonly string[];
    fill: Paint | null;
    stroke: Stroke | null;
  }>;

export type LeafNodeV6 =
  | RectangleNodeV6
  | EllipseNodeV6
  | LineNodeV6
  | PathNodeV6
  | CustomNodeV6
  | TextNode
  | InstanceNodeV5;
export type ContainerNodeV6 = GroupNode | FrameNodeV6 | SymbolNodeV6;
export type NodeV6 = LeafNodeV6 | ContainerNodeV6;
export type NodeTypeV6 = NodeV6['type'];

export type PageV6 = PageV5;

export type DocumentV6 = Readonly<{
  schemaVersion: 6;
  id: string;
  /** One or more pages. */
  pages: readonly PageV6[];
  nodes: Readonly<Record<string, NodeV6>>;
}>;
