// Document schema v1 (P5 editor-slice plan, section 3). The model imports nothing, so these
// types mirror the matching `contracts` scene fields instead of importing them.

export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** `[0, 1]` per channel. */
export type Color = Readonly<{ r: number; g: number; b: number; a: number }>;

/** Page units, axis-aligned; `width` and `height` are at least 0. */
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
