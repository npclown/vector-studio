// Document schemas (P5 editor-slice plan, section 3; MVP M1 contract, section 2). The model imports
// nothing, so these types mirror the matching `contracts` scene fields instead of importing them.
// Schema v8 (docs/plans/viz-schema-v8.md; v7's shape so far) is the document the model returns and writes; the v1
// to v7 types describe the input of `migrateV1toV2` to `migrateV7toV8` only.

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
 * any page of the same document; never inside a symbol (M7-S3); opacity 1 below v6 (M7-S4), any in `[0, 1]` from v6 (M4-L1).
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

// Document schema v7 (E41 contract, section 3): v6 with `effects` on every node.

/**
 * A drop shadow (E41-S2): `offsetX`, `offsetY` and `radius` in node-local units (E41-S4), the
 * Gaussian's `σ = radius / 2`; `color` straight alpha.
 */
export type DropShadowEffect = Readonly<{
  kind: 'dropShadow';
  visible: boolean;
  color: Color;
  offsetX: number;
  offsetY: number;
  radius: number;
}>;

/** A blur of the node's whole rendered layer (E41-S2), `σ = radius / 2`. */
export type LayerBlurEffect = Readonly<{ kind: 'layerBlur'; visible: boolean; radius: number }>;

/** The effect kinds of v7 (E41-S2). */
export type EffectV7 = DropShadowEffect | LayerBlurEffect;

/**
 * An inner shadow (V-36 contract, V36-S1): a drop shadow's fields and ranges, drawn inside the
 * node's hardened coverage.
 */
export type InnerShadowEffect = Readonly<{
  kind: 'innerShadow';
  visible: boolean;
  color: Color;
  offsetX: number;
  offsetY: number;
  radius: number;
}>;

/** A blur of what lies behind the node, inside its coverage (V36-S1), `σ = radius / 2`. */
export type BackgroundBlurEffect = Readonly<{
  kind: 'backgroundBlur';
  visible: boolean;
  radius: number;
}>;

/** The effect kinds of v8 (V36-S1): v7's and the two V-36 adds. */
export type Effect = DropShadowEffect | LayerBlurEffect | InnerShadowEffect | BackgroundBlurEffect;

/** The field v7 adds to every node (E41-S1): at most 8 effects, at most one layer blur (E41-S3). */
export type NodeEffectsV7 = Readonly<{ effects: readonly EffectV7[] }>;

/** v8's `effects` (V36-S2): E41-S3's limits, plus at most one background blur. */
export type NodeEffects = Readonly<{ effects: readonly Effect[] }>;

export type RectangleNodeV7 = RectangleNodeV6 & NodeEffectsV7;
export type EllipseNodeV7 = EllipseNodeV6 & NodeEffectsV7;
export type LineNodeV7 = LineNodeV6 & NodeEffectsV7;
export type PathNodeV7 = PathNodeV6 & NodeEffectsV7;
export type CustomNodeV7 = CustomNodeV6 & NodeEffectsV7;
export type TextNodeV7 = TextNode & NodeEffectsV7;
export type InstanceNodeV7 = InstanceNodeV5 & NodeEffectsV7;
export type GroupNodeV7 = GroupNode & NodeEffectsV7;
/**
 * A page guide (V-38 contract, V38-S1): `axis: 'x'` is a vertical line at page x = `value`,
 * `'y'` a horizontal line at page y = `value`.
 */
export type Guide = Readonly<{ axis: 'x' | 'y'; value: number }>;

/** A uniform layout grid (V38-S2): lines every `size` page units from the frame's top-left. */
export type UniformLayoutGrid = Readonly<{
  type: 'grid';
  size: number;
  color: Color;
  visible: boolean;
}>;

/**
 * Columns or rows (V38-S2): `count` bands of `size` (ignored by `stretch`) with `gutter` between
 * them, `offset` from the aligned side (the margin for `stretch`, ignored by `center`).
 */
export type BandLayoutGrid = Readonly<{
  type: 'columns' | 'rows';
  count: number;
  align: 'stretch' | 'start' | 'center' | 'end';
  size: number;
  gutter: number;
  offset: number;
  color: Color;
  visible: boolean;
}>;

/** A frame's or symbol's layout grid (V38-S2). */
export type LayoutGrid = UniformLayoutGrid | BandLayoutGrid;

/** The optional field V-38 adds to a frame or symbol (V38-S2); absent means none. */
export type NodeLayoutGrids = Readonly<{ layoutGrids?: readonly LayoutGrid[] }>;

export type FrameNodeV7 = FrameNodeV6 & NodeEffectsV7;
export type SymbolNodeV7 = SymbolNodeV6 & NodeEffectsV7;

export type LeafNodeV7 =
  | RectangleNodeV7
  | EllipseNodeV7
  | LineNodeV7
  | PathNodeV7
  | CustomNodeV7
  | TextNodeV7
  | InstanceNodeV7;
export type ContainerNodeV7 = GroupNodeV7 | FrameNodeV7 | SymbolNodeV7;
export type NodeV7 = LeafNodeV7 | ContainerNodeV7;
export type NodeTypeV7 = NodeV7['type'];

export type PageV7 = PageV6;

export type DocumentV7 = Readonly<{
  schemaVersion: 7;
  id: string;
  /** One or more pages. */
  pages: readonly PageV7[];
  nodes: Readonly<Record<string, NodeV7>>;
}>;

// Document schema v8 (docs/plans/viz-schema-v8.md, gap-list items V-31 to V-40): introduced as v7's shape
// so the ten items can each add their fields to one unreleased version instead of bumping it in
// turn. V-35 replaces `fill` by `fills` and adds `blendMode` to every node (V35-S1, S2).

/**
 * V-35 contract (docs/plans/viz-v35-fills-blend-contract.md), V35-S2: the W3C Compositing Level 1
 * blend modes, and `passThrough`, which only a container or instance takes.
 */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'colorDodge'
  | 'colorBurn'
  | 'hardLight'
  | 'softLight'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';
export type ContainerBlendMode = BlendMode | 'passThrough';

/** V35-S2: one fill of a node, painted bottom first; `opacity` in `[0, 1]`. */
export type Fill = Readonly<{
  paint: Paint;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
}>;

/** V35-S2: the fills that replace v7's single `fill` (at most MAX_FILLS). */
export type NodeFills = Readonly<{ fills: readonly Fill[] }>;
/** V35-S2: a leaf's blend mode. */
export type LeafBlend = Readonly<{ blendMode: BlendMode }>;
/** V35-S2: a container's or instance's blend mode. */
export type ContainerBlend = Readonly<{ blendMode: ContainerBlendMode }>;

/** The field V-39 adds to every v8 node (V39-S4): its bindings, absent when it has none. */
export type NodeBindings = Readonly<{ bindings?: Bindings }>;

/**
 * V-31 contract, V31-S1: the optional lock. Absent or `false` is unlocked, and a validated node
 * has the key only when locked; locked nodes cannot be picked or transformed on the canvas.
 */
export type NodeLock = Readonly<{ locked?: boolean }>;

export type RectangleNodeV8 = Omit<RectangleNodeV6, 'fill'> &
  NodeFills &
  LeafBlend &
  NodeEffects &
  NodeLock &
  NodeBindings &
  NodeSizing;
export type EllipseNodeV8 = Omit<EllipseNodeV6, 'fill'> &
  NodeFills &
  LeafBlend &
  NodeEffects &
  NodeLock &
  NodeBindings &
  NodeSizing;
export type LineNodeV8 = LineNodeV6 &
  LeafBlend &
  NodeEffects &
  NodeLock &
  NodeBindings &
  NodeSizing;
export type PathNodeV8 = Omit<PathNodeV6, 'fill'> &
  NodeFills &
  LeafBlend &
  NodeEffects &
  NodeLock &
  NodeBindings &
  NodeSizing;
export type CustomNodeV8 = Omit<CustomNodeV6, 'fill'> &
  NodeFills &
  LeafBlend &
  NodeEffects &
  NodeLock &
  NodeBindings &
  NodeSizing;
export type TextNodeV8 = TextNode & LeafBlend & NodeEffects & NodeLock & NodeBindings & NodeSizing;
export type GroupNodeV8 = GroupNode &
  ContainerBlend &
  NodeEffects &
  NodeLock &
  NodeBindings &
  NodeSizing;
export type FrameNodeV8 = Omit<FrameNodeV6, 'fill'> &
  NodeFills &
  ContainerBlend &
  NodeEffects &
  NodeLock &
  NodeLayoutGrids &
  NodeBindings &
  NodeSizing &
  FrameLayout;

/**
 * The fields of an instance's source node an instance may override (V-37 contract, V37-S3): the
 * appearance fields; text runs stay in `textOverrides`, and `blendMode` is not overridable
 * (V37-Q5). At least one field is present. `fills` is the node field's own list (V35-S2; V-37
 * V35 rebase amendment 2026-11-12).
 */
export type NodeOverride = Readonly<{
  fills?: readonly Fill[];
  stroke?: Stroke | null;
  opacity?: number;
  visible?: boolean;
  effects?: readonly Effect[];
}>;

/** V37-S3: `overrides` is keyed by node IDs of the source subtree; absent when empty. */
export type InstanceNodeV8 = InstanceNodeV5 &
  ContainerBlend &
  NodeEffects &
  NodeLock &
  NodeBindings &
  NodeSizing &
  Readonly<{ overrides?: Readonly<Record<string, NodeOverride>> }>;

/**
 * V37-S2: a symbol in a symbol set names its variant by property values; absent outside a set.
 */
export type SymbolNodeV8 = Omit<SymbolNodeV6, 'fill'> &
  NodeFills &
  ContainerBlend &
  NodeEffects &
  NodeLock &
  NodeLayoutGrids &
  NodeBindings &
  NodeSizing &
  Readonly<{ variant?: Readonly<Record<string, string>> }>;

/** A component set (V37-S1) before V-35: a frame's v6 fields (`fill`), holding only symbols. */
export type SymbolSetNodeV6 = NodeBaseV2 &
  Readonly<{
    type: 'symbolSet';
    children: readonly string[];
    fill: Paint | null;
    stroke: Stroke | null;
  }>;

/** A component set (V37-S1): a frame's fields, holding only symbols. */
export type SymbolSetNode = NodeBaseV2 &
  NodeFills &
  ContainerBlend &
  NodeEffects &
  NodeLock &
  NodeBindings &
  NodeSizing &
  Readonly<{
    type: 'symbolSet';
    children: readonly string[];
    stroke: Stroke | null;
  }>;

export type LeafNodeV8 =
  | RectangleNodeV8
  | EllipseNodeV8
  | LineNodeV8
  | PathNodeV8
  | CustomNodeV8
  | TextNodeV8
  | InstanceNodeV8;
export type ContainerNodeV8 = GroupNodeV8 | FrameNodeV8 | SymbolNodeV8 | SymbolSetNode;
export type NodeV8 = LeafNodeV8 | ContainerNodeV8;
export type NodeTypeV8 = NodeV8['type'];

/** A page with its optional guides (V38-S1); absent means none. */
export type PageV8 = PageV6 & Readonly<{ guides?: readonly Guide[] }>;

export type DocumentV8 = Readonly<{
  schemaVersion: 8;
  id: string;
  /** V-39 (V39-S1): named paints, 1 to 1,000 when present, in panel order. */
  colorStyles?: readonly ColorStyle[];
  /** V-39 (V39-S2): the variables and their modes, present only with a variable. */
  variables?: VariableSet;
  /** One or more pages. */
  pages: readonly PageV8[];
  nodes: Readonly<Record<string, NodeV8>>;
}>;

// V-39 contract (docs/plans/viz-v39-styles-variables-contract.md), section 2: colour styles,
// variables with modes, and the bindings of node properties to them. A bound property keeps its
// concrete value (V39-Q1), equal to the reference's resolved value (V39-S5).

/** A named paint (V39-S1). */
export type ColorStyle = Readonly<{ id: string; name: string; paint: Paint }>;

/** One mode of the variable set (V39-S2). */
export type VariableMode = Readonly<{ id: string; name: string }>;

/** A colour or number variable with exactly one value per mode (V39-S2). */
export type Variable =
  | Readonly<{ id: string; name: string; type: 'color'; values: Readonly<Record<string, Color>> }>
  | Readonly<{
      id: string;
      name: string;
      type: 'number';
      values: Readonly<Record<string, number>>;
    }>;

/** The variables, their 1 to 16 modes and the active `mode` (V39-S2). */
export type VariableSet = Readonly<{
  modes: readonly VariableMode[];
  mode: string;
  items: readonly Variable[];
}>;

/** What a binding names: a colour style or a variable (V39-S4). */
export type BindingRef = Readonly<{ style: string }> | Readonly<{ variable: string }>;

/** The node properties a binding can hold (V39-S4), in canonical order. */
export type BindingKey = 'fill' | 'stroke' | 'text' | 'opacity' | 'strokeWidth' | 'cornerRadius';

/** A node's bindings (V39-S4): never empty when present. */
export type Bindings = Readonly<Partial<Record<BindingKey, BindingRef>>>;
// V-34 auto layout (contract sections 2 and 3): optional fields on the unreleased v8.

/** A frame's auto layout (V34-S1): padding is top, right, bottom, left. */
export type AutoLayout = Readonly<{
  direction: 'horizontal' | 'vertical';
  gap: number;
  padding: readonly [number, number, number, number];
  primaryAlign: 'start' | 'center' | 'end' | 'spaceBetween';
  counterAlign: 'start' | 'center' | 'end';
}>;

/** One axis of a node's sizing (V34-S2). */
export type AxisSizing = 'fixed' | 'hug' | 'fill';

/** A node's sizing (V34-S2); absent means fixed on both axes. */
export type LayoutSizing = Readonly<{ horizontal: AxisSizing; vertical: AxisSizing }>;

/** V-34's `layoutSizing`, on every v8 node (V34-S2). */
export type NodeSizing = Readonly<{ layoutSizing?: LayoutSizing }>;

/** V-34's `autoLayout`, on v8 frames only (V34-S1). */
export type FrameLayout = Readonly<{ autoLayout?: AutoLayout }>;

/** The V-34 fields: `autoLayout` on frames only, `layoutSizing` on every node. */
export type LayoutFields = Readonly<{ autoLayout?: AutoLayout; layoutSizing?: LayoutSizing }>;
